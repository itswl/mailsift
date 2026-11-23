/**
 * The settings pages and the API behind them.
 *
 * Everything here needs an administrator session (a browser signed in with the
 * administrator password), except claiming the server with the one-time setup
 * code and the OAuth provider's redirect, which carries its own single-use
 * state. The MCP tokens never reach these routes: an agent holding the write
 * token may act on mail, not reconfigure the server.
 *
 * Secrets go one way. The page can set or clear one, and is told whether one
 * is set, never what it is. The single exception is a newly generated MCP
 * token, shown once in the answer that created it.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { ConfigError, mailboxAccount, PROVIDER_PRESETS, type AuthKind } from './config.js';
import {
  authorizedScope, authorizedUsernames, buildTokenRecord, exchangeCode, getOAuthProvider, TokenStore,
} from './imap/auth.js';
import { discoverMailboxFolders } from './imap/client.js';
import { imapErrorText } from './imap/connection.js';
import { getLogger } from './logger.js';
import { scopeAllowsSending } from './smtp.js';
import {
  ACCESS_TOKEN_KEYS, checkField, crossFieldProblems, FIELD_BY_KEY, SECRET_KEYS, words, type FieldProblem,
} from './settings-catalog.js';
import { renderClaimPage, renderSettingsPage } from './settings-page.js';
import { sendTestNotification } from './services/sink.js';
import { resolveLlmBaseUrl } from './services/triage.js';
import { aiGatewayHeaders } from './services/decider.js';
import {
  restartState, requestRestart, serverMode, supervised, type RestartOutcome,
} from './services/runtime-control.js';
import {
  applySettings, differsFromBoot, isOAuthProvider, mailboxReadiness,
} from './services/settings-runtime.js';
import {
  ADMIN_PASSWORD_MIN, adminPasswordSet, adminSessionValid, changeAdminPassword, claimAdmin, endOtherAdminSessions,
  newAccessToken, newMailboxId, passwordProblem, readSettings, savePendingOAuth, takePendingOAuth, updateSettings,
  type MailboxSettings, type PendingOAuth, type SettingsDocument,
} from './services/settings-store.js';
import { hostPort, requestChannel } from './web-access.js';
import { json, rateWindow, readCookie, readJson, type WebResponse } from './web-http.js';
import type { Language } from './web-strings.js';

const log = getLogger('settings');

export const ADMIN_COOKIE = 'mailsift_admin';
const ADMIN_MAX_AGE = 30 * 24 * 60 * 60;
/** Where the provider sends the browser when the page is not opened at a loopback address. */
const PASTE_REDIRECT = 'http://localhost:8765/';
const OAUTH_TTL_MS = 15 * 60_000;

const allowClaimPerClient = rateWindow(10);
const allowClaimOverall = rateWindow(60);
const allowTest = rateWindow(20);

export interface AdminContext {
  lang: Language;
  nonce: string;
  client: string;
  version: string;
  /** The signed-in administrator's session token, or '' for none. */
  admin: string;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** The request's administrator session, when it carries a valid one. */
export function adminSessionOf(req: IncomingMessage): string {
  const token = readCookie(req.headers.cookie, ADMIN_COOKIE);
  if (!token) return '';
  try {
    return adminSessionValid(token) ? token : '';
  } catch {
    return '';
  }
}

export function adminCookie(req: IncomingMessage, token: string, maxAge = ADMIN_MAX_AGE): string {
  const setting = (process.env.WEB_COOKIE_SECURE ?? 'auto').trim().toLowerCase();
  const secure = setting === 'true' || (setting !== 'false' && requestChannel(req) === 'https');
  return `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

const noStore = (answer: WebResponse): WebResponse => ({ ...answer, cacheControl: 'no-store' });
const ok = (value: unknown): WebResponse => noStore(json(200, value));
const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): WebResponse =>
  noStore(json(status, { error: message, code, ...extra }));

function htmlPage(body: string, nonce: string): WebResponse {
  return {
    status: 200,
    body,
    contentType: 'text/html; charset=utf-8',
    cacheControl: 'no-store',
    headers: {
      'content-security-policy': [
        "default-src 'none'", `script-src 'nonce-${nonce}'`, "style-src 'unsafe-inline'", "img-src 'self' data:",
        "connect-src 'self'", "manifest-src 'self'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
      ].join('; '),
      'x-frame-options': 'DENY',
      'cross-origin-opener-policy': 'same-origin',
    },
  };
}

const redirect = (location: string, cookie?: string): WebResponse => ({
  status: 303, body: '', contentType: 'text/html; charset=utf-8', cacheControl: 'no-store',
  headers: { location }, ...(cookie ? { cookie } : {}),
});

// ---------------------------------------------------------------------------
// What the page is shown
// ---------------------------------------------------------------------------

function safeMailbox(mailbox: MailboxSettings, authorized: ReadonlySet<string>): Record<string, unknown> {
  const oauth = isOAuthProvider(mailbox.provider);
  const scope = oauth ? authorizedScope(mailbox.username) : undefined;
  const auth = (PROVIDER_PRESETS as Record<string, { auth: AuthKind }>)[mailbox.provider]?.auth ?? 'password';
  return {
    id: mailbox.id,
    provider: mailbox.provider,
    username: mailbox.username,
    name: mailbox.name ?? '',
    host: mailbox.host ?? '',
    port: mailbox.port ?? null,
    ssl: mailbox.ssl ?? true,
    folders: mailbox.folders ?? [],
    smtpHost: mailbox.smtpHost ?? '',
    smtpPort: mailbox.smtpPort ?? null,
    fromName: mailbox.fromName ?? '',
    authservId: mailbox.authservId ?? '',
    enabled: mailbox.enabled,
    oauth,
    hasPassword: Boolean(mailbox.password),
    readiness: mailboxReadiness(mailbox, authorized),
    // An Outlook authorization from before sending was asked for reads only.
    ...(oauth && scope !== undefined ? { canSend: scopeAllowsSending(auth, scope) } : {}),
  };
}

function statePayload(req: IncomingMessage, doc: SettingsDocument): Record<string, unknown> {
  const authorized = authorizedUsernames();
  const values: Record<string, string> = {};
  const secrets: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(doc.values)) {
    if (!FIELD_BY_KEY.has(key)) continue;
    if (SECRET_KEYS.has(key)) secrets[key] = Boolean(value);
    else values[key] = value;
  }
  return {
    mode: serverMode(),
    setupComplete: Boolean(doc.setupCompletedAt),
    restart: restartState(),
    supervised: supervised(),
    values,
    secrets,
    mailboxes: doc.mailboxes.map((mailbox) => safeMailbox(mailbox, authorized)),
    tokens: { read: Boolean(doc.values['MCP_TOKEN']), write: Boolean(doc.values['MCP_WRITE_TOKEN']) },
    oauthApps: {
      gmail: Boolean(doc.values['GMAIL_CLIENT_ID']),
      outlook: Boolean(doc.values['OUTLOOK_CLIENT_ID']),
    },
    channel: requestChannel(req),
    timeZone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

// ---------------------------------------------------------------------------
// Applying a change
// ---------------------------------------------------------------------------

type Applied = 'none' | RestartOutcome;

/**
 * After a save: during setup nothing is running that read the old values,
 * so they are applied in place; afterwards a restart applies them, and only
 * when what the service runs on actually changed.
 */
function apply(doc: SettingsDocument, reason: string): Applied {
  const authorized = authorizedUsernames();
  if (serverMode() === 'setup') {
    applySettings(doc, authorized);
    return 'none';
  }
  if (!differsFromBoot(doc, authorized)) return restartState().pending ? 'scheduled' : 'none';
  return requestRestart(reason);
}

function fieldErrors(problems: FieldProblem[], lang: Language): Record<string, string> {
  return Object.fromEntries(problems.map((problem) => [problem.key, words(problem.message, lang)]));
}

/**
 * The values a save or a test would leave, from the page's changes: a string
 * sets a value ('' resets it to the default), null clears it. A secret left
 * out keeps what is stored.
 */
function mergeValues(
  current: Record<string, string>, changes: unknown, lang: Language,
): { values: Record<string, string>; errors: Record<string, string> } {
  const values = { ...current };
  const problems: FieldProblem[] = [];
  if (changes && typeof changes === 'object' && !Array.isArray(changes)) {
    for (const [key, raw] of Object.entries(changes as Record<string, unknown>).slice(0, 200)) {
      const field = FIELD_BY_KEY.get(key);
      if (!field) {
        problems.push({ key, message: { en: 'Not a setting.', zh: '不是可设置的项。' } });
        continue;
      }
      if (raw === null) {
        delete values[key];
        continue;
      }
      if (typeof raw !== 'string') {
        problems.push({ key, message: { en: 'Not a valid value.', zh: '值无效。' } });
        continue;
      }
      if (field.type === 'secret' && raw.trim() === '') continue;
      const checked = checkField(field, raw);
      if ('problem' in checked) problems.push({ key, message: checked.problem });
      else if (checked.value === '') delete values[key];
      else values[key] = checked.value;
    }
  }
  if (!problems.length) problems.push(...crossFieldProblems(values));
  return { values, errors: fieldErrors(problems, lang) };
}

// ---------------------------------------------------------------------------
// Mailboxes
// ---------------------------------------------------------------------------

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function portOf(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : Number.NaN;
}

/**
 * A mailbox from the page's form, on top of the stored one it edits. The
 * password is kept when the field was left empty, and dropped when the
 * mailbox moves to a provider that signs in with OAuth.
 */
function mailboxFrom(raw: unknown, existing: MailboxSettings | undefined): MailboxSettings {
  const m = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const provider = text(m['provider'], 40).toLowerCase();
  const typed = typeof m['password'] === 'string' ? (m['password'] as string).slice(0, 1000) : '';
  const password = isOAuthProvider(provider) ? '' : typed || existing?.password || '';
  const folders = Array.isArray(m['folders'])
    ? (m['folders'] as unknown[]).filter((f): f is string => typeof f === 'string').map((f) => f.trim().slice(0, 300)).filter(Boolean).slice(0, 100)
    : [];
  const mailbox: MailboxSettings = {
    id: existing?.id ?? newMailboxId(),
    provider,
    // Lower case throughout, so the address and its OAuth record always match.
    username: text(m['username'], 320).toLowerCase(),
    enabled: m['enabled'] !== false,
  };
  const set = <K extends keyof MailboxSettings>(key: K, value: MailboxSettings[K] | '' | undefined): void => {
    if (value !== '' && value !== undefined) mailbox[key] = value as MailboxSettings[K];
  };
  set('password', password);
  set('name', text(m['name'], 160));
  set('host', text(m['host'], 255));
  set('port', portOf(m['port']));
  if (m['ssl'] === false) mailbox.ssl = false;
  if (folders.length) mailbox.folders = folders;
  set('smtpHost', text(m['smtpHost'], 255));
  set('smtpPort', portOf(m['smtpPort']));
  set('fromName', text(m['fromName'], 160));
  set('authservId', text(m['authservId'], 255));
  return mailbox;
}

function mailboxProblem(mailbox: MailboxSettings, doc: SettingsDocument, lang: Language): string | undefined {
  const zh = lang === 'zh-CN';
  if (!(PROVIDER_PRESETS as Record<string, unknown>)[mailbox.provider]) return zh ? '请选择邮件服务商。' : 'Choose a provider.';
  const clash = doc.mailboxes.find((other) => other.id !== mailbox.id && other.username.toLowerCase() === mailbox.username.toLowerCase());
  if (clash) return zh ? '这个邮箱已经添加过了。' : 'This mailbox is already added.';
  try {
    mailboxAccount(mailbox);
    return undefined;
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : String(error);
    if (!zh) return message;
    if (/not an email address/.test(message)) return '请输入有效的邮箱地址。';
    if (/needs the IMAP server address/.test(message)) return '这个服务商需要填写 IMAP 服务器地址（在“服务器与发信”中）。';
    if (/enter the app password/.test(message)) return '请填写这个邮箱的应用专用密码（授权码）。';
    if (/port must be between/.test(message)) return '端口应为 1–65535 之间的整数。';
    if (/is not a server address/.test(message)) return '服务器地址格式不对。';
    return message;
  }
}

/** A connection failure in words the person at the page can act on. */
function connectionProblem(error: unknown, lang: Language): string {
  const zh = lang === 'zh-CN';
  const detail = imapErrorText(error);
  const lower = detail.toLowerCase();
  const failed = error && typeof error === 'object' && (error as { authenticationFailed?: boolean }).authenticationFailed;
  if (failed || /authenticat|login failed|invalid credentials|logon failure|\bno \[auth/.test(lower)) {
    return zh
      ? '服务器拒绝了登录。请检查邮箱地址和应用专用密码（授权码），并确认邮箱设置里已开启 IMAP。'
      : 'The server refused the sign-in. Check the address and the app password, and that IMAP is turned on in the mailbox\'s settings.';
  }
  if (/enotfound|eai_again|getaddrinfo/.test(lower)) {
    return zh ? '找不到这个服务器地址。' : 'That server address could not be found.';
  }
  if (/econnrefused|etimedout|timed out|timeout|ehostunreach|enetunreach|given up/.test(lower)) {
    return zh ? '无法连接到服务器。请检查服务器地址、端口和 SSL 设置。' : 'Could not reach the server. Check its address, port and SSL setting.';
  }
  if (/certificate|ssl|tls|self.signed/.test(lower)) {
    return zh ? '加密连接失败（证书或 SSL 设置不对）。' : 'The encrypted connection failed (certificate or SSL setting).';
  }
  if (/no authorization record|authorize this mailbox|has no authorization/.test(lower)) {
    return zh ? '请先登录授权这个邮箱。' : 'Sign in to this mailbox first.';
  }
  return detail.slice(0, 300) || (zh ? '连接失败。' : 'The connection failed.');
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

function oauthKind(provider: string): AuthKind | undefined {
  const auth = (PROVIDER_PRESETS as Record<string, { auth: AuthKind }>)[provider]?.auth;
  return auth === 'gmail_oauth' || auth === 'outlook_oauth' ? auth : undefined;
}

/** The provider settings as stored, so a client ID saved a moment ago is used before any restart. */
function oauthSource(doc: SettingsDocument): Record<string, string | undefined> {
  return { ...process.env, ...doc.values };
}

function sendingAsked(doc: SettingsDocument): boolean {
  return (doc.values['SMTP_ENABLED'] ?? process.env.SMTP_ENABLED ?? 'true').toLowerCase() !== 'false';
}

/** Back to the page's own origin, and only to an address of that shape. */
function returnOrigin(req: IncomingMessage): string {
  const host = String(req.headers.host ?? '').toLowerCase();
  if (!/^[a-z0-9.\-[\]:]+$/.test(host)) return '';
  return `${requestChannel(req) === 'https' ? 'https' : 'http'}://${host}`;
}

async function finishOAuth(pending: PendingOAuth, code: string, lang: Language): Promise<{ ok: true; applied: Applied } | { ok: false; message: string }> {
  const zh = lang === 'zh-CN';
  const doc = readSettings();
  const mailbox = doc.mailboxes.find((m) => m.id === pending.mailboxId);
  const auth = mailbox ? oauthKind(mailbox.provider) : undefined;
  if (!mailbox || !auth || mailbox.username !== pending.username) {
    return { ok: false, message: zh ? '这个邮箱已被修改或删除，请重新开始授权。' : 'The mailbox was changed or removed; start the sign-in again.' };
  }
  try {
    const provider = getOAuthProvider(auth, { send: sendingAsked(doc), source: oauthSource(doc) });
    const store = new TokenStore();
    const previous = await store.get(mailbox.username);
    const record = buildTokenRecord(await exchangeCode(provider, code, pending.redirectUri, pending.verifier), previous, pending.scope);
    await store.save(mailbox.username, record);
    log.info(`Authorized ${mailbox.provider} mailbox ${mailbox.id} from the settings page.`);
  } catch (error) {
    log.warn(`OAuth token exchange failed for mailbox ${mailbox.id}: ${error instanceof Error ? error.message : error}`);
    const detail = error instanceof Error ? error.message.slice(0, 240) : '';
    return { ok: false, message: (zh ? '换取授权令牌失败：' : 'The provider did not hand over a token: ') + detail };
  }
  return { ok: true, applied: apply(readSettings(), 'a mailbox was authorized') };
}

function callbackParams(raw: string): URLSearchParams | undefined {
  try {
    return new URL(raw.trim()).searchParams;
  } catch {
    // Some people paste only the part after "?".
    const query = raw.trim().replace(/^.*?\?/, '');
    return query.includes('state=') ? new URLSearchParams(query) : undefined;
  }
}

/**
 * The provider's redirect back to the page (`/?code=…&state=…`), when the
 * page was opened at a loopback address and the redirect URI could point at
 * it. Authenticated by the state, which only this server handed out and which
 * is used once; the browser may land here without the session cookie, because
 * localhost and 127.0.0.1 are different sites to it.
 */
export async function routeOAuthCallback(url: URL, lang: Language): Promise<WebResponse | undefined> {
  const state = url.searchParams.get('state') ?? '';
  if (!state || (!url.searchParams.has('code') && !url.searchParams.has('error'))) return undefined;
  const pending = takePendingOAuth(state);
  if (!pending) {
    return redirect('/settings?oauth=expired#mailboxes');
  }
  const back = `${pending.returnTo}/settings`;
  const error = url.searchParams.get('error');
  if (error) return redirect(`${back}?oauth=denied&mailbox=${pending.mailboxId}#mailboxes`);
  const result = await finishOAuth(pending, url.searchParams.get('code') ?? '', lang);
  if (!result.ok) return redirect(`${back}?oauth=failed&mailbox=${pending.mailboxId}#mailboxes`);
  return redirect(`${back}?oauth=ok&mailbox=${pending.mailboxId}#mailboxes`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testModel(values: Record<string, string>, lang: Language): Promise<{ ok: boolean; message: string }> {
  const zh = lang === 'zh-CN';
  if (!values['LLM_API_KEY']) return { ok: false, message: zh ? '请先填写 API Key。' : 'Enter an API key first.' };
  let base: string;
  try {
    base = resolveLlmBaseUrl(values);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const started = Date.now();
  try {
    const response = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${values['LLM_API_KEY']}`,
        'content-type': 'application/json',
        ...(values['AI_GATEWAY_ID'] ? { 'cf-aig-gateway-id': values['AI_GATEWAY_ID'] } : aiGatewayHeaders()),
      },
      body: JSON.stringify({
        model: values['LLM_MODEL'] || 'deepseek-flash',
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        max_tokens: 16,
      }),
      signal: AbortSignal.timeout(25_000),
    });
    const ms = Date.now() - started;
    if (!response.ok) {
      const body = (await response.text()).replace(values['LLM_API_KEY'], '[key]').slice(0, 200);
      return { ok: false, message: `HTTP ${response.status}${body ? `: ${body}` : ''}` };
    }
    return { ok: true, message: zh ? `模型已响应（${ms} 毫秒）。` : `The model answered in ${ms} ms.` };
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    const message = cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
    return { ok: false, message: (zh ? '请求失败：' : 'The request failed: ') + message.slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const PAGES = new Set(['/setup', '/settings']);

/** Thrown inside a settings transaction to leave the stored document as it was. */
class NotSaved extends Error {}

/**
 * Serve a settings page or API call, or return undefined for anything else.
 * Runs after the channel and cross-site checks of the web server.
 */
export async function routeAdmin(req: IncomingMessage, url: URL, ctx: AdminContext): Promise<WebResponse | undefined> {
  const path = url.pathname;
  const isPage = PAGES.has(path) && (req.method === 'GET' || req.method === 'HEAD');
  if (!isPage && !path.startsWith('/api/admin/')) return undefined;
  const lang = ctx.lang;
  const zh = lang === 'zh-CN';

  if (isPage) {
    if (!adminPasswordSet()) return htmlPage(renderClaimPage(lang, ctx.nonce, ctx.version), ctx.nonce);
    if (!ctx.admin) return redirect(`/signin?next=${encodeURIComponent(path + url.search)}`);
    const doc = readSettings();
    if (path === '/settings' && !doc.setupCompletedAt) return redirect('/setup');
    if (path === '/setup' && doc.setupCompletedAt) return redirect('/settings');
    return htmlPage(renderSettingsPage(lang, ctx.nonce, ctx.version, doc.setupCompletedAt ? 'settings' : 'setup'), ctx.nonce);
  }

  // Claiming the server: the only API call without a session.
  if (path === '/api/admin/claim' && req.method === 'POST') {
    if (adminPasswordSet()) return fail(409, 'claimed', zh ? '管理员密码已经设置过了。' : 'An administrator password is already set.');
    if (!allowClaimPerClient(ctx.client) || !allowClaimOverall('all')) {
      return { ...fail(429, 'rate_limited', zh ? '尝试次数过多，请一分钟后再试。' : 'Too many attempts. Wait a minute.'), headers: { 'retry-after': '60' } };
    }
    const body = await readJson(req, 4096);
    const code = text(body?.['code'], 64);
    const password = typeof body?.['password'] === 'string' ? body['password'] as string : '';
    const problem = passwordProblem(password);
    if (problem) {
      return fail(400, 'weak_password', zh ? `密码至少 ${ADMIN_PASSWORD_MIN} 个字符。` : `Use at least ${ADMIN_PASSWORD_MIN} characters.`);
    }
    const session = claimAdmin(code, password);
    if (!session) return fail(401, 'invalid_code', zh ? '设置码不正确或已失效。请查看服务日志中最新的设置码。' : 'That setup code is wrong or no longer valid. Use the latest one in the service log.');
    log.info('The administrator password was set with the one-time setup code.');
    return { ...ok({ claimed: true }), cookie: adminCookie(req, session) };
  }

  if (!ctx.admin) return fail(401, 'admin_required', zh ? '请用管理员密码登录。' : 'Sign in with the administrator password.');

  if (path === '/api/admin/state' && req.method === 'GET') {
    return ok(statePayload(req, readSettings()));
  }

  if (req.method !== 'POST') return fail(404, 'not_found', 'not found');
  const body = await readJson(req, 64 * 1024);
  if (!body) return fail(400, 'bad_json', zh ? '请求格式不对。' : 'The request was not understood.');

  switch (path) {
    case '/api/admin/settings': {
      // Merged inside the write transaction, so two tabs saving at once cannot drop each other's changes.
      let errors: Record<string, string> = {};
      let doc: SettingsDocument;
      try {
        doc = updateSettings((d) => {
          const merged = mergeValues(d.values, body['values'], lang);
          errors = merged.errors;
          if (Object.keys(errors).length) throw new NotSaved();
          d.values = merged.values;
        });
      } catch (error) {
        if (!(error instanceof NotSaved)) throw error;
        return fail(400, 'invalid', zh ? '有设置需要修改。' : 'Some settings need attention.', { errors });
      }
      const applied = apply(doc, 'settings were saved');
      return ok({ saved: true, applied, state: statePayload(req, doc) });
    }

    case '/api/admin/mailboxes/save': {
      const id = text(body['id'], 40);
      let problem: string | undefined;
      let saved: MailboxSettings | undefined;
      let doc: SettingsDocument;
      try {
        doc = updateSettings((d) => {
          const existing = id ? d.mailboxes.find((m) => m.id === id) : undefined;
          if (id && !existing) problem = zh ? '找不到这个邮箱。' : 'That mailbox no longer exists.';
          const mailbox = mailboxFrom(body['mailbox'], existing);
          problem ??= mailboxProblem(mailbox, d, lang);
          if (problem) throw new NotSaved();
          const index = d.mailboxes.findIndex((m) => m.id === mailbox.id);
          if (index >= 0) d.mailboxes[index] = mailbox;
          else d.mailboxes.push(mailbox);
          saved = mailbox;
        });
      } catch (error) {
        if (!(error instanceof NotSaved)) throw error;
        return fail(400, 'invalid_mailbox', problem ?? 'invalid');
      }
      const applied = apply(doc, 'a mailbox was saved');
      return ok({ saved: true, applied, mailbox: safeMailbox(saved!, authorizedUsernames()), state: statePayload(req, doc) });
    }

    case '/api/admin/mailboxes/delete': {
      const id = text(body['id'], 40);
      let removed: MailboxSettings | undefined;
      const doc = updateSettings((d) => {
        removed = d.mailboxes.find((m) => m.id === id);
        d.mailboxes = d.mailboxes.filter((m) => m.id !== id);
      });
      if (!removed) return fail(404, 'no_mailbox', zh ? '找不到这个邮箱。' : 'That mailbox no longer exists.');
      const gone = removed;
      // Its authorization goes with it, unless another entry signs in as the same address.
      if (isOAuthProvider(gone.provider) && !doc.mailboxes.some((m) => m.username.toLowerCase() === gone.username.toLowerCase())) {
        await new TokenStore().remove(gone.username).catch(() => undefined);
      }
      const applied = apply(doc, 'a mailbox was removed');
      return ok({ deleted: true, applied, state: statePayload(req, doc) });
    }

    case '/api/admin/mailboxes/test': {
      if (!allowTest(ctx.client)) return fail(429, 'rate_limited', zh ? '测试太频繁，请稍后再试。' : 'Too many tests; wait a moment.');
      const current = readSettings();
      const id = text(body['id'], 40);
      const existing = id ? current.mailboxes.find((m) => m.id === id) : undefined;
      const mailbox = mailboxFrom(body['mailbox'] ?? existing, existing);
      const problem = mailboxProblem(mailbox, { ...current, mailboxes: current.mailboxes.filter((m) => m.id !== mailbox.id) }, lang);
      if (problem) return fail(400, 'invalid_mailbox', problem);
      if (isOAuthProvider(mailbox.provider) && !authorizedUsernames().has(mailbox.username.toLowerCase())) {
        return fail(400, 'needs_authorization', zh ? '请先登录授权这个邮箱，再测试连接。' : 'Sign in to this mailbox before testing it.');
      }
      try {
        const account = mailboxAccount(mailbox);
        const folders = await discoverMailboxFolders(account, { interactive: true });
        return ok({
          connected: true,
          folders: folders.filter((f) => f.selectable).map((f) => ({ path: f.path, specialUse: f.specialUse })),
        });
      } catch (error) {
        return fail(400, 'connection_failed', connectionProblem(error, lang));
      }
    }

    case '/api/admin/oauth/start': {
      const doc = readSettings();
      const mailbox = doc.mailboxes.find((m) => m.id === text(body['id'], 40));
      const auth = mailbox ? oauthKind(mailbox.provider) : undefined;
      if (!mailbox || !auth) return fail(400, 'not_oauth', zh ? '这个邮箱不使用 OAuth 登录。' : 'This mailbox does not sign in with OAuth.');
      let provider;
      try {
        provider = getOAuthProvider(auth, { send: sendingAsked(doc), source: oauthSource(doc) });
      } catch (error) {
        return fail(400, 'oauth_not_configured', error instanceof Error ? error.message : String(error));
      }
      // At a loopback address the provider can send the browser straight back
      // here; anywhere else it lands on a page that does not load, whose
      // address is pasted back instead.
      const direct = requestChannel(req) === 'loopback';
      const redirectUri = direct ? `http://localhost:${hostPort(req.headers.host)}/` : PASTE_REDIRECT;
      const verifier = randomBytes(48).toString('base64url');
      const state = randomBytes(24).toString('base64url');
      savePendingOAuth(state, {
        mailboxId: mailbox.id, username: mailbox.username, verifier, redirectUri, scope: provider.scope,
        returnTo: returnOrigin(req), expiresAt: Date.now() + OAUTH_TTL_MS,
      });
      const params = new URLSearchParams({
        client_id: provider.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: provider.scope,
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        login_hint: mailbox.username,
      });
      if (provider.name === 'gmail') {
        // Without these Google hands out no refresh token on a repeat consent.
        params.set('access_type', 'offline');
        params.set('prompt', 'consent');
      }
      return ok({ url: `${provider.authorizeUrl}?${params}`, mode: direct ? 'direct' : 'paste', state, redirectUri });
    }

    case '/api/admin/oauth/finish': {
      const params = callbackParams(text(body['url'], 4000));
      const state = params?.get('state') ?? text(body['state'], 200);
      if (!params) return fail(400, 'bad_url', zh ? '请粘贴浏览器地址栏里的完整地址。' : 'Paste the complete address from the browser\'s address bar.');
      if (params.get('error')) {
        takePendingOAuth(state);
        return fail(400, 'denied', zh ? '授权被拒绝或已取消。' : 'The sign-in was declined or cancelled.');
      }
      const pending = takePendingOAuth(state);
      if (!pending) return fail(400, 'expired', zh ? '这次登录已过期，请重新点“登录”。' : 'This sign-in has expired. Start it again.');
      const code = params.get('code');
      if (!code) return fail(400, 'no_code', zh ? '地址里没有授权码。' : 'That address carries no authorization code.');
      const result = await finishOAuth(pending, code, lang);
      if (!result.ok) return fail(400, 'exchange_failed', result.message);
      return ok({ authorized: true, applied: result.applied, mailbox: pending.mailboxId, state: statePayload(req, readSettings()) });
    }

    case '/api/admin/test/notifications': {
      if (!allowTest(ctx.client)) return fail(429, 'rate_limited', zh ? '测试太频繁，请稍后再试。' : 'Too many tests; wait a moment.');
      const merged = mergeValues(readSettings().values, body['values'], lang);
      if (Object.keys(merged.errors).length) return fail(400, 'invalid', zh ? '有设置需要修改。' : 'Some settings need attention.', { errors: merged.errors });
      try {
        const delivered = await sendTestNotification(merged.values, lang);
        return ok({ delivered: true, message: delivered });
      } catch (error) {
        return fail(400, 'not_delivered', error instanceof Error ? error.message : String(error));
      }
    }

    case '/api/admin/test/model': {
      if (!allowTest(ctx.client)) return fail(429, 'rate_limited', zh ? '测试太频繁，请稍后再试。' : 'Too many tests; wait a moment.');
      const merged = mergeValues(readSettings().values, body['values'], lang);
      if (Object.keys(merged.errors).length) return fail(400, 'invalid', zh ? '有设置需要修改。' : 'Some settings need attention.', { errors: merged.errors });
      const result = await testModel(merged.values, lang);
      return result.ok ? ok({ ok: true, message: result.message }) : fail(400, 'model_failed', result.message);
    }

    case '/api/admin/tokens/rotate': {
      const kind = body['kind'];
      if (kind !== 'read' && kind !== 'write') return fail(400, 'bad_kind', 'kind must be read or write');
      const key = kind === 'read' ? 'MCP_TOKEN' : 'MCP_WRITE_TOKEN';
      const token = newAccessToken();
      const doc = updateSettings((d) => { d.values[key] = token; });
      log.info(`The MCP ${kind} token was replaced from the settings page.`);
      const applied = apply(doc, `the MCP ${kind} token was replaced`);
      return ok({ token, applied, state: statePayload(req, doc) });
    }

    case '/api/admin/password': {
      const current = typeof body['current'] === 'string' ? body['current'] as string : '';
      const next = typeof body['next'] === 'string' ? body['next'] as string : '';
      if (passwordProblem(next)) return fail(400, 'weak_password', zh ? `新密码至少 ${ADMIN_PASSWORD_MIN} 个字符。` : `Use at least ${ADMIN_PASSWORD_MIN} characters.`);
      if (!allowClaimPerClient(ctx.client)) return fail(429, 'rate_limited', zh ? '尝试次数过多，请一分钟后再试。' : 'Too many attempts. Wait a minute.');
      const session = changeAdminPassword(current, next);
      if (!session) return fail(401, 'wrong_password', zh ? '当前密码不正确。' : 'The current password is not right.');
      log.info('The administrator password was changed; other sessions were signed out.');
      return { ...ok({ changed: true }), cookie: adminCookie(req, session) };
    }

    case '/api/admin/sessions/end-others': {
      const ended = endOtherAdminSessions(ctx.admin);
      return ok({ ended });
    }

    case '/api/admin/setup/finish': {
      const current = readSettings();
      const authorized = authorizedUsernames();
      if (!current.mailboxes.some((m) => mailboxReadiness(m, authorized) === 'ready')) {
        return fail(400, 'no_mailbox', zh ? '至少需要一个可以连接的邮箱。' : 'Add at least one mailbox that is ready to check.');
      }
      const doc = updateSettings((d) => { d.setupCompletedAt ??= new Date().toISOString(); });
      const applied = requestRestart('setup was finished');
      return ok({ finished: true, applied, state: statePayload(req, doc) });
    }

    default:
      return fail(404, 'not_found', 'not found');
  }
}
