/**
 * Outputs: Feishu and a generic webhook can be enabled together.
 *
 * The webhook authentication uses a token header. Its signature modes sign
 * different payloads, so one header cannot satisfy both replay protection checks.
 */
import {
  snippet, type MailMessage,
} from '../imap/message.js';
import { buildCard, FeishuSink, sign, type PushOutcome, type Sink } from './feishu.js';
import { hidesContent, sensitiveWords, type TriageResult } from './triage.js';
import { buildMailSignalEvent } from './signal.js';
import { redactSecrets } from '../logger.js';
import { deliverWithRetry, isRetryableStatus, type RetryState } from './delivery.js';
import { getLogger } from '../logger.js';

const log = getLogger('sink');

const MAX_SNIPPET = 600;
/**
 * A digest carries its whole body, not a preview of one.
 *
 * snippet() exists to bound a mail preview at 400 characters. Running a digest
 * through it delivered a fragment ending mid-word, without the closing line
 * that states how much was left out, which is the failure the Feishu path was
 * just fixed for. Sized above DIGEST_MAX_CHARS so the render budget governs.
 */
const MAX_DIGEST_BODY = 8000;

/**
 * Where the webhook posts.
 *
 * WEBHOOK_URL is the complete endpoint, which is what a webhook usually means.
 * The older WEBHOOKWISE_* names are still honoured and keep their original
 * behaviour of appending a fixed receiver path, so an existing deployment does
 * not silently change shape on upgrade.
 */
export function webhookEndpoint(): string {
  const direct = process.env.WEBHOOK_URL?.trim();
  if (direct) return direct.replace(/\/$/, '');
  const legacy = process.env.WEBHOOKWISE_URL?.trim();
  if (!legacy) return '';
  const source = process.env.WEBHOOKWISE_SOURCE?.trim() || 'mailsift';
  return `${legacy.replace(/\/$/, '')}/api/v1/webhook/${source}`;
}

/** The token header, under either the current or the legacy name. */
export function webhookToken(): string {
  return process.env.WEBHOOK_TOKEN?.trim() || process.env.WEBHOOKWISE_TOKEN?.trim() || '';
}

/** True when the deployment still uses the superseded variable names. */
export function usesLegacyWebhookNames(): boolean {
  return !process.env.WEBHOOK_URL?.trim() && Boolean(process.env.WEBHOOKWISE_URL?.trim());
}

/**
 * Build the webhook payload.
 *
 * Fields stay grouped under mail and triage so a receiver can recognise this
 * shape specifically rather than treating it as anonymous JSON. The
 * source-neutral signal is additive and carries only a summary plus an MCP
 * reference, never the message body.
 */
export function buildWebhookPayload(message: MailMessage, result: TriageResult): Record<string, unknown> {
  const isDigest = Boolean(message.extra?.['digest']);
  const sensitiveVerification = hidesContent(message, result);
  const words = sensitiveWords(message, result);
  return {
    signal: buildMailSignalEvent(message, result),
    mail: {
      account: message.account,
      account_label: message.accountLabel,
      folder: message.folder,
      in_spam: message.inSpam,
      message_id: message.messageId,
      subject: sensitiveVerification ? words.subject : message.subject || '(no subject)',
      from: message.fromAddr,
      from_name: message.fromName,
      date: message.date,
      snippet: sensitiveVerification
        ? ''
        : isDigest ? message.body.slice(0, MAX_DIGEST_BODY) : snippet(message).slice(0, MAX_SNIPPET),
      has_attachments: message.hasAttachments,
      is_bulk: message.listUnsubscribe,
    },
    triage: {
      importance: result.importance,
      score: result.score,
      summary: sensitiveVerification ? words.summary : result.summary,
      reason: sensitiveVerification ? words.reason : result.reason,
      deadline: sensitiveVerification ? '' : result.deadline,
      category: sensitiveVerification ? 'Security' : result.category,
      action_required: sensitiveVerification ? !result.sensitiveUnasked : result.actionRequired,
      decided_by: result.decidedBy,
    },
  };
}

export class WebhookSink implements Sink {
  private readonly retry: RetryState = { exhausted: false };

  constructor(
    private readonly url = webhookEndpoint(),
    private readonly token = webhookToken(),
  ) {}

  get configured(): boolean {
    return Boolean(this.url);
  }

  get endpoint(): string {
    return this.url;
  }

  async push(message: MailMessage, result: TriageResult): Promise<PushOutcome> {
    if ((process.env.DRY_RUN ?? '').toLowerCase() === 'true') {
      log.info(`[dry-run] Would send to generic webhook | ${result.importance} | ${message.subject}`);
      return 'delivered';
    }
    if (!this.configured) return 'declined';

    const delivered = await deliverWithRetry(`Generic webhook | ${message.subject}`, this.retry, async () => {
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
    return delivered ? 'delivered' : 'failed';
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

  async push(message: MailMessage, result: TriageResult): Promise<PushOutcome> {
    if (this.sinks.length === 0) {
      // No external destination is a supported choice. Keep the mail in the
      // local digest/view; browser push is dispatched independently.
      return 'declined';
    }
    // Do not short-circuit: try every output even when one fails.
    const outcomes = await Promise.all(this.sinks.map((sink) => sink.push(message, result)));
    if (outcomes.includes('delivered')) return 'delivered';
    // One output declining must not settle a message another output failed to
    // send; only a unanimous decline means no retry can ever help.
    return outcomes.includes('failed') ? 'failed' : 'declined';
  }
}

export function buildSink(): Sink {
  const sinks: Sink[] = [];
  if (process.env.FEISHU_WEBHOOK_URL?.trim()) sinks.push(new FeishuSink());
  if (webhookEndpoint()) sinks.push(new WebhookSink());
  return sinks.length === 1 ? sinks[0]! : new CompositeSink(sinks);
}

/**
 * Send one made-up notification to the destinations in `values`, for the
 * settings page's test button. Nothing from a mailbox is in it, it does not
 * go through the outbox, and every destination is tried even when one fails.
 */
export async function sendTestNotification(
  values: Record<string, string | undefined>, lang: 'en' | 'zh-CN' = 'en',
): Promise<string> {
  const zh = lang === 'zh-CN';
  const feishuUrl = values['FEISHU_WEBHOOK_URL']?.trim() ?? '';
  const webhookUrl = values['WEBHOOK_URL']?.trim() ?? '';
  const webhookToken = values['WEBHOOK_TOKEN']?.trim() ?? '';
  if (!feishuUrl && !webhookUrl) {
    throw new Error(zh ? '还没有配置飞书或 Webhook。' : 'Add a Feishu bot or a webhook first.');
  }

  const message: MailMessage = {
    account: 'test@mailsift.invalid',
    accountLabel: 'mailsift',
    provider: 'imap',
    folder: 'INBOX',
    inSpam: false,
    uid: 1,
    messageId: `<test-${Date.now()}@mailsift.invalid>`,
    subject: zh ? 'mailsift 测试通知' : 'mailsift test notification',
    fromAddr: 'mailsift@mailsift.invalid',
    fromName: 'mailsift',
    toAddrs: [],
    date: new Date().toISOString(),
    body: zh ? '这是从设置页面发出的测试通知，不含任何邮件内容。' : 'A test sent from the settings page. It carries no mail.',
    hasAttachments: false,
    listUnsubscribe: false,
  };
  const triage: TriageResult = {
    importance: 'warning',
    score: 2,
    summary: zh ? '通知渠道工作正常。' : 'This notification channel works.',
    reason: zh ? '管理员在设置页面请求了测试。' : 'Sent because the administrator asked for a test.',
    deadline: '',
    category: 'System',
    actionRequired: false,
    decidedBy: 'rule',
  };

  const deliveries: Array<{ name: string; work: () => Promise<void> }> = [];
  if (feishuUrl) deliveries.push({
    name: zh ? '飞书' : 'Feishu',
    work: async () => {
      const payload = buildCard(message, triage);
      const secret = values['FEISHU_WEBHOOK_SECRET']?.trim();
      if (secret) {
        const timestamp = Math.floor(Date.now() / 1000);
        payload['timestamp'] = String(timestamp);
        payload['sign'] = sign(secret, timestamp);
      }
      const response = await fetch(feishuUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json().catch(() => ({})) as { code?: number; StatusCode?: number; msg?: string };
      const code = data.code ?? data.StatusCode ?? 0;
      if (code !== 0) throw new Error(`${data.msg ?? 'rejected'} (${code})`);
    },
  });
  if (webhookUrl) deliveries.push({
    name: 'Webhook',
    work: async () => {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(webhookToken ? { token: webhookToken } : {}) },
        body: JSON.stringify(buildWebhookPayload(message, triage)),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    },
  });

  const results = await Promise.allSettled(deliveries.map((delivery) => delivery.work()));
  const failures = results.flatMap((result, index) => result.status === 'rejected'
    ? [`${deliveries[index]!.name}: ${redactSecrets(result.reason instanceof Error ? result.reason.message : String(result.reason))}`]
    : []);
  const sent = deliveries.filter((_, index) => results[index]!.status === 'fulfilled').map((delivery) => delivery.name);
  if (failures.length) {
    throw new Error((sent.length ? (zh ? `已送达 ${sent.join('、')}；` : `Delivered to ${sent.join(' and ')}; `) : '') + failures.join('; '));
  }
  return zh ? `已送达 ${sent.join('、')}。` : `Delivered to ${sent.join(' and ')}.`;
}

export type { PushOutcome, Sink };
