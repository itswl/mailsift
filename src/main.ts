#!/usr/bin/env node
/**
 * mailsift 入口。
 *
 * 默认常驻轮询；--once 跑一轮就退出（适合 cron），--check 只做配置自检。
 */
import './env.js'; // 必须最先执行：把 .env 灌进 process.env
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig, needsOAuth } from './config.js';
import { TokenStore } from './imap/auth.js';
import { StateStore } from './services/state.js';
import { buildSink, WebhookWiseSink } from './services/sink.js';
import { resolveLlmBaseUrl } from './services/triage.js';
import { sendDigest } from './services/digest.js';
import { recordStartupFailure } from './services/health.js';
import { HEARTBEAT_KEY, Watcher } from './services/watcher.js';
import { getLogger } from './logger.js';

const log = getLogger('main');

/** 启动失败后的退避秒数，避免容器 restart 策略把它变成紧密崩溃循环 */
const STARTUP_FAILURE_BACKOFF_MS = 30_000;

let stopping = false;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function checkConfig(): Promise<number> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.log(`❌ 配置错误: ${error instanceof Error ? error.message : error}`);
    return 1;
  }

  console.log('✅ 配置来源: 环境变量（.env）');
  console.log(`   账号 ${config.accounts.length} 个:`);

  const authorized = new Set(await new TokenStore().usernames());
  let problems = 0;

  for (const account of config.accounts) {
    const pending = needsOAuth(account) && !authorized.has(account.username);
    if (pending) problems += 1;
    console.log(
      `   ${pending ? '❌' : '✅'} ${account.name} (${account.username}) ` +
        `[${account.provider}/${account.auth}] 文件夹: ${account.folders.join(', ')}` +
        (pending ? '  <- 未授权，先跑 npm run oauth' : ''),
    );
  }

  const { rules } = config;
  console.log(`   白名单 ${rules.alwaysImportant.length} 条 / 忽略名单 ${rules.neverImportant.length} 条`);
  if (!rules.context) {
    console.log('   ⚠️  MAIL_CONTEXT 为空，LLM 判重要性会缺少你的背景，建议补上');
  }

  let outlets = 0;
  if (process.env.FEISHU_WEBHOOK_URL?.trim()) {
    outlets += 1;
    console.log(`✅ 出口 飞书机器人: ${process.env.FEISHU_WEBHOOK_URL.slice(0, 48)}***`);
  }
  if (process.env.WEBHOOKWISE_URL?.trim()) {
    outlets += 1;
    console.log(`✅ 出口 WebhookWise: ${new WebhookWiseSink().endpoint}`);
    if (!process.env.WEBHOOKWISE_TOKEN?.trim()) {
      console.log('   ⚠️  未设置 WEBHOOKWISE_TOKEN，若对端开了鉴权会被拒');
    }
  }
  if (outlets === 0) {
    console.log('❌ 一个出口都没配：至少设置 FEISHU_WEBHOOK_URL 或 WEBHOOKWISE_URL');
    problems += 1;
  }

  if (process.env.LLM_API_KEY?.trim()) {
    try {
      const provider = process.env.LLM_PROVIDER?.trim();
      console.log(
        `✅ LLM: ${process.env.LLM_MODEL ?? 'deepseek-flash'} @ ` +
          `${provider ? `${provider} -> ` : ''}${resolveLlmBaseUrl()}`,
      );
    } catch (error) {
      console.log(`❌ ${error instanceof Error ? error.message : error}`);
      return 1;
    }
  } else {
    console.log('⚠️  未设置 LLM_API_KEY，将全程走关键词兜底（能用，但判得粗）');
  }

  console.log(
    `   推送阈值 ${process.env.PUSH_MIN_IMPORTANCE ?? 'warning'}，` +
      `垃圾箱敏感度 +${process.env.SPAM_RANK_BONUS ?? 0} 档`,
  );
  console.log(
    `   轮询间隔 ${process.env.POLL_INTERVAL_SECONDS ?? 300}s，` +
      `简报 ${(process.env.DIGEST_ENABLED ?? 'true') === 'false' ? '关闭' : `每日 ${process.env.DIGEST_HOUR ?? 9} 点`}`,
  );
  console.log(`   每轮补账上限 ${process.env.MAX_MESSAGES_PER_POLL_TOTAL ?? 500} 封（所有账号/文件夹合计）`);
  console.log(`   首次回看超过 ${process.env.MAX_MESSAGES_PER_LOOKBACK ?? 500} 封则跳过整批`);

  return problems ? 1 : 0;
}

/**
 * 存活探针：最近一轮轮询是否在合理时间内完成。
 *
 * 刻意不校验配置——配置在运行期不会变，拿它当健康信号只会在进程卡死时
 * 给出"健康"的假象。
 */
function healthcheck(): number {
  const interval = Number(process.env.POLL_INTERVAL_SECONDS ?? 300);
  const deadline = interval * 3 + 120;

  let last: string | undefined;
  try {
    last = new StateStore().getMeta(HEARTBEAT_KEY);
  } catch (error) {
    console.log(`unhealthy: 读取状态库失败 ${error}`);
    return 1;
  }
  if (!last) {
    console.log('unhealthy: 还没有完成过一轮轮询');
    return 1;
  }
  const age = (Date.now() - new Date(last).valueOf()) / 1000;
  if (!Number.isFinite(age)) {
    console.log(`unhealthy: 心跳时间戳无法解析 ${last}`);
    return 1;
  }
  if (age > deadline) {
    console.log(`unhealthy: 上轮轮询在 ${age.toFixed(0)}s 前，超过阈值 ${deadline}s`);
    return 1;
  }
  console.log(`ok: 上轮轮询在 ${age.toFixed(0)}s 前`);
  return 0;
}

/** 把"标记过但没有分诊结论"的邮件放回待处理队列。 */
function recover(): number {
  const state = new StateStore();
  const stuck = state.countUndispatched();
  if (!stuck) {
    console.log('✅ 没有卡住的邮件');
    return 0;
  }
  const dropped = state.dropUndispatched();
  const cursors = state.clearCursors();
  console.log(`已清理 ${dropped} 条无结论记录，回滚 ${cursors} 个 UID 游标。`);
  console.log(`下一轮会按 INITIAL_LOOKBACK_DAYS（当前 ${process.env.INITIAL_LOOKBACK_DAYS ?? 3} 天）重新拉取并分诊。`);
  return 0;
}

async function runForever(watcher: Watcher): Promise<void> {
  const interval = Number(process.env.POLL_INTERVAL_SECONDS ?? 300) * 1000;
  log.info(`mailsift 启动，轮询间隔 ${interval / 1000}s`);

  while (!stopping) {
    try {
      await watcher.pollOnce();
    } catch (error) {
      // 单轮失败不该让服务退出——下一轮大概率能恢复
      log.error(`本轮轮询异常: ${error}`);
    }
    for (let waited = 0; waited < interval && !stopping; waited += 500) await sleep(500);
  }
  log.info('已退出');
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      once: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      'digest-now': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      healthcheck: { type: 'boolean', default: false },
      recover: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values['dry-run']) process.env.DRY_RUN = 'true';
  if (values.healthcheck) return healthcheck();
  if (values.recover) return recover();
  if (values.check) return checkConfig();

  let watcher: Watcher;
  try {
    watcher = new Watcher(loadConfig(), new StateStore(), buildSink());
  } catch (error) {
    log.error(`配置错误: ${error instanceof Error ? error.message : error}`);
    if (error instanceof ConfigError) {
      await recordStartupFailure(error, buildSink()).catch(() => undefined);
      log.error(`${STARTUP_FAILURE_BACKOFF_MS / 1000} 秒后退出（避免紧密重启循环）`);
      await sleep(STARTUP_FAILURE_BACKOFF_MS);
    }
    return 1;
  }

  if (values['digest-now']) {
    await sendDigest(watcher.state, watcher.sink);
    return 0;
  }
  if (values.once) {
    const stats = await watcher.pollOnce();
    return stats.failures.length ? 2 : 0;
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log.info(`收到 ${signal}，本轮结束后退出`);
      stopping = true;
    });
  }
  await runForever(watcher);
  return 0;
}

// ESM 下判断"是否被直接执行"：比较真实路径，避免 tsx / dist 两种入口下判断不一致
const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
