/**
 * A message as a person reads it, parsed from its RFC822 source.
 *
 * Triage wants one bounded line of text; a reader wants the message: the HTML
 * the sender laid out, the plain text with its paragraphs, who it went to, and
 * whether the mailbox's own server vouches for the sender. This module turns
 * the raw source into that, in memory, for the duration of one request.
 *
 * Nothing here is trusted and nothing here is made safe. The HTML is the
 * sender's markup as it arrived; the browser sanitizes it and renders it in a
 * sandboxed frame under its own content policy. What this module does bound is
 * size, so one message cannot turn into an unbounded response.
 *
 * It verifies no signature itself. The authentication verdict is what the
 * mailbox's own server wrote into Authentication-Results, and only that: a
 * sender can put the same header into a message, so one is believed only when
 * it names the server this account reads its mail from.
 */
import { simpleParser, type AddressObject, type EmailAddress, type ParsedMail } from 'mailparser';
import { findQuoteStart, normalizeWhitespace } from './body.js';
import { htmlToText } from './message.js';

export interface ReadableAddress { name: string; address: string }

export interface ReadableAuth {
  /** What the mailbox's own server reported in Authentication-Results; mailsift verifies nothing itself. */
  result: 'pass' | 'fail' | 'none';
  dkim: string | null;
  spf: string | null;
  dmarc: string | null;
  /**
   * DKIM d= domain (or the domain of header.i) of a passing signature: the one
   * that speaks for the From domain when there is one. null for a sender
   * verified without such a signature.
   */
  signedBy: string | null;
}

export interface ReadableMessage {
  /**
   * Raw HTML part, cid: images inlined as data URIs. Untrusted: the browser
   * sanitizes and sandboxes it. null when there is none or it is over the limit.
   */
  html: string | null;
  htmlOmitted: boolean;
  /** Plain text above any quoted history, line structure kept. */
  text: string;
  /** The quoted history below it, '' when none. */
  quoted: string;
  truncated: boolean;
  from: ReadableAddress | null;
  to: ReadableAddress[];
  cc: ReadableAddress[];
  replyTo: ReadableAddress[];
  subject: string;
  /** ISO 8601, or null when the message carries no usable Date. */
  date: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  auth: ReadableAuth;
  /** First https URL in List-Unsubscribe, validated with new URL(); never fetched. */
  unsubscribe: string | null;
  inlineImages: number;
}

/**
 * Markup above this is not sent to the browser at all. Ordinary mail is well
 * under 200 KB; past this size it is a document someone exported, and the
 * plain text reads better than a frame that takes seconds to lay out.
 */
export const MAX_HTML_BYTES = 600 * 1024;
/** Text and quoted history together. A reader scrolls; a response must still end. */
export const MAX_TEXT_CHARS = 100_000;
/** One inline image. Logos and signatures fit; a pasted photo stays an attachment. */
export const MAX_INLINE_IMAGE_BYTES = 1024 * 1024;
/** Every inlined use together, counted per reference so one image repeated cannot multiply the response. */
export const MAX_INLINE_TOTAL_BYTES = 4 * 1024 * 1024;
/**
 * Raster formats only. An SVG is a document that can carry script and remote
 * references, and nothing else here is an image a browser draws.
 */
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Recipients and references are shown, not processed; a list of thousands is cut. */
const MAX_ADDRESSES = 50;
const MAX_REFERENCES = 50;
const MAX_URL_CHARS = 2048;

function emptyAuth(): ReadableAuth {
  return { result: 'none', dkim: null, spf: null, dmarc: null, signedBy: null };
}

function emptyReadable(): ReadableMessage {
  return {
    html: null, htmlOmitted: false, text: '', quoted: '', truncated: false,
    from: null, to: [], cc: [], replyTo: [], subject: '', date: null,
    messageId: null, inReplyTo: null, references: [],
    auth: emptyAuth(), unsubscribe: null, inlineImages: 0,
  };
}

/** Flatten address headers, groups included, to the mailboxes they name. */
function addresses(input: AddressObject | AddressObject[] | undefined): ReadableAddress[] {
  const out: ReadableAddress[] = [];
  const visit = (entry: EmailAddress): void => {
    if (out.length >= MAX_ADDRESSES) return;
    if (entry.group) {
      for (const member of entry.group) visit(member);
      return;
    }
    const address = (entry.address ?? '').trim().toLowerCase();
    if (address) out.push({ name: (entry.name ?? '').trim(), address });
  };
  for (const object of Array.isArray(input) ? input : input ? [input] : []) {
    for (const entry of object.value ?? []) visit(entry);
  }
  return out;
}

function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1).trim().replace(/\.$/, '').toLowerCase();
}

/**
 * Relaxed alignment without a public-suffix list: the same domain, or one a
 * subdomain of the other. `mail.github.com` signing for `github.com` aligns;
 * `github.com.evil.example` does not, because the match is on whole labels
 * from the right.
 */
function aligned(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/** A header as one line, without its name. */
function headerValue(line: string): string {
  return line.replace(/\r?\n[ \t]+/g, ' ').replace(/^[^:]*:/, '').trim();
}

/** Remove RFC 5322 comments, nested ones included: they are prose and can spell out any result. */
function stripComments(value: string): string {
  let out = value;
  for (let pass = 0; pass < 8; pass += 1) {
    const next = out.replace(/\([^()]*\)/g, ' ');
    if (next === out) break;
    out = next;
  }
  return out;
}

const DKIM_FAILED = new Set(['fail', 'permerror', 'policy']);
const SPF_FAILED = new Set(['fail', 'softfail']);

/**
 * How to recognise the header the mailbox's own server wrote.
 *
 * Anyone can put an Authentication-Results header into a message. A receiving
 * server adds its own above it and names itself there (the authserv-id), so a
 * header is a verdict only when that name is the one this mailbox's provider
 * uses. Microsoft is the exception that writes no name at all.
 */
export interface AuthservTrust {
  /** The authserv-id. */
  id?: string;
  /** Names under `id` count as well: a provider whose receiving hosts each use their own. */
  subdomains?: boolean;
  /** The provider writes one header per check, each under a name of its own, rather than one for all. */
  perCheck?: boolean;
  /** The provider writes its header without an authserv-id. */
  bare?: boolean;
}

/**
 * Providers whose header is known, by the host the account reads mail from.
 * A provider missing here is not distrusted, only unknown: its mail shows no
 * verdict until MAIL_ACCOUNT_N_AUTHSERV_ID says what its server calls itself.
 */
const KNOWN_AUTHSERV: Array<{ host: RegExp; trust: AuthservTrust }> = [
  { host: /(^|\.)(gmail|googlemail)\.com$/, trust: { id: 'mx.google.com' } },
  { host: /(^|\.)(office365|outlook|hotmail|live)\.com$/, trust: { bare: true } },
  { host: /(^|\.)yahoo\.com$/, trust: { id: 'yahoo.com', subdomains: true } },
  { host: /(^|\.)(me|icloud)\.com$/, trust: { id: 'icloud.com', subdomains: true, perCheck: true } },
  { host: /(^|\.)(fastmail|messagingengine)\.com$/, trust: { id: 'messagingengine.com', subdomains: true } },
];

/**
 * The header to believe for a mailbox read from `imapHost`.
 *
 * `configured` is MAIL_ACCOUNT_N_AUTHSERV_ID: a server name for a provider
 * not listed above, or `none` to show no verdict for this mailbox at all.
 */
export function authservTrust(imapHost: string, configured?: string): AuthservTrust | undefined {
  const named = configured?.trim().toLowerCase().replace(/\.$/, '');
  if (named) return named === 'none' || !/^[a-z0-9.-]+$/.test(named) ? undefined : { id: named, subdomains: true };
  const host = imapHost.trim().toLowerCase();
  return KNOWN_AUTHSERV.find((known) => known.host.test(host))?.trust;
}

/**
 * One header cut into its statements, with nothing left in that a sender
 * could have phrased.
 *
 * A server quotes what it copies from the message (an odd local part, a HELO
 * name) and comments on its results in prose. Either can contain a semicolon
 * and the words "dkim=pass". Quoted strings are emptied first and comments
 * removed after, so text can only ever be lost here, never promoted into a
 * statement of its own. An unterminated quote empties the rest of the line.
 */
function statements(header: string): string[] {
  const unquoted = headerValue(header).replace(/"(?:[^"\\]|\\.)*"?/g, '""');
  return stripComments(unquoted).split(';');
}

/** The authserv-id a header names; '' when it starts straight into its results. */
function authservId(header: string): string {
  const first = statements(header)[0]!.trim();
  if (first === '' || first.includes('=')) return '';
  // "example.com 1": an optional version follows the name.
  return first.split(/\s+/, 1)[0]!.replace(/\.$/, '').toLowerCase();
}

function writtenByMailbox(id: string, trust: AuthservTrust): boolean {
  if (id === '') return trust.bare === true;
  if (trust.id === undefined) return false;
  return id === trust.id || (trust.subdomains === true && id.endsWith(`.${trust.id}`));
}

/**
 * The header, or headers, the mailbox's own server wrote, from the ones a
 * message carries.
 *
 * Headers are prepended as a message travels, so the server's own is the
 * first, and only the first is believed. A second one under the same name
 * further down is exactly what a sender would add, to supply the "dkim=pass"
 * the real one did not mention; a conforming server strips those, but this
 * does not depend on it.
 *
 * The exception is a provider that writes one header per check, each under
 * its own name. There the run continues while the names are the provider's
 * and new, and stops at the first that repeats.
 */
export function mailboxAuthHeaders(headers: string[], trust: AuthservTrust | undefined): string[] {
  if (!trust) return [];
  const own: string[] = [];
  const heard = new Set<string>();
  for (const header of headers) {
    const id = authservId(header);
    if (!writtenByMailbox(id, trust)) break;
    if (own.length > 0 && (!trust.perCheck || heard.has(id))) break;
    own.push(header);
    heard.add(id);
  }
  return own;
}

/**
 * Read a server's verdict from its Authentication-Results header or headers.
 *
 * This reads what it is given. Whether a header deserves belief is decided
 * before it gets here, by `mailboxAuthHeaders`. Given several, the first
 * header to speak on a check is the only one heard on it.
 *
 * The server's own DMARC result decides when there is one, either way: it
 * knows the domain's policy and where the organisation ends, and this does
 * not. Without one, a passing signature counts only when it was made by the
 * From domain itself or by a domain above it. A signature from a subdomain
 * says nothing about its parent: anyone can own a name under a shared one.
 */
export function parseAuthenticationResults(header: string | string[] | undefined, fromAddress: string): ReadableAuth {
  const headers = (Array.isArray(header) ? header : header ? [header] : []).filter(Boolean);
  if (headers.length === 0) return emptyAuth();
  const fromDomain = domainOf(fromAddress);
  const signatures: Array<{ result: string; domain: string }> = [];
  let spf: string | null = null;
  let dmarc: string | null = null;

  // A check an earlier header has spoken on is closed: a later header cannot
  // add a passing signature to a message whose signature the first one failed.
  const closed = new Set<string>();
  for (const line of headers) {
    const spoken = new Set<string>();
    for (const part of statements(line)) {
      const match = /^\s*(dkim|spf|dmarc)\s*=\s*([a-z]+)/i.exec(part);
      if (!match) continue;
      const method = match[1]!.toLowerCase();
      const result = match[2]!.toLowerCase();
      if (closed.has(method)) continue;
      spoken.add(method);
      if (method === 'spf') spf ??= result;
      else if (method === 'dmarc') dmarc ??= result;
      else {
        const d = /\bheader\.d\s*=\s*([^\s;]+)/i.exec(part)?.[1];
        const i = /\bheader\.i\s*=\s*([^\s;]+)/i.exec(part)?.[1];
        const domain = (d ?? (i ? i.slice(i.lastIndexOf('@') + 1) : '')).replace(/^["'<]+|["'>.]+$/g, '').toLowerCase();
        signatures.push({ result, domain });
      }
    }
    for (const method of spoken) closed.add(method);
  }

  const passing = signatures.filter((signature) => signature.result === 'pass');
  const dkim = passing.length ? 'pass' : signatures[0]?.result ?? null;
  // Made by the From domain or one above it: enough on its own.
  const own = fromDomain
    ? passing.find((signature) => signature.domain === fromDomain || fromDomain.endsWith(`.${signature.domain}`))
    : undefined;
  // Related in either direction: worth naming, not worth believing alone.
  const related = passing.find((signature) => aligned(signature.domain, fromDomain));

  let result: ReadableAuth['result'] = 'none';
  if (dmarc === 'pass') result = 'pass';
  else if (dmarc === 'fail') result = 'fail';
  else if (own) result = 'pass';
  else if (!passing.length && signatures.some((s) => DKIM_FAILED.has(s.result)) && spf !== null && SPF_FAILED.has(spf)) {
    result = 'fail';
  }
  // For a verified sender, the signature that speaks for it, when there is
  // one (DMARC can also pass on SPF alone). Otherwise whichever passed, which
  // is still who vouched for the message in transit.
  const named = own ?? related ?? (result === 'pass' ? undefined : passing.find((signature) => signature.domain));
  return { result, dkim, spf, dmarc, signedBy: named?.domain || null };
}

/**
 * The https target of List-Unsubscribe, when there is one.
 *
 * A mailto: target would have this service send mail, and a plain http one
 * would put the reader's choice on the wire in clear, so neither is offered.
 * The URL is validated and handed to the page as a link; nothing requests it.
 */
export function unsubscribeUrl(header: string | undefined): string | null {
  if (!header) return null;
  for (const match of headerValue(header).matchAll(/<([^<>]+)>/g)) {
    const candidate = match[1]!.replace(/\s+/g, '');
    if (candidate.length > MAX_URL_CHARS || !/^https:/i.test(candidate)) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' && url.hostname && !url.username && !url.password) return url.href;
    } catch {
      // Not a URL; a later entry may be.
    }
  }
  return null;
}

/**
 * Put related images into the markup they belong to.
 *
 * A `cid:` reference names another part of the same message, which a browser
 * cannot fetch. Each reference is looked up as a whole token, so an id that is
 * a prefix of another can never be substituted into the longer one. Anything
 * that is not a small raster image, or that would take the response past its
 * budget, is left as it was and simply does not load.
 */
export function inlineCidImages(html: string, parsed: Pick<ParsedMail, 'attachments'>): { html: string; inlined: number } {
  const images = new Map<string, { type: string; content: Buffer }>();
  for (const part of parsed.attachments ?? []) {
    const id = String(part.cid ?? part.contentId ?? '').replace(/^<|>$/g, '').trim();
    const type = String(part.contentType ?? '').toLowerCase().split(';', 1)[0]!.trim();
    if (!id || !INLINE_IMAGE_TYPES.has(type) || !Buffer.isBuffer(part.content)) continue;
    if (part.content.length === 0 || part.content.length > MAX_INLINE_IMAGE_BYTES) continue;
    if (!images.has(id.toLowerCase())) images.set(id.toLowerCase(), { type, content: part.content });
  }
  if (images.size === 0) return { html, inlined: 0 };

  let spent = 0;
  const used = new Set<string>();
  const encoded = new Map<string, string>();
  const out = html.replace(/cid:([^"'\s<>()]+)/gi, (whole, raw: string) => {
    // Some clients percent-encode the @ of a content id inside an attribute.
    let key = raw.replace(/&amp;/gi, '&').toLowerCase();
    if (!images.has(key)) {
      try { key = decodeURIComponent(key); } catch { /* keep the raw form */ }
    }
    const image = images.get(key);
    if (!image) return whole;
    if (spent + image.content.length > MAX_INLINE_TOTAL_BYTES) return whole;
    spent += image.content.length;
    used.add(key);
    let uri = encoded.get(key);
    if (!uri) {
      uri = `data:${image.type};base64,${image.content.toString('base64')}`;
      encoded.set(key, uri);
    }
    return uri;
  });
  return { html: out, inlined: used.size };
}

/**
 * Split a body where the quoted history begins.
 *
 * The same markers triage uses to stop reading: an "On ... wrote:" line, an
 * "Original Message" rule, an Outlook header block. A reader gets the part
 * above first and can unfold the rest. When nothing would be left above, the
 * message is its quote, and it is all shown.
 */
export function splitQuoted(text: string): { text: string; quoted: string } {
  const lines = text.split('\n');
  const start = findQuoteStart(lines);
  if (start <= 0) return { text, quoted: '' };
  const above = lines.slice(0, start).join('\n').trim();
  if (above === '') return { text, quoted: '' };
  return { text: above, quoted: lines.slice(start).join('\n').trim() };
}

/** Headers that describe the original body, which the slim message replaces. */
const BODY_HEADERS = new Set(['content-type', 'content-transfer-encoding', 'content-disposition', 'content-length', 'mime-version']);

const base64Lines = (content: Buffer): string => (content.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');

/**
 * A message too large to fetch whole, rebuilt as a small one that reads the same.
 *
 * A message with a 20 MB attachment is still a few lines of text to its
 * reader. Its own headers are kept as they are (who sent it, the thread it
 * belongs to, what the receiving server said about the sender), and its body
 * becomes just the text and the markup, which the caller has fetched as
 * separate parts, already decoded to UTF-8. The attachments are not in it;
 * they are listed and downloaded on their own.
 */
export function slimSource(headers: Buffer, parts: { plain?: Buffer; html?: Buffer }): Buffer {
  // A header is its first line and the indented lines that continue it.
  const kept: string[] = [];
  let keeping = false;
  for (const line of headers.toString('latin1').split(/\r?\n/)) {
    if (line === '') break;
    if (!/^[ \t]/.test(line)) {
      const name = /^([^:\s]+)\s*:/.exec(line)?.[1]?.toLowerCase();
      keeping = name !== undefined && !BODY_HEADERS.has(name);
    }
    if (keeping) kept.push(line);
  }
  const boundary = `mailsift-slim-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const part = (type: string, content: Buffer): string =>
    `--${boundary}\r\nContent-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(content)}\r\n`;
  const body = [
    part('text/plain', parts.plain ?? Buffer.alloc(0)),
    ...(parts.html ? [part('text/html', parts.html)] : []),
    `--${boundary}--\r\n`,
  ].join('');
  const head = [...kept, 'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`].join('\r\n');
  return Buffer.from(`${head}\r\n\r\n${body}`, 'latin1');
}

function isoDate(value: Date | undefined): string | null {
  return value instanceof Date && !Number.isNaN(value.valueOf()) ? value.toISOString() : null;
}

/**
 * Parse one message source into what the reading view shows.
 *
 * Never throws: mail is malformed in every way there is, and a message that
 * cannot be parsed is answered with empty fields rather than a failed request.
 */
export async function parseReadable(source: Buffer, options: { authserv?: AuthservTrust } = {}): Promise<ReadableMessage> {
  const readable = emptyReadable();
  if (!Buffer.isBuffer(source) || source.length === 0) return readable;

  let parsed: ParsedMail;
  try {
    // cid: links are resolved here, under a budget, rather than by the parser,
    // which would inline every related part whatever its size.
    parsed = await simpleParser(source, { skipImageLinks: true });
  } catch {
    return readable;
  }

  try {
    const from = addresses(parsed.from)[0] ?? null;
    readable.from = from;
    readable.to = addresses(parsed.to);
    readable.cc = addresses(parsed.cc);
    readable.replyTo = addresses(parsed.replyTo);
    readable.subject = (parsed.subject ?? '').trim();
    readable.date = isoDate(parsed.date);
    readable.messageId = parsed.messageId?.trim() || null;
    readable.inReplyTo = parsed.inReplyTo?.trim() || null;
    const references = parsed.references;
    readable.references = (Array.isArray(references) ? references : references ? [references] : [])
      .map((reference) => String(reference).trim()).filter(Boolean).slice(0, MAX_REFERENCES);

    const lines = parsed.headerLines ?? [];
    const authHeaders = lines.filter((header) => header.key === 'authentication-results').map((header) => header.line);
    readable.auth = parseAuthenticationResults(mailboxAuthHeaders(authHeaders, options.authserv), from?.address ?? '');
    readable.unsubscribe = unsubscribeUrl(lines.find((header) => header.key === 'list-unsubscribe')?.line);

    const html = typeof parsed.html === 'string' && parsed.html.trim() !== '' ? parsed.html : null;
    if (html !== null) {
      if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) readable.htmlOmitted = true;
      else {
        const inlined = inlineCidImages(html, parsed);
        readable.html = inlined.html;
        readable.inlineImages = inlined.inlined;
      }
    }

    // The sender's own text part when there is one; otherwise the markup read
    // as text, so a message that is only HTML still has words when the frame
    // is not wanted, or when the markup was too large to send.
    const plain = parsed.text?.trim() ? parsed.text : html !== null ? htmlToText(html) : '';
    const split = splitQuoted(normalizeWhitespace(plain));
    if (split.text.length > MAX_TEXT_CHARS) {
      readable.text = split.text.slice(0, MAX_TEXT_CHARS);
      readable.truncated = true;
    } else {
      readable.text = split.text;
      const room = MAX_TEXT_CHARS - split.text.length;
      readable.quoted = split.quoted.slice(0, room);
      if (split.quoted.length > room) readable.truncated = true;
    }
  } catch {
    // A header shaped in a way the parser's own types do not promise. What was
    // read so far is still true; return it.
  }
  return readable;
}
