/**
 * IMAP IDLE listeners: wake the poll pipeline as soon as a watched folder changes.
 *
 * Polling remains the source of truth. A listener keeps one read-only
 * connection per account and folder; imapflow holds it in IDLE, restarts IDLE
 * before servers time it out, and emits `exists` when mail arrives. The
 * listener then asks the watcher to fetch that folder on the same connection,
 * so a wake-up costs no new TLS handshake or LOGIN. The scheduled poll keeps
 * running and reconciles anything a notification missed.
 */
import type { ImapFlow } from 'imapflow';
import type { Account } from '../config.js';
import { connect, imapErrorText, isTransientConnectError, listFolders } from './client.js';
import { ALL_TOKEN, resolveFolders, type Folder } from './folders.js';
import { getLogger } from '../logger.js';
import { metrics } from '../metrics.js';

const log = getLogger('idle');

/** A burst of EXISTS notifications within this window becomes one fetch. */
export const WAKE_DEBOUNCE_MS = 1_000;
/** A session that lived this long counts as healthy and resets the reconnect backoff. */
const HEALTHY_SESSION_MS = 60_000;

export function idleEnabled(): boolean {
  return (process.env.IMAP_IDLE_ENABLED ?? 'false').toLowerCase() === 'true';
}

export function idleFolderTokens(): string[] {
  return (process.env.IMAP_IDLE_FOLDERS ?? 'INBOX')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
}

/**
 * Reconnect delay. Transient errors retry from 2s, doubling to 60s. Anything
 * else is probably an authentication problem, which the poll already alerts
 * on, so start at 5 minutes and cap at 15 instead of hammering the provider
 * with failed logins.
 */
export function reconnectDelayMs(failures: number, transient: boolean): number {
  const [base, cap] = transient ? [2_000, 60_000] : [5 * 60_000, 15 * 60_000];
  return Math.min(cap, base * 2 ** Math.max(0, failures - 1));
}

export type WakeHandler = (account: Account, folder: Folder, client: ImapFlow) => Promise<void>;

export interface ListenerDeps {
  connect: (account: Account) => Promise<ImapFlow>;
  sleep: (ms: number) => Promise<void>;
  debounceMs: number;
}

const DEFAULT_DEPS: ListenerDeps = {
  connect: (account) => connect(account, { idle: true }),
  // unref: a backoff timer must not keep the process alive after stop().
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()),
  debounceMs: WAKE_DEBOUNCE_MS,
};

/** Resolve when `work` settles or after `ms`, whichever comes first, without leaving a timer behind. */
function withTimeout(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    work.then(
      () => { clearTimeout(timer); resolve(); },
      () => { clearTimeout(timer); resolve(); },
    );
  });
}

/** One IDLE connection for one folder of one account, reconnecting until stopped. */
export class FolderListener {
  private stopping = false;
  private client: ImapFlow | undefined;
  private folder: Folder | undefined;
  private timer: NodeJS.Timeout | undefined;
  private waking = false;
  private wakeAgain = false;
  private done: Promise<void> = Promise.resolve();
  private releaseStop: () => void = () => undefined;
  /** Settles when stop() is called, so a reconnect backoff does not delay shutdown. */
  private readonly stopped = new Promise<void>((resolve) => {
    this.releaseStop = resolve;
  });

  constructor(
    readonly account: Account,
    readonly token: string,
    private readonly onWake: WakeHandler,
    private readonly deps: ListenerDeps = DEFAULT_DEPS,
  ) {}

  private get label(): string {
    return `${this.account.name}/${this.folder?.path ?? this.token}`;
  }

  start(): void {
    this.done = this.run();
  }

  /** Log out and wait for the supervise loop to end; safe to call more than once. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.releaseStop();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const client = this.client;
    this.client = undefined;
    if (client) await this.release(client);
    await this.done;
  }

  /** LOGOUT so the server keeps no zombie session; a dead socket is just closed. */
  private async release(client: ImapFlow): Promise<void> {
    if (client.usable) await withTimeout(client.logout(), 5_000);
    client.close();
  }

  /** Sleep that ends early when stop() is called. */
  private pause(ms: number): Promise<void> {
    return Promise.race([this.deps.sleep(ms), this.stopped]);
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (!this.stopping) {
      const startedAt = Date.now();
      let transient = true;
      try {
        if ((await this.session()) === 'unsupported') return;
      } catch (error) {
        transient = isTransientConnectError(error);
        log.warn(`[${this.label}] IDLE session failed: ${imapErrorText(error)}`);
      }
      if (this.stopping) return;
      // A session that stayed up for a while was healthy; only quick failures escalate.
      failures = Date.now() - startedAt >= HEALTHY_SESSION_MS ? 1 : failures + 1;
      const delay = reconnectDelayMs(failures, transient);
      metrics.addCounter('mailsift.idle.reconnects', 1, { provider: this.account.provider });
      log.info(`[${this.label}] reconnecting IDLE in ${Math.round(delay / 1000)}s`);
      await this.pause(delay);
    }
  }

  /** Resolves when the connection closes; 'unsupported' means polling must cover this folder. */
  private async session(): Promise<'closed' | 'unsupported'> {
    const client = await this.deps.connect(this.account);
    this.client = client;
    try {
      if (this.stopping) return 'closed';
      if (!client.capabilities.has('IDLE')) {
        log.warn(`[${this.label}] server does not advertise IDLE; this folder stays on scheduled polling`);
        return 'unsupported';
      }
      const folder = await this.resolveFolder(client);
      if (!folder) return 'unsupported';
      this.folder = folder;

      const closed = new Promise<void>((resolve) => client.once('close', resolve));
      await client.mailboxOpen(folder.path, { readOnly: true });
      // Attach after the open so the SELECT response itself does not count as new mail.
      client.on('exists', () => this.scheduleWake());
      log.info(`[${this.label}] IDLE listening`);
      metrics.addCounter('mailsift.idle.sessions', 1, { provider: this.account.provider });
      await closed;
      return 'closed';
    } finally {
      if (this.client === client) {
        this.client = undefined;
        await this.release(client);
      }
    }
  }

  /**
   * The IDLE folder must also be a monitored folder: otherwise nothing would
   * reconcile it, and its cursor would exist for the wake path alone.
   */
  private async resolveFolder(client: ImapFlow): Promise<Folder | undefined> {
    const entries = await listFolders(client);
    const monitored = new Set(resolveFolders(entries, this.account.folders).map((f) => f.path));
    const [folder, ...extra] = resolveFolders(entries, [this.token]);
    if (!folder) {
      log.warn(`[${this.label}] no folder matches IMAP_IDLE_FOLDERS entry "${this.token}"`);
      return undefined;
    }
    if (extra.length) {
      log.warn(`[${this.label}] "${this.token}" matches ${extra.length + 1} folders; listening on ${folder.path} only`);
    }
    if (!monitored.has(folder.path)) {
      log.warn(`[${this.label}] ${folder.path} is not in MAIL_ACCOUNT_N_FOLDERS; add it there before enabling IDLE for it`);
      return undefined;
    }
    return folder;
  }

  /** Coalesce a burst of notifications: one fetch per debounce window, then one more if events kept coming. */
  private scheduleWake(): void {
    if (this.stopping || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.wake();
    }, this.deps.debounceMs);
  }

  private async wake(): Promise<void> {
    if (this.waking) {
      this.wakeAgain = true;
      return;
    }
    const client = this.client;
    const folder = this.folder;
    if (!client || !folder || !client.usable || this.stopping) return;
    this.waking = true;
    try {
      metrics.addCounter('mailsift.idle.wakes', 1, { provider: this.account.provider });
      await this.onWake(this.account, folder, client);
    } catch (error) {
      log.error(`[${this.label}] wake-up fetch failed: ${error}`);
    } finally {
      this.waking = false;
    }
    if (this.wakeAgain) {
      this.wakeAgain = false;
      this.scheduleWake();
    }
  }
}

/** All IDLE listeners of a process: one per configured account and IDLE folder. */
export class IdleSupervisor {
  readonly listeners: FolderListener[] = [];

  constructor(accounts: readonly Account[], onWake: WakeHandler, deps: Partial<ListenerDeps> = {}) {
    const resolved = { ...DEFAULT_DEPS, ...deps };
    for (const token of idleFolderTokens()) {
      if (token.toLowerCase() === ALL_TOKEN) {
        // One connection per folder; "all" would open one per mailbox folder.
        log.warn('IMAP_IDLE_FOLDERS does not accept "all"; list the folders explicitly');
        continue;
      }
      for (const account of accounts) this.listeners.push(new FolderListener(account, token, onWake, resolved));
    }
  }

  start(): void {
    for (const listener of this.listeners) listener.start();
    log.info(`IMAP IDLE enabled: ${this.listeners.length} listener(s); the poll interval is now the reconciliation pass`);
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.listeners.map((listener) => listener.stop()));
  }
}
