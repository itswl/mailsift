#!/usr/bin/env node
/**
 * mailsift MCP server — 让 AI 主动查邮件分诊结果。
 *
 * 推送解决的是"要紧的事立刻知道"，但"今天有什么要紧邮件""XX 公司来过信吗"
 * 是拉取式的，交给 AI 直接查本地状态库。
 *
 * 默认不启动；开启方式见 README。
 */
import './env.js'; // 必须最先执行：把 .env 灌进 process.env
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
  '查询 mailsift 的邮件分诊结果。它同时监控多个邮箱的收件箱和垃圾箱，' +
  '用 LLM 判断重要性。重要的已实时推送，其余进每日简报。\n' +
  '注意 inSpam=true 表示该邮件被邮件服务商判为垃圾——如果它同时 pushed=true，' +
  '说明是被捞回来的误判，这类最值得关注。';

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
    '列出最近处理过的邮件。默认返回 24 小时内的。importance 可选 critical/warning/info；' +
      'spamOnly=true 只看垃圾箱里的；pushedOnly=true 只看已实时推送的。',
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
    '按关键词搜索邮件，匹配标题、发件人、分诊分类、摘要和判定理由。' +
      '用于回答"XX 来过信吗""关于续费的邮件有哪些"。',
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
    '按 Message-ID 取单封邮件的完整记录，含正文摘要和分诊理由。',
    { messageId: z.string().min(1) },
    async (args) => {
      const found = state().getMail(args.messageId);
      return json(found ? { found: true, ...found } : { found: false, messageId: args.messageId });
    },
  );

  server.tool(
    'mail_summary',
    '统计概览：时间窗内处理了多少封、推送了多少、其中多少来自垃圾箱、多少是从垃圾箱捞回的误判。',
    { hours: z.number().int().positive().default(24) },
    async (args) => json(state().summarize(args.hours)),
  );

  server.tool(
    'list_accounts',
    '列出正在监控的邮箱账号及其扫描的文件夹、认证方式。',
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
    '服务健康状态：上轮轮询时间、各账号是否失联、模型是否可用、简报队列积压多少。' +
      '排查"为什么没收到通知"时先看这个。',
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
    '立刻跑一轮收取与分诊，不等下一个轮询周期。耗时取决于新邮件数量，通常几秒到一分钟。',
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
    '立刻发送每日简报（会清空当前简报队列），不等到设定的时间点。',
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
 * Streamable HTTP 模式：给远程 MCP 客户端用的。
 *
 * 无状态实现（sessionIdGenerator 为 undefined）：每个请求独立的 server +
 * transport，处理完即回收，不留会话——本服务的工具全是短平快的查询/触发，
 * 不需要跨请求会话，换来的是零状态、随便横向扩。
 *
 * 端点固定为 /mcp；绑定非回环地址时强烈建议设置 MCP_TOKEN，
 * 否则任何能连到端口的人都能读你的邮件分诊结果。
 */
async function serveHttp(): Promise<void> {
  const port = Number(process.env.MCP_PORT ?? 8410);
  const host = process.env.MCP_BIND ?? '127.0.0.1';
  const token = process.env.MCP_TOKEN?.trim() ?? '';
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);

  if (!loopback && !token) {
    console.error(
      `⚠️  MCP_BIND=${host} 且未设置 MCP_TOKEN：任何能连到 ${host}:${port} 的人` +
        '都能查询你的邮件，请尽快在 .env 里设置 MCP_TOKEN',
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
        // 不传 sessionIdGenerator 即无状态模式（SDK 类型注释明确说明）
        const transport = new StreamableHTTPServerTransport({});
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        // SDK 的 streamableHttp 实现把 onclose 声明成可空，与 Transport 接口在
        // exactOptionalPropertyTypes 下不合（stdio 就合），只能断言绕过
        await server.connect(transport as unknown as Transport);
        await transport.handleRequest(req, res);
      } catch (error) {
        console.error('MCP 请求处理失败:', error);
        if (!res.headersSent) res.writeHead(500).end();
      }
    })();
  });

  httpServer.listen(port, host, () => {
    console.error(
      `mailsift MCP (Streamable HTTP) http://${host}:${port}/mcp · 鉴权: ` +
        (token ? 'Bearer token' : '无'),
    );
  });
}

async function main(): Promise<void> {
  // stdio 下 stdout 属于协议通道，日志一律走 stderr（见 logger.ts）
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
