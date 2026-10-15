/** Convert an IMAP envelope into a structured MailMessage without throwing. */
import { createHash } from 'node:crypto';
import type { MessageStructureObject } from 'imapflow';
import { simpleParser } from 'mailparser';

export const SNIPPET_CHARS = 400;
export const MAX_ATTACHMENT_MANIFEST_ITEMS = 100;

export interface AttachmentInfo {
  /** IMAP BODYSTRUCTURE part number used for an on-demand read. */
  partId: string;
  filename?: string;
  contentType: string;
  /** Reported MIME part size in bytes; the downloaded size can differ slightly. */
  sizeBytes?: number;
  transferEncoding?: string;
  inline: boolean;
  contentId?: string;
}

export interface AttachmentManifest {
  items: AttachmentInfo[];
  truncated: boolean;
}

export interface TextBodyPart {
  partId: string;
  contentType: 'text/plain' | 'text/html' | 'text/x-amp-html';
}

export interface MailMessage {
  account: string;
  accountLabel: string;
  provider: string;
  folder: string;
  inSpam: boolean;
  uid: number;
  messageId: string;
  /** Stable conversation key from In-Reply-To, or the message itself when absent. */
  threadKey?: string;
  subject: string;
  fromAddr: string;
  fromName: string;
  toAddrs: string[];
  date: string;
  body: string;
  hasAttachments: boolean;
  /** Lightweight MIME metadata only. File contents are fetched separately. */
  attachmentManifest?: AttachmentManifest;
  listUnsubscribe: boolean;
  /** Synthetic messages (digest and health alerts) use this to select rendering. */
  extra?: Record<string, unknown>;
}

const MIME_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
const BODY_TEXT_TYPES = new Set(['text/plain', 'text/html', 'text/x-amp-html']);

/**
 * Build a bounded, lightweight manifest from IMAP BODYSTRUCTURE.
 *
 * It includes ordinary attachments and inline MIME parts such as CID images,
 * while leaving the plain and HTML message bodies out of the download list.
 */
export function extractAttachmentManifest(
  structure: MessageStructureObject | undefined,
): AttachmentManifest {
  const items: AttachmentInfo[] = [];
  let truncated = false;

  const add = (node: MessageStructureObject, partId: string, inline: boolean): void => {
    if (!/^\d+(?:\.\d+)*$/.test(partId)) return;
    if (items.length >= MAX_ATTACHMENT_MANIFEST_ITEMS) {
      truncated = true;
      return;
    }
    const parameters = node.dispositionParameters ?? {};
    const name = parameters['filename'] ?? node.parameters?.['name'];
    const filename = typeof name === 'string' && name.trim() ? name.trim().slice(0, 512) : undefined;
    const rawType = node.type.trim().toLowerCase();
    const contentType = MIME_TYPE.test(rawType) ? rawType : 'application/octet-stream';
    const sizeBytes = typeof node.size === 'number' && Number.isFinite(node.size) && node.size >= 0
      ? node.size
      : undefined;
    const transferEncoding = node.encoding?.trim().toLowerCase().slice(0, 40) || undefined;
    const rawContentId = node.id?.trim().replace(/^<|>$/g, '').slice(0, 500);
    const contentId = rawContentId || undefined;
    items.push({
      partId,
      ...(filename ? { filename } : {}),
      contentType,
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      ...(transferEncoding ? { transferEncoding } : {}),
      inline,
      ...(contentId ? { contentId } : {}),
    });
  };

  const visit = (node: MessageStructureObject, fallbackPartId?: string): void => {
    if (truncated) return;
    const children = node.childNodes ?? [];
    const partId = node.part ?? fallbackPartId ?? (children.length ? undefined : '1');
    const type = node.type.trim().toLowerCase();
    const disposition = node.disposition?.trim().toLowerCase();
    const filename = node.dispositionParameters?.['filename'] ?? node.parameters?.['name'];
    const contentId = node.id?.trim();
    const inline = disposition === 'inline' || (disposition !== 'attachment' && Boolean(contentId));
    const isNamed = typeof filename === 'string' && filename.trim().length > 0;
    const isExplicitAttachment = disposition === 'attachment';

    // A named or explicitly attached multipart/message part is one downloadable
    // item. Do not expose its internal MIME children as separate files.
    if (partId && (isNamed || isExplicitAttachment || type === 'message/rfc822')) {
      add(node, partId, inline);
      return;
    }

    if (children.length) {
      for (let index = 0; index < children.length && !truncated; index += 1) {
        const child = children[index]!;
        const childPartId = child.part ?? (partId ? `${partId}.${index + 1}` : String(index + 1));
        visit(child, childPartId);
      }
      return;
    }

    const isBodyText = BODY_TEXT_TYPES.has(type) && !isExplicitAttachment;
    if (partId && !type.startsWith('multipart/') && !isBodyText) {
      add(node, partId, inline);
    }
  };

  if (structure) visit(structure);
  return { items, truncated };
}

/** Find a message's readable text body without descending into attached files. */
export function findTextBodyPart(structure: MessageStructureObject | undefined): TextBodyPart | undefined {
  if (!structure) return undefined;
  const candidates: TextBodyPart[] = [];

  const visit = (node: MessageStructureObject, fallbackPartId?: string): void => {
    const children = node.childNodes ?? [];
    const partId = node.part ?? fallbackPartId ?? (children.length ? undefined : '1');
    const type = node.type.trim().toLowerCase();
    const disposition = node.disposition?.trim().toLowerCase();
    const filename = node.dispositionParameters?.['filename'] ?? node.parameters?.['name'];

    // Text files can be attachments too; do not use their contents as the
    // message body. A forwarded message is another MIME tree, not this body's
    // text, so leave it alone as well.
    if (disposition === 'attachment'
      || (typeof filename === 'string' && filename.trim().length > 0)
      || type === 'message/rfc822') return;

    if (children.length) {
      children.forEach((child, index) => {
        const childPartId = child.part ?? (partId ? `${partId}.${index + 1}` : String(index + 1));
        visit(child, childPartId);
      });
      return;
    }

    if (!partId || !/^[0-9]+(?:\.[0-9]+)*$/.test(partId)) return;
    if (type === 'text/plain' || type === 'text/html' || type === 'text/x-amp-html') {
      candidates.push({ partId, contentType: type });
    }
  };

  visit(structure);
  return candidates.find((part) => part.contentType === 'text/plain')
    ?? candidates.find((part) => part.contentType === 'text/html')
    ?? candidates.find((part) => part.contentType === 'text/x-amp-html');
}

/** Phrases that identify a verification-code email without sending it to an LLM. */
export const SENSITIVE_LOCAL_KEYWORDS = [
  '验证码', '驗證碼', '动态密码', '動態密碼', '一次性密码', '一次性密碼',
  '身份验证码', '身份驗證碼', '安全码', '安全碼', '登录码', '登入碼',
  '校验码', '校驗碼', '认证码', '認證碼',
  'verification code', 'verify code', 'one-time password', 'one time password',
  'one-time code', 'one time code', 'authentication code', 'authorization code', 'auth code',
  'security code', 'sign-in code', 'sign in code', 'log-in code', 'log in code',
  'login code', 'passcode', 'confirmation code', 'code to sign in', 'code to log in',
  'code to verify', 'code for sign-in', 'code for login', 'otp',
] as const;

export function containsSensitiveVerificationContent(subject: string, body: string): boolean {
  const haystack = `${subject}\n${body}`.toLowerCase();
  return SENSITIVE_LOCAL_KEYWORDS.some((keyword) => haystack.includes(keyword.toLowerCase()));
}

/** Extract a code only when a nearby label identifies it as an authentication code. */
export function extractVerificationCode(subject: string, body: string): string | undefined {
  const text = `${subject}\n${body}`;
  if (!containsSensitiveVerificationContent(subject, body)) return undefined;

  const token = '([A-Z0-9]{4,12})';
  const patterns = [
    new RegExp(
      String.raw`^\s*${token}\s+is\s+your\b[^\n]{0,100}\b(?:verification|authentication|authorization)\s+code\b`,
      'i',
    ),
    new RegExp(
      String.raw`(?:verification|verify|confirmation|authentication|authorization|auth|security|login|log[ -]?in|sign[ -]?in|one[ -]?time(?:[ -]?password)?|passcode|otp)(?:\s+(?:code|password|passcode|number))?\s*(?:is\b\s*[:：=,，]?\s*|[:：=,，]\s*|(?:为|是)\s*[:：=]?\s*)${token}(?![A-Z0-9])`,
      'i',
    ),
    new RegExp(
      String.raw`(?:verification|verify|confirmation|authentication|authorization|auth|security|login|log[ -]?in|sign[ -]?in|one[ -]?time(?:[ -]?password)?|passcode|otp)(?:\s+(?:code|password|passcode|number))?\s+${token}(?![A-Z0-9])`,
      'i',
    ),
    new RegExp(String.raw`(?:your\s+)?(?:code|passcode|password)\s*(?:is\s+|[:：=]\s*)${token}(?![A-Z0-9])`, 'i'),
    new RegExp(
      String.raw`(?:验证码|驗證碼|动态密码|動態密碼|一次性密码|一次性密碼|身份验证码|身份驗證碼|安全码|安全碼|登录码|登入碼|校验码|校驗碼|认证码|認證碼)\s*(?:(?:为|是)\s*[:：=]?\s*|[:：=]\s*)?${token}(?![A-Z0-9])`,
      'i',
    ),
    new RegExp(String.raw`(?:verification[_ -]?code|verificationCode)\s*[=:：]\s*${token}(?![A-Z0-9])`, 'i'),
    new RegExp(
      String.raw`(?:code challenge|one-time code challenge|enter the code below|enter this code)[\s\S]{0,240}?\b([0-9]{4,12})\b`,
      'i',
    ),
    new RegExp(
      String.raw`(?:验证码|驗證碼|verification code|authorization code)[\s\S]{0,100}?\b([0-9]{4,12})\b`,
      'i',
    ),
    new RegExp(String.raw`\b(?:use|enter|type|input)\s+${token}\s+(?:to\s+)?(?:verify|authenticate|sign[ -]?in|log[ -]?in)\b`, 'i'),
    new RegExp(
      String.raw`\b(?:use|enter|type|input)\s+(?:this|the|following)\s+(?:code|passcode)\s+to\s+(?:verify|authenticate|sign[ -]?in|log[ -]?in)\s*[:：=]?\s*${token}(?![A-Z0-9])`,
      'i',
    ),
    new RegExp(
      String.raw`\b(?:use|enter|type|input)\s+(?:this|the|following)\s+(?:\d[ -]?digit\s+)?(?:verification\s+)?(?:code|passcode)\s+(?:to\s+(?:verify|authenticate|sign[ -]?in|log[ -]?in)\s*)?[:：=]\s*${token}(?![A-Z0-9])`,
      'i',
    ),
    new RegExp(
      String.raw`\b(?:sign[ -]?in|log[ -]?in|verify|authenticate)[^.!?\n]{0,50}\b(?:use|enter|type|input)\s+(?:this|the|following)\s+(?:\d[ -]?digit\s+)?(?:verification\s+)?(?:code|passcode)\s*[:：=]\s*${token}(?![A-Z0-9])`,
      'i',
    ),
  ];

  for (const pattern of patterns) {
    const candidate = pattern.exec(text)?.[1];
    // Requiring a digit avoids mistaking words such as "expires" for a code.
    if (candidate && /\d/.test(candidate)) return candidate;
  }
  return undefined;
}

export function isSensitiveVerificationMessage(message: Pick<MailMessage, 'subject' | 'body'>): boolean {
  return containsSensitiveVerificationContent(message.subject, message.body);
}

const HTML_TAG = /<[^>]+>/g;
const STYLE_BLOCK = /<(script|style)[^>]*>[\s\S]*?<\/\1>/gi;
const WHITESPACE = /\s+/g;

/**
 * Decode HTML entities.
 *
 * `&nbsp;` is common in mail HTML. Decoding it keeps LLM input smaller and readable.
 * Handle common named and numeric entities without adding an HTML parser.
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
      // Exclude surrogate and out-of-range code points.
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
  if (isSensitiveVerificationMessage(message)) return '验证码邮件（正文已隐藏）';
  return message.body.slice(0, SNIPPET_CHARS);
}

/** The same message in two accounts counts twice because the recipient differs. */
export function dedupKey(message: MailMessage): string {
  return `${message.account}|${message.messageId}`;
}

/**
 * Create a stable ID when Message-ID is missing.
 *
 * UID alone is insufficient: it is unique only within one UIDVALIDITY.
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
 * Extract the body from the original RFC822 message.
 *
 * Use MIME parsing rather than converting source directly to a string: the source
 * contains SMTP headers and MIME boundaries, and the body may use base64,
 * quoted-printable, or a non-UTF-8 charset.
 *
 * mailparser and ImapFlow share the nodemailer ecosystem and handle these details.
 */
export async function extractBody(source: Buffer | undefined): Promise<{ body: string; hasAttachments: boolean }> {
  if (!source) return { body: '', hasAttachments: false };
  try {
    const parsed = await simpleParser(source, { skipImageLinks: true });
    // Prefer plain text and fall back to HTML.
    const text = parsed.text?.trim() || (parsed.html ? htmlToText(parsed.html) : '');
    return {
      body: text.replace(/\s+/g, ' ').trim(),
      hasAttachments: (parsed.attachments?.length ?? 0) > 0,
    };
  } catch {
    // One malformed message must not stop the entire folder.
    return { body: '', hasAttachments: false };
  }
}
