#!/usr/bin/env node
/**
 * mailsift entry point.
 *
 * Runs continuously by default; --once runs one poll for cron, and --check validates configuration.
 */
import './env.js'; // Must run first so .env is loaded into process.env.
import { realpathSync } from 'node:fs';
import type { Server } from 'node:http';
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
import { metrics } from './metrics.js';
import { startMcpHttp } from './mcp.js';

const log = getLogger('main');

/** Backoff after startup failure to avoid a tight container restart loop. */
const STARTUP_FAILURE_BACKOFF_MS = 30_000;

let stopping = false;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function checkConfig(): Promise<number> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.log(`❌ Configuration error: ${error instanceof Error ? error.message : error}`);
    return 1;
  }

  console.log('✅ Configuration source: environment (.env)');
  console.log(`   Accounts (${config.accounts.length}):`);

  const authorized = new Set(await new TokenStore().usernames());
  let problems = 0;

  for (const account of config.accounts) {
    const pending = needsOAuth(account) && !authorized.has(account.username);
    if (pending) problems += 1;
    console.log(
      `   ${pending ? '❌' : '✅'} ${account.name} (${account.username}) ` +
        `[${account.provider}/${account.auth}] folders: ${account.folders.join(', ')}` +
        (pending ? '  <- unauthorized; run npm run oauth' : ''),
    );
  }

  const { rules } = config;
  console.log(`   Always-important rules: ${rules.alwaysImportant.length}; never-important rules: ${rules.neverImportant.length}`);
  if (!rules.context) {
    console.log('   ⚠️  MAIL_CONTEXT is empty; the LLM will lack your personal context.');
  }

  let outlets = 0;
  if (process.env.FEISHU_WEBHOOK_URL?.trim()) {
    outlets += 1;
    console.log('✅ Output Feishu bot: configured');
  }
  if (process.env.WEBHOOKWISE_URL?.trim()) {
    outlets += 1;
    let host = 'configured';
    try { host = new URL(new WebhookWiseSink().endpoint).host; } catch { /* report configured only */ }
    console.log(`✅ Output generic webhook: configured (${host})`);
    if (!process.env.WEBHOOKWISE_TOKEN?.trim()) {
      console.log('   ⚠️  WEBHOOKWISE_TOKEN is not set; an authenticated endpoint will reject requests.');
    }
  }
  if (outlets === 0) {
    console.log('❌ No output configured: set FEISHU_WEBHOOK_URL or WEBHOOKWISE_URL.');
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
    console.log('⚠️  LLM_API_KEY is not set; using local keyword fallback for all messages.');
  }

  console.log(
    `   Push threshold: ${process.env.PUSH_MIN_IMPORTANCE ?? 'warning'}; ` +
      `spam importance bonus: +${process.env.SPAM_RANK_BONUS ?? 0}`,
  );
  console.log(
    `   Poll interval: ${process.env.POLL_INTERVAL_SECONDS ?? 300}s; ` +
      `digest: ${(process.env.DIGEST_ENABLED ?? 'true') === 'false' ? 'disabled' : `daily at ${process.env.DIGEST_HOUR ?? 9}:00`}`,
  );
  console.log(`   Total per-poll backfill limit: ${process.env.MAX_MESSAGES_PER_POLL_TOTAL ?? 500}`);
  console.log(`   Fresh lookbacks are backfilled in chunks of ${process.env.MAX_MESSAGES_PER_LOOKBACK ?? 500}`);

  return problems ? 1 : 0;
}

/**
 * Health probe: whether the last poll completed within a reasonable interval.
 *
 * Configuration is intentionally not checked: it does not change at runtime and
 * would make a stuck process appear healthy.
 */
function healthcheck(): number {
  const interval = Number(process.env.POLL_INTERVAL_SECONDS ?? 300);
  const deadline = interval * 3 + 120;

  let last: string | undefined;
  try {
    last = new StateStore().getMeta(HEARTBEAT_KEY);
  } catch (error) {
    console.log(`unhealthy: failed to read state database: ${error}`);
    return 1;
  }
  if (!last) {
    console.log('unhealthy: no poll has completed yet');
    return 1;
  }
  const age = (Date.now() - new Date(last).valueOf()) / 1000;
  if (!Number.isFinite(age)) {
    console.log(`unhealthy: cannot parse heartbeat timestamp ${last}`);
    return 1;
  }
  if (age > deadline) {
    console.log(`unhealthy: last poll was ${age.toFixed(0)}s ago, exceeding ${deadline}s`);
    return 1;
  }
  console.log(`ok: last poll was ${age.toFixed(0)}s ago`);
  return 0;
}

/** Put messages marked without a triage result back into the pending queue. */
function recover(): number {
  const state = new StateStore();
  const stuck = state.countUndispatched();
  if (!stuck) {
    console.log('✅ No interrupted messages found.');
    return 0;
  }
  const dropped = state.dropUndispatched();
  const cursors = state.clearCursors();
  console.log(`Cleared ${dropped} undecided records and rolled back ${cursors} UID cursors.`);
  console.log(`The next poll will fetch and triage using INITIAL_LOOKBACK_DAYS (currently ${process.env.INITIAL_LOOKBACK_DAYS ?? 3} days).`);
  return 0;
}

async function runForever(watcher: Watcher): Promise<void> {
  const interval = Number(process.env.POLL_INTERVAL_SECONDS ?? 300) * 1000;
  log.info(`mailsift started; poll interval ${interval / 1000}s`);

  while (!stopping) {
    try {
      await watcher.pollOnce();
    } catch (error) {
      // One failed poll should not stop the service; the next poll may recover.
      log.error(`Poll failed: ${error}`);
    }
    for (let waited = 0; waited < interval && !stopping; waited += 500) await sleep(500);
  }
  log.info('Exited');
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
    log.error(`Configuration error: ${error instanceof Error ? error.message : error}`);
    if (error instanceof ConfigError) {
      await recordStartupFailure(error, buildSink()).catch(() => undefined);
      log.error(`Exiting in ${STARTUP_FAILURE_BACKOFF_MS / 1000}s to avoid a tight restart loop.`);
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

  let mcpServer: Server | undefined;
  if ((process.env.MCP_ENABLED ?? 'true').toLowerCase() === 'true') {
    try {
      mcpServer = await startMcpHttp();
    } catch (error) {
      log.error(`MCP startup failed: ${error}`);
      return 1;
    }
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log.info(`Received ${signal}; exiting after the current poll.`);
      stopping = true;
      if (mcpServer) mcpServer.close();
      void metrics.shutdown().catch((error) => log.warn(`Failed to flush OTel metrics: ${error}`));
    });
  }
  await runForever(watcher);
  return 0;
}

// Detect direct execution under ESM by comparing real paths across tsx and dist.
const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
