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
import { fetchByMessageId } from './imap/client.js';
import { buildLink } from './links.js';
import { renderDigest, type DigestItem } from './services/digest.js';
import { CATEGORIES } from './services/triage.js';
import { appleTouch180, favicon64, icon192, icon512, maskable512 } from './web-icons.js';
import type { StateStore } from './services/state.js';

export const SESSION_COOKIE = 'mailsift_session';
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
      mail: mail.map((row) => ({
        ...row,
        link: buildLink(providerOf(row.account), row.account, row.messageId ?? ''),
      })),
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
    if (!account) return json(409, { error: 'this mailbox is no longer configured' });
    try {
      const live = await Promise.race([
        fetchByMessageId(account, messageId),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), LIVE_FETCH_TIMEOUT_MS).unref()),
      ]);
      if (!live) return json(504, { error: 'the mailbox did not return this message in time' });
      return json(200, { ...stored, body: live.body.slice(0, LIVE_BODY_CHARS) });
    } catch (error) {
      return json(502, { error: `mailbox read failed: ${String(error).slice(0, 200)}` });
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
export function renderLogin(message = ''): string {
  return page('Sign in', `
    <form method="post" action="/auth" class="card login">
      <h1>mailsift</h1>
      <p class="muted">Enter the access token for this instance. Your browser can remember it.</p>
      <input type="text" name="user" value="mailsift" autocomplete="username" readonly aria-label="Account">
      <input type="password" name="token" autocomplete="current-password" placeholder="token" autofocus>
      <button type="submit">Open</button>
      ${message ? '<p class="error">' + message + '</p>' : ''}
    </form>`);
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

/** The application shell. All content is built in the browser from the JSON API. */
export function renderApp(): string {
  return page('mailsift', `
    <header class="bar">
      <strong>mailsift</strong>
      <span id="totals" class="muted"></span>
      <button id="theme" type="button" aria-label="Colour theme"></button>
    </header>
    <form id="filters" class="bar filters">
      <select name="hours">
        <option value="24">24h</option><option value="72">3d</option>
        <option value="168">7d</option><option value="720">30d</option>
      </select>
      <select name="importance">
        <option value="">any level</option>
        <option value="critical">critical</option>
        <option value="warning">warning</option>
        <option value="info">info</option>
      </select>
      <select name="category"><option value="">any category</option></select>
      <select name="account"><option value="">all mailboxes</option></select>
      <label class="check"><input type="checkbox" name="spamOnly"> spam</label>
      <label class="check"><input type="checkbox" name="pushedOnly"> notified</label>
      <input type="search" name="q" placeholder="search subject, sender, summary">
    </form>
    <main id="list" aria-live="polite"></main>
    <section id="digest" class="card"><h2>Waiting for the next digest</h2><pre id="digest-body"></pre></section>
    <script>` + clientScript() + `</script>`);
}

function page(title: string, body: string): string {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
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
#theme{margin-left:auto;font:inherit;font-size:17px;line-height:1;background:none;border:1px solid var(--line);
color:var(--fg);border-radius:8px;padding:5px 9px;cursor:pointer}
#theme:hover{background:var(--card)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;
padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
-webkit-text-size-adjust:100%;overscroll-behavior-y:contain}
.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 14px;border-bottom:1px solid var(--line)}
header.bar{position:sticky;top:0;z-index:2;background:var(--bg)}
/* A finger needs a bigger target than a mouse does. */
@media(pointer:coarse){.filters select,.filters input{min-height:38px}.row{padding:14px}}
.bar strong{font-size:16px}
.filters select,.filters input{background:var(--bg);color:var(--fg);border:1px solid var(--line);
border-radius:7px;padding:6px 8px;font:inherit}
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
.row .meta{margin-top:3px;display:flex;gap:6px;flex-wrap:wrap}
.dot{width:8px;height:8px;border-radius:50%;flex:none;align-self:center}
.critical{background:var(--critical)}.warning{background:var(--warning)}.info{background:var(--info)}
.chip{font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:1px 7px}
.detail{padding:12px 14px;background:var(--card);border-bottom:1px solid var(--line)}
.detail h3{margin:0 0 6px;font-size:15px}
.detail dl{margin:0 0 8px;display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:13px}
.detail dt{color:var(--muted)}
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
.error{color:var(--critical);font-size:13px}
`;
}

/**
 * Browser code.
 *
 * Every value that came from a message is written with textContent and never
 * as markup: subjects, sender names and summaries are attacker-controlled, and
 * this is the one place in the service that renders them into a document.
 * Written without template literals so the server template cannot interpolate it.
 */
function clientScript(): string {
  return `
const $ = (s) => document.querySelector(s);
const list = $('#list'), filters = $('#filters');
let open = null;

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

function detail(row) {
  const box = el('div', 'detail');
  box.appendChild(el('h3', null, row.subject || '(no subject)'));
  const dl = el('dl');
  const add = (k, v) => { if (!v) return; dl.appendChild(el('dt', null, k)); dl.appendChild(el('dd', null, v)); };
  add('From', (row.senderName ? row.senderName + ' ' : '') + '<' + (row.sender || '') + '>');
  add('Mailbox', (row.accountLabel || row.account) + ' · ' + (row.folder || ''));
  add('Judged', row.importance + ' by ' + row.decidedBy + (row.pushed ? ' · notified' : ''));
  add('Why', row.reason);
  add('Deadline', row.deadline);
  box.appendChild(dl);
  if (row.summary) box.appendChild(el('pre', null, row.summary));

  const actions = el('div', 'actions');
  if (row.link && row.link.url) {
    const a = el('a', null, row.link.label);
    a.href = row.link.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    actions.appendChild(a);
  }
  const full = el('button', null, 'Load full message');
  full.onclick = async () => {
    full.disabled = true; full.textContent = 'Reading the mailbox…';
    try {
      const r = await fetch('/api/message?live=true&id=' + encodeURIComponent(row.messageId || row.dedupKey));
      const d = await r.json();
      const pre = el('pre', null, r.ok ? (d.body || '(this message has no text body)') : (d.error || 'failed'));
      box.appendChild(pre);
      full.remove();
    } catch (e) {
      full.disabled = false; full.textContent = 'Load full message';
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
  top.appendChild(el('span', 'who', m.senderName || m.sender || 'unknown'));
  top.appendChild(el('span', 'when', when(m.mailDate || m.createdAt)));
  b.appendChild(top);
  b.appendChild(el('div', 'sum', m.summary || m.subject || ''));
  const meta = el('div', 'meta');
  if (m.category) meta.appendChild(el('span', 'chip', m.category));
  if (m.inSpam) meta.appendChild(el('span', 'chip', 'spam'));
  if (m.pushed) meta.appendChild(el('span', 'chip', 'notified'));
  b.appendChild(meta);
  b.onclick = () => {
    if (open && open.parentNode) open.remove();
    if (open && open.dataset.key === (m.dedupKey || '')) { open = null; return; }
    const d = detail(m); d.dataset.key = m.dedupKey || '';
    b.after(d); open = d;
  };
  return b;
}

async function load() {
  const r = await fetch('/api/mail?' + query().toString());
  if (r.status === 401) { location.reload(); return; }
  const d = await r.json();
  list.replaceChildren();
  open = null;
  if (!d.mail.length) { list.appendChild(el('p', 'card muted', 'Nothing matches these filters.')); return; }
  for (const m of d.mail) list.appendChild(rowOf(m));
}

async function chrome() {
  const p = new URLSearchParams(); p.set('hours', filters.hours.value);
  const s = await (await fetch('/api/summary?' + p.toString())).json();
  $('#totals').textContent = s.total + ' messages · ' + s.pushed + ' notified · ' + s.fromSpamFolder + ' from spam';
  if (!filters.category.dataset.filled) {
    for (const c of s.categories) filters.category.appendChild(new Option(c, c));
    for (const a of s.accounts) filters.account.appendChild(new Option(a.name, a.address));
    filters.category.dataset.filled = '1';
  }
  const g = await (await fetch('/api/digest')).json();
  $('#digest').hidden = g.pending === 0;
  $('#digest-body').textContent = g.preview;
}

// Three states rather than two: following the system is the sensible default,
// and a switch that cannot go back to it forces a choice the reader may not have.
const THEMES = ['auto', 'light', 'dark'];
const THEME_FACE = { auto: '\u25D0', light: '\u2600', dark: '\u263E' };
const THEME_NAME = { auto: 'Follow the system', light: 'Light', dark: 'Dark' };
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
    button.textContent = THEME_FACE[choice];
    button.title = THEME_NAME[choice];
    button.setAttribute('aria-label', 'Colour theme: ' + THEME_NAME[choice]);
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

  if (url.pathname === '/auth' && req.method === 'POST') {
    if (!allowAuthAttempt(client)) {
      return html(429, renderLogin('Too many attempts. Wait a minute and try again.'));
    }
    let presented = '';
    try {
      presented = new URLSearchParams(await readBody(req)).get('token')?.trim() ?? '';
    } catch {
      return html(413, renderLogin('That request was too large.'));
    }
    if (!tokenMatches(token, presented)) return html(401, renderLogin('That token was not accepted.'));
    return { status: 303, body: '', contentType: 'text/html; charset=utf-8', cookie: sessionCookie(req, presented) };
  }

  if (!authorized(req, token)) {
    return url.pathname.startsWith('/api/')
      ? json(401, { error: 'unauthorized' })
      : html(401, renderLogin());
  }

  if (url.pathname === '/' && req.method === 'GET') {
    const answer = html(200, renderApp());
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
