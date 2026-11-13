/**
 * The part of the web view that does things.
 *
 * Reading what triage stored is the rest of the view. This file is where the
 * page stops being a window: marking a message dealt with, moving it in the
 * mailbox, correcting a judgement, sending a reply, asking the model a
 * question, and telling this server which devices want notifications.
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
  appendToSent, applyWebMailAction, fetchReadableByMessageId, MailActionError,
  type LiveMessage, type WebMailAction, type WebMailActionResult,
} from './imap/client.js';
import {
  askMail, AssistantError, assistantConfigured, draftReply, type AskAnswer, type DraftInput,
} from './services/assistant.js';
import { sendTestPush, vapidKeys } from './services/push-dispatcher.js';
import { StateStore, type MailRow } from './services/state.js';
import { isPushEndpoint, type PushSendResult } from './services/webpush.js';
import {
  replyEnvelope, savesSentCopy, SendError, sendingStatus, sendMail, type OutgoingMail, type SentMail,
} from './smtp.js';
import {
  json, rateWindow, readJson, text, textList, timedOut, within, type Session, type WebResponse,
} from './web-http.js';
import type { Language } from './web-strings.js';
import { getLogger } from './logger.js';

const log = getLogger('web');

export interface WebBackend {
  read: (account: Account, messageId: string, folderHint?: string) => Promise<LiveMessage | undefined>;
  act: (
    account: Account, messageId: string, action: WebMailAction, options?: { destination?: string; folderHint?: string },
  ) => Promise<WebMailActionResult | undefined>;
  send: (account: Account, mail: OutgoingMail) => Promise<SentMail>;
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

/** The message as the mailbox has it now, from memory when it was read moments ago. */
export async function liveMessage(row: MailRow, account: Account, backend: WebBackend): Promise<LiveMessage | undefined> {
  const cached = liveCache.get(row.dedupKey);
  if (cached && Date.now() - cached.at < LIVE_TTL_MS) return cached.value;
  if (!row.messageId) return undefined;
  const running = liveInFlight.get(row.dedupKey);
  if (running) return running;
  const work: Promise<LiveMessage | undefined> = backend.read(account, row.messageId, row.folder ?? undefined)
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
const allowSend = rateWindow(10);

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

/** The actions the page offers. `move` to a folder of the caller's choosing stays with MCP. */
const PAGE_ACTIONS = new Set<WebMailAction>(['mark_read', 'mark_unread', 'star', 'unstar', 'archive', 'trash', 'inbox']);

async function handleHandled(req: IncomingMessage, store: StateStore, ctx: ActionContext, life: Life): Promise<WebResponse> {
  if (!ctx.mayMark) return readOnly();
  const body = await readJson(req);
  const key = text(body?.['key'], 1200);
  if (!key) return badRequest('key is required');
  const handled = body?.['handled'] !== false;
  const row = store.setHandled(key, handled);
  if (!row) return json(404, { error: 'not found', code: 'notFound' });
  store.recordMcpAudit(handled ? 'web:handled' : 'web:unhandled', ctx.client, true, row.dedupKey);
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
      void ctx.backend.act(account, messageId, 'mark_read', row.folder ? { folderHint: row.folder } : {}).then(
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
  const body = await readJson(req);
  const key = text(body?.['key'], 1200);
  const action = text(body?.['action'], 40) as WebMailAction;
  if (!key || !PAGE_ACTIONS.has(action)) return badRequest('key and a supported action are required');
  const row = store.getMail(key);
  if (!row?.messageId) return json(404, { error: 'not found', code: 'notFound' });
  const account = accountOf(row);
  if (!account) return json(409, { error: 'this mailbox is no longer configured', code: 'unconfigured' });

  const audit = {
    account: row.account, messageId: row.messageId, action, client: ctx.client,
    ...(row.folder ? { sourceFolder: row.folder } : {}),
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
      db.updateMailLocation(row.dedupKey, result.destinationFolder, Boolean(result.destinationIsSpam));
    }
    // Filing a message away is dealing with it.
    if (action === 'archive' || action === 'trash') db.setHandled(row.dedupKey, true);
    const after = db.getMail(row.dedupKey) ?? row;
    return json(200, { ok: true, action, row: ctx.decorate(after), attention: db.attentionCount() });
  };
  const refused = (error: unknown): WebResponse => {
    if (error instanceof MailActionError) return json(409, { error: error.message, code: `action_${error.code}` });
    return json(502, { error: 'the mailbox action failed', code: 'actionFailed', detail: String(error).slice(0, 200) });
  };
  const work: Promise<WebResponse> = ctx.backend.act(account, row.messageId, action, row.folder ? { folderHint: row.folder } : {}).then(
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
  store.recordFeedback(row.messageId ?? row.dedupKey, label as 'false_positive' | 'missed' | 'correct');
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

// ---- Writing ----

async function handleReply(params: URLSearchParams, store: StateStore, ctx: ActionContext): Promise<WebResponse> {
  const key = params.get('key')?.trim() ?? '';
  const row = key ? store.getMail(key) : undefined;
  if (!row) return json(404, { error: 'not found', code: 'notFound' });
  const account = accountOf(row);
  if (!account) return json(409, { error: 'this mailbox is no longer configured', code: 'unconfigured' });
  let live: LiveMessage | undefined;
  try {
    const found = await within(liveMessage(row, account, ctx.backend), LIVE_TIMEOUT_MS);
    if (timedOut(found)) return json(504, { error: 'the mailbox did not return this message in time', code: 'timeout' });
    live = found;
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
    params.get('mode') === 'replyAll' ? 'replyAll' : 'reply',
    ctx.lang,
  );
  const sending = ctx.backend.sending(account);
  return json(200, {
    key: row.dedupKey, account: account.username, accountName: account.name,
    ...envelope,
    canSend: sending.available, ...(sending.reason ? { reason: sending.reason } : {}),
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
const sendJobs = new Map<string, { at: number; outcome: Promise<WebResponse> }>();

export function forgetSends(): void {
  sendJobs.clear();
}

function rememberSend(id: string, outcome: Promise<WebResponse>, now = Date.now()): void {
  for (const [known, job] of sendJobs) {
    if (now - job.at > SEND_MEMORY_MS || sendJobs.size >= SEND_MEMORY_MAX) sendJobs.delete(known);
    else break;
  }
  sendJobs.set(id, { at: now, outcome });
}

const SEND_UNCERTAIN = (): WebResponse =>
  json(504, { error: 'the mail server did not confirm the message; check Sent before trying again', code: 'send_timeout' });

async function handleSend(req: IncomingMessage, store: StateStore, ctx: ActionContext, life: Life): Promise<WebResponse> {
  if (ctx.session !== 'write') return readOnly();
  // Sized for a long letter with its quoted history, and nothing like an upload.
  const body = await readJson(req, 700 * 1024);
  if (!body) return badRequest('a JSON body is required');

  // The same letter again: answer with what became of it the first time.
  const named = text(body['id'], 80);
  const sendId = /^[A-Za-z0-9_-]{8,64}$/.test(named) ? named : '';
  const earlier = sendId ? sendJobs.get(sendId) : undefined;
  if (earlier && Date.now() - earlier.at <= SEND_MEMORY_MS) {
    const answer = await within(earlier.outcome, SEND_TIMEOUT_MS);
    return timedOut(answer) ? SEND_UNCERTAIN() : { ...answer };
  }

  if (!allowSend(ctx.client)) {
    return { ...json(429, { error: 'too many messages; wait a minute', code: 'send_rate' }), headers: { 'retry-after': '60' } };
  }

  // A reply leaves from the mailbox that received the original: answering
  // from another address is how a thread loses its other half.
  const replyKey = text(body['replyTo'], 1200);
  const original = replyKey ? store.getMail(replyKey) : undefined;
  if (replyKey && !original) return json(404, { error: 'the message being answered was not found', code: 'notFound' });
  const address = original ? original.account : text(body['account'], 320);
  const account = configuredAccounts().find((candidate) => candidate.username === address);
  if (!account) return json(409, { error: 'this mailbox is not configured', code: 'unconfigured' });
  const sending = ctx.backend.sending(account);
  if (!sending.available) {
    return json(409, { error: 'this mailbox cannot send', code: 'send_not_configured', reason: sending.reason ?? 'no_smtp' });
  }

  const mail: OutgoingMail = {
    to: textList(body['to']),
    cc: textList(body['cc']),
    bcc: textList(body['bcc']),
    subject: text(body['subject'], 2000),
    text: text(body['text'], 500_000),
  };
  if (original?.messageId && !original.messageId.startsWith('<generated-')) {
    mail.inReplyTo = original.messageId;
    mail.references = [...textList(body['references'], 30, 998), original.messageId];
  }

  const audit = { account: account.username, action: 'send', client: ctx.client };
  // The whole of a send, from the server taking the message to the last note
  // about it. It never rejects, and it runs to its end whether or not the
  // request that started it is still waiting.
  const outcome = (async (): Promise<WebResponse> => {
    let sent: SentMail;
    try {
      sent = await ctx.backend.send(account, mail);
    } catch (error) {
      quietly('A failed send', () => record(ctx, store, life, (db) => db.recordMailAction({
        ...audit, messageId: replyKey || '(new message)', success: false,
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
    // Recorded without recipients or text: that a message left, from where, and when.
    quietly('A sent message', () => record(ctx, store, life, (db) => db.recordMailAction(
      { ...audit, messageId: sent.messageId, success: true },
    )));

    // Where the provider does not file its own copy, put one in Sent, or the
    // reply exists only in the other person's mailbox.
    let savedCopy = true;
    if (!ctx.backend.savesSentCopy(account)) {
      try {
        const folder = await within(ctx.backend.appendSent(account, sent.copy), ACTION_TIMEOUT_MS);
        savedCopy = !timedOut(folder) && Boolean(folder);
      } catch (error) {
        savedCopy = false;
        log.warn(`Filing the sent copy failed: ${String(error).slice(0, 160)}`);
      }
    }

    let attention: number | undefined;
    quietly('An answered message', () => record(ctx, store, life, (db) => {
      if (original) db.setHandled(original.dedupKey, true);
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
        void ctx.backend.act(account, messageId, 'answered', original.folder ? { folderHint: original.folder } : {}).then(
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
    });
  })();
  if (sendId) rememberSend(sendId, outcome);

  const answer = await within(outcome, SEND_TIMEOUT_MS);
  if (!timedOut(answer)) return answer;
  // Not known to have failed: the server may still take it, and that is recorded when it does.
  store.recordMailAction({ ...audit, messageId: replyKey || '(new message)', success: false, error: 'timeout' });
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
      const found = await within(liveMessage(row, account, ctx.backend), LIVE_TIMEOUT_MS);
      if (timedOut(found)) return json(504, { error: 'the mailbox did not return this message in time', code: 'timeout' });
      live = found;
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
      if (req.method !== 'POST') return undefined;
      if (path === '/api/handled') return handleHandled(req, store, ctx, life);
      if (path === '/api/action') return handleAction(req, store, ctx, life);
      if (path === '/api/feedback') return handleFeedback(req, store, ctx);
      if (path === '/api/send') return handleSend(req, store, ctx, life);
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
