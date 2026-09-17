/**
 * 编排：拉取 -> 去重 -> 分诊 -> 推送/入简报队列。
 *
 * 各账号并发拉取，但分诊统一批量做——LLM 按批计费，攒一批比一封一调便宜。
 */
import { IMPORTANCE_RANK, type Account, type Importance, type WatchConfig } from '../config.js';
import {
  connect,
  fetchNew,
  targetFolders,
  type FolderCursor,
  type MessageBudget,
} from '../imap/client.js';
import { dedupKey, snippet, type MailMessage } from '../imap/message.js';
import { triage, rank, type TriageResult } from './triage.js';
import * as digest from './digest.js';
import * as health from './health.js';
import type { Sink } from './sink.js';
import type { StateStore } from './state.js';
import { getLogger } from '../logger.js';

const log = getLogger('watcher');

export const HEARTBEAT_KEY = 'last_poll_at';
export const PRUNE_KEY = 'last_prune_date';

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
    `账号 ${stats.accountsOk} 成功/${stats.accountsFailed} 失败 | ` +
    `拉取 ${stats.fetched} | 新邮件 ${stats.fresh} | ` +
    `推送 ${stats.pushed}（垃圾箱捞回 ${stats.spamRescued}）| 入简报 ${stats.queued}`
  );
}

type PendingCursor = [account: string, folder: string, uidValidity: string, lastUid: number];

export class Watcher {
  constructor(
    readonly config: WatchConfig,
    readonly state: StateStore,
    readonly sink: Sink,
  ) {}

  /**
   * 拉一个账号所有目标文件夹的新邮件。
   *
   * 游标**不在这里落盘**——必须等这些邮件真正分诊并投递完才能推进，
   * 否则进程若死在 dispatch 阶段，游标已经越过去了，这批信再也不会被
   * 拉到，而且是完全静默的。宁可重复拉取，不可静默丢失。
   */
  async collectAccount(
    account: Account,
    budget: MessageBudget,
  ): Promise<{ messages: MailMessage[]; cursors: PendingCursor[] }> {
    const messages: MailMessage[] = [];
    const cursors: PendingCursor[] = [];
    const client = await connect(account);

    try {
      const folders = await targetFolders(client, account);
      if (folders.length === 0) {
        log.warn(`[${account.name}] 没有可扫描的文件夹`);
        return { messages, cursors };
      }
      log.info(
        `[${account.name}] 扫描文件夹: ${folders
          .map((f) => `${f.path}${f.isSpam ? '(垃圾箱)' : ''}`)
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
          cursors.push([account.username, folder.path, result.cursor.uidValidity, result.cursor.lastUid]);
        } catch (error) {
          log.error(`[${account.name}/${folder.path}] 拉取失败: ${error}`);
        }
      }
    } finally {
      await client.logout().catch(() => undefined);
    }

    return { messages, cursors };
  }

  async collectAll(stats: PollStats): Promise<{ messages: MailMessage[]; cursors: PendingCursor[] }> {
    const limit = Math.max(1, Number(process.env.MAX_CONCURRENT_ACCOUNTS ?? 5));
    const rawBudget = Number(process.env.MAX_MESSAGES_PER_POLL_TOTAL ?? 500);
    const budget: MessageBudget = {
      remaining: Number.isFinite(rawBudget) && rawBudget > 0 ? Math.floor(rawBudget) : 500,
    };
    const messages: MailMessage[] = [];
    const cursors: PendingCursor[] = [];
    const queue = [...this.config.accounts];

    const worker = async (): Promise<void> => {
      for (;;) {
        const account = queue.shift();
        if (!account) return;
        try {
          const result = await this.collectAccount(account, budget);
          stats.accountsOk += 1;
          messages.push(...result.messages);
          cursors.push(...result.cursors);
          await health.recordAccountSuccess(this.state, this.sink, account).catch((e) =>
            log.error(`发送恢复通知失败: ${e}`),
          );
        } catch (error) {
          stats.accountsFailed += 1;
          stats.failures.push(`${account.name}: ${error}`);
          log.error(`[${account.name}] 账号处理失败: ${error}`);
          // 失联必须出声：静默停止监控正是这个工具要防的事
          await health
            .recordAccountFailure(this.state, this.sink, account, error)
            .catch((e) => log.error(`发送失联告警本身也失败了: ${e}`));
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
    stats.fetched = messages.length;
    return { messages, cursors };
  }

  /**
   * 只保留没处理过的。只查不写——标记推迟到这封信真正处理完（见 dispatch）。
   * 同一轮内还要去一次重：同一封信可能同时出现在两个被监控的文件夹里。
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
      void task.catch((e) => log.error(`模型可用性告警本身失败: ${e}`));
    };

    for (const [message, result] of await triage(messages, this.config.rules, onLlmResult)) {
      // 先建 seen 行再写结论：两步都在这一封处理完之前完成，进程若死在这里，
      // 这封信下轮会被重新拉取和分诊，而不是静默消失。
      const key = dedupKey(message);
      this.state.markSeen(key, message.account, message.subject);
      const fields = this.outcomeFields(message, result);

      if (this.effectiveRank(message, result) >= pushThreshold) {
        const delivered = await this.sink.push(message, result);
        if (delivered) {
          stats.pushed += 1;
          if (message.inSpam) stats.spamRescued += 1;
        }
        this.state.recordOutcome(key, result.importance, delivered, fields);
        if (delivered) continue;
        // 投递失败的不能就这么没了：它已经被标记 seen，下轮不会再拉，
        // 兜进简报至少保证还能看到一次。
        log.warn(`投递失败，改入简报: ${message.subject}`);
        this.state.queueDigest(key, digest.toDigestItem(message, result));
        stats.queued += 1;
        continue;
      }

      this.state.recordOutcome(key, result.importance, false, fields);
      // 垃圾箱的邮件一律进简报：实时推送要克制，但"进了垃圾箱的东西你从来
      // 看不到"正是这个工具要解决的问题，每天给一份可复核的清单。
      if (message.inSpam || rank(result) >= digestThreshold) {
        this.state.queueDigest(key, digest.toDigestItem(message, result));
        stats.queued += 1;
      }
    }
  }

  /** 每天清理一次过期的 seen 记录。不清的话这张表只增不减。 */
  private maybePrune(): void {
    const keepDays = Number(process.env.STATE_RETENTION_DAYS ?? 90);
    if (keepDays <= 0) return;
    const today = new Date().toISOString().slice(0, 10);
    if (this.state.getMeta(PRUNE_KEY) === today) return;
    try {
      const removed = this.state.prune(keepDays);
      this.state.setMeta(PRUNE_KEY, today);
      if (removed) log.info(`已清理 ${removed} 条超过 ${keepDays} 天的记录`);
    } catch (error) {
      log.warn(`清理状态库失败（不影响本轮）: ${error}`);
    }
  }

  async pollOnce(): Promise<PollStats> {
    const stats = newStats();
    const { messages, cursors } = await this.collectAll(stats);

    const fresh = this.filterFresh(messages);
    stats.fresh = fresh.length;

    if (fresh.length) await this.dispatch(fresh, stats);
    else log.info('本轮没有新邮件');

    // 分诊投递都走完了，这批 UID 才算真正处理过，可以推进游标。
    // dispatch 抛异常时这里不会执行，下轮重新拉取——重复远好过静默丢失。
    for (const [account, folder, uidValidity, lastUid] of cursors) {
      this.state.saveCursor(account, folder, uidValidity, lastUid);
    }

    if (digest.shouldSend(this.state)) await digest.sendDigest(this.state, this.sink);

    this.maybePrune();

    const stuck = this.state.countUndispatched();
    if (stuck) {
      log.warn(
        `有 ${stuck} 封邮件标记过但没有分诊结论（多半是上次被中断）。` +
          '用 node dist/src/main.js --recover 让它们重新处理',
      );
    }

    // 心跳放最后——只有真正跑完一轮才算活着，卡在 IMAP 上不会续命
    this.state.setMeta(HEARTBEAT_KEY, new Date().toISOString());
    log.info(summarizeStats(stats));
    return stats;
  }
}
