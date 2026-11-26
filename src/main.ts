#!/usr/bin/env node
/**
 * mailsift service.
 *
 * Started by src/server.ts, which restarts it when settings change. Runs
 * continuously by default; --once runs one poll, --check reports on the stored
 * configuration, and --reset-admin prints a new one-time setup code.
 */
import './env.js'; // Must run first for DNS defaults.
import { bootstrapError } from './bootstrap.js'; // Load stored settings before other modules read them.
import { realpathSync } from 'node:fs';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from './config.js';
import { authorizedUsernames } from './imap/auth.js';
import { StateStore } from './services/state.js';
import { buildSink, usesLegacyWebhookNames, webhookEndpoint, webhookToken, WebhookSink } from './services/sink.js';
import { deciderConfigured } from './services/decider.js';
import {
  resolveLlmBaseUrl, spamBonusWarning, suppressSelfForwards, unanchoredSenderRules,
} from './services/triage.js';
import { digestHour, sendDigest } from './services/digest.js';
import { recordStartupFailure } from './services/health.js';
import { Watcher } from './services/watcher.js';
import { PollCoordinator } from './services/poll-scheduler.js';
import { IdleSupervisor, idleEnabled, idleFolderTokens } from './imap/idle.js';
import { stopConnecting } from './imap/connection.js';
import { sentLookbackDays, sentMailEnabled } from './imap/sent.js';
import { flushHeartbeats, heartbeatProblem, heartbeatUrl } from './services/heartbeat.js';
import { getLogger } from './logger.js';
import { metrics } from './metrics.js';
import { startMcpHttp } from './mcp.js';
import { adminPasswordSet, issueSetupCode, readSettings, resetAdmin } from './services/settings-store.js';
import { mailboxReadiness } from './services/settings-runtime.js';
import {
  onRestartRequested, RESTART_EXIT_CODE, restartRequested, setServerMode, supervised, type ServerMode,
} from './services/runtime-control.js';

const log = getLogger('main');

/** Backoff after startup failure to avoid a tight container restart loop. */
const STARTUP_FAILURE_BACKOFF_MS = 30_000;

let stopping = false;

async function checkConfig(): Promise<number> {
  // Every stored mailbox, the ones not being checked included, with what stands in its way.
  const doc = readSettings();
  const authorized = authorizedUsernames();
  let problems = 0;
  console.log('✅ Configuration source: the settings stored in the database (Settings in the web view)');
  console.log(`   Setup: ${doc.setupCompletedAt ? `finished ${doc.setupCompletedAt}` : 'not finished; no mailbox is checked until it is'}`);
  console.log(`   Mailboxes (${doc.mailboxes.length}):`);
  const why: Record<string, string> = {
    'disabled': 'switched off',
    'needs-authorization': 'not signed in yet: Settings → Mailboxes → Sign in',
    'needs-password': 'no password: Settings → Mailboxes → Edit',
    'invalid': 'settings incomplete: Settings → Mailboxes → Edit',
  };
  for (const mailbox of doc.mailboxes) {
    const state = mailboxReadiness(mailbox, authorized);
    if (state !== 'ready' && state !== 'disabled') problems += 1;
    console.log(
      `   ${state === 'ready' ? '✅' : state === 'disabled' ? '⏸️ ' : '❌'} ${mailbox.name || mailbox.username} (${mailbox.username}) ` +
        `[${mailbox.provider}] folders: ${(mailbox.folders?.length ? mailbox.folders : ['INBOX', 'spam']).join(', ')}` +
        (why[state] ? `  <- ${why[state]}` : ''),
    );
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.log(`❌ ${error instanceof Error ? error.message : error}`);
    return 1;
  }

  const { rules } = config;
  console.log(`   Always-important rules: ${rules.alwaysImportant.length}; never-important rules: ${rules.neverImportant.length}`);
  const stale = unanchoredSenderRules([...rules.alwaysImportant, ...rules.neverImportant]);
  if (stale.length) {
    console.log(
      `   ⚠️  These sender rules no longer match anything: ${stale.join(', ')}. A pattern containing @ is ` +
        'compared as a complete address. Use @domain.com for a domain, or the full address.',
    );
  }
  console.log(
    config.accounts.length > 1 && suppressSelfForwards()
      ? '   Self-forwards: a copy arriving from another monitored mailbox is filed to the digest, not pushed'
      : `   Self-forwards: not suppressed${config.accounts.length > 1 ? ' (turned off in Settings → Triage rules)' : ''}`,
  );
  if (!rules.context) {
    console.log('   ⚠️  Settings → Triage rules → About you is empty; the LLM will lack your personal context.');
  }

  let outlets = 0;
  if (process.env.FEISHU_WEBHOOK_URL?.trim()) {
    outlets += 1;
    console.log('✅ Output Feishu bot: configured');
  }
  if (webhookEndpoint()) {
    outlets += 1;
    let host = 'configured';
    try { host = new URL(new WebhookSink().endpoint).host; } catch { /* report configured only */ }
    console.log(`✅ Output webhook: configured (${host})`);
    if (!webhookToken()) {
      console.log('   ⚠️  WEBHOOK_TOKEN is not set; an authenticated endpoint will reject requests.');
    }
    if (usesLegacyWebhookNames()) {
      console.log(
        '   ⚠️  WEBHOOKWISE_URL is superseded by WEBHOOK_URL, which takes the complete endpoint ' +
          'rather than a base that /api/v1/webhook/<source> is appended to. The old names still work.',
      );
    }
  }
  if (outlets === 0) {
    console.log('ℹ️  No external output configured; mailsift will keep triaged mail in the web view. Browser notifications are optional.');
  }

  if (process.env.LLM_API_KEY?.trim()) {
    try {
      const provider = process.env.LLM_PROVIDER?.trim();
      console.log(
        `✅ LLM: ${process.env.LLM_MODEL ?? 'deepseek-flash'} @ ` +
          `${provider ? `${provider} -> ` : ''}${resolveLlmBaseUrl()}; ` +
          `output language: ${process.env.LLM_OUTPUT_LANGUAGE?.trim() || 'en'}`,
      );
      if (deciderConfigured()) {
        console.log(
          `✅ Decider: ${process.env.DECIDER_MODEL ?? 'clef-flash'} @ ` +
            `${process.env.DECIDER_BASE_URL?.trim()}; two-stage triage (decide, then summarize)`,
        );
      }
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
  const spamWarning = spamBonusWarning();
  // A warning, not a misconfiguration: report it without failing the check.
  if (spamWarning) console.log(`   ⚠️  ${spamWarning}`);
  const digest = digestHour();
  console.log(
    `   Poll interval: ${process.env.POLL_INTERVAL_SECONDS ?? 300}s; ` +
      `digest: ${(process.env.DIGEST_ENABLED ?? 'true').toLowerCase() === 'false' ? 'disabled' : `daily at ${digest.hour}:00 server time`}`,
  );
  if (digest.invalid !== undefined) {
    console.log(`   ⚠️  DIGEST_HOUR=${digest.invalid} is not a whole hour from 0 to 23; using ${digest.hour}.`);
  }
  if (idleEnabled()) {
    const interval = Number(process.env.POLL_INTERVAL_SECONDS ?? 300);
    console.log(`   IMAP IDLE: enabled for ${idleFolderTokens().join(', ')}; the poll interval is the reconciliation pass`);
    if (interval < 900) {
      console.log('   ℹ️  With IDLE on, POLL_INTERVAL_SECONDS can usually be raised to 900-1800.');
    }
  } else {
    console.log('   IMAP IDLE: disabled (Settings → Checking and digest → Real-time wake-ups)');
  }
  console.log(
    sentMailEnabled()
      ? `   Sent folders: read for the conversation, first looking back ${sentLookbackDays()} days (Settings → Privacy and retention)`
      : '   Sent folders: not read (turned off in Settings → Privacy and retention)',
  );
  console.log(
    `   Web view and MCP: http://127.0.0.1:${process.env.MCP_PORT ?? 8410}/ · sign in with the administrator password; ` +
      'MCP clients use a token from Settings → Access (read, write, or admin)',
  );
  const monitor = heartbeatUrl();
  const monitorProblem = heartbeatProblem();
  console.log(
    monitor
      ? `   External heartbeat: pinging ${monitor.host} after each poll`
      : monitorProblem
        ? `   ⚠️  The heartbeat URL ${monitorProblem}; no heartbeat will be sent.`
        : '   External heartbeat: off (Settings → Notifications → Heartbeat URL lets a monitor notice when mailsift stops)',
  );
  console.log(`   Total per-poll backfill limit: ${process.env.MAX_MESSAGES_PER_POLL_TOTAL ?? 500}`);
  console.log(`   Fresh lookbacks are backfilled in chunks of ${process.env.MAX_MESSAGES_PER_LOOKBACK ?? 500}`);

  return problems ? 1 : 0;
}

/**
 * Health probe for the container: asks the running service's /healthz.
 *
 * The service knows whether it is waiting for setup (healthy) or checking
 * mailboxes, and then whether its last check is recent enough. A service
 * that does not answer at all is unhealthy, which a heartbeat in the
 * database alone could not tell.
 */
async function healthcheck(): Promise<number> {
  const port = Number(process.env.MCP_PORT ?? 8410);
  const bind = process.env.MCP_BIND?.trim() || '127.0.0.1';
  const host = ['0.0.0.0', '::', '127.0.0.1', 'localhost', ''].includes(bind) ? '127.0.0.1' : bind;
  try {
    const response = await fetch(`http://${host.includes(':') ? `[${host}]` : host}:${port}/healthz`, {
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => ({})) as { status?: string; mode?: string; lastPollAt?: string };
    if (!response.ok) {
      console.log(`unhealthy: ${body.mode ?? 'service'} reports ${body.status ?? response.status}` +
        (body.lastPollAt ? `; last check finished at ${body.lastPollAt}` : '; no check has finished'));
      return 1;
    }
    console.log(`ok: ${body.mode ?? 'running'}${body.lastPollAt ? `, last check ${body.lastPollAt}` : ''}`);
    return 0;
  } catch (error) {
    console.log(`unhealthy: the service does not answer on port ${port}: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
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

async function runForever(coordinator: PollCoordinator): Promise<void> {
  const interval = Number(process.env.POLL_INTERVAL_SECONDS ?? 300) * 1000;
  log.info(`mailsift started; poll interval ${interval / 1000}s`);

  while (!stopping) {
    try {
      await coordinator.now();
    } catch (error) {
      // One failed poll should not stop the service; the next poll may recover.
      log.error(`Poll failed: ${error}`);
    }
    if (stopping) break;
    await coordinator.wait(interval);
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
      'reset-admin': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (bootstrapError) {
    console.error(`mailsift: the stored settings cannot be read: ${bootstrapError.message}`);
    return 1;
  }

  if (values['dry-run']) process.env.DRY_RUN = 'true';
  if (values.healthcheck) return healthcheck();
  if (values.recover) return recover();
  if (values.check) return checkConfig();

  if (values['reset-admin']) {
    const code = resetAdmin();
    console.error('The administrator password and all browser sessions have been cleared.');
    console.error(`One-time setup code: ${code}`);
    console.error(`Open ${setupAddress()}/ and use the code to choose a new password.`);
    return 0;
  }

  if (!values.once && !values['digest-now']) return serve();
  return runOnce(values.once, values['digest-now']);
}

/** Where the page is reached on this machine, for the messages in the log. */
function setupAddress(): string {
  return `http://127.0.0.1:${process.env.MCP_PORT ?? '8410'}`;
}

function announceSetup(code: string | undefined, setupFinished: boolean): void {
  const port = process.env.MCP_PORT ?? '8410';
  const headline = !code ? ' mailsift is waiting for setup to be finished.'
    : setupFinished ? ' mailsift is running, but no administrator password is set yet.'
    : ' mailsift is waiting to be set up.';
  const lines = [
    '',
    '──────────────────────────────────────────────────────────────',
    headline,
    '',
    ` Open ${setupAddress()}/ on this machine${setupFinished ? ', or the address of your HTTPS proxy' : ''}.`,
    ' On a remote server, tunnel the port first from your computer:',
    `   ssh -N -L ${port}:127.0.0.1:${port} you@your-server`,
    ...(code ? ['', ` One-time setup code: ${code}`, ' (a new code is printed each time mailsift starts until it is used)'] : []),
    '──────────────────────────────────────────────────────────────',
    '',
  ];
  console.error(lines.join('\n'));
}

/**
 * The long-running service. Starts in one of three modes (see ServerMode) and
 * serves the page in all of them; mailboxes are checked only once setup is
 * finished. A settings change ends this function with RESTART_EXIT_CODE.
 */
async function serve(): Promise<number> {
  const doc = readSettings();
  const authorized = authorizedUsernames();
  const readiness = doc.mailboxes.map((mailbox) => mailboxReadiness(mailbox, authorized));
  const ready = readiness.filter((state) => state === 'ready').length;
  const waiting = readiness.filter((state) => state === 'needs-authorization').length;
  const mode: ServerMode = !doc.setupCompletedAt ? 'setup' : ready > 0 ? 'running' : 'idle';
  setServerMode(mode);

  const code = adminPasswordSet() ? undefined : issueSetupCode();
  if (code || mode === 'setup') announceSetup(code, Boolean(doc.setupCompletedAt));
  if (!supervised()) {
    log.warn('Started without the supervisor (dist/src/server.js): saved settings will need a manual restart.');
  }
  if (mode !== 'running') return serveWithoutMonitoring(mode, waiting);
  if (waiting) log.warn(`${waiting} mailbox(es) wait for authorization in Settings and are not checked yet.`);
  return monitor();
}

/** Setup, or nothing to check: the page and the API only. */
async function serveWithoutMonitoring(mode: ServerMode, waiting: number): Promise<number> {
  log.info(mode === 'setup'
    ? 'Waiting for setup to be finished; no mailbox is checked until then.'
    : `No mailbox can be checked${waiting ? ` (${waiting} wait for authorization)` : ''}; serving the web view only.`);
  let server: Server;
  try {
    server = await startMcpHttp({ setupMode: mode === 'setup', adminAuth: true });
  } catch (error) {
    log.error(`Web server failed to start: ${error}`);
    return 1;
  }
  const stop = (): void => {
    stopping = true;
    server.close();
    server.closeAllConnections();
  };
  onRestartRequested(stop);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await new Promise<void>((resolve) => server.once('close', resolve));
  return restartRequested() ? RESTART_EXIT_CODE : 0;
}

/** A watcher over the mailboxes that can be checked, or a startup failure already reported. */
async function buildWatcher(): Promise<Watcher | undefined> {
  try {
    return new Watcher(loadConfig(), new StateStore(), buildSink());
  } catch (error) {
    log.error(`Configuration error: ${error instanceof Error ? error.message : error}`);
    if (error instanceof ConfigError) {
      await recordStartupFailure(error, buildSink()).catch(() => undefined);
      log.error(`Exiting in ${STARTUP_FAILURE_BACKOFF_MS / 1000}s to avoid a tight restart loop.`);
      await sleep(STARTUP_FAILURE_BACKOFF_MS);
    }
    return undefined;
  }
}

/** --once and --digest-now, for cron and for trying things by hand. */
async function runOnce(once: boolean | undefined, digestNow: boolean | undefined): Promise<number> {
  const watcher = await buildWatcher();
  if (!watcher) return 1;
  if (digestNow) {
    await sendDigest(watcher.state, watcher.sink);
    return 0;
  }
  if (once) {
    const stats = await watcher.pollOnce();
    // The ping is not awaited inside the poll; a cron run must not exit before it is sent.
    await flushHeartbeats();
    return stats.failures.length ? 2 : 0;
  }
  return 0;
}

/** Check the ready mailboxes until stopped, or until saved settings ask for a restart. */
async function monitor(): Promise<number> {
  const watcher = await buildWatcher();
  if (!watcher) return 1;

  const spamWarning = spamBonusWarning();
  if (spamWarning) log.warn(spamWarning);

  // The refresh button and the scheduled loop share this, so a click during a
  // poll joins it rather than opening a second set of IMAP connections.
  const coordinator = new PollCoordinator(() => watcher.pollOnce());

  let idle: IdleSupervisor | undefined;
  if (idleEnabled()) {
    idle = new IdleSupervisor(watcher.config.accounts, async (account, folder, client) => {
      await watcher.pollFolder(account, folder, client);
    });
    idle.start();
  }

  let server: Server;
  try {
    server = await startMcpHttp({ onRefresh: () => coordinator.now(), adminAuth: true });
  } catch (error) {
    log.error(`Web server failed to start: ${error}`);
    await idle?.stop().catch(() => undefined);
    return 1;
  }

  let stopped = false;
  const stop = (why: string): void => {
    if (stopped) return;
    stopped = true;
    log.info(`${why}; exiting after the current poll.`);
    stopping = true;
    coordinator.wake();
    // Hang up on connections still being made and make no more: a poll
    // stuck on a provider that is not answering would otherwise outlast
    // the time a stop is given, and be killed.
    stopConnecting();
    // Log the IDLE sessions out now so the server keeps no zombie connections.
    void idle?.stop().catch((error) => log.warn(`Failed to stop IDLE listeners: ${error}`));
    void metrics.shutdown().catch((error) => log.warn(`Failed to flush OTel metrics: ${error}`));
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => stop(`Received ${signal}`));
  onRestartRequested(() => stop('Restarting to apply settings'));

  await runForever(coordinator);
  // The page stays up while the last poll finishes, so it can see the restart through.
  server.close();
  server.closeAllConnections();
  await idle?.stop().catch((error) => log.warn(`Failed to stop IDLE listeners: ${error}`));
  return restartRequested() ? RESTART_EXIT_CODE : 0;
}

// Detect direct execution under ESM by comparing real paths across tsx and dist.
const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
