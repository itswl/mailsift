import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import './setup.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import type { AddressInfo, Server } from 'node:net';
import { startMcpHttp } from '../src/mcp.js';
import { StateStore } from '../src/services/state.js';
import { closeSettingsStore } from '../src/services/settings-store.js';
import { setSettingsAccounts } from '../src/config.js';
import { resetRuntimeControl } from '../src/services/runtime-control.js';
import { sendBodyLimit } from '../src/web-actions.js';

/**
 * The credential split lives in the HTTP layer, not in createServer.
 *
 * createServer takes `writable` and `admin` as arguments, so a unit test of it
 * proves only that the flags are honoured. Whether a presented bearer token
 * turns into those flags, and whether the read token is kept away from them,
 * is decided here and is the part a leak would exploit.
 */
const READ = 'r'.repeat(64);
const WRITE = 'w'.repeat(64);
const ADMIN = 'a'.repeat(64);

let server: Server | undefined;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailsift-mcp-http-'));
  process.env.STATE_DB_PATH = join(dir, 'state.db');
  process.env.MAILSIFT_KEY_FILE = join(dir, 'mailsift.key');
  process.env.MCP_BIND = '127.0.0.1';
  process.env.MCP_PORT = '0';
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  closeSettingsStore();
  setSettingsAccounts(undefined);
  resetRuntimeControl();
  rmSync(dir, { recursive: true, force: true });
});

async function start(options: Parameters<typeof startMcpHttp>[0] = {}): Promise<string> {
  server = await startMcpHttp(options);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/mcp`;
}

/** One call, as a client makes it. Stateless Streamable HTTP answers a single call as one SSE event. */
async function rpc(url: string, token: string, method: string, params: Record<string, unknown> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) return { status: res.status, body: {} };
  const text = await res.text();
  const payload = text.startsWith('event:') || text.startsWith('data:')
    ? text.split('\n').find((line) => line.startsWith('data:'))!.slice('data:'.length)
    : text;
  return { status: res.status, body: JSON.parse(payload) as Record<string, unknown> };
}

async function listTools(url: string, token: string): Promise<{ status: number; names: string[] }> {
  const { status, body } = await rpc(url, token, 'tools/list');
  const result = body['result'] as { tools?: Array<{ name: string }> } | undefined;
  return { status, names: (result?.tools ?? []).map((t) => t.name) };
}

/** A tool's answer over the endpoint: its first block, as the JSON the tools answer with. */
async function tool(url: string, token: string, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { body } = await rpc(url, token, 'tools/call', { name, arguments: args });
  const result = body['result'] as { isError?: boolean; content?: Array<{ type: string; text: string }> } | undefined;
  expect(result?.isError ?? false, JSON.stringify(body)).toBe(false);
  return JSON.parse(result!.content![0]!.text) as Record<string, unknown>;
}

/** A tool's refusal over the endpoint. */
async function refusal(url: string, token: string, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { body } = await rpc(url, token, 'tools/call', { name, arguments: args });
  const result = body['result'] as { isError?: boolean; content?: Array<{ type: string; text: string }> } | undefined;
  expect(result?.isError, JSON.stringify(body)).toBe(true);
  return JSON.parse(result!.content![0]!.text) as Record<string, unknown>;
}

/** What the write credential adds to the read one: everything that changes something. */
const WRITE_TOOLS = [
  'get_triage_rules', 'manage_mail', 'mark_handled', 'record_feedback', 'remove_push_device', 'retry_dead_letter', 'send_mail',
  'set_signature', 'set_triage_rules', 'snooze',
];
/** What the admin token adds on top of those: the settings API of the page, one tool to a route. */
const ADMIN_TOOLS = [
  'change_admin_password', 'end_other_sessions', 'get_settings', 'manage_mailbox', 'rotate_token', 'test_model', 'test_notifications',
  'update_settings',
];

describe('bearer credentials decide the tool set', () => {
  it('gives a read token everything except the tools that change something', async () => {
    process.env.MCP_TOKEN = READ;
    process.env.MCP_WRITE_TOKEN = WRITE;
    const url = await start();

    const { status, names } = await listTools(url, READ);
    expect(status).toBe(200);
    expect(names).toContain('list_mail');
    expect(names).toContain('read_message');
    // What the page only shows, the page has here too.
    expect(names).toEqual(expect.arrayContaining(['get_conversation', 'list_push_devices']));
    // A check of the mailboxes needs the server's poller: a bare endpoint does not offer it.
    expect(names).not.toContain('refresh');
    // Nothing that changes a mailbox, sends mail, or changes how mail is judged.
    for (const name of WRITE_TOOLS) expect(names, name).not.toContain(name);
    for (const name of ADMIN_TOOLS) expect(names, name).not.toContain(name);
  });

  it('gives the write token the full surface, sending included, and none of the administrator’s', async () => {
    process.env.MCP_TOKEN = READ;
    process.env.MCP_WRITE_TOKEN = WRITE;
    process.env.MCP_ADMIN_TOKEN = ADMIN;
    const url = await start({ adminAuth: true });

    const { names } = await listTools(url, WRITE);
    for (const name of WRITE_TOOLS) expect(names, name).toContain(name);
    for (const name of ADMIN_TOOLS) expect(names, name).not.toContain(name);
    // Not listed, and not reachable by name either.
    expect(await refusal(url, WRITE, 'get_settings')).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await refusal(url, WRITE, 'rotate_token', { kind: 'admin' })).toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('gives the admin token everything, the administrator’s tools included, and only over the server’s endpoint', async () => {
    process.env.MCP_TOKEN = READ;
    process.env.MCP_WRITE_TOKEN = WRITE;
    process.env.MCP_ADMIN_TOKEN = ADMIN;
    const url = await start({ adminAuth: true });

    const { names } = await listTools(url, ADMIN);
    for (const name of [...WRITE_TOOLS, ...ADMIN_TOOLS]) expect(names, name).toContain(name);
    expect(names).toContain('list_mail');
    // The settings answer it with the token it is called with: here the one the environment gave, which is not one
    // generated in Settings, so of the three it says none is stored, as it does of the other two.
    expect(await tool(url, ADMIN, 'get_settings', { keys: ['DIGEST_HOUR'] })).toMatchObject({ mode: 'setup', tokens: { admin: false } });
    expect(await refusal(url, ADMIN, 'update_settings', { values: {} })).toMatchObject({ code: 'INVALID_ARGUMENT' });
    // The other two tokens get nothing of the administrator's, with one issued beside them.
    for (const token of [READ, WRITE]) {
      for (const name of ADMIN_TOOLS) expect((await listTools(url, token)).names, name).not.toContain(name);
    }
  });

  it('registers no write tool when no write token is configured', async () => {
    // The default deployment: one token, strictly read-only.
    process.env.MCP_TOKEN = READ;
    delete process.env.MCP_WRITE_TOKEN;
    const url = await start();

    const { names } = await listTools(url, READ);
    for (const name of WRITE_TOOLS) expect(names, name).not.toContain(name);
  });

  it('has no administrator’s tool without one issued, whoever presents a value, and offers it from the server’s endpoint alone', async () => {
    process.env.MCP_TOKEN = READ;
    process.env.MCP_WRITE_TOKEN = WRITE;
    delete process.env.MCP_ADMIN_TOKEN;
    // The server's endpoint with no admin token issued: the value in the header is anybody's.
    const issued = await start({ adminAuth: true });
    expect((await listTools(issued, ADMIN)).status).toBe(401);
    for (const name of ADMIN_TOOLS) expect((await listTools(issued, WRITE)).names, name).not.toContain(name);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    // The same value in the environment is read by the server's endpoint alone: an instance without the settings
    // store, as a tool run by hand is, offers the administrator's tools to nobody, whoever presents it.
    process.env.MCP_ADMIN_TOKEN = ADMIN;
    const bare = await start();
    expect((await listTools(bare, ADMIN)).status).toBe(401);
    const { names } = await listTools(bare, WRITE);
    for (const name of ADMIN_TOOLS) expect(names, name).not.toContain(name);
  });

  it('rejects a token that is neither', async () => {
    process.env.MCP_TOKEN = READ;
    process.env.MCP_WRITE_TOKEN = WRITE;
    const url = await start();

    expect((await listTools(url, 'x'.repeat(64))).status).toBe(401);
    expect((await listTools(url, '')).status).toBe(401);
  });

  it('refuses to start when one value is used for two of them', async () => {
    // Sharing the value would hand every reader the write tools, or either of
    // them the administrator's, which is the whole thing the split exists to
    // prevent, so it fails loudly.
    process.env.MCP_TOKEN = READ;
    process.env.MCP_WRITE_TOKEN = READ;
    await expect(start()).rejects.toThrow(/must differ/i);
    process.env.MCP_WRITE_TOKEN = WRITE;
    process.env.MCP_ADMIN_TOKEN = WRITE;
    await expect(start({ adminAuth: true })).rejects.toThrow(/must differ/i);
    process.env.MCP_ADMIN_TOKEN = READ;
    await expect(start({ adminAuth: true })).rejects.toThrow(/must differ/i);
  });

  it('offers a check of the mailboxes when the server has a poller to run, to a reader too', async () => {
    process.env.MCP_TOKEN = READ;
    let polls = 0;
    const url = await start({
      onRefresh: async () => { polls += 1; return { accountsOk: 1, accountsFailed: 0, fetched: 3, fresh: 1, pushed: 0, queued: 1, spamRescued: 0, failures: [] }; },
    });
    expect((await listTools(url, READ)).names).toContain('refresh');
    expect(await tool(url, READ, 'refresh')).toMatchObject({ accountsOk: 1, fetched: 3 });
    expect(polls).toBe(1);
  });

  it('records a rejected attempt without storing what was presented', async () => {
    process.env.MCP_TOKEN = READ;
    const url = await start();
    await listTools(url, 'x'.repeat(64));

    const store = new StateStore();
    try {
      const rejected = store.mcpAuditByAction().find((row) => row.action === 'unauthorized');
      expect(rejected).toMatchObject({ calls: 1, failures: 1 });
      // Only the outcome and a hash of the caller address are kept.
      expect(JSON.stringify(store.mcpAuditByAction())).not.toContain('x'.repeat(64));
    } finally {
      store.close();
    }
  });
});

describe('a server with no token answers only to this machine’s names', () => {
  /** A request under a chosen Host, which fetch does not let a caller set. */
  function under(port: number, host: string, path = '/mcp', extra: Record<string, string> = {}): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1', port, path, method: 'POST',
        headers: { host, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra },
      }, (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    });
  }

  it('turns away a request that arrived under another site’s name', async () => {
    // What DNS rebinding looks like from here: a page elsewhere pointed a host
    // name of its own at 127.0.0.1, and the browser sends that name in Host.
    delete process.env.MCP_TOKEN;
    delete process.env.MCP_WRITE_TOKEN;
    delete process.env.MCP_ADMIN_TOKEN;
    delete process.env.MCP_ALLOWED_HOSTS;
    await start();
    const { port } = server!.address() as AddressInfo;
    // Refused before anything else: a name that is not this machine's, over plain HTTP.
    const rebound = await under(port, `evil.example:${port}`);
    expect(rebound.status).toBe(403);
    expect(rebound.body).toContain('https_required');
    expect(rebound.body).not.toContain('list_mail');
    expect((await under(port, 'evil.example', '/api/summary')).status).toBe(403);
    const local = await under(port, `127.0.0.1:${port}`);
    expect(local.status).toBe(200);
    expect(local.body).toContain('list_mail');
    expect((await under(port, `localhost:${port}`)).status).toBe(200);
  });

  it('takes a public name only over HTTPS, and then asks for the token', async () => {
    process.env.MCP_TOKEN = READ;
    delete process.env.MCP_WRITE_TOKEN;
    delete process.env.MCP_ADMIN_TOKEN;
    await start();
    const { port } = server!.address() as AddressInfo;
    // Plain HTTP under a public name would carry the token in the clear.
    expect((await under(port, 'mail.example.org')).status).toBe(403);
    // Behind a TLS proxy it is refused for the missing token, not for the name.
    expect((await under(port, 'mail.example.org', '/mcp', { 'x-forwarded-proto': 'https' })).status).toBe(401);
  });
});

describe('a letter from the page is one large request', () => {
  it('is given long enough to arrive over a slow uplink, not the five minutes Node gives every request', async () => {
    process.env.MCP_TOKEN = READ;
    await start();
    // The largest letter at a modest 64 KiB a second (about half a megabit).
    const need = Math.ceil(sendBodyLimit() / (64 * 1024)) * 1000;
    expect(need).toBeGreaterThan(300_000);
    expect((server as unknown as { requestTimeout: number }).requestTimeout).toBeGreaterThanOrEqual(need);
    // Raised to its ceiling, the limit on files raises the time with it.
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    process.env.SMTP_ATTACHMENT_MAX_BYTES = String(35 * 1024 * 1024);
    await start();
    expect((server as unknown as { requestTimeout: number }).requestTimeout).toBeGreaterThanOrEqual(Math.ceil(sendBodyLimit() / (64 * 1024)) * 1000);
    expect(sendBodyLimit()).toBeGreaterThan(40 * 1024 * 1024);
  });
});

describe('the web view on the same port', () => {
  it('has a budget of its own, says in its words when it is spent, and goes on to where a sign-in was asked for', async () => {
    process.env.MCP_TOKEN = READ;
    process.env.WEB_UI_ENABLED = 'true';
    process.env.MCP_RATE_LIMIT_PER_MINUTE = '2';
    // An address of its own, so no other test's budget is touched.
    process.env.TRUSTED_PROXY = 'true';
    const mcp = await start();
    const base = mcp.replace(/\/mcp$/, '');
    const from = { 'x-real-ip': '198.51.100.7' };
    const tools = () => fetch(mcp, {
      method: 'POST', headers: { ...from, 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${READ}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect((await tools()).status).toBe(200);
    expect((await tools()).status).toBe(200);
    expect((await tools()).status).toBe(429);
    // The page on the same address is not locked out by its MCP client.
    const page = () => fetch(`${base}/`, { headers: { ...from, cookie: `mailsift_session=${READ}` }, redirect: 'manual' });
    expect((await page()).status).toBe(200);
    // Signing in goes back to the shortcut it came from.
    const signIn = await fetch(`${base}/auth`, {
      method: 'POST', redirect: 'manual',
      headers: { ...from, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
      body: `token=${READ}&next=${encodeURIComponent('/?focus=code')}`,
    });
    expect(signIn.status).toBe(303);
    expect(signIn.headers.get('location')).toBe('/?focus=code');
    // Twenty a minute here (ten times MCP's two): then a page that says so, not a line of JSON.
    let last: Response | undefined;
    for (let n = 0; n < 20; n += 1) last = await page();
    expect(last!.status).toBe(429);
    const said = await last!.text();
    expect(last!.headers.get('content-type')).toContain('text/html');
    expect(said).toContain('This device asked too often just now');
    // Its mark is not refused by the same spent budget.
    const mark = await fetch(`${base}/icon-192.png?v=3`, { headers: from });
    expect(mark.status).toBe(200);
    expect(mark.headers.get('content-type')).toBe('image/png');
    const api = await fetch(`${base}/api/summary`, { headers: { ...from, cookie: `mailsift_session=${READ}` } });
    expect(await api.json()).toMatchObject({ code: 'rate_limited' });
  });
});
