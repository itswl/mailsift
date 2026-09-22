/**
 * Orchestration: fetch -> deduplicate -> triage -> push or queue for digest.
 *
 * Accounts fetch concurrently, while triage is batched to reduce LLM cost.
 * Two entry points feed the same pipeline: the scheduled poll and IDLE
 * wake-ups for a single folder.
 */
import type { ImapFlow } from 'imapflow';
import { IMPORTANCE_RANK, type Account, type Importance, type WatchConfig } from '../config.js';
import {
  connect,
  fetchNew,
  targetFolders,
  type FetchFailure,
  type FolderCursor,
  type MessageBudget,
} from '../imap/client.js';
import type { Folder } from '../imap/folders.js';
import { dedupKey, snippet, type MailMessage } from '../imap/message.js';
import { triage, rank, type TriageResult } from './triage.js';
import * as digest from './digest.js';
import * as health from './health.js';
import type { Sink } from './sink.js';
import type { StateStore } from './state.js';
import { getLogger } from '../logger.js';
import { metrics } from '../metrics.js';

const log = getLogger('watcher');

export const HEARTBEAT_KEY = 'last_poll_at';
export const PRUNE_KEY = 'last_prune_date';
/** Per-account timestamp of the last IDLE wake-up that reached the pipeline. */
export const IDLE_WAKE_KEY = 'idle_last_wake_at:';

export interface PollStats {
  accountsOk: number;
  accountsFailed: number;
  fetched: number;
  fresh: number;
  pushed: number;
  queued: number;
  spamRescued: number;
  failures: string[];
}

function newStats(): PollStats {
  return {
    accountsOk: 0, accountsFailed: 0, fetched: 0, fresh: 0,
    pushed: 0, queued: 0, spamRescued: 0, failures: [],
  };
}

export function summarizeStats(stats: PollStats): string {
  return (
    `accounts ${stats.accountsOk} ok/${stats.accountsFailed} failed | ` +
    `fetched ${stats.fetched} | fresh ${stats.fresh} | ` +
    `pushed ${stats.pushed} (spam recovered ${stats.spamRescued}) | queued ${stats.queued}`
  );
}

type PendingCursor = [account: string, folder: string, uidValidity: string, lastUid: number];
type CollectAccountResult = {
  messages: MailMessage[];
  cursors: PendingCursor[];
  failures?: string[];
  deadLetters?: FetchFailure[];
};
/** Everything fetched and ready for the deduplicate -> triage -> deliver stage. */
interface Collected {
  messages: MailMessage[];
  cursors: PendingCursor[];
  deadLetters?: Array<FetchFailure & { account: string }>;
}

export class Watcher {
  /** Tail of the exclusive-section chain; see exclusive(). */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly config: WatchConfig,
    readonly state: StateStore,
    readonly sink: Sink,
  ) {}

  /**
   * Run state-changing work one job at a time.
   *
   * The scheduled poll and IDLE wake-ups both end in filterFresh -> dispatch.
   * Interleaved, two of them could pass isSeen for the same message before
   * either marks it, and an outbox flush could resend a notification another
   * job is pushing at that moment. IMAP fetching stays outside this section so
   * a wake-up is not held up by a long poll.
   */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Fetch new mail from all target folders for one account.
   *
   * Cursors are not persisted here. They advance only after triage and delivery,
   * so an interruption cannot silently skip a batch.
   */
  async collectAccount(
    account: Account,
    budget: MessageBudget,
  ): Promise<CollectAccountResult> {
    const messages: MailMessage[] = [];
    const cursors: PendingCursor[] = [];
    const failures: string[] = [];
    const deadLetters: FetchFailure[] = [];
    const client = await connect(account);

    try {
      const folders = await targetFolders(client, account);
      if (folders.length === 0) {
        const failure = `no selectable folders to scan; configured folders: ${account.folders.join(', ')}`;
        log.error(`[${account.name}] ${failure}`);
        return { messages, cursors, failures: [failure] };
      }
      log.info(
        `[${account.name}] scanning folders: ${folders
          .map((f) => `${f.path}${f.isSpam ? ' (spam)' : ''}`)
          .join(', ')}`,
      );

      for (const folder of folders) {
        if (budget.remaining <= 0) break;
        const saved = this.state.getCursor(account.username, folder.path);
        const cursor: FolderCursor | undefined = saved
          ? { uidValidity: saved.uidValidity, lastUid: saved.lastUid }
          : undefined;
        try {
          const result = await fetchNew(client, account, folder, cursor, budget);
          messages.push(...result.messages);
          deadLetters.push(...result.failures);
          cursors.push([account.username, folder.path, result.cursor.uidValidity, result.cursor.lastUid]);
        } catch (error) {
          failures.push(`${folder.path}: ${error}`);
          log.error(`[${account.name}/${folder.path}] fetch failed: ${error}`);
        }
      }
    } finally {
      await client.logout().catch(() => undefined);
    }

    return { messages, cursors, failures, deadLetters };
  }

  async collectAll(stats: PollStats): Promise<Collected> {
    const limit = Math.max(1, Number(process.env.MAX_CONCURRENT_ACCOUNTS ?? 5));
    const rawBudget = Number(process.env.MAX_MESSAGES_PER_POLL_TOTAL ?? 500);
    const budget: MessageBudget = {
      remaining: Number.isFinite(rawBudget) && rawBudget > 0 ? Math.floor(rawBudget) : 500,
    };
    const messages: MailMessage[] = [];
    const cursors: PendingCursor[] = [];
    const deadLetters: Array<FetchFailure & { account: string }> = [];
    const queue = [...this.config.accounts];

    const worker = async (): Promise<void> => {
      for (;;) {
        const account = queue.shift();
        if (!account) return;
        try {
          const result = await this.collectAccount(account, budget);
          const failures = result.failures ?? [];
          if (failures.length === 0) stats.accountsOk += 1;
          else {
            stats.accountsFailed += 1;
            stats.failures.push(...failures.map((failure) => `${account.name}/${failure}`));
          }
          messages.push(...result.messages);
          cursors.push(...result.cursors);
          metrics.addCounter('mailsift.accounts.processed', 1, {
            provider: account.provider,
            outcome: failures.length === 0 ? 'success' : 'partial_failure',
          });
          for (const dead of result.deadLetters ?? []) {
            deadLetters.push({ ...dead, account: account.username });
          }
          const healthTask = failures.length
            ? health.recordAccountFailure(this.state, this.sink, account, failures.join('; '))
            : health.recordAccountSuccess(this.state, this.sink, account);
          await healthTask.catch((e) => log.error(`Failed to send account health notice: ${e}`));
        } catch (error) {
          stats.accountsFailed += 1;
          stats.failures.push(`${account.name}: ${error}`);
          log.error(`[${account.name}] account processing failed: ${error}`);
          // Account loss must be visible; silent monitoring gaps are unacceptable.
          await health
            .recordAccountFailure(this.state, this.sink, account, error)
            .catch((e) => log.error(`Failed to send account failure alert: ${e}`));
          metrics.addCounter('mailsift.accounts.processed', 1, { provider: account.provider, outcome: 'failure' });
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
    stats.fetched = messages.length;
    return { messages, cursors, deadLetters };
  }

  /**
   * Keep only unseen messages. Marking is deferred until dispatch completes.
   * Deduplicate within a poll because one message may appear in two folders.
   */
  filterFresh(messages: MailMessage[]): MailMessage[] {
    const batch = new Set<string>();
    const fresh: MailMessage[] = [];
    for (const message of messages) {
      const key = dedupKey(message);
      if (batch.has(key) || this.state.isSeen(key)) continue;
      batch.add(key);
      fresh.push(message);
    }
    return fresh;
  }

  private effectiveRank(message: MailMessage, result: TriageResult): number {
    const bonus = Number(process.env.SPAM_RANK_BONUS ?? 0);
    return message.inSpam ? rank(result) + Math.max(0, bonus) : rank(result);
  }

  private triageRules() {
    const feedback = this.state.feedbackRuleHints(2);
    return { ...this.config.rules, feedbackAlwaysImportant: feedback.alwaysImportant, feedbackNeverImportant: feedback.neverImportant };
  }

  private async flushNotificationOutbox(): Promise<void> {
    for (const entry of this.state.pendingNotifications()) {
      const delivered = await this.sink.push(entry.message, entry.result);
      if (delivered) {
        this.state.markNotificationDelivered(entry.notificationKey);
        this.state.clearDigest([entry.notificationKey]);
        metrics.addCounter('mailsift.notifications.delivered', 1, { channel: 'outbox_retry' });
      } else {
        this.state.markNotificationFailed(entry.notificationKey, 'sink delivery failed');
        metrics.addCounter('mailsift.notifications.failed', 1, { channel: 'outbox_retry' });
      }
    }
  }

  private outcomeFields(message: MailMessage, result: TriageResult) {
    return {
      messageId: message.messageId,
      accountLabel: message.accountLabel,
      sender: message.fromAddr,
      senderName: message.fromName,
      folder: message.folder,
      inSpam: message.inSpam,
      category: result.category,
      summary: result.summary,
      reason: result.reason,
      deadline: result.deadline,
      decidedBy: result.decidedBy,
      mailDate: message.date,
      snippet: snippet(message),
    };
  }

  async dispatch(messages: MailMessage[], stats: PollStats): Promise<void> {
    if (messages.length === 0) return;

    const pushThreshold =
      IMPORTANCE_RANK[(process.env.PUSH_MIN_IMPORTANCE ?? 'warning') as Importance] ?? 1;
    const digestThreshold =
      IMPORTANCE_RANK[(process.env.DIGEST_MIN_IMPORTANCE ?? 'info') as Importance] ?? 0;

    const onLlmResult = (error: unknown | null): void => {
      const task = error
        ? health.recordLlmFailure(this.state, this.sink, error)
        : health.recordLlmSuccess(this.state, this.sink);
      void task.catch((e) => log.error(`Failed to send LLM availability alert: ${e}`));
    };

    for (const [message, result] of await triage(messages, this.triageRules(), onLlmResult)) {
      metrics.addCounter('mailsift.messages.triaged', 1, {
        provider: message.provider,
        importance: result.importance,
        decided_by: result.decidedBy,
      });
      // Create the seen row before the outcome. An interruption before completion
      // leaves the message eligible for the next poll.
      const key = dedupKey(message);
      this.state.markSeen(key, message.account, message.subject);
      const fields = this.outcomeFields(message, result);

      if (this.effectiveRank(message, result) >= pushThreshold) {
        // Persist a bounded, resendable copy before the external write. The
        // outbox is at-least-once: a crash after provider acceptance and before
        // the delivered mark can still duplicate a notification, so adapters
        // should use notificationKey for idempotency where supported.
        const outboxMessage = { ...message, body: snippet(message) };
        this.state.enqueueNotification(key, outboxMessage, result);
        const delivered = await this.sink.push(message, result);
        if (delivered) {
          this.state.markNotificationDelivered(key);
          metrics.addCounter('mailsift.notifications.delivered', 1, { channel: 'realtime' });
          stats.pushed += 1;
          if (message.inSpam) stats.spamRescued += 1;
        } else {
          this.state.markNotificationFailed(key, 'sink delivery failed');
          metrics.addCounter('mailsift.notifications.failed', 1, { channel: 'realtime' });
        }
        this.state.recordOutcome(key, result.importance, delivered, fields);
        if (delivered) continue;
        // A failed delivery is already marked seen, so queue it for the digest.
        log.warn(`Delivery failed; queued for digest: ${message.subject}`);
        this.state.queueDigest(key, digest.toDigestItem(message, result));
        stats.queued += 1;
        continue;
      }

      this.state.recordOutcome(key, result.importance, false, fields);
      // Always include spam in the digest: it is the category most likely to hide
      // an important message.
      if (message.inSpam || rank(result) >= digestThreshold) {
        this.state.queueDigest(key, digest.toDigestItem(message, result));
        stats.queued += 1;
      }
    }
  }

  /** Prune old seen records once per day. */
  private maybePrune(): void {
    const keepDays = Number(process.env.STATE_RETENTION_DAYS ?? 90);
    if (keepDays <= 0) return;
    const today = new Date().toISOString().slice(0, 10);
    if (this.state.getMeta(PRUNE_KEY) === today) return;
    try {
      const removed = this.state.prune(keepDays);
      this.state.setMeta(PRUNE_KEY, today);
      if (removed) log.info(`Pruned ${removed} records older than ${keepDays} days`);
    } catch (error) {
      log.warn(`State pruning failed (poll continues): ${error}`);
    }
  }

  /** Deduplicate, triage, deliver, then advance cursors. Call inside exclusive(). */
  private async commit(collected: Collected, stats: PollStats, quietWhenEmpty = false): Promise<void> {
    const fresh = this.filterFresh(collected.messages);
    stats.fresh = fresh.length;

    if (fresh.length) await this.dispatch(fresh, stats);
    else if (!quietWhenEmpty) log.info('No new messages in this poll.');

    for (const dead of collected.deadLetters ?? []) {
      this.state.recordDeadLetter({
        account: dead.account,
        folder: dead.folder,
        uidValidity: dead.uidValidity,
        uid: dead.uid,
        messageId: dead.messageId,
        subject: dead.subject,
        reason: dead.reason,
      });
      metrics.addCounter('mailsift.dead_letters.created', 1, { reason: dead.reason.includes('size') ? 'oversized' : 'parse' });
    }

    // Only after triage and delivery complete are these UIDs safe to advance.
    // If dispatch throws, the next poll retries them.
    for (const [account, folder, uidValidity, lastUid] of collected.cursors) {
      this.state.advanceCursor(account, folder, uidValidity, lastUid);
    }
  }

  async pollOnce(): Promise<PollStats> {
    const stats = newStats();
    const started = performance.now();
    metrics.addCounter('mailsift.polls.started');
    const collected = await this.collectAll(stats);

    return this.exclusive(async () => {
      await this.flushNotificationOutbox();
      await this.commit(collected, stats);

      if (digest.shouldSend(this.state)) await digest.sendDigest(this.state, this.sink);

      this.maybePrune();

      const stuck = this.state.countUndispatched();
      if (stuck) {
        log.warn(
          `${stuck} messages are marked without a triage result (likely interrupted). ` +
            'Run node dist/src/main.js --recover to retry them.',
        );
      }

      // Write the heartbeat last: a poll stuck in IMAP must not appear healthy.
      this.state.setMeta(HEARTBEAT_KEY, new Date().toISOString());
      metrics.recordHistogram('mailsift.poll.duration_ms', performance.now() - started);
      metrics.addCounter('mailsift.polls.completed');
      log.info(summarizeStats(stats));
      return stats;
    });
  }

  /**
   * Fetch one folder on an already open connection and run it through the pipeline.
   *
   * This is the IDLE wake-up path. It is incremental only: a folder without a
   * cursor is left to the scheduled poll, whose bounded lookback handles first
   * contact, so a wake-up during the initial backfill cannot double it.
   */
  async pollFolder(account: Account, folder: Folder, client: ImapFlow): Promise<PollStats> {
    const stats = newStats();
    const cursor = this.state.getCursor(account.username, folder.path);
    if (!cursor) {
      log.info(`[${account.name}/${folder.path}] no cursor yet; leaving the first scan to the scheduled poll`);
      return stats;
    }
    const result = await fetchNew(client, account, folder, cursor);
    stats.accountsOk = 1;
    stats.fetched = result.messages.length;

    return this.exclusive(async () => {
      await this.commit(
        {
          messages: result.messages,
          cursors: [[account.username, folder.path, result.cursor.uidValidity, result.cursor.lastUid]],
          deadLetters: result.failures.map((failure) => ({ ...failure, account: account.username })),
        },
        stats,
        true,
      );
      this.state.setMeta(IDLE_WAKE_KEY + account.username, new Date().toISOString());
      log.info(`[${account.name}/${folder.path}] IDLE wake-up | ${summarizeStats(stats)}`);
      return stats;
    });
  }
}
