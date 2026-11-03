/**
 * Read-only web view of triage results.
 *
 * A browser surface over what the poller already stored: what arrived, how it
 * was judged and why. It does not open, alter or send mail. Every mailbox
 * operation in this service uses a read-only lock. On demand it can fetch a
 * single message body, selected MIME metadata, or one attachment, and persists
 * nothing.
 *
 * It shares the MCP server's port and token, because it shares that trust
 * boundary: whoever can read triage results over JSON-RPC can read them here.
 * Disabled unless WEB_UI_ENABLED=true, since a page a browser can reach is a
 * wider surface than a JSON-RPC endpoint and should be opted into.
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { loadConfig } from './config.js';
import { escapeHtml } from './html.js';
import {
  AttachmentNotFoundError, AttachmentTooLargeError, fetchAttachmentByMessageId,
  fetchAttachmentManifestByMessageId, fetchByMessageId, inspectMailSafety, scanAttachmentByMessageId,
} from './imap/client.js';
import { buildLink } from './links.js';
import { nextDigestAt, renderDigest, type DigestItem } from './services/digest.js';
import { CATEGORIES } from './services/triage.js';
import { HEARTBEAT_KEY, type PollStats } from './services/watcher.js';
import { clientScript, LANGUAGE_COOKIE, storeLanguageScript } from './web-client.js';
import { appleTouch180, favicon64, icon192, icon512, maskable512 } from './web-icons.js';
import { LIGHT_BAR, styles } from './web-styles.js';
import { isLanguage, LANGUAGES, t, type Language, type StringKey } from './web-strings.js';
import type { StateStore } from './services/state.js';

export const SESSION_COOKIE = 'mailsift_session';
export { LANGUAGE_COOKIE };
/** A live IMAP read can be slow on providers with poor search; do not hang a tab on it. */
const LIVE_FETCH_TIMEOUT_MS = 25_000;
const LIVE_ATTACHMENT_TIMEOUT_MS = 60_000;
const LIVE_SAFETY_TIMEOUT_MS = 25_000;
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
const authWindows = new Map<string, { startedAt: number; count: number }>();

export function allowAuthAttempt(client: string, now = Date.now()): boolean {
  const current = authWindows.get(client);
  if (!current || now - current.startedAt >= 60_000) {
    authWindows.set(client, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= AUTH_ATTEMPTS_PER_MINUTE) return false;
  current.count += 1;
  return true;
}

/**
 * Manual polls per client per minute.
 *
 * A poll opens every monitored IMAP connection, so a browser left on the page
 * must not be able to turn a held-down button into a mailbox hammer. A handful
 * is plenty for a person waiting on a verification code.
 */
const REFRESHES_PER_MINUTE = 6;
const refreshWindows = new Map<string, { startedAt: number; count: number }>();

export function allowManualRefresh(client: string, now = Date.now()): boolean {
  const current = refreshWindows.get(client);
  if (!current || now - current.startedAt >= 60_000) {
    refreshWindows.set(client, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= REFRESHES_PER_MINUTE) return false;
  current.count += 1;
  return true;
}

export function webUiEnabled(): boolean {
  return (process.env.WEB_UI_ENABLED ?? 'false').toLowerCase() === 'true';
}

export function webVersion(): string {
  const version = process.env.MAILSIFT_VERSION?.trim();
  if (!version) return 'dev';
  return version.startsWith('v') ? version : `v${version}`;
}

export interface WebResponse {
  status: number;
  body: string | Buffer;
  contentType: string;
  /** Set-Cookie value, when a request establishes a session. */
  cookie?: string;
  cacheControl?: string;
  headers?: Record<string, string>;
}

/**
 * What the page may do beyond reading what the poller stored.
 *
 * `onRefresh` is absent in the standalone MCP server, which has no watcher to
 * poll with; the button and the endpoint then stay out of the page entirely
 * rather than offering a control that can only fail.
 */
export interface WebOptions {
  onRefresh?: (() => Promise<PollStats>) | undefined;
}

const json = (status: number, value: unknown): WebResponse => ({
  status,
  body: JSON.stringify(value),
  contentType: 'application/json; charset=utf-8',
});

/** Constant-time comparison, so a wrong token cannot be found a character at a time. */
export function tokenMatches(expected: string, presented: string): boolean {
  if (!expected) return true;
  if (expected.length !== presented.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(presented));
}

export function readCookie(header: string | undefined, name: string): string {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

/** Whether this request may see triage data: a bearer token or an established session. */
export function authorized(req: IncomingMessage, token: string): boolean {
  if (!token) return true;
  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice('Bearer '.length)
    : '';
  if (bearer && tokenMatches(token, bearer)) return true;
  return tokenMatches(token, readCookie(req.headers.cookie, SESSION_COOKIE));
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
): Promise<WebResponse> {
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
      mail: mail.map((row) => {
        const provider = providerOf(row.account);
        // The provider travels with the link so the browser can word it in its own language.
        return { ...row, provider, link: buildLink(provider, row.account, row.messageId ?? '') };
      }),
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
    const addLink = (row: (typeof threads)[number]['latest']) => {
      const provider = providerOf(row.account);
      return { ...row, provider, link: buildLink(provider, row.account, row.messageId ?? '') };
    };
    return json(200, {
      count: threads.length,
      windowHours: intParam(params, 'hours', 24, 24 * 90),
      threads: threads.map((thread) => ({
        ...thread,
        latest: addLink(thread.latest),
        messages: thread.messages.map(addLink),
      })),
    });
  }

  if (path === '/api/summary') {
    const hours = intParam(params, 'hours', 24, 24 * 90);
    // When the poller last finished, so the page can say how fresh it is. The
    // standalone MCP server shares the database, so it can usually say too.
    return json(200, {
      ...store.summarize(hours),
      categories: CATEGORIES,
      accounts: accountLabels(),
      lastPollAt: store.getMeta(HEARTBEAT_KEY) ?? null,
      pollIntervalSeconds: Number(process.env.POLL_INTERVAL_SECONDS ?? 300),
    });
  }

  if (path === '/api/digest') {
    const items = store.peekDigest() as DigestItem[];
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
    });
  }

  if (path === '/api/message') {
    const messageId = params.get('id')?.trim();
    if (!messageId) return json(400, { error: 'id is required' });
    const found = store.getMail(messageId);
    if (!found) return json(404, { error: 'not found' });
    // Linked like a row of the list, so a message opened from a shared link
    // still offers the provider's own client.
    const provider = providerOf(found.account);
    const stored = { ...found, provider, link: buildLink(provider, found.account, found.messageId ?? '') };
    if (params.get('live') !== 'true') return json(200, { ...stored, body: null });

    const account = loadConfig().accounts.find((a) => a.username === stored.account);
    // Each failure carries a code as well as the message, so the browser can
    // word it in the reader's language while a JSON client still reads the text.
    if (!account) return json(409, { error: 'this mailbox is no longer configured', code: 'unconfigured' });
    try {
      const live = await Promise.race([
        fetchByMessageId(account, messageId),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), LIVE_FETCH_TIMEOUT_MS).unref()),
      ]);
      if (!live) return json(504, { error: 'the mailbox did not return this message in time', code: 'timeout' });
      return json(200, { ...stored, body: live.body.slice(0, LIVE_BODY_CHARS) });
    } catch (error) {
      const detail = String(error).slice(0, 200);
      return json(502, { error: `mailbox read failed: ${detail}`, code: 'readFailed', detail });
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
    return json(404, { error: 'mail record not found' });
  }
  const account = loadConfig().accounts.find((candidate) => candidate.username === stored.account);
  if (!account) {
    store.recordMcpAudit('web:list-attachments', client, false, target);
    return json(409, { error: 'mailbox is no longer configured', code: 'unconfigured' });
  }

  try {
    const timeout = Symbol('attachment lookup timeout');
    const found = await Promise.race([
      fetchAttachmentManifestByMessageId(account, stored.messageId),
      new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), LIVE_ATTACHMENT_TIMEOUT_MS).unref()),
    ]);
    if (found === timeout) {
      store.recordMcpAudit('web:list-attachments', client, false, target);
      return json(504, { error: 'the mailbox did not return attachment metadata in time', code: 'attachmentTimeout' });
    }
    store.recordMcpAudit('web:list-attachments', client, Boolean(found), target);
    if (!found) return json(404, { error: 'message not found in configured read-only folders' });
    return json(200, {
      folder: found.folder,
      attachments: found.manifest.items,
      truncated: found.manifest.truncated,
    });
  } catch (error) {
    store.recordMcpAudit('web:list-attachments', client, false, target);
    const detail = String(error).slice(0, 200);
    return json(502, { error: `mailbox attachment lookup failed: ${detail}`, code: 'attachmentFailed', detail });
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
      inspectMailSafety(account, stored.messageId),
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
    const detail = String(error).slice(0, 200);
    return json(502, { error: 'mail safety inspection failed: ' + detail, code: 'safetyFailed', detail });
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
    return json(404, { error: 'mail record not found' });
  }
  const account = loadConfig().accounts.find((candidate) => candidate.username === stored.account);
  if (!account) {
    store.recordMcpAudit('web:get-attachment', client, false, target);
    return json(409, { error: 'mailbox is no longer configured', code: 'unconfigured' });
  }

  try {
    const timeout = Symbol('attachment download timeout');
    const found = await Promise.race([
      fetchAttachmentByMessageId(account, stored.messageId, partId),
      new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), LIVE_ATTACHMENT_TIMEOUT_MS).unref()),
    ]);
    if (found === timeout) {
      store.recordMcpAudit('web:get-attachment', client, false, target);
      return json(504, { error: 'the mailbox did not return this attachment in time', code: 'attachmentTimeout' });
    }
    store.recordMcpAudit('web:get-attachment', client, Boolean(found), target);
    if (!found) return json(404, { error: 'message not found in configured read-only folders' });
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
    const detail = String(error).slice(0, 200);
    return json(502, { error: `attachment read failed: ${detail}`, code: 'attachmentFailed', detail });
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
    return json(404, { error: 'mail record not found' });
  }
  const account = loadConfig().accounts.find((candidate) => candidate.username === stored.account);
  if (!account) {
    store.recordMcpAudit('web:scan-attachment', client, false, target);
    return json(409, { error: 'mailbox is no longer configured', code: 'unconfigured' });
  }

  try {
    const timeout = Symbol('attachment scan timeout');
    const report = await Promise.race([
      scanAttachmentByMessageId(account, stored.messageId, partId),
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
    const detail = String(error).slice(0, 200);
    return json(502, { error: `attachment scan failed: ${detail}`, code: 'attachmentFailed', detail });
  }
}

function accountLabels(): Array<{ address: string; name: string }> {
  try {
    return loadConfig().accounts.map((a) => ({ address: a.username, name: a.name }));
  } catch {
    return [];
  }
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
 * browser history, proxy logs or a Referer header.
 */
export function renderLogin(lang: Language, error?: StringKey): string {
  const s = (key: StringKey): string => escapeHtml(t(lang, key));
  // The switch reloads here rather than rewording in place: there is nothing
  // on this page to lose, and the reload goes to GET / so a refused sign-in is
  // not posted a second time.
  return page(lang, s('login.title'), `
    <form method="post" action="/auth" class="login">
      <img class="brand-mark" src="/icon-192.png?v=3" alt="" aria-hidden="true">
      <h1>mailsift</h1>
      <p class="muted">${s('login.intro')}</p>
      <input type="text" name="user" value="mailsift" autocomplete="username" readonly aria-label="${s('login.account')}">
      <input type="password" name="token" autocomplete="current-password" placeholder="${s('login.token')}" enterkeyhint="go" autofocus>
      <button type="submit">${s('login.open')}</button>
      ${error ? '<p class="error" role="alert">' + s(error) + '</p>' : ''}
      <button type="button" id="lang" class="lang" aria-label="${s('lang.label')}">${s('lang.face')}</button>
      <p class="version">${escapeHtml(webVersion())}</p>
    </form>
    <script>${storeLanguageScript()}
    document.querySelector('#lang').onclick = () => { storeLanguage('${nextLanguage(lang)}'); location.replace('/'); };</script>`);
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

/**
 * The application shell. All content is built in the browser from the JSON API.
 *
 * The page's own words are rendered in the chosen language and tagged with
 * their key, so the switch can reword them in place instead of reloading and
 * losing the filters.
 */
export function renderApp(lang: Language, canRefresh = false): string {
  const s = (key: StringKey): string => escapeHtml(t(lang, key));
  const worded = (tag: string, key: StringKey, attrs = ''): string =>
    `<${tag}${attrs ? ' ' + attrs : ''} data-i18n="${key}">${s(key)}</${tag}>`;
  const option = (value: string, key: StringKey): string => worded('option', key, `value="${value}"`);
  // A radio styled as a word: the input stays in the form under its name, so
  // the query the page sends is built from the form exactly as before.
  const seg = (name: string, value: string, key: StringKey, checked = false): string =>
    `<label class="seg${checked ? ' on' : ''}"><input type="radio" name="${name}" value="${value}"${checked ? ' checked' : ''}>${worded('span', key)}</label>`;
  const chevron = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 6l6 6-6 6"/></svg>';
  // Icon-only, like the theme switch: the label lives in its title and in the
  // accessible name, and the arrow spins while a poll is running.
  const refresh = canRefresh
    ? `<button id="refresh" type="button" class="icon-btn" aria-label="${s('refresh.label')}" title="${s('refresh.label')}">`
      + '<svg class="refresh-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
      + '<path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 4v7h-7"/></svg></button>'
    : '';
  return page(lang, 'mailsift', `
    <header class="app-header">
      <div class="header-inner">
        <div class="brand"><img class="brand-mark" src="/icon-192.png?v=3" alt="" aria-hidden="true"><strong>mailsift</strong></div>
        <div class="header-actions">
          ${refresh}
          <button id="install" type="button" class="word-btn" data-i18n="pwa.install" hidden>${s('pwa.install')}</button>
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
          <p id="status" class="status" role="status" aria-live="polite"></p>
        </section>
        <form id="filters" class="controls" autocomplete="off">
          <div id="control-line" class="control-line">
            <fieldset class="window" role="radiogroup" aria-label="${s('filter.window')}" data-i18n-label="filter.window">
              ${seg('hours', '24', 'window.24h', true)}${seg('hours', '72', 'window.3d')}${seg('hours', '168', 'window.7d')}${seg('hours', '720', 'window.30d')}
            </fieldset>
            <button id="search-open" type="button" class="icon-btn" aria-label="${s('search.open')}" title="${s('search.open')}" data-i18n-label="search.open" data-i18n-title="search.open"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg></button>
            <button id="filters-open" type="button" class="text-btn" aria-haspopup="dialog" aria-expanded="false" aria-controls="filter-sheet">${s('filter.more')}</button>
          </div>
          <div id="search-line" class="search-line" hidden>
            <div class="search-field"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg><input type="search" name="q" placeholder="${s('search.short')}" aria-label="${s('search')}" data-i18n-label="search" inputmode="search" enterkeyhint="search" autocapitalize="off" autocorrect="off" spellcheck="false"></div>
            <button id="search-cancel" type="button" class="text-btn quiet" data-i18n="search.cancel">${s('search.cancel')}</button>
          </div>
          <div id="tokens" class="tokens" hidden></div>
          <dialog id="filter-sheet" class="sheet" aria-labelledby="filter-title">
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
        <section id="lane" class="lane" hidden></section>
        <section id="list"></section>
        <section id="digest" class="digest" hidden></section>
      </div>
      <aside id="pane" class="pane"><div class="pane-head"><button id="pane-close" type="button" class="text-btn quiet" data-i18n="detail.close" hidden>${s('detail.close')}</button></div><div class="pane-body"></div></aside>
    </main>
    <footer class="version">${escapeHtml(webVersion())}</footer>
    <dialog id="sheet" class="sheet" aria-labelledby="sheet-title">
      <div class="sheet-head"><span class="handle"></span><span></span><button id="sheet-done" type="button" class="text-btn" data-i18n="done">${s('done')}</button></div>
      <div class="sheet-body"></div>
    </dialog>
    <dialog id="install-help" class="sheet install-help" aria-labelledby="install-title">
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
    <div id="toast" class="toast" hidden></div>
    <div id="announce" class="sr-only" aria-live="polite"></div>
    <svg hidden aria-hidden="true" focusable="false">
      <symbol id="i-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></symbol>
      <symbol id="i-chevron" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></symbol>
      <symbol id="i-arrow" viewBox="0 0 24 24"><path d="M7 17L17 7M8 7h9v9"/></symbol>
    </svg>
    <script>` + clientScript() + `</script>`);
}

function page(lang: Language, title: string, body: string): string {
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
    + '<script>' + themeBoot() + '</script>'
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

/**
 * A service worker that caches nothing.
 *
 * It exists so the app is installable. Caching would be actively wrong here:
 * this is a live view of mailbox state, and a page showing yesterday's triage
 * is worse than no page at all.
 */
const SERVICE_WORKER = [
  "self.addEventListener('install', () => self.skipWaiting());",
  "self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));",
  "self.addEventListener('fetch', () => {});",
].join('\n');

/** Assets a browser fetches before it has a session, and which hold nothing private. */
const PUBLIC_ASSETS: Record<string, { body: string | Buffer; type: string; cache: string }> = {
  '/sw.js': { body: SERVICE_WORKER, type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
  '/icon-192.png': { body: icon192, type: 'image/png', cache: 'public, max-age=604800, immutable' },
  '/icon-512.png': { body: icon512, type: 'image/png', cache: 'public, max-age=604800, immutable' },
  '/icon-maskable.png': { body: maskable512, type: 'image/png', cache: 'public, max-age=604800, immutable' },
  '/apple-touch-icon.png': { body: appleTouch180, type: 'image/png', cache: 'public, max-age=604800, immutable' },
  '/favicon.ico': { body: favicon64, type: 'image/png', cache: 'public, max-age=604800, immutable' },
};

/** Read a small request body; anything larger than a token is refused outright. */
async function readBody(req: IncomingMessage, limit = 4096): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Six months. Long enough that a browser in regular use is never asked again. */
const SESSION_MAX_AGE = 180 * 24 * 60 * 60;

function sessionCookie(req: IncomingMessage, token: string): string {
  // Secure only when the request really arrived over TLS: setting it on plain
  // HTTP would make the cookie unusable behind a loopback-only setup.
  const https = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim() === 'https';
  // Lax, not Strict. Strict withholds the cookie on a navigation that starts
  // outside the site, which is exactly how an installed app launches from a
  // home screen and how a shared link opens, so it asked for the token again
  // for no gain: this surface has no route that changes anything, and signing
  // in still requires the token in the request body rather than a cookie.
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`
    + (https ? '; Secure' : '');
}

/**
 * Run the poll the refresh button asked for.
 *
 * The response carries the poller's own stats so the page can say how many new
 * messages it found. A poll can read mail but changes nothing, keeping this
 * route inside the same read-only boundary as the rest of the view.
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
  const html = (status: number, body: string): WebResponse => ({ status, body, contentType: 'text/html; charset=utf-8' });

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

  if (url.pathname === '/auth' && req.method === 'POST') {
    if (!allowAuthAttempt(client)) {
      return html(429, renderLogin(lang, 'login.tooMany'));
    }
    let presented = '';
    try {
      presented = new URLSearchParams(await readBody(req)).get('token')?.trim() ?? '';
    } catch {
      return html(413, renderLogin(lang, 'login.tooLarge'));
    }
    if (!tokenMatches(token, presented)) return html(401, renderLogin(lang, 'login.rejected'));
    return { status: 303, body: '', contentType: 'text/html; charset=utf-8', cookie: sessionCookie(req, presented) };
  }

  if (!authorized(req, token)) {
    return url.pathname.startsWith('/api/')
      ? json(401, { error: 'unauthorized' })
      : html(401, renderLogin(lang));
  }

  if (url.pathname === '/' && req.method === 'GET') {
    const answer = html(200, renderApp(lang, Boolean(options.onRefresh)));
    // Roll the session forward on each visit, so regular use never expires.
    // Only on the page: doing it on the polling calls would rewrite the cookie
    // every minute for nothing.
    const session = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (token && session) answer.cookie = sessionCookie(req, session);
    return answer;
  }
  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    const answer = await handleRefresh(store, client, options);
    answer.cacheControl = 'no-store';
    return answer;
  }
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
    return handleApi(url.pathname, url.searchParams, store);
  }
  return json(404, { error: 'not found' });
}
