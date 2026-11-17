import { describe, expect, it, vi } from 'vitest';
import './setup.js';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import {
  allowAuthAttempt, handleApi, LANGUAGE_COOKIE, languageFromHeader, readCookie, routeWeb, SESSION_COOKIE, signInTarget,
  tokenMatches, webRateLimited, webUiEnabled, webVersion,
} from '../src/web.js';
import { SERVICE_WORKER } from '../src/web-worker.js';
import { buildLink } from '../src/links.js';
import { STRINGS, type StringKey } from '../src/web-strings.js';
import { clientScript } from '../src/web-client.js';
import { styles } from '../src/web-styles.js';
import { webcrypto } from 'node:crypto';
import { letterText } from '../src/web-actions.js';
import { attachmentFilename } from '../src/smtp.js';
import { Script } from 'node:vm';
import { allowMcpRequest, allowWebRequest, clientAddress, RATE_TABLE_MAX, rateTableSize } from '../src/mcp.js';
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

  it('marks the cookie Secure always when WEB_COOKIE_SECURE says so, and as before otherwise', async () => {
    // The cookie is the token itself: a deployment only ever reached over HTTPS can say so, whatever its proxy sends.
    const store = seeded();
    const signIn = async (headers: Record<string, string> = {}) =>
      (await routeWeb(request({ method: 'POST', url: '/auth', body: 'token=s', headers }), url('/auth'), 's', store)).cookie;
    process.env.WEB_COOKIE_SECURE = 'true';
    expect(await signIn()).toContain('; Secure');
    // Renewed on a visit, and cleared on signing out, under the same rule.
    const visit = await routeWeb(request({ headers: { cookie: `${SESSION_COOKIE}=s` } }), url('/'), 's', store);
    expect(visit.cookie).toContain('; Secure');
    process.env.WEB_COOKIE_SECURE = 'auto';
    expect(await signIn()).not.toContain('Secure');
    expect(await signIn({ 'x-forwarded-proto': 'https' })).toContain('; Secure');
  });

  it('signs a device out whose session has already ended, so the page can forget what it kept', async () => {
    const store = seeded();
    const out = await routeWeb(
      request({ method: 'POST', url: '/auth/signout', headers: { cookie: `${SESSION_COOKIE}=expired`, 'sec-fetch-site': 'same-origin' } }),
      url('/auth/signout'), 'secret', store,
    );
    expect(out.status).toBe(200);
    expect(out.cookie).toContain('Max-Age=0');
    // Still only from this site.
    const elsewhere = await routeWeb(
      request({ method: 'POST', url: '/auth/signout', headers: { 'sec-fetch-site': 'cross-site' } }), url('/auth/signout'), 'secret', store,
    );
    expect(elsewhere.status).toBe(403);
    expect(elsewhere.cookie).toBeUndefined();
  });

  it('refuses a mistyped write token where no read token is set, rather than signing in read-only on it', async () => {
    const store = seeded();
    const signIn = (token: string) => routeWeb(
      request({ method: 'POST', url: '/auth', body: `token=${token}` }), url('/auth'), '', store, `write-only-${token}`, { writeToken: 'write' },
    );
    const wrong = await signIn('wrong-write-token');
    expect(wrong.status).toBe(401);
    expect(wrong.cookie).toBeUndefined();
    expect(String(wrong.body)).toContain(STRINGS.en['login.rejected']);
    expect((await signIn('write')).status).toBe(303);
    // Nothing typed: the page reads without a token here, as it did.
    expect((await signIn('')).status).toBe(303);
  });

  it('goes on to the address the sign-in was asked for, and never off this server', async () => {
    const store = seeded();
    const signIn = async (next: string) => (await routeWeb(
      request({ method: 'POST', url: '/auth', body: `token=secret&next=${encodeURIComponent(next)}` }), url('/auth'), 'secret', store, `next-${next}`,
    )).headers?.['location'];
    expect(await signIn('/?focus=code')).toBe('/?focus=code');
    expect(await signIn('/?in=me%40qq.com&folder=Travel%2F2025')).toBe('/?in=me%40qq.com&folder=Travel%2F2025');
    expect(await signIn('/#m=k1')).toBe('/#m=k1');
    for (const away of ['//evil.example/', 'https://evil.example/', '/\\evil.example', 'javascript:alert(1)', '/auth', '', 'x']) {
      expect(await signIn(away), away).toBe('/');
    }
    expect(signInTarget('/\nLocation: x')).toBe('/');
    // The form carries where it was asked for, and keeps it over a refused try.
    const form = String((await routeWeb(request({ url: '/?focus=code' }), url('/?focus=code'), 'secret', store)).body);
    expect(form).toContain('<input type="hidden" name="next" value="">');
    expect(form).toContain('next.value = here + location.search + location.hash');
    const refused = String((await routeWeb(
      request({ method: 'POST', url: '/auth', body: `token=wrong&next=${encodeURIComponent('/?focus=code')}` }), url('/auth'), 'secret', store, 'next-wrong',
    )).body);
    expect(refused).toContain('name="next" value="/?focus=code"');
  });

  it('sends an address that is not a page to the page, answers HEAD, and does not call a cross-site sign-in a wrong token', async () => {
    const store = seeded();
    const as = { cookie: `${SESSION_COOKIE}=secret` };
    for (const path of ['/index.html', '/signout', '/auth', '/nonexistent']) {
      const answer = await routeWeb(request({ url: path, headers: as }), url(path), 'secret', store);
      expect(answer.status, path).toBe(303);
      expect(answer.headers?.['location'], path).toBe('/');
    }
    expect((await routeWeb(request({ url: '/api/nonexistent', headers: as }), url('/api/nonexistent'), 'secret', store)).status).toBe(404);
    expect((await routeWeb(request({ method: 'HEAD', url: '/', headers: as }), url('/'), 'secret', store)).status).toBe(200);
    const cross = await routeWeb(
      request({ method: 'POST', url: '/auth', body: 'token=secret', headers: { origin: 'https://mail.example.com', host: '127.0.0.1:8410' } }),
      url('/auth'), 'secret', store, 'cross-signin',
    );
    expect(cross.status).toBe(403);
    expect(String(cross.body)).toContain(STRINGS.en['login.crossSite'].slice(0, 30));
    expect(String(cross.body)).not.toContain(STRINGS.en['login.rejected']);
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

  it('gives the page a budget of its own, apart from MCP\'s, and says in its own words when it is spent', async () => {
    const at = Date.parse('2026-11-17T00:00:00Z');
    // An MCP client on the same address uses up its budget...
    for (let n = 0; n < 120; n += 1) allowMcpRequest('shared-address', at + n);
    expect(allowMcpRequest('shared-address', at + 200)).toBe(false);
    // ...and the page on it reads on, ten times as long.
    expect(Array.from({ length: 1200 }, (_, n) => allowWebRequest('shared-address', at + n)).every(Boolean)).toBe(true);
    expect(allowWebRequest('shared-address', at + 1300)).toBe(false);
    const navigation = webRateLimited(request({ headers: { 'accept-language': 'zh-CN' } }), '/');
    expect(navigation.status).toBe(429);
    expect(navigation.contentType).toContain('text/html');
    expect(String(navigation.body)).toContain(STRINGS['zh-CN']['error.rate_limited']);
    expect(String(navigation.body)).not.toContain('{"error"');
    const api = webRateLimited(request(), '/api/message');
    expect(JSON.parse(String(api.body))).toMatchObject({ code: 'rate_limited' });
    expect(api.headers?.['retry-after']).toBe('60');
    // The installed app opens the page it kept rather than the answer of a server too busy to give it one.
    expect(SERVICE_WORKER).toContain('response.status === 429 || response.status >= 500');
  });

  it('does not let a stream of addresses grow the budget tables without end', () => {
    const at = Date.parse('2026-11-17T01:00:00Z');
    const before = rateTableSize();
    for (let n = 0; n < RATE_TABLE_MAX * 2; n += 1) allowMcpRequest(`passer-by-${n}`, at + n);
    expect(rateTableSize() - before).toBeLessThanOrEqual(RATE_TABLE_MAX);
    for (let n = 0; n < RATE_TABLE_MAX * 2; n += 1) allowWebRequest(`passer-by-${n}`, at + n);
    expect(rateTableSize()).toBeLessThanOrEqual(RATE_TABLE_MAX * 2);
    // A client still within its minute keeps what it has used.
    for (let n = 0; n < 120; n += 1) allowMcpRequest('busy', at + RATE_TABLE_MAX * 2 + n);
    expect(allowMcpRequest('busy', at + RATE_TABLE_MAX * 2 + 200)).toBe(false);
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

  it('searches what a person reads of a message, for the words as typed', async () => {
    const store = seeded();
    store.markSeen('k4', 'me@qq.com', 'first_last report');
    store.recordOutcome('k4', 'info', false, { messageId: '<four@x>', threadKey: 'me@qq.com|<four@x>', sender: 'club@example.com', folder: 'INBOX' });
    // % and _ are characters, not wildcards: each matched every message.
    expect(await body('/api/mail?q=_', store)).toMatchObject({ count: 1 });
    expect(await body('/api/mail?q=%25', store)).toMatchObject({ count: 0 });
    expect(await body('/api/mail?q=first_last', store)).toMatchObject({ count: 1 });
    expect(await body('/api/mail?q=firstxlast', store)).toMatchObject({ count: 0 });
    // The mailbox's own address is in every thread key, and a piece of a Message-ID is the sender's machine text.
    expect(await body('/api/mail?q=qq', store)).toMatchObject({ count: 0 });
    expect(await body('/api/mail?q=four', store)).toMatchObject({ count: 0 });
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
describe('the composer', () => {
  const shell = async (headers: Record<string, string> = {}): Promise<string> =>
    String((await routeWeb(request({ headers }), url('/'), '', seeded())).body);

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
      readDraft: () => ({ text: 'Here they are.', files: ['report.pdf', 'notes.txt'], at: 1 }), offerKept: () => undefined,
      t, fill, el: () => node(), composeSay: (text: string) => { note['textContent'] = text; },
      drawChips: () => undefined, showQuoted: () => undefined, showCopies: () => undefined, drawSignature: () => undefined,
      drawFiles: () => undefined, openSheet: () => undefined, growText: () => undefined, setTimeout: () => undefined,
      signatureOf: () => '', fromOf: () => 'me@qq.com', saveDraft: () => undefined, lang: 'en', closeSuggest: () => false,
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
    const sendCompose = lifted<() => void>(['isAnswer', 'addresses', 'sendCompose'], 'sendCompose', context);
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
    // As the browser's: what is stored is also listed by Object.keys.
    const localStorage: Record<string, unknown> = Object.create({
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, String(value));
        Object.defineProperty(localStorage, key, { value: String(value), enumerable: true, configurable: true, writable: true });
      },
      removeItem: (key: string) => { stored.delete(key); delete localStorage[key]; },
    }) as Record<string, unknown>;
    const storage = localStorage as unknown as { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void; removeItem: (key: string) => void };
    const toasts: Array<{ text: string; failed: boolean; action: { label: string; run: () => void } | null }> = [];
    const context: Record<string, unknown> = {
      $: (selector: string) => elements.get(selector) ?? elements.set(selector, node()).get(selector),
      document: { createElement: () => node() }, Option: function Option() { return {}; },
      composeForm: form, composeNote: note, composeLost: lost, composeSend: { disabled: false }, composeSheet: { open: true },
      composeSig: { querySelector: () => null }, sendingNode: node(),
      session: { assistant: false }, lastSummary: { accounts: [{ address: 'me@qq.com', name: 'Me', canSend: true }] },
      writeStorage: (key: string, value: string) => storage.setItem(key, value),
      readStorage: (key: string) => storage.getItem(key),
      localStorage,
      hideToast: () => undefined, toast: (text: string, failed: boolean, action: { label: string; run: () => void } | null) => toasts.push({ text, failed, action }),
      loadReply: () => undefined, loadForward: () => undefined,
      t, fill, el: () => node(),
      composeSay: (text: string) => { note['textContent'] = text; note['children'] = []; if (text) said.push(text); },
      composeAdd: (text: string) => said.push(text),
      drawChips: () => undefined, showQuoted: () => undefined, showCopies: () => undefined, drawSignature: () => undefined,
      drawFiles: () => undefined, openSheet: () => undefined, growText: () => undefined, setTimeout: () => undefined,
      takeSignature: () => undefined, signatureOf: () => '', fromOf: () => 'me@qq.com', fileProblem: () => '',
      letterId: () => `letter${(ids += 1)}`, draftTimer: undefined, clearTimeout: () => undefined, setInterval: () => 1,
      clearInterval: () => undefined, closeSheet: () => undefined, raiseToast: () => undefined, announce: () => undefined,
      hideSending: () => undefined, deliver: (job: unknown) => delivered.push(job), pendingSend: null, composing: null,
      lang: 'en', closeSuggest: () => false, offerKept: () => undefined, textNode: () => node(),
    };
    const page = lifted<{
      openCompose: (state: Record<string, unknown>) => void; saveDraft: () => void; sendCompose: () => void;
      undoSend: (job: unknown) => void; fillForward: (d: Record<string, unknown>) => void;
      heldFiles: Map<string, { files: unknown[] }>;
      backToLetter: (job: unknown, said: string) => void; keptLetters: () => Array<{ id: string; kept: Record<string, unknown> }>;
      settleKept: () => void; reopenLetter: (stateOrId: unknown) => void;
    }>([
      'homeId', 'draftId', 'heldFiles', 'isAnswer', 'choosesFrom', 'addresses', 'letterText', 'letterKey', 'saveDraft',
      'sentenceGap', 'drawLost', 'missingWords', 'readDraft', 'isOn', 'sentOriginals', 'UNSHOWABLE', 'cleanFileName', 'reclaimDraft',
      'undoSend', 'openCompose', 'fillForward', 'SEND_DELAY', 'sendCompose',
      'letterOf', 'keptStates', 'keepLetter', 'keptLetters', 'settleKept', 'reopenLetter', 'backToLetter',
    ], '({ openCompose, saveDraft, sendCompose, undoSend, fillForward, heldFiles, backToLetter, keptLetters, settleKept, reopenLetter })', context);
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
    return { page, context, stored, storage, toasts, said, delivered, form, lost, note, write, fresh, file, names };
  }

  it('keeps a letter whose send failed while another was open, offers it, and makes it its message\'s draft once that is free', () => {
    const { page, context, stored, storage, toasts, form, write, fresh } = composer();
    const a = fresh();
    write({ to: 'ann.lee@studio.example', subject: 'Letter A', text: 'Important letter A, long and careful.' });
    page.sendCompose();
    const job = context['pendingSend'];
    // Letter B is begun during the count, and is being typed when A fails.
    const b = fresh();
    write({ text: 'Letter B being written' });
    // As deliver() does: no longer counting, and then refused.
    context['pendingSend'] = null;
    page.backToLetter(job, 'The mail server refused the sign-in.');
    // B stays open, with what is being typed in it; the page says what happened, with a way to A.
    expect(context['composing']).toBe(b);
    expect(form.text.value).toBe('Letter B being written');
    expect(toasts.at(-1)).toMatchObject({ failed: true, action: { label: STRINGS.en['compose.openIt'] } });
    expect(toasts.at(-1)!.text).toContain('The mail server refused the sign-in.');
    // B is closed and kept; A is out of reach of n (B holds that place), but kept and offered.
    page.saveDraft();
    (context['composeSheet'] as { open: boolean }).open = false;
    expect(JSON.parse(stored.get('draft:new')!).text).toBe('Letter B being written');
    const kept = page.keptLetters();
    expect(kept.map((entry) => entry.kept['subject'])).toEqual(['Letter A']);
    // Opened again from there: all of A, and B is still the new letter's draft.
    (context['composeSheet'] as { open: boolean }).open = true;
    page.reopenLetter(kept[0]!.id);
    expect(context['composing']).toBe(a);
    expect([form.to.value, form.subject.value, form.text.value]).toEqual(['ann.lee@studio.example', 'Letter A', 'Important letter A, long and careful.']);
    expect(JSON.parse(stored.get('draft:new')!).text).toBe('Letter B being written');
    // Closed again, it is still kept, with what it is, for a page opened later.
    page.saveDraft();
    (context['composeSheet'] as { open: boolean }).open = false;
    expect(page.keptLetters()).toHaveLength(1);
    // Once B has gone, A is the new letter's draft again, and nothing is kept apart.
    storage.removeItem('draft:new');
    page.settleKept();
    expect(JSON.parse(stored.get('draft:new')!)).toMatchObject({ subject: 'Letter A', text: 'Important letter A, long and careful.' });
    expect(JSON.parse(stored.get('draft:new')!)).not.toHaveProperty('letter');
    expect(page.keptLetters()).toEqual([]);
  });

  it('keeps every word of a letter being written when Undo brings back the one that was counting', () => {
    const { page, context, stored, form, write, fresh } = composer();
    fresh();
    write({ to: 'ann@x.org', subject: 'A', text: 'Letter A.' });
    page.sendCompose();
    const job = context['pendingSend'];
    fresh();
    // Typed a moment ago: not yet saved by the pause after typing.
    write({ text: 'Letter B, typed just now.' });
    page.undoSend(job);
    expect(form.text.value).toBe('Letter A.');
    expect(JSON.parse(stored.get('draft:new')!).text).toBe('Letter B, typed just now.');
  });

  it('opens a letter whose send failed again when nothing else is being written, as before', () => {
    const { page, context, form, write, fresh, toasts } = composer();
    const a = fresh();
    write({ to: 'ann@x.org', subject: 'Hello', text: 'Hi Ann.' });
    page.sendCompose();
    (context['composeSheet'] as { open: boolean }).open = false;
    const job = context['pendingSend'];
    context['pendingSend'] = null;
    page.backToLetter(job, 'Refused.');
    expect(context['composing']).toBe(a);
    expect(form.text.value).toBe('Hi Ann.');
    expect(toasts).toEqual([]);
  });

  /** Draft with AI, its question and its Undo, over a stand-in composer: what is posted, and what the box and the line under it say. */
  function drafting(state: Record<string, unknown>) {
    const posted: Array<Record<string, unknown>> = [];
    let answer: (body: Record<string, unknown>) => Record<string, unknown> = () => ({ ok: true, status: 200, data: { draft: 'Model text.' } });
    const note = node();
    const button = { ...node(), disabled: false, textContent: t('compose.draft') };
    const form = { to: field(), cc: field(), bcc: field(), subject: field(), text: field(), instruction: field() };
    const element = (_tag: string, _cls?: string, text?: string): Record<string, unknown> => ({ ...node(), textContent: text ?? '' });
    const context: Record<string, unknown> = {
      $: () => button, composeForm: form, composeNote: note, composeSheet: { open: true }, pendingSend: null, composing: state,
      t, fill, el: element, textNode: (value: string) => ({ textContent: value }), draftSeq: 0, writing: 0,
      composeSay: (text: string, failed?: boolean) => { note['textContent'] = text; note['children'] = []; note['failed'] = Boolean(failed); },
      post: async (_path: string, body: Record<string, unknown>) => { posted.push(body); return answer(body); },
      failure: (d: { code: string }) => `failure:${d.code}`, reduceMotion: () => true, growText: () => undefined, saveDraft: () => undefined,
    };
    const page = lifted<{ aiDraft: (confirmed?: boolean) => Promise<void> }>(
      ['isAnswer', 'aiDraft', 'askReplace', 'putDraft', 'writeIn'], '({ aiDraft })', context,
    );
    /** Presses the button in the line under the letter that says this. */
    const press = (key: string): void => {
      const found = (note['children'] as Array<Record<string, unknown>>).find((child) => child['textContent'] === t(key));
      expect(found, key).toBeDefined();
      (found!['onclick'] as () => void)();
    };
    return { page, context, posted, note, button, form, press, answerWith: (run: typeof answer) => { answer = run; } };
  }

  it('never puts the model\'s draft in place of words the owner wrote without asking, and always offers the way back', async () => {
    const reply = { mode: 'reply', key: 'k1' };
    // An empty box is filled at once, and can be emptied again.
    const empty = drafting(reply);
    await empty.page.aiDraft();
    expect(empty.form.text.value).toBe('Model text.');
    expect(empty.note['textContent']).toBe(t('compose.drafted'));
    empty.press('undo');
    expect(empty.form.text.value).toBe('');

    // Words of the owner's own: asked first, and nothing goes to the model until the answer is yes.
    const own = drafting(reply);
    own.form.text.value = 'I have a long careful answer here that took me ten minutes to write.';
    own.form.instruction.value = t('chip.thanks');
    await own.page.aiDraft();
    expect(own.posted).toEqual([]);
    expect(own.note['textContent']).toBe(t('compose.replaceAsk'));
    own.press('compose.keepMine');
    expect(own.form.text.value).toBe('I have a long careful answer here that took me ten minutes to write.');
    expect(own.posted).toEqual([]);
    await own.page.aiDraft();
    own.press('compose.replace');
    await vi.waitFor(() => expect(own.form.text.value).toBe('Model text.'));
    expect(own.posted).toHaveLength(1);
    // And the way back gives back exactly what was there.
    own.press('undo');
    expect(own.form.text.value).toBe('I have a long careful answer here that took me ten minutes to write.');

    // Typed on while the model wrote: asked again, with the draft ready, and nothing replaced meanwhile.
    const typing = drafting(reply);
    typing.answerWith(() => { typing.form.text.value = 'Something I typed while waiting.'; return { ok: true, status: 200, data: { draft: 'Model text.' } }; });
    await typing.page.aiDraft();
    expect(typing.form.text.value).toBe('Something I typed while waiting.');
    expect(typing.note['textContent']).toBe(t('compose.draftReady'));
    typing.press('compose.replace');
    expect(typing.form.text.value).toBe('Model text.');
    typing.press('undo');
    expect(typing.form.text.value).toBe('Something I typed while waiting.');
  });

  it('writes a draft only into the letter it was asked for while it is open, never into one sent off meanwhile', async () => {
    const letter = { mode: 'reply', key: 'k1' };
    const page = drafting(letter);
    page.form.text.value = '';
    // Cmd+Enter pressed in the instruction once sent the letter too: here it is sent off while the model writes.
    page.answerWith(() => { page.context['pendingSend'] = { state: letter }; return { ok: true, status: 200, data: { draft: 'Model text.' } }; });
    await page.page.aiDraft();
    expect(page.form.text.value).toBe('');
  });

  it('asks a new letter or a forward for a line instead of asking the server, and says Draft again only after a draft', async () => {
    const fresh = drafting({ mode: 'new', key: '' });
    fresh.form.subject.value = 'Lunch on Friday';
    await fresh.page.aiDraft();
    expect(fresh.posted).toEqual([]);
    expect(fresh.note['textContent']).toBe(t('error.draftNeedsLine'));
    expect(fresh.button['textContent']).toBe(t('compose.draft'));
    const forward = drafting({ mode: 'forward', key: 'k1' });
    await forward.page.aiDraft();
    expect(forward.posted).toEqual([]);
    // Refused: nothing was drafted, so the button still says Draft.
    const refused = drafting({ mode: 'reply', key: 'k1' });
    refused.answerWith(() => ({ ok: false, status: 422, data: { code: 'assistant_refused' } }));
    await refused.page.aiDraft();
    expect(refused.note['textContent']).toBe('failure:assistant_refused');
    expect(refused.button['textContent']).toBe(t('compose.draft'));
    await drafting({ mode: 'reply', key: 'k1' }).page.aiDraft();
  });

  it('keeps Enter in the instruction to drafting, Cmd or Ctrl with it too, and leaves an input method its Enter', () => {
    const drafted: number[] = [];
    const keydown = lifted<(e: Record<string, unknown>) => void>(['instructionKeydown'], 'instructionKeydown', { aiDraft: () => drafted.push(1) });
    const press = (extra: Record<string, unknown>) => {
      const did: string[] = [];
      keydown({ key: 'Enter', preventDefault: () => did.push('prevent'), stopPropagation: () => did.push('stop'), ...extra });
      return did;
    };
    // Cmd+Enter does not reach the form, where it would send the letter.
    expect(press({ metaKey: true })).toEqual(['prevent', 'stop']);
    expect(press({ ctrlKey: true })).toEqual(['prevent', 'stop']);
    expect(drafted).toHaveLength(2);
    // Committing pinyin or kana: the input method's own Enter, not a draft.
    expect(press({ isComposing: true })).toEqual([]);
    expect(press({ keyCode: 229 })).toEqual([]);
    expect(drafted).toHaveLength(2);
  });

  it('leaves the signature open on an Escape that only takes back an input method\'s composition', () => {
    const closed: unknown[] = [];
    const keydown = lifted<(e: Record<string, unknown>, state: unknown, save: unknown) => void>(['signatureKeydown'], 'signatureKeydown', {
      closeSignatureEditor: (state: unknown) => closed.push(state),
    });
    const noop = () => undefined;
    keydown({ key: 'Escape', isComposing: true, preventDefault: noop, stopPropagation: noop }, 'letter', {});
    keydown({ key: 'Escape', keyCode: 229, preventDefault: noop, stopPropagation: noop }, 'letter', {});
    expect(closed).toEqual([]);
    keydown({ key: 'Escape', preventDefault: noop, stopPropagation: noop }, 'letter', {});
    expect(closed).toEqual(['letter']);
  });

  it('stops saying the signature must be saved once it is, and does not send an answer whose message could not be read', () => {
    const note = { textContent: t('compose.sigUnsaved') };
    const state: Record<string, unknown> = { editingSignature: true };
    const withState = lifted<(state: Record<string, unknown>) => void>(['closeSignatureEditor'], 'closeSignatureEditor', {
      composeNote: note, t, composing: state, composeSay: (text: string) => { note.textContent = text; },
      drawSignature: () => undefined, focusSignature: () => undefined,
    });
    withState(state);
    expect(note.textContent).toBe('');
    // Anything else said there stays.
    note.textContent = 'Something else.';
    state['editingSignature'] = true;
    withState(state);
    expect(note.textContent).toBe('Something else.');

    const said: string[] = [];
    const sendCompose = lifted<() => void>(['isAnswer', 'addresses', 'sendCompose'], 'sendCompose', {
      composeSend: { disabled: false }, pendingSend: null, t, fill,
      composeForm: { to: field('someone@example.org'), cc: field(), bcc: field(), subject: field(''), text: field('Hello') },
      composeSay: (text: string) => said.push(text),
      composing: { mode: 'reply', key: 'live:x', replyFailed: 'This message is no longer where the folder listed it.' },
    });
    sendCompose();
    expect(said.at(-1)).toBe(fill('compose.replyUnreadable', { reason: 'This message is no longer where the folder listed it.' }));
  });

  it('sends a letter that has recipients only in Cc or Bcc', () => {
    const { page, context, form, write, fresh, said } = composer();
    fresh();
    write({ subject: 'Hello', text: 'For you both.' });
    form.bcc.value = 'ann.lee@studio.example, bob@acme.example';
    page.sendCompose();
    expect(said).not.toContain(STRINGS.en['compose.needTo']);
    expect((context['pendingSend'] as { payload: { to: string[]; bcc: string[] } }).payload).toMatchObject({ to: [], bcc: ['ann.lee@studio.example', 'bob@acme.example'] });
    // Nobody at all is still asked for.
    fresh();
    write({ subject: 'Hello', text: 'For nobody.' });
    context['pendingSend'] = null;
    page.sendCompose();
    expect(said.at(-1)).toBe(STRINGS.en['compose.needTo']);
  });

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
      renderBars: () => undefined, updateBadge: () => undefined, refreshConversations: () => { redrawn += 1; },
      liveView: null, settleKept: () => undefined,
    };
    let redrawn = 0;
    const deliver = lifted<(job: unknown) => Promise<void>>(['homeId', 'draftId', 'heldFiles', 'keptStates', 'deliver'], 'deliver', context);
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
    // Each letter that left is drawn into the conversation open in the reader at once.
    expect(redrawn).toBe(2);
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
    // No answer of mailsift's own (the connection dropped, a proxy's own error page): it may have gone.
    for (const status of [0, 500, 502, 503]) expect(sendFailure({}, status), String(status)).toBe(t('compose.sendUnknown'));
    expect(t('compose.sendUnknown')).toContain('Look in Sent');
    expect(sendFailure({ code: 'send_connection' }, 502)).toBe('failure:send_connection');
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

describe('suggesting addresses while one is typed', () => {
  it('offers them under To, Cc and Bcc as a list a screen reader can follow', async () => {
    const page = String((await routeWeb(request(), url('/'), '', seeded())).body);
    for (const name of ['to', 'cc', 'bcc']) {
      expect(page).toMatch(new RegExp(`<input name="${name}"[^>]*role="combobox" aria-autocomplete="list" aria-controls="compose-suggest" aria-expanded="false"`));
    }
    expect(page).toContain('<ul id="compose-suggest" class="suggest" role="listbox" aria-label="Suggested addresses" data-i18n-label="compose.suggestions" hidden></ul>');
    const chinese = String((await routeWeb(request({ headers: { 'accept-language': 'zh-CN' } }), url('/'), '', seeded())).body);
    expect(chinese).toContain('aria-label="建议的地址"');
    // Escape on the list shuts the list, not the letter.
    expect(clientScript()).toContain('if (dialog === composeSheet && suggestionsTookEscape()) return;');
  });

  it('puts the address in place of what is being typed, with a separator after it', () => {
    const page = lifted<{
      tokenAround: (value: string, caret: number) => { start: number; end: number; text: string };
      acceptAddress: (value: string, caret: number, address: string) => { value: string; caret: number };
    }>(['tokenAround', 'acceptAddress'], '({ tokenAround, acceptAddress })');
    expect(page.tokenAround('bob@x.org, an', 13)).toEqual({ start: 10, end: 13, text: 'an' });
    expect(page.acceptAddress('an', 2, 'ann@acme.example')).toEqual({ value: 'ann@acme.example, ', caret: 18 });
    expect(page.acceptAddress('bob@x.org, an', 13, 'ann@acme.example'))
      .toEqual({ value: 'bob@x.org, ann@acme.example, ', caret: 29 });
    // In the middle of the line only the address typed there is replaced, whatever separates them.
    const middle = 'a@b.co; jo, c@d.co';
    expect(page.acceptAddress(middle, middle.indexOf('jo') + 2, 'john@x.org'))
      .toEqual({ value: 'a@b.co; john@x.org, c@d.co', caret: 20 });
    // What the send path makes of it: the bare addresses, each once.
    const addresses = lifted<(value: string) => string[]>(['addresses'], 'addresses');
    expect(addresses(page.acceptAddress(middle, 10, 'john@x.org').value)).toEqual(['a@b.co', 'john@x.org', 'c@d.co']);
  });

  it('moves with the arrows, accepts with Enter or Tab, shuts with Escape, and leaves an IME its keys', () => {
    const decide = lifted<(key: string, open: boolean, count: number, active: number, composing: boolean) => { act: string; active: number }>(
      ['suggestKey'], 'suggestKey',
    );
    expect(decide('ArrowDown', true, 3, 0, false)).toEqual({ act: 'move', active: 1 });
    expect(decide('ArrowDown', true, 3, 2, false)).toEqual({ act: 'move', active: 0 });
    expect(decide('ArrowUp', true, 3, 0, false)).toEqual({ act: 'move', active: 2 });
    expect(decide('Enter', true, 3, 1, false)).toEqual({ act: 'accept', active: 1 });
    expect(decide('Tab', true, 3, 2, false)).toEqual({ act: 'accept', active: 2 });
    expect(decide('Escape', true, 3, 0, false)).toEqual({ act: 'close', active: 0 });
    expect(decide('a', true, 3, 0, false).act).toBe('');
    // Shut, the keys are the field's own; ArrowDown asks for the list.
    expect(decide('Enter', false, 0, 0, false).act).toBe('');
    expect(decide('Escape', false, 0, 0, false).act).toBe('');
    expect(decide('ArrowDown', false, 0, 0, false).act).toBe('open');
    for (const key of ['Enter', 'ArrowDown', 'Escape', 'Tab']) expect(decide(key, true, 3, 0, true).act, key).toBe('');
  });

  it('never lets Enter on the list send the letter or reach the form', () => {
    const done: string[] = [];
    const field = { name: 'to', value: 'an', selectionStart: 2 };
    const context: Record<string, unknown> = {
      suggest: {
        field, items: [{ address: 'ann@acme.example' }, { address: 'anand@acme.example' }], active: 0, escapedAt: 0,
        token: { start: 0, text: 'an' },
      },
      suggestList: { hidden: false },
      acceptSuggestion: (i: number) => done.push(`accept ${i}`),
      closeSuggest: () => { done.push('close'); return true; },
      markSuggest: () => done.push('mark'),
      lookUpAddresses: () => done.push('look up'),
    };
    const keydown = lifted<(e: Record<string, unknown>) => void>(['tokenAround', 'listFits', 'suggestKey', 'suggestKeydown'], 'suggestKeydown', context);
    const press = (key: string, extra: Record<string, unknown> = {}) => {
      const said = { prevented: 0, stopped: 0 };
      keydown({ key, target: field, preventDefault: () => { said.prevented += 1; }, stopPropagation: () => { said.stopped += 1; }, ...extra });
      return said;
    };
    done.length = 0;
    expect(press('Enter')).toEqual({ prevented: 1, stopped: 1 });
    expect(done).toEqual(['accept 0']);
    // Text being composed with an IME: Enter is the IME's, and nothing is taken.
    done.length = 0;
    expect(press('Enter', { isComposing: true })).toEqual({ prevented: 0, stopped: 0 });
    expect(press('Enter', { keyCode: 229 })).toEqual({ prevented: 0, stopped: 0 });
    expect(done).toEqual([]);
    // Ctrl or Cmd with Enter is the send shortcut, and goes on to the form; the list shuts.
    expect(press('Enter', { ctrlKey: true })).toEqual({ prevented: 0, stopped: 0 });
    expect(press('Enter', { metaKey: true })).toEqual({ prevented: 0, stopped: 0 });
    expect(done).toEqual(['close', 'close']);
    done.length = 0;
    expect(press('ArrowDown')).toEqual({ prevented: 1, stopped: 1 });
    expect((context['suggest'] as { active: number }).active).toBe(1);
    expect(press('Tab')).toEqual({ prevented: 1, stopped: 1 });
    expect(done).toEqual(['mark', 'accept 1']);
    done.length = 0;
    expect(press('Tab', { shiftKey: true })).toEqual({ prevented: 0, stopped: 0 });
    expect(press('Escape')).toEqual({ prevented: 1, stopped: 1 });
    expect(done).toEqual(['close', 'close']);
    expect((context['suggest'] as { escapedAt: number }).escapedAt).toBeGreaterThan(0);
    // With the list shut, Enter is left alone (the form never submits) and ArrowDown asks again.
    (context['suggestList'] as { hidden: boolean }).hidden = true;
    done.length = 0;
    expect(press('Enter')).toEqual({ prevented: 0, stopped: 0 });
    expect(press('ArrowDown')).toEqual({ prevented: 1, stopped: 1 });
    expect(done).toEqual(['look up']);
    // Nothing typed: Down is the field's own.
    field.value = '';
    field.selectionStart = 0;
    expect(press('ArrowDown')).toEqual({ prevented: 0, stopped: 0 });
    expect(done).toEqual(['look up']);
  });

  it('never puts a suggestion in place of something else than what it was drawn for', () => {
    const done: string[] = [];
    const field = { name: 'to', value: 'boris@new.example', selectionStart: 17, focus: () => undefined, setSelectionRange: () => undefined };
    // The list still on show was drawn for "bo", typed before the rest of the address.
    const context: Record<string, unknown> = {
      suggest: { field, items: [{ address: 'bob@acme.example', name: 'Bob Stone' }], active: 0, escapedAt: 0, token: { start: 0, text: 'bo' } },
      suggestList: { hidden: false },
      closeSuggest: () => { done.push('close'); (context['suggestList'] as { hidden: boolean }).hidden = true; return true; },
      markSuggest: () => done.push('mark'), lookUpAddresses: () => done.push('look up'),
      draftTimer: 0, clearTimeout: () => undefined, setTimeout: () => 0, saveDraft: () => undefined,
    };
    const page = lifted<{ keydown: (e: Record<string, unknown>) => void; accept: (i: number) => void }>(
      ['tokenAround', 'acceptAddress', 'listFits', 'suggestKey', 'acceptSuggestion', 'suggestKeydown'],
      '({ keydown: suggestKeydown, accept: acceptSuggestion })', context,
    );
    const press = (key: string) => {
      const said = { prevented: 0 };
      page.keydown({ key, target: field, preventDefault: () => { said.prevented += 1; }, stopPropagation: () => undefined });
      return said;
    };
    // Tab moves on, as it would with no list, and the address typed stays.
    expect(press('Tab')).toEqual({ prevented: 0 });
    expect(field.value).toBe('boris@new.example');
    expect(done).toEqual(['close']);
    // Enter on it likewise, and a press on one of its rows.
    (context['suggestList'] as { hidden: boolean }).hidden = false;
    expect(press('Enter')).toEqual({ prevented: 0 });
    (context['suggestList'] as { hidden: boolean }).hidden = false;
    page.accept(0);
    expect(field.value).toBe('boris@new.example');
    // The caret moved back to another address: the list for the old one is shut, and so is its Enter.
    field.value = 'boris@new.example, an';
    field.selectionStart = 21;
    (context['suggest'] as Record<string, unknown>)['token'] = { start: 18, text: 'an' };
    (context['suggestList'] as { hidden: boolean }).hidden = false;
    done.length = 0;
    expect(press('Home')).toEqual({ prevented: 0 });
    expect(done).toEqual(['close']);
    field.selectionStart = 0;
    (context['suggestList'] as { hidden: boolean }).hidden = false;
    expect(press('Enter')).toEqual({ prevented: 0 });
    expect(field.value).toBe('boris@new.example, an');
    // Escape on a list left over still only shuts the list.
    (context['suggestList'] as { hidden: boolean }).hidden = false;
    expect(press('Escape')).toEqual({ prevented: 1 });
  });

  it('narrows the list at once as the address is typed on, and shuts it when nothing fits', () => {
    const shown: Array<{ items: Array<{ address: string }>; token: unknown }> = [];
    let closed = 0;
    const field = { value: 'an', selectionStart: 2 };
    const context: Record<string, unknown> = {
      suggest: {
        field, active: 1, token: { start: 0, text: 'an' },
        items: [{ address: 'ann@acme.example', name: 'Ann Lee' }, { address: 'anand@acme.example', name: 'Anand Rao' }],
      },
      suggestList: { hidden: false },
      showSuggest: (_f: unknown, items: Array<{ address: string }>, token: unknown) => shown.push({ items, token }),
      closeSuggest: () => { closed += 1; return true; },
    };
    const narrow = lifted<(f: unknown) => void>(['tokenAround', 'fitsQuery', 'highlightIn', 'narrowSuggest'], 'narrowSuggest', context);
    field.value = 'ana';
    field.selectionStart = 3;
    narrow(field);
    expect(shown.at(-1)!.items.map((c) => c.address)).toEqual(['anand@acme.example']);
    expect(shown.at(-1)!.token).toMatchObject({ start: 0, text: 'ana' });
    field.value = 'anx';
    narrow(field);
    expect(closed).toBe(1);
  });

  it('keeps the person picked when the server\'s answer for the same text redraws the list', async () => {
    const field = { value: 'bo', selectionStart: 2 };
    const boris = { address: 'boris@old.example' }, bob = { address: 'bob@b.example' }, bonnie = { address: 'bonnie@lee.example' };
    let later: (() => Promise<void>) | undefined;
    const drawn: Array<{ items: unknown[]; active: number }> = [];
    const context: Record<string, unknown> = {
      // Down, Down: Bonnie is picked in the list drawn for "bo" before the server answered.
      suggest: { field, items: [boris, bob, bonnie], active: 2, seq: 0, timer: null, token: { start: 0, text: 'bo' } },
      suggestList: { hidden: false },
      document: { activeElement: field },
      fetch: async () => ({ ok: true, json: async () => ({ contacts: [boris, bonnie, bob, { address: 'bonita@x.example' }] }) }),
      setTimeout: (run: () => Promise<void>) => { later = run; return 1; }, clearTimeout: () => undefined,
      closeSuggest: () => true, takenAddresses: () => new Set(),
      showSuggest: (_f: unknown, items: unknown[], _token: unknown, active: number) => drawn.push({ items, active }),
      encodeURIComponent,
    };
    const lookUp = lifted<(f: unknown, now: boolean) => void>(['tokenAround', 'highlightIn', 'lookUpAddresses'], 'lookUpAddresses', context);
    lookUp(field, false);
    await later!();
    expect(drawn).toHaveLength(1);
    expect((drawn[0]!.items as Array<{ address: string }>)[drawn[0]!.active]!.address).toBe('bonnie@lee.example');
    // With no list on show, the first is the one highlighted.
    (context['suggestList'] as { hidden: boolean }).hidden = true;
    lookUp(field, false);
    await later!();
    expect(drawn[1]!.active).toBe(0);
  });

  it('narrows names in any Unicode form as the server matches them', () => {
    const fits = lifted<(c: unknown, q: string) => boolean>(['fitsQuery'], 'fitsQuery');
    expect(fits({ address: 'tanaka@corp.jp', name: 'Ｍｉｋａ Ｔａｎａｋａ' }, 'mik')).toBe(true);
    expect(fits({ address: 'tanaka@corp.jp', name: 'Ｍｉｋａ Ｔａｎａｋａ' }, 'tan')).toBe(true);
    expect(fits({ address: 't@corp.jp', name: 'ﾀﾅｶ' }, 'タナ')).toBe(true);
    expect(fits({ address: 'em@x.fr', name: 'E\u0301lise' }, 'élise')).toBe(true);
    expect(fits({ address: 'tanaka@corp.jp', name: 'Ｍｉｋａ Ｔａｎａｋａ' }, 'mix')).toBe(false);
  });

  it('keeps the letter open on the Escape that shut the list, and only on that one', () => {
    const context: Record<string, unknown> = { suggest: { escapedAt: 0 }, closeSuggest: () => false, Date };
    const took = lifted<() => boolean>(['suggestionsTookEscape'], 'suggestionsTookEscape', context);
    expect(took()).toBe(false);
    (context['suggest'] as { escapedAt: number }).escapedAt = Date.now();
    expect(took()).toBe(true);
    context['closeSuggest'] = () => true;
    (context['suggest'] as { escapedAt: number }).escapedAt = 0;
    expect(took()).toBe(true);
  });
});

describe('the conversation in the reader', () => {
  it('says nothing when the thread holds only the message, and marks the reader\'s own messages as theirs', () => {
    const t = (key: string): string => STRINGS.en[key as StringKey] ?? key;
    const fill = (key: string, vars: Record<string, unknown> = {}): string =>
      Object.entries(vars).reduce((text, [name, value]) => text.split(`{${name}}`).join(String(value)), t(key));
    /** As much of an element as the conversation's code touches. */
    function node(tag = 'div', cls?: string, text?: string): Record<string, unknown> {
      const self: Record<string, unknown> = {
        tag, className: cls ?? '', textContent: text ?? '', hidden: false, children: [] as unknown[], attrs: {} as Record<string, string>,
        appendChild: (child: unknown) => { (self['children'] as unknown[]).push(child); return child; },
        replaceChildren: () => { self['children'] = []; self['redrawn'] = Number(self['redrawn'] ?? 0) + 1; },
        setAttribute: (name: string, value: string) => { (self['attrs'] as Record<string, string>)[name] = value; },
        dataset: {}, contains: () => false,
      };
      Object.defineProperty(self, 'childNodes', { get: () => self['children'] });
      return self;
    }
    const text = (n: Record<string, unknown>): string =>
      String(n['textContent'] ?? '') + (n['children'] as Array<Record<string, unknown>>).map(text).join('');
    const context: Record<string, unknown> = {
      t, fill, DOT: ' · ', NB: ' ', el: (tag: string, cls?: string, value?: string) => node(tag, cls, value),
      textNode: (value: string) => node('#text', undefined, value), dayLabel: () => 'Today', hhmm: () => '10:00',
      textBody: (value: string) => node('div', 'mail-text', value), extraRows: new Map(), openDetail: () => undefined,
      rowKey: (m: { dedupKey?: string }) => m.dedupKey ?? '', sentOpen: new Set(), lang: 'en', document: { activeElement: null },
    };
    const draw = lifted<(entry: unknown, d: unknown) => void>(
      ['bareSubject', 'newSubject', 'whenLine', 'receivedItem', 'peopleLine', 'sentItem', 'fillSent', 'conversationSignature', 'drawConversation'],
      'drawConversation', context,
    );
    const current = { dedupKey: 'k2', subject: 'Lunch?' };
    const alone = { section: node('section'), row: current };
    draw(alone, { messages: [{ direction: 'in', current: true, dedupKey: 'k2', at: '2026-11-17T10:00:00Z' }] });
    expect(alone.section['hidden']).toBe(true);

    const entry = { section: node('section'), row: current };
    draw(entry, {
      omitted: 0,
      messages: [
        { direction: 'in', current: true, dedupKey: 'k2', at: '2026-11-17T09:00:00Z' },
        {
          direction: 'out', id: 7, at: '2026-11-17T10:00:00Z', subject: 'Re: Lunch?', excerpt: 'Thursday works.', text: 'Thursday works.',
          to: [{ name: 'Ann', address: 'ann@example.org' }], cc: [], bcc: [{ name: '', address: 'boss@qq.com' }], attachments: { count: 0 },
        },
      ],
    });
    expect(entry.section['hidden']).toBe(false);
    const said = text(entry.section);
    expect(said).toContain('Conversation · 2');
    expect(said).toContain('This message');
    expect(said).toContain('You · to Ann · Today 10:00');
    expect(said).toContain('Thursday works.');
    // "Re:" the same subject is not said again.
    expect(said).not.toContain('Re: Lunch?');
    const yours = ((entry.section['children'] as Array<Record<string, unknown>>)[1]!['children'] as Array<Record<string, unknown>>)[1]!;
    expect(yours['className']).toBe('tl-yours');
    const button = (yours['children'] as Array<Record<string, unknown>>)[0]!;
    expect((button['attrs'] as Record<string, string>)['aria-expanded']).toBe('false');
    // Opened in place: what was written, and whom it went to, Bcc included.
    (button['onclick'] as () => void)();
    expect((button['attrs'] as Record<string, string>)['aria-expanded']).toBe('true');
    expect(text((yours['children'] as Array<Record<string, unknown>>)[1]!)).toContain('boss@qq.com');

    // The same answer again (a live event about other mail) leaves the drawn timeline, and its focus, alone.
    const before = entry.section['redrawn'];
    draw(entry, { omitted: 0, messages: [
      { direction: 'in', current: true, dedupKey: 'k2', at: '2026-11-17T09:00:00Z' },
      {
        direction: 'out', id: 7, at: '2026-11-17T10:00:00Z', subject: 'Re: Lunch?', excerpt: 'Thursday works.', text: 'Thursday works.',
        to: [{ name: 'Ann', address: 'ann@example.org' }], cc: [], bcc: [{ name: '', address: 'boss@qq.com' }], attachments: { count: 0 },
      },
    ] });
    expect(entry.section['redrawn']).toBe(before);
    // Something new in it is drawn, and says how many more the conversation holds, in the singular when one.
    draw(entry, { omitted: 1, messages: [{ direction: 'in', current: true, dedupKey: 'k2', at: '2026-11-17T09:00:00Z' }, {
      direction: 'in', dedupKey: 'k3', at: '2026-11-17T11:00:00Z', senderName: 'Ann', summary: 'See you then.',
    }] });
    expect(entry.section['redrawn']).toBe(Number(before) + 1);
    expect(text(entry.section)).toContain('1 more message in this conversation is not shown');
    expect(text(entry.section)).toContain('Conversation · 3');
    expect(STRINGS['zh-CN']['conv.omitted1']).toBeTruthy();

    // An older message opened: the gap after it is marked where it is, and the top line counts only the rest.
    const older = { section: node('section'), row: { dedupKey: 'k1', subject: 'Lunch?' } };
    draw(older, { omitted: 5, between: 3, messages: [
      { direction: 'in', current: true, dedupKey: 'k1', at: '2026-11-10T09:00:00Z' },
      { direction: 'in', dedupKey: 'k9', at: '2026-11-17T11:00:00Z', senderName: 'Ann', summary: 'Any news?' },
    ] });
    const items = ((older.section['children'] as Array<Record<string, unknown>>)[2]!['children'] as Array<Record<string, unknown>>);
    expect(items.map((li) => li['className'])).toEqual(['tl-current', 'tl-gap', '']);
    expect(text(items[1]!)).toBe('3 messages after this one are not shown');
    expect(text(older.section)).toContain('2 more messages in this conversation are not shown');
  });

  it('asks about a withheld message\'s judgement as about a notified one\'s, and says why it was not notified', () => {
    const t = (key: string): string => STRINGS.en[key as StringKey] ?? key;
    const made: Array<{ text: string }> = [];
    const el = (_tag: string, _cls?: string, text?: string) => {
      const node = { text: text ?? '', children: [] as unknown[], appendChild(child: unknown) { this.children.push(child); return child; }, replaceChildren() {} };
      made.push(node);
      return node;
    };
    const line = lifted<(row: unknown) => void>(['feedbackLine'], 'feedbackLine', { el, t, fill: t, post: async () => ({ ok: true, data: {} }) });
    line({ pushed: false, withheld: true, sender: 'ann@example.org' });
    expect(made.map((n) => n.text)).toContain('Should not have notified');
    expect(made.map((n) => n.text)).not.toContain('Should have notified');
    expect(clientScript()).toContain("else if (row.withheld) judged += DOT + t('detail.withheld');");
    expect(clientScript()).toContain("else if (m.withheld) add(t('row.withheld'));");
    for (const key of ['detail.withheld', 'row.withheld', 'conv.between', 'conv.between1'] as const) {
      expect(STRINGS['zh-CN'][key], key).toBeTruthy();
    }
  });

  it('puts the keyboard back where it was when the timeline is drawn again', () => {
    const script = clientScript();
    expect(script).toContain("open.dataset.conv = 'in:' + rowKey(m);");
    expect(script).toContain("open.dataset.conv = 'out:' + m.id;");
    expect(script).toContain('const again = section.querySelector(\'[data-conv="\' + CSS.escape(focused) + \'"]\');');
  });

  it('asks for no conversation for a reader already left behind', () => {
    let asked = 0;
    const context: Record<string, unknown> = {
      fetch: () => { asked += 1; return new Promise(() => undefined); }, conversations: new Map(), Date,
      drawConversation: () => undefined,
    };
    const load = lifted<(entry: unknown, fresh: boolean) => void>(['showKnownConversation', 'loadConversation'], 'loadConversation', context);
    load({ key: 'k1', section: { isConnected: false } }, false);
    load({ key: 'k1', section: { isConnected: false } }, true);
    expect(asked).toBe(0);
    load({ key: 'k1', section: { isConnected: true } }, false);
    expect(asked).toBe(1);
    expect(clientScript()).toContain('setTimeout(() => { if (conversation.section.isConnected) loadConversation(conversation, false); }, 300);');
  });
});

describe('putting a message off until later', () => {
  /** The page's words in one language, filled in as the page fills them. */
  const words = (lang: 'en' | 'zh-CN') => {
    const t = (key: string): string => STRINGS[lang][key as StringKey] ?? key;
    const fill = (key: string, vars: Record<string, unknown> = {}): string =>
      Object.entries(vars).reduce((text, [name, value]) => text.split(`{${name}}`).join(String(value)), t(key));
    return { t, fill, lang };
  };
  type Choice = { key: string; at: Date };
  const choicesAt = (now: Date): Array<[string, string]> => lifted<(now: Date) => Choice[]>(['snoozeChoices'], 'snoozeChoices')(now)
    .map((c) => [c.key.replace('snooze.', ''), `${c.at.getDate()} ${String(c.at.getHours()).padStart(2, '0')}:${String(c.at.getMinutes()).padStart(2, '0')}`]);

  it('offers the times that make sense from where the day is, on the device\'s own clock', () => {
    // Saturday 14 November 2026, early: three hours on to the next quarter hour, the evening, tomorrow, Monday.
    expect(choicesAt(new Date(2026, 10, 14, 5, 40))).toEqual([
      ['laterToday', '14 08:45'], ['evening', '14 19:00'], ['tomorrow', '15 09:00'], ['nextWeek', '16 09:00'],
    ]);
    // On a quarter hour, it stays on it.
    expect(choicesAt(new Date(2026, 10, 14, 9, 15))[0]).toEqual(['laterToday', '14 12:15']);
    // Three hours on would be no sooner than the evening that is also offered: only the evening.
    expect(choicesAt(new Date(2026, 10, 14, 16, 10)).map(([key]) => key)).toEqual(['evening', 'tomorrow', 'nextWeek']);
    // After five the evening is no longer offered; after eight, nothing more today.
    expect(choicesAt(new Date(2026, 10, 14, 17, 30)).slice(0, 2)).toEqual([['laterToday', '14 20:30'], ['tomorrow', '15 09:00']]);
    expect(choicesAt(new Date(2026, 10, 14, 20, 0)).map(([key]) => key)).toEqual(['tomorrow', 'nextWeek']);
    // On a Sunday, Monday morning is tomorrow morning, offered once.
    expect(choicesAt(new Date(2026, 10, 15, 10, 0)).map(([key]) => key)).toEqual(['laterToday', 'evening', 'tomorrow']);
    // On a Monday, next week is a week on.
    expect(choicesAt(new Date(2026, 10, 16, 10, 0)).at(-1)).toEqual(['nextWeek', '23 09:00']);
  });

  it('says each time as the reader would, in both languages', () => {
    const now = new Date(2026, 10, 14, 5, 40);
    for (const [lang, today, tomorrow, inSentence, weekday, far] of [
      ['en', '08:45', 'Tomorrow 09:00', 'tomorrow 09:00', 'Mon 09:00', /^Nov 30 09:00$/],
      ['zh-CN', '今天 08:45', '明天 09:00', '明天 09:00', '周一 09:00', /^11月30日 09:00$/],
    ] as const) {
      const say = lifted<(d: Date, now: Date, inSentence?: boolean) => string>(
        ['pad', 'hhmm', 'dayKey', 'whenLabel'], 'whenLabel', words(lang),
      );
      expect(say(new Date(2026, 10, 14, 8, 45), now)).toBe(today);
      expect(say(new Date(2026, 10, 15, 9, 0), now)).toBe(tomorrow);
      expect(say(new Date(2026, 10, 15, 9, 0), now, true)).toBe(inSentence);
      expect(say(new Date(2026, 10, 16, 9, 0), now)).toBe(weekday);
      expect(say(new Date(2026, 10, 30, 9, 0), now)).toMatch(far);
    }
    expect(words('en').fill('snooze.toast', { when: 'tomorrow 09:00' })).toBe('Reminder set for tomorrow 09:00');
    expect(words('zh-CN').fill('snooze.toast', { when: '明天 09:00' })).toBe('将于明天 09:00 提醒你');
    expect(words('en').fill('snooze.later', { count: 2 })).toBe('Later · 2');
    expect(words('zh-CN').fill('snooze.later', { count: 2 })).toBe('稍后 · 2');
  });

  it('offers the morning to come in the small hours, and no reminder in the night', () => {
    // Sunday 15 November 2026, ten past midnight: nothing at three in the morning, and the
    // morning meant is this one; Monday is then a choice of its own. Soonest first.
    expect(choicesAt(new Date(2026, 10, 15, 0, 10))).toEqual([
      ['morning', '15 09:00'], ['evening', '15 19:00'], ['nextWeek', '16 09:00'],
    ]);
    // A minute before five, three hours on is already morning.
    expect(choicesAt(new Date(2026, 10, 15, 4, 59))).toEqual([
      ['laterToday', '15 08:00'], ['morning', '15 09:00'], ['evening', '15 19:00'], ['nextWeek', '16 09:00'],
    ]);
    // From five, tomorrow morning is tomorrow's again.
    expect(choicesAt(new Date(2026, 10, 15, 5, 0)).map(([key]) => key)).toEqual(['laterToday', 'evening', 'tomorrow']);
    expect(words('en').t('snooze.morning')).toBe('This morning');
    expect(words('zh-CN').t('snooze.morning')).toBe('今天上午');
  });

  it('names a weekday across New Year without the year, and a date in another year with it', () => {
    const now = new Date(2026, 11, 30, 10, 0);
    for (const [lang, monday, far] of [
      ['en', 'Mon 09:00', /^Jan 20, 2027 09:00$/],
      ['zh-CN', '周一 09:00', /^2027年1月20日 09:00$/],
    ] as const) {
      const say = lifted<(d: Date, now: Date, inSentence?: boolean) => string>(
        ['pad', 'hhmm', 'dayKey', 'whenLabel'], 'whenLabel', words(lang),
      );
      expect(say(new Date(2027, 0, 4, 9, 0), now)).toBe(monday);
      expect(say(new Date(2027, 0, 20, 9, 0), now)).toMatch(far);
    }
    // "Next week" from the 30th of December is that Monday, said the same way.
    expect(choicesAt(now).at(-1)).toEqual(['nextWeek', '4 09:00']);
  });

  it('undoes to the time a message had while it is to come, to none if it had none, and back now if it came', () => {
    const undoTo = lifted<(before: string | null) => Date | string | null>(['snoozeUndoTo'], 'snoozeUndoTo');
    const ahead = new Date(Date.now() + 3_600_000);
    expect(undoTo(null)).toBeNull();
    expect((undoTo(ahead.toISOString()) as Date).getTime()).toBe(ahead.getTime());
    // A reminder that had come: putting it back means bringing it back, never taking the reminder away.
    expect(undoTo(new Date(Date.now() - 20 * 60_000).toISOString())).toBe('now');
    const script = clientScript();
    expect(script).toContain("if (row && isSnoozed(row)) choice(t('snooze.now'), null, () => go('now'));");
    expect(script).toContain("const go = run || ((at) => snooze(key, at));");
    expect(script).toContain('run: () => snooze(key, snoozeUndoTo(before), true)');
    expect(words('en').t('snooze.back')).toBe('Back in Needs you');
    expect(words('zh-CN').t('snooze.back')).toBe('已放回待你处理');
  });

  it('says in Chinese that a reminder can be at most a year ahead, not at least', () => {
    expect(words('zh-CN').t('error.snoozeFar')).toBe('提醒最多只能设在一年以内。');
    expect(words('zh-CN').t('error.snoozeFar')).not.toContain('以后');
  });

  it('keeps a popover on its control when the control is drawn again, and in place when it is gone', () => {
    type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };
    const box = (left: number, top: number): Box => ({ left, right: left + 32, top, bottom: top + 32, width: 32, height: 32 });
    const control = (rect: Box, connected = true) => {
      const attrs: Record<string, string> = {};
      return {
        isConnected: connected, id: '', dataset: { act: 'snooze' } as Record<string, string>, attrs,
        getBoundingClientRect: () => rect,
        setAttribute: (name: string, value: string) => { attrs[name] = value; },
        closest: () => null, parentElement: null,
      };
    };
    const popovers = new Map<unknown, Record<string, unknown>>();
    const props: Record<string, string> = {};
    const dialog = {
      open: true, scrollHeight: 200,
      classList: { toggle: () => undefined },
      style: { setProperty: (name: string, value: string) => { props[name] = value; } },
    };
    let successor: ReturnType<typeof control> | null = null;
    const place = lifted<(d: unknown) => void>(['anchorOf', 'placePopover'], 'placePopover', {
      popovers, window: { innerHeight: 800, scrollX: 0, scrollY: 0 },
      document: { documentElement: { clientWidth: 1200 } },
    });
    const first = control(box(500, 100));
    popovers.set(dialog, { anchor: first, width: 320, align: 'end', fixed: true, flip: false, find: () => successor });
    place(dialog);
    const where = { ...props };
    expect(where['--pop-top']).toBe('142px');

    // The bar was drawn again: the old control is gone and nothing stands in its place yet.
    first.isConnected = false;
    for (const name of Object.keys(props)) delete props[name];
    place(dialog);
    expect(props).toEqual({});
    // Its successor, where the bar now puts it: the popover follows it, and it is marked open.
    successor = control(box(520, 100));
    place(dialog);
    expect(popovers.get(dialog)!['anchor']).toBe(successor);
    expect(successor.attrs['aria-expanded']).toBe('true');
    expect(props['--pop-top']).toBe(where['--pop-top']);
    expect(Number.parseFloat(props['--pop-left']!)).toBeGreaterThan(Number.parseFloat(where['--pop-left']!));

    // Where its successor is looked for: the same act in the same bar, or in the same row.
    const asked: string[] = [];
    const finder = lifted<(anchor: unknown) => (() => unknown) | null>(['anchorFinder'], 'anchorFinder', {
      CSS: { escape: (value: string) => value },
      document: { querySelector: (selector: string) => { asked.push(selector); return null; }, getElementById: (id: string) => { asked.push(`id:${id}`); return null; } },
    });
    const inBar = { id: '', dataset: { act: 'snooze' }, parentElement: { closest: () => ({ id: 'pane-bar' }) }, closest: () => null };
    const inRow = { id: '', dataset: { act: 'snooze' }, parentElement: { closest: () => ({ id: 'queue' }) }, closest: () => ({ dataset: { key: 'k1' } }) };
    finder(inBar)!();
    finder(inRow)!();
    finder({ id: 'bell', dataset: {} })!();
    expect(asked).toEqual(['#pane-bar [data-act="snooze"]', '#queue li.row[data-key="k1"] [data-act="snooze"]', 'id:bell']);
    expect(finder({ id: '', dataset: {}, parentElement: { closest: () => ({ id: 'x' }) }, closest: () => null })).toBeNull();
  });

  it('holds a datetime field to this device\'s own time, to the minute', () => {
    const local = lifted<(d: Date) => string>(['pad', 'localInput'], 'localInput');
    expect(local(new Date(2026, 0, 5, 7, 3, 59))).toBe('2026-01-05T07:03');
  });

  it('counts a message put off as still to come only while it is, and not once it is done', () => {
    const isSnoozed = lifted<(m: Record<string, unknown> | null) => boolean>(['isSnoozed'], 'isSnoozed');
    const later = new Date(Date.now() + 60_000).toISOString();
    expect(isSnoozed({ snoozedUntil: later, handledAt: null })).toBe(true);
    expect(isSnoozed({ snoozedUntil: new Date(Date.now() - 60_000).toISOString(), handledAt: null })).toBe(false);
    expect(isSnoozed({ snoozedUntil: later, handledAt: new Date().toISOString() })).toBe(false);
    expect(isSnoozed({ snoozedUntil: null, handledAt: null })).toBe(false);
    expect(isSnoozed(null)).toBe(false);
  });

  it('offers it in the reader, on b, and in the list of keys, and opens it as a panel under its control', async () => {
    const script = clientScript();
    const page = String((await routeWeb(request(), url('/'), '', seeded())).body);
    expect(page).toContain('<dialog id="snooze-sheet" class="sheet bare" aria-labelledby="snooze-title" tabindex="-1">');
    expect(page).toContain('<symbol id="i-clock" viewBox="0 0 24 24">');
    expect(script).toContain("item('i-clock', t('act.snooze'), () => {");
    expect(script).toContain("['b', 'keys.snooze']");
    expect(script).toContain("else if (e.key === 'b' && !row.handledAt && markable) {");
    expect(script).toContain('openPopover(snoozeSheet, anchor, {');
    // The queue's own line for it, beside what was done, and the server told by the route for it.
    expect(script).toContain("fill('snooze.later', { count: later.length + laterExtra })");
    expect(script).toContain("post('/api/snooze', { key, until })");
  });

  it('lists what is put off with the queue, soonest first, and shows it nowhere in the queue', async () => {
    const store = seeded();
    store.setSnoozed('k3', new Date(Date.now() + 2 * 3_600_000).toISOString());
    store.setSnoozed('k1', new Date(Date.now() + 3_600_000).toISOString());
    const queue = await body('/api/attention', store);
    expect(queue['count']).toBe(0);
    expect((queue['snoozed'] as Array<{ dedupKey: string }>).map((m) => m.dedupKey)).toEqual(['k1', 'k3']);
    expect((queue['snoozed'] as Array<Record<string, unknown>>)[0]).toHaveProperty('provider');
    // The list itself still has them, each carrying when it comes back.
    const mail = (await body('/api/mail', store))['mail'] as Array<{ dedupKey: string; snoozedUntil: string | null }>;
    expect(mail.find((m) => m.dedupKey === 'k1')?.snoozedUntil).toEqual(expect.any(String));
  });
});

describe('the rest of the mailbox in the page', () => {
  const words = (lang: 'en' | 'zh-CN') => {
    const t = (key: string): string => STRINGS[lang][key as StringKey] ?? key;
    return { t, lang, STRINGS };
  };

  it('offers the folders under their control, a line that says a list is live, and a quiet way to search the mailbox', async () => {
    const page = String((await routeWeb(request(), url('/'), '', seeded())).body);
    expect(page).toContain('<dialog id="folder-sheet" class="sheet bare" aria-labelledby="folder-title" tabindex="-1">');
    expect(page).toMatch(/<button id="folders-open" type="button" class="icon-btn" aria-label="Folders"[^>]*aria-controls="folder-sheet"/);
    expect(page).toMatch(/<div id="live-head" class="live-head" hidden><button id="live-back"[^>]*aria-label="Back to the triaged mail"/);
    expect(page).toContain('<div id="live-note" class="live-note" role="status" hidden></div>');
    const script = clientScript();
    // The offer to search the mailbox is drawn at the end of the list, so typing never moves it in.
    expect(page).not.toContain('id="mailbox-search"');
    expect(script).toContain('const offer = mailboxOffer();');
    expect(script).toContain("openPopover(folderSheet, anchor, { width: 340, align: 'start', history: !isWide() });");
    expect(script).toContain("['g', 'keys.folders']");
    expect(script).toContain("fetch((view.mode === 'search' ? '/api/search?' : '/api/folder?') + p.toString(), abort ? { signal: abort.signal } : {})");
  });

  it('names the folders every mailbox has in the page\'s words, and the rest as the owner named them', () => {
    for (const [lang, inbox, junk, both] of [['en', 'Inbox', 'Spam', 'Inbox and archive'], ['zh-CN', '收件箱', '垃圾邮件', '收件箱和归档']] as const) {
      const folderLists = new Map([['me@qq.com', { folders: [
        { path: 'INBOX', name: 'INBOX', role: 'inbox' }, { path: '垃圾邮件', name: '垃圾邮件', role: 'junk' },
        { path: 'Projects/2026', name: '2026', role: null },
      ] }]]);
      const name = lifted<(account: string, path: string | null) => string>(['folderInfo', 'folderName'], 'folderName', { ...words(lang), folderLists });
      expect(name('me@qq.com', 'INBOX')).toBe(inbox);
      expect(name('me@qq.com', '垃圾邮件')).toBe(junk);
      expect(name('me@qq.com', 'Projects/2026')).toBe('2026');
      expect(name('me@qq.com', null)).toBe(both);
      // Before the folders are listed, the inbox is still the inbox.
      expect(name('other@x', 'INBOX')).toBe(inbox);
    }
  });

  it('makes a row of what the mailbox says, known by its handle, with the record it is carried apart', () => {
    const context = { folderLists: new Map(), accountName: (a: string) => `name of ${a}` };
    const row = lifted<(item: Record<string, unknown>, account: string) => Record<string, unknown>>(
      ['folderInfo', 'folderRoleOf', 'liveRow'], 'liveRow', context,
    );
    const unstored = row({ handle: 'live:a', messageId: '<a@x>', folder: 'INBOX', subject: 'Hi', from: { name: 'Ann', address: 'ann@x' },
      date: '2026-11-01T00:00:00.000Z', flags: { seen: false }, attachments: true }, 'me@qq.com');
    expect(unstored).toMatchObject({ dedupKey: 'live:a', handle: 'live:a', live: true, stored: false, sender: 'ann@x', senderName: 'Ann',
      accountLabel: 'name of me@qq.com', importance: null, handledAt: null, attachments: true });
    const stored = row({ handle: 'live:b', key: 'k1', stored: { importance: 'critical', handledAt: '2026-11-02T00:00:00.000Z' }, folder: 'Archive',
      from: { name: '', address: 'b@x' }, flags: {} }, 'me@qq.com');
    // Known by its handle: two messages that share a Message-ID are two rows. The record the server matched it to is carried apart.
    expect(stored).toMatchObject({ dedupKey: 'live:b', storedKey: 'k1', handle: 'live:b', stored: true, importance: 'critical', handledAt: '2026-11-02T00:00:00.000Z' });
    const queue = lifted<(m: Record<string, unknown>) => string>(['rowKey', 'queueKey'], 'queueKey');
    expect(queue(stored)).toBe('k1');
    expect(queue(unstored)).toBe('live:a');
    // What the server is asked to find it by: the handle, which says where it is.
    const ref = lifted<(m: Record<string, unknown>) => string>(['rowKey', 'mailRef'], 'mailRef');
    expect(ref(stored)).toBe('live:b');
    expect(ref({ dedupKey: 'k2' })).toBe('k2');
  });

  it('keeps a live view on the address and in the history, and knows one from another', () => {
    const same = lifted<(a: unknown, b: unknown) => boolean>(['sameLive'], 'sameLive');
    expect(same({ mode: 'folder', account: 'a', folder: 'INBOX' }, { mode: 'folder', account: 'a', folder: 'INBOX', q: '' })).toBe(true);
    expect(same({ mode: 'search', account: 'a', folder: null, q: 'x' }, { mode: 'search', account: 'a', folder: null, q: 'y' })).toBe(false);
    expect(same(null, { mode: 'folder', account: 'a' })).toBe(false);
    const context: Record<string, unknown> = { bootLive: null };
    const read = lifted<(p: URLSearchParams) => void>(['readLiveUrl'], 'readLiveUrl', context);
    read(new URLSearchParams('in=me%40qq.com&mq=invoice'));
    expect(context['bootLive']).toEqual({ mode: 'search', account: 'me@qq.com', folder: null, q: 'invoice' });
    read(new URLSearchParams('in=me%40qq.com'));
    expect(context['bootLive']).toEqual({ mode: 'folder', account: 'me@qq.com', folder: 'INBOX', q: '' });
    const p = new URLSearchParams('q=old&hours=72');
    lifted<(p: URLSearchParams) => void>(['writeLiveUrl'], 'writeLiveUrl', { liveView: { mode: 'search', account: 'me@qq.com', folder: 'Archive', q: 'new' } })(p);
    expect(p.toString()).toBe('hours=72&in=me%40qq.com&folder=Archive&mq=new');
  });

  it('says that a list is live, and when a search read only recent subjects and senders, in both languages', () => {
    expect(STRINGS.en['live.mark']).toBe('Live from the mailbox, not triaged');
    expect(STRINGS['zh-CN']['live.mark']).toBe('实时读取自邮箱，未经分拣');
    expect(STRINGS.en['live.limited']).toContain('{count}');
    expect(STRINGS['zh-CN']['live.limited']).toContain('{count}');
    for (const key of Object.keys(STRINGS.en).filter((k) => k.startsWith('live.') || k.startsWith('folder'))) {
      expect(STRINGS['zh-CN'][key as StringKey], key).toBeTruthy();
    }
  });

  it('gives a live row only what applies to it: no Done or later for a message never stored, no Archive in the archive', () => {
    const script = clientScript();
    expect(script).toContain("if (markable) bar.appendChild(barButton('i-check'");
    expect(script).toContain("const archived = liveIn(row, 'archive') || liveIn(row, 'all') || role === 'archive' || role === 'all'");
    expect(script).toContain("if (!archived) bar.appendChild(barButton('i-archive'");
    // A message the page just archived is not offered Archive again: the answer said where its archive is.
    expect(script).toContain("if (action === 'archive' && r.data.row && r.data.row.folder) archiveOf.set(r.data.row.account, r.data.row.folder);");
    expect(script).toContain("if (e.key === 'e') { if (!markable) return;");
    expect(script).toContain('const conversation = stored ? conversationSection(box, row) : null;');
  });
});

describe('what a review of the whole-mailbox stage found, in the page', () => {
  const en = (key: string): string => STRINGS.en[key as StringKey] ?? key;
  const fillEn = (key: string, vars: Record<string, unknown> = {}): string =>
    Object.entries(vars).reduce((text, [name, value]) => text.split(`{${name}}`).join(String(value)), en(key));

  /** bulkAction and its Undo, with the page around them stood in for: what is posted, picked and said. */
  function bulkPage(rows: Array<Record<string, unknown>>, answer: (body: Record<string, unknown>) => Record<string, unknown>) {
    const posted: Array<Record<string, unknown>> = [];
    const toasts: Array<{ text: string; error: boolean; undo: { run: () => Promise<void> } | null }> = [];
    const byKey = new Map(rows.map((row) => [String(row['dedupKey']), row]));
    const context: Record<string, unknown> = {
      session: { writable: true, canMark: true }, requireWrite: () => undefined, bulkBusy: false,
      picked: new Set<string>(), pickAnchor: null, history: { state: null },
      post: async (_path: string, body: Record<string, unknown>) => { posted.push(body); return { ok: true, data: answer(body) }; },
      // What the page still has: emptied by forget(), as leaving a folder or a reload of the lists does.
      rowByKey: (key: string) => byKey.get(key), findItem: () => null, rowOfItem: () => null,
      pickedRows: () => Array.from(context['picked'] as Set<string>).map((key) => byKey.get(key)).filter(Boolean),
      applyRow: () => undefined, liveData: new Map(), flagsByKey: new Map(), liveView: null, liveRows: new Map(), extraRows: new Map(), dropLive: () => undefined,
      attentionCount: 0, oweBack: () => undefined, pickChanged: () => undefined, renderPickBar: () => undefined, loadAttention: () => undefined,
      renderList: () => undefined, renderLede: () => undefined, renderBars: () => undefined, updateBadge: () => undefined,
      refresh: () => undefined, liveLoad: () => undefined, setTimeout: () => 0,
      toast: (text: string, error: boolean, undo: { run: () => Promise<void> } | null) => { toasts.push({ text, error, undo }); },
      failure: (data: { code: string }) => `refused: ${data.code}`, t: en, fill: fillEn, STRINGS, lang: 'en', DOT: ' · ',
      folderName: (_account: string, path: string) => path, whenLabel: () => 'tomorrow', crypto: webcrypto,
    };
    const fns = lifted<{
      bulkAction: (action: string, extra?: Record<string, unknown>) => Promise<void>;
    }>(['rowKey', 'mailRef', 'queueKey', 'bulkId', 'snoozeUndoTo', 'mutedLine', 'liveShown', 'bulkAction', 'bulkUndo', 'undoBulkSnooze'], '{ bulkAction }', context);
    const forget = (): void => { byKey.clear(); (context['liveRows'] as Map<string, unknown>).clear(); };
    return { ...fns, context, posted, toasts, forget };
  }
  const allDone = (body: Record<string, unknown>) => ({
    results: (body['items'] as string[]).map((key) => ({ key, status: 'done' })), done: (body['items'] as string[]).length, skipped: 0, failed: 0,
  });

  it('undoes exactly the batch it undoes, and leaves what was picked since picked', async () => {
    const rows = ['k1', 'k2', 'k3'].map((dedupKey) => ({ dedupKey, account: 'me@qq.com', folder: 'INBOX', handledAt: null }));
    const page = bulkPage(rows, allDone);
    (page.context['picked'] as Set<string>).add('k1').add('k2');
    await page.bulkAction('done');
    expect(page.posted[0]).toMatchObject({ action: 'done', items: ['k1', 'k2'] });
    // Picked since: k3. Undo is pressed.
    (page.context['picked'] as Set<string>).add('k3');
    await page.toasts[0]!.undo!.run();
    expect(page.posted[1]).toMatchObject({ action: 'not_done', items: ['k1', 'k2'] });
    expect([...(page.context['picked'] as Set<string>)]).toEqual(['k3']);
  });

  it('undoes every message of a batch, whatever the page has loaded or left since', async () => {
    // Stored rows listed live: known by their handles, sent by their records' keys.
    const rows = Array.from({ length: 30 }, (_, n) => ({
      dedupKey: `live:h${n}`, handle: `live:h${n}`, storedKey: `k${n}`, live: true, stored: true, account: 'me@qq.com', folder: 'INBOX', handledAt: null,
    }));
    const page = bulkPage(rows, allDone);
    for (const row of rows) (page.context['picked'] as Set<string>).add(row.dedupKey);
    await page.bulkAction('done');
    const sent = rows.map((row) => row.storedKey);
    expect(page.posted[0]).toMatchObject({ action: 'done', items: sent });
    // The folder is left (or the lists reloaded without most of them): no row is found any more.
    page.forget();
    page.context['liveView'] = null;
    await page.toasts[0]!.undo!.run();
    expect(page.posted[1]).toMatchObject({ action: 'not_done', items: sent });
  });

  it('undoes a batch reminder by giving each message the reminder it had, and leaves out the ones the batch did not change', async () => {
    const soon = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const rows = [
      { dedupKey: 'k1', account: 'me@qq.com', handledAt: null, snoozedUntil: null },
      { dedupKey: 'k2', account: 'me@qq.com', handledAt: null, snoozedUntil: soon },
      { dedupKey: 'k3', account: 'me@qq.com', handledAt: '2026-11-01T00:00:00.000Z', snoozedUntil: null },
    ];
    const page = bulkPage(rows, (body) => ({
      results: (body['items'] as string[]).map((key) => (key === 'k3' ? { key, status: 'skipped', code: 'alreadyDone' } : { key, status: 'done' })),
      done: (body['items'] as string[]).filter((key) => key !== 'k3').length, skipped: 1, failed: 0,
    }));
    for (const key of ['k1', 'k2', 'k3']) (page.context['picked'] as Set<string>).add(key);
    await page.bulkAction('snooze', { until: '2027-01-01T09:00:00.000Z' });
    // Nothing of the batch is on the page any more when Undo is pressed.
    page.forget();
    await page.toasts[0]!.undo!.run();
    const undo = page.posted.slice(1).map((body) => [body['items'], body['until']]);
    expect(undo).toEqual(expect.arrayContaining([[['k1'], null], [['k2'], soon]]));
    expect(undo).toHaveLength(2);
  });

  it('says why a batch went nowhere, in the page\'s words, rather than that none were moved', async () => {
    const rows = ['k1', 'k2'].map((dedupKey) => ({ dedupKey, account: 'me@qq.com', folder: 'INBOX' }));
    const page = bulkPage(rows, (body) => ({
      results: (body['items'] as string[]).map((key) => ({ key, status: 'failed', code: 'action_invalid_destination' })), done: 0, skipped: 0, failed: 2,
    }));
    for (const key of ['k1', 'k2']) (page.context['picked'] as Set<string>).add(key);
    STRINGS.en['error.action_invalid_destination' as StringKey] ??= 'This mailbox has no spam folder.';
    await page.bulkAction('spam');
    expect(page.toasts[0]).toMatchObject({ text: 'refused: action_invalid_destination', error: true });
    // Some went, some are still under way, and a sender was made low priority: each said.
    const mixed = bulkPage(rows, (body) => ({
      results: [{ key: 'k1', status: 'done' }, { key: 'k2', status: 'pending' }], done: 1, skipped: 0, failed: 0, pending: 1, muted: ['promo@shop.example'],
    }));
    for (const key of ['k1', 'k2']) (mixed.context['picked'] as Set<string>).add(key);
    await mixed.bulkAction('spam');
    expect(mixed.toasts[0]!.text).toBe([
      fillEn('bulk.spam', { count: 1, folder: '', when: '' }), fillEn('bulk.pending', { count: 1 }), fillEn('fb.ruleNever', { sender: 'promo@shop.example' }),
    ].join(' · '));
  });

  it('gives the reader on a desk to the next message listed when the open one leaves the folder', () => {
    const opened: string[] = [];
    const context: Record<string, unknown> = {
      liveView: { items: [{ dedupKey: 'a' }, { dedupKey: 'b' }, { dedupKey: 'c' }], total: 3 }, liveRows: new Map([['b', { dedupKey: 'b' }]]), extraRows: new Map(),
      visibleKeys: () => ['a', 'b', 'c'], isWide: () => true, selectedKey: 'b', findItem: (key: string) => key !== 'b',
      openDetail: (key: string) => opened.push(key), clearSelection: () => opened.push('cleared'), renderLiveHead: () => undefined,
    };
    const drop = lifted<(keys: string[]) => void>(['rowKey', 'moveOnFrom', 'dropLive'], 'dropLive', context);
    drop(['b']);
    expect(opened).toEqual(['c']);
    expect((context['liveView'] as { items: unknown[]; total: number })).toMatchObject({ items: [{ dedupKey: 'a' }, { dedupKey: 'c' }], total: 2 });
    context['selectedKey'] = 'c';
    drop(['a', 'c']);
    expect(opened).toEqual(['c', 'cleared']);
  });

  it('opens a folder named by the address over the triaged view, so Back and a closed sheet stay in mailsift', () => {
    const calls: string[] = [];
    const location = { pathname: '/', search: '?hours=72&in=me%40qq.com&folder=Archive' };
    const history = {
      state: null as unknown,
      replaceState(state: unknown, _title: string, path: string) { calls.push(`replace ${path}`); this.state = state; location.search = path.slice(1); },
      pushState(state: unknown, _title: string, path: string) { calls.push(`push ${path}`); this.state = state; },
    };
    const noop = () => undefined;
    const context: Record<string, unknown> = {
      location, history, liveView: null, triagedQuery: '', liveAbort: null, liveRows: new Map(), filters: { q: { value: '' } },
      document: { body: { classList: { add: noop } } }, selectedKey: null, openKey: null, clearSelection: noop, URLSearchParams,
      syncUrl: () => calls.push('sync'), renderLiveHead: noop, renderTokens: noop, updateAsk: noop, wordPlaceholders: noop, renderList: noop,
      liveLoad: noop, loadFolders: noop, window: { scrollTo: noop },
    };
    const open = lifted<(view: Record<string, unknown>, how: string) => void>(['liveState', 'openLive'], 'openLive', context);
    open({ mode: 'folder', account: 'me@qq.com', folder: 'Archive' }, 'boot');
    expect(calls).toEqual(['replace /?hours=72', 'push /?hours=72', 'sync']);
    expect(history.state).toEqual({ live: { mode: 'folder', account: 'me@qq.com', folder: 'Archive', q: '' } });
  });

  it('opens a message a link names by its handle as a live row: no queue for one never stored, the record\'s key for one that was', async () => {
    const extraRows = new Map<string, Record<string, unknown>>();
    let answer: Record<string, unknown> = {};
    const context = {
      extraRows, findItem: () => null, openDetail: () => undefined, encodeURIComponent,
      fetch: async () => ({ ok: true, json: async () => answer }),
    };
    const open = lifted<(key: string) => void>(['openFromLink'], 'openFromLink', context);
    answer = { handle: 'live:a', dedupKey: 'live:a', stored: false, handledAt: null };
    open('live:a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(extraRows.get('live:a')).toMatchObject({ dedupKey: 'live:a', storedKey: null, live: true, stored: false });
    answer = { handle: 'live:b', dedupKey: 'k1', stored: true };
    open('live:b');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(extraRows.get('live:b')).toMatchObject({ dedupKey: 'live:b', storedKey: 'k1', live: true });
  });

  it('tells apart two folders of the same name by what they are in', () => {
    const folderLists = new Map([['me@qq.com', { folders: [
      { path: 'Projects/2026', name: '2026', parent: 'Projects', delimiter: '/', role: null },
      { path: 'Travel/2026', name: '2026', parent: 'Travel', delimiter: '/', role: null },
      { path: 'Receipts', name: 'Receipts', parent: null, delimiter: '/', role: null },
    ] }]]);
    const name = lifted<(account: string, path: string) => string>(['folderInfo', 'folderName'], 'folderName',
      { t: en, lang: 'en', STRINGS, folderLists });
    expect(name('me@qq.com', 'Projects/2026')).toBe('Projects / 2026');
    expect(name('me@qq.com', 'Travel/2026')).toBe('Travel / 2026');
    expect(name('me@qq.com', 'Receipts')).toBe('Receipts');
  });

  it('does not say nothing matches when a search could read only recent subjects and senders', () => {
    const el = (tag: string, cls: string | null, text?: string) => ({ tag, cls, text, children: [] as unknown[], appendChild(child: unknown) { this.children.push(child); } });
    const context: Record<string, unknown> = { el, t: en, fill: fillEn, lang: 'en', failure: () => '', liveLoad: () => undefined };
    const empty = lifted<() => { children: Array<{ text: string }> }>(['liveEmpty'], 'liveEmpty', context);
    context['liveView'] = { mode: 'search', failed: null, limited: { reason: 'provider', scanned: 2000 } };
    expect(empty().children[0]!.text).toBe(fillEn('live.noneFoundLimited', { count: (2000).toLocaleString('en') }));
    expect(empty().children[0]!.text).not.toBe(en('live.noneFound'));
    context['liveView'] = { mode: 'search', failed: null, limited: null };
    expect(empty().children[0]!.text).toBe(en('live.noneFound'));
  });

  it('keeps a live view out of the snapshot of the triaged mail', () => {
    let written = 0;
    const context: Record<string, unknown> = {
      fromSnapshot: false, liveView: { mode: 'folder' }, lastMail: [{}], lastSummary: {}, filtersActive: () => false,
      filters: { view: { value: 'mail' }, hours: { value: '24' } }, clearTimeout: () => undefined,
      setTimeout: (run: () => void) => { run(); return 0; }, writeStorage: () => { written += 1; },
    };
    const save = lifted<() => void>(['saveSnapshot'], 'saveSnapshot', context);
    save();
    expect(written).toBe(0);
  });

  it('lets e, y, #, s and b act on what is picked, and keeps right-click a right-click', () => {
    const script = clientScript();
    expect(script).toContain("} else if (picked.size && ['e', 'y', '#', 's', 'b'].includes(e.key)) {");
    expect(script).toContain("li.addEventListener('contextmenu', (e) => { if (touched && !isWide()) e.preventDefault(); });");
    expect(script).toContain("if (bulkSheet.open) closePopover(bulkSheet, false);");
    // A search from this tab takes the place only of this tab's own.
    expect(script).toContain("p.set('tab', tabId());");
  });

  it('fits the selection bar on a small phone, protects the long press from the link menu, and lines up the mailbox switch', () => {
    const css = styles();
    const phone = css.slice(css.indexOf('body.picking .pick-box{display:grid}'));
    expect(phone).toContain('.row,.row .who{-webkit-touch-callout:none;user-select:none;-webkit-user-select:none}');
    expect(phone).toContain('#pick-all{display:none}');
    expect(phone).toContain('.pick-actions .bar-btn span{display:none}');
    expect(phone).toContain('.pick-count{min-width:0;overflow:hidden;text-overflow:ellipsis}');
    expect(css).toContain('#folder-sheet .folder-accounts{max-width:none;margin:0 8px 8px}');
  });

  it('gives the box its own place in a narrow window with a mouse, never over the ring, the clock or the check', () => {
    const css = styles();
    // Not shown in the mark's place under the pointer, where a click meant for the ring would pick the row.
    expect(css).not.toContain('@media(max-width:899px) and (hover:hover){.row:hover .pick-box{display:grid}}');
    const narrowMouse = css.slice(css.indexOf('@media(max-width:899px) and (hover:hover) and (pointer:fine){'));
    const rules = narrowMouse.slice(0, narrowMouse.indexOf('\n}') + 2);
    // A gutter on the left of the whole column, as on a desk: the box sits in it, outside the row (3-21px of an
    // 800px window), and the ring keeps its place in the row (38px), clear of the box and of the 10px around it
    // a click still takes. The groups no longer clip the box; the column clips instead.
    expect(rules).toContain('main.app-main{padding-left:24px;padding-right:24px;overflow-x:clip}');
    expect(rules).toContain('ul.group{overflow-x:visible}');
    expect(rules).toContain('.pick-box{left:-21px;top:15px}');
    expect(rules).toContain('.row:hover .pick-box{display:grid}');
    // While picking, the ring and the mark stay: the box is beside them, not over them.
    expect(rules).toContain('body.picking .row>.mark,body.picking .row>.ring{visibility:visible}');
    const gutter = 24, box = -21, width = 18, reach = 10, ring = 16 - 2;
    expect(gutter + box + width + reach).toBeLessThanOrEqual(gutter + ring);
  });

  it('words what a batch did evenly, and says a search was replaced by a newer one, in both languages', () => {
    expect(STRINGS.en['bulk.not_done']).toBe('Marked {count} not done');
    expect(STRINGS.en['bulk.snooze']).toBe('Reminders set for {count}: {when}');
    expect(STRINGS.en['palette.searchMailbox']).toBe('Search {name} for “{q}”');
    for (const key of ['error.superseded', 'bulk.pending', 'live.noneFoundLimited'] as const) {
      expect(STRINGS.en[key as StringKey], key).toBeTruthy();
      expect(STRINGS['zh-CN'][key as StringKey], key).toBeTruthy();
    }
    // Said once, above the list; the empty list says only that none of it matched.
    expect(STRINGS.en['live.noneFoundLimited' as StringKey]).toBe('No subject or sender matches.');
    expect(STRINGS['zh-CN']['live.noneFoundLimited' as StringKey]).toBe('主题和发件人里都没有匹配的。');
    expect(STRINGS.en['live.limitedOne' as StringKey]).toContain('in this folder');
    expect(STRINGS['zh-CN']['live.limitedOne' as StringKey]).toContain('这个文件夹');
  });

  it('opens a folder from the address over its own entry when a reload or a restore finds it there, adding nothing', () => {
    const calls: string[] = [];
    const view = { mode: 'folder', account: 'me@qq.com', folder: 'INBOX', q: '' };
    const location = { pathname: '/', search: '?in=me%40qq.com&folder=INBOX' };
    const history = {
      state: { live: view } as unknown,
      replaceState(_state: unknown, _title: string, path: string) { calls.push(`replace ${path}`); },
      pushState(_state: unknown, _title: string, path: string) { calls.push(`push ${path}`); },
    };
    const noop = () => undefined;
    const context: Record<string, unknown> = {
      location, history, liveView: null, triagedQuery: '', liveAbort: null, liveRows: new Map(), filters: { q: { value: '' } },
      document: { body: { classList: { add: noop } } }, selectedKey: null, openKey: null, clearSelection: noop, URLSearchParams,
      syncUrl: noop, renderLiveHead: noop, renderTokens: noop, updateAsk: noop, wordPlaceholders: noop, renderList: noop,
      liveLoad: noop, loadFolders: noop, window: { scrollTo: noop },
    };
    const open = lifted<(view: Record<string, unknown>, how: string) => void>(['liveState', 'sameLive', 'openLive'], 'openLive', context);
    open(view, 'boot');
    open(view, 'boot');
    expect(calls).toEqual([]);
    // A sheet, a popover or a selection open at the reload is gone; its entry keeps the folder, not the sheet.
    for (const stale of [{ live: view, sheet: true }, { live: view, picking: true }, { live: view, popover: 'bulk' }]) {
      const kept: unknown[] = [];
      const strip = lifted<() => void>(['stripStaleEntry'], 'stripStaleEntry', {
        location: { pathname: '/', search: '?in=x', hash: '' },
        history: { state: stale, replaceState: (state: unknown) => kept.push(state) },
      });
      strip();
      expect(kept).toEqual([{ live: view }]);
    }
  });

  it('keeps a stored message opened from a link by its handle in step with Done and Remind me', () => {
    const extraRows = new Map<string, Record<string, unknown>>([['live:a', { dedupKey: 'live:a', storedKey: 'k1', live: true, handledAt: null }]]);
    const touched: string[] = [];
    const each = lifted<(key: string, touch: (m: Record<string, unknown>) => void) => void>(['rowKey', 'eachCopy'], 'eachCopy', {
      lastMail: [], attention: [], doneRecent: [], snoozedRows: [], lastThreads: [], extraRows, liveRows: new Map(),
    });
    each('k1', (m) => { m['handledAt'] = '2026-11-17T00:00:00.000Z'; touched.push(String(m['dedupKey'])); });
    expect(touched).toEqual(['live:a']);
    expect(extraRows.get('live:a')!['handledAt']).toBe('2026-11-17T00:00:00.000Z');
    const byKey = lifted<(key: string) => unknown>(['rowKey', 'rowByKey'], 'rowByKey', {
      liveView: null, liveRows: new Map(), lastMail: [], attention: [], lastThreads: [], doneRecent: [], snoozedRows: [], extraRows,
    });
    expect(byKey('k1')).toBe(extraRows.get('live:a'));
  });

  it('closes the reader on a phone when Done names the open live row by its record\'s key', () => {
    const row = { dedupKey: 'live:a', storedKey: 'k1', live: true };
    const isOpen = lifted<(key: string) => boolean>(['rowKey', 'queueKey', 'isOpenRow'], 'isOpenRow', {
      openKey: 'live:a', findItem: () => ({ row }), rowOfItem: (item: { row: unknown }) => item.row,
    });
    expect(isOpen('k1')).toBe(true);
    expect(isOpen('live:a')).toBe(true);
    expect(isOpen('k2')).toBe(false);
  });

  it('lets e act on a selection only where it has Done, and s take the star off when every one picked has it', () => {
    const script = clientScript();
    expect(script).toContain("if (e.key === 'e') { if (choices.includes('done')) bulkAction('done'); else if (choices.includes('not_done')) bulkAction('not_done'); }");
    expect(script).toContain("else if (e.key === 's') bulkAction(allStarred(pickedRows()) ? 'unstar' : 'star');");
    const flagsByKey = new Map([['a', { flagged: true }], ['b', { flagged: true }], ['c', { flagged: false }]]);
    const starred = lifted<(rows: unknown[]) => boolean>(['rowKey', 'allStarred'], 'allStarred', { flagsByKey });
    expect(starred([{ dedupKey: 'a' }, { dedupKey: 'b' }])).toBe(true);
    expect(starred([{ dedupKey: 'a' }, { dedupKey: 'c' }])).toBe(false);
    expect(starred([])).toBe(false);
  });

  it('names a folder in the panel by its own name, where its parent is shown beside it', () => {
    const folderLists = new Map([['me@qq.com', { folders: [
      { path: 'Projects/2026', name: '2026', parent: 'Projects', delimiter: '/', role: null },
      { path: 'Travel/2026', name: '2026', parent: 'Travel', delimiter: '/', role: null },
    ] }]]);
    const name = lifted<(account: string, path: string, plain?: boolean) => string>(['folderInfo', 'folderName'], 'folderName',
      { t: en, lang: 'en', STRINGS, folderLists });
    expect(name('me@qq.com', 'Projects/2026', true)).toBe('2026');
    expect(name('me@qq.com', 'Projects/2026')).toBe('Projects / 2026');
    expect(clientScript()).toContain("const name = el('span', 'folder-name', folderName(account, f.path, true));");
  });

  it('names one or two senders a vote muted, and counts more, in each language\'s own way', () => {
    for (const [lang, sep] of [['en', ' and '], ['zh-CN', '、']] as const) {
      const t = (key: string): string => STRINGS[lang][key as StringKey] ?? key;
      const fill = (key: string, vars: Record<string, unknown> = {}): string =>
        Object.entries(vars).reduce((text, [k, v]) => text.split(`{${k}}`).join(String(v)), t(key));
      const line = lifted<(muted: unknown) => string>(['mutedLine'], 'mutedLine', { t, fill, lang });
      expect(line(['a@x'])).toBe(fill('fb.ruleNever', { sender: 'a@x' }));
      expect(line(['a@x', 'b@x'])).toBe(fill('fb.ruleNever', { sender: `a@x${sep}b@x` }));
      const many = line(Array.from({ length: 12 }, (_, n) => `s${n}@x`));
      expect(many).toBe(fill('fb.ruleNeverSome', { count: (12).toLocaleString(lang) }));
      expect(many).not.toContain('@');
      expect(line([])).toBe('');
    }
    expect(clientScript()).toContain('const muted = mutedLine(r.data.muted);\n  toast(muted ? said + DOT + muted : said);');
  });

  /** liveLoad, with the page around it stood in for: the open message, what the list read again holds, what the reader did. */
  function livePage(open: string, onFirstPage: string[], wide = true) {
    const did: string[] = [];
    const rowOf = (key: string) => ({ dedupKey: key, handle: key, live: true, folder: 'INBOX', flags: {} });
    // A folder of 99, both pages loaded: page 1 is h1-h50.
    const listed = Array.from({ length: 99 }, (_, n) => `live:h${n + 1}`);
    const context: Record<string, unknown> = {
      liveView: { mode: 'folder', account: 'me@qq.com', folder: 'INBOX', items: listed.map(rowOf), next: 'x', loading: false },
      liveSeq: 0, liveAbort: null, window: {}, URLSearchParams, LIVE_PAGE: 50, location: { reload: () => did.push('reload') },
      liveRows: new Map(listed.map((key) => [key, rowOf(key)])), extraRows: new Map(), flagsByKey: new Map(),
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ items: onFirstPage.map((key) => ({ key })), next: null, total: 99 }) }),
      liveRow: (item: { key: string }) => rowOf(item.key), tabId: () => 'tab', holdPending: () => undefined, holdSnoozes: () => undefined,
      renderList: () => undefined, renderLiveHead: () => undefined, renderPane: () => did.push('pane'), renderBars: () => did.push('bars'),
      visibleKeys: () => listed, isWide: () => wide, selectedKey: open, openKey: null, sheet: { open: false },
      openDetail: (key: string) => did.push(`open ${key}`), clearSelection: () => did.push('cleared'),
      picked: new Set<string>(), pickChanged: () => did.push('picks'), markSelected: () => did.push('marked'),
    };
    context['findItem'] = (key: string) => (context['liveRows'] as Map<string, unknown>).get(key) ?? (context['extraRows'] as Map<string, unknown>).get(key) ?? null;
    const load = lifted<(reset: boolean, gone?: Set<string>) => Promise<void>>(['rowKey', 'moveOnFrom', 'forgetUnlisted', 'liveLoad'], 'liveLoad', context);
    return { load, context, did };
  }

  it('keeps the message open on a desk when the list is read again from the top without it', async () => {
    // Open: the 70th message. The refresh, the same search again, a page read again: page 1 has 50, and not it.
    const page = livePage('live:h70', ['live:h48', 'live:h49', 'live:h50']);
    await page.load(true);
    expect(page.context['selectedKey']).toBe('live:h70');
    expect(page.did.filter((what) => what.startsWith('open') || what === 'cleared')).toEqual([]);
    // Still found, so the reader and its bar stay.
    expect((page.context['findItem'] as (key: string) => unknown)('live:h70')).toMatchObject({ dedupKey: 'live:h70' });
    expect(page.did).toContain('bars');
  });

  it('moves a desk reader on only when the owner\'s own batch took the open message out', async () => {
    const page = livePage('live:h49', ['live:h48', 'live:h50']);
    await page.load(true, new Set(['live:h49']));
    expect(page.did).toContain('open live:h50');
    expect((page.context['extraRows'] as Map<string, unknown>).has('live:h49')).toBe(false);
    // The batch named it, but it is still listed (the move did not happen): it stays open.
    const still = livePage('live:h49', ['live:h48', 'live:h49', 'live:h50']);
    await still.load(true, new Set(['live:h49']));
    expect(still.did.filter((what) => what.startsWith('open'))).toEqual([]);
  });

  it('keeps a desk reader past the first page over the reload after a batch, since the first page cannot say its move happened', async () => {
    const page = livePage('live:h60', Array.from({ length: 50 }, (_, n) => `live:h${n + 1}`));
    await page.load(true, new Set(['live:h60']));
    expect(page.did.filter((what) => what.startsWith('open') || what === 'cleared')).toEqual([]);
    expect((page.context['extraRows'] as Map<string, unknown>).has('live:h60')).toBe(true);
  });

  it('puts down, in a narrow window, a selected row and picks the reload no longer lists, so keys act only on what is shown', async () => {
    const page = livePage('live:h70', Array.from({ length: 50 }, (_, n) => `live:h${n + 1}`), false);
    (page.context['picked'] as Set<string>).add('live:h3').add('live:h80');
    await page.load(true);
    // No reader shows it in a narrow window: not held, and no longer selected.
    expect(page.context['selectedKey']).toBeNull();
    expect((page.context['extraRows'] as Map<string, unknown>).has('live:h70')).toBe(false);
    expect((page.context['findItem'] as (key: string) => unknown)('live:h70')).toBeNull();
    expect([...(page.context['picked'] as Set<string>)]).toEqual(['live:h3']);
    expect(page.did).toContain('picks');
    // A row the new list still has stays selected.
    const listed = livePage('live:h7', Array.from({ length: 50 }, (_, n) => `live:h${n + 1}`), false);
    await listed.load(true);
    expect(listed.context['selectedKey']).toBe('live:h7');
  });

  it('puts down every message of a batch the server says is no longer where the folder listed it, and lists it again once', async () => {
    const rows = ['live:a', 'live:b', 'live:c'].map((dedupKey) => ({ dedupKey, handle: dedupKey, live: true, account: 'me@qq.com', folder: 'INBOX' }));
    const page = bulkPage(rows, (body) => ({
      results: (body['items'] as string[]).map((key) => (key === 'live:c' ? { key, status: 'done' } : { key, status: 'failed', code: 'liveStale' })),
      done: 1, skipped: 0, failed: 2,
    }));
    const forgotten: unknown[] = [];
    page.context['liveView'] = { items: [] };
    page.context['forgetStale'] = (keys: unknown) => forgotten.push(keys);
    for (const row of rows) (page.context['picked'] as Set<string>).add(row.dedupKey);
    await page.bulkAction('trash');
    expect(forgotten).toEqual([['live:a', 'live:b']]);
    const forget = lifted<(keys: string[]) => void>(['forgetStale'], 'forgetStale', {
      liveRows: new Map([['live:a', {}], ['live:b', {}], ['live:x', {}]]), extraRows: new Map(), selectedKey: 'live:b', openKey: null,
      sheet: { open: false }, closeSheet: () => undefined, clearSelection: () => forgotten.push('cleared'), liveLoad: () => forgotten.push('load'),
    });
    forget(['live:a', 'live:b']);
    expect(forgotten.slice(1)).toEqual(['cleared', 'load']);
    // Reply, forward and the reader's own read do the same with a stale answer.
    const script = clientScript();
    expect(script).toContain("if (!r.ok) { failed(failure(d)); if (d.code === 'liveStale' && liveView && listed) forgetStale(listed); return; }");
    expect(script).toContain('loadReply(state, rowKey(row));');
    expect(script).toContain('loadForward(state, rowKey(row));');
    expect(script).toContain("if (!r.ok && d.code === 'liveStale' && liveView && row.live) { clearTimeout(slow); toast(failure(d), true); forgetStale(rowKey(row)); return; }");
  });

  it('lets the open message held over a reload go when the owner moves it, and puts the reader down rather than pick another', () => {
    const did: string[] = [];
    const held = { dedupKey: 'live:h70', live: true };
    const context: Record<string, unknown> = {
      liveView: { items: [{ dedupKey: 'live:h1' }], total: 99 }, liveRows: new Map([['live:h1', { dedupKey: 'live:h1' }]]),
      extraRows: new Map([['live:h70', held]]), visibleKeys: () => ['live:h1'], isWide: () => true, selectedKey: 'live:h70',
      renderLiveHead: () => undefined, openDetail: (key: string) => did.push(`open ${key}`), clearSelection: () => did.push('cleared'),
    };
    context['findItem'] = (key: string) => (context['liveRows'] as Map<string, unknown>).get(key) ?? (context['extraRows'] as Map<string, unknown>).get(key) ?? null;
    const shown = lifted<(key: string) => unknown>(['liveShown'], 'liveShown', context);
    expect(shown('live:h70')).toBe(held);
    const drop = lifted<(keys: string[]) => void>(['rowKey', 'moveOnFrom', 'dropLive'], 'dropLive', context);
    drop(['live:h70']);
    expect((context['extraRows'] as Map<string, unknown>).has('live:h70')).toBe(false);
    expect(did).toEqual(['cleared']);
  });

  it('puts the open message down when the server says it is no longer where the folder listed it, rather than open another', () => {
    const did: string[] = [];
    const context: Record<string, unknown> = {
      liveRows: new Map([['live:a', {}], ['live:b', {}]]), extraRows: new Map(), selectedKey: 'live:a', openKey: null,
      sheet: { open: false }, closeSheet: () => did.push('closed'), clearSelection: () => did.push('cleared'),
      liveLoad: (reset: boolean) => did.push(`load ${reset}`), openDetail: (key: string) => did.push(`open ${key}`),
    };
    const forget = lifted<(key: string) => void>(['forgetStale'], 'forgetStale', context);
    forget('live:a');
    expect(did).toEqual(['cleared', 'load true']);
    expect((context['liveRows'] as Map<string, unknown>).has('live:a')).toBe(false);
    expect(clientScript()).toContain("if (r.data && r.data.code === 'liveStale' && liveView) forgetStale(key);");
  });

  it('lines the narrow mouse layout up with its header, centred, and covers the gutter beside the selection bar', () => {
    const css = styles();
    const narrowMouse = css.slice(css.indexOf('@media(max-width:899px) and (hover:hover) and (pointer:fine){'));
    const rules = narrowMouse.slice(0, narrowMouse.indexOf('\n}') + 2);
    // The header moves with the column (16px + 24px on the left, 12px + 24px on the right), and the column is inset on both sides.
    expect(rules).toContain('header.app-header{padding-left:40px;padding-right:36px}');
    expect(rules).toContain('main.app-main{padding-left:24px;padding-right:24px;overflow-x:clip}');
    // The bar covers the gutter beside it, painted and taking the click, in every layout with one.
    expect(css).toContain('body.picking .controls::before{content:"";position:absolute;top:0;bottom:0;right:100%;width:24px;background:var(--bg)}');
    expect(css).not.toContain('box-shadow:-24px 0 0 var(--bg)');
  });

  it('moves a desk reader on when the list read again after a batch no longer has its message', () => {
    const opened: string[] = [];
    const context: Record<string, unknown> = {
      isWide: () => true, selectedKey: 'b', findItem: (key: string) => key !== 'b',
      openDetail: (key: string) => opened.push(key), clearSelection: () => opened.push('cleared'),
    };
    const moveOn = lifted<(before: string[], gone?: Set<string>) => void>(['moveOnFrom'], 'moveOnFrom', context);
    moveOn(['a', 'b', 'c']);
    expect(opened).toEqual(['c']);
    context['findItem'] = () => null;
    moveOn(['a', 'b']);
    expect(opened).toEqual(['c', 'cleared']);
    const script = clientScript();
    expect(script).toContain('if (listedBefore && out.size) moveOnFrom(listedBefore, out);\n      if (listedBefore) forgetUnlisted();\n      renderPane();\n      renderBars();');
  });
});

describe('the parts of the page script', () => {
  it('are written as the browser runs them: no backtick and no interpolation inside a String.raw part', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = new URL('../src/', import.meta.url);
    const parts = readdirSync(dir).filter((name) => /^web-client-.+\.ts$/.test(name));
    expect(parts).toEqual(expect.arrayContaining(['web-client-mailbox.ts', 'web-client-list.ts', 'web-client-reader.ts', 'web-client-compose.ts', 'web-client-live.ts']));
    for (const name of parts) {
      const source = readFileSync(new URL(name, dir), 'utf8');
      const start = source.indexOf('String.raw`');
      expect(start, name).toBeGreaterThan(-1);
      const body = source.slice(start + 'String.raw`'.length, source.lastIndexOf('`;'));
      expect(body.includes('`'), name).toBe(false);
      expect(body.includes('${'), name).toBe(false);
    }
    expect(() => new Script(clientScript())).not.toThrow();
  });
});

describe('picking many messages in the page', () => {
  it('picks the rows between two with Shift, in the list\'s order, either way', () => {
    const range = lifted<(keys: string[], from: string, to: string) => string[]>(['pickRange'], 'pickRange');
    const keys = ['a', 'b', 'c', 'd', 'e'];
    expect(range(keys, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(range(keys, 'd', 'b')).toEqual(['b', 'c', 'd']);
    // From a row no longer listed: only the one pressed.
    expect(range(keys, 'gone', 'c')).toEqual(['c']);
  });

  it('offers for a selection only what at least one of it can take', () => {
    const context = { folderLists: new Map([['me@qq.com', { folders: [{ path: 'Archive', role: 'archive' }, { path: 'Junk', role: 'junk' }] }]]) };
    const choices = lifted<(rows: Array<Record<string, unknown>>) => string[]>(['folderInfo', 'folderRoleOf', 'liveIn', 'bulkChoices'], 'bulkChoices', context);
    const storedOpen = { account: 'me@qq.com', folder: 'INBOX', handledAt: null };
    const storedDone = { account: 'me@qq.com', folder: 'INBOX', handledAt: '2026-11-01T00:00:00Z' };
    const liveInArchive = { account: 'me@qq.com', folder: 'Archive', live: true, stored: false };
    const liveSpam = { account: 'me@qq.com', folder: 'Junk', live: true, stored: false, inSpam: true };
    expect(choices([storedOpen, liveInArchive])).toEqual(['done', 'archive', 'trash', 'mark_read', 'mark_unread', 'star', 'unstar', 'move', 'spam', 'snooze']);
    // Nothing stored: no Done, no later. All in the archive: no Archive. All in spam: Not spam only.
    expect(choices([liveInArchive])).not.toEqual(expect.arrayContaining(['done']));
    expect(choices([liveInArchive])).not.toContain('archive');
    expect(choices([liveSpam])).toEqual(expect.arrayContaining(['not_spam']));
    expect(choices([liveSpam])).not.toContain('spam');
    // All done: the way back; two mailboxes: no move.
    expect(choices([storedDone])[0]).toBe('not_done');
    expect(choices([storedOpen, { ...storedOpen, account: 'me@gmail.com' }])).not.toContain('move');
  });

  it('has the bar in the controls\' place, x to pick, Escape and Back to put the selection down, and one request per press', async () => {
    const page = String((await routeWeb(request(), url('/'), '', seeded())).body);
    expect(page).toMatch(/<form id="filters" class="controls" autocomplete="off">\s*<div id="pick-bar" class="pick-bar" hidden>/);
    expect(page).toContain('<dialog id="bulk-sheet" class="sheet bare" aria-labelledby="bulk-title" tabindex="-1">');
    const script = clientScript();
    expect(script).toContain("['x', 'keys.pick']");
    expect(script).toContain("} else if (e.key === 'Escape' && picked.size) {");
    expect(script).toContain('if (picked.size && !(history.state && history.state.picking)) clearPicks(true);');
    expect(script).toContain("post('/api/bulk', Object.assign({ items: Array.from(refs.keys()), action, id: bulkId() }, extra || {}))");
    expect(script).toContain("if (doneRefs.length && action === 'done') undo = { label: t('undo'), run: () => bulkUndo('not_done', doneRefs) };");
    for (const lang of ['en', 'zh-CN'] as const) {
      for (const key of ['pick.count', 'bulk.archive', 'bulk.move', 'bulk.skipped', 'act.moveTo', 'act.spam', 'folders.recent']) {
        expect(STRINGS[lang][key as StringKey], `${lang} ${key}`).toBeTruthy();
      }
    }
  });
});

describe('what a QA pass found in the reader and on signing out', () => {
  /** The reader's own checks, run on their own: URL is the one thing they need from a browser. */
  const reader = () => {
    const context: Record<string, unknown> = { URL, location: { origin: 'https://mail.example' } };
    return lifted<{
      misleadingSite: (text: string, hostname: string) => string;
      cssUrls: (css: string, imagesOn: boolean, out: { remote: number }) => string;
      cssUnescape: (css: string) => string;
      backgroundStyle: (value: string) => string;
    }>(['siteOf', 'ownAddress', 'RASTER_DATA', 'shownHost', 'misleadingSite', 'cssUnescape', 'cssCalls', 'cssUrls', 'backgroundStyle'],
      '({ misleadingSite, cssUrls, cssUnescape, backgroundStyle })', context);
  };

  it('sees a link that names one site and goes to another through invisible characters and look-alike letters', () => {
    const { misleadingSite } = reader();
    for (const shown of [
      'paypal.com', 'PayPal.com', 'paypal.com\u200b', 'paypal.com\u00ad', '\u200bpaypal.com', 'paypal.com!', 'paypal.com.',
      '\u202epaypal.com', '\uff50\uff41\uff59\uff50\uff41\uff4c\uff0e\uff43\uff4f\uff4d', 'https://www.paypal.com/signin', '«paypal.com»', 'paypal.com is where you pay',
    ]) {
      expect(misleadingSite(shown, 'evil.example'), JSON.stringify(shown)).toBe(shown.includes('www.') ? 'www.paypal.com' : 'paypal.com');
    }
    // A look-alike letter is another site than the one it imitates, in the form that shows it.
    expect(misleadingSite('\u0430pple.com', 'evil.example')).toBe('xn--pple-43d.com');
    expect(misleadingSite('\u0430pple.com', 'apple.com')).toBe('xn--pple-43d.com');
    // Text that goes where it says, or names no site, is left alone.
    expect(misleadingSite('paypal.com', 'www.paypal.com')).toBe('');
    expect(misleadingSite('Pay your invoice', 'evil.example')).toBe('');
  });

  it('cuts every remote picture from CSS however it is written, counts each, and keeps them when images are shown', () => {
    const { cssUrls, cssUnescape } = reader();
    const css = cssUnescape('.a{background-image:u\\72l(https://cssescape.example/a.png)}'
      + '.b{background-image:image-set("https://imageset.example/b.png" 1x, url(https://imageset.example/c.png) 2x)}'
      + '.c{background:url("https://quoted.example/a)b.png")}'
      + '.d{background:URL( h\\74tps://upper.example/d.png )}'
      + '.e{background:url(data:image/png;base64,AAAA)}');
    const off = { remote: 0 };
    const cut = cssUrls(css, false, off);
    expect(cut).not.toMatch(/https?:/);
    expect(cut).toContain('data:image/png;base64,AAAA');
    expect(off.remote).toBe(5);
    const on = { remote: 0 };
    const kept = cssUrls(css, true, on);
    for (const host of ['cssescape.example', 'imageset.example/b.png', 'imageset.example/c.png', 'quoted.example', 'upper.example']) {
      expect(kept, host).toContain(host);
    }
    expect(on.remote).toBe(5);
    // An escape that stands for a quote or a brace stays as written, so a string keeps its meaning.
    expect(cssUnescape('content:"\\22"; a\\7d b')).toBe('content:"\\22"; a\\7d b');
    // This server's own addresses never load, images on or not.
    expect(cssUrls('a{background:url(https://mail.example/api/x)}', true, { remote: 0 })).not.toContain('mail.example');
  });

  it('shows a background picture of an old table layout with the rest, as a style the frame treats like any image', () => {
    const { backgroundStyle } = reader();
    expect(backgroundStyle('https://cdn.example/bg.png')).toBe('background-image:url("https://cdn.example/bg.png")');
    // A quote cannot end the url() early.
    expect(backgroundStyle('https://cdn.example/a").x{color:red')).not.toContain('a")');
    const script = clientScript();
    expect(script).toContain('if (imagesOn) background = backgroundStyle(target);');
    // A link whose address was taken away is drawn as text, not as a link that does nothing.
    expect(script).toContain("doc.createElement(tag === 'a' && !url ? 'span' : tag)");
  });

  it('forgets what this device kept on signing out, even when the session has already ended', async () => {
    const did: string[] = [];
    const context: Record<string, unknown> = {
      navigator: { serviceWorker: { getRegistration: async () => ({ active: { postMessage: (m: { type: string }) => did.push(`worker ${m.type}`) } }) } },
      forgetLocal: () => did.push('forgot'),
      // The session ended: every request is refused.
      fetch: async (path: string) => { did.push(`asked ${path}`); return { ok: false, status: 401 }; },
      toast: (text: string) => did.push(`said ${text}`), t: (key: string) => key, location: { replace: () => did.push('left') },
      JSON,
    };
    const signOut = lifted<() => Promise<void>>(['signOut'], 'signOut', context);
    await signOut();
    expect(did).toEqual(['worker signout', 'forgot', 'asked /auth/signout', 'said session.signoutFailed']);
  });
});
