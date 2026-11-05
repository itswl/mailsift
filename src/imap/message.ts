/** Convert an IMAP envelope into a structured MailMessage without throwing. */
import { createHash } from 'node:crypto';
import type { MessageStructureObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import { cleanBody, normalizeWhitespace } from './body.js';

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
  /** Metadata-only caution codes; these do not indicate that a file is malware. */
  safetyWarnings?: AttachmentSafetyWarningCode[];
}

export const ATTACHMENT_SAFETY_WARNING_CODES = [
  'executable_or_installer',
  'script_or_shortcut',
  'macro_enabled_document',
  'active_content',
  'archive_not_scanned',
] as const;
export type AttachmentSafetyWarningCode = (typeof ATTACHMENT_SAFETY_WARNING_CODES)[number];

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
const EXECUTABLE_EXTENSIONS = new Set([
  'app', 'apk', 'com', 'cpl', 'deb', 'dmg', 'dll', 'exe', 'jar', 'msi', 'msp', 'pkg', 'rpm', 'scr', 'sys',
]);
const EXECUTABLE_MIME_TYPES = new Set([
  'application/vnd.microsoft.portable-executable', 'application/x-dosexec', 'application/x-elf',
  'application/x-executable', 'application/x-mach-binary', 'application/x-msdownload',
  'application/x-msdos-program',
]);
const SCRIPT_EXTENSIONS = new Set([
  'bash', 'bat', 'cmd', 'command', 'hta', 'js', 'jse', 'lnk', 'ps1', 'psm1', 'sh', 'url', 'vbe', 'vbs',
  'wsf', 'wsh', 'zsh',
]);
const MACRO_EXTENSIONS = new Set(['docm', 'dotm', 'ppsm', 'pptm', 'potm', 'xlam', 'xlsm', 'xltm']);
const MACRO_MIME_TYPES = new Set([
  'application/vnd.ms-excel.addin.macroenabled.12',
  'application/vnd.ms-excel.sheet.macroenabled.12',
  'application/vnd.ms-powerpoint.presentation.macroenabled.12',
  'application/vnd.ms-powerpoint.slideshow.macroenabled.12',
  'application/vnd.ms-word.document.macroenabled.12',
]);
const ACTIVE_CONTENT_EXTENSIONS = new Set(['htm', 'html', 'mht', 'mhtml', 'svg', 'xhtml']);
const ACTIVE_CONTENT_MIME_TYPES = new Set(['application/xhtml+xml', 'image/svg+xml', 'text/html']);
const ARCHIVE_EXTENSIONS = new Set(['7z', 'bz2', 'gz', 'iso', 'img', 'rar', 'tar', 'tgz', 'xz', 'zip']);
const ARCHIVE_MIME_TYPES = new Set([
  'application/gzip', 'application/vnd.rar', 'application/x-7z-compressed', 'application/x-bzip2',
  'application/x-iso9660-image', 'application/x-rar-compressed', 'application/x-tar', 'application/zip',
]);

/** Identify file types that merit care without opening or scanning file contents. */
export function attachmentSafetyWarnings(
  attachment: { filename?: string | undefined; contentType: string },
): AttachmentSafetyWarningCode[] {
  const filename = attachment.filename?.trim().split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
  const extension = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1) : '';
  const contentType = attachment.contentType.trim().toLowerCase().split(';', 1)[0] ?? '';
  const warnings: AttachmentSafetyWarningCode[] = [];

  if (EXECUTABLE_EXTENSIONS.has(extension) || EXECUTABLE_MIME_TYPES.has(contentType)) {
    warnings.push('executable_or_installer');
  }
  if (SCRIPT_EXTENSIONS.has(extension)) warnings.push('script_or_shortcut');
  if (MACRO_EXTENSIONS.has(extension) || MACRO_MIME_TYPES.has(contentType)) {
    warnings.push('macro_enabled_document');
  }
  if (ACTIVE_CONTENT_EXTENSIONS.has(extension) || ACTIVE_CONTENT_MIME_TYPES.has(contentType)) {
    warnings.push('active_content');
  }
  if (ARCHIVE_EXTENSIONS.has(extension) || ARCHIVE_MIME_TYPES.has(contentType)) {
    warnings.push('archive_not_scanned');
  }

  return warnings;
}

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
    const safetyWarnings = attachmentSafetyWarnings({ filename, contentType });
    items.push({
      partId,
      ...(filename ? { filename } : {}),
      contentType,
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      ...(transferEncoding ? { transferEncoding } : {}),
      inline,
      ...(contentId ? { contentId } : {}),
      ...(safetyWarnings.length ? { safetyWarnings } : {}),
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

/**
 * Characters that make up an opaque run: base64 image data, tracking tokens,
 * and the like. A short keyword such as "otp" inside one of these is not a word.
 */
const OPAQUE_RUN = /[a-z0-9+/=_-]/i;

/**
 * Chinese keywords are matched as plain substrings; ASCII keywords must stand
 * on their own. Without the token check, a marketing mail whose inline image
 * data happens to contain "otp" is mistaken for a verification-code mail and
 * its body is hidden from the digest and the notification.
 */
function containsKeyword(haystack: string, keyword: string): boolean {
  const needle = keyword.toLowerCase();
  if (/[^\x00-\x7f]/.test(needle)) return haystack.includes(needle);

  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const before = at === 0 ? '' : haystack[at - 1]!;
    const after = haystack[at + needle.length] ?? '';
    if (!OPAQUE_RUN.test(before) && !OPAQUE_RUN.test(after)) return true;
  }
  return false;
}

/**
 * The summaries a verification-code message is stored with. They are set
 * here, never by the model, so they also mark such a row for the codes
 * filter: rows filed before the code itself was kept, and rows whose code
 * could not be extracted, carry them without a stored code.
 */
export const VERIFICATION_SUMMARY = '收到验证码邮件。';
export const VERIFICATION_SUMMARY_NO_CODE = '收到验证码邮件，但未能自动提取验证码。';
export const VERIFICATION_SUMMARY_PREFIX = '收到验证码邮件';
/** The summary a sign-in or password-reset link message is stored with. */
export const SIGN_IN_LINK_SUMMARY = '收到登录链接邮件。';
/** The same for a link nobody plainly asked for: one in bulk mail or a spam folder. */
export const UNASKED_LINK_SUMMARY = '收到登录链接邮件（如果不是你刚刚请求的，请勿打开）。';
export const UNASKED_LINK_REASON = '登录链接邮件内容已在本地隐藏；如果不是你刚刚请求的，请勿打开。';

/**
 * Sensitive mail comes in two kinds. A verification code is the message
 * itself; a sign-in or password-reset link carries a token that grants the
 * same access. Either is handled locally and kept out of the model, the
 * notification excerpt and the webhook.
 */
export type SensitiveKind = 'code' | 'link';

/** What stands in for a sensitive message's subject, summary and body wherever it is shown or sent. */
export const SENSITIVE_WORDS: Record<SensitiveKind, {
  subject: string; summary: string; hidden: string; snippet: string; reason: string;
}> = {
  code: {
    subject: '验证码邮件', summary: VERIFICATION_SUMMARY, hidden: '验证码邮件（内容已隐藏）',
    snippet: '验证码邮件（正文已隐藏）', reason: '验证码邮件内容已在本地隐藏。',
  },
  link: {
    subject: '登录链接邮件', summary: SIGN_IN_LINK_SUMMARY, hidden: '登录链接邮件（内容已隐藏）',
    snippet: '登录链接邮件（正文已隐藏）', reason: '登录链接邮件内容已在本地隐藏。',
  },
};

/**
 * Subject wording that announces a sign-in or password-reset link. Only the
 * subject is read: a body that merely mentions signing in is ordinary mail,
 * and a security alert about a new sign-in is not a link anyone should use.
 */
const SIGN_IN_LINK_SUBJECT = new RegExp([
  String.raw`\b(?:sign|log)[\s-]?in\s+link\b`,
  String.raw`\bmagic\s+link\b`,
  // "Reset your password", "Reset your Dropbox password", "Reset password instructions"
  String.raw`\breset\s+(?:your\s+)?(?:[\w'’-]+\s+){0,3}password\b`,
  String.raw`\bpassword\s+reset\b`,
  String.raw`\bforgot\s+(?:your\s+)?password\b`,
  // "Sign in to Medium", "Log in to Acme", "Login to Acme", "Sign into Acme": the whole message is the link.
  String.raw`^(?:sign|log)[\s-]?in\s*to\b`,
  '(?:重置|重设|重設|找回|忘记|忘記)(?:您的|你的)?(?:登录|登錄)?密[码碼]',
  '密[码碼](?:重置|重设|重設|找回)',
  '登[录錄入](?:链接|鏈接|連結)',
].join('|'), 'i');
/**
 * Forwarding prefixes and a sender's bracketed tag ("[Medium]", "【网易】"),
 * read past so "Fwd: [Medium] Sign in to Medium" still starts with its verb.
 * A tag with a slash is a repository thread and is kept for the check below.
 */
const SUBJECT_PREFIX = /^\s*(?:(?:fwd?|转发|轉發)\s*[:：]\s*|\[[^\]/]*\]\s*|【[^】]*】\s*)+/i;
/**
 * Subjects that talk about a reset without carrying one: replies, repository
 * notification threads ("[owner/repo] Fix password reset email"), and the
 * confirmation that a password was changed.
 */
const NOT_A_LINK_SUBJECT = new RegExp([
  String.raw`^\s*(?:re|aw|回复|答复|回覆)\s*[:：]`,
  String.raw`\[[\w.-]+\/[\w.-]+\]`,
  String.raw`\b(?:successful(?:ly)?|succeeded|(?:has|have) been (?:reset|changed|updated)|was (?:reset|changed|updated))\b`,
  '成功|已重置|已重设|已重設|已修改|已更改',
].join('|'), 'i');
const LINK = /https?:\/\/[^\s<>"'()[\]]+/g;
/** Query parameters a sign-in or reset token travels in. */
const TOKEN_PARAM = /^(?:t|key|code|otp|magic|ticket|auth|oobcode|nonce)$|token$/i;
/** Signature parameters count only on a sign-in path; elsewhere they sign storage and media links. */
const SIGNATURE_PARAM = /^(?:sig|signature)$/i;
/** Path segments right after which the token sits: /password_reset/<token>, /reset/<uid>/<token>. */
const TOKEN_PATH = /^(?:reset|password|passwords|password[-_]?resets?|reset[-_]?password|forgot[-_]?password|magic(?:[-_]?(?:link|login))?|email[-_]?login|login[-_]?links?|log[-_]?in|sign[-_]?in|verify|auth|callback|token|session|confirm|recover|recovery)$/i;
/** Code-host routes: a repository named "auth" or "login" followed by a commit hash is not a sign-in link. */
const CODE_ROUTE = /^(?:commit|commits|blob|tree|src|-|pull|pulls|merge_requests|issues|compare|releases|tags?)$/i;
/** Links that carry a token for something else: unsubscribing, mail preferences. */
const NOT_A_SIGN_IN_URL = /unsubscribe|opt-?out|preferences|email[-_]?settings/i;
/** Links are looked for near the top; a token link sits there in every such mail. */
const LINK_SCAN_CHARS = 20_000;

/** Random-looking: letters mixed with digits, or with capitals past the first letter. */
function scrambled(part: string): boolean {
  return /[A-Za-z]/.test(part) && (/\d/.test(part) || (/[a-z]/.test(part) && /[A-Z]/.test(part.slice(1))));
}

/**
 * A token rather than a word, an id or a slug: 16 or more characters once
 * '-' and '_' are set aside, random-looking (see scrambled). Base64url tokens
 * carry '-' and '_' themselves, and so do slugs ("Password-Reset-Flow",
 * "set-up-2fa-on-your-account"), so a value with separators needs one
 * random-looking stretch of 8 or more characters between them.
 */
function looksLikeToken(value: string): boolean {
  const compact = value.replace(/[-_]/g, '');
  if (compact.length < 16 || !scrambled(compact)) return false;
  return !/[-_]/.test(value) || value.split(/[-_]/).some((part) => part.length >= 8 && scrambled(part));
}

/**
 * The path and query inside a fragment, when the fragment is an app route or
 * carries parameters: "#/reset?token=…", "#!/login/…", "#recovery_token=…".
 * A plain anchor ("#Password_cracking") is a place on the page, not a path.
 */
function fragmentParts(hash: string): { path: string; query: string } {
  const text = hash.replace(/^#/, '');
  const route = /^!?\//.test(text);
  const mark = text.indexOf('?');
  if (route) {
    const path = text.replace(/^!?/, '');
    return mark >= 0 ? { path: path.slice(0, path.indexOf('?')), query: text.slice(mark + 1) } : { path, query: '' };
  }
  return text.includes('=') ? { path: '', query: text } : { path: '', query: '' };
}

/**
 * Whether a path, as segments, puts a token right after a sign-in word, or
 * after up to two short ids: Django's /reset/<uid>/<token>/, Drupal's
 * /user/reset/<uid>/<timestamp>/<hash>/login.
 */
function tokenInPath(segments: string[]): boolean {
  if (segments.some((segment) => CODE_ROUTE.test(segment))) return false;
  return segments.some((segment, index) => {
    if (!TOKEN_PATH.test(segment)) return false;
    for (const next of segments.slice(index + 1, index + 4)) {
      if (looksLikeToken(next)) return true;
      if (next.length >= 16) return false; // a long segment that is not a token ends the search
    }
    return false;
  });
}

/**
 * Whether a link carries a sign-in or reset token where such tokens are put:
 * a token parameter, the path segment after a sign-in word, or the same inside
 * the fragment of a single-page app. A link wrapped by a scanner or a click
 * tracker (Safe Links, SES) is unwrapped, twice at most.
 */
function hasSignInToken(raw: string, depth = 0): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (NOT_A_SIGN_IN_URL.test(url.pathname) || NOT_A_SIGN_IN_URL.test(url.hostname)) return false;
  const fragment = fragmentParts(url.hash);
  const segments = [...url.pathname.split('/'), ...fragment.path.split('/')].filter(Boolean).map(decodeSegment);
  const signInPath = segments.some((segment) => TOKEN_PATH.test(segment));
  const params = [...url.searchParams, ...new URLSearchParams(fragment.query)];
  for (const [name, value] of params) {
    if ((TOKEN_PARAM.test(name) || (signInPath && SIGNATURE_PARAM.test(name))) && looksLikeToken(value)) return true;
  }
  if (tokenInPath(segments)) return true;
  if (depth >= 2) return false;
  // A wrapped destination: a parameter value or a path segment that is itself a link.
  const inner = [...params.map(([, value]) => value), ...segments].filter((value) => /^https?:\/\//i.test(value));
  return inner.some((link) => hasSignInToken(link, depth + 1));
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function containsSignInLink(subject: string, body: string): boolean {
  const plain = subject.replace(SUBJECT_PREFIX, '');
  if (NOT_A_LINK_SUBJECT.test(plain) || !SIGN_IN_LINK_SUBJECT.test(plain)) return false;
  for (const link of body.slice(0, LINK_SCAN_CHARS).matchAll(LINK)) {
    if (hasSignInToken(link[0])) return true;
  }
  return false;
}

/** Which kind of sensitive mail this is, if any. A code wins when a message offers both. */
export function sensitiveKindOf(subject: string, body: string): SensitiveKind | undefined {
  if (containsSensitiveVerificationContent(subject, body)) return 'code';
  if (containsSignInLink(subject, body)) return 'link';
  return undefined;
}

/**
 * A code announced by a delivery phrase, with or without the words
 * "verification code": "Use the code below to complete your registration:
 * 083897". A colon or equals sign must introduce the code, and the candidate
 * must contain a digit, so "use code SAVE20" and prose are left alone.
 */
const ANNOUNCED_CODE_PATTERNS = [
  new RegExp(
    String.raw`\b(?:use|enter|type|input)\s+(?:this|the|following)\s+code(?:\s+(?:below|above))?[\s\S]{0,120}?[:：=]\s*([A-Z0-9]{4,12})(?![A-Z0-9])`,
    'i',
  ),
  new RegExp(String.raw`\b(?:the\s+)?code\s+(?:below|above)\s*[:：=]\s*([A-Z0-9]{4,12})(?![A-Z0-9])`, 'i'),
];

/**
 * Tracking ids live in links and image paths; only the visible sentence
 * carries the code. Strip them before looking for digits, so a 5-digit path
 * segment cannot outrank the real code.
 */
function withoutLinks(text: string): string {
  return text
    .replace(/\[https?:\/\/[^\]]*\]/gi, ' ')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/<[^<>\s]+@[^<>\s]+>/g, ' ');
}

export function containsSensitiveVerificationContent(subject: string, body: string): boolean {
  const text = `${subject}\n${body}`;
  const haystack = text.toLowerCase();
  if (SENSITIVE_LOCAL_KEYWORDS.some((keyword) => containsKeyword(haystack, keyword))) return true;
  // Some senders never write "verification code"; they announce the code with a
  // delivery phrase instead ("Use the code below to complete your registration:
  // 083897"). That is still a one-time code, so it must stay out of the model
  // and always be pushed.
  const visible = withoutLinks(text);
  return ANNOUNCED_CODE_PATTERNS.some((pattern) => {
    const candidate = pattern.exec(visible)?.[1];
    return Boolean(candidate && /\d/.test(candidate));
  });
}

/** Extract a code only when a nearby label identifies it as an authentication code. */
export function extractVerificationCode(subject: string, body: string): string | undefined {
  if (!containsSensitiveVerificationContent(subject, body)) return undefined;
  const text = withoutLinks(`${subject}\n${body}`);

  const token = '([A-Z0-9]{4,12})';
  const chineseLabel = '验证码|驗證碼|动态密码|動態密碼|一次性密码|一次性密碼|身份验证码|身份驗證碼|安全码|安全碼|登录码|登入碼|校验码|校驗碼|认证码|認證碼';
  const patterns = [
    // A code written before its label: "322435 是你的 Zoom 验证码". Senders that
    // put the code in the subject use this shape, and the label-first patterns
    // below then latched onto an unrelated number further down the body.
    new RegExp(
      String.raw`\b${token}\s*(?:是|为)\s*(?:你的|您的|你|您)?[^\n]{0,20}?(?:${chineseLabel})`,
      'i',
    ),
    // The same shape in English: "892391 is your X verification code". Unanchored,
    // so a forwarded header or a subject prefix does not hide the code.
    new RegExp(
      String.raw`\b${token}\s+is\s+your\b[^\n]{0,100}\b(?:verification|authentication|authorization|security|login|log[ -]?in|sign[ -]?in|one[ -]?time)[ -]?(?:code|password|passcode|pin)\b`,
      'i',
    ),
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
      String.raw`(?:${chineseLabel})\s*(?:(?:为|是)\s*[:：=]?\s*|[:：=]\s*)?${token}(?![A-Z0-9])`,
      'i',
    ),
    new RegExp(String.raw`(?:verification[_ -]?code|verificationCode)\s*[=:：]\s*${token}(?![A-Z0-9])`, 'i'),
    new RegExp(
      String.raw`(?:code challenge|one-time code challenge|enter the code below|enter this code)[\s\S]{0,240}?\b([0-9]{4,12})\b`,
      'i',
    ),
    new RegExp(
      // The broad fallback: a number near the label. A trailing date unit or
      // separator means the digits are a date ("2026年…", "2026-11-05"), not a code.
      String.raw`(?:${chineseLabel}|verification code|authorization code)[\s\S]{0,100}?\b([0-9]{4,12})\b(?![年月日/-])`,
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
    ...ANNOUNCED_CODE_PATTERNS,
  ];

  for (const pattern of patterns) {
    const candidate = pattern.exec(text)?.[1];
    // Requiring a digit avoids mistaking words such as "expires" for a code.
    if (candidate && /\d/.test(candidate)) return candidate;
  }
  return undefined;
}

export function isSensitiveVerificationMessage(message: Pick<MailMessage, 'subject' | 'body'>): boolean {
  return sensitiveKindOf(message.subject, message.body) !== undefined;
}

const HTML_TAG = /<[^>]+>/g;
const STYLE_BLOCK = /<(script|style)[^>]*>[\s\S]*?<\/\1>/gi;

/**
 * Block-level boundaries become line breaks before the tags are stripped.
 *
 * Quoted history is recognised by whole lines ("On ... wrote:", `>`, an Outlook
 * header block), and in HTML mail those sit in their own `<div>` or `<p>`. Without
 * this the entire message arrives as one line and none of them can be found.
 */
const HTML_BLOCK = /<\/?(?:div|p|br|tr|li|ul|ol|table|blockquote|h[1-6]|hr|pre|section|article|header|footer)\b[^>]*>/gi;

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

/**
 * HTML body to plain text, keeping the line structure quote detection needs.
 * Callers that want a single line collapse the result themselves.
 */
export function htmlToText(html: string): string {
  const withBreaks = html.replace(STYLE_BLOCK, ' ').replace(HTML_BLOCK, '\n').replace(HTML_TAG, ' ');
  return normalizeWhitespace(decodeEntities(withBreaks));
}

export function snippet(message: MailMessage): string {
  const kind = sensitiveKindOf(message.subject, message.body);
  if (kind) return SENSITIVE_WORDS[kind].snippet;
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
    // Clean while the line structure is still there, then store as one line as before.
    return {
      body: cleanBody(text).replace(/\s+/g, ' ').trim(),
      hasAttachments: (parsed.attachments?.length ?? 0) > 0,
    };
  } catch {
    // One malformed message must not stop the entire folder.
    return { body: '', hasAttachments: false };
  }
}
