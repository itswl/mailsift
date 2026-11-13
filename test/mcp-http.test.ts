import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import './setup.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import type { AddressInfo, Server } from 'node:net';
import { startMcpHttp } from '../src/mcp.js';
import { StateStore } from '../src/services/state.js';

/**
 * The credential split lives in the HTTP layer, not in createServer.
 *
 * createServer takes `writable` as an argument, so a unit test of it proves
 * only that the flag is honoured. Whether a presented bearer token turns into
 * that flag, and whether the read token is kept away from it, is decided here
 * and is the part a leak would exploit.
 */
const READ = 'r'.repeat(64);
const WRITE = 'w'.repeat(64);

let server: Server | undefined;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailsift-mcp-http-'));
  process.env.STATE_DB_PATH = join(dir, 'state.db');
  process.env.MCP_BIND = '127.0.0.1';
  process.env.MCP_PORT = '0';
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function start(): Promise<string> {
  server = await startMcpHttp();
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/mcp`;
}

async function listTools(url: string, token: string): Promise<{ status: number; names: string[] }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  if (!res.ok) return { status: res.status, names: [] };
  // Stateless Streamable HTTP answers a single call as one SSE event.
  const text = await res.text();
  const payload = text.startsWith('event:') || text.startsWith('data:')
    ? text.split('\n').find((line) => line.startsWith('data:'))!.slice('data:'.length)
    : text;
  const body = JSON.parse(payload) as { result?: { tools?: Array<{ name: string }> } };
  return { status: res.status, names: (body.result?.tools ?? []).map((t) => t.name) };
}

const WRITE_TOOLS = ['record_feedback', 'retry_dead_letter', 'manage_mail', 'mark_handled', 'send_mail'];

describe('bearer credentials decide the tool set', () => {
  it('gives a read token everything except the tools that change something', async () => {
    process.env.MCP_TOKEN = READ;
    process.env.MCP_WRITE_TOKEN = WRITE;
    const url = await start();

    const { status, names } = await listTools(url, READ);
    expect(status).toBe(200);
    expect(names).toContain('list_mail');
    expect(names).toContain('read_message');
    // Nothing that changes a mailbox, sends mail, or changes how mail is judged.
    for (const name of WRITE_TOOLS) expect(names, name).not.toContain(name);
  });

  it('gives the write token the full surface, sending included', async () => {
    process.env.MCP_TOKEN = READ;
    process.env.MCP_WRITE_TOKEN = WRITE;
    const url = await start();

    const { names } = await listTools(url, WRITE);
    for (const name of WRITE_TOOLS) expect(names, name).toContain(name);
    expect(names).toContain('list_mail');
  });

  it('registers neither write tool when no write token is configured', async () => {
    // The default deployment: one token, strictly read-only.
    process.env.MCP_TOKEN = READ;
    delete process.env.MCP_WRITE_TOKEN;
    const url = await start();

    const { names } = await listTools(url, READ);
    for (const name of WRITE_TOOLS) expect(names, name).not.toContain(name);
  });

  it('rejects a token that is neither', async () => {
    process.env.MCP_TOKEN = READ;
    process.env.MCP_WRITE_TOKEN = WRITE;
    const url = await start();

    expect((await listTools(url, 'x'.repeat(64))).status).toBe(401);
    expect((await listTools(url, '')).status).toBe(401);
  });

  it('refuses to start when one value is used for both', async () => {
    // Sharing the value would hand every reader the write tools, which is the
    // whole thing the split exists to prevent, so it fails loudly.
    process.env.MCP_TOKEN = READ;
    process.env.MCP_WRITE_TOKEN = READ;
    await expect(start()).rejects.toThrow(/must differ/i);
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
  function under(port: number, host: string, path = '/mcp'): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1', port, path, method: 'POST',
        headers: { host, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
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
    delete process.env.MCP_ALLOWED_HOSTS;
    await start();
    const { port } = server!.address() as AddressInfo;
    const rebound = await under(port, `evil.example:${port}`);
    expect(rebound.status).toBe(421);
    expect(rebound.body).not.toContain('list_mail');
    expect((await under(port, 'evil.example', '/api/summary')).status).toBe(421);
    const local = await under(port, `127.0.0.1:${port}`);
    expect(local.status).toBe(200);
    expect(local.body).toContain('list_mail');
    expect((await under(port, `localhost:${port}`)).status).toBe(200);
  });

  it('does not ask about the name once a token is what is checked', async () => {
    process.env.MCP_TOKEN = READ;
    delete process.env.MCP_WRITE_TOKEN;
    await start();
    const { port } = server!.address() as AddressInfo;
    // Refused for the missing token, not for the name.
    expect((await under(port, 'mail.example.org')).status).toBe(401);
  });
});
