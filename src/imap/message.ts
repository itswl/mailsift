/** IMAP 抓到的原始信封 -> 结构化 MailMessage。解析全程不抛异常。 */
import { createHash } from 'node:crypto';
import { simpleParser } from 'mailparser';

export const SNIPPET_CHARS = 400;

export interface MailMessage {
  account: string;
  accountLabel: string;
  provider: string;
  folder: string;
  inSpam: boolean;
  uid: number;
  messageId: string;
  subject: string;
  fromAddr: string;
  fromName: string;
  toAddrs: string[];
  date: string;
  body: string;
  hasAttachments: boolean;
  listUnsubscribe: boolean;
  /** 合成消息（简报、健康告警）用它标记渲染方式 */
  extra?: Record<string, unknown>;
}

const HTML_TAG = /<[^>]+>/g;
const STYLE_BLOCK = /<(script|style)[^>]*>[\s\S]*?<\/\1>/gi;
const WHITESPACE = /\s+/g;

/**
 * HTML 实体 -> 字符。
 *
 * 邮件 HTML 里 `&nbsp;` 极其常见（招行这类账单模板靠它排版），
 * 不解码的话会大量进正文，既占 LLM token 又让模型读到乱码。
 * 只处理常见命名实体 + 数字实体，不引 HTML 解析库。
 */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'",
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—', ndash: '–',
  middot: '·', bull: '·', copy: '©', reg: '®', trade: '™', yen: '¥', euro: '€', pound: '£',
};
const ENTITY = /&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi;

export function decodeEntities(text: string): string {
  return text.replace(ENTITY, (match, body: string) => {
    const key = body.toLowerCase();
    if (key.startsWith('#')) {
      const code = key.startsWith('#x') ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      // 排除代理区和越界码点，String.fromCodePoint 会对它们抛异常
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) {
        return String.fromCodePoint(code);
      }
      return match;
    }
    return NAMED_ENTITIES[key] ?? match;
  });
}

export function htmlToText(html: string): string {
  return decodeEntities(html.replace(STYLE_BLOCK, ' ').replace(HTML_TAG, ' '))
    .replace(WHITESPACE, ' ')
    .trim();
}

export function snippet(message: MailMessage): string {
  return message.body.slice(0, SNIPPET_CHARS);
}

/** 同一封信发到两个邮箱各算一条——收件人不同，处理动作也不同。 */
export function dedupKey(message: MailMessage): string {
  return `${message.account}|${message.messageId}`;
}

/**
 * 没有 Message-ID 时造一个稳定 ID。
 *
 * 不能只用 uid：UID 只在同一个 UIDVALIDITY 里唯一，邮箱重建后会撞。
 */
export function fallbackMessageId(
  account: string,
  parts: { date?: string; subject?: string; from?: string; uid: number },
): string {
  const raw = [account, parts.date ?? '', parts.subject ?? '', parts.from ?? '', parts.uid].join('|');
  return `<generated-${createHash('sha256').update(raw).digest('hex').slice(0, 32)}@mailsift>`;
}

export function normalizeDate(value: Date | string | undefined): string {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

/**
 * 从 RFC822 原文里取出正文。
 *
 * 必须走 MIME 解析而不是直接把 source 转字符串——原文里混着 SMTP 头、
 * MIME 分隔符，正文本身还可能是 base64 / quoted-printable 编码、
 * GB2312 之类的非 UTF-8 字符集。直接 toString 得到的是邮件头，
 * 模型会以为"正文没有内容"。
 *
 * mailparser 是 ImapFlow 的同门（都出自 nodemailer），这些都替我们处理了。
 */
export async function extractBody(source: Buffer | undefined): Promise<{ body: string; hasAttachments: boolean }> {
  if (!source) return { body: '', hasAttachments: false };
  try {
    const parsed = await simpleParser(source, { skipImageLinks: true });
    // 优先纯文本，没有才降级 HTML
    const text = parsed.text?.trim() || (parsed.html ? htmlToText(parsed.html) : '');
    return {
      body: text.replace(/\s+/g, ' ').trim(),
      hasAttachments: (parsed.attachments?.length ?? 0) > 0,
    };
  } catch {
    // 单封畸形邮件不该中断整个文件夹
    return { body: '', hasAttachments: false };
  }
}
