/**
 * IMAP engine: one mail-fetching path for three authentication methods.
 *
 * Two lessons from the Python implementation must remain:
 *
 * 1. Never set \Seen. ImapFlow fetch uses peek semantics by default.
 * 2. IMAP `UID n:*` returns at least one message, even when its UID is below n.
 *    Filter the search result client-side or the last message repeats every poll.
 */
import { ImapFlow, type FetchMessageObject, type ListResponse } from 'imapflow';
import { getAccessToken } from './auth.js';
import { resolveFolders, type Folder } from './folders.js';
import { extractBody, fallbackMessageId, normalizeDate, type MailMessage } from './message.js';
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

export function selectFetchUids(found: readonly number[], floor: number, limit: number): number[] {
  return [...found]
    .filter((uid) => uid > floor)
    .sort((a, b) => a - b)
    .slice(0, Math.max(0, limit));
}

export function isOversizedLookback(found: readonly number[], limit: number): boolean {
  return found.length > limit;
}

export async function connect(account: Account): Promise<ImapFlow> {
  const auth = needsOAuth(account)
    ? { user: account.username, accessToken: await getAccessToken(account.username, account.auth) }
    : { user: account.username, pass: account.password ?? '' };

  const maxAttempts = 3;
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

      const delayMs = 1_000 * 2 ** (attempt - 1);
      log.warn(
        `[${account.name}] transient IMAP connection failure (${attempt}/${maxAttempts}); ` +
          `retrying in ${delayMs}ms: ${detail}`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
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


async function toMailMessage(
  raw: FetchMessageObject,
  account: Account,
  folder: Folder,
): Promise<MailMessage> {
  const envelope = raw.envelope;
  const from = firstAddress(envelope?.from);
  const headers = raw.headers?.toString('utf8') ?? '';
  const { body, hasAttachments } = await extractBody(raw.source);

  const messageId =
    envelope?.messageId?.trim() ||
    fallbackMessageId(account.username, {
      date: normalizeDate(envelope?.date),
      subject: envelope?.subject ?? '',
      from: from.address,
      uid: raw.uid,
    });

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
    hasAttachments,
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
): Promise<{ messages: MailMessage[]; cursor: FolderCursor }> {
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
      return { messages: [], cursor: { uidValidity, lastUid: fresh ? 0 : cursor.lastUid } };
    }

    const messages: MailMessage[] = [];
    for await (const raw of client.fetch(
      uids,
      { uid: true, envelope: true, source: true, headers: ['list-unsubscribe'] },
      { uid: true },
    )) {
      try {
        messages.push(await toMailMessage(raw, account, folder));
      } catch (error) {
        // One malformed message must not stop the entire folder.
        log.warn(`Failed to parse uid=${raw.uid}; skipping: ${error}`);
      }
    }

    log.info(
      `[${account.name}/${folder.path}] fetched ${messages.length} new messages${folder.isSpam ? ' (spam)' : ''}`,
    );
    return { messages, cursor: { uidValidity, lastUid: Math.max(...uids) } };
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
        const headerFound = await client.search({ header: { 'message-id': messageId } }, { uid: true });
        let found = Array.isArray(headerFound) && headerFound.length
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
        if (!foundUids.length) continue;
        for await (const raw of client.fetch(
          foundUids,
          {
            uid: true,
            size: true,
            envelope: true,
            source: { maxLength: maxSourceBytes + 1 },
            headers: ['list-unsubscribe'],
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
