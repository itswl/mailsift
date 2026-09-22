/**
 * Outputs: Feishu and a generic webhook can be enabled together.
 *
 * The webhook authentication uses a token header. Its signature modes sign
 * different payloads, so one header cannot satisfy both replay protection checks.
 */
import { snippet, type MailMessage } from '../imap/message.js';
import { FeishuSink, type Sink } from './feishu.js';
import type { TriageResult } from './triage.js';
import { buildMailSignalEvent } from './signal.js';
import { deliverWithRetry, isRetryableStatus, type RetryState } from './delivery.js';
import { getLogger } from '../logger.js';

const log = getLogger('sink');

const MAX_SNIPPET = 600;

/**
 * Build a generic webhook inbound event.
 *
 * Keep fields under mail / triage to avoid generic_json adapter detection and
 * keep mailsift.yaml detection specific. The source-neutral signal is additive
 * and contains only a summary plus an MCP reference, never the message body.
 */
export function buildWebhookPayload(message: MailMessage, result: TriageResult): Record<string, unknown> {
  return {
    signal: buildMailSignalEvent(message, result),
    mail: {
      account: message.account,
      account_label: message.accountLabel,
      folder: message.folder,
      in_spam: message.inSpam,
      message_id: message.messageId,
      subject: message.subject || '(no subject)',
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
  private readonly retry: RetryState = { exhausted: false };

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
      log.info(`[dry-run] Would send to generic webhook | ${result.importance} | ${message.subject}`);
      return true;
    }
    if (!this.configured) return false;

    return deliverWithRetry(`Generic webhook | ${message.subject}`, this.retry, async () => {
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
          return { delivered: false, retryable: isRetryableStatus(response.status), detail: `HTTP ${response.status}` };
        }
        log.info(`Generic webhook delivered | ${result.importance} | ${message.subject}`);
        return { delivered: true, retryable: false, detail: '' };
      } catch (error) {
        return { delivered: false, retryable: true, detail: String(error) };
      }
    });
  }
}

/**
 * Send the same result to multiple outputs.
 *
 * Any successful output counts as delivery; one failed output must not hide another success.
 */
export class CompositeSink implements Sink {
  constructor(private readonly sinks: Sink[]) {}

  get configured(): boolean {
    return this.sinks.some((s) => s.configured);
  }

  async push(message: MailMessage, result: TriageResult): Promise<boolean> {
    if (this.sinks.length === 0) {
      log.error(`No configured output; message dropped | ${message.subject}`);
      return false;
    }
    // Do not short-circuit: try every output even when one fails.
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
