import { describe, expect, it } from 'vitest';
import './setup.js';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import {
  allowAuthAttempt, handleApi, LANGUAGE_COOKIE, languageFromHeader, readCookie, routeWeb, SESSION_COOKIE,
  tokenMatches, webUiEnabled, webVersion,
} from '../src/web.js';
import { buildLink } from '../src/links.js';
import { STRINGS, type StringKey } from '../src/web-strings.js';
import { clientScript } from '../src/web-client.js';
import { letterText } from '../src/web-actions.js';
import { attachmentFilename } from '../src/smtp.js';
import { Script } from 'node:vm';
import { clientAddress } from '../src/mcp.js';
import { StateStore } from '../src/services/state.js';
import { HEARTBEAT_KEY } from '../src/services/watcher.js';

function request(options: {
  method?: string; url?: string; headers?: Record<string, string>; body?: string;
} = {}): IncomingMessage {
  const stream = Readable.from(options.body ? [Buffer.from(options.body)] : []);
  return Object.assign(stream, {
    method: options.method ?? 'GET',
    url: options.url ?? '/',
    headers: options.headers ?? {},
  }) as unknown as IncomingMessage;
}

const url = (path: string): URL => new URL(path, 'http://127.0.0.1:8410');

function seeded(): StateStore {
  const state = new StateStore(':memory:');
  const rows: Array<[string, string, string, string, boolean, boolean]> = [
    ['k1', '<one@x>', 'critical', 'Security', true, false],
    ['k2', '<two@x>', 'info', 'Marketing', false, true],
    ['k3', '<three@x>', 'warning', 'Finance', true, false],
  ];
  for (const [key, messageId, importance, category, pushed, inSpam] of rows) {
    state.markSeen(key, 'me@qq.com', `subject ${key}`);
    state.recordOutcome(key, importance, pushed, {
      messageId, category, inSpam, sender: 'billing@vendor.com', senderName: 'Vendor',
      summary: `summary of ${key}`, reason: 'because', snippet: 'body text', folder: 'INBOX',
    });
  }
  return state;
}

const body = async (path: string, store: StateStore): Promise<Record<string, unknown>> => {
  const target = url(path);
  return JSON.parse((await handleApi(target.pathname, target.searchParams, store)).body) as Record<string, unknown>;
};

describe('exposure', () => {
  it('formats the configured version for the browser', () => {
    expect(webVersion()).toBe('dev');
    process.env.MAILSIFT_VERSION = '0.1.56';
    expect(webVersion()).toBe('v0.1.56');
    process.env.MAILSIFT_VERSION = 'v0.1.57';
    expect(webVersion()).toBe('v0.1.57');
  });

  it('is off unless explicitly enabled', () => {
    expect(webUiEnabled()).toBe(false);
    process.env.WEB_UI_ENABLED = 'true';
    expect(webUiEnabled()).toBe(true);
  });
});

describe('authorization', () => {
  it('refuses a page and an API call without the token', async () => {
    const store = seeded();
    expect((await routeWeb(request(), url('/'), 'secret', store)).status).toBe(401);
    expect((await routeWeb(request({ url: '/api/mail' }), url('/api/mail'), 'secret', store)).status).toBe(401);
  });

  it('accepts a bearer token or an established session', async () => {
    const store = seeded();
    const bearer = request({ headers: { authorization: 'Bearer secret' } });
    expect((await routeWeb(bearer, url('/'), 'secret', store)).status).toBe(200);
    const cookie = request({ headers: { cookie: `${SESSION_COOKIE}=secret` } });
    expect((await routeWeb(cookie, url('/'), 'secret', store)).status).toBe(200);
  });

  it('turns a posted token into a session cookie that a script cannot read', async () => {
    const store = seeded();
    const post = request({ method: 'POST', url: '/auth', body: 'token=secret' });
    const answer = await routeWeb(post, url('/auth'), 'secret', store);
    expect(answer.status).toBe(303);
    expect(answer.cookie).toContain('HttpOnly');
  });

  it('survives a launch that starts outside the site', async () => {
    // Strict withholds the cookie on exactly that navigation, which is how an
    // installed app opens from a home screen, so it asked for the token again
    // every time. Nothing here changes state, and signing in still needs the
    // token in the body rather than a cookie.
    const store = seeded();
    const answer = await routeWeb(request({ method: 'POST', url: '/auth', body: 'token=secret' }), url('/auth'), 'secret', store);
    expect(answer.cookie).toContain('SameSite=Lax');
    expect(answer.cookie).not.toContain('SameSite=Strict');
  });

  it('keeps the session for months, and rolls it forward on each visit', async () => {
    const store = seeded();
    const fresh = await routeWeb(request({ method: 'POST', url: '/auth', body: 'token=secret' }), url('/auth'), 'secret', store);
    expect(fresh.cookie).toContain(`Max-Age=${180 * 24 * 60 * 60}`);

    // Opening the app renews it, so a browser in regular use never expires.
    const visit = await routeWeb(
      request({ headers: { cookie: `${SESSION_COOKIE}=secret` } }), url('/'), 'secret', store,
    );
    expect(visit.status).toBe(200);
    expect(visit.cookie).toContain(`${SESSION_COOKIE}=secret`);
    expect(visit.cookie).toContain('Max-Age=');
  });

  it('does not rewrite the cookie on the polling calls', async () => {
    // The app polls every minute; renewing there would resend the header for nothing.
    const store = seeded();
    const poll = await routeWeb(
      request({ url: '/api/mail', headers: { cookie: `${SESSION_COOKIE}=secret` } }),
      url('/api/mail'), 'secret', store,
    );
    expect(poll.status).toBe(200);
    expect(poll.cookie).toBeUndefined();
  });

  it('gives a password manager an account to file the token under', async () => {
    // A lone password field is saved inconsistently, which is what left the
    // token being typed by hand on every new browser.
    const login = String((await routeWeb(request(), url('/'), 'secret', seeded())).body);
    expect(login).toContain('autocomplete="username"');
    expect(login).toContain('autocomplete="current-password"');
  });

  it('does not renew a session for a bearer client, which has no cookie', async () => {
    const store = seeded();
    const answer = await routeWeb(
      request({ headers: { authorization: 'Bearer secret' } }), url('/'), 'secret', store,
    );
    expect(answer.status).toBe(200);
    expect(answer.cookie).toBeUndefined();
  });

  it('marks the cookie Secure only when the request really arrived over TLS', async () => {
    const store = seeded();
    const plain = await routeWeb(request({ method: 'POST', url: '/auth', body: 'token=s' }), url('/auth'), 's', store);
    expect(plain.cookie).not.toContain('Secure');
    const tls = await routeWeb(
      request({ method: 'POST', url: '/auth', body: 'token=s', headers: { 'x-forwarded-proto': 'https' } }),
      url('/auth'), 's', store,
    );
    expect(tls.cookie).toContain('Secure');
  });

  it('rejects a wrong token without establishing anything', async () => {
    const store = seeded();
    const answer = await routeWeb(request({ method: 'POST', url: '/auth', body: 'token=wrong' }), url('/auth'), 'secret', store);
    expect(answer.status).toBe(401);
    expect(answer.cookie).toBeUndefined();
  });

  it('serves the app unauthenticated only when no token is configured', async () => {
    const store = seeded();
    expect((await routeWeb(request(), url('/'), '', store)).status).toBe(200);
  });

  it('compares tokens of differing length without throwing', () => {
    expect(tokenMatches('secret', 'sec')).toBe(false);
    expect(tokenMatches('secret', 'secret')).toBe(true);
    expect(tokenMatches('', 'anything')).toBe(true);
  });

  it('reads one cookie out of several', () => {
    expect(readCookie(`a=1; ${SESSION_COOKIE}=tok%20en; b=2`, SESSION_COOKIE)).toBe('tok en');
    expect(readCookie(undefined, SESSION_COOKIE)).toBe('');
  });
});

describe('exposure behind a proxy', () => {
  it('uses the socket address unless a proxy is declared', () => {
    const req = request({ headers: { 'x-real-ip': '9.9.9.9', 'cf-connecting-ip': '8.8.8.8' } });
    Object.defineProperty(req, 'socket', { value: { remoteAddress: '172.18.0.5' } });
    expect(clientAddress(req)).toBe('172.18.0.5');
  });

  it('reads the real client from the forwarded headers when one is declared', () => {
    // Behind a proxy every request shares the proxy's address, so a per-client
    // limit becomes one shared bucket and a single noisy caller locks everyone
    // else out, this operator's own browser included.
    process.env.TRUSTED_PROXY = 'true';
    const make = (headers: Record<string, string>): IncomingMessage => {
      const req = request({ headers });
      Object.defineProperty(req, 'socket', { value: { remoteAddress: '172.18.0.5' } });
      return req;
    };
    expect(clientAddress(make({ 'cf-connecting-ip': '8.8.8.8', 'x-real-ip': '9.9.9.9' }))).toBe('8.8.8.8');
    expect(clientAddress(make({ 'x-real-ip': '9.9.9.9' }))).toBe('9.9.9.9');
    expect(clientAddress(make({ 'x-forwarded-for': '7.7.7.7, 172.18.0.5' }))).toBe('7.7.7.7');
    expect(clientAddress(make({}))).toBe('172.18.0.5');
  });

  it('gives the sign-in route its own small budget', () => {
    const at = Date.parse('2026-09-29T00:00:00Z');
    expect(Array.from({ length: 10 }, (_, n) => allowAuthAttempt('guesser', at + n)).every(Boolean)).toBe(true);
    expect(allowAuthAttempt('guesser', at + 11)).toBe(false);
    // Another client is unaffected, and the window reopens.
    expect(allowAuthAttempt('someone-else', at + 11)).toBe(true);
    expect(allowAuthAttempt('guesser', at + 60_000)).toBe(true);
  });

  it('refuses a sign-in once the budget is spent, without checking the token', async () => {
    const store = seeded();
    const post = (): IncomingMessage => request({ method: 'POST', url: '/auth', body: 'token=secret' });
    for (let n = 0; n < 10; n += 1) await routeWeb(post(), url('/auth'), 'secret', store, 'flooder');
    const answer = await routeWeb(post(), url('/auth'), 'secret', store, 'flooder');
    expect(answer.status).toBe(429);
    expect(answer.cookie).toBeUndefined();
  });
});

describe('read-only data', () => {
  it('lists mail and applies every filter', async () => {
    const store = seeded();
    expect(await body('/api/mail', store)).toMatchObject({ count: 3 });
    expect(await body('/api/mail?importance=critical', store)).toMatchObject({ count: 1 });
    expect(await body('/api/mail?category=Finance', store)).toMatchObject({ count: 1 });
    expect(await body('/api/mail?pushedOnly=true', store)).toMatchObject({ count: 2 });
    expect(await body('/api/mail?spamOnly=true', store)).toMatchObject({ count: 1 });
    expect(await body('/api/mail?q=vendor', store)).toMatchObject({ count: 3 });
    expect(await body('/api/mail?q=nothing', store)).toMatchObject({ count: 0 });
    // The threads view honours the same switches, so turning one on there is not a no-op.
    expect(await body('/api/threads?spamOnly=true', store)).toMatchObject({ count: 1 });
    expect(await body('/api/threads?pushedOnly=true', store)).toMatchObject({ count: 2 });
  });

  it('bounds the window and the page size rather than trusting the query', async () => {
    const store = seeded();
    const huge = url('/api/mail?limit=99999&hours=-5');
    const answer = JSON.parse((await handleApi(huge.pathname, huge.searchParams, store)).body) as { count: number };
    expect(answer.count).toBe(3);
  });

  it('summarizes the window and offers the vocabularies the filters need', async () => {
    const store = seeded();
    const summary = await body('/api/summary', store);
    expect(summary).toMatchObject({ total: 3, pushed: 2, lastPollAt: null, pollIntervalSeconds: 300 });
    expect(summary['categories']).toContain('Security');
    // Once a poll has completed, the page can say how fresh the view is, and
    // judge staleness against the interval actually configured.
    store.setMeta(HEARTBEAT_KEY, '2026-11-02T08:00:00.000Z');
    process.env.POLL_INTERVAL_SECONDS = '900';
    expect(await body('/api/summary', store)).toMatchObject({ lastPollAt: '2026-11-02T08:00:00.000Z', pollIntervalSeconds: 900 });
  });

  it('carries each mailbox\'s own state, since the heartbeat vouches for none of them', async () => {
    process.env.MAIL_ACCOUNT_1 = 'gmail|me@gmail.com|pw';
    process.env.MAIL_ACCOUNT_1_NAME = 'work';
    const store = seeded();
    store.setMeta('account_fail_count:me@gmail.com', '4');
    store.setMeta('account_last_error:me@gmail.com', 'Error: invalid_grant');
    store.setMeta('account_last_success:me@gmail.com', '2026-11-01T01:14:00.000Z');
    const summary = await body('/api/summary', store);
    expect(summary['mailboxes']).toEqual([expect.objectContaining({
      name: 'work', address: 'me@gmail.com', failing: true, consecutiveFailures: 4, fix: 'google',
      lastSuccessAt: '2026-11-01T01:14:00.000Z',
    })]);
    expect(summary).toMatchObject({ outboxPending: 0 });
  });

  it('previews the digest queue', async () => {
    const store = seeded();
    store.queueDigest('k2', { subject: 'queued', importance: 'info', category: 'Marketing', threadCount: 1, date: '', summary: 'x', accountLabel: 'a', folder: 'INBOX', inSpam: false, from: 'f@x', fromName: 'F', deadline: '', actionRequired: false });
    const digest = await body('/api/digest', store);
    expect(digest).toMatchObject({ pending: 1, enabled: true });
    // The send time is an instant, so a browser in another timezone shows it in its own clock.
    expect(new Date(String(digest['nextAt'])).getHours()).toBe(9);
    // Structured items travel with the rendered text, so the page can lay the
    // queue out as a list rather than showing markdown source; each carries
    // its key so a line opens that message.
    expect(digest['items']).toEqual([expect.objectContaining({ subject: 'queued', category: 'Marketing', key: 'k2' })]);
    expect(digest['last']).toBeUndefined();
    store.recordDigestLog(new Date().toISOString(), [{ dedupKey: 'k1', payload: { subject: 'sent', fromName: 'S' } }]);
    expect(await body('/api/digest', store)).toMatchObject({ last: { count: 1, items: [expect.objectContaining({ key: 'k1' })] } });
    process.env.DIGEST_ENABLED = 'false';
    expect(await body('/api/digest', store)).toMatchObject({ enabled: false, nextAt: null });
  });

  it('returns a stored record without touching the mailbox unless asked', async () => {
    const store = seeded();
    const one = await body('/api/message?id=%3Cone%40x%3E', store);
    expect(one).toMatchObject({ messageId: '<one@x>', importance: 'critical', body: null });
    expect(await body('/api/message?id=%3Cabsent%40x%3E', store)).toMatchObject({ error: 'not found' });
  });

  it('links a message opened on its own like a row of the list', async () => {
    // A shared link opens a message outside the loaded window; it should still
    // offer the provider's client.
    process.env.MAIL_ACCOUNT_1 = 'gmail_pw|me@qq.com|pw';
    const one = await body('/api/message?id=%3Cone%40x%3E', seeded());
    expect(one).toMatchObject({ provider: 'gmail_pw', link: { exact: true } });
  });

  it('carries a verification code to the browser so the page can show it', async () => {
    const store = seeded();
    store.markSeen('k4', 'me@qq.com', '验证码邮件');
    store.recordOutcome('k4', 'warning', true, {
      messageId: '<code@x>', category: 'Security', summary: '收到验证码邮件。',
      verificationCode: '227857', folder: 'INBOX', sender: 'no-reply@cursor.sh',
    });
    const answer = await body('/api/mail?importance=warning', store);
    const row = (answer['mail'] as Array<Record<string, unknown>>).find((m) => m['messageId'] === '<code@x>');
    expect(row).toMatchObject({ verificationCode: '227857' });
    // The "only verification codes" switch sees only that row, in either view.
    expect(await body('/api/mail?codesOnly=true', store)).toMatchObject({ count: 1 });
    expect(await body('/api/threads?codesOnly=true', store)).toMatchObject({ count: 1 });
    // It also keeps verification mail whose code was never stored: filed before
    // codes were kept, or with a code that could not be extracted.
    store.markSeen('k5', 'me@qq.com', 'old code');
    store.recordOutcome('k5', 'warning', true, { messageId: '<old@x>', category: 'Security', summary: '收到验证码邮件。' });
    store.markSeen('k6', 'me@qq.com', 'unreadable code');
    store.recordOutcome('k6', 'warning', true, {
      messageId: '<unreadable@x>', category: 'Security', summary: '收到验证码邮件，但未能自动提取验证码。',
    });
    expect(await body('/api/mail?codesOnly=true', store)).toMatchObject({ count: 3 });
  });

  it('has no route that changes anything', async () => {
    const store = seeded();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const req = request({ method, url: '/api/mail', headers: { authorization: 'Bearer s' } });
      expect((await routeWeb(req, url('/api/mail'), 's', store)).status).toBe(404);
    }
  });
});

describe('rendering', () => {
  it('shows the running version at the bottom of each page', async () => {
    process.env.MAILSIFT_VERSION = '0.1.56';
    const page = String((await routeWeb(request(), url('/'), '', seeded())).body);
    expect(page).toContain('<strong>mailsift</strong>');
    expect(page).toContain('<footer class="version"><span id="version">v0.1.56</span>');
    const login = String((await routeWeb(request(), url('/'), 'secret', seeded())).body);
    expect(login).toContain('<h1>mailsift</h1>');
    expect(login).toContain('<p class="version">v0.1.56</p>');
  });

  it('builds every message value in the browser, never as server-side markup', async () => {
    // Subjects and sender names are attacker-controlled. The shell must carry
    // no message data at all, so there is nothing to escape wrongly.
    const store = seeded();
    store.markSeen('evil', 'me@qq.com', '<img src=x onerror=alert(1)>');
    store.recordOutcome('evil', 'info', false, { messageId: '<evil@x>', summary: '</script><script>alert(1)</script>' });
    const page = (await routeWeb(request(), url('/'), '', store)).body;
    expect(page).not.toContain('onerror=alert');
    expect(page).not.toContain('alert(1)');
    expect(page).toContain('textContent');
  });
});

describe('installable app', () => {
  it('serves the manifest and icons without a session, since a browser asks before it has one', async () => {
    const store = seeded();
    for (const path of ['/manifest.webmanifest', '/icon-192.png', '/icon-512.png',
      '/icon-maskable.png', '/apple-touch-icon.png', '/favicon.ico', '/sw.js']) {
      const answer = await routeWeb(request({ url: path }), url(path), 'secret', store);
      expect(answer.status, path).toBe(200);
      expect(answer.body.length, path).toBeGreaterThan(0);
    }
  });

  it('describes an app that opens without browser chrome, with a maskable icon', async () => {
    const store = seeded();
    const answer = await routeWeb(request({ url: '/manifest.webmanifest' }), url('/manifest.webmanifest'), '', store);
    const m = JSON.parse(String(answer.body)) as {
      id: string; display: string; display_override: string[]; icons: Array<{ purpose: string; sizes: string }>;
      shortcuts: Array<{ name: string; url: string }>;
    };
    expect(answer.contentType).toBe('application/manifest+json');
    expect(m.display).toBe('standalone');
    expect(m.id).toBe('/');
    expect(m.display_override).toEqual(['standalone']);
    expect(m.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512')).toBe(true);
    // A long press on the icon offers the two things worth a shortcut, worded in the reader's language.
    expect(m.shortcuts.map((s) => s.url)).toEqual(['/?focus=code', '/?importance=critical']);
    const zh = await routeWeb(
      request({ url: '/manifest.webmanifest', headers: { 'accept-language': 'zh-CN' } }), url('/manifest.webmanifest'), '', store,
    );
    expect((JSON.parse(String(zh.body)) as typeof m).shortcuts[0]?.name).toBe('最新验证码');
    // One URL, two bodies: no shared cache may hand one reader's language to another.
    expect(answer.cacheControl).toContain('private');
    expect(answer.headers?.['vary']).toContain('Accept-Language');
  });

  it('offers to install on a phone only, leaving a desk to the browser', async () => {
    const page = String((await routeWeb(request(), url('/'), '', seeded())).body);
    // The header carries no install word; the phone's offer is a line in the list.
    expect(page).not.toContain('id="install"');
    expect(page).not.toContain('#install{');
    expect(page).toContain("line.id = 'install-line'");
    expect(page).toContain('.install-line{display:none}');
  });

  it('lays the page out for a phone that installed it', async () => {
    const page = String((await routeWeb(request(), url('/'), '', seeded())).body);
    // A message opens in a sheet, the sentence sits over the list, and the
    // list itself is silent: one live region speaks for it.
    expect(page).toContain('<dialog id="sheet"');
    expect(page).toContain('<dialog id="health-sheet"');
    expect(page).toContain('id="health"');
    // Notifications and the mailboxes' health open as panels under their controls, which say
    // whether they are open; every sheet but the reader and the composer takes the focus itself.
    expect(page).toMatch(/<dialog id="notify-sheet" class="sheet bare"[^>]*tabindex="-1"/);
    expect(page).toMatch(/<dialog id="health-sheet" class="sheet bare"[^>]*tabindex="-1"/);
    expect(page).toContain('aria-controls="notify-sheet" aria-expanded="false"');
    expect(page).toContain('aria-controls="health-sheet" aria-expanded="false"');
    expect(page).toMatch(/<dialog id="filter-sheet"[^>]*tabindex="-1"/);
    expect(page).toContain('id="lede"');
    expect(page).toContain('id="announce"');
    expect(page).toContain('<section id="list"></section>');
    // Selects belong inside the filter sheet; the page itself shows words and segments.
    const sheetStart = page.indexOf('<dialog id="filter-sheet"');
    const sheetEnd = page.indexOf('</dialog>', sheetStart);
    expect(sheetStart).toBeGreaterThan(-1);
    let at = page.indexOf('<select');
    expect(at).toBeGreaterThan(-1);
    while (at !== -1) {
      expect(at).toBeGreaterThan(sheetStart);
      expect(at).toBeLessThan(sheetEnd);
      at = page.indexOf('<select', at + 1);
    }
    expect(page).toContain('interactive-widget=resizes-content');
    expect(page).not.toContain('innerHTML');
    // A link cut off mid-escape must not stop the script before it draws anything.
    expect(page).not.toContain('decodeURIComponent(location.hash');
  });

  it('sends real PNG bytes, not a placeholder', async () => {
    const store = seeded();
    const answer = await routeWeb(request({ url: '/icon-512.png' }), url('/icon-512.png'), '', store);
    const png = answer.body as Buffer;
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(512);
    expect(answer.cacheControl).toContain('immutable');
  });

  it('gives the status bar a colour for each scheme and reaches under a notch', async () => {
    const page = String((await routeWeb(request(), url('/'), '', seeded())).body);
    expect(page).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">');
    expect(page).toContain("getComputedStyle(document.documentElement).getPropertyValue('--bg')");
    expect(page).toContain("getComputedStyle(root).getPropertyValue('--bg')");
    expect(page).toContain('viewport-fit=cover');
    expect(page).toContain('apple-touch-icon');
    expect(page).toContain('safe-area-inset-top');
  });

  it('keeps only the empty shell in the worker, never mail', async () => {
    // The shell lets an installed app open with no network. A list of
    // yesterday's judgements served as today's would be worse than none, so
    // nothing under /api/ is ever stored or answered from the cache.
    const worker = String((await routeWeb(request({ url: '/sw.js' }), url('/sw.js'), '', seeded())).body);
    expect(worker).toContain("url.pathname !== '/'");
    expect(worker).toContain("request.mode !== 'navigate'");
    expect(worker).toContain("cache.put('/'");
    expect(worker).not.toContain('/api/');
    // Only the signed-in app is kept, never a sign-in form.
    expect(worker).toContain("response.headers.get('x-mailsift-shell') === '1'");
    const shell = await routeWeb(request(), url('/'), '', seeded());
    expect(shell.headers?.['x-mailsift-shell']).toBe('1');
    const login = await routeWeb(request(), url('/'), 'secret', seeded());
    expect(login.headers?.['x-mailsift-shell']).toBeUndefined();
  });

  it('shows a notification for every push, and opens the message it is about', async () => {
    const worker = String((await routeWeb(request({ url: '/sw.js' }), url('/sw.js'), '', seeded())).body);
    expect(worker).toContain("addEventListener('push'");
    expect(worker).toContain('showNotification');
    expect(worker).toContain("addEventListener('notificationclick'");
    expect(worker).toContain('setAppBadge');
  });
});

describe('colour theme', () => {
  const shell = async (): Promise<string> => String((await routeWeb(request(), url('/'), '', seeded())).body);

  it('offers a direct light and dark switch', async () => {
    const page = await shell();
    expect(page).toContain('id="theme"');
    expect(page).toContain("const THEMES = ['light', 'dark']");
    expect(page).not.toContain('theme.auto');
  });

  it('uses the selected palette without following the system', async () => {
    const page = await shell();
    expect(page).toContain(':root[data-theme=dark]{--bg:#0e1013');
    expect(page).toContain('--accent:#3358d4');
    expect(page).not.toContain('prefers-color-scheme');
  });

  it('applies the choice before the body renders', async () => {
    // Reading it afterwards would show the other theme for a frame, which is
    // the flash a manual switch exists to avoid.
    const page = await shell();
    const boot = page.indexOf("localStorage.getItem('theme')");
    expect(boot).toBeGreaterThan(-1);
    expect(boot).toBeLessThan(page.indexOf('<body>'));
  });

  it('moves the status bar colour with the choice, not just the page', async () => {
    // An installed app paints the status bar from this meta; leaving it behind
    // would keep the top of the screen in the other theme.
    const page = await shell();
    expect(page).toContain('<meta name="theme-color" content="#f4f5f7">');
    expect(page).toContain("if (meta && bg) meta.setAttribute('content', bg)");
  });

  it('defaults to light when there is no saved theme', async () => {
    expect(await shell()).toContain("if(c!=='dark'&&c!=='light')c='light'");
  });

  it('survives a browser that refuses storage', async () => {
    const page = await shell();
    expect(page).toContain("catch (e) { return 'light'; }");
  });
});

describe('layout', () => {
  it('wraps the unbroken runs that message text is full of', async () => {
    // A URL or a message id has nowhere to wrap, so without this the row grows
    // past the viewport and the whole page scrolls sideways on a phone.
    const page = String((await routeWeb(request(), url('/'), '', seeded())).body);
    expect(page).toContain('.row,.detail,.lane,.digest{overflow-wrap:anywhere;min-width:0}');
    expect(page).toContain('.detail h3{margin:0 0 6px;font-size:18px;line-height:1.3;font-weight:600;overflow-wrap:anywhere}');
  });

  it('keeps a definition value inside its own grid column', async () => {
    // dd carries a 40px inline start margin by default.
    expect(String((await routeWeb(request(), url('/'), '', seeded())).body)).toContain('.detail dd{margin:0}');
  });

  it('styles the version as quiet supporting text at the bottom', async () => {
    const page = String((await routeWeb(request(), url('/'), '', seeded())).body);
    expect(page).toContain('.version{color:var(--muted);font-size:11px;font-weight:400;white-space:nowrap}');
    expect(page).toContain('footer.version{text-align:center;padding:8px 14px 20px}');
    expect(page).toContain('.login .version{text-align:center;margin:14px 0 0}');
  });

  it('keeps both header switches on the first row of a phone', async () => {
    // At narrow widths the wordmark yields to the language and theme controls,
    // keeping the complete action row within the phone viewport.
    const page = String((await routeWeb(request(), url('/'), '', seeded())).body);
    expect(page).toContain('class="header-actions"');
    expect(page).toContain('@media(max-width:370px)');
    expect(page).toContain('.brand strong{display:none}');
    expect(page).toContain('html{touch-action:manipulation;background:var(--bg)}');
    expect(page).not.toContain('transform:translateY(-1px)');
  });
});

describe('language', () => {
  const shell = async (headers: Record<string, string> = {}): Promise<string> =>
    String((await routeWeb(request({ headers }), url('/'), '', seeded())).body);

  it('speaks English unless the browser asks for Chinese', async () => {
    const english = await shell();
    expect(english).toContain('<html lang="en">');
    expect(english).toContain('>any level<');
    const chinese = await shell({ 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' });
    expect(chinese).toContain('<html lang="zh-CN">');
    expect(chinese).toContain('>所有级别<');
    expect(chinese).not.toContain('>any level<');
  });

  it('ranks the header by weight and serves the first language it has', () => {
    expect(languageFromHeader(undefined)).toBe('en');
    expect(languageFromHeader('fr-FR,fr;q=0.9')).toBe('en');
    expect(languageFromHeader('en;q=0.5, zh;q=0.9')).toBe('zh-CN');
    // Japanese comes first but is not offered; Chinese is the first one that is.
    expect(languageFromHeader('ja, zh;q=0.8, en;q=0.7')).toBe('zh-CN');
    expect(languageFromHeader('zh-TW')).toBe('zh-CN');
    expect(languageFromHeader('en-GB,en;q=0.9,zh;q=0.8')).toBe('en');
  });

  it('lets a choice made with the switch beat the browser', async () => {
    const chosen = await shell({ 'accept-language': 'en', cookie: `${LANGUAGE_COOKIE}=zh-CN` });
    expect(chosen).toContain('<html lang="zh-CN">');
    // An unknown value is ignored rather than trusted.
    const junk = await shell({ 'accept-language': 'zh', cookie: `${LANGUAGE_COOKIE}=xx` });
    expect(junk).toContain('<html lang="zh-CN">');
  });

  it('words the sign-in form and its refusals too', async () => {
    const store = seeded();
    const headers = { 'accept-language': 'zh-CN' };
    const login = String((await routeWeb(request({ headers }), url('/'), 'secret', store)).body);
    expect(login).toContain('<title>登录</title>');
    expect(login).toContain('>进入<');
    expect(login).toContain('id="lang"');
    const refused = await routeWeb(
      request({ method: 'POST', url: '/auth', body: 'token=wrong', headers }), url('/auth'), 'secret', store,
    );
    expect(refused.status).toBe(401);
    expect(String(refused.body)).toContain('令牌不正确');
  });

  it('carries every language so the switch rewords the page in place, and tells the server', async () => {
    const page = await shell();
    expect(page).toContain('data-i18n="filter.anyLevel"');
    expect(page).toContain('"zh-CN":{');
    expect(page).toContain(`document.cookie='${LANGUAGE_COOKIE}='`);
    // In place rather than by reload, so the filters and the open message keep their place.
    expect(page).toContain('function applyLanguage');
    expect(page).not.toContain('location.reload(); }\n};');
  });

  it('has a Chinese word for every English one, and none left blank', () => {
    expect(Object.keys(STRINGS['zh-CN']).sort()).toEqual(Object.keys(STRINGS.en).sort());
    for (const [language, table] of Object.entries(STRINGS)) {
      for (const [key, value] of Object.entries(table)) expect(value.trim(), `${language} ${key}`).not.toBe('');
    }
  });

  it('words the provider link the way links.ts does, in English', () => {
    // The browser composes the label from the provider so it can be worded in
    // Chinese; in English the result must be the one the notification card shows.
    for (const provider of ['gmail', 'gmail_pw', 'outlook', 'qq', 'qq_biz', '163', '126', 'icloud']) {
      for (const messageId of ['<id@x>', '']) {
        const link = buildLink(provider, 'me@x', messageId);
        if (!link) continue;
        const name = STRINGS.en[`provider.${provider}` as StringKey];
        const composed = STRINGS.en[link.exact ? 'link.openIn' : 'link.open'].replace('{name}', name);
        expect(composed, `${provider} ${messageId}`).toBe(link.label);
      }
    }
  });

  it('sends the provider with each row so the browser can word the link', async () => {
    const answer = await body('/api/mail', seeded()) as { mail: Array<Record<string, unknown>> };
    expect(answer.mail[0]).toHaveProperty('provider');
  });

  it('names a live-read failure by a code the browser can word', async () => {
    // The one failure reachable without a mailbox: the record's account is no longer configured.
    process.env.MAIL_ACCOUNT_1 = 'qq|someone-else@qq.com|pw';
    const answer = await body('/api/message?id=%3Cone%40x%3E&live=true', seeded());
    expect(answer).toMatchObject({ code: 'unconfigured' });
    expect(STRINGS['zh-CN']['error.unconfigured']).toBeTruthy();
  });
});

describe('refresh', () => {
  const stats = {
    accountsOk: 2, accountsFailed: 0, fetched: 9, fresh: 2,
    pushed: 1, queued: 1, spamRescued: 0, failures: [] as string[],
  };
  const pageRequest = (): IncomingMessage =>
    request({ headers: { cookie: `${SESSION_COOKIE}=secret` } });
  const refreshRequest = (): IncomingMessage =>
    request({ method: 'POST', url: '/api/refresh', headers: { cookie: `${SESSION_COOKIE}=secret` } });

  it('leaves the button out when there is no poller to run', async () => {
    // The standalone MCP server has no watcher, so a button there could only fail.
    const store = seeded();
    const page = String((await routeWeb(pageRequest(), url('/'), 'secret', store)).body);
    expect(page).not.toContain('id="refresh"');
    const answer = await routeWeb(refreshRequest(), url('/api/refresh'), 'secret', store);
    expect(answer.status).toBe(503);
    expect(JSON.parse(String(answer.body))).toMatchObject({ error: 'refresh_unavailable' });
  });

  it('offers a button that asks the poller for new mail', async () => {
    const store = seeded();
    const onRefresh = async () => stats;
    const page = String((await routeWeb(pageRequest(), url('/'), 'secret', store, 'reader', { onRefresh })).body);
    expect(page).toContain('id="refresh"');
    // The poll narrates itself in the status line under the title, not in a toast.
    expect(page).toContain('id="status"');

    const answer = await routeWeb(refreshRequest(), url('/api/refresh'), 'secret', store, 'clicker-ok', { onRefresh });
    expect(answer.status).toBe(200);
    expect(answer.cacheControl).toBe('no-store');
    expect(JSON.parse(String(answer.body))).toMatchObject({ fresh: 2 });
    expect(store.listMcpAudit(10)).toContainEqual(
      expect.objectContaining({ action: 'web:refresh', client: 'clicker-ok', success: true }),
    );
  });

  it('requires a session like the rest of the view', async () => {
    const answer = await routeWeb(
      request({ method: 'POST', url: '/api/refresh' }), url('/api/refresh'), 'secret', seeded(), 'anon',
      { onRefresh: async () => stats },
    );
    expect(answer.status).toBe(401);
  });

  it('does not let a held-down button hammer the mailboxes', async () => {
    const store = seeded();
    const onRefresh = async () => stats;
    for (let n = 0; n < 6; n += 1) {
      const answer = await routeWeb(refreshRequest(), url('/api/refresh'), 'secret', store, 'clicker-flood', { onRefresh });
      expect(answer.status).toBe(200);
    }
    const refused = await routeWeb(refreshRequest(), url('/api/refresh'), 'secret', store, 'clicker-flood', { onRefresh });
    expect(refused.status).toBe(429);
    expect(refused.headers?.['retry-after']).toBe('60');
    expect(JSON.parse(String(refused.body))).toMatchObject({ error: 'refresh_rate_limited' });
  });

  it('reports a failed poll without pretending it fetched anything', async () => {
    const store = seeded();
    const failing = async (): Promise<never> => { throw new Error('imap down'); };
    const answer = await routeWeb(
      refreshRequest(), url('/api/refresh'), 'secret', store, 'clicker-fail', { onRefresh: failing },
    );
    expect(answer.status).toBe(502);
    expect(JSON.parse(String(answer.body))).toMatchObject({ error: 'refresh_failed' });
    expect(store.listMcpAudit(10)).toContainEqual(
      expect.objectContaining({ action: 'web:refresh', client: 'clicker-fail', success: false }),
    );
  });
});

describe('the composer', () => {
  const shell = async (headers: Record<string, string> = {}): Promise<string> =>
    String((await routeWeb(request({ headers }), url('/'), '', seeded())).body);

  /**
   * Declarations of the page script, run on their own. The script is written
   * with each top-level function closing on a line of its own, and each
   * top-level table on a "};" line, which is what lets one be lifted out.
   */
  function lifted<T>(names: string[], expose: string, context: Record<string, unknown> = {}): T {
    const script = clientScript();
    const parts = names.map((name) => {
      const plain = script.indexOf(`\nfunction ${name}(`);
      const fn = plain !== -1 ? plain : script.indexOf(`\nasync function ${name}(`);
      if (fn !== -1) return script.slice(fn, script.indexOf('\n}\n', fn) + 3);
      const constant = script.indexOf(`\nconst ${name} = `);
      expect(constant, name).toBeGreaterThan(-1);
      const table = script.slice(constant).match(/^\nconst \w+ = \{\n/);
      const end = table ? script.indexOf('\n};\n', constant) + 4 : script.indexOf(';\n', constant) + 2;
      return script.slice(constant, end);
    });
    return new Script(`${parts.join('\n')}\n(${expose})`).runInNewContext(context) as T;
  }
  /** The page's words by key, filled in, in English, as the page shows them. */
  const t = (key: string): string => STRINGS.en[key as StringKey] ?? key;
  const fill = (key: string, vars: Record<string, unknown> = {}): string =>
    Object.entries(vars).reduce((text, [name, value]) => text.split(`{${name}}`).join(String(value)), t(key));

  it('shows Cc and Bcc with one switch, and offers to attach files', async () => {
    const page = await shell();
    expect(page).toContain('id="compose-cc-toggle" type="button" class="text-btn quiet" data-i18n="compose.ccBcc">Cc / Bcc<');
    expect(page).toMatch(/<label id="compose-cc-row" class="cfield" hidden>/);
    expect(page).toMatch(/<label id="compose-bcc-row" class="cfield" hidden>.*<input name="bcc"/);
    // The paperclip at the end of the subject line opens a picker that takes several files at once.
    expect(page).toMatch(/<input name="subject" type="text" aria-labelledby="compose-subject-label"><button id="compose-attach"[^>]*aria-label="Attach files"/);
    // Each field is named by its own label alone, not by the buttons that share its line.
    expect(page).toContain('<span class="label" id="compose-subject-label" data-i18n="compose.subject">Subject</span>');
    expect(page).toMatch(/<span class="label" id="compose-to-label" data-i18n="compose.to">To<\/span><input name="to"[^>]* aria-labelledby="compose-to-label">/);
    // What a restored draft still needs, and the pictures a forward leaves out, have lines of their
    // own, outside the note that every other message replaces.
    expect(page).toMatch(/<ul id="compose-files"[^>]*><\/ul>\s*<p id="compose-pictures" class="compose-pictures" hidden><\/p>\s*<p id="compose-lost" class="compose-lost" hidden><\/p>/);
    expect(page).toContain('<input id="compose-file" type="file" multiple hidden>');
    expect(page).toContain('<div id="compose-sig" class="compose-sig" hidden></div>');
    expect(page).toContain('<ul id="compose-files" class="compose-files"');
    expect(page).toContain('<symbol id="i-forward"');
    const chinese = await shell({ 'accept-language': 'zh-CN' });
    expect(chinese).toContain('>抄送 / 密送<');
    expect(chinese).toContain('aria-label="添加附件"');
  });

  it('puts a letter together as MCP does: text, signature under its delimiter, then the quote or the forward', () => {
    const page = lifted<(body: string, signature: string, carried: string) => string>(['letterText'], 'letterText');
    const cases: Array<[string, string, string]> = [
      ['Thanks!\n\n', 'Alex Lin\nMailsift Ltd', 'On Monday, Ann wrote:\n> Hello'],
      ['Thanks!', '', '> Hello'],
      ['Thanks!', '  ', ''],
      ['FYI', 'Alex', '---------- Forwarded message ----------\nFrom: Ann'],
      // A forward with nothing of its own to say, as either side puts it together.
      [' ', 'Alex', 'FWD'],
      ['\n', '', 'FWD'],
      ['', 'Alex', ''],
      ['', '', ''],
    ];
    for (const [body, signature, carried] of cases) expect(page(body, signature, carried)).toBe(letterText(body, signature, carried));
    expect(page('Thanks!\n', 'Alex', '> Hello')).toBe('Thanks!\n\n-- \nAlex\n\n> Hello');
    // A forward with nothing of its own to say starts with the signature, not with blank lines.
    expect(page('  \n', 'Alex', 'fwd')).toBe('-- \nAlex\n\nfwd');
    expect(page('', '', 'fwd')).toBe('fwd');
  });

  it('names a file as the server will send it, and numbers pasted pictures', () => {
    const clean = lifted<(value: unknown) => string>(['UNSHOWABLE', 'cleanFileName'], 'cleanFileName');
    const names = [
      'C:\\Users\\me\\Q3 report.pdf', '/tmp/x/notes.txt', 'invoice\u202Efdp.exe', 'tab\there.txt', '', '.', '..',
      'Cafe\u0301.pdf', `${'a'.repeat(300)}.docx`, `${'长'.repeat(200)}.pdf`, `${'b'.repeat(200)}.not-an-extension-at-all`,
      ' spaced .txt ', 42,
    ];
    for (const name of names) expect(clean(name), String(name)).toBe(attachmentFilename(name));

    const pasted = lifted<(taken: string[], type: string) => string>(['IMAGE_EXTENSIONS', 'pastedName'], 'pastedName');
    expect(pasted([], 'image/png')).toBe('image-1.png');
    expect(pasted(['image-1.png'], 'image/jpeg')).toBe('image-2.jpg');
    expect(pasted(['notes.txt', 'image-2.png'], 'image/webp')).toBe('image-1.webp');
    expect(pasted(['image-1.png', 'image-2.gif'], 'image/x-icon')).toBe('image-3.png');
    expect(pasted([], 'image/heic')).toBe('image-1.heic');
  });

  it('gives a letter a new name when its files change, and the same name when nothing did', () => {
    const key = lifted<(payload: unknown, files: unknown[]) => string>(['letterKey'], 'letterKey');
    const payload = { account: 'me@qq.com', to: ['a@b.co'], bcc: ['c@d.co'], text: 'Hi', forwardOf: 'k1', forwardAttachments: ['2'] };
    const report = { name: 'report.pdf', type: 'application/pdf', size: 1200, at: 1, file: {} };
    const same = key(payload, [report]);
    expect(key({ ...payload }, [{ ...report, file: { other: true } }])).toBe(same);
    expect(key(payload, [])).not.toBe(same);
    expect(key(payload, [report, { ...report, name: 'image-1.png' }])).not.toBe(same);
    expect(key(payload, [{ ...report, size: 1201 }])).not.toBe(same);
    expect(key({ ...payload, forwardAttachments: [] }, [report])).not.toBe(same);
    expect(key({ ...payload, bcc: [] }, [report])).not.toBe(same);
  });

  it('forwards from the reader and the keyboard, and sends what it shows', () => {
    const script = clientScript();
    // In the reader's more menu beside Reply all, and on f beside r and a.
    expect(script).toContain("item('i-forward', t('act.forward'), () => { closeSheet(menuSheet, false); startForward(key); });");
    expect(script).toContain("else if (e.key === 'f') { e.preventDefault(); startForward(key); }");
    expect(script).toContain("['r a', 'keys.reply'], ['f', 'keys.forward']");
    // The original's files go by reference, read by the server; the browser never fetches them.
    expect(script).toContain("payload.forwardAttachments = sentOriginals(state).map((a) => a.partId);");
    expect(script).toContain("'/api/forward?key='");
    // A draft keeps the names of what was attached, never the files.
    expect(script).toContain('files: added.map((f) => f.name).concat(composing.lost || []),');
    expect(script).toContain("post('/api/signature', { account: from, text })");
  });

  /** A field of the form: a value, and somewhere for the focus to go. */
  const field = (value = ''): { value: string; focus: () => void } => ({ value, focus: () => undefined });
  /** As much of an element as the composer's code touches. */
  function node(): Record<string, unknown> {
    const self: Record<string, unknown> = {
      hidden: false, textContent: '', value: '', children: [] as unknown[], dataset: {},
      classList: { toggle: () => undefined, add: () => undefined, remove: () => undefined },
      appendChild: (child: unknown) => { (self['children'] as unknown[]).push(child); return child; },
      replaceChildren: () => { self['children'] = []; },
      setAttribute: () => undefined, focus: () => undefined, querySelector: () => null, reset: () => undefined,
    };
    return self;
  }

  it('keeps naming the files a restored draft is owed, however often it is saved, and holds added ones for the page', () => {
    const stored = new Map<string, string>();
    const context: Record<string, unknown> = {
      composeForm: { to: field('a@b.co'), cc: field(), bcc: field(), subject: field('Re: contract'), text: field('Signed contract attached.') },
      writeStorage: (key: string, value: string) => stored.set(key, value),
      localStorage: { removeItem: (key: string) => stored.delete(key) },
    };
    const page = lifted<{ saveDraft: () => void; heldFiles: Map<string, { files: unknown[] }> }>(
      ['homeId', 'draftId', 'heldFiles', 'saveDraft'], '({ saveDraft, heldFiles })', context,
    );
    const state: Record<string, unknown> = { mode: 'reply', key: 'k1', files: [], lost: ['contract-signed.pdf'] };
    context['composing'] = state;
    // A word typed after the restore: the file still owed is still named.
    page.saveDraft();
    expect(JSON.parse(stored.get('draft:k1')!)).toMatchObject({ text: 'Signed contract attached.', files: ['contract-signed.pdf'] });
    // A file added meanwhile is named with it, and held by the page under the same letter.
    const scan = { name: 'scan.pdf', type: 'application/pdf', size: 10, at: 1, file: {} };
    state['files'] = [scan];
    page.saveDraft();
    expect(JSON.parse(stored.get('draft:k1')!).files).toEqual(['scan.pdf', 'contract-signed.pdf']);
    expect(page.heldFiles.get('draft:k1')!.files).toEqual([scan]);
    // Taken off again, it is no longer held.
    state['files'] = [];
    page.saveDraft();
    expect(page.heldFiles.has('draft:k1')).toBe(false);
    // A letter with nothing in it but a file to add again is still a letter worth keeping.
    (context['composeForm'] as Record<string, { value: string }>)['text']!.value = '';
    page.saveDraft();
    expect(stored.has('draft:k1')).toBe(true);
  });

  it('opens a letter with the files this page holds for it, and says only which of the rest to add again', () => {
    const lost = node();
    const note = node();
    const elements = new Map<string, Record<string, unknown>>();
    const context: Record<string, unknown> = {
      $: (selector: string) => elements.get(selector) ?? elements.set(selector, node()).get(selector),
      composeForm: { ...node(), to: field(), cc: field(), bcc: field(), subject: field(), text: field() },
      composeNote: note, composeLost: lost, composeSend: { disabled: false }, composeSheet: { open: true },
      session: { assistant: false }, lastSummary: { accounts: [] },
      readDraft: () => ({ text: 'Here they are.', files: ['report.pdf', 'notes.txt'], at: 1 }),
      t, fill, el: () => node(), composeSay: (text: string) => { note['textContent'] = text; },
      drawChips: () => undefined, showQuoted: () => undefined, showCopies: () => undefined, drawSignature: () => undefined,
      drawFiles: () => undefined, openSheet: () => undefined, growText: () => undefined, setTimeout: () => undefined,
      signatureOf: () => '', fromOf: () => 'me@qq.com', saveDraft: () => undefined, lang: 'en',
    };
    const page = lifted<{ openCompose: (state: Record<string, unknown>) => void; heldFiles: Map<string, unknown> }>(
      ['homeId', 'draftId', 'heldFiles', 'choosesFrom', 'sentenceGap', 'drawLost', 'openCompose'], '({ openCompose, heldFiles })', context,
    );
    const report = { name: 'report.pdf', size: 10, file: {} };
    page.heldFiles.set('draft:k1', { state: {}, files: [report] });
    const state: Record<string, unknown> = { mode: 'reply', key: 'k1', account: 'me@qq.com', titleKey: 'act.reply' };
    context['composing'] = null;
    page.openCompose(state);
    expect(state['files']).toEqual([report]);
    expect(state['lost']).toEqual(['notes.txt']);
    expect(lost['hidden']).toBe(false);
    expect(lost['textContent']).toBe('Attachments are not kept with a draft: add notes.txt again.');
    // Reopened after an undo, it keeps its own files, whatever this page holds under its name by then.
    page.heldFiles.set('draft:k1', { state: {}, files: [{ name: 'other.pdf' }] });
    state['files'] = [];
    page.openCompose(state);
    expect(state['files']).toEqual([]);
  });

  it('forwards the original\'s files but not the pictures in its body, unless they are asked for', () => {
    const page = lifted<{
      sentOriginals: (state: unknown) => Array<{ partId: string }>; attachedCount: (state: unknown) => number;
    }>(['isOn', 'sentOriginals', 'attachedCount'], '({ sentOriginals, attachedCount })');
    const pdf = { partId: '2', filename: 'invoice.pdf', size: 100, inline: false };
    const logos = Array.from({ length: 24 }, (_, n) => ({ partId: `3.${n + 1}`, filename: `image${n}.png`, size: 10, inline: true }));
    const state: Record<string, unknown> = { originals: [pdf, ...logos], files: [] };
    // A newsletter's two dozen logos do not make a forward of one invoice too large to send.
    expect(page.sentOriginals(state).map((a) => a.partId)).toEqual(['2']);
    expect(page.attachedCount(state)).toBe(1);
    // Asked for, a picture goes; taken off, the invoice does not.
    state['choice'] = { '3.1': true, '2': false };
    expect(page.sentOriginals(state).map((a) => a.partId)).toEqual(['3.1']);
  });

  it('keeps a saved signature from signing a letter that moved to another mailbox while it was saved', async () => {
    const saved: Array<[string, string]> = [];
    const closed: unknown[] = [];
    let leavesFrom = 'me@qq.com';
    const context: Record<string, unknown> = {
      letterLimits: () => ({ signature: 2000 }), t, fill, announce: () => undefined, failure: () => 'failed',
      post: async () => ({ ok: true, data: { signature: 'Ada Lovelace\nAnalytical Engines Ltd' } }),
      savedSignatures: new Map(), rememberSignature: (address: string, text: string) => saved.push([address, text]),
      closeSignatureEditor: (state: unknown) => closed.push(state),
      fromOf: () => leavesFrom, choosesFrom: () => true,
    };
    const storeSignature = lifted<(state: unknown, from: string, area: unknown, said: unknown, buttons: unknown[]) => Promise<void>>(
      ['storeSignature'], 'storeSignature', context,
    );
    const area = { value: 'Ada Lovelace\nAnalytical Engines Ltd' };
    // Saved for work@, while the letter was moved to me@, which has no signature.
    const letter: Record<string, unknown> = { mode: 'new', signature: '', editingSignature: false };
    context['composing'] = letter;
    await storeSignature(letter, 'work@qq.com', area, { textContent: '' }, []);
    expect(letter['signature']).toBe('');
    expect(closed).toEqual([]);
    // Saved for every letter from work@ all the same.
    expect(saved).toEqual([['work@qq.com', 'Ada Lovelace\nAnalytical Engines Ltd']]);
    expect((context['savedSignatures'] as Map<string, { text: string }>).get('work@qq.com')!.text).toBe('Ada Lovelace\nAnalytical Engines Ltd');
    // Still leaving from work@, the letter signs with it.
    leavesFrom = 'work@qq.com';
    await storeSignature(letter, 'work@qq.com', area, { textContent: '' }, []);
    expect(letter['signature']).toBe('Ada Lovelace\nAnalytical Engines Ltd');
    expect(closed).toEqual([letter]);
  });

  it('will not send while the signature is being edited, or a forward whose message could not be read', () => {
    const said: string[] = [];
    let focused = 0;
    const context: Record<string, unknown> = {
      composeSend: { disabled: false }, pendingSend: null, t, fill,
      composeForm: { to: field('a@b.co'), cc: field(), bcc: field(), subject: field('s'), text: field('Hello') },
      composeSay: (text: string) => said.push(text),
      composeSig: { querySelector: () => ({ focus: () => { focused += 1; } }) },
    };
    const sendCompose = lifted<() => void>(['addresses', 'sendCompose'], 'sendCompose', context);
    context['composing'] = { mode: 'new', key: '', editingSignature: true, signature: 'Old' };
    sendCompose();
    expect(said.at(-1)).toBe('Save or cancel the signature first.');
    expect(focused).toBe(1);
    // The forward's message was refused by the server: waiting will not bring it.
    context['composing'] = { mode: 'forward', key: 'k1', quoted: '', forwardFailed: 'Not found.' };
    sendCompose();
    expect(said.at(-1)).toBe('The message to forward could not be read: Not found. Close this and forward it again.');
    // Still on its way: it may yet come.
    context['composing'] = { mode: 'forward', key: 'k1', quoted: '' };
    sendCompose();
    expect(said.at(-1)).toBe(t('compose.forwardMissing'));
  });

  /**
   * The composer's own code for opening a letter, keeping its draft, sending
   * it off and taking it back, run together over a stand-in page: storage in
   * a map, and each element as much of one as that code touches.
   */
  function composer() {
    const stored = new Map<string, string>();
    const said: string[] = [];
    const delivered: unknown[] = [];
    const elements = new Map<string, Record<string, unknown>>();
    const note = node();
    const lost = node();
    const form = {
      ...node(), to: field(), cc: field(), bcc: field(), subject: field(), text: field(),
      reset: () => { for (const name of ['to', 'cc', 'bcc', 'subject', 'text'] as const) form[name].value = ''; },
    };
    let ids = 0;
    const context: Record<string, unknown> = {
      $: (selector: string) => elements.get(selector) ?? elements.set(selector, node()).get(selector),
      document: { createElement: () => node() }, Option: function Option() { return {}; },
      composeForm: form, composeNote: note, composeLost: lost, composeSend: { disabled: false }, composeSheet: { open: true },
      composeSig: { querySelector: () => null }, sendingNode: node(),
      session: { assistant: false }, lastSummary: { accounts: [{ address: 'me@qq.com', name: 'Me', canSend: true }] },
      writeStorage: (key: string, value: string) => stored.set(key, value),
      readStorage: (key: string) => stored.get(key) ?? null,
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: (key: string) => stored.delete(key),
      },
      t, fill, el: () => node(),
      composeSay: (text: string) => { note['textContent'] = text; note['children'] = []; if (text) said.push(text); },
      composeAdd: (text: string) => said.push(text),
      drawChips: () => undefined, showQuoted: () => undefined, showCopies: () => undefined, drawSignature: () => undefined,
      drawFiles: () => undefined, openSheet: () => undefined, growText: () => undefined, setTimeout: () => undefined,
      takeSignature: () => undefined, signatureOf: () => '', fromOf: () => 'me@qq.com', fileProblem: () => '',
      letterId: () => `letter${(ids += 1)}`, draftTimer: undefined, clearTimeout: () => undefined, setInterval: () => 1,
      clearInterval: () => undefined, closeSheet: () => undefined, raiseToast: () => undefined, announce: () => undefined,
      hideSending: () => undefined, deliver: (job: unknown) => delivered.push(job), pendingSend: null, composing: null,
      lang: 'en',
    };
    const page = lifted<{
      openCompose: (state: Record<string, unknown>) => void; saveDraft: () => void; sendCompose: () => void;
      undoSend: (job: unknown) => void; fillForward: (d: Record<string, unknown>) => void;
      heldFiles: Map<string, { files: unknown[] }>;
    }>([
      'homeId', 'draftId', 'heldFiles', 'isAnswer', 'choosesFrom', 'addresses', 'letterText', 'letterKey', 'saveDraft',
      'sentenceGap', 'drawLost', 'missingWords', 'readDraft', 'isOn', 'sentOriginals', 'UNSHOWABLE', 'cleanFileName', 'reclaimDraft',
      'undoSend', 'openCompose', 'fillForward', 'SEND_DELAY', 'sendCompose',
    ], '({ openCompose, saveDraft, sendCompose, undoSend, fillForward, heldFiles })', context);
    /** A letter written into the open composer, as a person types it. */
    const write = (fields: { to?: string; subject?: string; text?: string }): void => {
      if (fields.to !== undefined) form.to.value = fields.to;
      if (fields.subject !== undefined) form.subject.value = fields.subject;
      if (fields.text !== undefined) form.text.value = fields.text;
    };
    /** A new message opened, and what it opened with. */
    const fresh = (): Record<string, unknown> => {
      const state: Record<string, unknown> = { mode: 'new', key: '', titleKey: 'compose.new', files: [] };
      page.openCompose(state);
      return state;
    };
    const file = (name: string) => ({ id: name, name, type: 'text/plain', size: 10, at: 1, file: {} });
    const names = (state: Record<string, unknown>): string[] => ((state['files'] ?? []) as Array<{ name: string }>).map((f) => f.name);
    return { page, context, stored, said, delivered, form, lost, note, write, fresh, file, names };
  }

  it('never gives a letter begun during another\'s count that other letter\'s files when it comes back', () => {
    for (const secondHasFiles of [true, false]) {
      const { page, context, write, fresh, file, names, form, delivered } = composer();
      // Letter one, to Alice with her contract, is sent off and counting.
      const one = fresh();
      write({ to: 'alice@example.org', subject: 'Contract', text: 'letter one' });
      one['files'] = [file('alice-contract.pdf')];
      page.sendCompose();
      const job = context['pendingSend'];
      expect(job).toBeTruthy();
      // Meanwhile a new message to Bob is begun, and closed.
      const two = fresh();
      expect(names(two)).toEqual([]);
      write({ to: 'bob@example.org', subject: 'Lunch', text: 'letter two for bob' });
      if (secondHasFiles) two['files'] = [file('bob-notes.txt')];
      page.saveDraft();
      // Letter one comes back (undone, or refused), and is closed again.
      page.undoSend(job);
      expect(context['composing']).toBe(one);
      expect(names(one)).toEqual(['alice-contract.pdf']);
      page.saveDraft();
      // The next new message is Bob's letter, with Bob's files and none of Alice's.
      const three = fresh();
      expect(form.to.value).toBe('bob@example.org');
      expect(names(three)).toEqual(secondHasFiles ? ['bob-notes.txt'] : []);
      expect(delivered).toEqual([]);
    }
  });

  it('does not put back a file that was taken off a reopened letter, or a draft that was discarded', () => {
    const { page, context, write, fresh, file, names, note } = composer();
    const first = fresh();
    write({ to: 'friend@example.org', text: 'with a file' });
    first['files'] = [file('a.txt')];
    page.saveDraft();
    // Opened again it has the file, as it should; taken off, and closed.
    const again = fresh();
    expect(names(again)).toEqual(['a.txt']);
    again['files'] = [];
    page.saveDraft();
    expect(names(fresh())).toEqual([]);
    expect(page.heldFiles.size).toBe(0);
    // Discarded from the restored draft, the file is gone with its words.
    const third = context['composing'] as Record<string, unknown>;
    write({ text: 'another try' });
    third['files'] = [file('b.txt')];
    page.saveDraft();
    fresh();
    const discard = (note['children'] as Array<{ onclick?: () => void }>).find((child) => child.onclick)!;
    discard.onclick!();
    page.saveDraft();
    expect(names(fresh())).toEqual([]);
  });

  it('asks before a restored draft goes without the files it had, and sends it at the second press', () => {
    const { page, context, stored, said, fresh } = composer();
    stored.set('draft:new', JSON.stringify({ to: 'a@b.co', subject: 'Contract', text: 'See attached.', files: ['contract.pdf', 'scan.png'], at: 1 }));
    const letter = fresh();
    expect(letter['lost']).toEqual(['contract.pdf', 'scan.png']);
    page.sendCompose();
    expect(context['pendingSend']).toBeNull();
    expect(said.at(-1)).toBe(`${fill('compose.sendWithoutFiles', { list: 'contract.pdf, scan.png' })} ${t('compose.sendAnyway')}`);
    // A press right after the question is a double click, not an answer to it.
    page.sendCompose();
    expect(context['pendingSend']).toBeNull();
    // Read, and answered.
    letter['warnedAt'] = Date.now() - 1000;
    page.sendCompose();
    expect(context['pendingSend']).toMatchObject({ state: letter });
  });

  it('says which of the original\'s files cannot be forwarded, and asks before the forward goes without them', () => {
    const { page, context, said, lost, write } = composer();
    const forward: Record<string, unknown> = { mode: 'forward', key: 'k1', account: 'me@qq.com', titleKey: 'act.forward', files: [], originals: [] };
    page.openCompose(forward);
    page.fillForward({
      forwarded: '---------- Forwarded message ----------', subject: 'Fwd: x', attachments: [],
      notForwardable: [{ partId: '2', filename: 'Quarterly.pdf', contentType: 'multipart/appledouble' }],
    });
    expect(lost['hidden']).toBe(false);
    expect(lost['textContent']).toBe(fill('compose.cannotForward', { list: 'Quarterly.pdf' }));
    write({ to: 'colleague@example.org' });
    page.sendCompose();
    expect(context['pendingSend']).toBeNull();
    expect(said.at(-1)).toBe(`${fill('compose.sendWithoutContainers', { list: 'Quarterly.pdf' })} ${t('compose.sendAnyway')}`);
    forward['warnedAt'] = Date.now() - 1000;
    page.sendCompose();
    expect(context['pendingSend']).not.toBeNull();
  });

  it('keeps saying a forward\'s files could not be listed after an undo, and asks before it goes without them', () => {
    const { page, context, said, lost, write } = composer();
    const forward: Record<string, unknown> = { mode: 'forward', key: 'k1', account: 'me@qq.com', titleKey: 'act.forward', files: [], originals: [] };
    page.openCompose(forward);
    page.fillForward({ forwarded: '---------- Forwarded message ----------', subject: 'Fwd: x', attachments: [], attachmentsUnavailable: true });
    expect(lost['hidden']).toBe(false);
    expect(lost['textContent']).toBe(t('compose.forwardFilesUnavailable'));
    write({ to: 'colleague@example.org' });
    // The first press asks, as MCP refuses until it is told to send without them; the second sends.
    page.sendCompose();
    expect(context['pendingSend']).toBeNull();
    expect(said.at(-1)).toBe(`${t('compose.sendWithoutOriginals')} ${t('compose.sendAnyway')}`);
    forward['warnedAt'] = Date.now() - 1000;
    page.sendCompose();
    const job = context['pendingSend'] as { payload: { forwardAttachments: string[] } };
    expect(job.payload.forwardAttachments).toEqual([]);
    // Taken back, the letter still says so, under its files where an undo does not reach, and asks again.
    page.undoSend(job);
    expect(lost['textContent']).toBe(t('compose.forwardFilesUnavailable'));
    page.sendCompose();
    expect(context['pendingSend']).toBeNull();
  });

  it('moves the focus with a forward\'s file that is put back, to its own Remove', () => {
    const focused: string[] = [];
    const context: Record<string, unknown> = { filesChanged: () => undefined, announce: () => undefined, fill };
    const page = lifted<{
      fileItems: (state: unknown) => Array<{ filename: string }>; putBack: (state: unknown, item: unknown, at?: number) => void;
    }>(['isOn', 'fileItems', 'chooseOriginal', 'putBack'], '({ fileItems, putBack })', context);
    const invoice = { partId: '2', filename: 'invoice-4821.pdf', inline: false };
    const receipt = { partId: '3', filename: 'receipt-october.png', inline: false };
    const state: Record<string, unknown> = { originals: [invoice, receipt], files: [], choice: { 2: false } };
    // As drawn: the receipt going, then the invoice taken off.
    context['composeFiles'] = {
      querySelectorAll: () => page.fileItems(state).map((item) => ({ focus: () => focused.push(item.filename) })),
    };
    expect(page.fileItems(state).map((item) => item.filename)).toEqual(['receipt-october.png', 'invoice-4821.pdf']);
    page.putBack(state, invoice, 1);
    expect(page.fileItems(state).map((item) => item.filename)).toEqual(['invoice-4821.pdf', 'receipt-october.png']);
    expect(focused).toEqual(['invoice-4821.pdf']);
  });

  it('counts the message dealt with only when the server says the letter dealt with it', async () => {
    const marked: string[] = [];
    let answer: Record<string, unknown> = {};
    const context: Record<string, unknown> = {
      pendingSend: null, hideSending: () => undefined, toast: () => undefined, readFiles: async () => ({ attachments: [] }),
      backToLetter: () => undefined, post: async () => ({ ok: true, status: 200, data: answer }), document: { hidden: false },
      bytesOf: () => 10, KEEPALIVE_BYTES: 60000, localStorage: { removeItem: () => undefined }, t, fill,
      attentionSet: new Set(['k1']), rowByKey: () => ({ handledAt: null }), markHandledLocal: (key: string) => marked.push(key),
      attentionCount: 3, liveData: new Map(), renderList: () => undefined, renderLede: () => undefined,
      renderBars: () => undefined, updateBadge: () => undefined,
    };
    const deliver = lifted<(job: unknown) => Promise<void>>(['homeId', 'draftId', 'heldFiles', 'deliver'], 'deliver', context);
    const job = () => ({ payload: { forwardOf: 'k1' }, files: [], state: { mode: 'forward', key: 'k1', draftKey: 'draft:sending:x' } });
    // Forwarded to another of the owner's own mailboxes: still to be dealt with.
    answer = { sent: true, rejected: [], handled: false, attention: 3 };
    await deliver(job());
    expect(marked).toEqual([]);
    expect(context['attentionCount']).toBe(3);
    answer = { sent: true, rejected: [], handled: true, attention: 2 };
    await deliver(job());
    expect(marked).toEqual(['k1']);
    expect(context['attentionCount']).toBe(2);
  });

  it('says a proxy refused the size, or stopped waiting, rather than blaming the mail server', () => {
    const sendFailure = lifted<(d: unknown, status?: number) => string>(['sendFailure'], 'sendFailure', {
      t, fill, sizeLabel: (n: number) => `${n / (1024 * 1024)} MB`, letterLimits: () => ({ bytes: 20 * 1024 * 1024 }),
      failure: (d: { code: string }) => `failure:${d.code}`,
    });
    expect(sendFailure({}, 413)).toBe(fill('compose.proxyTooLarge', { maxBytes: '20 MB' }));
    expect(sendFailure({}, 413)).toContain('before it reached mailsift');
    expect(sendFailure({}, 504)).toBe(t('error.send_timeout'));
    expect(sendFailure({}, 524)).toBe(t('error.send_timeout'));
    expect(sendFailure({}, 0)).toBe(t('error.send_connection'));
    // Cut off while it was still arriving: the upload took too long, and the mail server was never asked.
    expect(sendFailure({}, 408)).toBe(t('compose.uploadTooSlow'));
    expect(t('compose.uploadTooSlow')).toContain('took too long to upload');
    // mailsift's own refusals keep their own words.
    expect(sendFailure({ code: 'send_too_large', maxBytes: 5 }, 413)).toBe('failure:send_too_large');
    for (const key of [
      'compose.proxyTooLarge', 'compose.forwardUnreadable', 'compose.sigUnsaved', 'compose.picturesOff', 'compose.putBackFile',
      'compose.uploadTooSlow', 'compose.sendWithoutFiles', 'compose.sendWithoutOriginals', 'compose.sendAnyway',
    ] as const) {
      expect(STRINGS['zh-CN'][key], key).toBeTruthy();
      expect(STRINGS['zh-CN'][key]).not.toBe(STRINGS.en[key]);
    }
  });
});
