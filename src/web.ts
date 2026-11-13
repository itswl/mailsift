/**
 * The web view: a mail client over what the poller stored.
 *
 * This file is the page and the part of it that reads: what arrived, how it
 * was judged and why, and one message fetched live under a read-only lock and
 * persisted nowhere. The part that changes things (marking done, mailbox
 * actions, sending, asking the model, notifications) is in web-actions.ts.
 *
 * It shares the MCP server's port and its two tokens, because it shares that
 * trust boundary: whoever can read triage results over JSON-RPC can read them
 * here, and only the write credential can act. Disabled unless
 * WEB_UI_ENABLED=true, since a page a browser can reach is a wider surface
 * than a JSON-RPC endpoint and should be opted into.
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { loadConfig, type Account } from './config.js';
import { escapeHtml } from './html.js';
import {
  AttachmentNotFoundError, AttachmentTooLargeError, fetchAttachmentByMessageId,
  fetchAttachmentManifestByMessageId, inspectMailSafety, scanAttachmentByMessageId,
} from './imap/client.js';
import { buildLink } from './links.js';
import { nextDigestAt, renderDigest, type DigestItem } from './services/digest.js';
import { mailboxStatuses } from './services/health.js';
import { CATEGORIES } from './services/triage.js';
import { HEARTBEAT_KEY, type PollStats } from './services/watcher.js';
import { attachmentLimitBytes, MAX_ATTACHMENTS } from './smtp.js';
import {
  configuredAccounts, defaultBackend, forgetLive, liveMessage, mailboxFailure, rememberWhereabouts, routeActions,
  SIGNATURE_MAX_CHARS, signatureOf, webPushEnabled, whereabouts,
  type ActionContext, type WebBackend,
} from './web-actions.js';
import { clientScript, LANGUAGE_COOKIE, storeLanguageScript } from './web-client.js';
import {
  credentialMark, crossSite, embedded, json, localHost, presentedToken, rateWindow, readBody, readCookie,
  SESSION_COOKIE, sessionOf, timedOut, tokenMatches, within, type Session, type WebResponse,
} from './web-http.js';
import { appleTouch180, favicon64, icon192, icon512, maskable512 } from './web-icons.js';
import { liveHub } from './web-live.js';
import { LIGHT_BAR, styles } from './web-styles.js';
import { isLanguage, LANGUAGES, t, type Language, type StringKey } from './web-strings.js';
import { appPolicy, framePolicy, MAIL_FRAME, SERVICE_WORKER, SHELL_HEADER } from './web-worker.js';
import type { MailRow, StateStore } from './services/state.js';

export { LANGUAGE_COOKIE, readCookie, SESSION_COOKIE, tokenMatches };
export type { Session, WebBackend, WebResponse };
/** A live IMAP read can be slow on providers with poor search; do not hang a tab on it. */
const LIVE_FETCH_TIMEOUT_MS = 25_000;
const LIVE_ATTACHMENT_TIMEOUT_MS = 60_000;
const LIVE_SAFETY_TIMEOUT_MS = 25_000;
/** The plain text kept under `body` for callers that read the API directly. */
const LIVE_BODY_CHARS = 20_000;

/**
 * Sign-in attempts per client per minute.
 *
 * /auth is the only route that answers without credentials, so it is the only
 * one an unauthenticated caller can spend the general request budget on. A
 * much smaller budget of its own keeps a guessing client from crowding out
 * real traffic, whatever it achieves against a long token.
 */
const AUTH_ATTEMPTS_PER_MINUTE = 10;
export const allowAuthAttempt = rateWindow(AUTH_ATTEMPTS_PER_MINUTE);

/**
 * Manual polls per client per minute.
 *
 * A poll opens every monitored IMAP connection, so a browser left on the page
 * must not be able to turn a held-down button into a mailbox hammer. A handful
 * is plenty for a person waiting on a verification code.
 */
const REFRESHES_PER_MINUTE = 6;
export const allowManualRefresh = rateWindow(REFRESHES_PER_MINUTE);

export function webUiEnabled(): boolean {
  return (process.env.WEB_UI_ENABLED ?? 'false').toLowerCase() === 'true';
}

export function webVersion(): string {
  const version = process.env.MAILSIFT_VERSION?.trim();
  if (!version) return 'dev';
  return version.startsWith('v') ? version : `v${version}`;
}

/**
 * What the page may do beyond reading what the poller stored.
 *
 * `onRefresh` is absent in the standalone MCP server, which has no watcher to
 * poll with; the button and the endpoint then stay out of the page entirely
 * rather than offering a control that can only fail. `writeToken` is the
 * credential that turns a session into one that may act on mail; without it
 * the view is read-only for everyone. `backend` stands in for the mailbox,
 * the mail server and the model in the preview and in tests.
 */
export interface WebOptions {
  onRefresh?: (() => Promise<PollStats>) | undefined;
  writeToken?: string | undefined;
  backend?: Partial<WebBackend> | undefined;
  /**
   * Have a mailbox connection ready for the reader. Called when the page
   * asks for its summary, which is when someone has just opened it. Given
   * by the server that owns real mailboxes; absent, nothing is warmed.
   */
  warm?: ((account: Account) => void) | undefined;
}

/** Whether this request may see triage data: a bearer token or an established session. */
export function authorized(req: IncomingMessage, token: string, writeToken = ''): boolean {
  return sessionOf(req, token, writeToken) !== 'none';
}

/**
 * The language the browser asks for, reduced to the ones offered.
 *
 * Entries are ranked by their q weight, then by position, and the first one
 * we can serve wins, so "ja, zh;q=0.8" gets Chinese rather than falling back
 * to English because Japanese came first. Every Chinese variant maps to
 * Simplified: it is the one we have, and nearer to what a Traditional reader
 * wants than English is.
 */
export function languageFromHeader(header: string | undefined): Language {
  const ranked = (header ?? '').split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().toLowerCase().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag: tag.trim(), weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((entry) => entry.tag && entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const { tag } of ranked) {
    if (tag === 'zh' || tag.startsWith('zh-')) return 'zh-CN';
    if (tag === 'en' || tag.startsWith('en-')) return 'en';
  }
  return 'en';
}

/** The language to render in: a choice made with the switch, otherwise what the browser asks for. */
export function pickLanguage(req: IncomingMessage): Language {
  const stored = readCookie(req.headers.cookie, LANGUAGE_COOKIE);
  return isLanguage(stored) ? stored : languageFromHeader(req.headers['accept-language']);
}

/** Where the switch goes from here: round robin, so it also serves a third language. */
function nextLanguage(lang: Language): Language {
  return LANGUAGES[(LANGUAGES.indexOf(lang) + 1) % LANGUAGES.length] ?? LANGUAGES[0];
}

function intParam(params: URLSearchParams, name: string, fallback: number, max: number): number {
  const raw = Number(params.get(name));
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.floor(raw), max);
}

function boolParam(params: URLSearchParams, name: string): boolean {
  return params.get(name) === 'true';
}

interface MailCursor {
  createdAt: string;
  dedupKey: string;
}

function encodeMailCursor(row: MailCursor): string {
  // Keep the cursor small and opaque: never put subject, sender or summary
  // fields into a URL just because the row object happens to contain them.
  return Buffer.from(JSON.stringify({ createdAt: row.createdAt, dedupKey: row.dedupKey }), 'utf8').toString('base64url');
}

function decodeMailCursor(raw: string | null): MailCursor | undefined {
  if (!raw || raw.length > 1024) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<MailCursor>;
    if (typeof parsed.createdAt !== 'string' || typeof parsed.dedupKey !== 'string') return undefined;
    return { createdAt: parsed.createdAt, dedupKey: parsed.dedupKey };
  } catch {
    return undefined;
  }
}

/** What a read route needs to know about who asked and what stands behind the page. */
export interface ApiContext {
  session?: Session;
  options?: WebOptions;
  lang?: Language;
  /** Whether this server asks for a token at all, so the page knows to offer signing out. */
  authRequired?: boolean;
}

function backendOf(options: WebOptions | undefined): WebBackend {
  return { ...defaultBackend, ...(options?.backend ?? {}) };
}

/** A stored row as the list shows it: with its provider and its link out. */
function decorate(row: MailRow): Record<string, unknown> {
  const provider = providerOf(row.account);
  // The provider travels with the link so the browser can word it in its own language.
  return { ...row, provider, link: buildLink(provider, row.account, row.messageId ?? '') };
}

/**
 * Answer one API path.
 *
 * Kept separate from the HTTP plumbing so the contract can be tested without a
 * socket, and so the routing stays readable.
 */
export async function handleApi(
  path: string,
  params: URLSearchParams,
  store: StateStore,
  context: ApiContext = {},
): Promise<WebResponse> {
  const backend = backendOf(context.options);
  const session = context.session ?? 'read';

  if (path === '/api/mail') {
    const search = params.get('q')?.trim();
    const importance = params.get('importance')?.trim();
    const category = params.get('category')?.trim();
    const account = params.get('account')?.trim();
    const limit = intParam(params, 'limit', 100, 199);
    const cursor = decodeMailCursor(params.get('cursor'));
    const rows = store.queryMail({
      sinceHours: intParam(params, 'hours', 24, 24 * 90),
      ...(importance ? { importance } : {}),
      ...(category ? { category } : {}),
      ...(account ? { account } : {}),
      ...(search ? { search } : {}),
      spamOnly: boolParam(params, 'spamOnly'),
      pushedOnly: boolParam(params, 'pushedOnly'),
      codesOnly: boolParam(params, 'codesOnly'),
      ...(cursor ? { beforeCreatedAt: cursor.createdAt, beforeDedupKey: cursor.dedupKey } : {}),
      // Read one extra row to know whether the page needs a continuation cursor.
      limit: limit + 1,
    });
    const hasMore = rows.length > limit;
    const mail = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && mail.at(-1)
      ? encodeMailCursor({ createdAt: mail.at(-1)!.createdAt, dedupKey: mail.at(-1)!.dedupKey })
      : undefined;
    return json(200, {
      count: mail.length,
      mail: mail.map(decorate),
      ...(nextCursor ? { nextCursor } : {}),
    });
  }

  if (path === '/api/threads') {
    const search = params.get('q')?.trim();
    const importance = params.get('importance')?.trim();
    const category = params.get('category')?.trim();
    const account = params.get('account')?.trim();
    const limit = intParam(params, 'limit', 50, 100);
    const threads = store.queryThreads({
      sinceHours: intParam(params, 'hours', 24, 24 * 90),
      ...(importance ? { importance } : {}),
      ...(category ? { category } : {}),
      ...(account ? { account } : {}),
      ...(search ? { search } : {}),
      spamOnly: boolParam(params, 'spamOnly'),
      pushedOnly: boolParam(params, 'pushedOnly'),
      codesOnly: boolParam(params, 'codesOnly'),
      limit,
    });
    return json(200, {
      count: threads.length,
      windowHours: intParam(params, 'hours', 24, 24 * 90),
      threads: threads.map((thread) => ({
        ...thread,
        latest: decorate(thread.latest),
        messages: thread.messages.map(decorate),
      })),
    });
  }

  if (path === '/api/attention') {
    // What was judged to matter and has not been dealt with, whatever the
    // window the list is showing: a deadline does not expire with the day.
    const rows = store.attention(intParam(params, 'limit', 50, 100));
    // And what was dealt with lately, so a message marked done can be found
    // again and put back even when it is older than the list's window.
    const done = store.recentlyHandled(intParam(params, 'done', 20, 50));
    return json(200, {
      count: store.attentionCount(),
      mail: rows.map(decorate),
      done: done.map(({ row, queued }) => ({ ...decorate(row), queued })),
    });
  }

  if (path === '/api/summary') {
    const hours = intParam(params, 'hours', 24, 24 * 90);
    // When the poller last finished, so the page can say how fresh it is. The
    // standalone MCP server shares the database, so it can usually say too.
    // The heartbeat is written after every poll, even one in which a mailbox
    // failed, so each mailbox's own state travels with it.
    const accounts = configuredAccounts();
    // Someone is looking at the page: by the time they tap a message, the
    // connection it will be read over should already be made.
    if (context.options?.warm) {
      for (const account of accounts) {
        try { context.options.warm(account); } catch { /* warming is a courtesy */ }
      }
    }
    return json(200, {
      ...store.summarize(hours),
      categories: CATEGORIES,
      accounts: accounts.map((a) => {
        const sending = backend.sending(a);
        return {
          address: a.username, name: a.name, canSend: sending.available, ...(sending.reason ? { sendReason: sending.reason } : {}),
          // What goes under a letter from this mailbox, for the session that may send one ('' when none).
          ...(session === 'write' ? { signature: signatureOf(store, a.username) } : {}),
        };
      }),
      // What a letter may carry and a signature may say, so the page refuses what the server would.
      limits: { attachmentBytes: attachmentLimitBytes(), attachmentFiles: MAX_ATTACHMENTS, signatureChars: SIGNATURE_MAX_CHARS },
      lastPollAt: store.getMeta(HEARTBEAT_KEY) ?? null,
      pollIntervalSeconds: Number(process.env.POLL_INTERVAL_SECONDS ?? 300),
      mailboxes: mailboxStatuses(store, accounts),
      outboxPending: store.notificationOutboxPending(),
      attention: store.attentionCount(),
      // What this session may do, so the page offers only what will work.
      session: {
        writable: session === 'write',
        auth: Boolean(context.authRequired),
        writeConfigured: Boolean(context.options?.writeToken),
        // Marking mail dealt with: the write session's, unless no write token
        // exists and the one credential is the owner's.
        canMark: session === 'write' || !context.options?.writeToken,
        assistant: backend.assistant(),
        push: webPushEnabled(),
      },
    });
  }

  if (path === '/api/digest') {
    // Each entry carries its key, so a line in the page opens that message.
    const items = store.peekDigestEntries()
      .map((entry) => ({ ...(entry.payload as DigestItem), key: entry.dedupKey }));
    // The rendered text is what Feishu will receive; the items let the page
    // lay the same queue out as a list instead of showing markdown source.
    // The send time is worked out here, by the clock that sends it, and the
    // page shows it in its own.
    const next = nextDigestAt(store);
    return json(200, {
      pending: items.length,
      preview: renderDigest(items),
      items,
      enabled: next !== null,
      nextAt: next?.toISOString() ?? null,
      // What went out last, for a morning's look after the queue is empty.
      ...lastDigest(store),
    });
  }

  if (path === '/api/message') {
    const messageId = params.get('id')?.trim();
    if (!messageId) return json(400, { error: 'id is required' });
    const found = store.getMail(messageId);
    if (!found) return json(404, { error: 'not found', code: 'notFound' });
    // Linked like a row of the list, so a message opened from a shared link
    // still offers the provider's own client.
    const stored = decorate(found);
    if (params.get('live') !== 'true') return json(200, { ...stored, body: null });

    const account = loadConfig().accounts.find((a) => a.username === found.account);
    // Each failure carries a code as well as the message, so the browser can
    // word it in the reader's language while a JSON client still reads the text.
    if (!account) return json(409, { error: 'this mailbox is no longer configured', code: 'unconfigured' });
    // A retry asks the mailbox again rather than a copy read a moment ago.
    if (params.get('fresh') === 'true') forgetLive(found.dedupKey);
    try {
      const live = await within(liveMessage(found, account, backend, whereabouts(store, found)), LIVE_FETCH_TIMEOUT_MS);
      if (timedOut(live)) return json(504, { error: 'the mailbox did not return this message in time', code: 'timeout' });
      if (!live) return json(404, { error: 'the message is no longer where it was filed', code: 'notInMailbox' });
      // Where it was found is kept, so the next opening is a fetch and not a search.
      rememberWhereabouts(store, found, live);
      const r = live.readable;
      return json(200, {
        ...stored,
        body: r.text.slice(0, LIVE_BODY_CHARS),
        // The message as it was written. `html` is the sender's own markup and
        // is not safe to put in a page: the browser view cleans it and shows it
        // in a sandboxed frame; any other caller should prefer `text`.
        text: r.text, quoted: r.quoted, html: r.html, htmlOmitted: r.htmlOmitted, truncated: r.truncated,
        from: r.from, to: r.to, cc: r.cc, replyTo: r.replyTo, references: r.references,
        auth: r.auth, unsubscribe: r.unsubscribe, inlineImages: r.inlineImages,
        flags: live.flags, liveFolder: live.folder,
      });
    } catch (error) {
      return mailboxFailure(error, 'readFailed', 'mailbox read failed');
    }
  }

  return json(404, { error: 'unknown endpoint' });
}

function attachmentContentDisposition(filename: string | undefined): string {
  const safe = (filename || 'attachment')
    .replace(/[\\/\u0000-\u001f\u007f"]/g, '_')
    .trim()
    .slice(0, 200) || 'attachment';
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function attachmentContentType(value: string): string {
  const normalized = value.toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(normalized)
    ? normalized
    : 'application/octet-stream';
}

async function handleAttachmentsApi(
  params: URLSearchParams,
  store: StateStore,
  client: string,
): Promise<WebResponse> {
  const id = params.get('id')?.trim();
  const target = id;
  if (!id) {
    store.recordMcpAudit('web:list-attachments', client, false, target);
    return json(400, { error: 'id is required' });
  }
  const stored = store.getMail(id);
  if (!stored?.messageId) {
    store.recordMcpAudit('web:list-attachments', client, false, target);
    return json(404, { error: 'mail record not found', code: 'notFound' });
  }
  const account = loadConfig().accounts.find((candidate) => candidate.username === stored.account);
  if (!account) {
    store.recordMcpAudit('web:list-attachments', client, false, target);
    return json(409, { error: 'mailbox is no longer configured', code: 'unconfigured' });
  }

  try {
    const timeout = Symbol('attachment lookup timeout');
    const found = await Promise.race([
      fetchAttachmentManifestByMessageId(account, stored.messageId, whereabouts(store, stored)),
      new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), LIVE_ATTACHMENT_TIMEOUT_MS).unref()),
    ]);
    if (found === timeout) {
      store.recordMcpAudit('web:list-attachments', client, false, target);
      return json(504, { error: 'the mailbox did not return attachment metadata in time', code: 'attachmentTimeout' });
    }
    store.recordMcpAudit('web:list-attachments', client, Boolean(found), target);
    if (!found) return json(404, { error: 'message not found in configured read-only folders', code: 'actionNotFound' });
    return json(200, {
      folder: found.folder,
      attachments: found.manifest.items,
      truncated: found.manifest.truncated,
    });
  } catch (error) {
    store.recordMcpAudit('web:list-attachments', client, false, target);
    return mailboxFailure(error, 'attachmentFailed', 'mailbox attachment lookup failed');
  }
}

async function handleMailSafetyApi(
  params: URLSearchParams,
  store: StateStore,
  client: string,
): Promise<WebResponse> {
  const id = params.get('id')?.trim();
  const target = id;
  if (!id) {
    store.recordMcpAudit('web:inspect-mail-safety', client, false, target);
    return json(400, { error: 'id is required' });
  }
  const stored = store.getMail(id);
  if (!stored?.messageId) {
    store.recordMcpAudit('web:inspect-mail-safety', client, false, target);
    return json(404, { error: 'mail record not found', code: 'safetyNotFound' });
  }
  const account = loadConfig().accounts.find((candidate) => candidate.username === stored.account);
  if (!account) {
    store.recordMcpAudit('web:inspect-mail-safety', client, false, target);
    return json(409, { error: 'mailbox is no longer configured', code: 'unconfigured' });
  }

  try {
    const timeout = Symbol('mail safety lookup timeout');
    const report = await Promise.race([
      inspectMailSafety(account, stored.messageId, whereabouts(store, stored)),
      new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), LIVE_SAFETY_TIMEOUT_MS).unref()),
    ]);
    if (report === timeout) {
      store.recordMcpAudit('web:inspect-mail-safety', client, false, target);
      return json(504, { error: 'the mailbox did not return safety metadata in time', code: 'safetyTimeout' });
    }
    store.recordMcpAudit('web:inspect-mail-safety', client, Boolean(report), target);
    if (!report) {
      return json(404, { error: 'message not found in configured read-only folders', code: 'safetyNotFound' });
    }
    return json(200, report);
  } catch (error) {
    store.recordMcpAudit('web:inspect-mail-safety', client, false, target);
    return mailboxFailure(error, 'safetyFailed', 'mail safety inspection failed');
  }
}

async function handleAttachmentApi(
  params: URLSearchParams,
  store: StateStore,
  client: string,
): Promise<WebResponse> {
  const id = params.get('id')?.trim();
  const partId = params.get('part')?.trim();
  const target = id && partId ? `${id}#${partId}` : id;
  if (!id || !partId) {
    store.recordMcpAudit('web:get-attachment', client, false, target);
    return json(400, { error: 'id and part are required' });
  }
  const stored = store.getMail(id);
  if (!stored?.messageId) {
    store.recordMcpAudit('web:get-attachment', client, false, target);
    return json(404, { error: 'mail record not found', code: 'notFound' });
  }
  const account = loadConfig().accounts.find((candidate) => candidate.username === stored.account);
  if (!account) {
    store.recordMcpAudit('web:get-attachment', client, false, target);
    return json(409, { error: 'mailbox is no longer configured', code: 'unconfigured' });
  }

  try {
    const timeout = Symbol('attachment download timeout');
    const found = await Promise.race([
      fetchAttachmentByMessageId(account, stored.messageId, partId, whereabouts(store, stored)),
      new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), LIVE_ATTACHMENT_TIMEOUT_MS).unref()),
    ]);
    if (found === timeout) {
      store.recordMcpAudit('web:get-attachment', client, false, target);
      return json(504, { error: 'the mailbox did not return this attachment in time', code: 'attachmentTimeout' });
    }
    store.recordMcpAudit('web:get-attachment', client, Boolean(found), target);
    if (!found) return json(404, { error: 'message not found in configured read-only folders', code: 'actionNotFound' });
    return {
      status: 200,
      body: found.content,
      contentType: attachmentContentType(found.metadata.contentType),
      cacheControl: 'no-store',
      headers: {
        'content-disposition': attachmentContentDisposition(found.metadata.filename),
        'x-content-type-options': 'nosniff',
      },
    };
  } catch (error) {
    store.recordMcpAudit('web:get-attachment', client, false, target);
    if (error instanceof AttachmentNotFoundError) {
      return json(404, { error: 'attachment not found', code: 'attachmentNotFound' });
    }
    if (error instanceof AttachmentTooLargeError) {
      return json(413, {
        error: 'attachment exceeds the configured per-file limit',
        code: 'attachmentTooLarge',
        maxBytes: error.maxBytes,
      });
    }
    return mailboxFailure(error, 'attachmentFailed', 'attachment read failed');
  }
}

async function handleAttachmentScanApi(
  params: URLSearchParams,
  store: StateStore,
  client: string,
): Promise<WebResponse> {
  const id = params.get('id')?.trim();
  const partId = params.get('part')?.trim();
  const target = id && partId ? `${id}#${partId}` : undefined;
  if (!id || !partId || !/^\d+(?:\.\d+)*$/.test(partId)) {
    store.recordMcpAudit('web:scan-attachment', client, false, target);
    return json(400, { error: 'id and a valid part are required' });
  }
  const stored = store.getMail(id);
  if (!stored?.messageId) {
    store.recordMcpAudit('web:scan-attachment', client, false, target);
    return json(404, { error: 'mail record not found', code: 'notFound' });
  }
  const account = loadConfig().accounts.find((candidate) => candidate.username === stored.account);
  if (!account) {
    store.recordMcpAudit('web:scan-attachment', client, false, target);
    return json(409, { error: 'mailbox is no longer configured', code: 'unconfigured' });
  }

  try {
    const timeout = Symbol('attachment scan timeout');
    const report = await Promise.race([
      scanAttachmentByMessageId(account, stored.messageId, partId, whereabouts(store, stored)),
      new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), LIVE_ATTACHMENT_TIMEOUT_MS).unref()),
    ]);
    if (report === timeout) {
      store.recordMcpAudit('web:scan-attachment', client, false, target);
      return json(504, { error: 'the mailbox did not return this attachment in time', code: 'attachmentTimeout' });
    }
    store.recordMcpAudit('web:scan-attachment', client, Boolean(report), target);
    if (!report) return json(404, { error: 'attachment not found', code: 'attachmentNotFound' });
    return json(200, report);
  } catch (error) {
    store.recordMcpAudit('web:scan-attachment', client, false, target);
    if (error instanceof AttachmentNotFoundError) {
      return json(404, { error: 'attachment not found', code: 'attachmentNotFound' });
    }
    return mailboxFailure(error, 'attachmentFailed', 'attachment scan failed');
  }
}

/** A sent digest stays on the page for most of a day, then gives way to the next. */
const LAST_DIGEST_HOURS = 18;

function lastDigest(store: StateStore): { last?: { sentAt: string; count: number; items: Array<Record<string, unknown>> } } {
  const logged = store.lastDigestLog();
  if (!logged) return {};
  const age = Date.now() - Date.parse(logged.sentAt);
  if (!Number.isFinite(age) || age < 0 || age > LAST_DIGEST_HOURS * 3_600_000) return {};
  return { last: { sentAt: logged.sentAt, count: logged.items.length, items: logged.items } };
}

function providerOf(address: string): string {
  try {
    return loadConfig().accounts.find((a) => a.username === address)?.provider ?? '';
  } catch {
    return '';
  }
}

/**
 * The login form, shown when a token is configured and the browser has none.
 *
 * The token is posted rather than put in the URL, so it does not end up in
 * browser history, proxy logs or a Referer header. One field takes either
 * credential: the token decides what the session may do.
 */
export function renderLogin(lang: Language, error?: StringKey, nonce = '', upgrade = false): string {
  const s = (key: StringKey): string => escapeHtml(t(lang, key));
  // The switch reloads here rather than rewording in place: there is nothing
  // on this page to lose, and the reload goes to a GET so a refused sign-in is
  // not posted a second time.
  return page(lang, s('login.title'), `
    <form method="post" action="/auth" class="login">
      <img class="brand-mark" src="/icon-192.png?v=3" alt="" aria-hidden="true">
      <h1>mailsift</h1>
      <p class="muted">${s(upgrade ? 'login.introWrite' : 'login.intro')}</p>
      <input type="text" name="user" value="mailsift" autocomplete="username" readonly aria-label="${s('login.account')}">
      <input type="password" name="token" autocomplete="current-password" placeholder="${s('login.token')}" enterkeyhint="go" autofocus>
      <button type="submit">${s('login.open')}</button>
      ${error ? '<p class="error" role="alert">' + s(error) + '</p>' : ''}
      <button type="button" id="lang" class="lang" aria-label="${s('lang.label')}">${s('lang.face')}</button>
      <p class="version">${escapeHtml(webVersion())}</p>
    </form>
    <script nonce="${nonce}">${storeLanguageScript()}
    document.querySelector('#lang').onclick = () => { storeLanguage('${nextLanguage(lang)}'); location.replace('${upgrade ? '/signin' : '/'}'); };</script>`, nonce);
}

/**
 * Applied in the document head, ahead of the body.
 *
 * Reading the choice after first paint would show the wrong theme for a frame,
 * which is exactly the thing a manual switch is meant to stop.
 */
function themeBoot(): string {
  return "(function(){try{var c=localStorage.getItem('theme');"
    + "if(c!=='dark'&&c!=='light')c='light';"
    + "document.documentElement.dataset.theme=c;"
    + "var d=c==='dark';"
    + "var m=document.querySelector('meta[name=theme-color]');"
    + "var b=getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();"
    + "if(m&&b)m.setAttribute('content',b);"
    + "var a=document.querySelector('meta[name=apple-mobile-web-app-status-bar-style]');"
    + "if(a)a.setAttribute('content',d?'black-translucent':'default');}catch(e){}})();";
}

/** The line icons the page draws with, defined once and referenced by id. */
const ICONS: Record<string, string> = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  arrow: '<path d="M7 17L17 7M8 7h9v9"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  reply: '<path d="M10 8l-5 5 5 5"/><path d="M5 13h9a5 5 0 0 1 5 5v1"/>',
  'reply-all': '<path d="M7 8l-5 5 5 5"/><path d="M13 8l-5 5 5 5"/><path d="M8 13h8a5 5 0 0 1 5 5v1"/>',
  forward: '<path d="M14 8l5 5-5 5"/><path d="M19 13h-9a5 5 0 0 0-5 5v1"/>',
  archive: '<path d="M4 5h16v4H4z"/><path d="M6 9v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9"/><path d="M10 13h4"/>',
  star: '<path d="M12 4l2.5 5.1 5.6.8-4 4 1 5.6-5.1-2.7-5.1 2.7 1-5.6-4-4 5.6-.8z"/>',
  trash: '<path d="M5 7h14"/><path d="M10 7V5h4v2"/><path d="M7 7l1 12h8l1-12"/>',
  inbox: '<path d="M4 13l2.5-7h11L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M4 13h4.5l1 2h5l1-2H20"/>',
  more: '<path d="M6 12h.01M12 12h.01M18 12h.01" stroke-width="2.6"/>',
  sparkle: '<path d="M11 4l1.7 4.3L17 10l-4.3 1.7L11 16l-1.7-4.3L5 10l4.3-1.7z"/><path d="M18 14.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  send: '<path d="M20 4L4 11l6 2.5L12.5 20z"/><path d="M10 13.5L20 4"/>',
  bell: '<path d="M6 17v-6a6 6 0 1 1 12 0v6l1.5 1.5h-15z"/><path d="M10 21a2 2 0 0 0 4 0"/>',
  clip: '<path d="M15.5 7.5l-7 7a2 2 0 0 0 2.8 2.8l7.4-7.4a4 4 0 0 0-5.6-5.6L5.6 11.8a6 6 0 0 0 8.5 8.5l6-6"/>',
  shield: '<path d="M12 3.5l7 2.5v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z"/><path d="M9 12l2.2 2.2 4-4.2"/>',
  alert: '<path d="M12 4l9 15.5H3z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  compose: '<path d="M5 19h4L19 9l-4-4L5 15z"/><path d="M13.5 6.5l4 4"/>',
  image: '<path d="M4 5h16v14H4z"/><path d="M4 16l4.5-4.5 3.5 3.5 2.5-2.5L20 17"/><path d="M9 9.5h.01" stroke-width="2.4"/>',
  read: '<path d="M4 9.5l8-5 8 5V19H4z"/><path d="M4 9.5l8 5 8-5"/>',
};

function iconSymbols(): string {
  return '<svg hidden aria-hidden="true" focusable="false">'
    + Object.entries(ICONS).map(([id, body]) => `<symbol id="i-${id}" viewBox="0 0 24 24">${body}</symbol>`).join('')
    + '</svg>';
}

/** One of the icons above, inline, for the parts of the shell rendered here. */
function icon(id: string, cls = 'icon'): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[id] ?? ''}</svg>`;
}

/**
 * The application shell. All content is built in the browser from the JSON API.
 *
 * The page's own words are rendered in the chosen language and tagged with
 * their key, so the switch can reword them in place instead of reloading and
 * losing the filters.
 */
export function renderApp(lang: Language, canRefresh = false, nonce = ''): string {
  const s = (key: StringKey): string => escapeHtml(t(lang, key));
  const worded = (tag: string, key: StringKey, attrs = ''): string =>
    `<${tag}${attrs ? ' ' + attrs : ''} data-i18n="${key}">${s(key)}</${tag}>`;
  const option = (value: string, key: StringKey): string => worded('option', key, `value="${value}"`);
  // A radio styled as a word: the input stays in the form under its name, so
  // the query the page sends is built from the form exactly as before.
  const seg = (name: string, value: string, key: StringKey, checked = false): string =>
    `<label class="seg${checked ? ' on' : ''}"><input type="radio" name="${name}" value="${value}"${checked ? ' checked' : ''}>${worded('span', key)}</label>`;
  // An icon-only button: its name lives in the label and the title, both reworded with the page.
  const iconButton = (id: string, glyph: string, key: StringKey, attrs = ''): string =>
    `<button id="${id}" type="button" class="icon-btn" aria-label="${s(key)}" title="${s(key)}" data-i18n-label="${key}" data-i18n-title="${key}"${attrs ? ' ' + attrs : ''}>${icon(glyph, '')}</button>`;
  const chevron = icon('chevron');
  // Icon-only, like the theme switch: the label lives in its title and in the
  // accessible name, and the arrow spins while a poll is running.
  const refresh = canRefresh
    ? `<button id="refresh" type="button" class="icon-btn" aria-label="${s('refresh.label')}" title="${s('refresh.label')}">`
      + '<svg class="refresh-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
      + '<path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 4v7h-7"/></svg></button>'
    : '';
  const sheetHead = (titleId: string, key: StringKey, doneId: string): string =>
    `<div class="sheet-head"><span class="handle"></span><span></span><h2 id="${titleId}" data-i18n="${key}">${s(key)}</h2><button id="${doneId}" type="button" class="text-btn" data-i18n="done">${s('done')}</button></div>`;
  return page(lang, 'mailsift', `
    <header class="app-header">
      <div class="header-inner">
        <div class="brand"><img class="brand-mark" src="/icon-192.png?v=3" alt="" aria-hidden="true"><strong>mailsift</strong></div>
        <div class="header-actions">
          ${refresh}
          ${iconButton('compose-open', 'compose', 'compose.new', 'aria-haspopup="dialog" aria-controls="compose"')}
          ${iconButton('bell', 'bell', 'notify.title', 'aria-haspopup="dialog" aria-controls="notify-sheet" aria-expanded="false"')}
          <button id="lang" type="button" class="word-btn" aria-label="${s('lang.label')}">${s('lang.face')}</button>
          <button id="theme" type="button" class="icon-btn" aria-label="${s('theme.title')}"><svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor" stroke="none"/></svg></button>
        </div>
      </div>
    </header>
    <main class="app-main">
      <div class="feed">
        <div id="network" class="banner" hidden><span id="network-text"></span><button id="network-retry" type="button" class="text-btn" data-i18n="network.retry">${s('network.retry')}</button></div>
        <section class="title" aria-label="${s('overview.title')}" data-i18n-label="overview.title">
          <p id="lede" class="lede pending">${s('lede.loading')}</p>
          <p id="tally" class="tally"></p>
          <p id="status" class="status" role="status" aria-live="polite"></p>
          <button id="health" type="button" class="health-line" aria-haspopup="dialog" aria-controls="health-sheet" aria-expanded="false" hidden></button>
        </section>
        <form id="filters" class="controls" autocomplete="off">
          <div id="control-line" class="control-line">
            <fieldset class="window" role="radiogroup" aria-label="${s('filter.window')}" data-i18n-label="filter.window">
              ${seg('hours', '24', 'window.24h', true)}${seg('hours', '72', 'window.3d')}${seg('hours', '168', 'window.7d')}${seg('hours', '720', 'window.30d')}
            </fieldset>
            ${iconButton('search-open', 'search', 'search.open')}
            <button id="filters-open" type="button" class="text-btn" aria-haspopup="dialog" aria-expanded="false" aria-controls="filter-sheet">${s('filter.more')}</button>
          </div>
          <div id="search-line" class="search-line" hidden>
            <div class="search-field">${icon('search')}<input type="search" name="q" placeholder="${s('search.short')}" aria-label="${s('search')}" data-i18n-label="search" inputmode="search" enterkeyhint="search" autocapitalize="off" autocorrect="off" spellcheck="false"><button id="ask" type="button" class="ask-btn" hidden>${icon('sparkle')}${worded('span', 'ask.button')}</button><kbd id="palette-hint" class="kbd" hidden></kbd></div>
            <button id="search-cancel" type="button" class="text-btn quiet" data-i18n="search.cancel">${s('search.cancel')}</button>
          </div>
          <div id="tokens" class="tokens" hidden></div>
          <dialog id="filter-sheet" class="sheet" aria-labelledby="filter-title" tabindex="-1">
            <div class="sheet-head"><span class="handle"></span><button id="filter-clear" type="button" class="text-btn quiet" data-i18n="filter.clearAll">${s('filter.clearAll')}</button><h2 id="filter-title" data-i18n="filter.more">${s('filter.more')}</h2><button id="filter-done" type="button" class="text-btn" data-i18n="done" autofocus>${s('done')}</button></div>
            <div class="sheet-body">
              <div class="field">${worded('span', 'filter.view', 'class="label"')}<fieldset class="segset" role="radiogroup" aria-label="${s('filter.view')}" data-i18n-label="filter.view">${seg('view', 'mail', 'view.mail', true)}${seg('view', 'threads', 'view.threads')}</fieldset></div>
              <div class="field">${worded('span', 'filter.level', 'class="label"')}<fieldset class="segset" role="radiogroup" aria-label="${s('filter.level')}" data-i18n-label="filter.level">${seg('importance', '', 'filter.anyLevel', true)}${seg('importance', 'critical', 'level.critical')}${seg('importance', 'warning', 'level.warning')}${seg('importance', 'info', 'level.info')}</fieldset></div>
              <label class="field pick">${worded('span', 'filter.category', 'class="label"')}<select name="category">${option('', 'filter.anyCategory')}</select>${chevron}</label>
              <label class="field pick">${worded('span', 'filter.mailbox', 'class="label"')}<select name="account">${option('', 'filter.allMailboxes')}</select>${chevron}</label>
              <label class="switch">${worded('span', 'filter.spamOnly')}<input type="checkbox" name="spamOnly" role="switch"></label>
              <label class="switch">${worded('span', 'filter.pushedOnly')}<input type="checkbox" name="pushedOnly" role="switch"></label>
              <label class="switch">${worded('span', 'filter.codesOnly')}<input type="checkbox" name="codesOnly" role="switch"></label>
            </div>
          </dialog>
        </form>
        <section id="answer" class="answer" hidden></section>
        <section id="lane" class="lane" hidden></section>
        <section id="queue" class="queue" hidden></section>
        <section id="list"></section>
        <section id="digest" class="digest" hidden></section>
      </div>
      <aside id="pane" class="pane"><div id="pane-bar" class="pane-bar"></div><div class="pane-body"></div></aside>
    </main>
    <footer class="version"><span id="version">${escapeHtml(webVersion())}</span><span id="session-line"></span></footer>
    <button id="fresh-pill" type="button" class="fresh-pill" hidden></button>
    <dialog id="sheet" class="sheet reader" aria-labelledby="sheet-title">
      <div class="sheet-head"><span class="handle"></span>${iconButton('sheet-close', 'x', 'detail.close')}<span class="sheet-nav">${iconButton('sheet-prev', 'up', 'nav.prev')}${iconButton('sheet-next', 'down', 'nav.next')}</span></div>
      <div class="sheet-body"></div>
      <div id="sheet-bar" class="action-bar"></div>
    </dialog>
    <dialog id="health-sheet" class="sheet bare" aria-labelledby="health-title" tabindex="-1">
      ${sheetHead('health-title', 'mailboxes.title', 'health-done')}
      <div class="sheet-body"></div>
    </dialog>
    <dialog id="notify-sheet" class="sheet bare" aria-labelledby="notify-title" tabindex="-1">
      ${sheetHead('notify-title', 'notify.title', 'notify-done')}
      <div class="sheet-body"></div>
    </dialog>
    <dialog id="keys-sheet" class="sheet" aria-labelledby="keys-title" tabindex="-1">
      ${sheetHead('keys-title', 'keys.title', 'keys-done')}
      <div class="sheet-body"></div>
    </dialog>
    <dialog id="menu-sheet" class="sheet" aria-labelledby="menu-title" tabindex="-1">
      ${sheetHead('menu-title', 'menu.title', 'menu-done')}
      <div class="sheet-body"></div>
    </dialog>
    <dialog id="compose" class="sheet compose" aria-labelledby="compose-title">
      <div class="sheet-head"><span class="handle"></span><button id="compose-cancel" type="button" class="text-btn quiet" data-i18n="search.cancel">${s('search.cancel')}</button><h2 id="compose-title"></h2><button id="compose-send" type="button" class="text-btn strong">${icon('send')}${worded('span', 'compose.send')}</button></div>
      <div class="sheet-body">
        <form id="compose-form" autocomplete="off">
          <div id="compose-from" class="cfield" hidden>${worded('span', 'compose.from', 'class="label"')}<span id="compose-from-value" class="cvalue"></span></div>
          <label class="cfield">${worded('span', 'compose.to', 'class="label" id="compose-to-label"')}<input name="to" type="text" inputmode="email" autocapitalize="off" autocorrect="off" spellcheck="false" aria-labelledby="compose-to-label"><button id="compose-cc-toggle" type="button" class="text-btn quiet" data-i18n="compose.ccBcc">${s('compose.ccBcc')}</button></label>
          <label id="compose-cc-row" class="cfield" hidden>${worded('span', 'compose.cc', 'class="label"')}<input name="cc" type="text" inputmode="email" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
          <label id="compose-bcc-row" class="cfield" hidden>${worded('span', 'compose.bcc', 'class="label"')}<input name="bcc" type="text" inputmode="email" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
          <label class="cfield">${worded('span', 'compose.subject', 'class="label" id="compose-subject-label"')}<input name="subject" type="text" aria-labelledby="compose-subject-label">${iconButton('compose-attach', 'clip', 'compose.attach')}</label>
          <input id="compose-file" type="file" multiple hidden>
          <div id="compose-ai" class="compose-ai" hidden>
            <div class="ai-line">${icon('sparkle')}<input name="instruction" type="text" placeholder="${s('compose.aiHint')}" aria-label="${s('compose.aiHint')}" data-i18n-label="compose.aiHint" enterkeyhint="go"><button id="compose-draft" type="button" class="text-btn" data-i18n="compose.draft">${s('compose.draft')}</button></div>
            <div id="compose-chips" class="chips"></div>
          </div>
          <textarea name="text" rows="9" placeholder="${s('compose.body')}" aria-label="${s('compose.body')}" data-i18n-label="compose.body"></textarea>
          <div id="compose-sig" class="compose-sig" hidden></div>
          <ul id="compose-files" class="compose-files" aria-label="${s('compose.files')}" data-i18n-label="compose.files" hidden></ul>
          <p id="compose-pictures" class="compose-pictures" hidden></p>
          <p id="compose-lost" class="compose-lost" hidden></p>
          <details id="compose-quoted" class="quoted" hidden><summary data-i18n="compose.quoted">${s('compose.quoted')}</summary><pre></pre></details>
          <p id="compose-note" class="compose-note" role="status"></p>
        </form>
      </div>
    </dialog>
    <dialog id="palette" class="palette" aria-label="${s('palette.title')}" data-i18n-label="palette.title">
      <div class="palette-field">${icon('search')}<input id="palette-input" type="text" role="combobox" aria-controls="palette-list" aria-expanded="true" aria-autocomplete="list" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="${s('palette.hint')}"></div>
      <ul id="palette-list" class="palette-list" role="listbox"></ul>
    </dialog>
    <dialog id="lightbox" class="lightbox" aria-label="${s('lightbox.title')}" data-i18n-label="lightbox.title">
      ${iconButton('lightbox-close', 'x', 'detail.close')}
      <img alt="">
    </dialog>
    <dialog id="install-help" class="sheet install-help" aria-labelledby="install-title" tabindex="-1">
      <div class="sheet-head"><span class="handle"></span><h2 id="install-title" data-i18n="pwa.iosTitle">${s('pwa.iosTitle')}</h2><button id="install-close" type="button" class="text-btn" data-i18n="done">${s('done')}</button></div>
      <div class="sheet-body">
        <ol class="steps">
          <li><svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 15V4M8 8l4-4 4 4"/><path d="M6 11v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-8"/></svg>${worded('span', 'pwa.step1')}</li>
          <li><svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8v8M8 12h8"/></svg>${worded('span', 'pwa.step2')}</li>
        </ol>
        ${worded('p', 'pwa.iosHelp', 'class="muted"')}
        <button id="install-done" type="button" class="primary-action" data-i18n="pwa.done">${s('pwa.done')}</button>
      </div>
    </dialog>
    <div id="toast" class="toast" popover="manual" hidden></div>
    <div id="sending" class="toast sending" popover="manual" role="status" hidden></div>
    <div id="announce" class="sr-only" aria-live="polite"></div>
    ${iconSymbols()}
    <script nonce="${nonce}">` + clientScript() + `</script>`, nonce);
}

function page(lang: Language, title: string, body: string, nonce = ''): string {
  return '<!doctype html><html lang="' + lang + '"><head><meta charset="utf-8">'
    // viewport-fit=cover lets the page reach under a notch; the CSS then pads
    // it back with the safe-area insets, which is what an installed app needs.
    // Prevent iOS from zooming email text on double-tap or pinch. The interface
    // is responsive and all controls remain legible at the default scale.
    // interactive-widget keeps the on-screen keyboard from covering a field
    // inside a sheet on Android.
    + '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover,interactive-widget=resizes-content">'
    + '<meta name="referrer" content="no-referrer">'
    + '<meta name="apple-mobile-web-app-capable" content="yes">'
    + '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">'
    + '<meta name="apple-mobile-web-app-title" content="mailsift">'
    + '<meta name="mobile-web-app-capable" content="yes">'
    + '<link rel="manifest" href="/manifest.webmanifest">'
    + '<link rel="icon" type="image/png" href="/favicon.ico?v=3">'
    + '<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=3">'
    // One theme-color tag lets the saved theme choice drive the installed
    // app status bar immediately, including after a manual light/dark switch.
    + '<meta name="theme-color" content="' + LIGHT_BAR + '">'
    + '<title>' + title + '</title><style>' + styles() + '</style>'
    // Before the body renders, so a stored choice never flashes the other theme.
    + '<script nonce="' + nonce + '">' + themeBoot() + '</script>'
    + '</head><body>' + body + '</body></html>';
}

/**
 * The manifest that makes this installable to a home screen.
 *
 * `standalone` so it opens without browser chrome, and the theme colour is the
 * app's own header rather than the brand blue, so the status bar continues the
 * page instead of sitting on top of it. Worded per language, because the
 * shortcut names show up in the launcher.
 */
function manifest(lang: Language): string {
  return JSON.stringify({
    id: '/',
    name: 'mailsift',
    short_name: 'mailsift',
    description: t(lang, 'manifest.description'),
    lang,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    display_override: ['standalone'],
    categories: ['productivity', 'utilities'],
    background_color: LIGHT_BAR,
    theme_color: LIGHT_BAR,
    icons: [
      { src: '/icon-192.png?v=3', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png?v=3', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable.png?v=3', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    // A long press on the home-screen icon: the two things worth a shortcut.
    // The page reads these query parameters on boot.
    shortcuts: [
      { name: t(lang, 'shortcut.code'), url: '/?focus=code', icons: [{ src: '/icon-192.png?v=3', sizes: '192x192', type: 'image/png' }] },
      { name: t(lang, 'shortcut.critical'), url: '/?importance=critical', icons: [{ src: '/icon-192.png?v=3', sizes: '192x192', type: 'image/png' }] },
    ],
  });
}

/** Assets a browser fetches before it has a session, and which hold nothing private. */
const PUBLIC_ASSETS: Record<string, { body: string | Buffer; type: string; cache: string }> = {
  '/sw.js': { body: SERVICE_WORKER, type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
  '/icon-192.png': { body: icon192, type: 'image/png', cache: 'public, max-age=604800, immutable' },
  '/icon-512.png': { body: icon512, type: 'image/png', cache: 'public, max-age=604800, immutable' },
  '/icon-maskable.png': { body: maskable512, type: 'image/png', cache: 'public, max-age=604800, immutable' },
  '/apple-touch-icon.png': { body: appleTouch180, type: 'image/png', cache: 'public, max-age=604800, immutable' },
  '/favicon.ico': { body: favicon64, type: 'image/png', cache: 'public, max-age=604800, immutable' },
};

/** Six months. Long enough that a browser in regular use is never asked again. */
const SESSION_MAX_AGE = 180 * 24 * 60 * 60;

function sessionCookie(req: IncomingMessage, token: string, maxAge = SESSION_MAX_AGE): string {
  // Secure only when the request really arrived over TLS: setting it on plain
  // HTTP would make the cookie unusable behind a loopback-only setup.
  const https = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim() === 'https';
  // Lax, not Strict. Strict withholds the cookie on a navigation that starts
  // outside the site, which is exactly how an installed app launches from a
  // home screen and how a shared link opens, so it asked for the token again
  // for no gain. Lax still keeps the cookie off a POST another site starts,
  // and every route that changes something checks where its request came
  // from besides.
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
    + (https ? '; Secure' : '');
}

/**
 * Run the poll the refresh button asked for.
 *
 * The response carries the poller's own stats so the page can say how many new
 * messages it found. A poll reads mail and changes nothing in a mailbox.
 */
async function handleRefresh(
  store: StateStore, client: string, options: WebOptions,
): Promise<WebResponse> {
  const onRefresh = options.onRefresh;
  if (!onRefresh) return json(503, { error: 'refresh_unavailable' });
  if (!allowManualRefresh(client)) {
    return { ...json(429, { error: 'refresh_rate_limited' }), headers: { 'retry-after': '60' } };
  }
  try {
    const stats = await onRefresh();
    store.recordMcpAudit('web:refresh', client, true);
    return json(200, stats);
  } catch (error) {
    store.recordMcpAudit('web:refresh', client, false, error instanceof Error ? error.message : String(error));
    return json(502, { error: 'refresh_failed' });
  }
}

/** Sent with every response: never guess a content type, never send a referrer. */
const COMMON_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };

/**
 * Serve one non-MCP request.
 *
 * Returns the response rather than writing it, so routing and authorization
 * can be tested without a socket.
 */
export async function routeWeb(
  req: IncomingMessage,
  url: URL,
  token: string,
  store: StateStore,
  client = 'unknown',
  options: WebOptions = {},
): Promise<WebResponse> {
  const answer = await route(req, url, token, store, client, options);
  answer.headers = { ...COMMON_HEADERS, ...(answer.headers ?? {}) };
  return answer;
}

async function route(
  req: IncomingMessage,
  url: URL,
  token: string,
  store: StateStore,
  client: string,
  options: WebOptions,
): Promise<WebResponse> {
  const writeToken = options.writeToken ?? '';
  // One nonce per response: only the script that carries it runs.
  const nonce = randomBytes(16).toString('base64');
  const html = (status: number, body: string, shell = false): WebResponse => ({
    status, body, contentType: 'text/html; charset=utf-8',
    headers: {
      'content-security-policy': appPolicy(nonce),
      'x-frame-options': 'DENY',
      'cross-origin-opener-policy': 'same-origin',
      'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
      ...(shell ? { [SHELL_HEADER]: '1' } : {}),
    },
  });

  // Icons and the manifest carry nothing private, and a browser asks for them
  // before it has a session; refusing would leave the install without a mark.
  // The manifest is worded in the reader's language, because its shortcut
  // names appear in the launcher.
  if (url.pathname === '/manifest.webmanifest' && req.method === 'GET') {
    return {
      status: 200, body: manifest(pickLanguage(req)), contentType: 'application/manifest+json',
      // It differs by language, so no shared cache may hand one reader's copy to another.
      cacheControl: 'private, max-age=3600', headers: { vary: 'Accept-Language, Cookie' },
    };
  }
  const asset = PUBLIC_ASSETS[url.pathname];
  if (asset && req.method === 'GET') {
    return { status: 200, body: asset.body, contentType: asset.type, cacheControl: asset.cache };
  }

  const lang = pickLanguage(req);

  // With no token there is no credential to check, so the request has to have
  // come under one of this machine's own names (see localHost).
  if (!token && !localHost(req.headers.host)) {
    return {
      status: 421, contentType: 'text/plain; charset=utf-8',
      body: 'mailsift answers only to localhost while MCP_TOKEN is unset. Set MCP_TOKEN, or list this host name in MCP_ALLOWED_HOSTS.\n',
    };
  }
  // Nothing under these paths is an image, a stylesheet or a frame. A request
  // that says it is one was put there by a document, possibly a message.
  if ((url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth')) && embedded(req)) {
    return json(403, { error: 'not an embeddable resource', code: 'embedded' });
  }

  if (url.pathname === '/auth' && req.method === 'POST') {
    // Signing a browser in from another site's form would let that site pick
    // which credential the browser holds, a weaker one included.
    if (crossSite(req)) return html(403, renderLogin(lang, 'login.rejected', nonce));
    if (!allowAuthAttempt(client)) {
      return html(429, renderLogin(lang, 'login.tooMany', nonce));
    }
    let presented = '';
    try {
      presented = new URLSearchParams(await readBody(req)).get('token')?.trim() ?? '';
    } catch {
      return html(413, renderLogin(lang, 'login.tooLarge', nonce));
    }
    // Either credential signs in; which one it was decides what the session may do.
    const writes = writeToken !== '' && presented !== '' && tokenMatches(writeToken, presented);
    if (!writes && !tokenMatches(token, presented)) return html(401, renderLogin(lang, 'login.rejected', nonce));
    return { status: 303, body: '', contentType: 'text/html; charset=utf-8', cookie: sessionCookie(req, presented) };
  }

  const session = sessionOf(req, token, writeToken);

  // The form on its own address, so a read-only session can sign in again
  // with the credential that may act on mail.
  if (url.pathname === '/signin' && req.method === 'GET') {
    return html(200, renderLogin(lang, undefined, nonce, session !== 'none'));
  }

  if (session === 'none') {
    return url.pathname.startsWith('/api/')
      ? json(401, { error: 'unauthorized' })
      : html(401, renderLogin(lang, undefined, nonce));
  }

  // Every POST here changes something. One that another site started is
  // refused before it reaches a handler, whatever cookie came with it.
  if (req.method === 'POST' && crossSite(req)) {
    return json(403, { error: 'cross-site request refused', code: 'crossSite' });
  }

  if (url.pathname === '/' && req.method === 'GET') {
    const answer = html(200, renderApp(lang, Boolean(options.onRefresh), nonce), true);
    // Roll the session forward on each visit, so regular use never expires.
    // Only on the page: doing it on the polling calls would rewrite the cookie
    // every minute for nothing.
    const cookie = readCookie(req.headers.cookie, SESSION_COOKIE);
    if ((token || writeToken) && cookie) answer.cookie = sessionCookie(req, cookie);
    return answer;
  }
  if (url.pathname === '/mail-frame' && req.method === 'GET') {
    // The empty document a message is shown in. It is the same for every
    // message, so the browser may keep it; what differs is its policy.
    return {
      status: 200, body: MAIL_FRAME, contentType: 'text/html; charset=utf-8',
      cacheControl: 'private, max-age=86400',
      headers: {
        'content-security-policy': framePolicy(url.searchParams.get('images') === '1'),
        'x-frame-options': 'SAMEORIGIN',
      },
    };
  }
  if (url.pathname === '/auth/signout' && req.method === 'POST') {
    return { ...json(200, { signedOut: true }), cookie: sessionCookie(req, '', 0), cacheControl: 'no-store' };
  }
  if (url.pathname === '/api/events' && req.method === 'GET') {
    // The page's live line: one event when the stored mail changes, one when
    // a poll finishes. A hub that is full says so and the page falls back to
    // asking on a timer.
    if (!liveHub.hasRoom(client)) {
      return { ...json(503, { error: 'no room for another live stream', code: 'liveFull' }), cacheControl: 'no-store', headers: { 'retry-after': '120' } };
    }
    return {
      status: 200, body: '', contentType: 'text/event-stream; charset=utf-8',
      cacheControl: 'no-store, no-transform',
      headers: { 'x-accel-buffering': 'no' },
      stream: (channel) => {
        if (liveHub.attach(channel, client)) return;
        // Not taken on after all (the database would not open): say so and
        // end the response, so the page is not left holding a silent request.
        try { channel.write('event: full\ndata: {}\n\n'); } catch { /* already gone */ }
        channel.close();
      },
    };
  }
  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    const answer = await handleRefresh(store, client, options);
    answer.cacheControl = 'no-store';
    return answer;
  }

  const context: ActionContext = {
    session, backend: backendOf(options), lang, client, decorate,
    mayMark: session === 'write' || writeToken === '',
    credential: credentialMark(session === 'write' ? writeToken : token),
  };
  const acted = await routeActions(req, url, store, context);
  if (acted) return acted;

  if (url.pathname === '/api/attachments' && req.method === 'GET') {
    const answer = await handleAttachmentsApi(url.searchParams, store, client);
    answer.cacheControl = 'no-store';
    return answer;
  }
  if (url.pathname === '/api/safety' && req.method === 'GET') {
    const answer = await handleMailSafetyApi(url.searchParams, store, client);
    answer.cacheControl = 'no-store';
    return answer;
  }
  if (url.pathname === '/api/attachment' && req.method === 'GET') {
    const answer = await handleAttachmentApi(url.searchParams, store, client);
    answer.cacheControl = 'no-store';
    return answer;
  }
  if (url.pathname === '/api/attachment-scan' && req.method === 'GET') {
    const answer = await handleAttachmentScanApi(url.searchParams, store, client);
    answer.cacheControl = 'no-store';
    return answer;
  }
  if (url.pathname.startsWith('/api/') && req.method === 'GET') {
    const answer = await handleApi(url.pathname, url.searchParams, store, {
      session, options, lang, authRequired: Boolean(token || writeToken),
    });
    // Mail data is never a cache's to keep.
    answer.cacheControl = 'no-store';
    return answer;
  }
  return json(404, { error: 'not found' });
}
