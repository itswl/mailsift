import { describe, expect, it } from 'vitest';
import './setup.js';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { handleApi, readCookie, routeWeb, SESSION_COOKIE, tokenMatches, webUiEnabled } from '../src/web.js';
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
    expect(answer.cookie).toContain('SameSite=Strict');
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
