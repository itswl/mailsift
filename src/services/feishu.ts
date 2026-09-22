/**
 * Direct Feishu bot output.
 *
 * Cards must stand alone because the user may not have a mail client on their phone.
 * Show the summary first, then metadata, then an optional link button.
 */
import { createHmac } from 'node:crypto';
import { IMPORTANCE_RANK, type Importance } from '../config.js';
import { buildLink } from '../links.js';
import { snippet, type MailMessage } from '../imap/message.js';
import { effectiveRank, headline, type TriageResult } from './triage.js';
import { deliverWithRetry, isRetryableStatus, type RetryState } from './delivery.js';
import { getLogger } from '../logger.js';

const log = getLogger('feishu');

/** Returned with HTTP 200 when a custom bot exceeds its request rate. */
const FEISHU_RATE_LIMIT_CODE = 11232;

const TEMPLATE: Record<Importance, string> = { critical: 'red', warning: 'orange', info: 'blue' };
const PREFIX: Record<Importance, string> = { critical: '🔴', warning: '🟠', info: '🔵' };
const MAX_CARD_CHARS = 3000;

/**
 * Bare angle brackets are swallowed by card Markdown, but addresses contain them.
 *
 * The backslash escape is itself escapable, so any backslash in the text has to be
 * doubled first — otherwise a sender-controlled subject or address ending in `\`
 * turns the following `\<` back into a live `<`.
 */
function esc(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/</g, '\\<').replace(/>/g, '\\>');
}

/** Convert an ISO timestamp to a compact local-time display. */
function formatDate(raw: string): string {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.valueOf())) return raw;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

export function buildCard(message: MailMessage, result: TriageResult): Record<string, unknown> {
  const isDigest = Boolean(message.extra?.['digest']);
  const template = TEMPLATE[result.importance] ?? 'grey';

  if (isDigest) {
    return {
      msg_type: 'interactive',
      card: {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: `📮 ${message.subject}` }, template },
        elements: [{ tag: 'markdown', content: message.body.slice(0, MAX_CARD_CHARS) }],
      },
    };
  }

  const spamTag = message.inSpam ? '[Recovered from spam] ' : '';
  const title = `${PREFIX[result.importance] ?? ''} ${spamTag}${message.subject}`.slice(0, 200);

  const lines = [esc(headline(result))];
  if (result.deadline) lines.push(`\n⏰ **Deadline** ${esc(result.deadline)}`);
  lines.push(
    '',
    '---',
    `**From** ${esc(message.fromName || message.fromAddr)} \\<${esc(message.fromAddr)}\\>`,
    `**Account** ${message.accountLabel} · ${message.folder}`,
    `**Date** ${formatDate(message.date)}`,
    `**Category** ${result.category}${result.actionRequired ? ' · Action required' : ''}`,
  );
  if (message.hasAttachments) lines.push('**Attachments** available');
  const body = snippet(message);
  if (body) lines.push('', '---', esc(body));

  const elements: Array<Record<string, unknown>> = [
    { tag: 'markdown', content: lines.join('\n').slice(0, MAX_CARD_CHARS) },
  ];

  const link = buildLink(message.provider, message.account, message.messageId);
  if (link) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: link.label },
          url: link.url,
          type: link.exact ? 'primary' : 'default',
        },
      ],
    });
  }

  return {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: title }, template },
      elements,
    },
  };
}

/** Sign `{timestamp}\n{secret}` with HMAC-SHA256 over an empty payload. */
export function sign(secret: string, timestamp: number): string {
  return createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
}

/**
 * What one delivery attempt settled on.
 *
 * `declined` and `failed` have to stay apart. A decline is the output's own
 * policy, so the same message would be declined again on every retry; keeping
 * it queued builds a backlog that never drains and hides a real one. A failure
 * is worth retrying.
 */
export type PushOutcome = 'delivered' | 'declined' | 'failed';

export interface Sink {
  readonly configured: boolean;
  push(message: MailMessage, result: TriageResult): Promise<PushOutcome>;
}

export class FeishuSink implements Sink {
  private readonly retry: RetryState = { exhausted: false };

  constructor(
    private readonly url = process.env.FEISHU_WEBHOOK_URL ?? '',
    private readonly secret = process.env.FEISHU_WEBHOOK_SECRET ?? '',
  ) {}

  get configured(): boolean {
    return Boolean(this.url);
  }

  /** Feishu may be stricter than the global threshold; digests are exempt. */
  private get threshold(): number {
    const level = (process.env.FEISHU_MIN_IMPORTANCE ||
      process.env.PUSH_MIN_IMPORTANCE ||
      'warning') as Importance;
    return IMPORTANCE_RANK[level] ?? 1;
  }

  async push(message: MailMessage, result: TriageResult): Promise<PushOutcome> {
    const isDigest = Boolean(message.extra?.['digest']);
    // Feishu may be stricter than the global threshold; digests are exempt.
    // Compare the same effective rank the watcher used, so the spam bonus
    // cannot make the two disagree about one message.
    if (!isDigest && effectiveRank(message, result) < this.threshold) return 'declined';

    if ((process.env.DRY_RUN ?? '').toLowerCase() === 'true') {
      log.info(`[dry-run] Would send to Feishu | ${result.importance} | ${message.subject}`);
      return 'delivered';
    }
    if (!this.configured) return 'declined';

    const delivered = await deliverWithRetry(`Feishu | ${message.subject}`, this.retry, async () => {
      // Sign inside the attempt so a retry never reuses a stale timestamp.
      const payload = buildCard(message, result) as Record<string, unknown>;
      if (this.secret) {
        const timestamp = Math.floor(Date.now() / 1000);
        payload['timestamp'] = String(timestamp);
        payload['sign'] = sign(this.secret, timestamp);
      }
      try {
        const response = await fetch(this.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
          return { delivered: false, retryable: isRetryableStatus(response.status), detail: `HTTP ${response.status}` };
        }
        // Feishu may return HTTP 200 for business errors; inspect the response code.
        const data = (await response.json()) as { code?: number; msg?: string; StatusCode?: number };
        const code = data.code ?? data.StatusCode ?? 0;
        if (code !== 0) {
          return {
            delivered: false,
            retryable: code === FEISHU_RATE_LIMIT_CODE,
            detail: `code=${code} msg=${data.msg ?? ''}`,
          };
        }
        log.info(
          `Feishu delivered | ${result.importance} | ${message.subject}${message.inSpam ? ' (recovered from spam)' : ''}`,
        );
        return { delivered: true, retryable: false, detail: '' };
      } catch (error) {
        return { delivered: false, retryable: true, detail: String(error) };
      }
    });
    return delivered ? 'delivered' : 'failed';
  }
}
