import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './setup.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo, Server } from 'node:net';
import { Client, StreamableHTTPClientTransport, type VersionNegotiationOptions } from '@modelcontextprotocol/client';
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';
import { CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server';
import { MCP_MAX_REQUEST_BODY_BYTES, startMcpHttp } from '../src/mcp.js';
import { SKILL_URI, skillCatalogOrNone } from '../src/mcp-skills.js';
import { StateStore } from '../src/services/state.js';
import { closeSettingsStore } from '../src/services/settings-store.js';
import { setSettingsAccounts } from '../src/config.js';
import { resetRuntimeControl } from '../src/services/runtime-control.js';
import { sendBodyLimit } from '../src/web-actions.js';

/**
 * The skill is read as the endpoint starts. It reads the same here as there;
 * through this it can be made to come to nothing, to see what the endpoint
 * does without it.
 */
vi.mock('../src/mcp-skills.js', async (original) => {
  const real = await original<typeof import('../src/mcp-skills.js')>();
  return { ...real, skillCatalogOrNone: vi.fn(real.skillCatalogOrNone) };
});

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

/** The skill as the repository has it, which is what the endpoint serves. */
const skillFile = (): string => readFileSync(new URL('../.agents/skills/mailsift/SKILL.md', import.meta.url), 'utf8');

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

describe('one request to /mcp has a size of its own', () => {
  it('is refused by its size alone before anything in it is parsed, says the limit, and is read whole just inside it', async () => {
    process.env.MCP_TOKEN = READ;
    const url = await start();
    const limit = MCP_MAX_REQUEST_BODY_BYTES;
    // The same call, padded past what a whole request may carry, and again just inside it.
    const call = (padding: number) => JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_mail', arguments: { note: 'x'.repeat(padding) } },
    });
    const send = (body: string) => fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${READ}` },
      body,
    });
    const over = await send(call(limit));
    expect(over.status).toBe(413);
    const refused = JSON.parse(await over.text()) as { error: { code: number; message: string } };
    // The transport's own answer, in the protocol's reserved range for it.
    expect(refused.error.code).toBe(-32000);
    expect(refused.error.message).toContain(String(limit));
    // Just inside the limit the call is read to its end and answered like any other.
    const { status, body } = await rpc(url, READ, 'tools/call', { name: 'list_mail', arguments: { note: 'x'.repeat(limit - 4096) } });
    expect(status).toBe(200);
    expect(body['result']).toBeDefined();
    expect(body['error']).toBeUndefined();
  });

  it('has its refusal reach a caller that is still sending, every time it asks', async () => {
    process.env.MCP_TOKEN = READ;
    const url = await start();
    // A caller learns the limit from the answer, so the answer has to get past what it is still sending.
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_mail', arguments: { note: 'x'.repeat(MCP_MAX_REQUEST_BODY_BYTES) } },
    });
    for (let ask = 1; ask <= 8; ask += 1) {
      const refused = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${READ}` },
        body,
      }).catch((error: Error) => {
        throw new Error(`ask ${ask} was cut off: ${error.message}, ${(error.cause as Error | undefined)?.message ?? ''}`);
      });
      expect(refused.status, `ask ${ask}`).toBe(413);
      expect(((await refused.json()) as { error: { message: string } }).error.message).toContain(String(MCP_MAX_REQUEST_BODY_BYTES));
    }
  });

  it('waits for a caller that is still sending before it refuses it, so that the caller reads the refusal', async () => {
    process.env.MCP_TOKEN = READ;
    await start();
    const { port } = server!.address() as AddressInfo;
    // Declared one byte over the limit and sent in two pieces with a pause between: the server has
    // its reason to answer after the first. A caller that uploads for minutes is this, for longer.
    const declared = MCP_MAX_REQUEST_BODY_BYTES + 1;
    const first = 'x'.repeat(1024);
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      let heard = Buffer.alloc(0);
      let finished = false;
      socket.setTimeout(10_000, () => socket.destroy(new Error('no answer')));
      socket.on('error', reject);
      socket.on('data', (chunk: Buffer) => { heard = Buffer.concat([heard, chunk]); });
      socket.on('close', () => {
        // Closed before the caller was done: that is an answer sent while the rest was still coming.
        if (finished) resolve(heard.toString('utf8'));
        else reject(new Error(`the line was closed while the caller was still sending; it had heard: ${heard.toString('utf8').slice(0, 60)}`));
      });
      socket.on('connect', () => {
        socket.write(
          `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\ncontent-type: application/json\r\naccept: application/json, text/event-stream\r\n` +
            `authorization: Bearer ${READ}\r\ncontent-length: ${declared}\r\n\r\n${first}`,
        );
        setTimeout(() => {
          // Answered now, the answer would be followed by a close with the rest still coming, and
          // what the caller reads of that is a reset.
          if (heard.length > 0) {
            socket.destroy();
            reject(new Error(`answered while the caller was still sending: ${heard.toString('utf8').slice(0, 60)}`));
            return;
          }
          finished = true;
          socket.end('x'.repeat(declared - first.length));
        }, 700);
      });
    });
    expect(answer.split('\r\n')[0]).toBe('HTTP/1.1 413 Payload Too Large');
    // The answer comes in chunks: its JSON is from the first brace to the last.
    const body = JSON.parse(answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1)) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toContain(String(MCP_MAX_REQUEST_BODY_BYTES));
  });
});

describe('the revision a client is served on', () => {
  /** The SDK's own client at the endpoint with the read credential, asked for a revision the way a client asks. */
  async function connected(url: string, negotiation?: VersionNegotiationOptions): Promise<Client> {
    const client = new Client(
      { name: 'mcp-test', version: '0.0.0' },
      negotiation ? { versionNegotiation: negotiation } : {},
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${READ}` } },
    }));
    return client;
  }

  it('is 2026-07-28 for a client that asks for it, and the skill is on it', async () => {
    process.env.MCP_TOKEN = READ;
    const url = await start();
    // The second is a client that asks what is on offer and takes the newest; the first takes nothing else.
    for (const negotiation of [{ mode: { pin: '2026-07-28' } }, { mode: 'auto' }] as const) {
      const client = await connected(url, negotiation);
      try {
        expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
        const skills = new SkillsClient(client);
        expect(skills.supported).toBe(true);
        expect((await skills.list()).skills.map((one) => one.uri)).toEqual([SKILL_URI]);
        const { skill } = await skills.get(SKILL_URI);
        expect((await skills.read(skill)).text).toBe(skillFile());
        // What a client has always come for answers on the same revision.
        expect((await client.listTools()).tools.map((one) => one.name)).toContain('list_mail');
      } finally {
        await client.close();
      }
    }
    // Each read of it is written down, once; the listing and the asking are not.
    const store = new StateStore();
    try {
      expect(store.mcpAuditByAction().find((row) => row.action === 'resource:skill')).toMatchObject({ calls: 2, failures: 0 });
    } finally {
      store.close();
    }
  });

  it('is 2025-11-25 for a client that asks for nothing, as before, and the skill is on it all the same', async () => {
    process.env.MCP_TOKEN = READ;
    const url = await start();
    const client = await connected(url);
    try {
      expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
      const skills = new SkillsClient(client);
      expect((await skills.list()).skills.map((one) => one.uri)).toEqual([SKILL_URI]);
      const { skill } = await skills.get(SKILL_URI);
      expect((await skills.read(skill)).text).toBe(skillFile());
    } finally {
      await client.close();
    }
  });

  it('answers a client listening for changes with what it would be told of, on a line the client holds', async () => {
    process.env.MCP_TOKEN = READ;
    const url = await start();
    const revision = '2026-07-28';
    const listening = new AbortController();
    const answer = await fetch(url, {
      method: 'POST', signal: listening.signal,
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${READ}`,
        'mcp-protocol-version': revision, 'mcp-method': 'subscriptions/listen',
      },
      // A client on this revision says which changes it wants told of, in the envelope it says its revision in.
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'subscriptions/listen',
        params: {
          notifications: { toolsListChanged: true, resourcesListChanged: true, resourceSubscriptions: ['mailsift://search-syntax'] },
          _meta: { [PROTOCOL_VERSION_META_KEY]: revision, [CLIENT_CAPABILITIES_META_KEY]: {} },
        },
      }),
    });
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toContain('text/event-stream');
    const reader = answer.body!.getReader();
    const decoder = new TextDecoder();
    let heard = '';
    // The first event says which of those this server undertakes to tell of.
    while (!heard.includes('\n\n')) heard += decoder.decode((await reader.read()).value, { stream: true });
    listening.abort();
    const acknowledged = JSON.parse(heard.split('\n').find((line) => line.startsWith('data:'))!.slice('data:'.length)) as {
      method: string; params: { notifications: Record<string, unknown> };
    };
    expect(acknowledged.method).toBe('notifications/subscriptions/acknowledged');
    // It takes no subscription for one resource: it has no way to say that a letter arrived.
    expect(acknowledged.params.notifications).toEqual({ toolsListChanged: true, resourcesListChanged: true });
    // Nothing waits on the line once the client has let go of it: the server closes without being asked twice.
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it('has nothing to say to a GET, and says so with the one method it takes', async () => {
    process.env.MCP_TOKEN = READ;
    const url = await start();
    // Each call is a server of its own: there is no session whose changes a standing line could carry.
    const asked = await fetch(url, { headers: { authorization: `Bearer ${READ}` } });
    expect(asked.status).toBe(405);
    expect(asked.headers.get('allow')).toBe('POST');
    // The credential is asked for first, whatever the method.
    expect((await fetch(url)).status).toBe(401);
  });
});

describe('the skill over the endpoint', () => {
  it('is served to each credential alike, as the file itself, and to no one without one', async () => {
    process.env.MCP_TOKEN = READ;
    process.env.MCP_WRITE_TOKEN = WRITE;
    process.env.MCP_ADMIN_TOKEN = ADMIN;
    const url = await start({ adminAuth: true });
    for (const token of [READ, WRITE, ADMIN]) {
      const read = await rpc(url, token, 'resources/read', { uri: SKILL_URI });
      expect(read.status, 'read').toBe(200);
      expect(read.body['error']).toBeUndefined();
      expect((read.body['result'] as { contents: unknown }).contents).toMatchObject([{ uri: SKILL_URI, mimeType: 'text/markdown', text: skillFile() }]);
      const listed = await rpc(url, token, 'skills/list');
      expect((listed.body['result'] as { skills: Array<{ uri: string }> }).skills.map((one) => one.uri)).toEqual([SKILL_URI]);
    }
    for (const token of ['', 'x'.repeat(64)]) {
      expect((await rpc(url, token, 'resources/read', { uri: SKILL_URI })).status).toBe(401);
      expect((await rpc(url, token, 'skills/list')).status).toBe(401);
    }
  });

  it('is said at every start: served, or not there', async () => {
    process.env.MCP_TOKEN = READ;
    const said = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await start();
      expect(said.mock.calls.flat().some((line) => String(line).endsWith(` · skill: served at ${SKILL_URI}`))).toBe(true);
    } finally {
      said.mockRestore();
    }
  });

  it('does not keep the endpoint from starting, or from answering mail, when it could not be read', async () => {
    process.env.MCP_TOKEN = READ;
    vi.mocked(skillCatalogOrNone).mockResolvedValueOnce(undefined);
    const url = await start();
    const { body } = await rpc(url, READ, 'initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'mcp-test', version: '0.0.0' },
    });
    expect((body['result'] as { capabilities: Record<string, unknown> }).capabilities['extensions']).toBeUndefined();
    expect((await listTools(url, READ)).names).toContain('list_mail');
    expect((await rpc(url, READ, 'resources/read', { uri: SKILL_URI })).body['error']).toMatchObject({ code: -32602 });
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
