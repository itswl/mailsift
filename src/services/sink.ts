/**
 * 出口：飞书直推 与 WebhookWise，可并存。
 *
 * WebhookWise 的鉴权用 token 头。它也支持 x-webhook-signature，但当前实现里
 * ensure_webhook_auth 对 body 签名、enforce_replay_protection 对 "timestamp.body"
 * 签名，开了防重放后同一个头满足不了两边，所以不走签名。
 */
import { snippet, type MailMessage } from '../imap/message.js';
import { FeishuSink, type Sink } from './feishu.js';
import type { TriageResult } from './triage.js';
import { getLogger } from '../logger.js';

const log = getLogger('sink');

const MAX_SNIPPET = 600;

/**
 * 构造 WebhookWise 入站事件。
 *
 * 字段名刻意嵌在 mail / triage 两个对象里：既避开了 generic_json 适配器的
 * alert_name + level 检测，也让 mailsift.yaml 的 detect 条件足够专一。
 */
export function buildWebhookPayload(message: MailMessage, result: TriageResult): Record<string, unknown> {
  return {
    mail: {
      account: message.account,
      account_label: message.accountLabel,
      folder: message.folder,
      in_spam: message.inSpam,
      message_id: message.messageId,
      subject: message.subject || '(无主题)',
      from: message.fromAddr,
      from_name: message.fromName,
      date: message.date,
      snippet: snippet(message).slice(0, MAX_SNIPPET),
      has_attachments: message.hasAttachments,
      is_bulk: message.listUnsubscribe,
    },
    triage: {
      importance: result.importance,
      score: result.score,
      summary: result.summary,
      reason: result.reason,
      deadline: result.deadline,
      category: result.category,
      action_required: result.actionRequired,
      decided_by: result.decidedBy,
    },
  };
}

export class WebhookWiseSink implements Sink {
  constructor(
    private readonly baseUrl = (process.env.WEBHOOKWISE_URL ?? '').replace(/\/$/, ''),
    private readonly token = process.env.WEBHOOKWISE_TOKEN ?? '',
    private readonly source = process.env.WEBHOOKWISE_SOURCE ?? 'mailsift',
  ) {}

  get configured(): boolean {
    return Boolean(this.baseUrl);
  }

  get endpoint(): string {
    return `${this.baseUrl}/api/v1/webhook/${this.source}`;
  }

  async push(message: MailMessage, result: TriageResult): Promise<boolean> {
    if ((process.env.DRY_RUN ?? '').toLowerCase() === 'true') {
      log.info(`[dry-run] 本应推 WebhookWise | ${result.importance} | ${message.subject}`);
      return true;
    }
    if (!this.configured) return false;

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { token: this.token } : {}),
        },
        body: JSON.stringify(buildWebhookPayload(message, result)),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        log.error(`WebhookWise 推送被拒 | HTTP ${response.status} | ${message.subject}`);
        return false;
      }
      log.info(`WebhookWise 已送达 | ${result.importance} | ${message.subject}`);
      return true;
    } catch (error) {
      log.error(`WebhookWise 推送失败 | ${message.subject} | ${error}`);
      return false;
    }
  }
}

/**
 * 把同一条结论发往多个出口。
 *
 * 任一出口成功即算送达——两个都配的时候，一个挂了不该让另一个也被记成失败。
 */
export class CompositeSink implements Sink {
  constructor(private readonly sinks: Sink[]) {}

  get configured(): boolean {
    return this.sinks.some((s) => s.configured);
  }

  async push(message: MailMessage, result: TriageResult): Promise<boolean> {
    if (this.sinks.length === 0) {
      log.error(`没有任何可用出口，消息被丢弃 | ${message.subject}`);
      return false;
    }
    // 不短路：每个出口都要试，否则第一个失败会让后面的收不到
    const results = await Promise.all(this.sinks.map((sink) => sink.push(message, result)));
    return results.some(Boolean);
  }
}

export function buildSink(): Sink {
  const sinks: Sink[] = [];
  if (process.env.FEISHU_WEBHOOK_URL?.trim()) sinks.push(new FeishuSink());
  if (process.env.WEBHOOKWISE_URL?.trim()) sinks.push(new WebhookWiseSink());
  return sinks.length === 1 ? sinks[0]! : new CompositeSink(sinks);
}

export type { Sink };
