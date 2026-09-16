/**
 * 飞书机器人直推。
 *
 * 卡片要能独立看懂——用户手机上没有邮件客户端，不会去翻原文。
 * 所以顺序是：先说这封信讲了什么、要做什么，再是元信息，最后给跳转按钮。
 */
import { createHmac } from 'node:crypto';
import { IMPORTANCE_RANK, type Importance } from '../config.js';
import { buildLink } from '../links.js';
import { snippet, type MailMessage } from '../imap/message.js';
import { headline, rank, type TriageResult } from './triage.js';
import { getLogger } from '../logger.js';

const log = getLogger('feishu');

const TEMPLATE: Record<Importance, string> = { critical: 'red', warning: 'orange', info: 'blue' };
const PREFIX: Record<Importance, string> = { critical: '🔴', warning: '🟠', info: '🔵' };
const MAX_CARD_CHARS = 3000;

/** 卡片 markdown 里裸 < > 会被吞掉，发件人地址常带尖括号 */
function esc(text: string): string {
  return text.replace(/</g, '\\<').replace(/>/g, '\\>');
}

/** ISO 时间串在卡片上太难读，转成本地时区的 "09-16 14:32" */
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

  const spamTag = message.inSpam ? '【垃圾箱捞回】' : '';
  const title = `${PREFIX[result.importance] ?? ''} ${spamTag}${message.subject}`.slice(0, 200);

  const lines = [esc(headline(result))];
  if (result.deadline) lines.push(`\n⏰ **截止**　${esc(result.deadline)}`);
  lines.push(
    '',
    '---',
    `**发件人**　${esc(message.fromName || message.fromAddr)} \\<${esc(message.fromAddr)}\\>`,
    `**收件箱**　${message.accountLabel}　·　${message.folder}`,
    `**时间**　　${formatDate(message.date)}`,
    `**分类**　　${result.category}${result.actionRequired ? '　·　需要处理' : ''}`,
  );
  if (message.hasAttachments) lines.push('**附件**　　有');
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

/** 飞书签名：以 "{timestamp}\n{secret}" 为密钥对空串做 HMAC-SHA256 */
export function sign(secret: string, timestamp: number): string {
  return createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
}

export interface Sink {
  readonly configured: boolean;
  push(message: MailMessage, result: TriageResult): Promise<boolean>;
}

export class FeishuSink implements Sink {
  constructor(
    private readonly url = process.env.FEISHU_WEBHOOK_URL ?? '',
    private readonly secret = process.env.FEISHU_WEBHOOK_SECRET ?? '',
  ) {}

  get configured(): boolean {
    return Boolean(this.url);
  }

  /** 飞书阈值只能比全局更严，简报不受此限 */
  private get threshold(): number {
    const level = (process.env.FEISHU_MIN_IMPORTANCE ||
      process.env.PUSH_MIN_IMPORTANCE ||
      'warning') as Importance;
    return IMPORTANCE_RANK[level] ?? 1;
  }

  async push(message: MailMessage, result: TriageResult): Promise<boolean> {
    const isDigest = Boolean(message.extra?.['digest']);
    if (!isDigest && rank(result) < this.threshold) return true;

    const payload = buildCard(message, result) as Record<string, unknown>;
    if (this.secret) {
      const timestamp = Math.floor(Date.now() / 1000);
      payload['timestamp'] = String(timestamp);
      payload['sign'] = sign(this.secret, timestamp);
    }

    if ((process.env.DRY_RUN ?? '').toLowerCase() === 'true') {
      log.info(`[dry-run] 本应发飞书 | ${result.importance} | ${message.subject}`);
      return true;
    }
    if (!this.configured) return false;

    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        log.error(`飞书推送失败 | HTTP ${response.status} | ${message.subject}`);
        return false;
      }
      // 飞书对业务错误也返回 HTTP 200，必须看 body 里的 code
      const data = (await response.json()) as { code?: number; msg?: string; StatusCode?: number };
      const code = data.code ?? data.StatusCode ?? 0;
      if (code !== 0) {
        log.error(`飞书拒绝 | code=${code} msg=${data.msg ?? ''}`);
        return false;
      }
      log.info(
        `飞书已送达 | ${result.importance} | ${message.subject}${message.inSpam ? '（垃圾箱捞回）' : ''}`,
      );
      return true;
    } catch (error) {
      log.error(`飞书推送失败 | ${message.subject} | ${error}`);
      return false;
    }
  }
}
