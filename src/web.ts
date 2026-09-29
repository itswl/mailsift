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
import type { StateStore } from './services/state.js';

export const SESSION_COOKIE = 'mailsift_session';
/** A live IMAP read can be slow on providers with poor search; do not hang a tab on it. */
const LIVE_FETCH_TIMEOUT_MS = 25_000;
const LIVE_BODY_CHARS = 20_000;

export function webUiEnabled(): boolean {
  return (process.env.WEB_UI_ENABLED ?? 'false').toLowerCase() === 'true';
}

export interface WebResponse {
  status: number;
  body: string;
  contentType: string;
  /** Set-Cookie value, when a request establishes a session. */
  cookie?: string;
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
      <p class="muted">Enter the access token for this instance.</p>
      <input type="password" name="token" autocomplete="current-password" placeholder="token" autofocus>
      <button type="submit">Open</button>
      ${message ? '<p class="error">' + message + '</p>' : ''}
    </form>`);
}

/** The application shell. All content is built in the browser from the JSON API. */
export function renderApp(): string {
  return page('mailsift', `
    <header class="bar">
      <strong>mailsift</strong>
      <span id="totals" class="muted"></span>
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
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="referrer" content="no-referrer">'
    + '<title>' + title + '</title><style>' + styles() + '</style></head><body>'
    + body + '</body></html>';
}

function styles(): string {
  return `
:root{--bg:#fff;--fg:#111;--muted:#666;--line:#e5e5e5;--card:#fafafa;
--critical:#d33;--warning:#e08a00;--info:#3573d6}
@media(prefers-color-scheme:dark){:root{--bg:#15171a;--fg:#e8e8e8;--muted:#9aa0a6;
--line:#2a2e33;--card:#1c1f23}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 14px;border-bottom:1px solid var(--line)}
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

let timer;
filters.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(() => { load(); chrome(); }, 250);
});
load(); chrome();
setInterval(() => { load(); chrome(); }, 60000);
`;
}

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

function sessionCookie(req: IncomingMessage, token: string): string {
  // Secure only when the request really arrived over TLS: setting it on plain
  // HTTP would make the cookie unusable behind a loopback-only setup.
  const https = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim() === 'https';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`
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
): Promise<WebResponse> {
  const html = (status: number, body: string): WebResponse => ({ status, body, contentType: 'text/html; charset=utf-8' });

  if (url.pathname === '/auth' && req.method === 'POST') {
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

  if (url.pathname === '/' && req.method === 'GET') return html(200, renderApp());
  if (url.pathname.startsWith('/api/') && req.method === 'GET') {
    return handleApi(url.pathname, url.searchParams, store);
  }
  return json(404, { error: 'not found' });
}
