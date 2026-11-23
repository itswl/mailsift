/**
 * What the running server is doing, and how it restarts itself.
 *
 * Most settings are read once when the service starts, so a change is applied
 * by restarting the process. The process does not do that on its own: it ends
 * with RESTART_EXIT_CODE and the supervisor (src/server.ts) starts it again
 * straight away. Without a supervisor (main.js run directly) nothing would
 * start it again, so the change is saved and the page says a restart is due.
 */
import { randomBytes } from 'node:crypto';
import { getLogger } from '../logger.js';

const log = getLogger('runtime');

export const RESTART_EXIT_CODE = 75;

/**
 * setup: first-run setup is not finished; only the settings pages are served.
 * idle: set up, but no mailbox can be checked (none enabled, or all wait for authorization).
 * running: mailboxes are being checked.
 */
export type ServerMode = 'setup' | 'idle' | 'running';

const BOOT_ID = randomBytes(8).toString('hex');
const STARTED_AT = Date.now();
/** Changes saved in quick succession restart once, after the last of them. */
const RESTART_DEBOUNCE_MS = 1500;

let mode: ServerMode = 'setup';
let restartHandler: (() => void) | undefined;
let restartTimer: NodeJS.Timeout | undefined;
let restartPending = false;
let manualRestartNeeded = false;

export function bootId(): string {
  return BOOT_ID;
}

export function startedAt(): number {
  return STARTED_AT;
}

export function serverMode(): ServerMode {
  return mode;
}

export function setServerMode(next: ServerMode): void {
  mode = next;
}

/** Whether a supervisor will start the process again after it exits for a restart. */
export function supervised(): boolean {
  return process.env.MAILSIFT_SUPERVISED === '1';
}

/** How the running service stops for a restart; set by main once it is serving. */
export function onRestartRequested(handler: (() => void) | undefined): void {
  restartHandler = handler;
}

export type RestartOutcome = 'scheduled' | 'manual';

/** Apply saved settings by restarting, or say that someone has to. */
export function requestRestart(reason: string): RestartOutcome {
  if (!supervised() || !restartHandler) {
    manualRestartNeeded = true;
    log.warn(`Settings changed (${reason}); restart mailsift to apply them.`);
    return 'manual';
  }
  if (!restartPending) log.info(`Restarting to apply settings (${reason}).`);
  restartPending = true;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = undefined;
    restartHandler?.();
  }, RESTART_DEBOUNCE_MS);
  restartTimer.unref();
  return 'scheduled';
}

export function restartRequested(): boolean {
  return restartPending;
}

export function restartState(): { pending: boolean; manual: boolean } {
  return { pending: restartPending, manual: manualRestartNeeded };
}

/** For tests: forget everything above. */
export function resetRuntimeControl(): void {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = undefined;
  restartHandler = undefined;
  restartPending = false;
  manualRestartNeeded = false;
  mode = 'setup';
}
