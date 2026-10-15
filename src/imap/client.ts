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
import { resolveFolders, type Folder } from './folders.js';
import {
  extractAttachmentManifest, extractBody, fallbackMessageId, findTextBodyPart, htmlToText, normalizeDate,
  type AttachmentInfo, type AttachmentManifest, type MailMessage,
} from './message.js';
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

export async function targetFolders(client: ImapFlow, account: Account): Promise<Folder[]> {
  return resolveFolders(await listFolders(client), account.folders);
}

function firstAddress(input: unknown): { name: string; address: string } {
  const list = (input ?? []) as Array<{ name?: string; address?: string }>;
  const head = list[0];
  return { name: head?.name?.trim() ?? '', address: (head?.address ?? '').toLowerCase() };
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

export interface DownloadedAttachment {
  metadata: AttachmentInfo;
  content: Buffer;
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
 * Fetch one message on demand without persisting it or changing mailbox state.
 *
 * This is used by the MCP Resource path. The caller supplies a configured
 * account and Message-ID; the body exists only for the duration of this call.
 */
export async function fetchByMessageId(account: Account, messageId: string): Promise<MailMessage | undefined> {
  const client = await connect(account);
  const maxSourceBytes = intEnv('MCP_LIVE_SOURCE_BYTES', 5 * 1024 * 1024);
  try {
    const folders = await targetFolders(client, account);
    for (const folder of folders) {
      const lock = await client.getMailboxLock(folder.path, { readOnly: true });
      try {
        const foundUids = await searchMessageUids(client, messageId);
        if (!foundUids.length) continue;
        for await (const raw of client.fetch(
          foundUids,
          {
            uid: true,
            size: true,
            envelope: true,
            bodyStructure: true,
            source: { maxLength: maxSourceBytes + 1 },
            headers: ['list-unsubscribe', 'references'],
          },
          { uid: true },
        )) {
          if (raw.size !== undefined && raw.size > maxSourceBytes) {
            throw new Error(`message exceeds MCP_LIVE_SOURCE_BYTES (${maxSourceBytes})`);
          }
          const message = await toMailMessage(raw, account, folder);
          if (message.messageId === messageId) return message;
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
 * Read lightweight attachment metadata from the configured mailbox without
 * fetching the full message source or changing mailbox state.
 */
export async function fetchAttachmentManifestByMessageId(
  account: Account,
  messageId: string,
): Promise<AttachmentManifestLookup | undefined> {
  const client = await connect(account);
  try {
    const folders = await targetFolders(client, account);
    for (const folder of folders) {
      const lock = await client.getMailboxLock(folder.path, { readOnly: true });
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

/**
 * Fetch one attachment body part on demand. The MIME part is checked against
 * BODYSTRUCTURE before downloading, so callers cannot use this path to fetch
 * arbitrary message sections. Nothing is persisted.
 */
export async function fetchAttachmentByMessageId(
  account: Account,
  messageId: string,
  partId: string,
): Promise<DownloadedAttachment | undefined> {
  if (!/^\d+(?:\.\d+)*$/.test(partId)) throw new AttachmentNotFoundError(partId);
  const maxBytes = attachmentMaxBytes();
  const client = await connect(account);
  try {
    const folders = await targetFolders(client, account);
    for (const folder of folders) {
      const lock = await client.getMailboxLock(folder.path, { readOnly: true });
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
    for (const folder of folders) {
      const lock = await client.getMailboxLock(folder.path, { readOnly: false });
      try {
        const uids = await searchMessageUids(client, messageId);
        if (!uids.length) continue;
        for (const uid of uids) {
          const raw = await client.fetchOne(uid, { uid: true, envelope: true }, { uid: true });
          if (!raw || raw.envelope?.messageId?.trim() !== messageId) continue;
          if (action === 'mark_read') {
            if (!await client.messageFlagsAdd([uid], ['\\Seen'], { uid: true })) {
              throw new MailActionError('failed', 'IMAP server rejected the mark-read operation');
            }
          } else if (action === 'mark_unread') {
            if (!await client.messageFlagsRemove([uid], ['\\Seen'], { uid: true })) {
              throw new MailActionError('failed', 'IMAP server rejected the mark-unread operation');
            }
          } else if (action === 'star') {
            if (!await client.messageFlagsAdd([uid], ['\\Flagged'], { uid: true })) {
              throw new MailActionError('failed', 'IMAP server rejected the star operation');
            }
          } else if (action === 'unstar') {
            if (!await client.messageFlagsRemove([uid], ['\\Flagged'], { uid: true })) {
              throw new MailActionError('failed', 'IMAP server rejected the unstar operation');
            }
          } else if (destinationPath) {
            if (destinationPath === folder.path) {
              throw new MailActionError('invalid_destination', 'message is already in the destination folder');
            }
            if (!await client.messageMove([uid], destinationPath, { uid: true })) {
              throw new MailActionError('failed', 'IMAP server rejected the move operation');
            }
          }
          return {
            action,
            account: account.username,
            messageId,
            sourceFolder: folder.path,
            ...(destinationPath ? { destinationFolder: destinationPath } : {}),
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
