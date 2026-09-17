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
