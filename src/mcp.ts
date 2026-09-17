#!/usr/bin/env node
/**
 * mailsift MCP server — lets an AI query triage results.
 *
 * Push handles urgent alerts, while questions such as "what arrived today" are
 * pull-based and can be answered from the local state database.
 *
 * Disabled by default; see README for activation.
 */
import './env.js'; // Must run first so .env is loaded.
import { createServer as createHttpServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { StateStore } from './services/state.js';
import { resolveLlmBaseUrl } from './services/triage.js';
import { sendDigest } from './services/digest.js';
import { buildSink } from './services/sink.js';
import { HEARTBEAT_KEY, Watcher } from './services/watcher.js';
import { FAIL_COUNT_KEY, LLM_FAIL_COUNT_KEY } from './services/health.js';

const INSTRUCTIONS =
  'Query mailsift triage results. It monitors inboxes and spam folders, uses an LLM to assess importance, ' +
  'pushes important messages, and queues the rest for the daily digest.\n' +
  'inSpam=true means the provider classified a message as spam; when pushed=true, it was rescued as a likely false positive.';

const IMPORTANCE = z.enum(['critical', 'warning', 'info']);

export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'mailsift', version: '1.0.0' },
    { instructions: INSTRUCTIONS },
  );
  const state = (): StateStore => new StateStore();
  const json = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  });

  server.tool(
    'list_mail',
    'List recently processed mail (24 hours by default). importance accepts critical/warning/info; ' +
      'spamOnly=true filters spam and pushedOnly=true filters real-time deliveries.',
    {
      hours: z.number().int().positive().default(24),
      importance: IMPORTANCE.optional(),
      spamOnly: z.boolean().default(false),
      pushedOnly: z.boolean().default(false),
      account: z.string().optional(),
      limit: z.number().int().positive().max(200).default(30),
    },
    async (args) => {
      const mail = state().queryMail({
        sinceHours: args.hours,
        ...(args.importance ? { importance: args.importance } : {}),
        spamOnly: args.spamOnly,
        pushedOnly: args.pushedOnly,
        ...(args.account ? { account: args.account } : {}),
        limit: args.limit,
      });
      return json({ count: mail.length, windowHours: args.hours, mail });
    },
  );

  server.tool(
    'search_mail',
    'Search subject, sender, triage category, summary, and reason by keyword. ' +
      'Use it to answer whether a sender wrote or which messages concern a renewal.',
    { query: z.string().min(1), hours: z.number().int().positive().optional(), limit: z.number().int().positive().max(200).default(30) },
    async (args) => {
      const mail = state().queryMail({
        search: args.query,
        ...(args.hours ? { sinceHours: args.hours } : {}),
        limit: args.limit,
      });
      return json({ query: args.query, count: mail.length, mail });
    },
  );

  server.tool(
    'get_mail',
    'Get a complete record by Message-ID, including body preview and triage reason.',
    { messageId: z.string().min(1) },
    async (args) => {
      const found = state().getMail(args.messageId);
      return json(found ? { found: true, ...found } : { found: false, messageId: args.messageId });
    },
  );

  server.tool(
    'mail_summary',
    'Summarize processed and pushed messages in a time window, including spam and spam rescues.',
    { hours: z.number().int().positive().default(24) },
    async (args) => json(state().summarize(args.hours)),
  );

  server.tool(
    'list_accounts',
    'List monitored accounts, folders, and authentication methods.',
    {},
    async () => {
      try {
        const config = loadConfig();
        return json({
          count: config.accounts.length,
          accounts: config.accounts.map((a) => ({
            name: a.name,
            address: a.username,
            provider: a.provider,
            auth: a.auth,
            folders: a.folders,
          })),
        });
      } catch (error) {
        return json({ error: String(error) });
      }
    },
  );

  server.tool(
    'health',
    'Show service health: last poll, account outages, LLM status, and digest backlog. ' +
      'Check this first when investigating a missing notification.',
    {},
    async () => {
      const store = state();
      const last = store.getMeta(HEARTBEAT_KEY);
      const ageSeconds = last ? Math.round((Date.now() - new Date(last).valueOf()) / 1000) : null;
      const interval = Number(process.env.POLL_INTERVAL_SECONDS ?? 300);

      const failing: Array<Record<string, unknown>> = [];
      try {
        for (const account of loadConfig().accounts) {
          const count = store.getMeta(FAIL_COUNT_KEY + account.username);
          if (count) failing.push({ account: account.name, consecutiveFailures: Number(count) });
        }
      } catch (error) {
        failing.push({ error: String(error) });
      }

      return json({
        lastPollAt: last ?? null,
        lastPollAgeSeconds: ageSeconds,
        pollIntervalSeconds: interval,
        healthy: ageSeconds !== null && ageSeconds <= interval * 3 + 120,
        failingAccounts: failing,
        llm: {
          model: process.env.LLM_MODEL ?? null,
          endpoint: (() => {
            try {
              return resolveLlmBaseUrl();
            } catch {
              return null;
            }
          })(),
          consecutiveFailures: Number(store.getMeta(LLM_FAIL_COUNT_KEY) ?? 0),
        },
        digestPending: store.digestPending(),
      });
    },
  );

  server.tool(
    'poll_now',
    'Run one fetch and triage cycle immediately instead of waiting. Usually takes seconds to a minute.',
    {},
    async () => {
      try {
        const watcher = new Watcher(loadConfig(), state(), buildSink());
        const stats = await watcher.pollOnce();
        return json({
          ok: stats.failures.length === 0,
          fetched: stats.fetched,
          new: stats.fresh,
          pushed: stats.pushed,
          rescuedFromSpam: stats.spamRescued,
          queuedForDigest: stats.queued,
          failures: stats.failures,
        });
      } catch (error) {
        return json({ ok: false, error: String(error) });
      }
    },
  );

  server.tool(
    'send_digest_now',
    'Send the daily digest immediately and clear the current digest queue.',
    {},
    async () => {
      const store = state();
      const pending = store.digestPending();
      const sent = await sendDigest(store, buildSink());
      return json({ ok: true, sent, items: pending });
    },
  );

  return server;
}

/**
 * Streamable HTTP mode for remote MCP clients.
 *
 * Stateless implementation (sessionIdGenerator is undefined): each request gets
 * an independent server and transport, then is released. Tools are short queries
 * or triggers and do not need cross-request sessions.
 *
 * The endpoint is /mcp. Set MCP_TOKEN before binding outside loopback or anyone
 * who can reach the port can read triage results.
 */
async function serveHttp(): Promise<void> {
  const port = Number(process.env.MCP_PORT ?? 8410);
  const host = process.env.MCP_BIND ?? '127.0.0.1';
  const token = process.env.MCP_TOKEN?.trim() ?? '';
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);

  if (!loopback && !token) {
    console.error(
      `⚠️  MCP_BIND=${host} has no MCP_TOKEN; anyone reaching ${host}:${port} ` +
        'can query your mail. Set MCP_TOKEN in .env.',
    );
  }

  const httpServer = createHttpServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${host}:${port}`);
        if (url.pathname !== '/mcp') {
          res.writeHead(404).end();
          return;
        }
        if (token && req.headers.authorization !== `Bearer ${token}`) {
          res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
          return;
        }
        const server = createServer();
        // Omitting sessionIdGenerator selects stateless mode.
        const transport = new StreamableHTTPServerTransport({});
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        // The SDK declares onclose as nullable here, which conflicts with the
        // Transport interface under exactOptionalPropertyTypes.
        await server.connect(transport as unknown as Transport);
        await transport.handleRequest(req, res);
      } catch (error) {
        console.error('MCP request failed:', error);
        if (!res.headersSent) res.writeHead(500).end();
      }
    })();
  });

  httpServer.listen(port, host, () => {
    console.error(
      `mailsift MCP (Streamable HTTP) http://${host}:${port}/mcp · auth: ` +
        (token ? 'Bearer token' : 'none'),
    );
  });
}

async function main(): Promise<void> {
  // stdout is the protocol channel in stdio mode; logs use stderr.
  process.env.LOG_LEVEL ??= 'warn';
  if ((process.env.MCP_TRANSPORT ?? 'stdio') === 'http') {
    await serveHttp();
    return;
  }
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

const entry = process.argv[1];
if (entry && entry.endsWith('mcp.ts')) void main();
else if (entry && entry.endsWith('mcp.js')) void main();
