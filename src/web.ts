/**
 * Read-only web view of triage results.
 *
 * A browser surface over what the poller already stored: what arrived, how it
 * was judged and why. It does not open, alter or send mail. Every mailbox
 * operation in this service uses a read-only lock, and this view does not add
 * an exception; the one IMAP call it can make fetches a single body on demand
 * and persists nothing, exactly as the MCP resource already does.
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
import { fetchByMessageId } from './imap/client.js';
import { buildLink } from './links.js';
import { renderDigest, type DigestItem } from './services/digest.js';
import { CATEGORIES } from './services/triage.js';
import { appleTouch180, favicon64, icon192, icon512, maskable512 } from './web-icons.js';
import { isLanguage, LANGUAGES, STRINGS, t, type Language, type StringKey } from './web-strings.js';
import type { StateStore } from './services/state.js';

export const SESSION_COOKIE = 'mailsift_session';
/**
 * The language choice. A cookie, unlike the theme's localStorage, because the
 * server has to see it: the shell and the sign-in form are rendered here, and
 * a page that arrives in one language and switches after its script runs is
 * exactly the flash the theme code goes out of its way to avoid. It holds
 * nothing secret, so the browser may write it, and the server only ever maps
 * it onto a fixed list.
 */
export const LANGUAGE_COOKIE = 'mailsift_lang';
/** A year. A language is not a choice anyone wants to make twice. */
const LANGUAGE_MAX_AGE = 365 * 24 * 60 * 60;
/** A live IMAP read can be slow on providers with poor search; do not hang a tab on it. */
const LIVE_FETCH_TIMEOUT_MS = 25_000;
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

/** Browser code that records a language choice where the server sees it on the next request. */
function storeLanguageScript(): string {
  return `function storeLanguage(l){document.cookie='${LANGUAGE_COOKIE}='+l+'; Path=/; Max-Age=${LANGUAGE_MAX_AGE}; SameSite=Lax'}`;
}

function intParam(params: URLSearchParams, name: string, fallback: number, max: number): number {
  const raw = Number(params.get(name));
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.floor(raw), max);
}

function boolParam(params: URLSearchParams, name: string): boolean {
  return params.get(name) === 'true';
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
    const mail = store.queryMail({
      sinceHours: intParam(params, 'hours', 24, 24 * 90),
      ...(importance ? { importance } : {}),
      ...(category ? { category } : {}),
      ...(account ? { account } : {}),
      ...(search ? { search } : {}),
      spamOnly: boolParam(params, 'spamOnly'),
      pushedOnly: boolParam(params, 'pushedOnly'),
      limit: intParam(params, 'limit', 50, 200),
    });
    return json(200, {
      count: mail.length,
      mail: mail.map((row) => {
        const provider = providerOf(row.account);
        // The provider travels with the link so the browser can word it in its own language.
        return { ...row, provider, link: buildLink(provider, row.account, row.messageId ?? '') };
      }),
    });
  }

  if (path === '/api/summary') {
    const hours = intParam(params, 'hours', 24, 24 * 90);
    return json(200, { ...store.summarize(hours), categories: CATEGORIES, accounts: accountLabels() });
  }

  if (path === '/api/digest') {
    const items = store.peekDigest() as DigestItem[];
    return json(200, { pending: items.length, preview: renderDigest(items) });
  }

  if (path === '/api/message') {
    const messageId = params.get('id')?.trim();
    if (!messageId) return json(400, { error: 'id is required' });
    const stored = store.getMail(messageId);
    if (!stored) return json(404, { error: 'not found' });
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
    <form method="post" action="/auth" class="card login">
      <h1>mailsift <span class="version">${escapeHtml(webVersion())}</span></h1>
      <p class="muted">${s('login.intro')}</p>
      <input type="text" name="user" value="mailsift" autocomplete="username" readonly aria-label="${s('login.account')}">
      <input type="password" name="token" autocomplete="current-password" placeholder="${s('login.token')}" autofocus>
      <button type="submit">${s('login.open')}</button>
      ${error ? '<p class="error">' + s(error) + '</p>' : ''}
      <button type="button" id="lang" class="lang" aria-label="${s('lang.label')}">${s('lang.face')}</button>
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
    + "if(c==='dark'||c==='light')document.documentElement.dataset.theme=c;"
    + "var d=c==='dark'||(c!=='light'&&matchMedia('(prefers-color-scheme:dark)').matches);"
    + "var m=document.querySelector('meta[name=theme-color]');"
    + "if(m)m.setAttribute('content',d?'" + DARK_BAR + "':'" + LIGHT_BAR + "');}catch(e){}})();";
}

/**
 * The application shell. All content is built in the browser from the JSON API.
 *
 * The page's own words are rendered in the chosen language and tagged with
 * their key, so the switch can reword them in place instead of reloading and
 * losing the filters.
 */
export function renderApp(lang: Language): string {
  const s = (key: StringKey): string => escapeHtml(t(lang, key));
  const worded = (tag: string, key: StringKey, attrs = ''): string =>
    `<${tag}${attrs ? ' ' + attrs : ''} data-i18n="${key}">${s(key)}</${tag}>`;
  const option = (value: string, key: StringKey): string => worded('option', key, `value="${value}"`);
  return page(lang, 'mailsift', `
    <header class="bar">
      <strong>mailsift <span class="version">${escapeHtml(webVersion())}</span></strong>
      <span id="totals" class="muted"></span>
      <button id="lang" type="button" class="switch" aria-label="${s('lang.label')}">${s('lang.face')}</button>
      <button id="theme" type="button" class="switch" aria-label="${s('theme.title')}"></button>
    </header>
    <form id="filters" class="bar filters">
      <select name="hours">
        ${option('24', 'window.24h')}${option('72', 'window.3d')}
        ${option('168', 'window.7d')}${option('720', 'window.30d')}
      </select>
      <select name="importance">
        ${option('', 'filter.anyLevel')}
        ${option('critical', 'level.critical')}
        ${option('warning', 'level.warning')}
        ${option('info', 'level.info')}
      </select>
      <select name="category">${option('', 'filter.anyCategory')}</select>
      <select name="account">${option('', 'filter.allMailboxes')}</select>
      <label class="check"><input type="checkbox" name="spamOnly"> ${worded('span', 'spam')}</label>
      <label class="check"><input type="checkbox" name="pushedOnly"> ${worded('span', 'notified')}</label>
      <input type="search" name="q" placeholder="${s('search')}">
    </form>
    <main id="list" aria-live="polite"></main>
    <section id="digest" class="card">${worded('h2', 'digest.title')}<pre id="digest-body"></pre></section>
    <script>` + clientScript() + `</script>`);
}

function page(lang: Language, title: string, body: string): string {
  return '<!doctype html><html lang="' + lang + '"><head><meta charset="utf-8">'
    // viewport-fit=cover lets the page reach under a notch; the CSS then pads
    // it back with the safe-area insets, which is what an installed app needs.
    + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    + '<meta name="referrer" content="no-referrer">'
    // Painted behind the status bar when installed, so it should match the
    // page rather than announce itself: light and dark are given separately.
    + '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff">'
    + '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#15171a">'
    + '<meta name="apple-mobile-web-app-capable" content="yes">'
    + '<meta name="apple-mobile-web-app-title" content="mailsift">'
    + '<meta name="mobile-web-app-capable" content="yes">'
    + '<link rel="manifest" href="/manifest.webmanifest">'
    + '<link rel="icon" type="image/png" href="/favicon.ico">'
    + '<link rel="apple-touch-icon" href="/apple-touch-icon.png">'
    + '<meta name="theme-color" content="' + LIGHT_BAR + '">'
    + '<title>' + title + '</title><style>' + styles() + '</style>'
    // Before the body renders, so a stored choice never flashes the other theme.
    + '<script>' + themeBoot() + '</script>'
    + '</head><body>' + body + '</body></html>';
}

/** The dark palette, written once and used by both the media query and the override. */
const DARK_PALETTE = '--bg:#15171a;--fg:#e8e8e8;--muted:#9aa0a6;--line:#2a2e33;--card:#1c1f23';
export const LIGHT_BAR = '#ffffff';
export const DARK_BAR = '#15171a';

function styles(): string {
  return `
:root{color-scheme:light dark;--bg:#fff;--fg:#111;--muted:#666;--line:#e5e5e5;--card:#fafafa;
--critical:#d33;--warning:#e08a00;--info:#3573d6}
/* Follow the system unless a choice was made, and let that choice win either way. */
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){` + DARK_PALETTE + `}}
:root[data-theme=dark]{` + DARK_PALETTE + `}
:root[data-theme=light]{color-scheme:light}
:root[data-theme=dark]{color-scheme:dark}
/* The two header switches share one height: a 13px word and a 17px glyph on the same 17px line. */
.switch{font:inherit;font-size:13px;line-height:17px;background:none;border:1px solid var(--line);
color:var(--fg);border-radius:8px;padding:5px 9px;cursor:pointer}
.switch:hover{background:var(--card)}
#theme{font-size:17px}
/* The count fills the room between the brand and the switches and wraps inside
   it, so on a phone it takes a second line of text rather than pushing a
   switch onto a second row. */
#totals{flex:1 1 0;min-width:0}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;
padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
-webkit-text-size-adjust:100%;overscroll-behavior-y:contain}
.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 14px;border-bottom:1px solid var(--line)}
header.bar{position:sticky;top:0;z-index:2;background:var(--bg)}
/* A finger needs a bigger target than a mouse does. */
@media(pointer:coarse){.filters select,.filters input{min-height:38px}.row{padding:14px}}
.bar strong{font-size:16px}.version{color:var(--muted);font-size:11px;font-weight:400;white-space:nowrap}
.filters select,.filters input:not([type=checkbox]){background:var(--bg);color:var(--fg);
border:1px solid var(--line);border-radius:7px;padding:6px 8px;font:inherit}
.filters input[type=search]{flex:1;min-width:160px}
.check{display:flex;align-items:center;gap:4px;color:var(--muted);font-size:13px}
.muted{color:var(--muted);font-size:13px}
main{padding:0 0 24px}
.row{display:block;width:100%;text-align:left;background:none;border:0;border-bottom:1px solid var(--line);
padding:11px 14px;color:inherit;font:inherit;cursor:pointer}
.row:hover{background:var(--card)}
.row .top{display:flex;gap:8px;align-items:baseline}
.row .who{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:45%}
.row .when{margin-left:auto;color:var(--muted);font-size:12px;white-space:nowrap}
.row .sum{color:var(--fg);margin-top:2px}
/* Summaries quote URLs, message ids and hashes: unbroken runs with nowhere to
   wrap. Without this they push the row past the viewport and the whole page
   scrolls sideways. Applied to every container that renders message text, so a
   long run in a subject or an address cannot do it either. */
.row,.detail,.card{overflow-wrap:anywhere;min-width:0}
.row .meta{margin-top:3px;display:flex;gap:6px;flex-wrap:wrap}
.dot{width:8px;height:8px;border-radius:50%;flex:none;align-self:center}
.critical{background:var(--critical)}.warning{background:var(--warning)}.info{background:var(--info)}
.chip{font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:1px 7px}
.detail{padding:12px 14px;background:var(--card);border-bottom:1px solid var(--line)}
.detail h3{margin:0 0 6px;font-size:15px;overflow-wrap:anywhere}
.detail dl{margin:0 0 8px;display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:13px}
.detail dt{color:var(--muted)}
/* A dd carries a 40px inline start margin by default, which pushes the value
   out of its grid column. */
.detail dd{margin:0}
.detail pre{white-space:pre-wrap;word-break:break-word;margin:8px 0 0;font:13px/1.5 ui-monospace,monospace}
.actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.actions a,.actions button{font:inherit;font-size:13px;padding:6px 11px;border-radius:7px;
border:1px solid var(--line);background:var(--bg);color:var(--fg);text-decoration:none;cursor:pointer}
.card{margin:14px;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--card)}
.card h2{margin:0 0 8px;font-size:14px}
.card pre{white-space:pre-wrap;word-break:break-word;margin:0;font:12px/1.5 ui-monospace,monospace;color:var(--muted)}
.login{max-width:320px;margin:15vh auto}
.login input,.login button{width:100%;margin-top:8px;padding:9px;border-radius:7px;
border:1px solid var(--line);background:var(--bg);color:var(--fg);font:inherit}
/* Present so a password manager has an account to file the token under, but
   it is not a second thing to fill in. */
.login input[name=user]{color:var(--muted);cursor:default}
/* On the sign-in form the switch is a quiet word under the button, not a second button. */
.login .lang{width:auto;display:block;margin:14px auto 0;padding:0;border:0;background:none;
color:var(--muted);font-size:13px;cursor:pointer}
.login .lang:hover{color:var(--fg)}
.error{color:var(--critical);font-size:13px}
/* iOS Safari zooms editable controls smaller than 16px when they receive focus. */
@media(pointer:coarse){
  input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]),
  textarea,.filters select,.form-group select,#search-input,.filter-select{font-size:16px}
}
`;
}

/**
 * Browser code.
 *
 * Every value that came from a message is written with textContent and never
 * as markup: subjects, sender names and summaries are attacker-controlled, and
 * this is the one place in the service that renders them into a document.
 * Written without backticks of its own, so the server's template literal
 * interpolates only at its own marks.
 */
function clientScript(): string {
  return `
const $ = (s) => document.querySelector(s);
const list = $('#list'), filters = $('#filters');
let open = null;

// Every language travels with the page, so the switch needs no round trip.
const LANGUAGES = ${JSON.stringify(LANGUAGES)};
const STRINGS = ${JSON.stringify(STRINGS)};
let lang = STRINGS[document.documentElement.lang] ? document.documentElement.lang : 'en';
const t = (key) => STRINGS[lang][key];
function fill(key, vars) {
  let text = t(key);
  for (const name in vars) text = text.split('{' + name + '}').join(vars[name]);
  return text;
}
// A vocabulary value, worded when the table knows it and shown as stored when
// not: records written before the vocabulary existed may hold free-form labels.
const word = (prefix, value) => STRINGS[lang][prefix + value] || value || '';
${storeLanguageScript()}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}
function when(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const today = new Date().toDateString() === d.toDateString();
  return today ? pad(d.getHours()) + ':' + pad(d.getMinutes())
               : (d.getMonth() + 1) + '-' + pad(d.getDate());
}
function query() {
  const p = new URLSearchParams();
  for (const [k, v] of new FormData(filters)) if (v) p.set(k, v === 'on' ? 'true' : v);
  return p;
}

// The label is composed here from the provider rather than taken from the
// API, so it can be worded in the reader's language; in English it comes out
// as the same words links.ts uses.
function linkLabel(row) {
  const name = STRINGS[lang]['provider.' + row.provider];
  return name ? fill(row.link.exact ? 'link.openIn' : 'link.open', { name }) : row.link.label;
}
function failure(d) {
  return STRINGS[lang]['error.' + d.code] ? fill('error.' + d.code, { detail: d.detail || '' }) : (d.error || t('detail.failed'));
}

function detail(row) {
  const box = el('div', 'detail');
  box.appendChild(el('h3', null, row.subject || t('noSubject')));
  const dl = el('dl');
  const add = (k, v) => { if (!v) return; dl.appendChild(el('dt', null, t(k))); dl.appendChild(el('dd', null, v)); };
  add('detail.from', (row.senderName ? row.senderName + ' ' : '') + '<' + (row.sender || '') + '>');
  add('detail.mailbox', (row.accountLabel || row.account) + ' · ' + (row.folder || ''));
  add('detail.judged', fill('detail.judgedAs', { level: word('level.', row.importance), by: word('by.', row.decidedBy) })
    + (row.pushed ? ' · ' + t('notified') : ''));
  add('detail.why', row.reason);
  add('detail.deadline', row.deadline);
  box.appendChild(dl);
  if (row.summary) box.appendChild(el('pre', null, row.summary));

  const actions = el('div', 'actions');
  if (row.link && row.link.url) {
    const a = el('a', null, linkLabel(row));
    a.href = row.link.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    actions.appendChild(a);
  }
  const full = el('button', null, t('detail.load'));
  full.onclick = async () => {
    full.disabled = true; full.textContent = t('detail.loading');
    try {
      const r = await fetch('/api/message?live=true&id=' + encodeURIComponent(row.messageId || row.dedupKey));
      const d = await r.json();
      const pre = el('pre', null, r.ok ? (d.body || t('detail.noBody')) : failure(d));
      box.appendChild(pre);
      full.remove();
    } catch (e) {
      full.disabled = false; full.textContent = t('detail.load');
    }
  };
  actions.appendChild(full);
  box.appendChild(actions);
  return box;
}

function rowOf(m) {
  const b = el('button', 'row');
  const top = el('div', 'top');
  top.appendChild(el('span', 'dot ' + (m.importance || 'info')));
  top.appendChild(el('span', 'who', m.senderName || m.sender || t('unknownSender')));
  top.appendChild(el('span', 'when', when(m.mailDate || m.createdAt)));
  b.appendChild(top);
  b.appendChild(el('div', 'sum', m.summary || m.subject || ''));
  const meta = el('div', 'meta');
  if (m.category) meta.appendChild(el('span', 'chip', word('category.', m.category)));
  if (m.inSpam) meta.appendChild(el('span', 'chip', t('spam')));
  if (m.pushed) meta.appendChild(el('span', 'chip', t('notified')));
  b.appendChild(meta);
  b.dataset.key = m.dedupKey || '';
  b.onclick = () => {
    if (open && open.parentNode) open.remove();
    if (open && open.dataset.key === (m.dedupKey || '')) { open = null; return; }
    const d = detail(m); d.dataset.key = m.dedupKey || '';
    b.after(d); open = d;
  };
  return b;
}

// The last answers are kept so a language switch can reword the page from
// them instead of asking the server again.
let lastMail = null, lastSummary = null, lastDigest = null;

function render() {
  if (!lastMail) return;
  list.replaceChildren();
  open = null;
  if (!lastMail.length) { list.appendChild(el('p', 'card muted', t('empty'))); return; }
  for (const m of lastMail) list.appendChild(rowOf(m));
}

async function load() {
  const r = await fetch('/api/mail?' + query().toString());
  if (r.status === 401) { location.reload(); return; }
  lastMail = (await r.json()).mail;
  render();
}

function renderChrome() {
  const s = lastSummary, g = lastDigest;
  if (s) $('#totals').textContent = fill('totals', { total: s.total, pushed: s.pushed, spam: s.fromSpamFolder });
  if (g) { $('#digest').hidden = g.pending === 0; $('#digest-body').textContent = g.preview; }
}

async function chrome() {
  const p = new URLSearchParams(); p.set('hours', filters.hours.value);
  const s = await (await fetch('/api/summary?' + p.toString())).json();
  lastSummary = s;
  if (!filters.category.dataset.filled) {
    for (const c of s.categories) filters.category.appendChild(new Option(word('category.', c), c));
    for (const a of s.accounts) filters.account.appendChild(new Option(a.name, a.address));
    filters.category.dataset.filled = '1';
  }
  lastDigest = await (await fetch('/api/digest')).json();
  renderChrome();
}

// Three states rather than two: following the system is the sensible default,
// and a switch that cannot go back to it forces a choice the reader may not have.
const THEMES = ['auto', 'light', 'dark'];
const THEME_FACE = { auto: '\u25D0', light: '\u2600', dark: '\u263E' };
const dark = matchMedia('(prefers-color-scheme: dark)');

function readTheme() {
  try {
    const stored = localStorage.getItem('theme');
    return THEMES.includes(stored) ? stored : 'auto';
  } catch (e) { return 'auto'; }
}

function applyTheme(choice) {
  const root = document.documentElement;
  if (choice === 'auto') delete root.dataset.theme; else root.dataset.theme = choice;
  const isDark = choice === 'dark' || (choice === 'auto' && dark.matches);
  // The status bar of an installed app is painted from this, so a manual
  // choice has to move it too or the top of the screen keeps the other theme.
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', isDark ? '${DARK_BAR}' : '${LIGHT_BAR}');
  const button = document.querySelector('#theme');
  if (button) {
    const name = t('theme.' + choice);
    button.textContent = THEME_FACE[choice];
    button.title = name;
    button.setAttribute('aria-label', fill('theme.label', { name }));
  }
}

$('#theme').onclick = () => {
  const next = THEMES[(THEMES.indexOf(readTheme()) + 1) % THEMES.length];
  try { localStorage.setItem('theme', next); } catch (e) {}
  applyTheme(next);
};
// Following the system means following it as it changes, including the status bar.
dark.addEventListener('change', () => { if (readTheme() === 'auto') applyTheme('auto'); });
applyTheme(readTheme());

// Reword the page in place: the page's own words are tagged with their key,
// the vocabulary options are relabelled, and the lists are rebuilt from the
// last answers. The filters keep their values and the open message reopens.
function applyLanguage(next) {
  lang = next;
  document.documentElement.lang = next;
  for (const n of document.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
  filters.q.placeholder = t('search');
  for (const o of filters.category.options) if (o.value) o.text = word('category.', o.value);
  const button = $('#lang');
  button.textContent = t('lang.face');
  button.setAttribute('aria-label', t('lang.label'));
  applyTheme(readTheme());
  const openKey = open && open.dataset.key;
  render(); renderChrome();
  if (openKey) for (const row of list.children) if (row.dataset.key === openKey) { row.click(); break; }
}

$('#lang').onclick = () => {
  const next = LANGUAGES[(LANGUAGES.indexOf(lang) + 1) % LANGUAGES.length];
  storeLanguage(next);
  applyLanguage(next);
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

let timer;
filters.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(() => { load(); chrome(); }, 250);
});
load(); chrome();
setInterval(() => { if (!document.hidden) { load(); chrome(); } }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { load(); chrome(); } });
`;
}

/**
 * The manifest that makes this installable to a home screen.
 *
 * `standalone` so it opens without browser chrome, and the theme colour is the
 * app's own header rather than the brand blue, so the status bar continues the
 * page instead of sitting on top of it.
 */
function manifest(): string {
  return JSON.stringify({
    name: 'mailsift',
    short_name: 'mailsift',
    description: 'What arrived in your mailboxes, and how it was judged.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#ffffff',
    theme_color: '#2f6fd0',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
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
  '/manifest.webmanifest': { body: manifest(), type: 'application/manifest+json', cache: 'public, max-age=3600' },
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
): Promise<WebResponse> {
  const html = (status: number, body: string): WebResponse => ({ status, body, contentType: 'text/html; charset=utf-8' });

  // Icons and the manifest carry nothing private, and a browser asks for them
  // before it has a session; refusing would leave the install without a mark.
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
    const answer = html(200, renderApp(lang));
    // Roll the session forward on each visit, so regular use never expires.
    // Only on the page: doing it on the polling calls would rewrite the cookie
    // every minute for nothing.
    const session = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (token && session) answer.cookie = sessionCookie(req, session);
    return answer;
  }
  if (url.pathname.startsWith('/api/') && req.method === 'GET') {
    return handleApi(url.pathname, url.searchParams, store);
  }
  return json(404, { error: 'not found' });
}
