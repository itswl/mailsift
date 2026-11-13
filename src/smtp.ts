/**
 * Writing mail: sending and replying over SMTP.
 *
 * Everything else in mailsift reads. This is the first thing that writes to
 * the outside world on the owner's behalf: a message leaves under their name,
 * reaches other people, and cannot be taken back. The module is therefore
 * narrow on purpose.
 *
 * - The sender is always the mailbox's own address. A caller chooses the
 *   recipients, the subject and the text, never who the mail claims to be from.
 * - Every recipient is one bare address, checked before a connection is
 *   opened, and nothing a caller passes can add a header: line breaks are
 *   stripped from the subject and a reference that is not a message id is
 *   dropped rather than written.
 * - Plain text only. Composing HTML means sanitising what was typed or quoted
 *   on the way out, and a reply does not need it.
 * - Never unencrypted: implicit TLS on port 465, mandatory STARTTLS on any
 *   other port. There is no setting that sends a mailbox password in the clear.
 * - Message text and recipient addresses are never logged, only how many.
 *
 * The message is built first and the exact bytes are what goes on the wire, so
 * the caller can file the same message into Sent for the providers that do
 * not keep a copy themselves (see savesSentCopy), with the one line the
 * recipients are not shown: who was blind-copied.
 */
import { createTransport } from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import type { SMTPTransportOptions } from 'nodemailer/lib/smtp-transport';
import { PROVIDER_PRESETS, type Account, type AuthKind } from './config.js';
import { authorizedScope, getAccessToken } from './imap/auth.js';
import { getLogger } from './logger.js';
import { metrics } from './metrics.js';

const log = getLogger('smtp');

export interface OutgoingMail {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  /** When replying: the original's Message-ID and its References chain. */
  inReplyTo?: string;
  references?: string[];
}

export interface SentMail {
  messageId: string;
  /** The message exactly as it was handed to the server. */
  raw: Buffer;
  /**
   * What to file in Sent: the same message with its Bcc line, which the
   * recipients are never shown and the sender's own copy has to keep.
   */
  copy: Buffer;
  accepted: string[];
  rejected: string[];
}

/**
 * Why a send did not happen.
 *
 * `not_configured`: this mailbox cannot send from here (no server, sending
 * switched off, or an authorization that does not cover SMTP). `invalid`: the
 * message itself was refused before any connection. `auth`: the server did
 * not accept the sign-in. `rejected`: the server refused the sender, every
 * recipient, or the message. `connection`: the server was not reached, or the
 * conversation broke off before the message was handed over. `unknown`: it
 * broke off after, so the message may have been sent, and a caller must not
 * treat that as a failure it can simply retry.
 */
export type SendErrorCode = 'not_configured' | 'invalid' | 'auth' | 'rejected' | 'connection' | 'unknown';

export class SendError extends Error {
  override name = 'SendError';
  /** The SMTP reply code, when the server gave one. */
  readonly responseCode?: number;
  /** The server's own words, bounded. It may name a recipient, so it is for the reader, not the log. */
  readonly detail?: string;

  constructor(readonly code: SendErrorCode, message: string, extra: { responseCode?: number; detail?: string } = {}) {
    super(message);
    if (extra.responseCode !== undefined) this.responseCode = extra.responseCode;
    if (extra.detail) this.detail = extra.detail;
  }
}

/**
 * Submission servers, by provider.
 *
 * 465 is TLS from the first byte; 587 upgrades with STARTTLS, which is
 * required here rather than attempted.
 */
const SMTP_SERVERS: Record<string, { host: string; port: number }> = {
  gmail: { host: 'smtp.gmail.com', port: 465 },
  gmail_pw: { host: 'smtp.gmail.com', port: 465 },
  outlook: { host: 'smtp-mail.outlook.com', port: 587 },

  qq: { host: 'smtp.qq.com', port: 465 },
  qq_biz: { host: 'smtp.exmail.qq.com', port: 465 },
  '163': { host: 'smtp.163.com', port: 465 },
  '126': { host: 'smtp.126.com', port: 465 },
  sina: { host: 'smtp.sina.com', port: 465 },
  aliyun: { host: 'smtp.aliyun.com', port: 465 },
  feishu: { host: 'smtp.feishu.cn', port: 465 },
  lark: { host: 'smtp.larksuite.com', port: 465 },

  icloud: { host: 'smtp.mail.me.com', port: 587 },
  fastmail: { host: 'smtp.fastmail.com', port: 465 },
  yahoo: { host: 'smtp.mail.yahoo.com', port: 465 },
  zoho: { host: 'smtp.zoho.com', port: 465 },
  yandex: { host: 'smtp.yandex.com', port: 465 },
  gmx: { host: 'mail.gmx.com', port: 587 },
};

/** Providers that file a message sent over SMTP into Sent without being asked. */
const SAVES_SENT_COPY = new Set(['gmail', 'gmail_pw', 'outlook', 'qq', 'qq_biz']);

/** A port given without a host, or a host without a port, lands on implicit TLS. */
const DEFAULT_SMTP_PORT = 465;

const MAX_RECIPIENTS = 50;
/** The longest line SMTP carries; a subject is one header line before folding. */
const MAX_SUBJECT_CHARS = 998;
const MAX_TEXT_CHARS = 500_000;
/** A reply quotes this much of the original and says that it stopped. */
const MAX_QUOTED_CHARS = 50_000;
const MAX_REFERENCES = 20;

const CONNECTION_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 30_000;

/**
 * SMTP_ENABLED=false switches sending off for every mailbox. DRY_RUN does the
 * same, because a dry run that mailed people would not be one.
 */
function sendingEnabled(): boolean {
  if (['false', '0', 'no', 'off'].includes((process.env.SMTP_ENABLED ?? '').trim().toLowerCase())) return false;
  return (process.env.DRY_RUN ?? '').trim().toLowerCase() !== 'true';
}

/**
 * One bare address: something@domain.tld and nothing else.
 *
 * No display name, no angle brackets, no list. Whitespace is refused outright,
 * which is what keeps a line break (and so a second header) out, and so are
 * the characters that mean something in an address list.
 */
const ADDRESS = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/u;
const CONTROL = /[\u0000-\u001f\u007f]/;

export function isSendableAddress(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && !CONTROL.test(value) && ADDRESS.test(value);
}

/**
 * The outgoing server for a mailbox, or nothing when there is none to use.
 *
 * An explicit MAIL_ACCOUNT_N_SMTP_HOST wins. Otherwise the provider's own
 * server is used only while the mailbox really is on that provider: an account
 * whose IMAP host was pointed somewhere else (a self-hosted server under a
 * familiar preset, a fixture on a closed local port) must not have its
 * password offered to the provider's submission server on a guess.
 */
function smtpServer(account: Account): { host: string; port: number } | undefined {
  if (account.smtpHost) return { host: account.smtpHost, port: account.smtpPort ?? DEFAULT_SMTP_PORT };
  const preset = SMTP_SERVERS[account.provider];
  const imap = (PROVIDER_PRESETS as Record<string, { host?: string }>)[account.provider];
  if (!preset || !imap?.host || account.host !== imap.host) return undefined;
  return { host: preset.host, port: account.smtpPort ?? preset.port };
}

/**
 * Whether an OAuth authorization with this scope may submit mail.
 *
 * Google's full-mailbox scope covers SMTP. Microsoft grants IMAP and SMTP
 * separately, so a token asked for with the IMAP scope alone is refused at
 * AUTH with an error that says nothing about scopes.
 */
export function scopeAllowsSending(auth: AuthKind, scope: string): boolean {
  if (auth === 'gmail_oauth') return /(?:^|\s)https:\/\/mail\.google\.com\/?(?:\s|$)/i.test(scope);
  if (auth === 'outlook_oauth') return /(?:^|[\s/])SMTP\.Send(?:\s|$)/i.test(scope);
  return true;
}

function authorizationCoversSending(account: Account): boolean {
  if (account.auth === 'password') return true;
  // Google's one scope is the whole mailbox, sending included.
  if (account.auth === 'gmail_oauth') return true;
  // Microsoft's is per capability, so what counts is what this mailbox was
  // actually authorized with: `npm run oauth -- --send` asks for sending too.
  return scopeAllowsSending(account.auth, authorizedScope(account.username) ?? '');
}

/** Whether this mailbox can send, decided without opening a connection. */
export function sendingStatus(
  account: Account,
): { available: boolean; reason?: 'disabled' | 'no_smtp' | 'oauth_scope'; host?: string; port?: number } {
  // Switched off on purpose, which is a different thing to fix than a server nobody named.
  if (!sendingEnabled()) return { available: false, reason: 'disabled' };
  const server = smtpServer(account);
  // A login that is not an address (some self-hosted servers) is nothing to send from.
  if (!server || !isSendableAddress(account.username)) return { available: false, reason: 'no_smtp' };
  if (!authorizationCoversSending(account)) return { available: false, reason: 'oauth_scope', ...server };
  return { available: true, ...server };
}

/**
 * Whether this provider files a sent message into Sent by itself.
 *
 * Gmail, Outlook and QQ do when the mail goes through their own submission
 * server; the caller should APPEND a copy for everyone else, or the reply
 * exists only in the recipient's mailbox.
 */
export function savesSentCopy(account: Account): boolean {
  const server = smtpServer(account);
  return Boolean(server && SAVES_SENT_COPY.has(account.provider) && server.host === SMTP_SERVERS[account.provider]?.host);
}

/**
 * Connection settings for a mailbox's submission server.
 *
 * `accessToken` is required for an OAuth mailbox and ignored for a password
 * one. Exported so the settings can be checked without a server to talk to.
 */
export function smtpTransportOptions(account: Account, accessToken?: string): SMTPTransportOptions {
  const server = smtpServer(account);
  if (!server) throw new SendError('not_configured', 'no outgoing mail server is configured for this mailbox');
  const implicitTls = server.port === 465;
  return {
    host: server.host,
    port: server.port,
    secure: implicitTls,
    // Never fall back to plain text when the upgrade is refused or stripped.
    requireTLS: !implicitTls,
    tls: { minVersion: 'TLSv1.2' },
    // What a desktop client says in EHLO. The default is this machine's
    // hostname, which a receiving server then stamps into the message.
    name: '[127.0.0.1]',
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: CONNECTION_TIMEOUT_MS,
    dnsTimeout: CONNECTION_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    disableFileAccess: true,
    disableUrlAccess: true,
    auth: account.auth === 'password'
      ? { user: account.username, pass: account.password ?? '' }
      : { type: 'OAuth2', user: account.username, accessToken: accessToken ?? '' },
  };
}

/** The part of a nodemailer transport this module uses, so a test can hand one in. */
interface MailTransport {
  sendMail(mail: { envelope: { from: string; to: string[] }; raw: Buffer }): Promise<{ accepted?: unknown[]; rejected?: unknown[] }>;
  close?(): void;
}

/**
 * A way to know whether the message itself went down the wire.
 *
 * When a connection breaks, the library reports the same error whether that
 * was before the envelope or after the last byte of the message. The two are
 * very different to a reader: the first certainly sent nothing, the second
 * may have sent everything. The library does say, in its log, when the whole
 * message has been written; this listens for that line and for nothing else,
 * and keeps none of what it is shown.
 */
function handoverWatch(): { logger: Record<string, (entry?: unknown) => void>; handedOver: () => boolean } {
  let handed = false;
  const ignore = (): void => undefined;
  return {
    logger: {
      trace: ignore, debug: ignore, warn: ignore, error: ignore, fatal: ignore,
      info: (entry) => {
        if ((entry as { tnx?: unknown } | null)?.tnx === 'message') handed = true;
      },
    },
    handedOver: () => handed,
  };
}

/** A transport handed in ready-made, or a way to make one that is given the watch above. */
type TransportSource = MailTransport | ((watch: { logger: unknown }) => MailTransport);

function invalid(message: string): SendError {
  return new SendError('invalid', message);
}

function recipients(values: unknown, field: string): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw invalid(`${field} must be a list of addresses`);
  return values.map((value) => {
    const address = typeof value === 'string' ? value.trim() : value;
    if (!isSendableAddress(address)) throw invalid(`${field} holds something that is not a single email address`);
    return address;
  });
}

/**
 * A message id as a header may carry it, or nothing.
 *
 * Dropped rather than refused when malformed: a reply to a message with a
 * broken id should still go out, only without the thread link, and whatever
 * is dropped cannot become a header of its own.
 */
function messageIdOrNothing(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  const inner = trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed;
  if (!inner || inner.length > 990 || /[\s<>]/.test(inner) || CONTROL.test(inner)) return undefined;
  return `<${inner}>`;
}

function referenceChain(values: unknown): string[] {
  const chain: string[] = [];
  for (const value of Array.isArray(values) ? values : []) {
    const id = messageIdOrNothing(value);
    if (id && !chain.includes(id)) chain.push(id);
  }
  return chain.slice(-MAX_REFERENCES);
}

function oneLine(value: string): string {
    return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

interface Prepared {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  inReplyTo: string | undefined;
  references: string[];
}

/** Check a message and reduce it to what will be written. Throws SendError('invalid'). */
function prepare(mail: OutgoingMail): Prepared {
  if (typeof mail !== 'object' || mail === null) throw invalid('a message is required');
  const listed = {
    to: recipients(mail.to, 'to'),
    cc: recipients(mail.cc, 'cc'),
    bcc: recipients(mail.bcc, 'bcc'),
  };
  const total = listed.to.length + listed.cc.length + listed.bcc.length;
  if (total === 0) throw invalid('at least one recipient is required');
  if (total > MAX_RECIPIENTS) throw invalid(`a message may have at most ${MAX_RECIPIENTS} recipients`);
  // An address listed twice is delivered once, under the first field that names it.
  const taken = new Set<string>();
  const once = (list: string[]): string[] => list.filter((address) => {
    const key = address.toLowerCase();
    if (taken.has(key)) return false;
    taken.add(key);
    return true;
  });
  const to = once(listed.to);
  const cc = once(listed.cc);
  const bcc = once(listed.bcc);

  if (typeof mail.subject !== 'string') throw invalid('subject must be text');
  const subject = oneLine(mail.subject);
  if (subject.length > MAX_SUBJECT_CHARS) throw invalid(`subject exceeds ${MAX_SUBJECT_CHARS} characters`);
  if (typeof mail.text !== 'string') throw invalid('text must be text');
  if (mail.text.length > MAX_TEXT_CHARS) throw invalid(`text exceeds ${MAX_TEXT_CHARS} characters`);

  return {
    to, cc, bcc, subject,
    text: mail.text.replace(/\r\n?/g, '\n'),
    inReplyTo: messageIdOrNothing(mail.inReplyTo),
    references: referenceChain(mail.references),
  };
}

/**
 * The copy for the sender's own Sent folder: the message, with the Bcc line.
 * The addresses were each checked as one bare address, so nothing here can
 * start a header of its own.
 */
function sentCopy(raw: Buffer, bcc: string[]): Buffer {
  if (bcc.length === 0) return raw;
  return Buffer.concat([Buffer.from(`Bcc: ${bcc.join(',\r\n ')}\r\n`, 'latin1'), raw]);
}

/** Build the message. The bytes returned are the bytes sent: CRLF throughout, nothing added later. */
async function compose(account: Account, mail: Prepared): Promise<{ messageId: string; raw: Buffer }> {
  const boxes = (list: string[]): Array<{ name: string; address: string }> =>
    list.map((address) => ({ name: '', address }));
  const fromName = account.fromName ? oneLine(account.fromName) : '';
  const node = new MailComposer({
    from: { name: fromName, address: account.username },
    to: boxes(mail.to),
    ...(mail.cc.length ? { cc: boxes(mail.cc) } : {}),
    // The builder leaves the Bcc header out of what the recipients receive;
    // the envelope names them, and the copy for Sent gets the line back.
    ...(mail.bcc.length ? { bcc: boxes(mail.bcc) } : {}),
    subject: mail.subject,
    text: mail.text,
    ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo } : {}),
    ...(mail.references.length ? { references: mail.references } : {}),
    disableFileAccess: true,
    disableUrlAccess: true,
  }).compile();
  // Asking for the id creates the header, so it is the one in the bytes below.
  const messageId = node.messageId();
  const built = await node.build();
  // The builder keeps the body's own line ends; SMTP would rewrite them on the
  // way out, and then the copy filed in Sent would not be the message sent.
  let wire = built.toString('latin1').replace(/\r\n|\r|\n/g, '\r\n');
  if (!wire.endsWith('\r\n')) wire += '\r\n';
  return { messageId, raw: Buffer.from(wire, 'latin1') };
}

const AUTH_CODES = new Set(['EAUTH', 'ENOAUTH', 'EOAUTH2']);
const CONNECTION_CODES = new Set([
  'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ETLS', 'EREQUIRETLS', 'EPROTOCOL', 'EPROXY',
]);
const REJECTION_CODES = new Set(['EENVELOPE', 'EMESSAGE', 'EMAXRECIPIENTS']);

/** Translate what nodemailer threw into the handful of outcomes a caller can act on. */
function toSendError(error: unknown): SendError {
  if (error instanceof SendError) return error;
  const raised = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown; responseCode?: unknown; response?: unknown;
  };
  const code = typeof raised.code === 'string' ? raised.code : '';
  const responseCode = typeof raised.responseCode === 'number' && raised.responseCode > 0 ? raised.responseCode : undefined;
  const detail = typeof raised.response === 'string' ? oneLine(raised.response).slice(0, 200) : '';
  const extra = { ...(responseCode !== undefined ? { responseCode } : {}), ...(detail ? { detail } : {}) };

  if (AUTH_CODES.has(code)) return new SendError('auth', 'the mail server did not accept the sign-in', extra);
  if (CONNECTION_CODES.has(code)) return new SendError('connection', 'the mail server could not be reached', extra);
  if (REJECTION_CODES.has(code) || (responseCode !== undefined && responseCode >= 400)) {
    return new SendError('rejected', 'the mail server refused the message', extra);
  }
  return new SendError('connection', 'the message could not be handed to the mail server', extra);
}

function addressList(values: unknown[] | undefined): string[] {
  return (values ?? []).map((value) => {
    if (typeof value === 'string') return value;
    const address = (value as { address?: unknown } | null)?.address;
    return typeof address === 'string' ? address : '';
  }).filter(Boolean);
}

/**
 * Send one message from a mailbox.
 *
 * Resolves when the server has taken the message for at least one recipient;
 * `rejected` lists the ones it refused. Throws SendError otherwise, and never
 * retries by itself: a send that may have gone out must not go out twice.
 */
export async function sendMail(
  account: Account,
  mail: OutgoingMail,
  options: { transport?: unknown } = {},
): Promise<SentMail> {
  if (!sendingEnabled()) throw new SendError('not_configured', 'sending is switched off on this server');
  const injected = options.transport as TransportSource | undefined;
  if (!injected) {
    const status = sendingStatus(account);
    if (!status.available) {
      throw new SendError('not_configured', status.reason === 'oauth_scope'
        ? 'this mailbox is authorized for reading only; authorize it again with the SMTP scope to send'
        : 'no outgoing mail server is configured for this mailbox');
    }
  }
  if (!isSendableAddress(account.username)) {
    throw new SendError('not_configured', 'this mailbox signs in with a name that is not an address to send from');
  }

  const prepared = prepare(mail);
  const { messageId, raw } = await compose(account, prepared);
  const envelope = { from: account.username, to: [...prepared.to, ...prepared.cc, ...prepared.bcc] };
  const outcome = (name: string): Record<string, string> => ({ provider: account.provider, outcome: name });

  // Before the message went down the wire, a broken connection means nothing
  // was sent. After it, the server may have taken the message and lost the
  // line before saying so.
  const watch = handoverWatch();
  // A transport handed in ready-made belongs to the caller; one made here is closed here.
  let transport = typeof injected === 'function' ? undefined : injected;
  const owned = transport === undefined;
  try {
    if (typeof injected === 'function') transport = injected({ logger: watch.logger });
    if (!transport) {
      let accessToken: string | undefined;
      if (account.auth !== 'password') {
        try {
          accessToken = await getAccessToken(account.username, account.auth);
        } catch (error) {
          // No authorization on record, or the refresh was refused: the same
          // thing to the reader as a server saying no, and fixed the same way.
          log.warn(`[${account.name}] no usable authorization to send with: ${String(error).slice(0, 200)}`);
          throw new SendError('auth', 'this mailbox has no usable authorization to send with');
        }
      }
      transport = createTransport({
        ...smtpTransportOptions(account, accessToken), logger: watch.logger,
      } as SMTPTransportOptions) as unknown as MailTransport;
    }
    const info = await transport.sendMail({ envelope, raw });
    const rejected = addressList(info.rejected);
    const refused = new Set(rejected.map((address) => address.toLowerCase()));
    // What the server says it took; when it does not say, everyone it did not refuse.
    const accepted = info.accepted ? addressList(info.accepted) : envelope.to.filter((address) => !refused.has(address.toLowerCase()));
    log.info(`[${account.name}] sent a message | ${accepted.length} accepted, ${rejected.length} refused`);
    metrics.addCounter('mailsift.mail.sent', 1, outcome(rejected.length ? 'partial' : 'sent'));
    return { messageId, raw, copy: sentCopy(raw, prepared.bcc), accepted, rejected };
  } catch (error) {
    const broke = toSendError(error);
    const failure = watch.handedOver() && broke.code === 'connection'
      ? new SendError('unknown', 'the connection ended after the message was handed over; it may have been sent')
      : broke;
    log.warn(
      `[${account.name}] message not sent: ${failure.code}`
        + (failure.responseCode !== undefined ? ` (SMTP ${failure.responseCode})` : '')
        + ` | ${envelope.to.length} recipients`,
    );
    metrics.addCounter('mailsift.mail.sent', 1, outcome(failure.code));
    throw failure;
  } finally {
    if (transport && owned) transport.close?.();
  }
}

export interface MailAddress {
  name: string;
  address: string;
}

/** What the reader fetched of the message being answered. */
export interface ReplyOriginal {
  from: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  replyTo: MailAddress[];
  subject: string;
  date: string | null;
  messageId: string | null;
  references: string[];
  text: string;
}

/** "Re:" and what Chinese clients write for it, with either colon. */
const REPLY_PREFIX = /^(?:re|回复|回復|答复|答覆)\s*[:：]/i;

function attribution(original: ReplyOriginal, lang: 'en' | 'zh-CN'): string {
  const from = original.from;
  const name = from ? oneLine(from.name) : '';
  const address = from && isSendableAddress(from.address.trim()) ? from.address.trim() : '';
  const who = name && address ? `${name} <${address}>` : name || address || (lang === 'zh-CN' ? '发件人' : 'the sender');
  const at = original.date ? new Date(original.date) : null;
  let when = '';
  if (at && !Number.isNaN(at.valueOf())) {
    try {
      when = new Intl.DateTimeFormat(lang === 'zh-CN' ? 'zh-CN' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(at);
    } catch {
      when = at.toISOString().slice(0, 16).replace('T', ' ');
    }
  }
  // Both forms are the ones body.ts recognises, so when this reply is answered
  // in turn, mailsift strips its own quote before judging the new text.
  if (lang === 'zh-CN') return when ? `在 ${when}，${who} 写道：` : `${who} 写道：`;
  return when ? `On ${when}, ${who} wrote:` : `${who} wrote:`;
}

/**
 * Recipients, subject and quoted body for a reply, from what the reader fetched.
 *
 * Every address comes from the original message's headers, which its sender
 * wrote, so anything that is not a single plain address is left out here and
 * checked again when the reply is sent. `self` is every address the owner
 * reads mail at: none of them is ever addressed, so "reply all" does not mail
 * the owner's other mailboxes.
 */
export function replyEnvelope(
  original: ReplyOriginal,
  self: string[],
  mode: 'reply' | 'replyAll',
  lang: 'en' | 'zh-CN' = 'en',
): {
  to: string[]; cc: string[]; subject: string; quoted: string; inReplyTo?: string; references: string[];
  /**
   * Where `to` came from: the address the message asks answers to go to, its
   * sender, the people a message the owner sent went to, or (`recipients`)
   * the people it went to because it named nobody else to answer.
   */
  addressedTo: 'replyTo' | 'sender' | 'ownRecipients' | 'recipients';
} {
  const mine = new Set(self.map((address) => address.trim().toLowerCase()));
  const taken = new Set<string>();
  const usable = (list: MailAddress[] | null | undefined): string[] => {
    const out: string[] = [];
    for (const entry of list ?? []) {
      const address = typeof entry?.address === 'string' ? entry.address.trim() : '';
      const key = address.toLowerCase();
      if (!isSendableAddress(address) || mine.has(key) || taken.has(key)) continue;
      taken.add(key);
      out.push(address);
    }
    return out;
  };

  // Reply-To is where the sender asked for answers; From is the default, and
  // also where a Reply-To that names only the owner (or nothing usable) leaves
  // the answer: that is not a request to answer everyone else.
  let addressedTo: 'replyTo' | 'sender' | 'ownRecipients' | 'recipients' = 'replyTo';
  let to = usable(original.replyTo);
  if (to.length === 0) {
    addressedTo = 'sender';
    to = usable(original.from ? [original.from] : []);
  }
  // Answering a message the owner sent themselves continues it to the people it went to.
  if (to.length === 0) {
    const fromOwner = mine.has((original.from?.address ?? '').trim().toLowerCase());
    addressedTo = fromOwner ? 'ownRecipients' : 'recipients';
    to = usable(original.to);
  }
  const cc = mode === 'replyAll' ? usable([...(original.to ?? []), ...(original.cc ?? [])]) : [];

  const subject = oneLine(original.subject ?? '');
  const inReplyTo = messageIdOrNothing(original.messageId);
  const references = referenceChain([...(original.references ?? []), ...(inReplyTo ? [inReplyTo] : [])]);

  const text = (original.text ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  const clipped = text.length > MAX_QUOTED_CHARS;
  const lines = (clipped ? text.slice(0, MAX_QUOTED_CHARS) : text).split('\n');
  if (clipped) lines.push('[…]');
  const quoted = [attribution(original, lang), ...lines.map((line) => (line ? `> ${line}` : '>'))].join('\n');

  return {
    to,
    cc,
    subject: REPLY_PREFIX.test(subject) ? subject : `Re: ${subject}`.trim(),
    quoted,
    ...(inReplyTo ? { inReplyTo } : {}),
    references,
    addressedTo,
  };
}
