/** Convert an IMAP envelope into a structured MailMessage without throwing. */
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
  /** Stable conversation key from In-Reply-To, or the message itself when absent. */
  threadKey?: string;
  subject: string;
  fromAddr: string;
  fromName: string;
  toAddrs: string[];
  date: string;
  body: string;
  hasAttachments: boolean;
  listUnsubscribe: boolean;
  /** Synthetic messages (digest and health alerts) use this to select rendering. */
  extra?: Record<string, unknown>;
}

/** Phrases that identify a verification-code email without sending it to an LLM. */
export const SENSITIVE_LOCAL_KEYWORDS = [
  '验证码', '驗證碼', '动态密码', '動態密碼', '一次性密码', '一次性密碼',
  '身份验证码', '身份驗證碼', '安全码', '安全碼', '登录码', '登入碼',
  '校验码', '校驗碼', '认证码', '認證碼',
  'verification code', 'verify code', 'one-time password', 'one time password',
  'one-time code', 'one time code', 'authentication code', 'auth code',
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
      String.raw`(?:verification|verify|confirmation|authentication|auth|security|login|log[ -]?in|sign[ -]?in|one[ -]?time(?:[ -]?password)?|passcode|otp)(?:\s+(?:code|password|passcode|number))?\s*(?:is\b\s*[:：=]?\s*|[:：=]\s*|(?:为|是)\s*[:：=]?\s*)${token}(?![A-Z0-9])`,
      'i',
    ),
    new RegExp(
      String.raw`(?:verification|verify|confirmation|authentication|auth|security|login|log[ -]?in|sign[ -]?in|one[ -]?time(?:[ -]?password)?|passcode|otp)(?:\s+(?:code|password|passcode|number))?\s+${token}(?![A-Z0-9])`,
      'i',
    ),
    new RegExp(String.raw`(?:your\s+)?(?:code|passcode|password)\s*(?:is\s+|[:：=]\s*)${token}(?![A-Z0-9])`, 'i'),
    new RegExp(
      String.raw`(?:验证码|驗證碼|动态密码|動態密碼|一次性密码|一次性密碼|身份验证码|身份驗證碼|安全码|安全碼|登录码|登入碼|校验码|校驗碼|认证码|認證碼)\s*(?:(?:为|是)\s*[:：=]?\s*|[:：=]\s*)?${token}(?![A-Z0-9])`,
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
