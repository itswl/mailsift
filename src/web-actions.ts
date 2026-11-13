/**
 * The part of the web view that does things.
 *
 * Reading what triage stored is the rest of the view. This file is where the
 * page stops being a window: marking a message dealt with, moving it in the
 * mailbox, correcting a judgement, sending a reply or a forward with what it
 * carries, keeping each mailbox's signature, asking the model a question, and
 * telling this server which devices want notifications.
 *
 * Three rules hold for every route here.
 *
 * 1. Who may: anything that touches a mailbox, sends mail or changes how
 *    future mail is judged needs a `write` session, which a browser gets only
 *    by signing in with MCP_WRITE_TOKEN. Marking something dealt with changes
 *    what every reader sees, so once a deployment has set that token, the
 *    read token cannot do it either; with no write token configured the one
 *    credential is the owner's and may keep the page's own books. Asking a
 *    question and this device's notifications are reading, and work for a
 *    `read` session.
 * 2. From where: every route is a POST (or a GET that changes nothing) and
 *    the router refuses a POST another site started before it gets here.
 * 3. On record: each mailbox action and each sent message is written to the
 *    same audit tables the MCP write tools use.
 *
 * The mailbox, the SMTP server and the model are reached through a small
 * `WebBackend`, so the preview and the tests can stand in for all three.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { loadConfig, type Account } from './config.js';
import { MailboxUnreachableError } from './imap/connection.js';
import {
  appendToSent, applyWebMailAction, AttachmentNotFoundError, AttachmentTooLargeError, fetchAttachmentByMessageId,
  fetchAttachmentManifestByMessageId, fetchReadableByMessageId, MAIL_ACTIONS, MailActionError,
  type AttachmentManifestLookup, type DownloadedAttachment, type LiveMessage, type LookupHint, type MessageHint,
  type WebMailAction, type WebMailActionResult,
} from './imap/client.js';
import {
  askMail, AssistantError, assistantConfigured, draftReply, type AskAnswer, type DraftInput,
} from './services/assistant.js';
import { sendTestPush, vapidKeys } from './services/push-dispatcher.js';
import { StateStore, type MailRow } from './services/state.js';
import { isPushEndpoint, type PushSendResult } from './services/webpush.js';
import {
  addressed, attachmentCharset, attachmentContentType, attachmentFilename, attachmentLimitBytes, describeBytes,
  forwardEnvelope, MAX_ATTACHMENTS, replyEnvelope, savesSentCopy, SendError, sendingStatus, sendMail, transferAllowanceMs,
  type OutgoingAttachment, type OutgoingMail, type SentMail,
} from './smtp.js';
import {
  json, rateWindow, readJson, readJsonOrSize, text, textList, timedOut, within, type Session, type TimedOut, type WebResponse,
} from './web-http.js';
import type { Language } from './web-strings.js';
import { getLogger } from './logger.js';
import { suppressSelfForwards } from './services/triage.js';

const log = getLogger('web');

export interface WebBackend {
  read: (account: Account, messageId: string, hint?: LookupHint) => Promise<LiveMessage | undefined>;
  act: (
    account: Account, messageId: string, action: WebMailAction,
    options?: { destination?: string; folderHint?: string; hint?: MessageHint },
  ) => Promise<WebMailActionResult | undefined>;
  send: (account: Account, mail: OutgoingMail) => Promise<SentMail>;
  /** The original's attachments, as a forward offers them. */
  attachments: (account: Account, messageId: string, hint?: LookupHint) => Promise<AttachmentManifestLookup | undefined>;
  /** One of them, read for a forward, held to `limit` bytes. */
  attachment: (
    account: Account, messageId: string, partId: string, hint?: LookupHint, limit?: number,
  ) => Promise<DownloadedAttachment | undefined>;
  appendSent: (account: Account, raw: Buffer) => Promise<string | undefined>;
  savesSentCopy: (account: Account) => boolean;
  sending: (account: Account) => { available: boolean; reason?: string };
  assistant: () => boolean;
  ask: (store: StateStore, question: string, options: { lang: Language }) => Promise<AskAnswer>;
  draft: (input: DraftInput) => Promise<{ draft: string }>;
  testPush: (store: StateStore, endpoint: string) => Promise<PushSendResult>;
  /**
   * A database handle for work that outlives its request. The one a request
   * is given is closed when the answer goes out, and a send or a mailbox
   * action that finishes after that still has to be recorded.
   */
  openStore: () => StateStore;
}

export const defaultBackend: WebBackend = {
  read: fetchReadableByMessageId,
  act: applyWebMailAction,
  send: (account, mail) => sendMail(account, mail),
  attachments: fetchAttachmentManifestByMessageId,
  // Read to be sent on: the file's bytes as the sender attached them.
  attachment: (account, messageId, partId, hint, limit) =>
    fetchAttachmentByMessageId(account, messageId, partId, hint, { ...(limit !== undefined ? { limit } : {}), asStored: true }),
  appendSent: appendToSent,
  savesSentCopy,
  sending: sendingStatus,
  assistant: assistantConfigured,
  ask: (store, question, options) => askMail(store, question, options),
  draft: (input) => draftReply(input),
  // On a handle of its own: a slow push service can outlast the request, and
  // what it finally says (delivered, or gone) still has to be written down.
  testPush: async (_store, endpoint) => {
    const own = new StateStore();
    try {
      return await sendTestPush(own, endpoint);
    } finally {
      own.close();
    }
  },
  openStore: () => new StateStore(),
};

/** Whether this deployment offers notifications to installed copies of the page. */
export function webPushEnabled(): boolean {
  return (process.env.WEB_PUSH_ENABLED ?? 'true').toLowerCase() !== 'false';
}

export function configuredAccounts(): Account[] {
  try {
    return loadConfig().accounts;
  } catch {
    return [];
  }
}

// ---- A message read live, kept for a few minutes ----

/**
 * Opening a message reads it from the mailbox, and answering it, drafting a
 * reply and showing it again in another language would each read it again.
 * A short-lived copy in memory makes those free. Nothing is written to disk,
 * and the copy is dropped the moment the page changes the message.
 */
const LIVE_TTL_MS = 10 * 60_000;
const LIVE_MAX_ENTRIES = 24;
const LIVE_MAX_BYTES = 24 * 1024 * 1024;
const liveCache = new Map<string, { at: number; size: number; value: LiveMessage }>();
const liveInFlight = new Map<string, Promise<LiveMessage | undefined>>();

function liveSize(value: LiveMessage): number {
  const r = value.readable;
  return (r.html?.length ?? 0) + r.text.length + r.quoted.length + 2048;
}

function rememberLive(key: string, value: LiveMessage): void {
  liveCache.delete(key);
  liveCache.set(key, { at: Date.now(), size: liveSize(value), value });
  let total = 0;
  for (const entry of liveCache.values()) total += entry.size;
  // Oldest first: a Map iterates in insertion order.
  for (const [oldest, entry] of liveCache) {
    if (liveCache.size <= LIVE_MAX_ENTRIES && total <= LIVE_MAX_BYTES) break;
    liveCache.delete(oldest);
    total -= entry.size;
  }
}

/**
 * Drop what is remembered of a message, or of all of them.
 *
 * A read still on its way is abandoned too: it may be hung on a connection
 * that will take minutes to give up, and the next request for the message
 * must start a read of its own rather than wait behind it.
 */
export function forgetLive(key?: string): void {
  if (key === undefined) {
    liveCache.clear();
    liveInFlight.clear();
    return;
  }
  liveCache.delete(key);
  liveInFlight.delete(key);
}

/**
 * Where a stored message was last known to be: its folder, and its UID there
 * when that is known. Undefined when nothing is.
 *
 * Read while the request's database handle is open. It only makes a lookup
 * shorter, so a failure to read it is not a failure of the lookup.
 */
export function whereabouts(store: StateStore, row: MailRow): MessageHint | undefined {
  if (!row.folder) return undefined;
  let place: { uid: number; uidValidity: string } | undefined;
  try {
    place = store.placeOf(row.dedupKey);
  } catch (error) {
    log.warn(`A message's place in its mailbox could not be read: ${String(error).slice(0, 120)}`);
  }
  return { folder: row.folder, ...(place ?? {}) };
}

/** What `act` is told about where to find the message. */
type ActHint = { folderHint?: string; hint?: MessageHint };
function actHint(store: StateStore, row: MailRow): ActHint {
  const hint = whereabouts(store, row);
  return hint ? { folderHint: row.folder!, hint } : {};
}

/**
 * Keep where a message was just found, so that opening it again is a fetch.
 * A row that predates stored UIDs learns its own the first time it is read.
 */
export function rememberWhereabouts(store: StateStore, row: MailRow, live: LiveMessage | undefined): void {
  if (!live?.uid || !live.uidValidity || live.folder !== row.folder) return;
  try {
    store.rememberUid(row.dedupKey, live.folder, live.uid, live.uidValidity);
  } catch (error) {
    log.warn(`A message's place in its mailbox could not be noted: ${String(error).slice(0, 120)}`);
  }
}

/** The message as the mailbox has it now, from memory when it was read moments ago. */
export async function liveMessage(
  row: MailRow, account: Account, backend: WebBackend, hint?: MessageHint,
): Promise<LiveMessage | undefined> {
  const cached = liveCache.get(row.dedupKey);
  if (cached && Date.now() - cached.at < LIVE_TTL_MS) return cached.value;
  if (!row.messageId) return undefined;
  const running = liveInFlight.get(row.dedupKey);
  if (running) return running;
  const work: Promise<LiveMessage | undefined> = backend.read(account, row.messageId, hint ?? (row.folder ? { folder: row.folder } : undefined))
    .then((value) => {
      // An abandoned read keeps its result to itself: something newer was asked for since.
      if (value && liveInFlight.get(row.dedupKey) === work) rememberLive(row.dedupKey, value);
      return value;
    })
    .finally(() => {
      if (liveInFlight.get(row.dedupKey) === work) liveInFlight.delete(row.dedupKey);
    });
  liveInFlight.set(row.dedupKey, work);
  return work;
}

// ---- Shared pieces ----

export interface ActionContext {
  session: Session;
  backend: WebBackend;
  lang: Language;
  client: string;
  /** A stored row as the list shows it: with its provider and its link out. */
  decorate: (row: MailRow) => Record<string, unknown>;
  /**
   * Whether this session may mark mail dealt with and manage every device's
   * notifications: a write session, or any session where no write token is
   * configured and the single credential is therefore the owner's.
   */
  mayMark: boolean;
  /** A mark of the token this session holds (see credentialMark); '' when none is required. */
  credential: string;
  /** Set for a caller that is not the page. Its calls are audited under the tool's own name by whoever made them. */
  origin?: 'mcp';
}

const LIVE_TIMEOUT_MS = 25_000;
const ACTION_TIMEOUT_MS = 30_000;
const SEND_TIMEOUT_MS = 60_000;
const AI_TIMEOUT_MS = 50_000;

/** A person asking the model questions, not a loop: twenty a minute is generous. */
const allowAssistantMinute = rateWindow(20);

/**
 * Every model call the page makes in a day, across all sessions.
 *
 * The per-minute window is per client; this is the ceiling on what the page
 * can spend whoever is asking, including a holder of the read token. Counted
 * in memory: a restart forgives the day, which costs less than a table.
 */
const assistantDay = { day: '', used: 0 };

function assistantDailyLimit(): number {
  // An empty line in .env is "not set", not zero.
  const raw = process.env.WEB_ASSISTANT_DAILY_LIMIT?.trim();
  const value = raw ? Number(raw) : 300;
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 300;
}

export function resetAssistantBudget(): void {
  assistantDay.day = '';
  assistantDay.used = 0;
}

/** Take one model call from the budgets, or say which one is spent. */
function assistantBudget(client: string, now = new Date()): WebResponse | undefined {
  const day = now.toISOString().slice(0, 10);
  if (assistantDay.day !== day) {
    assistantDay.day = day;
    assistantDay.used = 0;
  }
  if (assistantDay.used >= assistantDailyLimit()) {
    return json(429, { error: "today's assistant budget is spent", code: 'assistant_daily' });
  }
  if (!allowAssistantMinute(client)) {
    return { ...json(429, { error: 'too many requests; wait a minute', code: 'assistant_rate' }), headers: { 'retry-after': '60' } };
  }
  assistantDay.used += 1;
  return undefined;
}
/** Mail leaves under the owner's name; ten a minute is more than a person types. */
let allowSend = rateWindow(10);

/**
 * Whether the request a piece of work belongs to has been answered.
 *
 * The database handle a request is given is closed when its answer goes out.
 * A mailbox action or a send can finish after that: the page was told it
 * timed out, and then the server took the message after all. What happened
 * still has to be written down, or the audit says "failed" about mail that
 * left and the page offers to send it again.
 */
export interface Life { over: boolean }

/**
 * Run bookkeeping on the request's own handle while the request is alive, and
 * on a handle of its own once the request has been answered.
 */
function record<T>(ctx: ActionContext, store: StateStore, life: Life, work: (db: StateStore) => T): T {
  if (!life.over) return work(store);
  const own = ctx.backend.openStore();
  try {
    return work(own);
  } finally {
    own.close();
  }
}

/** Bookkeeping that must not undo what it is recording: a failure here is logged, never thrown. */
function quietly(what: string, work: () => void): void {
  try {
    work();
  } catch (error) {
    log.warn(`${what} could not be recorded: ${String(error).slice(0, 160)}`);
  }
}

const readOnly = (): WebResponse =>
  json(403, { error: 'this session is read-only; sign in with the write token to act on mail', code: 'readOnly' });

const badRequest = (error: string): WebResponse => json(400, { error, code: 'badRequest' });

/**
 * The answer for a mailbox request that failed.
 *
 * A provider that is not answering is said as that, in words of the page's
 * own: it is nobody's fault here and trying again is the whole remedy. Any
 * other failure keeps its code and its detail.
 */
export function mailboxFailure(error: unknown, code: string, what: string): WebResponse {
  if (error instanceof MailboxUnreachableError) {
    return {
      ...json(503, { error: 'the mail provider is not answering right now', code: 'mailboxUnreachable' }),
      headers: { 'retry-after': '15' },
    };
  }
  const detail = String(error).slice(0, 200);
  return json(502, { error: `${what}: ${detail}`, code, detail });
}

function accountOf(row: MailRow): Account | undefined {
  return configuredAccounts().find((candidate) => candidate.username === row.account);
}

function assistantFailure(error: unknown): WebResponse {
  if (error instanceof AssistantError) {
    const status = { unavailable: 503, refused: 422, timeout: 504, failed: 502 }[error.code];
    return json(status, { error: error.message, code: `assistant_${error.code}` });
  }
  // The model's own words and the mail it was shown stay out of the log.
  log.warn(`Assistant request failed: ${String(error).slice(0, 120)}`);
  return json(502, { error: 'the assistant request failed', code: 'assistant_failed' });
}

// ---- Dealt with ----

/** What may be asked for a message: by the page, and by an MCP caller holding the write credential. */
const PAGE_ACTIONS = new Set<WebMailAction>(MAIL_ACTIONS);

/**
 * The page's actions for a caller that is not a browser.
 *
 * The MCP server gives a caller holding the write credential what a write
 * session of the page has, and it does so by running the page's own code:
 * markHandled, actOnMail, sendMessage, replyDraft, forwardDraft and
 * saveSignature below are what the routes call. There is one implementation
 * of each action and of every check around it, so the two cannot drift
 * apart. Work one of them starts may
 * outlast the call; `life` is ended when the call returns, as it is for a
 * request, so such work finishes on a database handle of its own.
 */
export async function asWriteSession<T>(
  client: string, backend: Partial<WebBackend> | undefined, run: (ctx: ActionContext, life: Life) => Promise<T>,
  lang: Language = 'en',
): Promise<T> {
  const life: Life = { over: false };
  const ctx: ActionContext = {
    session: 'write', backend: { ...defaultBackend, ...(backend ?? {}) }, lang, client,
    decorate: (row) => ({ ...row }), mayMark: true, credential: '', origin: 'mcp',
  };
  try {
    return await run(ctx, life);
  } finally {
    life.over = true;
  }
}

async function handleHandled(req: IncomingMessage, store: StateStore, ctx: ActionContext, life: Life): Promise<WebResponse> {
  if (!ctx.mayMark) return readOnly();
  return markHandled(await readJson(req), store, ctx, life);
}

/** Say a message is dealt with, or put it back. `body`: key, and handled (false to put it back). */
export async function markHandled(
  body: Record<string, unknown> | undefined, store: StateStore, ctx: ActionContext, life: Life,
): Promise<WebResponse> {
  if (!ctx.mayMark) return readOnly();
  const key = text(body?.['key'], 1200);
  if (!key) return badRequest('key is required');
  const handled = body?.['handled'] !== false;
  const row = store.setHandled(key, handled);
  if (!row) return json(404, { error: 'not found', code: 'notFound' });
  if (ctx.origin !== 'mcp') store.recordMcpAudit(handled ? 'web:handled' : 'web:unhandled', ctx.client, true, row.dedupKey);
  // "Done" here should mean done there too: where the session may write, the
  // message is marked read in its mailbox. Not awaited, because the queue has
  // already moved on, and not fatal, because the page's own state is what
  // the reader asked to change. It is a change to a mailbox all the same, so
  // it goes on record like one.
  if (handled && ctx.session === 'write' && row.messageId) {
    const account = accountOf(row);
    if (account) {
      const messageId = row.messageId;
      const audit = {
        account: row.account, messageId, action: 'mark_read', client: ctx.client,
        ...(row.folder ? { sourceFolder: row.folder } : {}),
      };
      void ctx.backend.act(account, messageId, 'mark_read', actHint(store, row)).then(
        (result) => {
          forgetLive(row.dedupKey);
          quietly('Marking a handled message read', () => record(ctx, store, life, (db) => db.recordMailAction(
            result ? { ...audit, success: true, sourceFolder: result.sourceFolder } : { ...audit, success: false, error: 'not found' },
          )));
        },
        (error: unknown) => {
          log.warn(`Marking a handled message read failed: ${String(error).slice(0, 160)}`);
          quietly('Marking a handled message read', () => record(ctx, store, life, (db) => db.recordMailAction(
            { ...audit, success: false, error: String(error).slice(0, 300) },
          )));
        },
      );
    }
  }
  return json(200, { key: row.dedupKey, handled, handledAt: row.handledAt, attention: store.attentionCount() });
}

async function handleAction(req: IncomingMessage, store: StateStore, ctx: ActionContext, life: Life): Promise<WebResponse> {
  if (ctx.session !== 'write') return readOnly();
  return actOnMail(await readJson(req), store, ctx, life);
}

/** Do one thing to a message in its mailbox. `body`: key, action, and for a move its destination folder. */
export async function actOnMail(
  body: Record<string, unknown> | undefined, store: StateStore, ctx: ActionContext, life: Life,
): Promise<WebResponse> {
  if (ctx.session !== 'write') return readOnly();
  const key = text(body?.['key'], 1200);
  const action = text(body?.['action'], 40) as WebMailAction;
  if (!key || !PAGE_ACTIONS.has(action)) return badRequest('key and a supported action are required');
  const destination = action === 'move' ? text(body?.['destination'], 500) : '';
  if (action === 'move' && !destination) return badRequest('a move needs a destination folder');
  const row = store.getMail(key);
  if (!row?.messageId) return json(404, { error: 'not found', code: 'notFound' });
  const account = accountOf(row);
  if (!account) return json(409, { error: 'this mailbox is no longer configured', code: 'unconfigured' });

  const audit = {
    account: row.account, messageId: row.messageId, action, client: ctx.client,
    ...(row.folder ? { sourceFolder: row.folder } : {}),
    // Where a move was aimed, so a refused one can still be traced; a move that goes through records where it landed.
    ...(destination ? { destinationFolder: destination } : {}),
  };
  // What the mailbox said, written down and turned into an answer. This runs
  // when the mailbox answers, which may be after the page stopped waiting:
  // the message has moved either way, and the row has to follow it.
  const settle = (db: StateStore, result: WebMailActionResult | undefined): WebResponse => {
    if (!result) {
      db.recordMailAction({ ...audit, success: false, error: 'not found' });
      return json(404, { error: 'message not found in the mailbox', code: 'actionNotFound' });
    }
    db.recordMailAction({
      ...audit, success: true, sourceFolder: result.sourceFolder,
      ...(result.destinationFolder ? { destinationFolder: result.destinationFolder } : {}),
    });
    forgetLive(row.dedupKey);
    // The row follows the message, so the next read looks where it now is.
    if (result.destinationFolder) {
      db.updateMailLocation(row.dedupKey, result.destinationFolder, Boolean(result.destinationIsSpam), {
        ...(result.destinationUid && result.destinationUidValidity
          ? { uid: result.destinationUid, uidValidity: result.destinationUidValidity } : {}),
      });
    }
    // Filing a message away is dealing with it, and so is putting it in the bin by the bin's name.
    if (action === 'archive' || action === 'trash' || result.destinationIsTrash) db.setHandled(row.dedupKey, true);
    const after = db.getMail(row.dedupKey) ?? row;
    return json(200, { ok: true, action, row: ctx.decorate(after), attention: db.attentionCount() });
  };
  const refused = (error: unknown): WebResponse => {
    if (error instanceof MailActionError) return json(409, { error: error.message, code: `action_${error.code}` });
    return json(502, { error: 'the mailbox action failed', code: 'actionFailed', detail: String(error).slice(0, 200) });
  };
  const work: Promise<WebResponse> = ctx.backend.act(
    account, row.messageId, action, { ...actHint(store, row), ...(destination ? { destination } : {}) },
  ).then(
    (result) => record(ctx, store, life, (db) => settle(db, result)),
    (error: unknown) => {
      quietly('A failed mailbox action', () => record(ctx, store, life, (db) => db.recordMailAction(
        { ...audit, success: false, error: String(error).slice(0, 300) },
      )));
      return refused(error);
    },
  );
  try {
    const answer = await within(work, ACTION_TIMEOUT_MS);
    if (!timedOut(answer)) return answer;
    // Not known to have failed. If the mailbox does it after all, that is recorded then.
    store.recordMailAction({ ...audit, success: false, error: 'timeout' });
    return json(504, { error: 'the mailbox did not answer in time', code: 'actionTimeout' });
  } catch (error) {
    // The mailbox did it and the bookkeeping failed: say so rather than report a failed action.
    log.warn(`A mailbox action could not be recorded: ${String(error).slice(0, 160)}`);
    return json(500, { error: 'the action was applied but could not be recorded', code: 'actionFailed', detail: 'bookkeeping' });
  }
}

const FEEDBACK_LABELS = new Set(['false_positive', 'missed', 'correct']);

async function handleFeedback(req: IncomingMessage, store: StateStore, ctx: ActionContext): Promise<WebResponse> {
  if (ctx.session !== 'write') return readOnly();
  const body = await readJson(req);
  const key = text(body?.['key'], 1200);
  const label = text(body?.['label'], 40);
  if (!key || !FEEDBACK_LABELS.has(label)) return badRequest('key and a known label are required');
  const row = store.getMail(key);
  if (!row) return json(404, { error: 'not found', code: 'notFound' });
  // Against this record, by its key: its Message-ID alone could name another one.
  store.recordFeedback(row.messageId ?? row.dedupKey, label as 'false_positive' | 'missed' | 'correct', '', row.dedupKey);
  store.recordMcpAudit('web:feedback', ctx.client, true, row.dedupKey);
  // Two messages from one sender marked the same way become a rule. Say so
  // when this vote was the one that made it, since that changes future mail.
  const hints = store.feedbackRuleHints(2);
  const sender = (row.sender ?? '').toLowerCase();
  const rule = !sender ? null
    : hints.neverImportant.includes(sender) ? 'never'
      : hints.alwaysImportant.includes(sender) ? 'always' : null;
  return json(200, { recorded: true, label, rule, sender: row.sender });
}

// ---- Signatures ----

/** A signature is a few lines under a letter, not a second letter. */
export const SIGNATURE_MAX_CHARS = 2000;

/** Each mailbox's own, since each signs as someone slightly different. */
const signatureKey = (address: string): string => `signature:${address}`;

/** The signature of a mailbox, '' when it has none. */
export function signatureOf(store: StateStore, address: string): string {
  return store.getMeta(signatureKey(address)) ?? '';
}

/**
 * The text of a letter as it leaves: what was written, then the signature
 * under the standard delimiter (two dashes and a space on a line of their
 * own, which mail clients know to set apart), then what the letter carries
 * along: the original quoted, for an answer, or the forwarded message. The
 * page puts its letters together the same way in the browser, to the
 * character. A forward may say nothing of its own, and then starts with the
 * signature, or with the forwarded message, rather than with blank lines.
 */
export function letterText(body: string, signature: string, carried = ''): string {
  let out = body.replace(/\s+$/, '');
  if (signature.trim()) out += `${out ? '\n\n' : ''}-- \n${signature}`;
  if (carried) out += `${out ? '\n\n' : ''}${carried}`;
  return out;
}

/**
 * A signature as it is kept: plain lines, nothing invisible, no blank lines
 * around it, and without a delimiter of its own, which is added when the
 * letter is put together and would otherwise be there twice.
 */
function cleanSignature(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/^--[ \t]*(?:\n|$)/, '')
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/\s+$/, '');
}

async function handleSignature(req: IncomingMessage, store: StateStore, ctx: ActionContext): Promise<WebResponse> {
  if (ctx.session !== 'write') return readOnly();
  // Two thousand characters, each of which JSON may spell in twelve bytes.
  return saveSignature(await readJson(req, 32 * 1024), store, ctx);
}

/**
 * Set the signature of one mailbox, or with empty text remove it. `body`:
 * account (the mailbox's address) and text. Only a session that may send
 * may change what is sent under the owner's name.
 */
export function saveSignature(
  body: Record<string, unknown> | undefined, store: StateStore, ctx: ActionContext,
): WebResponse {
  if (ctx.session !== 'write') return readOnly();
  const address = text(body?.['account'], 320).trim();
  if (!address) return badRequest('account is required');
  const given = body?.['text'];
  if (given !== undefined && given !== null && typeof given !== 'string') return badRequest('text must be text');
  const account = configuredAccounts().find((candidate) => candidate.username === address);
  if (!account) return json(409, { error: 'this mailbox is not configured', code: 'unconfigured' });
  const signature = cleanSignature(typeof given === 'string' ? given : '');
  // Characters as a person counts them, so a signature with an emoji is not short-changed.
  if (Array.from(signature).length > SIGNATURE_MAX_CHARS) {
    return json(400, {
      error: `a signature may be at most ${SIGNATURE_MAX_CHARS} characters`, code: 'signature_too_long', maxChars: SIGNATURE_MAX_CHARS,
    });
  }
  if (signature) store.setMeta(signatureKey(account.username), signature);
  else store.deleteMeta(signatureKey(account.username));
  // That it changed, and for which mailbox; never what it says.
  if (ctx.origin !== 'mcp') store.recordMcpAudit('web:signature', ctx.client, true, account.username);
  return json(200, { account: account.username, signature });
}

// ---- Writing ----

async function handleReply(params: URLSearchParams, store: StateStore, ctx: ActionContext): Promise<WebResponse> {
  return replyDraft({ key: params.get('key')?.trim() ?? '', mode: params.get('mode') ?? '' }, store, ctx);
}

/** What an answer to a message starts from: who it goes to, its subject, the thread it continues, the original quoted. */
export async function replyDraft(
  asked: { key: string; mode?: string }, store: StateStore, ctx: ActionContext,
): Promise<WebResponse> {
  const key = asked.key;
  const row = key ? store.getMail(key) : undefined;
  if (!row) return json(404, { error: 'not found', code: 'notFound' });
  const account = accountOf(row);
  if (!account) return json(409, { error: 'this mailbox is no longer configured', code: 'unconfigured' });
  let live: LiveMessage | undefined;
  try {
    const found = await within(liveMessage(row, account, ctx.backend, whereabouts(store, row)), LIVE_TIMEOUT_MS);
    if (timedOut(found)) return json(504, { error: 'the mailbox did not return this message in time', code: 'timeout' });
    live = found;
    rememberWhereabouts(store, row, live);
  } catch (error) {
    return mailboxFailure(error, 'readFailed', 'mailbox read failed');
  }
  if (!live) return json(404, { error: 'message not found in the mailbox', code: 'actionNotFound' });
  const r = live.readable;
  const self = configuredAccounts().map((candidate) => candidate.username);
  const envelope = replyEnvelope(
    {
      from: r.from, to: r.to, cc: r.cc, replyTo: r.replyTo, subject: r.subject || row.subject || '',
      date: r.date ?? row.mailDate, messageId: r.messageId ?? row.messageId, references: r.references, text: r.text,
    },
    self,
    asked.mode === 'replyAll' ? 'replyAll' : 'reply',
    ctx.lang,
  );
  const sending = ctx.backend.sending(account);
  // An answer that would go to another domain than the message came from: what
  // the reader's safety clues warn about, said here where the answer is addressed.
  const domain = (address: string): string => address.slice(address.lastIndexOf('@') + 1).trim().toLowerCase();
  const sender = r.from?.address ?? '';
  // A sender with no address to compare is no reassurance: answers are still asked for somewhere of the message's choosing.
  const replyToElsewhere = envelope.addressedTo === 'replyTo'
    && envelope.to.some((address) => !sender || domain(address) !== domain(sender));
  return json(200, {
    key: row.dedupKey, account: account.username, accountName: account.name,
    ...envelope,
    sender, replyToElsewhere,
    canSend: sending.available, ...(sending.reason ? { reason: sending.reason } : {}),
    // What goes under the answer, from the mailbox it leaves from, for the session that may send it.
    ...(ctx.session === 'write' ? { signature: signatureOf(store, account.username) } : {}),
  });
}

async function handleForward(params: URLSearchParams, store: StateStore, ctx: ActionContext): Promise<WebResponse> {
  if (ctx.session !== 'write') return readOnly();
  return forwardDraft({ key: params.get('key')?.trim() ?? '', language: params.get('language') ?? '' }, store, ctx);
}

/**
 * The size a mailbox gives for a part is its encoded size; what it decodes
 * to is about three quarters of that in base64. Said a little over rather
 * than under, so a limit checked against it is not passed by surprise.
 */
function decodedSize(item: { sizeBytes?: number; transferEncoding?: string }): number | null {
  if (item.sizeBytes === undefined) return null;
  return item.transferEncoding === 'base64' ? Math.ceil(item.sizeBytes * 3 / 4) : item.sizeBytes;
}

/**
 * A part that is itself a container of parts: a Mac file sent as
 * multipart/appledouble, or any multipart named as if it were a file. It has
 * no bytes of its own to send on. Asked for it, the mailbox gives its
 * children run together between boundary lines whose header is not part of
 * what it gives, and that would arrive under the file's name as something
 * that is not the file. A forward does not offer it, and refuses it if asked.
 */
const isContainer = (contentType: string): boolean => contentType.trim().toLowerCase().startsWith('multipart/');

/**
 * Whether a part is a picture of the original's own body: an image, sent
 * inline, whose Content-ID the markup shows (logos, icons, a portrait in a
 * signature). A plain-text forward would carry each of those as a file
 * nobody attached, so they go only when asked for. Anything else sent inline
 * is a file like the rest: Apple Mail sends a PDF or a photo that way, with
 * no Content-ID and no markup that shows it.
 */
function bodyPicture(
  item: { contentType: string; inline: boolean; contentId?: string }, shown: Set<string> | undefined,
): boolean {
  const id = item.contentId?.trim().toLowerCase();
  if (!item.inline || !item.contentType.trim().toLowerCase().startsWith('image/') || !id) return false;
  // Unknown only for a message too large to have its markup read for the
  // pictures it shows: an inline image with a Content-ID is then taken to be one.
  return shown ? shown.has(id) : true;
}

/**
 * What a forward of a message starts from: its subject, the forwarded block
 * (who it was from, when, to whom, then its text), and the original's
 * attachments, which a forward sends on by reference without the browser
 * ever holding them. `language` words the block; the page's own by default.
 */
export async function forwardDraft(
  asked: { key: string; language?: string }, store: StateStore, ctx: ActionContext,
): Promise<WebResponse> {
  const key = asked.key;
  const row = key ? store.getMail(key) : undefined;
  if (!row) return json(404, { error: 'not found', code: 'notFound' });
  const account = accountOf(row);
  if (!account) return json(409, { error: 'this mailbox is no longer configured', code: 'unconfigured' });
  let live: LiveMessage | undefined;
  try {
    const found = await within(liveMessage(row, account, ctx.backend, whereabouts(store, row)), LIVE_TIMEOUT_MS);
    if (timedOut(found)) return json(504, { error: 'the mailbox did not return this message in time', code: 'timeout' });
    live = found;
    rememberWhereabouts(store, row, live);
  } catch (error) {
    return mailboxFailure(error, 'readFailed', 'mailbox read failed');
  }
  if (!live) return json(404, { error: 'message not found in the mailbox', code: 'actionNotFound' });
  const r = live.readable;
  const lang: Language = asked.language === 'en' || asked.language === 'zh-CN' ? asked.language : ctx.lang;
  const envelope = forwardEnvelope({
    from: r.from, to: r.to, cc: r.cc, subject: r.subject || row.subject || '', date: r.date ?? row.mailDate,
    text: r.text, quoted: r.quoted,
    ...(r.toTruncated ? { toCut: true } : {}), ...(r.ccTruncated ? { ccCut: true } : {}),
  }, lang);

  // The files go with the forward unless they are taken off. A list that
  // cannot be read now does not stop the forward from being written: the
  // page says so, and asks before the letter goes without them.
  let attachments: Array<{ partId: string; filename: string; contentType: string; size: number | null; inline: boolean }> = [];
  const notForwardable: Array<{ partId: string; filename: string; contentType: string }> = [];
  let unavailable = false;
  try {
    // Asked where the read just found it, which is now on record.
    const found = row.messageId
      ? await within(ctx.backend.attachments(account, row.messageId, whereabouts(store, row)), LIVE_TIMEOUT_MS)
      : undefined;
    if (timedOut(found) || !found) unavailable = true;
    else {
      const shown = r.bodyCids ? new Set(r.bodyCids) : r.html === null && r.htmlOmitted ? undefined : new Set<string>();
      for (const item of found.manifest.items) {
        const filename = attachmentFilename(item.filename);
        if (isContainer(item.contentType)) {
          notForwardable.push({ partId: item.partId, filename, contentType: item.contentType });
          continue;
        }
        attachments.push({
          partId: item.partId, filename, contentType: attachmentContentType(item.contentType), size: decodedSize(item),
          inline: bodyPicture(item, shown),
        });
      }
    }
  } catch (error) {
    log.warn(`The attachments of a message being forwarded could not be listed: ${String(error).slice(0, 160)}`);
    unavailable = true;
  }
  const sending = ctx.backend.sending(account);
  return json(200, {
    key: row.dedupKey, account: account.username, accountName: account.name,
    subject: envelope.subject, forwarded: envelope.forwarded,
    attachments, ...(notForwardable.length ? { notForwardable } : {}), ...(unavailable ? { attachmentsUnavailable: true } : {}),
    canSend: sending.available, ...(sending.reason ? { reason: sending.reason } : {}),
    ...(ctx.session === 'write' ? { signature: signatureOf(store, account.username) } : {}),
  });
}

function sendFailure(error: unknown): WebResponse {
  if (error instanceof SendError) {
    // The connection ended after the message was handed over: it may have left.
    if (error.code === 'unknown') return SEND_UNCERTAIN();
    const status = { invalid: 400, not_configured: 409, rejected: 422, auth: 502, connection: 502 }[error.code];
    return json(status, { error: error.message, code: `send_${error.code}`, ...(error.detail ? { detail: error.detail } : {}) });
  }
  log.warn(`Sending failed: ${String(error).slice(0, 160)}`);
  return json(502, { error: 'sending failed', code: 'send_connection' });
}

/**
 * Sends in progress or done, by the id the page gave them.
 *
 * A send that outlasts its request leaves the page not knowing whether the
 * mail left. Trying again must not send it twice, so the page names each
 * letter, and a second request with the same name is given the first one's
 * outcome instead of a second send. Kept in memory for a while, for a send
 * that is still running or that went through. One that ended in an error is
 * forgotten at once, so that it can be tried again.
 */
const SEND_MEMORY_MS = 15 * 60_000;
const SEND_MEMORY_MAX = 200;
/**
 * When whoever is waiting for a letter stops, which a forward moves once it
 * knows the size of its files. Kept as a number the send updates, never as a
 * function made by the send: such a function would keep everything the send
 * holds (every file it carries, a forward's read from the mailbox included)
 * in memory for as long as the letter is remembered.
 */
interface SendPace { until: number }
const sendJobs = new Map<string, { at: number; outcome: Promise<WebResponse>; pace: SendPace }>();

/** For tests: no memory of letters sent, and nobody's count of them. */
export function forgetSends(): void {
  sendJobs.clear();
  allowSend = rateWindow(10);
}

/** What became, or is becoming, of a letter already asked for under this name; undefined when there was none. */
export function earlierSend(id: string, now = Date.now()): Promise<WebResponse> | undefined {
  const job = sendJobs.get(id);
  return job && now - job.at <= SEND_MEMORY_MS ? job.outcome : undefined;
}

/**
 * What became of a letter already asked for under this name, waited for as
 * long as the first request waits for it, and never less than any send is
 * given; undefined when there was none. A repeat from the page and one from
 * MCP both wait here, so that neither calls a letter unconfirmed while it is
 * still being put together or handed over.
 */
export function awaitEarlierSend(id: string): Promise<WebResponse | TimedOut> | undefined {
  const job = sendJobs.get(id);
  if (!job || Date.now() - job.at > SEND_MEMORY_MS) return undefined;
  const asked = Date.now() + SEND_TIMEOUT_MS;
  return withinUntil(job.outcome, () => Math.max(asked, job.pace.until));
}

function rememberSend(id: string, outcome: Promise<WebResponse>, pace: SendPace, now = Date.now()): void {
  for (const [known, job] of sendJobs) {
    if (now - job.at > SEND_MEMORY_MS || sendJobs.size >= SEND_MEMORY_MAX) sendJobs.delete(known);
    else break;
  }
  sendJobs.set(id, { at: now, outcome, pace });
}

const SEND_UNCERTAIN = (): WebResponse =>
  json(504, { error: 'the mail server did not confirm the message; check Sent before trying again', code: 'send_timeout' });

/**
 * Wait for work until a time that may move while it runs: a send knows how
 * long it may fairly take only once it has every file in hand.
 */
async function withinUntil<T>(work: Promise<T>, until: () => number): Promise<T | TimedOut> {
  for (;;) {
    const answer = await within(work, Math.max(0, until() - Date.now()));
    if (!timedOut(answer) || until() <= Date.now()) return answer;
  }
}

/**
 * The most a letter's request may be: its files in base64, which is a third
 * larger than they are, and the letter itself, which was allowed 700 KiB
 * before it could carry anything. 28 MiB with the default limit on files.
 */
export function sendBodyLimit(): number {
  return Math.max(28 * 1024 * 1024, Math.ceil(attachmentLimitBytes() / 3) * 4 + 700 * 1024 + MAX_ATTACHMENTS * 1024);
}

/** A modest uplink: about half a megabit a second, what a weak mobile connection still manages. */
const MODEST_UPLOAD_BYTES_PER_SECOND = 64 * 1024;

/**
 * How long one request may take to arrive whole. Node gives every request
 * five minutes, in which the largest letter arrives only over a link faster
 * than about three quarters of a megabit; past that it would be cut off with
 * a 408 before mailsift saw it. This is the time the largest letter takes at
 * a modest rate, and never less than Node's own. Headers still have to
 * arrive within Node's minute, however long the body may take.
 */
export function requestTimeoutMs(): number {
  return Math.max(300_000, Math.ceil(sendBodyLimit() / MODEST_UPLOAD_BYTES_PER_SECOND) * 1000);
}

async function handleSend(req: IncomingMessage, store: StateStore, ctx: ActionContext, life: Life): Promise<WebResponse> {
  if (ctx.session !== 'write') return readOnly();
  const read = await readJsonOrSize(req, sendBodyLimit());
  if (read.tooLarge) return sendTooLarge('bytes');
  return sendMessage(read.body, store, ctx, life);
}

/**
 * A letter with more attached than one message may carry. The limit is said
 * in words, and in numbers for the page to say in its own.
 */
function sendTooLarge(why: 'files' | 'bytes', file?: string): WebResponse {
  const limit = attachmentLimitBytes();
  const most = `${describeBytes(limit)}, the most one message may carry`;
  const error = why === 'files'
    ? `a message may carry at most ${MAX_ATTACHMENTS} files`
    : file ? `with ${file} the attachments come to more than ${most}` : `the attachments come to more than ${most}`;
  return json(413, { error, code: 'send_too_large', maxBytes: limit, maxFiles: MAX_ATTACHMENTS, ...(file ? { file } : {}) });
}

/** A file a forward was to carry, named, could not be had, so nothing was sent. */
function forwardUnavailable(status: number, error: string, file: string): WebResponse {
  return json(status, { error: `${error}; nothing was sent`, code: 'forward_attachment_unavailable', file });
}

/**
 * The message a forward carries files from could not be read for them, so
 * nothing was sent. There is no one file to name, and what to do next differs:
 * a message moved or deleted in its mailbox, or that no longer has a file it
 * had (404), is found again and forwarded from there, where trying again
 * would only fail again; a mailbox that did not answer is tried again.
 */
function forwardOriginalFailed(status: 404 | 502 | 504, error: string): WebResponse {
  return json(status, {
    error: `${error}; nothing was sent`, code: status === 404 ? 'forward_original_gone' : 'forward_original_unavailable',
  });
}

/** Bytes from base64 that decodes cleanly, or nothing. */
function strictBase64(value: string): Buffer | undefined {
  if (value.length % 4 !== 0) return undefined;
  const bytes = Buffer.from(value, 'base64');
  // Node passes over what is not base64 instead of refusing it. Encoding the
  // bytes again gives back exactly what was sent only when nothing was skipped.
  return bytes.toString('base64') === value ? bytes : undefined;
}

/** How many bytes base64 of this length decodes to, worked out without decoding it. */
const base64Bytes = (value: string): number =>
  Math.floor(value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);

/**
 * The files a letter brings with it, or the answer that refuses them.
 * `value` is [{ name, type, data }], data in base64. What can be checked
 * without decoding is checked first: how many, then how large from the
 * length of the encoding. Then each file's encoding, strictly: a file that
 * would arrive with bytes missing is not sent at all.
 */
function uploadedFiles(value: unknown, forwarding: number): { files: OutgoingAttachment[] } | { refused: WebResponse } {
  const given = value ?? [];
  if (!Array.isArray(given)) return { refused: badRequest('attachments must be a list') };
  if (given.length + forwarding > MAX_ATTACHMENTS) return { refused: sendTooLarge('files') };
  const entries: Array<{ name: unknown; type: unknown; data: string }> = [];
  let total = 0;
  for (const entry of given) {
    const file = typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
    const data = file['data'];
    if (typeof data !== 'string') return { refused: badRequest('each attachment needs its data, in base64') };
    total += base64Bytes(data);
    entries.push({ name: file['name'], type: file['type'], data });
  }
  if (total > attachmentLimitBytes()) return { refused: sendTooLarge('bytes') };
  const files: OutgoingAttachment[] = [];
  for (const entry of entries) {
    const filename = attachmentFilename(entry.name);
    const content = strictBase64(entry.data);
    if (!content) {
      return { refused: json(400, { error: `${filename} is not cleanly encoded in base64`, code: 'send_attachment_invalid', file: filename }) };
    }
    files.push({ filename, content, contentType: attachmentContentType(entry.type) });
  }
  return { files };
}

const PART_ID = /^\d+(?:\.\d+)*$/;

/** The parts of the original a forward sends on, each named once; undefined when the list is not one. */
function forwardedParts(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return undefined;
  if (value.some((part) => typeof part !== 'string' || part.length > 40 || !PART_ID.test(part))) return undefined;
  return [...new Set(value as string[])];
}

/** All the reading a forward's files may take before the letter itself is handed over. */
const FORWARD_FETCH_MS = 90_000;

/**
 * Read the files a forward sends on from the original's own mailbox, within
 * what the message may still carry. All of them or none: a forward that
 * arrived without a file its writer saw in it would say something they did
 * not mean. The list is read first, so that each part asked for is known to
 * be one of the original's attachments and a file that cannot be had is
 * named. Never throws.
 */
async function forwardedFiles(
  backend: WebBackend, source: Account, messageId: string, hint: MessageHint | undefined, parts: string[], room: number,
): Promise<{ files: OutgoingAttachment[] } | { refused: WebResponse }> {
  const deadline = Date.now() + FORWARD_FETCH_MS;
  const left = (): number => Math.max(0, deadline - Date.now());
  let listed: AttachmentManifestLookup | undefined;
  try {
    const found = await within(backend.attachments(source, messageId, hint), Math.min(LIVE_TIMEOUT_MS, left()));
    if (timedOut(found)) {
      return { refused: forwardOriginalFailed(504, 'the mailbox did not list the attachments of the message being forwarded in time') };
    }
    listed = found;
  } catch (error) {
    log.warn(`The attachments of a message being forwarded could not be listed: ${String(error).slice(0, 160)}`);
    return { refused: forwardOriginalFailed(502, 'the attachments of the message being forwarded could not be read from its mailbox') };
  }
  if (!listed) return { refused: forwardOriginalFailed(404, 'the message being forwarded is no longer in its mailbox') };

  const files: OutgoingAttachment[] = [];
  let free = room;
  for (const part of parts) {
    const item = listed.manifest.items.find((candidate) => candidate.partId === part);
    if (!item) return { refused: forwardOriginalFailed(404, `the message being forwarded no longer has attachment ${part}`) };
    const filename = attachmentFilename(item.filename);
    if (isContainer(item.contentType)) {
      return {
        refused: json(422, {
          error: `${filename} holds other parts rather than being one file, and cannot be forwarded; nothing was sent`,
          code: 'forward_attachment_container', file: filename,
        }),
      };
    }
    let got: DownloadedAttachment | undefined;
    try {
      const fetched = await within(backend.attachment(source, messageId, part, hint, free), left());
      if (timedOut(fetched)) return { refused: forwardUnavailable(504, `${filename} did not arrive from the mailbox in time`, filename) };
      got = fetched;
    } catch (error) {
      if (error instanceof AttachmentTooLargeError) return { refused: sendTooLarge('bytes', filename) };
      if (error instanceof AttachmentNotFoundError) {
        return { refused: forwardUnavailable(404, `${filename} is no longer in the message being forwarded`, filename) };
      }
      log.warn(`An attachment of a message being forwarded could not be read: ${String(error).slice(0, 160)}`);
      return { refused: forwardUnavailable(502, `${filename} could not be read from the mailbox`, filename) };
    }
    if (!got) return { refused: forwardUnavailable(404, `${filename} is no longer in the message being forwarded`, filename) };
    if (got.content.length > free) return { refused: sendTooLarge('bytes', filename) };
    free -= got.content.length;
    // The bytes as the sender attached them; a text file keeps the character set they are in.
    const contentType = attachmentContentType(item.contentType);
    const charset = contentType.startsWith('text/') ? attachmentCharset(got.charset) : undefined;
    files.push({ filename, content: got.content, contentType, ...(charset ? { charset } : {}) });
  }
  return { files };
}

/**
 * Send one message from a mailbox. `body`: to, cc, bcc, subject, text, and
 * attachments ([{ name, type, data }], data in base64); for an answer replyTo
 * (the stored message's key or Message-ID) and references; for a forward
 * forwardOf (the same) and forwardAttachments (part ids of the original's
 * attachments, which are read from its mailbox here and never pass through
 * the browser); for a new message, or a forward from another mailbox than
 * the one it arrived in, account; and id, a name for this letter, under
 * which asking again does not send it twice.
 */
export async function sendMessage(
  body: Record<string, unknown> | undefined, store: StateStore, ctx: ActionContext, life: Life,
): Promise<WebResponse> {
  if (ctx.session !== 'write') return readOnly();
  if (!body) return badRequest('a JSON body is required');

  // The same letter again: answer with what became of it the first time.
  const named = text(body['id'], 80);
  const sendId = /^[A-Za-z0-9_-]{8,64}$/.test(named) ? named : '';
  const earlier = sendId ? awaitEarlierSend(sendId) : undefined;
  if (earlier) {
    const answer = await earlier;
    return timedOut(answer) ? SEND_UNCERTAIN() : { ...answer };
  }

  // Whom it is for is checked before anything else is done for the letter: a
  // forward would otherwise read every file it carries from the mailbox, and
  // spend a send, only to be refused for an address with no dot in it.
  const recipients = { to: textList(body['to']), cc: textList(body['cc']), bcc: textList(body['bcc']) };
  try {
    addressed(recipients);
  } catch (error) {
    return sendFailure(error);
  }

  if (!allowSend(ctx.client)) {
    return { ...json(429, { error: 'too many messages; wait a minute', code: 'send_rate' }), headers: { 'retry-after': '60' } };
  }

  // A reply leaves from the mailbox that received the original: answering
  // from another address is how a thread loses its other half.
  const replyKey = text(body['replyTo'], 1200);
  const forwardKey = text(body['forwardOf'], 1200);
  if (replyKey && forwardKey) return badRequest('a letter answers a message or forwards one, not both');
  const original = replyKey ? store.getMail(replyKey) : undefined;
  // Read now: by the time the message has left, this handle may be closed.
  const originalPlace: ActHint = original ? actHint(store, original) : {};
  if (replyKey && !original) return json(404, { error: 'the message being answered was not found', code: 'notFound' });
  const forwarded = forwardKey ? store.getMail(forwardKey) : undefined;
  if (forwardKey && !forwarded) return json(404, { error: 'the message being forwarded was not found', code: 'notFound' });
  const parts = forwardedParts(body['forwardAttachments']);
  if (!parts) return badRequest('forwardAttachments must be a list of attachment part ids');
  if (parts.length && !forwarded) return badRequest('forwardAttachments needs forwardOf, the message they belong to');
  // A forward is a new letter about an old one, so it may leave from any of
  // the owner's mailboxes; by default, the one the original arrived in.
  const address = original ? original.account : text(body['account'], 320) || (forwarded?.account ?? '');
  const account = configuredAccounts().find((candidate) => candidate.username === address);
  if (!account) return json(409, { error: 'this mailbox is not configured', code: 'unconfigured' });
  const sending = ctx.backend.sending(account);
  if (!sending.available) {
    return json(409, { error: 'this mailbox cannot send', code: 'send_not_configured', reason: sending.reason ?? 'no_smtp' });
  }

  const uploads = uploadedFiles(body['attachments'], parts.length);
  if ('refused' in uploads) return uploads.refused;
  // The forwarded files are read from the mailbox the original is in, which
  // need not be the one the forward leaves from.
  const source = forwarded && parts.length ? accountOf(forwarded) : undefined;
  if (forwarded && parts.length) {
    if (!source) return json(409, { error: 'the mailbox the forwarded message is in is no longer configured', code: 'unconfigured' });
    if (!forwarded.messageId) return forwardOriginalFailed(404, 'the message being forwarded cannot be found in its mailbox');
  }
  const forwardPlace = forwarded ? whereabouts(store, forwarded) : undefined;
  const forwardMessageId = forwarded?.messageId ?? '';

  const mail: OutgoingMail = {
    ...recipients,
    subject: text(body['subject'], 2000),
    text: text(body['text'], 500_000),
    ...(uploads.files.length ? { attachments: uploads.files } : {}),
  };
  // Only an answer continues a thread. A forward starts a conversation of its own.
  if (original?.messageId && !original.messageId.startsWith('<generated-')) {
    mail.inReplyTo = original.messageId;
    mail.references = [...textList(body['references'], 30, 998), original.messageId];
  }

  const audit = { account: account.username, action: 'send', client: ctx.client };
  const about = replyKey || forwardKey || '(new message)';
  // Answering a message deals with it, and so does passing it on to whoever
  // it is for. A forward to nobody but the owner's own mailboxes (to deal with
  // it at work rather than at home) has dealt with nothing: the copy that
  // arrives there is ruled a forwarded copy of a message already judged and
  // is not put before the owner again, so the original has to stay where it is.
  // That holds only where the copy is in fact ruled one: with SUPPRESS_SELF_FORWARDS
  // on, and when it arrives in another of the owner's mailboxes than the one it left.
  const own = new Set(configuredAccounts().map((candidate) => candidate.username.toLowerCase()));
  const leftFrom = account.username.toLowerCase();
  const toSelfOnly = suppressSelfForwards() && [...recipients.to, ...recipients.cc, ...recipients.bcc]
    .every((address) => { const a = address.trim().toLowerCase(); return own.has(a) && a !== leftFrom; });
  const dealtWith = Boolean(original) || (Boolean(forwarded) && !toSelfOnly);
  // How long the request waits for the letter: the time any letter is given,
  // and on top of it the time its files take to travel, base64 and all: to
  // the mail server, as long again for the server to answer once it has them
  // (see smtpTransportOptions), and once more to Sent for a provider whose
  // copy is filed from here (allowed for every letter: waiting longer than
  // needed costs nothing when the answer comes sooner). A forward's files are
  // known only once they are read, so it is first given the time reading them
  // may take, and then the time for what was read.
  const travel = (files: OutgoingAttachment[]): number =>
    3 * transferAllowanceMs(Math.ceil(files.reduce((sum, file) => sum + file.content.length, 0) / 3) * 4);
  const pace: SendPace = { until: Date.now() + SEND_TIMEOUT_MS + travel(uploads.files) + (parts.length ? FORWARD_FETCH_MS : 0) };
  // The whole of a send, from reading what a forward carries to the server
  // taking the message to the last note about it. It never rejects, and it
  // runs to its end whether or not the request that started it is still waiting.
  const outcome = (async (): Promise<WebResponse> => {
    // Every file a forward carries is in hand before anything is handed over.
    if (source && parts.length) {
      const room = attachmentLimitBytes() - uploads.files.reduce((sum, file) => sum + file.content.length, 0);
      const gathered = await forwardedFiles(ctx.backend, source, forwardMessageId, forwardPlace, parts, room);
      if ('refused' in gathered) {
        quietly('A forward that could not carry its files', () => record(ctx, store, life, (db) => db.recordMailAction({
          ...audit, messageId: about, success: false, error: 'forward_attachment',
        })));
        // Nothing was sent: asking again is a new attempt.
        if (sendId) sendJobs.delete(sendId);
        return gathered.refused;
      }
      mail.attachments = [...(mail.attachments ?? []), ...gathered.files];
      pace.until = Date.now() + SEND_TIMEOUT_MS + travel(mail.attachments);
    }

    let sent: SentMail;
    try {
      sent = await ctx.backend.send(account, mail);
    } catch (error) {
      quietly('A failed send', () => record(ctx, store, life, (db) => db.recordMailAction({
        ...audit, messageId: about, success: false,
        error: error instanceof SendError ? error.code : 'failed',
      })));
      // Nothing more will be learned about this attempt, so the name is
      // released: pressing send again is a new send. Where the line dropped
      // after the message was handed over, the page has told the reader to
      // look in Sent first, and whether to send again is theirs to decide.
      if (sendId) sendJobs.delete(sendId);
      return sendFailure(error);
    }

    // From here the message has left. Nothing below can turn that into a failure.
    // Recorded without recipients, text or file names: that a message left, from where, and when.
    quietly('A sent message', () => record(ctx, store, life, (db) => db.recordMailAction(
      { ...audit, messageId: sent.messageId, success: true },
    )));

    // Where the provider does not file its own copy, put one in Sent, or the
    // reply exists only in the other person's mailbox.
    let savedCopy = true;
    if (!ctx.backend.savesSentCopy(account)) {
      try {
        const folder = await within(ctx.backend.appendSent(account, sent.copy), ACTION_TIMEOUT_MS + transferAllowanceMs(sent.copy.length));
        savedCopy = !timedOut(folder) && Boolean(folder);
      } catch (error) {
        savedCopy = false;
        log.warn(`Filing the sent copy failed: ${String(error).slice(0, 160)}`);
      }
    }

    // The message answered, or passed on to someone else, is dealt with (see
    // dealtWith). Only an answer is flagged answered in the mailbox: a forward is not one.
    let attention: number | undefined;
    quietly('An answered or forwarded message', () => record(ctx, store, life, (db) => {
      if (original) db.setHandled(original.dedupKey, true);
      if (forwarded && dealtWith) db.setHandled(forwarded.dedupKey, true);
      attention = db.attentionCount();
    }));
    if (original) {
      forgetLive(original.dedupKey);
      if (original.messageId) {
        const messageId = original.messageId;
        const flagged = {
          account: account.username, messageId, action: 'answered', client: ctx.client,
          ...(original.folder ? { sourceFolder: original.folder } : {}),
        };
        void ctx.backend.act(account, messageId, 'answered', originalPlace).then(
          (result) => quietly('Marking a message answered', () => record(ctx, store, life, (db) => db.recordMailAction(
            result ? { ...flagged, success: true, sourceFolder: result.sourceFolder } : { ...flagged, success: false, error: 'not found' },
          ))),
          (error: unknown) => {
            log.warn(`Marking a message answered failed: ${String(error).slice(0, 160)}`);
            quietly('Marking a message answered', () => record(ctx, store, life, (db) => db.recordMailAction(
              { ...flagged, success: false, error: String(error).slice(0, 300) },
            )));
          },
        );
      }
    }
    return json(200, {
      sent: true, messageId: sent.messageId, accepted: sent.accepted.length, rejected: sent.rejected,
      savedCopy, ...(attention !== undefined ? { attention } : {}),
      // Whether the message answered or forwarded now counts as dealt with,
      // for the page to follow rather than decide for itself.
      ...(original || forwarded ? { handled: dealtWith } : {}),
    });
  })();
  if (sendId) rememberSend(sendId, outcome, pace);

  const answer = await withinUntil(outcome, () => pace.until);
  if (!timedOut(answer)) return answer;
  // Not known to have failed: the server may still take it, and that is recorded when it does.
  store.recordMailAction({ ...audit, messageId: about, success: false, error: 'timeout' });
  return SEND_UNCERTAIN();
}

async function handleDraft(req: IncomingMessage, store: StateStore, ctx: ActionContext): Promise<WebResponse> {
  if (ctx.session !== 'write') return readOnly();
  const body = await readJson(req, 32 * 1024);
  if (!body) return badRequest('a JSON body is required');
  if (!ctx.backend.assistant()) return json(503, { error: 'no model is configured', code: 'assistant_unavailable' });
  const spent = assistantBudget(ctx.client);
  if (spent) return spent;
  const instruction = text(body['instruction'], 1000);
  const key = text(body['key'], 1200);
  let input: DraftInput = { subject: text(body['subject'], 300), from: '', text: '', instruction, lang: ctx.lang };
  if (key) {
    const row = store.getMail(key);
    if (!row) return json(404, { error: 'not found', code: 'notFound' });
    const account = accountOf(row);
    if (!account) return json(409, { error: 'this mailbox is no longer configured', code: 'unconfigured' });
    let live: LiveMessage | undefined;
    try {
      const found = await within(liveMessage(row, account, ctx.backend, whereabouts(store, row)), LIVE_TIMEOUT_MS);
      if (timedOut(found)) return json(504, { error: 'the mailbox did not return this message in time', code: 'timeout' });
      live = found;
      rememberWhereabouts(store, row, live);
    } catch (error) {
      return mailboxFailure(error, 'readFailed', 'mailbox read failed');
    }
    if (!live) return json(404, { error: 'message not found in the mailbox', code: 'actionNotFound' });
    const from = live.readable.from;
    input = {
      subject: live.readable.subject || row.subject || '',
      from: from ? (from.name ? `${from.name} <${from.address}>` : from.address) : row.sender ?? '',
      text: live.readable.text,
      instruction,
      lang: ctx.lang,
      ...(account.fromName ? { selfName: account.fromName } : {}),
    };
  } else if (!instruction.trim()) {
    return badRequest('say what the message should say');
  }
  try {
    const result = await within(ctx.backend.draft(input), AI_TIMEOUT_MS);
    if (timedOut(result)) return json(504, { error: 'the model did not answer in time', code: 'assistant_timeout' });
    store.recordMcpAudit('web:draft', ctx.client, true, key || undefined);
    return json(200, { draft: result.draft });
  } catch (error) {
    store.recordMcpAudit('web:draft', ctx.client, false, key || undefined);
    return assistantFailure(error);
  }
}

async function handleAsk(req: IncomingMessage, store: StateStore, ctx: ActionContext): Promise<WebResponse> {
  const body = await readJson(req, 8 * 1024);
  const question = text(body?.['question'], 600).trim();
  if (!question) return badRequest('a question is required');
  if (!ctx.backend.assistant()) return json(503, { error: 'no model is configured', code: 'assistant_unavailable' });
  const spent = assistantBudget(ctx.client);
  if (spent) return spent;
  try {
    const result = await within(ctx.backend.ask(store, question, { lang: ctx.lang }), AI_TIMEOUT_MS);
    if (timedOut(result)) return json(504, { error: 'the model did not answer in time', code: 'assistant_timeout' });
    store.recordMcpAudit('web:ask', ctx.client, true);
    // Each citation travels with its row, so the page can show and open it
    // without a request per source.
    const citations = result.citations.flatMap((citation) => {
      const row = store.getMail(citation.key);
      return row ? [{ n: citation.n, key: row.dedupKey, row: ctx.decorate(row) }] : [];
    });
    return json(200, { answer: result.answer, citations, considered: result.considered });
  } catch (error) {
    store.recordMcpAudit('web:ask', ctx.client, false);
    return assistantFailure(error);
  }
}

// ---- Notifications to this device ----

function validPushKeys(p256dh: string, auth: string): boolean {
  try {
    const point = Buffer.from(p256dh, 'base64url');
    return point.length === 65 && point[0] === 4 && Buffer.from(auth, 'base64url').length === 16;
  } catch {
    return false;
  }
}

/** The https origin a subscription was made from, for the contact a push service is given. */
function requestOrigin(req: IncomingMessage): string | undefined {
  const origin = String(req.headers.origin ?? '');
  return /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(origin) ? origin : undefined;
}

/** A name for a device that is safe to hand to the page: not the endpoint, which is where pushes go. */
const deviceId = (endpoint: string): string => createHash('sha256').update(endpoint, 'utf8').digest('hex').slice(0, 16);

async function handlePush(path: string, req: IncomingMessage, store: StateStore, ctx: ActionContext): Promise<WebResponse> {
  if (!webPushEnabled()) return json(404, { error: 'notifications are switched off on this server', code: 'pushDisabled' });
  if (path === '/api/push/key' && req.method === 'GET') {
    return json(200, { publicKey: vapidKeys(store).publicKey });
  }
  if (req.method !== 'POST') return json(404, { error: 'not found' });
  const body = await readJson(req);
  const endpoint = text(body?.['endpoint'], 2100);

  // Which devices are told about mail. Anyone who can read the mail may see
  // the list; it holds a label and two dates, never an address to push to.
  if (path === '/api/push/devices') {
    const devices = store.listPushSubscriptions().map((sub) => ({
      id: deviceId(sub.endpoint), label: sub.label, since: sub.createdAt, lastOkAt: sub.lastOkAt,
      level: sub.level, codes: sub.codes, current: endpoint !== '' && sub.endpoint === endpoint,
    }));
    return json(200, { devices, canRemove: ctx.mayMark });
  }
  // Ending another device's notifications is the owner's call.
  if (path === '/api/push/remove') {
    if (!ctx.mayMark) return readOnly();
    const id = text(body?.['id'], 40);
    const target = store.listPushSubscriptions().find((sub) => deviceId(sub.endpoint) === id);
    if (!target) return json(404, { error: 'not found', code: 'notFound' });
    store.deletePushSubscription(target.endpoint);
    store.recordMcpAudit('web:push-remove', ctx.client, true);
    return json(200, { removed: true });
  }

  if (!endpoint) return badRequest('endpoint is required');
  if (path === '/api/push/state') {
    const sub = store.getPushSubscription(endpoint);
    return json(200, sub ? { subscribed: true, level: sub.level, codes: sub.codes } : { subscribed: false });
  }
  if (path === '/api/push/subscribe') {
    const keys = (body?.['keys'] ?? {}) as Record<string, unknown>;
    const p256dh = text(keys['p256dh'], 200);
    const auth = text(keys['auth'], 100);
    // The endpoint is where this server will POST, so it is checked against
    // the push services browsers actually use before it is ever stored.
    if (!isPushEndpoint(endpoint)) return json(400, { error: 'not a known push service', code: 'pushEndpoint' });
    if (!validPushKeys(p256dh, auth)) return badRequest('subscription keys are malformed');
    const origin = requestOrigin(req);
    const saved = store.savePushSubscription({
      endpoint, p256dh, auth,
      level: body?.['level'] === 'critical' ? 'critical' : 'warning',
      codes: body?.['codes'] !== false,
      lang: ctx.lang,
      // Tied to the token this session holds: when that token is replaced,
      // the subscription ends with it.
      credential: ctx.credential,
      ...(text(body?.['label'], 80) ? { label: text(body?.['label'], 80) } : {}),
      ...(origin ? { origin } : {}),
    });
    store.recordMcpAudit('web:push-subscribe', ctx.client, saved);
    if (!saved) return json(409, { error: 'too many devices are subscribed; remove one first', code: 'pushFull' });
    return json(200, { subscribed: true });
  }
  if (path === '/api/push/unsubscribe') {
    const removed = store.deletePushSubscription(endpoint);
    store.recordMcpAudit('web:push-unsubscribe', ctx.client, removed);
    return json(200, { subscribed: false });
  }
  if (path === '/api/push/test') {
    const result = await within(ctx.backend.testPush(store, endpoint), 20_000);
    return json(200, { result: timedOut(result) ? 'failed' : result });
  }
  return json(404, { error: 'not found' });
}

/**
 * Answer one of this file's routes, or undefined when the path is not one.
 *
 * The caller has already established the session and refused cross-site POSTs.
 */
export async function routeActions(
  req: IncomingMessage,
  url: URL,
  store: StateStore,
  ctx: ActionContext,
): Promise<WebResponse | undefined> {
  const path = url.pathname;
  // Work a handler starts may outlast its answer; from the moment this
  // returns, such work must use a database handle of its own (see `record`).
  const life: Life = { over: false };
  try {
    const answer = await (async (): Promise<WebResponse | undefined> => {
      if (path.startsWith('/api/push/')) return handlePush(path, req, store, ctx);
      if (path === '/api/reply' && req.method === 'GET') return handleReply(url.searchParams, store, ctx);
      if (path === '/api/forward' && req.method === 'GET') return handleForward(url.searchParams, store, ctx);
      if (req.method !== 'POST') return undefined;
      if (path === '/api/handled') return handleHandled(req, store, ctx, life);
      if (path === '/api/action') return handleAction(req, store, ctx, life);
      if (path === '/api/feedback') return handleFeedback(req, store, ctx);
      if (path === '/api/send') return handleSend(req, store, ctx, life);
      if (path === '/api/signature') return handleSignature(req, store, ctx);
      if (path === '/api/draft') return handleDraft(req, store, ctx);
      if (path === '/api/ask') return handleAsk(req, store, ctx);
      return undefined;
    })();
    if (answer) answer.cacheControl = 'no-store';
    return answer;
  } finally {
    life.over = true;
  }
}
