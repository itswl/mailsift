/**
 * Health alerts: account outages, LLM failures, and startup failures.
 *
 * A monitoring tool that stops silently is the worst failure mode. Persistent
 * failures send critical alerts and a recovery notice, while one-poll blips
 * stay quiet.
 */
import { existsSync } from 'node:fs';
import type { Account } from '../config.js';
import type { MailMessage } from '../imap/message.js';
import type { TriageResult } from './triage.js';
import type { Sink } from './sink.js';
import { StateStore } from './state.js';
import { getLogger } from '../logger.js';

const log = getLogger('health');

export const FAIL_COUNT_KEY = 'account_fail_count:';
export const ALERTED_AT_KEY = 'account_alerted_at:';
export const LLM_FAIL_COUNT_KEY = 'llm_fail_count';
export const LLM_ALERTED_AT_KEY = 'llm_alerted_at';
export const STARTUP_ALERTED_AT_KEY = 'startup_alerted_at';
export const ACCOUNT_LAST_SUCCESS_KEY = 'account_last_success:';
export const ACCOUNT_LAST_FAILURE_KEY = 'account_last_failure:';
export const ACCOUNT_LAST_ERROR_KEY = 'account_last_error:';
export const DECIDER_FAIL_COUNT_KEY = 'decider_fail_count';
export const DECIDER_FAILED_SINCE_KEY = 'decider_failed_since';
export const DECIDER_ALERTED_AT_KEY = 'decider_alerted_at';

function cooldownSeconds(): number {
  return Number(process.env.ACCOUNT_ALERT_COOLDOWN_SECONDS ?? 21_600);
}

function withinCooldown(state: StateStore, key: string): boolean {
  const last = state.getMeta(key);
  if (!last) return false;
  const age = (Date.now() - new Date(last).valueOf()) / 1000;
  return Number.isFinite(age) && age < cooldownSeconds();
}

/** Authentication failures need auth-specific remediation in the alert body. */
function isAuthFailure(error: unknown): boolean {
  const text = String(error).toLowerCase();
  return [
    'authentication failed', 'invalid credentials', 'login failed',
    'invalid_grant', 'authenticationfailed', 'auth error', 'authenticate failed',
    // An OAuth account never authorized on this server, or whose token is
    // stored where this process does not read.
    'no authorization record',
  ].some((marker) => text.includes(marker))
    // A token request the provider refused. 408 and 429 are not refusals,
    // and a 5xx is the provider's outage, not the user's sign-in.
    || /token request failed: http 4(?!08|29)\d\d/.test(text);
}

/** mailsift's own OAuth setup on this server, not the provider: the token store or the client settings. */
function isSetupFailure(error: unknown): boolean {
  return /token store|requires? (?:gmail|outlook)_client_id|unknown oauth type/i.test(String(error));
}

type FailureKind = 'auth' | 'setup' | 'folders' | 'connection';

function failureKind(error: unknown): FailureKind {
  if (/no selectable folders/i.test(String(error))) return 'folders';
  if (isSetupFailure(error)) return 'setup';
  return isAuthFailure(error) ? 'auth' : 'connection';
}

const FAILURE_LABEL: Record<FailureKind, string> = {
  auth: 'authentication', setup: 'OAuth setup', folders: 'folders', connection: 'connection',
};

function healthMessage(subject: string, body: string, key: string, stamp: string): MailMessage {
  return {
    account: 'mailsift',
    accountLabel: 'mailsift',
    provider: '',
    folder: 'health',
    inSpam: false,
    uid: 0,
    messageId: `<health-${key}-${stamp}@mailsift>`,
    subject,
    fromAddr: 'health@mailsift',
    fromName: 'mailsift',
    toAddrs: [],
    date: new Date().toISOString(),
    body,
    hasAttachments: false,
    listUnsubscribe: false,
    // Render the full body instead of truncating it to a summary.
    extra: { digest: true },
  };
}

/** Health alerts only care whether the notice actually went out. */
async function deliver(sink: Sink, message: MailMessage, result: TriageResult): Promise<boolean> {
  return (await sink.push(message, result)) === 'delivered';
}

function critical(reason: string): TriageResult {
  return {
    importance: 'critical', score: 100, summary: '', reason, deadline: '',
    category: 'Service failure', actionRequired: true, decidedBy: 'health',
  };
}

function info(reason: string): TriageResult {
  return {
    importance: 'info', score: 0, summary: '', reason, deadline: '',
    category: 'Service failure', actionRequired: false, decidedBy: 'health',
  };
}

/**
 * The command that re-authorizes one OAuth account, worded for how this
 * process runs. Inside the image the host's npm script would write the token
 * beside the checkout instead of into the container's volume, and without
 * --account, --force walks through every OAuth account again.
 */
export function oauthCommand(account: Pick<Account, 'username'>): string {
  const user = shellWord(account.username);
  return existsSync('/.dockerenv')
    ? `docker compose run --rm mailsift node dist/scripts/oauth-setup.js --manual --force --account=${user}`
    : `npm run oauth -- --manual --force --account=${user}`;
}

/** An address as one POSIX shell word: "o'brien@x" or "a!b@x" must survive a paste. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9@._+-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function remedy(account: Account, kind: FailureKind): string {
  if (kind === 'folders') {
    return 'The sign-in worked, but none of the configured folders could be opened. ' +
      'Compare MAIL_ACCOUNT_N_FOLDERS with the folders `npm run probe` lists for this account.';
  }
  if (kind === 'setup') {
    return 'mailsift could not use its own OAuth setup on this server. Check the token store ' +
      '(TOKEN_STORE_PATH, data/tokens.json in the data volume) and the OAuth client settings in .env, then restart.';
  }
  if (kind === 'connection') return 'If the failure continues, check network connectivity to the mail provider.';
  if (account.auth === 'gmail_oauth') {
    return (
      `Re-authorize: \`${oauthCommand(account)}\`.\n` +
      'If this recurs every 7 days, the Google OAuth app is probably still in Testing. ' +
      'Publish the consent screen in Google Cloud Console.\n' +
      'Personal Gmail can use gmail_pw plus an app password instead.'
    );
  }
  if (account.auth === 'outlook_oauth') {
    return (
      'Check these likely causes:\n' +
      '1) Outlook.com IMAP is disabled. Open Settings -> Mail -> Forwarding and IMAP -> ' +
      'Allow devices and apps to use IMAP (disabled by default).\n' +
      `2) OAuth expired: \`${oauthCommand(account)}\`.`
    );
  }
  return (
    'The error is not provider-specific. Check these likely causes:\n' +
    '1) IMAP is disabled in the provider web settings.\n' +
    '2) The app password expired; generate a new one, update .env, and restart.\n' +
    '3) Login rate limiting; increase POLL_INTERVAL_SECONDS and observe recovery.'
  );
}

function hourStamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 10);
}

export function accountAlertThreshold(): number {
  const value = Number(process.env.ACCOUNT_ALERT_AFTER_FAILURES ?? 2);
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : 2;
}

/** Where one mailbox stands, as the web view shows it. */
export interface MailboxStatus {
  name: string;
  address: string;
  consecutiveFailures: number;
  /** Failing for as many polls as it takes to raise an alert; a single blip stays quiet. */
  failing: boolean;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  /** Which fix to suggest, only while failing. */
  fix?: 'google' | 'outlook' | 'authorize' | 'password' | 'folders' | 'setup' | 'connection';
  /** The re-authorization command, for OAuth accounts that are failing to sign in. */
  command?: string;
}

/**
 * Every configured mailbox and whether the poller can still read it.
 *
 * The heartbeat is written after every poll, even one in which a mailbox
 * failed, so "checked a minute ago" alone could vouch for a mailbox that has
 * not been read for days. This is what lets the page name it.
 */
export function mailboxStatuses(state: StateStore, accounts: Account[]): MailboxStatus[] {
  const threshold = accountAlertThreshold();
  return accounts.map((account) => {
    const failures = Number(state.getMeta(FAIL_COUNT_KEY + account.username) || 0);
    const failing = failures >= threshold;
    const error = failing ? state.getMeta(ACCOUNT_LAST_ERROR_KEY + account.username) ?? '' : '';
    const oauth = account.auth === 'gmail_oauth' || account.auth === 'outlook_oauth';
    const kind = failureKind(error);
    const fix: MailboxStatus['fix'] = !failing ? undefined
      : kind !== 'auth' ? kind
        // Never authorized here, or the token lives somewhere this process does not read.
        : oauth && /no authorization record/i.test(error) ? 'authorize'
          : account.auth === 'gmail_oauth' ? 'google'
            : account.auth === 'outlook_oauth' ? 'outlook'
              : 'password';
    return {
      name: account.name,
      address: account.username,
      consecutiveFailures: failures,
      failing,
      lastSuccessAt: state.getMeta(ACCOUNT_LAST_SUCCESS_KEY + account.username) || null,
      lastFailureAt: state.getMeta(ACCOUNT_LAST_FAILURE_KEY + account.username) || null,
      ...(fix ? { fix } : {}),
      ...(fix === 'google' || fix === 'outlook' || fix === 'authorize' ? { command: oauthCommand(account) } : {}),
    };
  });
}

export async function recordAccountFailure(
  state: StateStore, sink: Sink, account: Account, error: unknown,
): Promise<boolean> {
  const kind = failureKind(error);
  const failures = Number(state.getMeta(FAIL_COUNT_KEY + account.username) ?? 0) + 1;
  state.setMeta(FAIL_COUNT_KEY + account.username, String(failures));
  state.setMeta(ACCOUNT_LAST_FAILURE_KEY + account.username, new Date().toISOString());
  state.setMeta(ACCOUNT_LAST_ERROR_KEY + account.username, String(error).slice(0, 500));

  // Authentication errors can also be transient (for example an Outlook IMAP
  // `NO Login failed` during an OAuth/token hiccup). Use the same consecutive
  // failure threshold for every account failure so one bad poll does not
  // produce an outage alert immediately followed by a recovery alert.
  const threshold = accountAlertThreshold();
  if (failures < threshold) {
    log.warn(`[${account.name}] failure ${failures}; alert threshold not reached: ${error}`);
    return false;
  }
  if (withinCooldown(state, ALERTED_AT_KEY + account.username)) {
    log.warn(`[${account.name}] still failing (${failures}); alert is in cooldown.`);
    return false;
  }

  const body = [
    `**Monitoring stopped for ${account.name} (${account.username})**`,
    '',
    `**Failure type**: ${FAILURE_LABEL[kind]}`,
    `**Consecutive failures**: ${failures}`,
    `**Error**: ${String(error).slice(0, 300)}`,
    '',
    '---',
    remedy(account, kind),
    '',
    '⚠️ New mail from this account, including spam, will not be checked until recovery.',
  ].join('\n');

  const sent = await deliver(sink,
    healthMessage(`⚠️ Mail account unavailable: ${account.name}`, body, account.username, hourStamp()),
    critical(`${account.name} ${FAILURE_LABEL[kind]} failure; monitoring coverage is lost`),
  );
  // A failed sink delivery must not put the account into the "alerted" state;
  // otherwise recovery would claim an outage was announced when it was not.
  if (sent) state.setMeta(ALERTED_AT_KEY + account.username, new Date().toISOString());
  log.error(`[${account.name}] outage alert sent=${sent}: ${error}`);
  return sent;
}

export async function recordAccountSuccess(
  state: StateStore, sink: Sink, account: Account,
): Promise<boolean> {
  state.setMeta(ACCOUNT_LAST_SUCCESS_KEY + account.username, new Date().toISOString());
  if (!state.getMeta(FAIL_COUNT_KEY + account.username)) return false;
  const hadAlerted = Boolean(state.getMeta(ALERTED_AT_KEY + account.username));
  state.setMeta(FAIL_COUNT_KEY + account.username, '');
  state.setMeta(ALERTED_AT_KEY + account.username, '');

  if (!hadAlerted) {
    log.info(`[${account.name}] recovered (no alert was sent).`);
    return false;
  }
  const sent = await deliver(sink,
    healthMessage(
      `✅ Mail account recovered: ${account.name}`,
      `**Monitoring restored for ${account.name} (${account.username}).**\n\n` +
        'Messages received during the outage will be fetched by UID on the next poll.',
      `ok-${account.username}`,
      String(Date.now()),
    ),
    info(`${account.name} connection restored`),
  );
  log.info(`[${account.name}] recovery notice sent=${sent}`);
  return sent;
}

/**
 * LLM failures do not stop the service because keyword fallback continues, but
 * coverage quality drops and the user must be notified.
 */
export async function recordLlmFailure(state: StateStore, sink: Sink, error: unknown): Promise<boolean> {
  const failures = Number(state.getMeta(LLM_FAIL_COUNT_KEY) ?? 0) + 1;
  state.setMeta(LLM_FAIL_COUNT_KEY, String(failures));

  if (failures < Number(process.env.LLM_ALERT_AFTER_FAILURES ?? 2)) {
    log.warn(`LLM failure ${failures}; alert threshold not reached: ${error}`);
    return false;
  }
  if (withinCooldown(state, LLM_ALERTED_AT_KEY)) {
    log.warn(`LLM still unavailable (${failures}); alert is in cooldown.`);
    return false;
  }

  const body = [
    `**LLM unavailable; triage downgraded to keyword fallback** (${failures} consecutive failures)`,
    '',
    `**Model**: ${process.env.LLM_MODEL ?? '(not set)'}`,
    `**Endpoint**: ${process.env.LLM_BASE_URL ?? process.env.LLM_PROVIDER ?? '(default)'}`,
    `**Error**: ${String(error).slice(0, 300)}`,
    '',
    '---',
    'Common causes: invalid or unpaid API key, wrong model name, upstream rate limits, or blocked egress.',
    '',
    '⚠️ During fallback, hard keywords such as verification codes, overdue bills, and expiry notices are still pushed.',
    'Other messages, including human inquiries, are queued for the daily digest instead of real-time alerts.',
  ].join('\n');

  const sent = await deliver(sink,
    healthMessage('⚠️ LLM unavailable: triage downgraded', body, 'llm', hourStamp()),
    critical(`${process.env.LLM_MODEL ?? 'LLM'} failed ${failures} consecutive times; triage uses keyword fallback`),
  );
  if (sent) state.setMeta(LLM_ALERTED_AT_KEY, new Date().toISOString());
  log.error(`LLM outage alert sent=${sent}: ${error}`);
  return true;
}

export async function recordLlmSuccess(state: StateStore, sink: Sink): Promise<boolean> {
  if (!state.getMeta(LLM_FAIL_COUNT_KEY)) return false;
  const hadAlerted = Boolean(state.getMeta(LLM_ALERTED_AT_KEY));
  state.setMeta(LLM_FAIL_COUNT_KEY, '');
  state.setMeta(LLM_ALERTED_AT_KEY, '');
  if (!hadAlerted) {
    log.info('LLM recovered (no alert was sent).');
    return false;
  }
  const sent = await deliver(sink,
    healthMessage(
      '✅ LLM recovered',
      '**Triage is back to normal.**\n\nFallback messages still waiting in the digest are being re-triaged. ' +
        'Messages already delivered are left alone.',
      'llm-ok',
      String(Date.now()),
    ),
    info('LLM calls restored'),
  );
  log.info(`LLM recovery notice sent=${sent}`);
  return sent;
}

function warning(reason: string): TriageResult {
  return {
    importance: 'warning', score: 60, summary: '', reason, deadline: '',
    category: 'Service failure', actionRequired: true, decidedBy: 'health',
  };
}

/**
 * The decision model failing is easy to miss: the batch falls back to one
 * stage and every message is still judged, so nothing looks wrong. Repeated
 * failures say so once, with the cooldown the other alerts use.
 */
export async function recordDeciderFailure(state: StateStore, sink: Sink, error: unknown): Promise<boolean> {
  const failures = Number(state.getMeta(DECIDER_FAIL_COUNT_KEY) || 0) + 1;
  state.setMeta(DECIDER_FAIL_COUNT_KEY, String(failures));
  if (!state.getMeta(DECIDER_FAILED_SINCE_KEY)) state.setMeta(DECIDER_FAILED_SINCE_KEY, new Date().toISOString());

  if (failures < Number(process.env.LLM_ALERT_AFTER_FAILURES ?? 2)) {
    log.warn(`Decider failure ${failures}; alert threshold not reached: ${error}`);
    return false;
  }
  if (withinCooldown(state, DECIDER_ALERTED_AT_KEY)) {
    log.warn(`Decider still failing (${failures}); alert is in cooldown.`);
    return false;
  }

  const since = state.getMeta(DECIDER_FAILED_SINCE_KEY) ?? new Date().toISOString();
  const body = [
    `**Two-stage triage is off** since ${since} (${failures} consecutive failures)`,
    '',
    `**Decision model**: ${process.env.DECIDER_MODEL ?? 'clef-flash'}`,
    `**Error**: ${String(error).slice(0, 300)}`,
    '',
    '---',
    'Every message is still judged, in one stage by the LLM. Check DECIDER_API_TOKEN and the Workers AI account: ' +
      'the token may have expired or lost its permission.',
  ].join('\n');

  const sent = await deliver(sink,
    healthMessage('⚠️ Two-stage triage off: the decision model is failing', body, 'decider', hourStamp()),
    warning(`${process.env.DECIDER_MODEL ?? 'Decision model'} failed ${failures} consecutive times; triage runs in one stage`),
  );
  if (sent) state.setMeta(DECIDER_ALERTED_AT_KEY, new Date().toISOString());
  log.error(`Decider outage alert sent=${sent}: ${error}`);
  return sent;
}

export async function recordDeciderSuccess(state: StateStore, sink: Sink): Promise<boolean> {
  if (!state.getMeta(DECIDER_FAIL_COUNT_KEY)) return false;
  const hadAlerted = Boolean(state.getMeta(DECIDER_ALERTED_AT_KEY));
  state.setMeta(DECIDER_FAIL_COUNT_KEY, '');
  state.setMeta(DECIDER_FAILED_SINCE_KEY, '');
  state.setMeta(DECIDER_ALERTED_AT_KEY, '');
  if (!hadAlerted) {
    log.info('Decider recovered (no alert was sent).');
    return false;
  }
  const sent = await deliver(sink,
    healthMessage('✅ Two-stage triage restored', '**The decision model answers again.**', 'decider-ok', String(Date.now())),
    info('Decision model restored'),
  );
  log.info(`Decider recovery notice sent=${sent}`);
  return sent;
}

/**
 * Alert when the service cannot start.
 *
 * This is the most dangerous failure: a restart policy can repeatedly restart a
 * dead process while the user sees no difference between silence and normal operation.
 *
 * Outputs use environment variables so this path still works when account config is invalid.
 */
export async function recordStartupFailure(error: unknown, sink: Sink): Promise<boolean> {
  let state: StateStore | undefined;
  try {
    state = new StateStore();
  } catch {
    state = undefined;
  }
  if (state && withinCooldown(state, STARTUP_ALERTED_AT_KEY)) {
    log.error(`Startup failed (alert cooldown): ${error}`);
    return false;
  }
  if (!sink.configured) {
    log.error(`Startup failed and no output is configured; cannot alert: ${error}`);
    return false;
  }

  const body = [
    '**mailsift cannot start; your mailboxes are not being monitored.**',
    '',
    `**Error**: ${String(error).slice(0, 400)}`,
    '',
    '---',
    'The .env file is likely invalid. Run this on the server:',
    '```',
    'docker compose run --rm mailsift node dist/src/main.js --check',
    '```',
    '',
    '⚠️ No mailbox, including spam, will be checked until this is fixed.',
  ].join('\n');

  const sent = await deliver(sink,
    healthMessage('🛑 mailsift startup failed', body, 'startup', hourStamp()),
    critical('Service startup failed; mailbox monitoring is stopped'),
  );
  state?.setMeta(STARTUP_ALERTED_AT_KEY, new Date().toISOString());
  log.error(`Startup failure alert sent=${sent}: ${error}`);
  return true;
}
