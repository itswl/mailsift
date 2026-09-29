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
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { fetchByMessageId } from './imap/client.js';
import { StateStore } from './services/state.js';
import type { FeedbackLabel, NotificationOutboxRow } from './services/state.js';
import {
  CATEGORIES, pushThreshold, resolveLlmBaseUrl, spamBonus, spamBonusWarning, suppressSelfForwards,
} from './services/triage.js';
import { retryAttempts } from './services/delivery.js';
import { HEARTBEAT_KEY, IDLE_WAKE_KEY } from './services/watcher.js';
import { routeWeb, webUiEnabled } from './web.js';
import { idleEnabled, idleFolderTokens } from './imap/idle.js';
import {
  ACCOUNT_LAST_ERROR_KEY, ACCOUNT_LAST_FAILURE_KEY, ACCOUNT_LAST_SUCCESS_KEY,
  FAIL_COUNT_KEY, LLM_FAIL_COUNT_KEY,
} from './services/health.js';

const INSTRUCTIONS =
  'Query mailsift triage results. It monitors inboxes and spam folders, uses an LLM to assess importance, ' +
  'pushes important messages, and queues the rest for the daily digest.\n' +
  'inSpam=true means the provider classified a message as spam; when pushed=true, it was rescued as a likely false positive.\n' +
  `Triage categories come from a fixed vocabulary: ${CATEGORIES.join(', ')}. Rule-decided mail may also carry ` +
  'Always important, Never important, Feedback rule or Forwarded copy.';

const IMPORTANCE = z.enum(['critical', 'warning', 'info']);

const rateWindows = new Map<string, { startedAt: number; count: number }>();

function mcpRateLimit(): number {
  const value = Number(process.env.MCP_RATE_LIMIT_PER_MINUTE ?? 120);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 120;
}

export function allowMcpRequest(client: string, now = Date.now()): boolean {
  const key = client || 'unknown';
  const current = rateWindows.get(key);
  if (!current || now - current.startedAt >= 60_000) {
    rateWindows.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= mcpRateLimit()) return false;
  current.count += 1;
  return true;
}

function clientFingerprint(value: string): string {
  return createHash('sha256').update(value || 'unknown').digest('hex').slice(0, 16);
}

/**
 * The address to rate limit and audit against.
 *
 * Behind a reverse proxy every request arrives from the proxy, so the socket
 * address is identical for everyone and a per-client limit collapses into one
 * shared bucket: a single noisy caller then denies service to every other
 * client, including this operator's own browser. The forwarded headers carry
 * the real address, but anyone can send them, so they are believed only when
 * the deployment states that a proxy is in front.
 */
export function clientAddress(req: IncomingMessage): string {
  if ((process.env.TRUSTED_PROXY ?? 'false').toLowerCase() !== 'true') {
    return req.socket.remoteAddress ?? 'unknown';
  }
  const header = (name: string): string => String(req.headers[name] ?? '').split(',')[0]?.trim() ?? '';
  return header('cf-connecting-ip') || header('x-real-ip') || header('x-forwarded-for')
    || req.socket.remoteAddress || 'unknown';
}

interface MailCursor {
  createdAt: string;
  dedupKey: string;
}

function encodeCursor(row: { createdAt: string; dedupKey: string }): string {
  return Buffer.from(JSON.stringify({ createdAt: row.createdAt, dedupKey: row.dedupKey }), 'utf8').toString('base64url');
}

function decodeCursor(raw: string | undefined): MailCursor | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<MailCursor>;
    if (typeof parsed.createdAt !== 'string' || typeof parsed.dedupKey !== 'string') return undefined;
    return { createdAt: parsed.createdAt, dedupKey: parsed.dedupKey };
  } catch {
    return undefined;
  }
}

/**
 * A queued notification without its body.
 *
 * Enough to tell why an entry is stuck (what it is, how often it has been
 * tried, what the endpoint said) while keeping the bounded-preview rule that
 * the rest of this surface follows.
 */
function outboxSummary(row: NotificationOutboxRow): Record<string, unknown> {
  return {
    notificationKey: row.notificationKey,
    createdAt: row.createdAt,
    attempts: row.attempts,
    lastError: row.lastError,
    account: row.message.account,
    subject: row.message.subject,
    sender: row.message.fromAddr,
    inSpam: row.message.inSpam,
    importance: row.result.importance,
    category: row.result.category,
    decidedBy: row.result.decidedBy,
  };
}

function liveBodyLimit(): number {
  const value = Number(process.env.MCP_LIVE_BODY_CHARS ?? 20_000);
  return Number.isFinite(value) ? Math.max(1_000, Math.min(Math.floor(value), 100_000)) : 20_000;
}

export function createServer(options: { state?: StateStore } = {}): McpServer {
  const store = options.state ?? new StateStore();
  const server = new McpServer(
    { name: 'mailsift', version: '1.0.0' },
    { instructions: INSTRUCTIONS },
  );
  const json = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  });

  server.registerTool(
    'list_mail',
    {
      description:
        'List recently processed mail (24 hours by default). importance accepts critical/warning/info; ' +
        'spamOnly=true filters spam and pushedOnly=true filters real-time deliveries. ' +
        `category matches exactly, normally one of ${CATEGORIES.join(', ')}, or a rule label such as ` +
        'Forwarded copy; use search_mail instead for a substring match.',
      inputSchema: {
        hours: z.number().int().positive().default(24),
        importance: IMPORTANCE.optional(),
        category: z.string().min(1).max(60).optional(),
        spamOnly: z.boolean().default(false),
        pushedOnly: z.boolean().default(false),
        account: z.string().optional(),
        limit: z.number().int().positive().max(200).default(30),
        cursor: z.string().optional(),
      },
    },
    async (args) => {
      const cursor = decodeCursor(args.cursor);
      const mail = store.queryMail({
        sinceHours: args.hours,
        ...(args.importance ? { importance: args.importance } : {}),
        ...(args.category ? { category: args.category } : {}),
        spamOnly: args.spamOnly,
        pushedOnly: args.pushedOnly,
        ...(args.account ? { account: args.account } : {}),
        limit: args.limit,
        ...(cursor ? { beforeCreatedAt: cursor.createdAt, beforeDedupKey: cursor.dedupKey } : {}),
      });
      const nextCursor = mail.length === args.limit && mail.at(-1)?.createdAt
        ? encodeCursor(mail.at(-1)!)
        : undefined;
      return json({ count: mail.length, windowHours: args.hours, mail, ...(nextCursor ? { nextCursor } : {}) });
    },
  );

  server.registerTool(
    'search_mail',
    {
      description:
        'Search subject, sender, triage category, summary, and reason by keyword. ' +
        'Use it to answer whether a sender wrote or which messages concern a renewal.',
      inputSchema: { query: z.string().min(1), hours: z.number().int().positive().optional(), limit: z.number().int().positive().max(200).default(30) },
    },
    async (args) => {
      const mail = store.queryMail({
        search: args.query,
        ...(args.hours ? { sinceHours: args.hours } : {}),
        limit: args.limit,
      });
      return json({ query: args.query, count: mail.length, mail });
    },
  );

  server.registerTool(
    'get_mail',
    {
      description: 'Get the stored triage record by Message-ID, including a bounded body preview and triage reason. It does not fetch or return the full raw email.',
      inputSchema: { messageId: z.string().min(1) },
    },
    async (args) => {
      const found = store.getMail(args.messageId);
      return json(found ? { found: true, ...found } : { found: false, messageId: args.messageId });
    },
  );

  server.registerResource(
    'mail-record',
    new ResourceTemplate('mailsift://mail/{messageId}', { list: undefined }),
    { mimeType: 'application/json', description: 'Read one stored mailsift triage record by Message-ID.' },
    async (uri, variables) => {
      const rawMessageId = variables['messageId'];
      let messageId: string | undefined;
      if (typeof rawMessageId === 'string') {
        try {
          messageId = decodeURIComponent(rawMessageId);
        } catch {
          messageId = undefined;
        }
      }
      const found = messageId ? store.getMail(messageId) : undefined;
      if (!found) throw new Error('mail record not found');
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({ found: true, ...found }, null, 2),
        }],
      };
    },
  );

  server.registerResource(
    'mail-source',
    new ResourceTemplate('mailsift://imap/{account}/{messageId}', { list: undefined }),
    {
      mimeType: 'message/rfc822',
      description: 'Read a bounded normalized email body on demand from the configured IMAP account. Nothing is persisted.',
    },
    async (uri, variables) => {
      const rawAccount = variables['account'];
      const rawMessageId = variables['messageId'];
      if (typeof rawAccount !== 'string' || typeof rawMessageId !== 'string') {
        throw new Error('account and messageId are required');
      }
      let accountName: string;
      let messageId: string;
      try {
        accountName = decodeURIComponent(rawAccount);
        messageId = decodeURIComponent(rawMessageId);
      } catch {
        throw new Error('invalid encoded mail resource URI');
      }
      const account = loadConfig().accounts.find((candidate) => candidate.username === accountName);
      if (!account) throw new Error('mail account not found');
      const message = await fetchByMessageId(account, messageId);
      if (!message) throw new Error('message not found in configured read-only folders');
      const limit = liveBodyLimit();
      const body = message.body.slice(0, limit);
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({
            account: message.account,
            messageId: message.messageId,
            subject: message.subject,
            from: message.fromAddr,
            fromName: message.fromName,
            to: message.toAddrs,
            folder: message.folder,
            inSpam: message.inSpam,
            date: message.date,
            hasAttachments: message.hasAttachments,
            truncated: body.length < message.body.length,
            body,
          }, null, 2),
        }],
      };
    },
  );

  server.registerTool(
    'mail_summary',
    {
      description: 'Summarize processed and pushed messages in a time window, including spam and spam rescues.',
      inputSchema: { hours: z.number().int().positive().default(24) },
    },
    async (args) => json(store.summarize(args.hours)),
  );

  server.registerTool(
    'list_digest',
    {
      description:
        'Preview the messages waiting for the next daily digest. These were triaged below the push ' +
        'threshold, or declined by every output, so they were never sent in real time. The queue is ' +
        'cleared once the digest goes out.',
      inputSchema: { limit: z.number().int().positive().max(200).default(50) },
    },
    async (args) => {
      const items = store.peekDigest().slice(0, args.limit);
      return json({ count: items.length, pending: store.digestPending(), items });
    },
  );

  server.registerTool(
    'observability',
    {
      description: 'Show processing totals, delivery backlog, dead-letter count, and feedback counts.',
      inputSchema: {},
    },
    async () => json(store.observability()),
  );

  server.registerTool(
    'record_feedback',
    {
      description: 'Record feedback for a processed message so future rules and triage evaluation can use it.',
      inputSchema: {
        messageId: z.string().min(1).max(1000),
        label: z.enum(['false_positive', 'missed', 'handled', 'correct']),
        note: z.string().max(1000).default(''),
      },
    },
    async (args) => {
      store.recordFeedback(args.messageId, args.label as FeedbackLabel, args.note);
      return json({ recorded: true, messageId: args.messageId, label: args.label });
    },
  );

  server.registerTool(
    'feedback_rules',
    {
      description: 'Show sender rules inferred from at least two missed or false-positive feedback records.',
      inputSchema: {},
    },
    async () => json(store.feedbackRuleHints(2)),
  );

  server.registerTool(
    'list_accounts',
    {
      description: 'List monitored accounts, folders, and authentication methods.',
      inputSchema: {},
    },
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

  server.registerTool(
    'list_dead_letters',
    {
      description:
        'List messages that were explicitly skipped because they were oversized or could not be parsed. ' +
        'These records are excluded from normal triage but remain visible for recovery and investigation.',
      inputSchema: { limit: z.number().int().positive().max(200).default(50) },
    },
    async (args) => {
      const deadLetters = store.listDeadLetters(args.limit);
      return json({ count: deadLetters.length, deadLetters });
    },
  );

  server.registerTool(
    'recovery_status',
    {
      description:
        'Show account health timelines, folder UID progress, the dead-letter backlog, and the ' +
        'notifications still queued for retry. A queued entry means delivery genuinely failed: an ' +
        'output declining a message under its own threshold settles it instead of queueing it.',
      inputSchema: {
        deadLetterLimit: z.number().int().positive().max(200).default(50),
        outboxLimit: z.number().int().positive().max(200).default(50),
      },
    },
    async (args) => {
      const accounts = loadConfig().accounts.map((account) => ({
        name: account.name,
        address: account.username,
        consecutiveFailures: Number(store.getMeta(FAIL_COUNT_KEY + account.username) ?? 0),
        lastSuccessAt: store.getMeta(ACCOUNT_LAST_SUCCESS_KEY + account.username) ?? null,
        lastFailureAt: store.getMeta(ACCOUNT_LAST_FAILURE_KEY + account.username) ?? null,
        lastError: store.getMeta(ACCOUNT_LAST_ERROR_KEY + account.username) ?? null,
      }));
      const deadLetters = store.listDeadLetters(args.deadLetterLimit);
      const outbox = store.pendingNotifications(args.outboxLimit);
      return json({
        accounts,
        cursors: store.listCursors(),
        deadLetters,
        deadLetterCount: deadLetters.length,
        notificationOutbox: outbox.map(outboxSummary),
        notificationOutboxPending: store.notificationOutboxPending(),
      });
    },
  );

  server.registerTool(
    'retry_dead_letter',
    {
      description: 'Requeue one explicitly skipped message by rewinding its folder cursor. The next poll will retry it.',
      inputSchema: { deadKey: z.string().min(1).max(500) },
    },
    async (args) => json({ deadKey: args.deadKey, requeued: store.retryDeadLetter(args.deadKey) }),
  );

  server.registerTool(
    'health',
    {
      description:
        'Show service health: last poll, account outages, LLM status, and digest backlog. ' +
        'Check this first when investigating a missing notification.',
      inputSchema: {},
    },
    async () => {
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
      // Keyed by account and folder, because listeners are per folder: a single
      // per-account entry let a healthy listener vouch for a dead sibling.
      const idleWakes: Record<string, string> = {};
      for (const row of store.listMeta(IDLE_WAKE_KEY)) {
        idleWakes[row.key.slice(IDLE_WAKE_KEY.length)] = row.value;
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
        idle: { enabled: idleEnabled(), folders: idleFolderTokens(), lastWakeAt: idleWakes },
        // The thresholds that decide whether a message is notified. Without
        // them "why was I not told about this" cannot be answered from here.
        delivery: {
          pushMinImportance: process.env.PUSH_MIN_IMPORTANCE ?? 'warning',
          pushMinRank: pushThreshold(),
          spamRankBonus: spamBonus(),
          spamBonusWarning: spamBonusWarning() ?? null,
          digestMinImportance: process.env.DIGEST_MIN_IMPORTANCE ?? 'info',
          feishuMinImportanceOverride: process.env.FEISHU_MIN_IMPORTANCE?.trim() || null,
          suppressSelfForwards: suppressSelfForwards(),
          sinkRetryAttempts: retryAttempts(),
        },
        digestPending: store.digestPending(),
        notificationOutboxPending: store.notificationOutboxPending(),
      });
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
export async function startMcpHttp(): Promise<import('node:http').Server> {
  const port = Number(process.env.MCP_PORT ?? 8410);
  const host = process.env.MCP_BIND ?? '127.0.0.1';
  const token = process.env.MCP_TOKEN?.trim() ?? '';
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);

  if (!loopback && !token) {
    throw new Error(`MCP_BIND=${host} requires MCP_TOKEN; refusing to start an unauthenticated HTTP server.`);
  }

  const httpServer = createHttpServer((req, res) => {
    void (async () => {
      const client = clientFingerprint(clientAddress(req));
      if (!allowMcpRequest(client)) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' }).end('{"error":"rate_limited"}');
        return;
      }
      try {
        const url = new URL(req.url ?? '/', `http://${host}:${port}`);
        if (url.pathname !== '/mcp') {
          // The read-only browser view shares this port and token, because it
          // shares the trust boundary. Off unless explicitly enabled.
          if (!webUiEnabled()) {
            res.writeHead(404).end();
            return;
          }
          const webStore = new StateStore();
          try {
            const answer = await routeWeb(req, url, token, webStore, client);
            const headers: Record<string, string> = { 'content-type': answer.contentType };
            if (answer.cookie) headers['set-cookie'] = answer.cookie;
            if (answer.status === 303) headers['location'] = '/';
            res.writeHead(answer.status, headers).end(answer.body);
          } finally {
            webStore.close();
          }
          return;
        }
        const presented = req.headers.authorization?.startsWith('Bearer ')
          ? req.headers.authorization.slice('Bearer '.length)
          : '';
        const authorized = !token || (token.length === presented.length && timingSafeEqual(
          Buffer.from(token), Buffer.from(presented),
        ));
        if (!authorized) {
          res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
          return;
        }
        const state = new StateStore();
        state.recordMcpAudit('http_request', client, true);
        const server = createServer({ state });
        // Omitting sessionIdGenerator selects stateless mode.
        const transport = new StreamableHTTPServerTransport({});
        let cleaned = false;
        const cleanup = (): void => {
          if (cleaned) return;
          cleaned = true;
          void transport.close();
          void server.close();
          state.close();
        };
        res.once('close', cleanup);
        res.once('finish', cleanup);
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

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      httpServer.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      httpServer.off('error', onError);
      console.error(
        `mailsift MCP (Streamable HTTP) http://${host}:${port}/mcp · auth: ` +
          (token ? 'Bearer token' : 'none') + ' · mode: read-only',
      );
      resolve();
    };
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    httpServer.listen(port, host);
  });
  return httpServer;
}

async function serveHttp(): Promise<void> {
  const httpServer = await startMcpHttp();
  await new Promise<void>((resolve) => httpServer.once('close', resolve));
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
