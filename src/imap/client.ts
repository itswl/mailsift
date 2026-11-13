/**
 * IMAP engine: one mail-fetching path for three authentication methods.
 *
 * Two lessons from the Python implementation must remain:
 *
 * 1. Never set \Seen. ImapFlow fetch uses peek semantics by default.
 * 2. IMAP `UID n:*` returns at least one message, even when its UID is below n.
 *    Filter the search result client-side or the last message repeats every poll.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { ImapFlow, type FetchMessageObject, type ListResponse } from 'imapflow';
import { getAccessToken } from './auth.js';
import { resolveFolders, toFolder, type Folder } from './folders.js';
import {
  extractAttachmentManifest, extractBody, fallbackMessageId, findBodyParts, findTextBodyPart, htmlToText, normalizeDate,
  type AttachmentInfo, type AttachmentManifest, type MailMessage,
} from './message.js';
import { authservTrust, MAX_HTML_BYTES, parseReadable, slimSource, type ReadableMessage } from './readable.js';
import {
  inspectLinkRisks,
  scanAttachment,
  type AttachmentScanReport,
  type LinkRiskReport,
} from '../security.js';
import { needsOAuth, type Account } from '../config.js';
import { getLogger } from '../logger.js';

const log = getLogger('imap');

export interface FolderCursor {
  /** A changed UIDVALIDITY means the server rebuilt the mailbox and invalidated the cursor. */
  uidValidity: string;
  lastUid: number;
}

export interface MessageBudget {
  remaining: number;
}

export interface FetchFailure {
  folder: string;
  uidValidity: string;
  uid: number;
  subject: string;
  messageId: string;
  reason: string;
}

function intEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

const TRANSIENT_CONNECT_MARKERS = [
  'user is authenticated but not connected',
  'connection reset', 'connection refused', 'socket hang up',
  'timed out', 'timeout', 'econnreset', 'econnrefused', 'etimedout',
  'temporarily unavailable', 'try again',
];

export function imapErrorText(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const value = error as {
    message?: unknown;
    response?: unknown;
    responseText?: unknown;
    responseStatus?: unknown;
    code?: unknown;
  };
  return [value.message, value.responseText, value.response, value.responseStatus, value.code]
    .filter((part) => part !== undefined && part !== null && String(part))
    .map(String)
    .filter((part, index, all) => all.indexOf(part) === index)
    .join(' | ');
}

export function isTransientConnectError(error: unknown): boolean {
  const text = imapErrorText(error).toLowerCase();
  return TRANSIENT_CONNECT_MARKERS.some((marker) => text.includes(marker));
}

export function connectAttempts(account: Account): number {
  void account;
  return 4;
}

export function retryDelayMs(account: Account, attempt: number): number {
  void account;
  return 2_000 * 2 ** Math.max(0, attempt - 1);
}

export function selectFetchUids(found: readonly number[], floor: number, limit: number): number[] {
  return [...found]
    .filter((uid) => uid > floor)
    .sort((a, b) => a - b)
    .slice(0, Math.max(0, limit));
}

export function isOversizedLookback(found: readonly number[], limit: number): boolean {
  return found.length > limit;
}

export interface ConnectOptions {
  /** Tune the connection for a long-lived IDLE listener instead of a short poll. */
  idle?: boolean;
}

export async function connect(account: Account, options: ConnectOptions = {}): Promise<ImapFlow> {
  const auth = needsOAuth(account)
    ? { user: account.username, accessToken: await getAccessToken(account.username, account.auth) }
    : { user: account.username, pass: account.password ?? '' };

  const maxAttempts = connectAttempts(account);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    log.info(
      `Connecting ${account.name} (${account.host}:${account.port}, auth=${account.auth}, attempt ${attempt}/${maxAttempts})`,
    );
    const client = new ImapFlow({
      host: account.host,
      port: account.port,
      secure: account.useSsl,
      auth,
      logger: false,
      // Observe only; do not modify mailbox state.
      emitLogs: false,
      ...(options.idle
        ? {
            // Re-enter IDLE soon after a wake-up fetch so the listening gap stays
            // short; this connection issues few commands, so the extra round
            // trips do not matter. RFC 2177 lets servers drop an IDLE after 29
            // minutes, so restart it well before that.
            autoIdleDelay: 1_000,
            maxIdleTime: 20 * 60_000,
            missingIdleCommand: 'NOOP' as const,
          }
        : {}),
    });
    // ImapFlow can emit a later socket error after connect() has rejected. Node
    // treats an EventEmitter "error" without a listener as process-fatal, which
    // used to turn one provider reset into a container restart loop.
    client.on('error', (error: unknown) => {
      log.warn(`[${account.name}] asynchronous IMAP error: ${imapErrorText(error)}`);
    });
    try {
      await client.connect();
      return client;
    } catch (error) {
      // A failed handshake can leave a half-open TLS socket behind. Close it
      // before retrying or handing the connection failure back to the watcher.
      try {
        client.close();
      } catch {
        // Cleanup is best effort; preserve the original connection error.
      }

      const detail = imapErrorText(error);
      if (attempt === maxAttempts || !isTransientConnectError(error)) {
        throw new Error(detail, { cause: error });
      }

      const delayMs = retryDelayMs(account, attempt);
      log.warn(
        `[${account.name}] transient IMAP connection failure (${attempt}/${maxAttempts}); ` +
          `retrying in ${delayMs}ms: ${detail}`,
      );
      await sleep(delayMs);
    }
  }

  throw new Error(`Unable to connect to ${account.name}`);
}

export async function listFolders(client: ImapFlow): Promise<ListResponse[]> {
  return client.list();
}

export interface MailboxFolderInfo {
  /** Decoded IMAP path; this is the value accepted by mailbox commands. */
  path: string;
  name: string;
  delimiter: string;
  flags: string[];
  specialUse: string | null;
  specialUseSource: ListResponse['specialUseSource'] | null;
  selectable: boolean;
  subscribed: boolean;
}

/**
 * Discover folder metadata through IMAP LIST. This does not open a folder or
 * change message flags or contents.
 */
export async function discoverMailboxFolders(account: Account): Promise<MailboxFolderInfo[]> {
  const client = await connect(account);
  try {
    const entries = await listFolders(client);
    return entries
      .map((entry) => {
        const folder = toFolder(entry);
        return {
          path: folder.path,
          name: entry.name,
          delimiter: entry.delimiter,
          flags: [...folder.flags].sort(),
          specialUse: entry.specialUse ?? null,
          specialUseSource: entry.specialUseSource ?? null,
          selectable: folder.selectable,
          subscribed: entry.subscribed,
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path));
  } finally {
    await client.logout().catch(() => undefined);
  }
}

export async function targetFolders(client: ImapFlow, account: Account): Promise<Folder[]> {
  return resolveFolders(await listFolders(client), account.folders);
}

/** A folder to look for one message in. */
interface LookupFolder extends Folder {
  /**
   * Named by the caller rather than by configuration. If it cannot be opened
   * (renamed or removed since) the lookup moves on to the configured folders
   * instead of failing.
   */
  optional?: boolean;
}

type MailboxLock = Awaited<ReturnType<ImapFlow['getMailboxLock']>>;

/**
 * Put a folder the caller last saw the message in ahead of the configured ones.
 *
 * Pure, so the order can be checked without a server. The hint may name a
 * folder outside the configured set: a message archived or moved to the trash
 * from the web view is no longer where the poller found it, and without the
 * hint it could not be opened again. A hint that names nothing selectable is
 * ignored rather than trusted.
 */
export function orderLookupFolders(
  entries: readonly ListResponse[],
  configured: readonly Folder[],
  folderHint?: string,
): LookupFolder[] {
  const hint = folderHint?.trim();
  if (!hint) return [...configured];
  const first = configured.find((folder) => folder.path === hint || folder.rawPath === hint);
  if (first) return [first, ...configured.filter((folder) => folder !== first)];
  const listed = entries.map(toFolder);
  const hinted = listed.find((folder) => folder.path === hint || folder.rawPath === hint)
    ?? listed.find((folder) => folder.path.toLowerCase() === hint.toLowerCase());
  if (!hinted || !hinted.selectable) return [...configured];
  return [{ ...hinted, optional: true }, ...configured.filter((folder) => folder.path !== hinted.path)];
}

async function lookupFolders(client: ImapFlow, account: Account, folderHint?: string): Promise<LookupFolder[]> {
  // Without a hint this is exactly targetFolders, one LIST and the same order.
  if (!folderHint?.trim()) return targetFolders(client, account);
  const entries = await listFolders(client);
  return orderLookupFolders(entries, resolveFolders(entries, account.folders), folderHint);
}

/** Lock a folder, or return nothing when an optional one cannot be opened. */
async function lockFolder(client: ImapFlow, folder: LookupFolder, readOnly: boolean): Promise<MailboxLock | undefined> {
  try {
    return await client.getMailboxLock(folder.path, { readOnly });
  } catch (error) {
    if (!folder.optional) throw error;
    log.info(`Hinted folder ${folder.path} could not be opened; trying the configured folders: ${imapErrorText(error).slice(0, 160)}`);
    return undefined;
  }
}

function firstAddress(input: unknown): { name: string; address: string } {
  const list = (input ?? []) as Array<{ name?: string; address?: string }>;
  const head = list[0];
  return { name: head?.name?.trim() ?? '', address: (head?.address ?? '').toLowerCase() };
}

function parseHeaderValues(raw: Buffer | undefined): Map<string, string[]> {
  const unfolded = (raw?.toString('utf8') ?? '').replace(/\r?\n[ \t]+/g, ' ');
  const values = new Map<string, string[]>();
  for (const line of unfolded.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    const existing = values.get(name);
    if (existing) existing.push(value);
    else values.set(name, [value]);
  }
  return values;
}

function addressDomain(address: string): string | undefined {
  const separator = address.lastIndexOf('@');
  if (separator <= 0 || separator === address.length - 1) return undefined;
  return address.slice(separator + 1).trim().replace(/\.$/, '').toLowerCase() || undefined;
}

function attachmentWarningDetail(code: NonNullable<AttachmentInfo['safetyWarnings']>[number]): string {
  switch (code) {
    case 'executable_or_installer': return 'Executable or installer file type; only its metadata was checked.';
    case 'script_or_shortcut': return 'Script or shortcut file type; only its metadata was checked.';
    case 'macro_enabled_document': return 'Macro-enabled document type; only its metadata was checked.';
    case 'active_content': return 'HTML or SVG active-content type; only its metadata was checked.';
    case 'archive_not_scanned': return 'Archive or disk-image contents were not inspected.';
  }
}

function threadReference(headers: string): string | undefined {
  const match = /^references:\s*([^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*)/im.exec(headers);
  const ids = match?.[1]?.match(/<[^>\s]+>/g) ?? [];
  return ids[0]?.trim().toLowerCase();
}

function attachmentMaxBytes(): number {
  const fallback = 10 * 1024 * 1024;
  const hardMax = 100 * 1024 * 1024;
  const value = Number(process.env.MCP_ATTACHMENT_MAX_BYTES ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.min(Math.floor(value), hardMax)) : fallback;
}

function attachmentScanMaxBytes(): number {
  const fallback = 1024 * 1024;
  const hardMax = 4 * 1024 * 1024;
  const value = Number(process.env.MCP_ATTACHMENT_SCAN_BYTES ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.min(Math.floor(value), hardMax)) : fallback;
}

function safetyBodyMaxBytes(): number {
  const fallback = 256 * 1024;
  const hardMax = 1024 * 1024;
  const value = Number(process.env.MCP_SAFETY_BODY_BYTES ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.min(Math.floor(value), hardMax)) : fallback;
}

export class AttachmentTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`attachment exceeds MCP_ATTACHMENT_MAX_BYTES=${maxBytes}`);
    this.name = 'AttachmentTooLargeError';
  }
}

export class AttachmentNotFoundError extends Error {
  constructor(partId: string) {
    super(`attachment part not found: ${partId}`);
    this.name = 'AttachmentNotFoundError';
  }
}

export interface AttachmentManifestLookup {
  folder: string;
  manifest: AttachmentManifest;
}

export interface MailSafetyFinding {
  code: string;
  severity: 'info' | 'caution' | 'warning';
  detail: string;
  attachment?: string;
  /** Host only for link findings; paths and query parameters are omitted. */
  linkHost?: string;
}

export interface MailSafetyReport {
  account: string;
  messageId: string;
  folder: string;
  spamSignals: {
    inSpamFolder: boolean;
    bulkHeaders: string[];
    precedence: string | null;
  };
  senderSignals: {
    fromAddress: string;
    replyToAddresses: string[];
    replyToDomainMismatch: boolean;
  };
  attachments: AttachmentInfo[];
  attachmentsTruncated: boolean;
  links: LinkRiskReport;
  findings: MailSafetyFinding[];
  limitations: string;
}

export interface DownloadedAttachment {
  metadata: AttachmentInfo;
  content: Buffer;
}

interface DownloadedPrefix {
  content: Buffer;
  truncated: boolean;
}

export const MAIL_ACTIONS = ['mark_read', 'mark_unread', 'star', 'unstar', 'move'] as const;
export type MailAction = (typeof MAIL_ACTIONS)[number];

export interface MailActionResult {
  action: MailAction;
  account: string;
  messageId: string;
  sourceFolder: string;
  destinationFolder?: string;
}

export class MailActionError extends Error {
  constructor(readonly code: 'invalid_action' | 'invalid_destination' | 'not_found' | 'failed', message: string) {
    super(message);
    this.name = 'MailActionError';
  }
}

function isUnsafeMoveDestination(path: string): boolean {
  const normalized = path.trim().toLowerCase();
  const leaf = normalized.split('/').at(-1) ?? normalized;
  return new Set(['trash', 'deleted', 'deleted items', 'deleted messages', '回收站', '已删除', '已刪除']).has(leaf);
}

async function extractLargeMessageBody(
  client: ImapFlow,
  uid: number,
  structure: FetchMessageObject['bodyStructure'],
  maxBytes: number,
): Promise<{ body: string; hasAttachments: boolean }> {
  const part = findTextBodyPart(structure);
  if (!part) return { body: '', hasAttachments: false };

  const download = await client.download(uid, part.partId, { uid: true, maxBytes: maxBytes + 1 });
  if (!download.content) return { body: '', hasAttachments: false };
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of download.content) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      download.content.destroy();
      throw new Error(`text body part ${part.partId} exceeds MAX_MESSAGE_SOURCE_BYTES=${maxBytes}`);
    }
    chunks.push(buffer);
  }

  const decoded = Buffer.concat(chunks, size).toString('utf8');
  const text = part.contentType === 'text/plain' ? decoded : htmlToText(decoded);
  return { body: text.replace(/\s+/g, ' ').trim(), hasAttachments: false };
}

/** Find candidate UIDs in the currently selected folder and confirm exact IDs at fetch time. */
async function searchMessageUids(client: ImapFlow, messageId: string): Promise<number[]> {
  const headerFound = await client.search({ header: { 'message-id': messageId } }, { uid: true });
  const found = Array.isArray(headerFound) && headerFound.length
    ? headerFound
    : await client.search({ text: messageId }, { uid: true });
  let foundUids = Array.isArray(found) ? found : [];
  if (foundUids.length === 0) {
    const lookbackDays = intEnv('MCP_LIVE_LOOKBACK_DAYS', 90);
    const maxCandidates = intEnv('MCP_LIVE_SEARCH_MAX_MESSAGES', 500);
    const broad = await client.search(
      { since: new Date(Date.now() - lookbackDays * 86_400_000) },
      { uid: true },
    );
    if (Array.isArray(broad) && broad.length > maxCandidates) {
      throw new Error(`live IMAP search exceeds MCP_LIVE_SEARCH_MAX_MESSAGES (${maxCandidates})`);
    }
    const matching: number[] = [];
    for await (const raw of client.fetch(
      Array.isArray(broad) ? broad : [],
      { uid: true, envelope: true },
      { uid: true },
    )) {
      if (raw.envelope?.messageId?.trim() === messageId) matching.push(raw.uid);
    }
    foundUids = matching;
  }
  return foundUids;
}


async function toMailMessage(
  raw: FetchMessageObject,
  account: Account,
  folder: Folder,
  parsedBody?: { body: string; hasAttachments: boolean },
): Promise<MailMessage> {
  const envelope = raw.envelope;
  const from = firstAddress(envelope?.from);
  const headers = raw.headers?.toString('utf8') ?? '';
  const { body, hasAttachments } = parsedBody ?? await extractBody(raw.source);
  const attachmentManifest = extractAttachmentManifest(raw.bodyStructure);

  const messageId =
    envelope?.messageId?.trim() ||
    fallbackMessageId(account.username, {
      date: normalizeDate(envelope?.date),
      subject: envelope?.subject ?? '',
      from: from.address,
      uid: raw.uid,
    });

  const rootReference = threadReference(headers) || envelope?.inReplyTo?.trim().toLowerCase() || messageId.toLowerCase();

  return {
    account: account.username,
    accountLabel: account.name,
    provider: account.provider,
    folder: folder.path,
    inSpam: folder.isSpam,
    uid: raw.uid,
    messageId,
    subject: envelope?.subject?.trim() ?? '',
    fromAddr: from.address,
    fromName: from.name,
    toAddrs: ((envelope?.to ?? []) as Array<{ address?: string }>)
      .map((a) => (a.address ?? '').toLowerCase())
      .filter(Boolean),
    date: normalizeDate(envelope?.date),
    body,
    threadKey: `${account.username}|${rootReference}`,
    hasAttachments: hasAttachments || attachmentManifest.items.length > 0 || attachmentManifest.truncated,
    attachmentManifest,
    listUnsubscribe: /^list-unsubscribe:/im.test(headers),
  };
}

/** Fetch messages after the folder cursor and return the messages plus new cursor. */
export async function fetchNew(
  client: ImapFlow,
  account: Account,
  folder: Folder,
  cursor: FolderCursor | undefined,
  budget?: MessageBudget,
): Promise<{ messages: MailMessage[]; cursor: FolderCursor; failures: FetchFailure[] }> {
  // readOnly: this tool observes and does not modify mailbox state.
  const lock = await client.getMailboxLock(folder.path, { readOnly: true });
  try {
    const mailbox = client.mailbox;
    const uidValidity = typeof mailbox === 'object' ? String(mailbox.uidValidity ?? '') : '';
    const lookbackDays = intEnv('INITIAL_LOOKBACK_DAYS', 3);
    const maxPerPoll = intEnv('MAX_MESSAGES_PER_POLL', 200);

    const fresh = !cursor || cursor.uidValidity !== uidValidity;
    if (cursor && fresh) {
      log.warn(`UIDVALIDITY changed (${cursor.uidValidity} -> ${uidValidity}); using date lookback`);
    }

    const floor = fresh ? 0 : cursor.lastUid;
    const since = new Date(Date.now() - lookbackDays * 86_400_000);
    const found = await client.search(fresh ? { since } : { uid: `${floor + 1}:*` }, { uid: true });
    const foundUids = found || [];

    // `UID n:*` can include the last message as a fallback. Filter again here.
    // Take the oldest batch so a cap cannot skip older mail.
    const maxLookback = intEnv('MAX_MESSAGES_PER_LOOKBACK', 500);
    let limit = Math.min(maxPerPoll, budget?.remaining ?? maxPerPoll);
    if (fresh && isOversizedLookback(foundUids, maxLookback)) {
      // Do not advance past an oversized initial backlog. Fetch the oldest
      // bounded chunk instead; the returned cursor turns the next poll into a
      // normal UID-incremental poll, so every message is eventually covered.
      limit = Math.min(limit, maxLookback);
      log.warn(
        `[${account.name}/${folder.path}] lookback returned ${foundUids.length} messages, over the ${maxLookback} limit; ` +
          `processing the oldest chunk of ${limit} instead of skipping the backlog`,
      );
    }
    const uids = selectFetchUids(foundUids, floor, limit);
    if (budget) budget.remaining -= uids.length;
    if (uids.length === 0) {
      return { messages: [], cursor: { uidValidity, lastUid: fresh ? 0 : cursor.lastUid }, failures: [] };
    }

    const messages: MailMessage[] = [];
    const failures: FetchFailure[] = [];
    const maxSourceBytes = intEnv('MAX_MESSAGE_SOURCE_BYTES', 5 * 1024 * 1024);
    const fetched: FetchMessageObject[] = [];
    for await (const raw of client.fetch(
      uids,
      {
        uid: true,
        size: true,
        envelope: true,
        bodyStructure: true,
        headers: ['list-unsubscribe', 'references'],
      },
      { uid: true },
    )) {
      fetched.push(raw);
    }

    // Avoid downloading large attachments as part of the message source. Small
    // messages keep the existing mailparser path; large messages fetch only
    // the selected text/plain or HTML body part below.
    const sourceUids = fetched
      .filter((raw) => raw.size === undefined || raw.size <= maxSourceBytes)
      .map((raw) => raw.uid);
    const sources = new Map<number, Buffer>();
    if (sourceUids.length) {
      for await (const raw of client.fetch(
        sourceUids,
        { uid: true, source: { maxLength: maxSourceBytes + 1 } },
        { uid: true },
      )) {
        if (raw.source) sources.set(raw.uid, raw.source);
      }
    }

    for (const raw of fetched) {
      const envelope = raw.envelope;
      const subject = envelope?.subject?.trim() ?? '';
      const messageId = envelope?.messageId?.trim() ?? '';
      try {
        const source = sources.get(raw.uid);
        const sourceWasFetched = sources.has(raw.uid);
        const needsTextPart = (raw.size !== undefined && raw.size > maxSourceBytes)
          || (source !== undefined && source.length > maxSourceBytes)
          || !sourceWasFetched;
        const parsedBody = needsTextPart
          ? await extractLargeMessageBody(client, raw.uid, raw.bodyStructure, maxSourceBytes)
          : await extractBody(source);
        messages.push(await toMailMessage(raw, account, folder, parsedBody));
      } catch (error) {
        // One malformed message must not stop the entire folder.
        log.warn(`Failed to parse uid=${raw.uid}; skipping: ${error}`);
        failures.push({ folder: folder.path, uidValidity, uid: raw.uid, subject, messageId, reason: String(error) });
      }
    }

    log.info(
      `[${account.name}/${folder.path}] fetched ${messages.length} new messages${folder.isSpam ? ' (spam)' : ''}`,
    );
    return { messages, cursor: { uidValidity, lastUid: Math.max(...uids) }, failures };
  } finally {
    lock.release();
  }
}

/**
 * Find one message by its Message-ID and return its raw source.
 *
 * The loop both live readers share: each folder in turn under a read-only
 * lock, the bounded source fetched, and the id confirmed on the parsed
 * envelope rather than trusted from the search, which can match on text.
 * `parseBody` is off for a caller that reads the source itself, so the
 * message is not run through the MIME parser twice.
 *
 * A message over the size limit is refused, unless the caller asks for it
 * `slim`: then the message is first identified from its headers alone, and
 * its source is either fetched whole (when it fits) or rebuilt from its
 * headers and its text parts, so that a large attachment does not make the
 * few lines around it unreadable.
 */
async function findLiveSource(
  client: ImapFlow,
  account: Account,
  messageId: string,
  folders: readonly LookupFolder[],
  options: { withFlags: boolean; parseBody: boolean; oversize?: 'slim' },
): Promise<{ raw: FetchMessageObject; folder: Folder; message: MailMessage } | undefined> {
  const maxSourceBytes = intEnv('MCP_LIVE_SOURCE_BYTES', 5 * 1024 * 1024);
  const slim = options.oversize === 'slim';
  for (const folder of folders) {
    const lock = await lockFolder(client, folder, true);
    if (!lock) continue;
    try {
      const foundUids = await searchMessageUids(client, messageId);
      if (!foundUids.length) continue;
      // Collected before anything else is asked of the server: a command
      // issued while a fetch is still being read would wait on it forever.
      const candidates: FetchMessageObject[] = [];
      for await (const raw of client.fetch(
        foundUids,
        {
          uid: true,
          size: true,
          envelope: true,
          bodyStructure: true,
          ...(slim
            ? { headers: true }
            : { source: { maxLength: maxSourceBytes + 1 }, headers: ['list-unsubscribe', 'references'] }),
          ...(options.withFlags ? { flags: true } : {}),
        },
        { uid: true },
      )) candidates.push(raw);

      for (const raw of candidates) {
        if (!slim && raw.size !== undefined && raw.size > maxSourceBytes) {
          throw new Error(`message exceeds MCP_LIVE_SOURCE_BYTES (${maxSourceBytes})`);
        }
        const message = await toMailMessage(
          raw, account, folder, options.parseBody ? undefined : { body: '', hasAttachments: false },
        );
        if (message.messageId !== messageId) continue;
        if (slim) raw.source = await readingSource(client, raw, maxSourceBytes);
        return { raw, folder, message };
      }
    } finally {
      lock.release();
    }
  }
  return undefined;
}

/** Text read from a message too large to fetch whole. Far more than anyone reads; markup past the reader's own limit would be dropped anyway. */
const SLIM_TEXT_BYTES = 1024 * 1024;

/**
 * The source the reading view parses: the whole message when it fits, and
 * otherwise its headers with only its text and its markup (see slimSource).
 */
async function readingSource(client: ImapFlow, raw: FetchMessageObject, maxSourceBytes: number): Promise<Buffer> {
  if (raw.size === undefined || raw.size <= maxSourceBytes) {
    const whole = await client.fetchOne(String(raw.uid), { uid: true, source: { maxLength: maxSourceBytes + 1 } }, { uid: true });
    const source = whole ? whole.source : undefined;
    // A server that did not say how large the message is may still hand over too much.
    if (source && source.length <= maxSourceBytes) return source;
    if (!source) return Buffer.alloc(0);
  }
  const { plain, html } = findBodyParts(raw.bodyStructure);
  const text = plain ? await downloadDecodedPrefix(client, raw.uid, plain.partId, SLIM_TEXT_BYTES) : undefined;
  const markup = html ? await downloadDecodedPrefix(client, raw.uid, html.partId, MAX_HTML_BYTES) : undefined;
  return slimSource(raw.headers ?? Buffer.alloc(0), {
    ...(text ? { plain: text.content } : {}),
    // Markup cut off in the middle is not markup; the text stands in for it.
    ...(markup && !markup.truncated ? { html: markup.content } : {}),
  });
}

/**
 * Fetch one message on demand without persisting it or changing mailbox state.
 *
 * This is used by the MCP Resource path. The caller supplies a configured
 * account and Message-ID; the body exists only for the duration of this call.
 */
export async function fetchByMessageId(account: Account, messageId: string): Promise<MailMessage | undefined> {
  const client = await connect(account);
  try {
    const folders = await targetFolders(client, account);
    return (await findLiveSource(client, account, messageId, folders, { withFlags: false, parseBody: true }))?.message;
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** One message as the reading view shows it, with where it is and how the mailbox has it flagged. */
export interface LiveMessage {
  readable: ReadableMessage;
  /** The folder it was found in, which is the hint to pass next time. */
  folder: string;
  flags: { seen: boolean; flagged: boolean; answered: boolean };
}

/**
 * Fetch one message for reading: its markup, its text, its headers and flags.
 *
 * One IMAP session and a read-only lock, so opening a message in the web view
 * does not mark it read in the mailbox. `folderHint` is searched first; it may
 * be a folder outside the configured ones, because a message archived or
 * binned from the web view has left the folder the poller found it in.
 * Nothing is persisted: the source is parsed and dropped.
 */
export async function fetchReadableByMessageId(
  account: Account,
  messageId: string,
  folderHint?: string,
): Promise<LiveMessage | undefined> {
  const client = await connect(account);
  let found: Awaited<ReturnType<typeof findLiveSource>>;
  try {
    const folders = await lookupFolders(client, account, folderHint);
    found = await findLiveSource(client, account, messageId, folders, { withFlags: true, parseBody: false, oversize: 'slim' });
  } finally {
    await client.logout().catch(() => undefined);
  }
  if (!found) return undefined;
  // Parsed after the connection is closed: it needs no server, and a large
  // message should not hold a mailbox session open while it is read.
  // The sender's authentication is believed only from this mailbox's own server.
  const authserv = authservTrust(account.host, account.authservId);
  const readable = await parseReadable(found.raw.source ?? Buffer.alloc(0), authserv ? { authserv } : {});
  const flags = found.raw.flags ?? new Set<string>();
  return {
    readable,
    folder: found.folder.path,
    flags: { seen: flags.has('\\Seen'), flagged: flags.has('\\Flagged'), answered: flags.has('\\Answered') },
  };
}

/**
 * Read lightweight attachment metadata from the configured mailbox without
 * fetching the full message source or changing mailbox state.
 */
export async function fetchAttachmentManifestByMessageId(
  account: Account,
  messageId: string,
  folderHint?: string,
): Promise<AttachmentManifestLookup | undefined> {
  const client = await connect(account);
  try {
    const folders = await lookupFolders(client, account, folderHint);
    for (const folder of folders) {
      const lock = await lockFolder(client, folder, true);
      if (!lock) continue;
      try {
        const uids = await searchMessageUids(client, messageId);
        if (!uids.length) continue;
        for await (const raw of client.fetch(
          uids,
          { uid: true, envelope: true, bodyStructure: true },
          { uid: true },
        )) {
          if (raw.envelope?.messageId?.trim() !== messageId) continue;
          return { folder: folder.path, manifest: extractAttachmentManifest(raw.bodyStructure) };
        }
      } finally {
        lock.release();
      }
    }
    return undefined;
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** Read at most maxBytes from a decoded MIME part, retaining no suffix. */
async function downloadDecodedPrefix(
  client: ImapFlow,
  uid: number,
  partId: string,
  maxBytes: number,
): Promise<DownloadedPrefix> {
  const download = await client.download(uid, partId, { uid: true, maxBytes: maxBytes + 1 });
  if (!download.content) return { content: Buffer.alloc(0), truncated: false };
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of download.content) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = maxBytes - size;
    if (buffer.length > remaining) {
      if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
      size = maxBytes;
      truncated = true;
      download.content.destroy();
      break;
    }
    chunks.push(buffer);
    size += buffer.length;
  }
  return { content: Buffer.concat(chunks, size), truncated };
}

/**
 * Scan one attachment using only a bounded decoded prefix. The bytes are held
 * for this call and discarded before the report is returned.
 */
export async function scanAttachmentByMessageId(
  account: Account,
  messageId: string,
  partId: string,
  folderHint?: string,
): Promise<AttachmentScanReport | undefined> {
  if (!/^\d+(?:\.\d+)*$/.test(partId)) throw new AttachmentNotFoundError(partId);
  const maxBytes = attachmentScanMaxBytes();
  const client = await connect(account);
  try {
    const folders = await lookupFolders(client, account, folderHint);
    for (const folder of folders) {
      const lock = await lockFolder(client, folder, true);
      if (!lock) continue;
      try {
        const uids = await searchMessageUids(client, messageId);
        if (!uids.length) continue;
        for (const uid of uids) {
          const raw = await client.fetchOne(
            uid,
            { uid: true, envelope: true, bodyStructure: true },
            { uid: true },
          );
          if (!raw || raw.envelope?.messageId?.trim() !== messageId) continue;
          const metadata = extractAttachmentManifest(raw.bodyStructure).items.find((part) => part.partId === partId);
          if (!metadata) throw new AttachmentNotFoundError(partId);
          const prefix = await downloadDecodedPrefix(client, uid, partId, maxBytes);
          return scanAttachment(metadata, prefix.content, prefix.truncated);
        }
      } finally {
        lock.release();
      }
    }
    return undefined;
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/**
 * Inspect delivery headers, a bounded text-body prefix, and MIME structure for
 * spam and safety clues. Link parsing is local only: no URL is opened or
 * resolved, and attachment bytes are not downloaded by this function.
 */
export async function inspectMailSafety(
  account: Account,
  messageId: string,
  folderHint?: string,
): Promise<MailSafetyReport | undefined> {
  const client = await connect(account);
  try {
    const folders = await lookupFolders(client, account, folderHint);
    for (const folder of folders) {
      const lock = await lockFolder(client, folder, true);
      if (!lock) continue;
      try {
        const uids = await searchMessageUids(client, messageId);
        if (!uids.length) continue;
        // Use one FETCH at a time because a matching record may need a
        // bounded body-part DOWNLOAD while the read-only lock is held.
        for (const uid of uids) {
          const raw = await client.fetchOne(
            uid,
            {
              uid: true,
              envelope: true,
              bodyStructure: true,
              headers: ['list-id', 'list-unsubscribe', 'precedence'],
            },
            { uid: true },
          );
          if (!raw) continue;
          if (raw.envelope?.messageId?.trim() !== messageId) continue;

          const values = parseHeaderValues(raw.headers);
          const listId = (values.get('list-id')?.length ?? 0) > 0;
          const listUnsubscribe = (values.get('list-unsubscribe')?.length ?? 0) > 0;
          const precedenceValues = (values.get('precedence') ?? [])
            .map((value) => value.split(/[;,]/, 1)[0]?.trim().toLowerCase() ?? '')
            .filter(Boolean);
          const precedence = precedenceValues[0]?.slice(0, 40) ?? null;
          const bulkPrecedence = precedenceValues.find((value) => ['bulk', 'junk', 'list'].includes(value));
          const bulkHeaders = [
            ...(listId ? ['list-id'] : []),
            ...(listUnsubscribe ? ['list-unsubscribe'] : []),
            ...(bulkPrecedence ? ['precedence'] : []),
          ];

          const fromAddress = firstAddress(raw.envelope?.from).address;
          const replyToAddresses = (raw.envelope?.replyTo ?? [])
            .map((address) => (address.address ?? '').trim().toLowerCase())
            .filter(Boolean);
          const fromDomain = addressDomain(fromAddress);
          const replyToDomainMismatch = Boolean(fromDomain && replyToAddresses.some((address) => {
            const replyDomain = addressDomain(address);
            return replyDomain !== undefined && replyDomain !== fromDomain;
          }));
          const attachmentManifest = extractAttachmentManifest(raw.bodyStructure);
          const attachments = attachmentManifest.items;
          const findings: MailSafetyFinding[] = [];

          if (folder.isSpam) {
            findings.push({
              code: 'spam_folder',
              severity: 'warning',
              detail: 'This message is in a configured folder recognized as spam or junk.',
            });
          }
          if (bulkHeaders.length) {
            findings.push({
              code: 'bulk_headers',
              severity: 'info',
              detail: `Mailing-list or bulk-mail markers found: ${bulkHeaders.join(', ')}. These markers do not prove spam.`,
            });
          }
          if (replyToDomainMismatch) {
            findings.push({
              code: 'reply_to_domain_mismatch',
              severity: 'warning',
              detail: 'Reply-To uses a different domain from From; verify the recipient independently before replying.',
            });
          }
          for (const attachment of attachments) {
            for (const code of attachment.safetyWarnings ?? []) {
              findings.push({
                code: `attachment_${code}`,
                severity: code === 'archive_not_scanned' ? 'caution' : 'warning',
                detail: attachmentWarningDetail(code),
                attachment: attachment.filename ?? `part ${attachment.partId}`,
              });
            }
          }

          let links: LinkRiskReport = {
            checked: false,
            bodyPart: null,
            scannedBytes: 0,
            truncated: false,
            linksFound: 0,
            findings: [],
            findingsTruncated: false,
            limitations:
              'No readable text body part was found, so no links were parsed. No URL was opened or resolved.',
          };
          const textPart = findTextBodyPart(raw.bodyStructure);
          if (textPart) {
            try {
              const prefix = await downloadDecodedPrefix(client, raw.uid, textPart.partId, safetyBodyMaxBytes());
              links = inspectLinkRisks(prefix.content.toString('utf8'), {
                bodyPart: textPart.partId,
                scannedBytes: prefix.content.length,
                truncated: prefix.truncated,
              });
              for (const finding of links.findings) {
                findings.push({
                  code: finding.code,
                  severity: finding.severity,
                  detail: finding.detail,
                  ...(finding.host ? { linkHost: finding.host } : {}),
                });
              }
            } catch (error) {
              links = {
                ...links,
                limitations: 'The bounded text body could not be read, so links were not parsed. No URL was opened or resolved.',
                findings: [],
              };
              log.warn(`Unable to inspect bounded links for ${messageId}: ${String(error).slice(0, 200)}`);
            }
          }

          return {
            account: account.username,
            messageId,
            folder: folder.path,
            spamSignals: {
              inSpamFolder: folder.isSpam,
              bulkHeaders,
              precedence,
            },
            senderSignals: {
              fromAddress,
              replyToAddresses,
              replyToDomainMismatch,
            },
            attachments,
            attachmentsTruncated: attachmentManifest.truncated,
            links,
            findings,
            limitations:
              'Heuristics only. Bulk headers are not a spam verdict; From and Reply-To may be spoofed. ' +
              'Sender authentication is not verified. Links are parsed from a bounded body prefix but never opened; ' +
              'attachment contents are not inspected here.',
          };
        }
      } finally {
        lock.release();
      }
    }
    return undefined;
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/**
 * Fetch one attachment body part on demand. The MIME part is checked against
 * BODYSTRUCTURE before downloading, so callers cannot use this path to fetch
 * arbitrary message sections. Nothing is persisted.
 */
export async function fetchAttachmentByMessageId(
  account: Account,
  messageId: string,
  partId: string,
  folderHint?: string,
): Promise<DownloadedAttachment | undefined> {
  if (!/^\d+(?:\.\d+)*$/.test(partId)) throw new AttachmentNotFoundError(partId);
  const maxBytes = attachmentMaxBytes();
  const client = await connect(account);
  try {
    const folders = await lookupFolders(client, account, folderHint);
    for (const folder of folders) {
      const lock = await lockFolder(client, folder, true);
      if (!lock) continue;
      try {
        const uids = await searchMessageUids(client, messageId);
        if (!uids.length) continue;
        for (const uid of uids) {
          const raw = await client.fetchOne(
            uid,
            { uid: true, envelope: true, bodyStructure: true },
            { uid: true },
          );
          if (!raw || raw.envelope?.messageId?.trim() !== messageId) continue;
          const metadata = extractAttachmentManifest(raw.bodyStructure).items.find((part) => part.partId === partId);
          if (!metadata) throw new AttachmentNotFoundError(partId);
          const download = await client.download(uid, partId, { uid: true, maxBytes: maxBytes + 1 });
          if (!download.content) throw new AttachmentNotFoundError(partId);
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of download.content) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.length;
            if (size > maxBytes) {
              download.content.destroy();
              throw new AttachmentTooLargeError(maxBytes);
            }
            chunks.push(buffer);
          }
          return { metadata, content: Buffer.concat(chunks, size) };
        }
      } finally {
        lock.release();
      }
    }
    return undefined;
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** What each flag action does, and the word its refusal is reported with. */
const FLAG_CHANGES = {
  mark_read: { flag: '\\Seen', add: true, name: 'mark-read' },
  mark_unread: { flag: '\\Seen', add: false, name: 'mark-unread' },
  star: { flag: '\\Flagged', add: true, name: 'star' },
  unstar: { flag: '\\Flagged', add: false, name: 'unstar' },
  answered: { flag: '\\Answered', add: true, name: 'mark-answered' },
} as const;

/**
 * Apply one action to one message and return the folder it was found in.
 *
 * Shared by the MCP tool and the web view. The message is located again by
 * its Message-ID inside each folder and confirmed on its envelope before
 * anything is changed, so a stale local row cannot turn into an arbitrary UID.
 */
async function actOnMessage(
  client: ImapFlow,
  messageId: string,
  folders: readonly LookupFolder[],
  action: WebMailAction,
  destinationPath: string | undefined,
): Promise<string | undefined> {
  for (const folder of folders) {
    const lock = await lockFolder(client, folder, false);
    if (!lock) continue;
    try {
      const uids = await searchMessageUids(client, messageId);
      if (!uids.length) continue;
      for (const uid of uids) {
        const raw = await client.fetchOne(uid, { uid: true, envelope: true }, { uid: true });
        if (!raw || raw.envelope?.messageId?.trim() !== messageId) continue;
        const change = action in FLAG_CHANGES ? FLAG_CHANGES[action as keyof typeof FLAG_CHANGES] : undefined;
        if (change) {
          const accepted = change.add
            ? await client.messageFlagsAdd([uid], [change.flag], { uid: true })
            : await client.messageFlagsRemove([uid], [change.flag], { uid: true });
          if (!accepted) throw new MailActionError('failed', `IMAP server rejected the ${change.name} operation`);
        } else if (destinationPath) {
          if (destinationPath === folder.path) {
            throw new MailActionError('invalid_destination', 'message is already in the destination folder');
          }
          if (!await client.messageMove([uid], destinationPath, { uid: true })) {
            throw new MailActionError('failed', 'IMAP server rejected the move operation');
          }
        }
        return folder.path;
      }
    } finally {
      lock.release();
    }
  }
  return undefined;
}

/**
 * Apply one narrowly-scoped mailbox action after the caller has presented the
 * separate write credential. Message IDs are resolved again inside the
 * selected mailbox, so a stale local row cannot turn into an arbitrary UID.
 */
export async function applyMessageAction(
  account: Account,
  messageId: string,
  action: MailAction,
  destination?: string,
): Promise<MailActionResult | undefined> {
  if (!MAIL_ACTIONS.includes(action)) {
    throw new MailActionError('invalid_action', `unsupported mail action: ${action}`);
  }
  const target = destination?.trim();
  if (action === 'move' && !target) {
    throw new MailActionError('invalid_destination', 'move requires a destination folder');
  }
  if (action === 'move' && target && isUnsafeMoveDestination(target)) {
    throw new MailActionError('invalid_destination', 'moving to a delete/trash folder is disabled');
  }

  const client = await connect(account);
  try {
    let destinationPath: string | undefined;
    if (action === 'move') {
      const listed = await listFolders(client);
      const found = listed.find((entry) => entry.path === target);
      const flags = new Set([...((found?.flags ?? []) as Iterable<string>)].map((flag) => String(flag).toLowerCase()));
      if (!found || flags.has('\\noselect')) {
        throw new MailActionError('invalid_destination', `destination folder not found or not selectable: ${target}`);
      }
      destinationPath = found.path;
    }

    const folders = await targetFolders(client, account);
    const sourceFolder = await actOnMessage(client, messageId, folders, action, destinationPath);
    if (sourceFolder === undefined) return undefined;
    return {
      action,
      account: account.username,
      messageId,
      sourceFolder,
      ...(destinationPath ? { destinationFolder: destinationPath } : {}),
    };
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/**
 * What the web view may do to a message.
 *
 * A person looking at one message and pressing one button, not an agent with a
 * tool: so this set adds what a mail client is expected to do (archive, bin,
 * rescue to the inbox, mark as answered) to the actions the MCP tool has.
 * MAIL_ACTIONS is deliberately left as it was. The MCP tool builds its schema
 * from it and promises there that nothing can be sent to the trash.
 */
export const WEB_MAIL_ACTIONS = [...MAIL_ACTIONS, 'archive', 'trash', 'inbox', 'answered'] as const;
export type WebMailAction = (typeof WEB_MAIL_ACTIONS)[number];

export type WebMailActionResult = Omit<MailActionResult, 'action'> & {
  action: WebMailAction;
  /** Set with destinationFolder: whether the message now sits in a spam folder. */
  destinationIsSpam?: boolean;
};

type MovingAction = 'move' | 'archive' | 'trash' | 'inbox';
const MOVING_ACTIONS = new Set<WebMailAction>(['move', 'archive', 'trash', 'inbox']);

/** Names for servers that list an archive folder without its special-use flag. */
const ARCHIVE_NAMES = new Set(['archive', 'archives', '归档', '已归档', '存档', '封存']);
/** Gmail has no archive folder: archiving is leaving the inbox for All Mail. */
const GMAIL_ALL_NAMES = new Set(['[gmail]/all mail', '[google mail]/all mail']);
const TRASH_NAMES = new Set([
  'trash', 'deleted', 'deleted items', 'deleted messages', 'bin',
  '已删除', '已刪除', '已删除邮件', '回收站', '废纸篓', '廢紙簍',
]);
const SENT_NAMES = new Set(['sent', 'sent messages', 'sent items', 'sent mail', '已发送', '已发送邮件', '已寄郵件']);

function entryFlags(entry: ListResponse): Set<string> {
  return new Set([...((entry.flags ?? []) as Iterable<string>)].map((flag) => String(flag).toLowerCase()));
}

function entrySelectable(entry: ListResponse): boolean {
  return !entryFlags(entry).has('\\noselect');
}

/** RFC 6154 special use, whether the server sent it as an attribute or ImapFlow resolved it. */
function entryHasUse(entry: ListResponse, use: string): boolean {
  return (entry.specialUse ?? '').trim().toLowerCase() === use || entryFlags(entry).has(use);
}

function entryByName(entries: readonly ListResponse[], names: ReadonlySet<string>): ListResponse | undefined {
  return entries.find((entry) => {
    if (!entrySelectable(entry)) return false;
    const path = entry.path.trim().toLowerCase();
    const leaf = path.split(entry.delimiter || '/').at(-1) ?? path;
    return names.has(path) || names.has(leaf);
  });
}

/**
 * Where a moving action puts the message, decided from the folder list alone.
 *
 * Pure, so each provider's layout can be checked without a server. Special-use
 * flags come first because names are localized and users rename folders;
 * well-known names are the fallback for servers that send no flags. A mailbox
 * with no such folder is refused rather than given one: creating folders in
 * someone's mailbox is not what pressing Archive asks for.
 */
export function resolveActionDestination(
  entries: readonly ListResponse[],
  action: MovingAction,
  provider = '',
  destination?: string,
): { path: string; isSpam: boolean } {
  let found: ListResponse | undefined;
  if (action === 'move') {
    const target = destination?.trim();
    if (!target) throw new MailActionError('invalid_destination', 'move requires a destination folder');
    found = entries.find((entry) => entry.path === target);
    if (!found || !entrySelectable(found)) {
      throw new MailActionError('invalid_destination', `destination folder not found or not selectable: ${target}`);
    }
  } else if (action === 'inbox') {
    found = entries.find((entry) => entrySelectable(entry) && (entryHasUse(entry, '\\inbox') || entry.path.toUpperCase() === 'INBOX'));
    // Every IMAP server has INBOX, listed or not.
    if (!found) return { path: 'INBOX', isSpam: false };
  } else if (action === 'archive') {
    const gmail = provider.toLowerCase().startsWith('gmail');
    found = entries.find((entry) => entrySelectable(entry) && entryHasUse(entry, '\\archive'))
      ?? entries.find((entry) => entrySelectable(entry) && entryHasUse(entry, '\\all')
        && (gmail || /^\[(?:gmail|google mail)\]\//i.test(entry.path)))
      ?? entryByName(entries, GMAIL_ALL_NAMES)
      ?? entryByName(entries, ARCHIVE_NAMES);
    if (!found) throw new MailActionError('invalid_destination', 'this mailbox has no archive folder');
  } else {
    found = entries.find((entry) => entrySelectable(entry) && entryHasUse(entry, '\\trash'))
      ?? entryByName(entries, TRASH_NAMES);
    if (!found) throw new MailActionError('invalid_destination', 'this mailbox has no trash folder');
  }
  return { path: found.path, isSpam: toFolder(found).isSpam };
}

/**
 * Apply one web-view action to a stored message.
 *
 * The caller is responsible for who may ask: this is reached only from a
 * session that signed in with the write credential. `folderHint` is searched
 * first, as in the live readers, so a message that was already moved once can
 * be acted on again. Returns undefined when the message is in none of the
 * folders searched.
 */
export async function applyWebMailAction(
  account: Account,
  messageId: string,
  action: WebMailAction,
  options: { destination?: string; folderHint?: string } = {},
): Promise<WebMailActionResult | undefined> {
  if (!WEB_MAIL_ACTIONS.includes(action)) {
    throw new MailActionError('invalid_action', `unsupported mail action: ${String(action)}`);
  }
  if (action === 'move' && !options.destination?.trim()) {
    throw new MailActionError('invalid_destination', 'move requires a destination folder');
  }

  const client = await connect(account);
  try {
    const entries = await listFolders(client);
    const destination = MOVING_ACTIONS.has(action)
      ? resolveActionDestination(entries, action as MovingAction, account.provider, options.destination)
      : undefined;
    const folders = orderLookupFolders(entries, resolveFolders(entries, account.folders), options.folderHint);
    const sourceFolder = await actOnMessage(client, messageId, folders, action, destination?.path);
    if (sourceFolder === undefined) return undefined;
    return {
      action,
      account: account.username,
      messageId,
      sourceFolder,
      ...(destination ? { destinationFolder: destination.path, destinationIsSpam: destination.isSpam } : {}),
    };
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** The folder sent mail is kept in, from the folder list alone. */
export function sentFolderPath(entries: readonly ListResponse[]): string | undefined {
  return (entries.find((entry) => entrySelectable(entry) && entryHasUse(entry, '\\sent'))
    ?? entryByName(entries, SENT_NAMES))?.path;
}

/**
 * File a message this service sent into the mailbox's Sent folder.
 *
 * SMTP submission does not keep a copy on most providers, so without this a
 * reply written here would be missing from the conversation everywhere else.
 * Gmail and Outlook save submitted mail themselves; the caller should skip
 * them, or the copy appears twice. Returns the folder, or undefined when the
 * mailbox has no Sent folder to put it in, which is not an error.
 */
export async function appendToSent(account: Account, raw: Buffer): Promise<string | undefined> {
  const client = await connect(account);
  try {
    const path = sentFolderPath(await listFolders(client));
    if (!path) return undefined;
    // Marked read: it is the owner's own message.
    if (!await client.append(path, raw, ['\\Seen'])) {
      throw new Error(`IMAP server rejected the append to ${path}`);
    }
    return path;
  } finally {
    await client.logout().catch(() => undefined);
  }
}
