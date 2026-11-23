import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './setup.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { routeWeb } from '../src/web.js';
import { StateStore } from '../src/services/state.js';
import {
  closeSettingsStore, issueSetupCode, readSettings, updateSettings,
} from '../src/services/settings-store.js';
import { resetRuntimeControl, setServerMode } from '../src/services/runtime-control.js';
import { authorizedUsernames } from '../src/imap/auth.js';
import { setSettingsAccounts } from '../src/config.js';
import { healthReport } from '../src/mcp.js';

let dir: string;
let store: StateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailsift-admin-'));
  process.env.STATE_DB_PATH = join(dir, 'mailsift.db');
  process.env.MAILSIFT_KEY_FILE = join(dir, 'mailsift.key');
  store = new StateStore(':memory:');
  resetRuntimeControl();
});

afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  closeSettingsStore();
  setSettingsAccounts(undefined);
  resetRuntimeControl();
  rmSync(dir, { recursive: true, force: true });
});

function request(options: { method?: string; url?: string; headers?: Record<string, string>; body?: string } = {}): IncomingMessage {
  const stream = Readable.from(options.body ? [Buffer.from(options.body)] : []);
  return Object.assign(stream, {
    method: options.method ?? 'GET',
    url: options.url ?? '/',
    headers: { host: '127.0.0.1:8410', ...(options.headers ?? {}) },
  }) as unknown as IncomingMessage;
}

let cookie = '';
let client = 0;

async function call(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string>; setupMode?: boolean } = {}) {
  const method = options.method ?? (options.body !== undefined ? 'POST' : 'GET');
  const headers: Record<string, string> = {
    ...(cookie ? { cookie } : {}),
    ...(method === 'POST' ? { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } : {}),
    ...(options.headers ?? {}),
  };
  const answer = await routeWeb(
    request({ method, url: path, headers, ...(options.body !== undefined ? { body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body) } : {}) }),
    new URL(path, 'http://127.0.0.1:8410'), 'read-token', store, `client-${client}`,
    { adminAuth: true, setupMode: options.setupMode ?? false, writeToken: 'write-token' },
  );
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(String(answer.body)) as Record<string, unknown>; } catch { /* a page */ }
  return { answer, json };
}

async function claim(): Promise<void> {
  const code = issueSetupCode()!;
  const { answer } = await call('/api/admin/claim', { body: { code, password: 'a long password' } });
  expect(answer.status).toBe(200);
  cookie = String(answer.cookie).split(';')[0]!;
}

// Each test is its own client, so the per-client limits on claiming do not carry over.
beforeEach(() => { cookie = ''; client += 1; });

describe('a server nobody has claimed', { timeout: 30_000 }, () => {
  it('leads every page to the claim form, and the claim needs the code', async () => {
    setServerMode('setup');
    const home = await call('/', { setupMode: true });
    expect(home.answer.status).toBe(303);
    expect(home.answer.headers?.['location']).toBe('/setup');
    const page = await call('/setup', { setupMode: true });
    expect(String(page.answer.body)).toContain('id="claim"');
    issueSetupCode();
    const wrong = await call('/api/admin/claim', { body: { code: 'AAAA-BBBB-CCCC-DDDD', password: 'a long password' } });
    expect(wrong.answer.status).toBe(401);
    const weak = await call('/api/admin/claim', { body: { code: 'x', password: 'short' } });
    expect(weak.answer.status).toBe(400);
    await claim();
    expect(cookie).toMatch(/^mailsift_admin=/);
    const again = await call('/api/admin/claim', { body: { code: 'x', password: 'a long password' } });
    expect(again.answer.status).toBe(409);
  });

  it('refuses a claim another site started', async () => {
    issueSetupCode();
    const { answer } = await call('/api/admin/claim', {
      body: { code: 'x', password: 'a long password' }, headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(answer.status).toBe(403);
  });
});

describe('the settings API', { timeout: 30_000 }, () => {
  it('answers only an administrator session, not an MCP token', async () => {
    await claim();
    const signedIn = await call('/api/admin/state');
    expect(signedIn.answer.status).toBe(200);
    cookie = '';
    expect((await call('/api/admin/state')).answer.status).toBe(401);
    const bearer = await call('/api/admin/state', { headers: { authorization: 'Bearer write-token' } });
    expect(bearer.answer.status).toBe(401);
    const tokenCookie = await call('/api/admin/settings', { body: { values: { LOG_LEVEL: 'debug' } }, headers: { cookie: 'mailsift_session=write-token' } });
    expect(tokenCookie.answer.status).toBe(401);
  });

  it('links Settings from the mail view of a token session too, where the password is asked for', async () => {
    await claim();
    cookie = '';
    const page = await call('/', { headers: { cookie: 'mailsift_session=write-token' } });
    expect(page.answer.status).toBe(200);
    expect(String(page.answer.body)).toContain('href="/settings?back=1"');
    const settings = await call('/settings', { headers: { cookie: 'mailsift_session=write-token' } });
    expect(settings.answer.status).toBe(303);
    expect(settings.answer.headers?.['location']).toBe('/signin?next=%2Fsettings');
  });

  it('draws Settings from the page itself, in both languages, and signs out in one trip', async () => {
    setServerMode('setup');
    await claim();
    const page = String((await call('/setup')).answer.body);
    const boot = JSON.parse(/<script type="application\/json" id="boot">([^<]*)<\/script>/.exec(page)![1]!) as Record<string, any>;
    expect(boot['state']['setupComplete']).toBe(false);
    expect(Object.keys(boot['locales'])).toEqual(['en', 'zh-CN']);
    expect(boot['locales']['zh-CN']['strings']['mb.title']).toBe('邮箱');
    const out = await call('/auth/signout', { method: 'POST', headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' } });
    expect(out.answer.status).toBe(200);
    expect(String(out.answer.body)).toContain('action="/auth"');
    expect(out.answer.extraCookies?.[0]).toMatch(/^mailsift_admin=; .*Max-Age=0/);
    expect((await call('/api/admin/state')).answer.status).toBe(401);
  });

  it('signs in at the ordinary form with the administrator password', async () => {
    await claim();
    cookie = '';
    const form = await routeWeb(
      request({ method: 'POST', url: '/auth', body: 'token=a%20long%20password&next=%2Fsettings', headers: { 'sec-fetch-site': 'same-origin' } }),
      new URL('/auth', 'http://127.0.0.1:8410'), 'read-token', store, 'c2', { adminAuth: true, writeToken: 'write-token' },
    );
    expect(form.status).toBe(303);
    expect(form.headers?.['location']).toBe('/settings');
    expect(String(form.cookie)).toMatch(/^mailsift_admin=.*HttpOnly; SameSite=Lax/);
  });

  it('validates a save, stores it, and never sends a secret back', async () => {
    setServerMode('setup');
    await claim();
    const bad = await call('/api/admin/settings', { body: { values: { POLL_INTERVAL_SECONDS: '5', NOT_A_KEY: 'x' } } });
    expect(bad.answer.status).toBe(400);
    expect(Object.keys(bad.json['errors'] as object).sort()).toEqual(['NOT_A_KEY', 'POLL_INTERVAL_SECONDS']);
    const ok = await call('/api/admin/settings', { body: { values: { POLL_INTERVAL_SECONDS: '900', LLM_API_KEY: 'sk-secret-123' } } });
    expect(ok.answer.status).toBe(200);
    expect(ok.json['applied']).toBe('none');
    expect(String(ok.answer.body)).not.toContain('sk-secret-123');
    const state = (await call('/api/admin/state')).json;
    expect(state['values']).toMatchObject({ POLL_INTERVAL_SECONDS: '900' });
    expect(state['secrets']).toMatchObject({ LLM_API_KEY: true });
    expect(JSON.stringify(state)).not.toContain('sk-secret-123');
    expect(JSON.stringify(state)).not.toContain(readSettings().values['MCP_TOKEN'] ?? 'never');
    // Leaving a secret empty keeps it; null removes it; '' resets a value to its default.
    await call('/api/admin/settings', { body: { values: { LLM_API_KEY: '', POLL_INTERVAL_SECONDS: '' } } });
    expect(readSettings().values['LLM_API_KEY']).toBe('sk-secret-123');
    expect(readSettings().values['POLL_INTERVAL_SECONDS']).toBeUndefined();
    await call('/api/admin/settings', { body: { values: { LLM_API_KEY: null } } });
    expect(readSettings().values['LLM_API_KEY']).toBeUndefined();
    // During setup the values are applied in place.
    await call('/api/admin/settings', { body: { values: { DIGEST_HOUR: '7' } } });
    expect(process.env.DIGEST_HOUR).toBe('7');
  });

  it('cannot overwrite the API tokens through the field list', async () => {
    await claim();
    const before = readSettings().values['MCP_TOKEN'];
    const attempt = await call('/api/admin/settings', { body: { values: { MCP_TOKEN: 'mine' } } });
    expect(attempt.answer.status).toBe(400);
    expect(readSettings().values['MCP_TOKEN']).toBe(before);
  });

  it('keeps a mailbox password when the field is left empty, and checks the mailbox', async () => {
    setServerMode('setup');
    await claim();
    const missing = await call('/api/admin/mailboxes/save', { body: { mailbox: { provider: 'qq', username: 'me@qq.com' } } });
    expect(missing.answer.status).toBe(400);
    const noHost = await call('/api/admin/mailboxes/save', { body: { mailbox: { provider: 'imap', username: 'me@corp.example', password: 'x' } } });
    expect(noHost.answer.status).toBe(400);
    const saved = await call('/api/admin/mailboxes/save', { body: { mailbox: { provider: 'qq', username: 'Me@QQ.com', password: 'p|w', folders: ['all'] } } });
    expect(saved.answer.status).toBe(200);
    const mailbox = saved.json['mailbox'] as Record<string, unknown>;
    expect(mailbox).toMatchObject({ username: 'me@qq.com', hasPassword: true, readiness: 'ready', folders: ['all'] });
    expect(String(saved.answer.body)).not.toContain('p|w');
    const edited = await call('/api/admin/mailboxes/save', { body: { id: mailbox['id'], mailbox: { provider: 'qq', username: 'me@qq.com', name: 'Personal' } } });
    expect(edited.answer.status).toBe(200);
    expect(readSettings().mailboxes[0]).toMatchObject({ name: 'Personal', password: 'p|w' });
    const duplicate = await call('/api/admin/mailboxes/save', { body: { mailbox: { provider: 'qq', username: 'ME@qq.com', password: 'x' } } });
    expect(duplicate.answer.status).toBe(400);
    // A test of a mailbox that is gone says so, instead of judging an empty form.
    const gone = await call('/api/admin/mailboxes/test', { body: { id: 'not-a-mailbox' } });
    expect(gone.answer.status).toBe(404);
    expect(gone.json['code']).toBe('no_mailbox');
    const removed = await call('/api/admin/mailboxes/delete', { body: { id: mailbox['id'] } });
    expect(removed.answer.status).toBe(200);
    expect(readSettings().mailboxes).toEqual([]);
  });

  it('finishes setup only with a mailbox that is ready, then asks for a restart', async () => {
    setServerMode('setup');
    await claim();
    expect((await call('/api/admin/setup/finish', { body: {} })).answer.status).toBe(400);
    await call('/api/admin/mailboxes/save', { body: { mailbox: { provider: 'qq', username: 'me@qq.com', password: 'pw' } } });
    const done = await call('/api/admin/setup/finish', { body: {} });
    expect(done.answer.status).toBe(200);
    // No supervisor in a test: the owner is told to restart.
    expect(done.json['applied']).toBe('manual');
    expect(readSettings().setupCompletedAt).toBeTruthy();
  });

  it('replaces an API token and shows the new one once', async () => {
    await claim();
    const before = readSettings().values['MCP_WRITE_TOKEN'];
    const { json } = await call('/api/admin/tokens/rotate', { body: { kind: 'write' } });
    expect(json['token']).toMatch(/^ms_/);
    expect(json['token']).not.toBe(before);
    expect(readSettings().values['MCP_WRITE_TOKEN']).toBe(json['token']);
    expect(JSON.stringify(json['state'])).not.toContain(String(json['token']));
  });
});

describe('signing in to Gmail and Outlook', { timeout: 30_000 }, () => {
  async function gmailMailbox(): Promise<string> {
    await claim();
    await call('/api/admin/settings', { body: { values: { GMAIL_CLIENT_ID: 'client.apps.googleusercontent.com', GMAIL_CLIENT_SECRET: 'GOCSPX-x' } } });
    const saved = await call('/api/admin/mailboxes/save', { body: { mailbox: { provider: 'gmail', username: 'me@gmail.com' } } });
    return String((saved.json['mailbox'] as Record<string, unknown>)['id']);
  }

  it('sends the browser straight back to the page when it is opened at a loopback address', async () => {
    setServerMode('setup');
    const id = await gmailMailbox();
    const start = await call('/api/admin/oauth/start', { body: { id } });
    expect(start.json['mode']).toBe('direct');
    expect(start.json['redirectUri']).toBe('http://localhost:8410/');
    const url = new URL(String(start.json['url']));
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('login_hint')).toBe('me@gmail.com');

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ access_token: 'ya29.access', refresh_token: '1//refresh', expires_in: 3600 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    // The provider's redirect lands without the session cookie (another site to the browser).
    cookie = '';
    const back = await call(`/?state=${start.json['state']}&code=the-code`);
    expect(back.answer.status).toBe(303);
    expect(back.answer.headers?.['location']).toBe(`http://127.0.0.1:8410/settings?oauth=ok&mailbox=${id}#mailboxes`);
    const sent = String((fetchMock.mock.calls[0]![1] as RequestInit).body);
    expect(sent).toContain('code=the-code');
    expect(sent).toContain('code_verifier=');
    expect(sent).toContain(encodeURIComponent('http://localhost:8410/'));
    expect(authorizedUsernames()).toEqual(new Set(['me@gmail.com']));
    // The state is spent.
    const replay = await call(`/?state=${start.json['state']}&code=the-code`);
    expect(replay.answer.headers?.['location']).toContain('oauth=expired');
  });

  it('asks for the redirected address to be pasted back when the page is reached over HTTPS', async () => {
    setServerMode('setup');
    const id = await gmailMailbox();
    const start = await call('/api/admin/oauth/start', { body: { id }, headers: { host: 'mail.example.com', 'x-forwarded-proto': 'https' } });
    expect(start.json['mode']).toBe('paste');
    expect(start.json['redirectUri']).toBe('http://localhost:8765/');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ access_token: 'ya29.access', refresh_token: '1//refresh', expires_in: 3600 }), { status: 200 },
    ));
    const wrong = await call('/api/admin/oauth/finish', { body: { url: 'http://localhost:8765/?state=forged&code=x' } });
    expect(wrong.answer.status).toBe(400);
    const done = await call('/api/admin/oauth/finish', { body: { url: `http://localhost:8765/?state=${start.json['state']}&code=abc&scope=x` } });
    expect(done.answer.status).toBe(200);
    expect(done.json['authorized']).toBe(true);
    const state = done.json['state'] as { mailboxes: Array<{ readiness: string }> };
    expect(state.mailboxes[0]!.readiness).toBe('ready');
  });

  it('says what is missing when no OAuth app is configured', async () => {
    await claim();
    const saved = await call('/api/admin/mailboxes/save', { body: { mailbox: { provider: 'outlook', username: 'me@outlook.com' } } });
    const id = (saved.json['mailbox'] as Record<string, unknown>)['id'];
    const start = await call('/api/admin/oauth/start', { body: { id } });
    expect(start.answer.status).toBe(400);
    expect(String(start.json['error'])).toContain('Microsoft');
  });
});

describe('health', () => {
  it('is healthy while waiting for setup, and stale only when checks stop', () => {
    setServerMode('setup');
    expect(healthReport()).toMatchObject({ status: 'ok', mode: 'setup' });
    setServerMode('running');
    // Within the first quarter of an hour of a boot, no check yet is fine.
    expect(healthReport().status).toBe('ok');
    updateSettings(() => undefined);
  });
});
