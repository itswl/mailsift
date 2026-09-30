import { describe, expect, it } from 'vitest';
import './setup.js';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import {
  allowAuthAttempt, handleApi, readCookie, routeWeb, SESSION_COOKIE, tokenMatches, webUiEnabled,
} from '../src/web.js';
import { clientAddress } from '../src/mcp.js';
import { StateStore } from '../src/services/state.js';

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
  });

  it('bounds the window and the page size rather than trusting the query', async () => {
    const store = seeded();
    const huge = url('/api/mail?limit=99999&hours=-5');
    const answer = JSON.parse((await handleApi(huge.pathname, huge.searchParams, store)).body) as { count: number };
    expect(answer.count).toBe(3);
  });

  it('summarizes the window and offers the vocabularies the filters need', async () => {
    const summary = await body('/api/summary', seeded());
    expect(summary).toMatchObject({ total: 3, pushed: 2 });
    expect(summary['categories']).toContain('Security');
  });

  it('previews the digest queue', async () => {
    const store = seeded();
    store.queueDigest('k2', { subject: 'queued', importance: 'info', category: 'Marketing', threadCount: 1, date: '', summary: 'x', accountLabel: 'a', folder: 'INBOX', inSpam: false, from: 'f@x', fromName: 'F', deadline: '', actionRequired: false });
    expect(await body('/api/digest', store)).toMatchObject({ pending: 1 });
  });

  it('returns a stored record without touching the mailbox unless asked', async () => {
    const store = seeded();
    const one = await body('/api/message?id=%3Cone%40x%3E', store);
    expect(one).toMatchObject({ messageId: '<one@x>', importance: 'critical', body: null });
    expect(await body('/api/message?id=%3Cabsent%40x%3E', store)).toMatchObject({ error: 'not found' });
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
  it('builds every message value in the browser, never as server-side markup', async () => {
    // Subjects and sender names are attacker-controlled. The shell must carry
    // no message data at all, so there is nothing to escape wrongly.
    const store = seeded();
    store.markSeen('evil', 'me@qq.com', '<img src=x onerror=alert(1)>');
    store.recordOutcome('evil', 'info', false, { messageId: '<evil@x>', summary: '</script><script>alert(1)</script>' });
    const page = (await routeWeb(request(), url('/'), '', store)).body;
    expect(page).not.toContain('onerror');
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
    const m = JSON.parse(String(answer.body)) as { display: string; icons: Array<{ purpose: string; sizes: string }> };
    expect(answer.contentType).toBe('application/manifest+json');
    expect(m.display).toBe('standalone');
    expect(m.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512')).toBe(true);
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
    expect(page).toContain('prefers-color-scheme: light');
    expect(page).toContain('prefers-color-scheme: dark');
    expect(page).toContain('viewport-fit=cover');
    expect(page).toContain('apple-touch-icon');
    expect(page).toContain('safe-area-inset-top');
  });

  it('caches nothing in the worker, because this is a live view', async () => {
    const worker = String((await routeWeb(request({ url: '/sw.js' }), url('/sw.js'), '', seeded())).body);
    expect(worker).not.toContain('caches');
    expect(worker).toContain('fetch');
  });
});

describe('colour theme', () => {
  const shell = async (): Promise<string> => String((await routeWeb(request(), url('/'), '', seeded())).body);

  it('offers three states, so following the system stays reachable', async () => {
    const page = await shell();
    expect(page).toContain('id="theme"');
    expect(page).toContain("['auto', 'light', 'dark']");
  });

  it('lets a stored choice beat the system in either direction', async () => {
    const page = await shell();
    // System dark yields to an explicit light choice, and an explicit dark
    // choice applies under a light system.
    expect(page).toContain('@media(prefers-color-scheme:dark){:root:not([data-theme=light])');
    expect(page).toContain(':root[data-theme=dark]{--bg:#15171a');
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
    expect(page).toContain('<meta name="theme-color" content="#ffffff">');
    expect(page).toContain("meta.setAttribute('content', isDark ? '#15171a' : '#ffffff')");
  });

  it('keeps following the system while the choice is auto', async () => {
    expect(await shell()).toContain("dark.addEventListener('change'");
  });

  it('survives a browser that refuses storage', async () => {
    const page = await shell();
    expect(page).toContain("catch (e) { return 'auto'; }");
  });
});

describe('layout', () => {
  it('wraps the unbroken runs that message text is full of', async () => {
    // A URL or a message id has nowhere to wrap, so without this the row grows
    // past the viewport and the whole page scrolls sideways on a phone.
    const page = String((await routeWeb(request(), url('/'), '', seeded())).body);
    expect(page).toContain('.row,.detail,.card{overflow-wrap:anywhere');
    expect(page).toContain('.detail h3{margin:0 0 6px;font-size:15px;overflow-wrap:anywhere}');
  });

  it('keeps a definition value inside its own grid column', async () => {
    // dd carries a 40px inline start margin by default.
    expect(String((await routeWeb(request(), url('/'), '', seeded())).body)).toContain('.detail dd{margin:0}');
  });
});
