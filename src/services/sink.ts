/**
 * Outputs: Feishu and WebhookWise can be enabled together.
 *
 * WebhookWise authentication uses a token header. Its signature modes sign
 * different payloads, so one header cannot satisfy both replay protection checks.
 */
import { snippet, type MailMessage } from '../imap/message.js';
import { FeishuSink, type Sink } from './feishu.js';
import type { TriageResult } from './triage.js';
import { getLogger } from '../logger.js';

const log = getLogger('sink');

const MAX_SNIPPET = 600;

/**
 * Build a WebhookWise inbound event.
 *
 * Keep fields under mail / triage to avoid generic_json adapter detection and
 * keep mailsift.yaml detection specific.
 */
export function buildWebhookPayload(message: MailMessage, result: TriageResult): Record<string, unknown> {
  return {
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
      log.info(`[dry-run] Would send to WebhookWise | ${result.importance} | ${message.subject}`);
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
        log.error(`WebhookWise push rejected | HTTP ${response.status} | ${message.subject}`);
        return false;
      }
      log.info(`WebhookWise delivered | ${result.importance} | ${message.subject}`);
      return true;
    } catch (error) {
      log.error(`WebhookWise push failed | ${message.subject} | ${error}`);
      return false;
    }
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
