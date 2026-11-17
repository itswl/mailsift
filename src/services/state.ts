/**
 * Local state: UID cursors, deduplication, digest queue, and health counters.
 *
 * Use node:sqlite (built into Node 22.5+) without compiling native dependencies.
 * The main service and MCP share this database, and atomic updates protect cursor
 * writes and the "mark only after triage" invariant.
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

/**
 * node:sqlite was added in Node 22.5 but is not yet listed in
 * `module.builtinModules`. Some bundlers therefore treat a static import as a
 * third-party dependency.
 *
 * createRequire hides the runtime load from static analysis while Node resolves
 * it normally. Types still come from node:sqlite.
 */
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = import('node:sqlite').DatabaseSync;
import { getLogger } from '../logger.js';
import { attachmentSafetyWarnings, SIGN_IN_LINK_SUMMARY, VERIFICATION_SUMMARY_PREFIX } from '../imap/message.js';
import type { AttachmentInfo, AttachmentManifest, MailMessage } from '../imap/message.js';
import type { TriageResult } from './triage.js';

const log = getLogger('state');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cursors (
  account TEXT NOT NULL, folder TEXT NOT NULL,
  uid_validity TEXT NOT NULL, last_uid INTEGER NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (account, folder)
);
CREATE TABLE IF NOT EXISTS seen (
  dedup_key TEXT PRIMARY KEY, account TEXT NOT NULL, account_label TEXT,
  message_id TEXT, thread_key TEXT, subject TEXT, sender TEXT, sender_name TEXT,
  folder TEXT, in_spam INTEGER NOT NULL DEFAULT 0,
  importance TEXT, category TEXT, summary TEXT, reason TEXT, deadline TEXT,
  decided_by TEXT, pushed INTEGER NOT NULL DEFAULT 0,
  mail_date TEXT, snippet TEXT, attachments_json TEXT, verification_code TEXT, handled_at TEXT,
  uid INTEGER, uid_validity TEXT, snoozed_until TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS digest_queue (
  dedup_key TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dead_letter (
  dead_key TEXT PRIMARY KEY, account TEXT NOT NULL, folder TEXT NOT NULL,
  uid_validity TEXT NOT NULL, uid INTEGER NOT NULL, message_id TEXT,
  subject TEXT, reason TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notification_outbox (
  notification_key TEXT PRIMARY KEY, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, next_attempt_at TEXT, created_at TEXT NOT NULL, delivered_at TEXT
);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, dedup_key TEXT,
  label TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, client TEXT, target TEXT,
  success INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mail_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, message_id TEXT NOT NULL,
  action TEXT NOT NULL, source_folder TEXT, destination_folder TEXT,
  success INTEGER NOT NULL, error TEXT, client TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS digest_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sent_at TEXT NOT NULL, items TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'warning', codes INTEGER NOT NULL DEFAULT 1, lang TEXT NOT NULL DEFAULT 'en',
  label TEXT, origin TEXT, created_at TEXT NOT NULL, last_ok_at TEXT, failures INTEGER NOT NULL DEFAULT 0,
  credential TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_seen_created ON seen (created_at);
CREATE INDEX IF NOT EXISTS idx_seen_importance ON seen (importance);
CREATE INDEX IF NOT EXISTS idx_mail_actions_created ON mail_actions (created_at);
CREATE TABLE IF NOT EXISTS owner_filed (
  dedup_key TEXT PRIMARY KEY, account TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sent_mail (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, account_label TEXT,
  message_id TEXT NOT NULL, thread_key TEXT NOT NULL, in_reply_to TEXT, answers TEXT,
  subject TEXT, from_addr TEXT, from_name TEXT, recipients TEXT NOT NULL DEFAULT '[]',
  mail_date TEXT, body TEXT NOT NULL DEFAULT '',
  attachment_count INTEGER NOT NULL DEFAULT 0, attachment_names TEXT NOT NULL DEFAULT '[]',
  folder TEXT, uid INTEGER, uid_validity TEXT, source TEXT NOT NULL,
  checked_at TEXT, answered_key TEXT, created_at TEXT NOT NULL,
  UNIQUE (account, message_id)
);
CREATE INDEX IF NOT EXISTS idx_sent_thread ON sent_mail (thread_key, mail_date);
CREATE INDEX IF NOT EXISTS idx_sent_date ON sent_mail (mail_date);
CREATE INDEX IF NOT EXISTS idx_sent_unchecked ON sent_mail (id) WHERE checked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sent_answers ON sent_mail (account, answers);
CREATE TABLE IF NOT EXISTS sent_cursors (
  account TEXT PRIMARY KEY, folder TEXT NOT NULL, uid_validity TEXT NOT NULL, last_uid INTEGER NOT NULL,
  backfill_below INTEGER NOT NULL DEFAULT 0, backfill_left INTEGER NOT NULL DEFAULT 0, backfill_since TEXT,
  updated_at TEXT NOT NULL
);
`;

export interface MailRecord {
  messageId?: string;
  threadKey?: string;
  accountLabel?: string;
  sender?: string;
  senderName?: string;
  folder?: string;
  inSpam?: boolean;
  category?: string;
  summary?: string;
  reason?: string;
  deadline?: string;
  decidedBy?: string;
  mailDate?: string;
  snippet?: string;
  verificationCode?: string;
  attachmentManifest?: AttachmentManifest;
  /**
   * Where the message is in its folder: its UID, and the folder's UIDVALIDITY
   * that the UID belongs to. With these a message is fetched directly when it
   * is opened. Without them it has to be searched for, and some servers
   * answer a search for one message with the whole folder.
   */
  uid?: number;
  uidValidity?: string;
}

export interface MailRow {
  dedupKey: string;
  messageId: string | null;
  threadKey: string | null;
  account: string;
  accountLabel: string | null;
  subject: string | null;
  sender: string | null;
  senderName: string | null;
  folder: string | null;
  inSpam: boolean;
  importance: string | null;
  category: string | null;
  summary: string | null;
  reason: string | null;
  deadline: string | null;
  decidedBy: string | null;
  pushed: boolean;
  /**
   * Due a notification that was not sent because the owner had dealt with
   * the message already: answered it from another client, or marked it done
   * while its notification waited. Counted like pushed by the queue.
   */
  withheld: boolean;
  mailDate: string | null;
  createdAt: string;
  /** When the reader marked it dealt with, in the page or through feedback; null while it still needs them. */
  handledAt: string | null;
  /**
   * When the owner asked to be reminded of it (ISO 8601, UTC). Until then it
   * is out of the queue; from then on it is back in it, whatever it was
   * judged. Null when no reminder was asked for, or it was cancelled.
   */
  snoozedUntil: string | null;
  snippet?: string | null;
  /** Extracted one-time code, kept locally so the web view can show it. */
  verificationCode?: string;
  attachmentManifest?: AttachmentManifest | null;
}

export interface QueryOptions {
  sinceHours?: number;
  importance?: string;
  category?: string;
  spamOnly?: boolean;
  pushedOnly?: boolean;
  /** Only rows that carry an extracted verification code. */
  codesOnly?: boolean;
  account?: string;
  search?: string;
  limit?: number;
  beforeCreatedAt?: string;
  beforeDedupKey?: string;
}

export interface MailThread {
  threadKey: string;
  account: string;
  accountLabel: string | null;
  /** The received messages of the thread in the window. */
  messageCount: number;
  latest: MailRow;
  messages: MailRow[];
  /** The owner's own messages stored for this thread, whatever the window. */
  sentCount: number;
  /** When the owner last wrote in it, or null. */
  lastSentAt: string | null;
  /** Whether the latest word in the thread is the owner's: written after its latest received message. */
  lastWordYours: boolean;
}

/** One person a sent message went to, as its header named them. */
export interface SentAddress {
  name: string;
  address: string;
}

/** Where a stored sent message came from: the poll reading Sent, or a send from the page or through MCP. */
export type SentSource = 'poll' | 'page' | 'mcp';

/**
 * A message the owner sent, as it is stored for the conversation.
 *
 * Kept apart from `seen` on purpose. Everything that reads `seen` (the queue,
 * the digest, notifications, search, the model's thread context) is about
 * mail that arrived, and a sent message among those rows would leak into one
 * of them sooner or later.
 */
export interface SentRecord {
  account: string;
  accountLabel?: string | undefined;
  messageId: string;
  /** Computed exactly as for received mail, so a reply joins its conversation. */
  threadKey: string;
  inReplyTo?: string | undefined;
  /** The Message-ID this message answers: its In-Reply-To, else the last of its References. */
  answers?: string | undefined;
  subject: string;
  fromAddr: string;
  fromName?: string | undefined;
  to: SentAddress[];
  cc: SentAddress[];
  bcc: SentAddress[];
  /** When it was sent (ISO 8601), when that is known. */
  date?: string | undefined;
  /** What the owner wrote, without the quoted history, bounded. */
  text: string;
  attachmentCount: number;
  attachmentNames: string[];
  folder?: string | undefined;
  uid?: number | undefined;
  uidValidity?: string | undefined;
  source: SentSource;
}

export interface SentRow {
  id: number;
  account: string;
  accountLabel: string | null;
  messageId: string;
  threadKey: string;
  inReplyTo: string | null;
  answers: string | null;
  subject: string | null;
  fromAddr: string | null;
  fromName: string | null;
  to: SentAddress[];
  cc: SentAddress[];
  bcc: SentAddress[];
  date: string | null;
  text: string;
  attachmentCount: number;
  attachmentNames: string[];
  folder: string | null;
  source: SentSource;
  /** The received message this one took off the queue, when it did. */
  answeredKey: string | null;
  createdAt: string;
}

/** How far the poll has read one mailbox's Sent folder. */
export interface SentCursorRow {
  folder: string;
  uidValidity: string;
  /** The highest UID read; newer mail is fetched above it. */
  lastUid: number;
  /** The first look back still has messages below this UID to read (0: none). */
  backfillBelow: number;
  /** How many more the first look back may still read. */
  backfillLeft: number;
  /** How far back the first look reaches (ISO 8601). */
  backfillSince: string | null;
}

/** An address to suggest when writing, and why. */
export interface Contact {
  address: string;
  /** The most recent non-empty name seen with it; '' when there was none. */
  name: string;
  /** Messages the owner sent to it. */
  sent: number;
  /** Personal-looking messages received from it. */
  received: number;
  lastAt: string | null;
  /** `sent`: written to; `received`: only ever wrote. */
  source: 'sent' | 'received';
}

/** One message of a conversation, received or sent, as the reader and MCP show it. */
export type ConversationEntry =
  | { direction: 'in'; at: string; row: MailRow }
  | { direction: 'out'; at: string; sent: SentRow };

export interface MailActionAudit {
  account: string;
  messageId: string;
  action: string;
  sourceFolder?: string;
  destinationFolder?: string;
  success: boolean;
  error?: string;
  client?: string;
  createdAt: string;
}

export interface McpAuditEvent {
  action: string;
  client: string | null;
  target: string | null;
  success: boolean;
  createdAt: string;
}

export interface DeadLetterRow {
  deadKey: string;
  account: string;
  folder: string;
  uidValidity: string;
  uid: number;
  messageId: string | null;
  subject: string | null;
  reason: string;
  createdAt: string;
}

export interface CursorRow {
  account: string;
  folder: string;
  uidValidity: string;
  lastUid: number;
  updatedAt: string;
}

export interface NotificationOutboxRow {
  notificationKey: string;
  message: MailMessage;
  result: TriageResult;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
}

/**
 * What the owner said about a message. `spam` and `not_spam` are said by
 * moving a message into the spam folder or out of it; a sender's spam counts
 * towards a never-important rule as a false positive does, unless the owner
 * has since said one of that sender's messages is not spam.
 */
export type FeedbackLabel = 'false_positive' | 'missed' | 'handled' | 'correct' | 'spam' | 'not_spam';

/** One browser that asked to be notified, and what it asked to be told. */
export interface PushSubscriptionRow {
  endpoint: string;
  /** base64url, as PushSubscription.toJSON() gives them. */
  p256dh: string;
  auth: string;
  /** `critical` is critical mail only; `warning` adds warnings. */
  level: 'critical' | 'warning';
  /** Whether a verification code is sent, with the code in it. */
  codes: boolean;
  lang: string;
  label: string | null;
  /** The origin the page was on when it subscribed, for the push service's contact claim. */
  origin: string | null;
  createdAt: string;
  lastOkAt: string | null;
  /** Deliveries that failed in a row since the last one that worked. */
  failures: number;
  /** A mark of the token the subscribing session held, never the token; '' when none was required. */
  credential: string;
}

/** A place in the judged mail, ordered by when a row was filed and then by its key. */
export interface RowCursor {
  createdAt: string;
  dedupKey: string;
}

/**
 * The moment the "needs you" queue starts from.
 *
 * Mail judged before the queue existed was never offered to anyone as a
 * to-do, so on an upgrade it would arrive as weeks of backlog nobody asked
 * for. The queue therefore only holds what was filed after this instant.
 */
export const ATTENTION_SINCE_KEY = 'attention_since';
/** A to-do nobody touched for a month has stopped being one. */
const ATTENTION_WINDOW_DAYS = 30;
/** How far back "dealt with lately" reaches: long enough to notice a slip, short enough to stay a short list. */
const RECENTLY_HANDLED_DAYS = 7;
/**
 * Bumped by the changes no aggregate over the rows can see: a message moved
 * between two folders, one marked handled while another is put back, one put
 * off until later, and one whose reminder has come.
 */
const MAIL_REVISION_KEY = 'mail_revision';
/**
 * Keys of rows whose verdict changed after they were first judged, as a JSON
 * list. The web push dispatcher reads rows in the order they were filed and
 * never looks back, so a message that was `info` during an LLM outage and
 * `critical` once it was judged properly would never be notified. The poller
 * leaves its key here; the dispatcher takes the list each pass.
 */
export const REJUDGED_KEY = 'web_push_rejudged';
/**
 * Up to when the push dispatcher has looked for reminders that came, as an
 * ISO 8601 time. It is the dispatcher's mark, kept here because bringing a
 * message back by hand reads it too (see wakeNow).
 */
export const SNOOZE_CHECKED_KEY = 'snooze_checked_at';
/**
 * An outbox entry (n) whose message (s) is put off and still to come: held for
 * that time rather than failing. One parameter, the clock. COALESCE, because a
 * comparison with a row that is not there is NULL, and NOT NULL excludes too.
 */
const HELD_FOR_SNOOZE = 'COALESCE(s.snoozed_until > ? AND s.handled_at IS NULL, 0)';
/** A mark no older than this says a dispatcher is keeping the time: it looks once a minute. */
const FRESH_WAKE_MARK_MS = 3 * 60_000;
/** Nobody may be reading the list (notifications off); it must not grow without end. */
const MAX_REJUDGED = 200;
/** How far back the change signature looks; a little past the widest window the page offers. */
const SIGNATURE_WINDOW_DAYS = 35;
/** More than anyone has browsers; the oldest gives way to the newest. */
const MAX_PUSH_SUBSCRIPTIONS = 50;
/** What a sign-in link summary starts with, whichever of its two wordings was stored. */
const SIGN_IN_LINK_SUMMARY_PREFIX = SIGN_IN_LINK_SUMMARY.replace(/[。.]$/, '');

// ---- The owner's own mail, stored for the conversation ----

/** The most of what the owner wrote that one stored sent row keeps. */
export const SENT_TEXT_CHARS = 8000;
/** A conversation as the reader and MCP show it: this many messages at most. */
export const CONVERSATION_LIMIT = 50;
/** Who the audit says took a message off the queue when a reply was found in Sent. */
export const SENT_FOLDER_CLIENT = 'sent-folder';
/** Unchecked sent rows held against the queue in one pass; the rest wait for the next. */
const ANSWER_BATCH = 500;
/** A message counts for an address at full weight when new, half after this many days, a quarter after twice. */
const CONTACT_HALF_LIFE_DAYS = 30;
/** Rows read per source when ranking addresses: the newest, which is where the weight is. */
const CONTACT_SCAN_ROWS = 5000;
export const MAX_CONTACTS = 20;
/** What the model files a person writing under. */
const PERSONAL_CATEGORIES = new Set(['Personal', 'Work']);
/** What it files bulk, notices and copies under. */
const BULK_CATEGORIES = new Set(['Marketing', 'Social', 'System', 'Forwarded copy']);
/** The local part of an address that writes for a machine, not a person. */
const AUTOMATED_LOCAL =
  /^(?:do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster|bounces?|notifications?|notify|alerts?|newsletters?|news|marketing|updates?|digest|automated|system|info|support|hello|reports?|billing|receipts?|orders?|notices?|statements?)(?:[-_.+].*)?$|no[-_.]?reply/;
/** A received row that is a copy of one of the owner's own sent messages: the same mailbox and Message-ID. */
const OWN_COPY = 'EXISTS (SELECT 1 FROM sent_mail o WHERE o.account = seen.account AND o.message_id = seen.message_id)';
/** Han, kana and hangul: a name in these is matched anywhere in it, not by its words. */
const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯]/;

function sentAddresses(value: unknown): { to: SentAddress[]; cc: SentAddress[]; bcc: SentAddress[] } {
  const out = { to: [] as SentAddress[], cc: [] as SentAddress[], bcc: [] as SentAddress[] };
  let list: unknown;
  try {
    list = JSON.parse(String(value ?? '[]'));
  } catch {
    return out;
  }
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const kind = entry['kind'];
    if (kind !== 'to' && kind !== 'cc' && kind !== 'bcc') continue;
    const address = typeof entry['address'] === 'string' ? entry['address'] : '';
    if (!address) continue;
    out[kind].push({ name: typeof entry['name'] === 'string' ? entry['name'] : '', address });
  }
  return out;
}

function stringList(value: unknown): string[] {
  try {
    const list = JSON.parse(String(value ?? '[]')) as unknown;
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function toSentRow(raw: Record<string, unknown>): SentRow {
  const source = raw['source'];
  return {
    id: Number(raw['id']),
    account: String(raw['account'] ?? ''),
    accountLabel: (raw['account_label'] as string) ?? null,
    messageId: String(raw['message_id'] ?? ''),
    threadKey: String(raw['thread_key'] ?? ''),
    inReplyTo: (raw['in_reply_to'] as string) ?? null,
    answers: (raw['answers'] as string) ?? null,
    subject: (raw['subject'] as string) ?? null,
    fromAddr: (raw['from_addr'] as string) ?? null,
    fromName: (raw['from_name'] as string) ?? null,
    ...sentAddresses(raw['recipients']),
    date: (raw['mail_date'] as string) ?? null,
    text: String(raw['body'] ?? ''),
    attachmentCount: Number(raw['attachment_count'] ?? 0),
    attachmentNames: stringList(raw['attachment_names']),
    folder: (raw['folder'] as string) ?? null,
    source: source === 'page' || source === 'mcp' ? source : 'poll',
    answeredKey: (raw['answered_key'] as string) ?? null,
    createdAt: String(raw['created_at'] ?? ''),
  };
}

/** Every recipient is one of the owner's own addresses (or there is none): nobody else was answered. */
export function toOwnOnly(recipients: readonly SentAddress[], own: readonly string[]): boolean {
  const mine = new Set(own.map((address) => address.trim().toLowerCase()));
  return recipients.every((r) => mine.has(r.address.trim().toLowerCase()));
}

/** A LIKE pattern for text that may hold the wildcards itself. */
const likeEscape = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Whether a query names an address or the name that goes with it: a prefix of
 * the address, of a word of its local part or of its domain, or of a word of
 * the name (every word of a query of several, in any order); a name in
 * Chinese, Japanese or Korean, anywhere in it. The query is lowercased already.
 */
export function contactMatches(query: string, name: string, address: string): boolean {
  const addr = address.toLowerCase();
  if (addr.startsWith(query)) return true;
  const at = addr.lastIndexOf('@');
  const local = at > 0 ? addr.slice(0, at) : addr;
  const domain = at > 0 ? addr.slice(at + 1) : '';
  if (local.split(/[._+-]+/).some((part) => part.startsWith(query))) return true;
  if (domain.startsWith(query) || domain.split('.').some((part) => part.startsWith(query))) return true;
  const n = name.normalize('NFKC').toLowerCase().trim();
  if (!n) return false;
  if (n.startsWith(query) || (CJK.test(query) && n.includes(query))) return true;
  const words = n.split(/[\s,.;:'"()<>[\]@/_-]+/).filter(Boolean);
  const parts = query.split(/\s+/).filter(Boolean);
  return parts.length > 0 && parts.every((part) => words.some((word) => word.startsWith(part) || (CJK.test(part) && word.includes(part))));
}

/** How much one message adds to an address: one when new, halving every CONTACT_HALF_LIFE_DAYS. */
function weightOf(at: string | null, now: number): number {
  const time = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(time)) return 0.1;
  const days = Math.max(0, now - time) / 86_400_000;
  return 0.5 ** (days / CONTACT_HALF_LIFE_DAYS);
}

function now(): string {
  return new Date().toISOString();
}

function retrySeconds(name: string, fallback: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value >= 1 ? Math.min(Math.floor(value), maximum) : fallback;
}

function auditTargetValue(value: string | undefined): string | null {
  if (!value) return null;
  // Targets are identifiers for investigation, not a place to retain URL
  // query strings that may contain tracking values or bearer-like tokens.
  return value.replace(/[\r\n\t]+/g, ' ').replace(/[?].*$/s, '').slice(0, 1000) || null;
}

export function notificationRetryDelayMs(attempt: number): number {
  const baseSeconds = retrySeconds('OUTBOX_RETRY_BASE_SECONDS', 60, 86_400);
  const maxSeconds = retrySeconds('OUTBOX_RETRY_MAX_SECONDS', 3_600, 7 * 86_400);
  const safeAttempt = Math.max(1, Math.floor(attempt));
  return Math.min(maxSeconds, baseSeconds * 2 ** Math.min(safeAttempt - 1, 30)) * 1000;
}

const ROW_COLUMNS = [
  'dedup_key', 'message_id', 'thread_key', 'account', 'account_label', 'subject', 'sender', 'sender_name',
  'folder', 'in_spam', 'importance', 'category', 'summary', 'reason', 'deadline',
  'decided_by', 'pushed', 'withheld', 'mail_date', 'attachments_json', 'verification_code', 'handled_at', 'snoozed_until', 'created_at',
] as const;

function parseAttachmentManifest(value: unknown): AttachmentManifest | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<AttachmentManifest>;
    if (!parsed || !Array.isArray(parsed.items)) return null;
    const items = parsed.items.filter((item) => {
      if (!item || typeof item !== 'object') return false;
      const attachment = item as unknown as Record<string, unknown>;
      return typeof attachment['partId'] === 'string'
        && /^\d+(?:\.\d+)*$/.test(attachment['partId'])
        && typeof attachment['contentType'] === 'string'
        && typeof attachment['inline'] === 'boolean';
    }).slice(0, 100).map((item) => {
      const attachment = { ...(item as unknown as Record<string, unknown>) };
      // Recompute warnings from the stored filename and MIME metadata so older
      // rows gain the hints too and a persisted field cannot assert its own risk.
      delete attachment['safetyWarnings'];
      const safetyWarnings = attachmentSafetyWarnings({
        filename: typeof attachment['filename'] === 'string' ? attachment['filename'] : undefined,
        contentType: String(attachment['contentType']),
      });
      return {
        ...attachment,
        ...(safetyWarnings.length ? { safetyWarnings } : {}),
      } as unknown as AttachmentInfo;
    });
    return { items, truncated: parsed.truncated === true };
  } catch {
    return null;
  }
}

function toRow(raw: Record<string, unknown>): MailRow {
  return {
    dedupKey: String(raw['dedup_key'] ?? ''),
    messageId: (raw['message_id'] as string) ?? null,
    threadKey: (raw['thread_key'] as string) ?? null,
    account: String(raw['account'] ?? ''),
    accountLabel: (raw['account_label'] as string) ?? null,
    subject: (raw['subject'] as string) ?? null,
    sender: (raw['sender'] as string) ?? null,
    senderName: (raw['sender_name'] as string) ?? null,
    folder: (raw['folder'] as string) ?? null,
    inSpam: Boolean(raw['in_spam']),
    importance: (raw['importance'] as string) ?? null,
    category: (raw['category'] as string) ?? null,
    summary: (raw['summary'] as string) ?? null,
    reason: (raw['reason'] as string) ?? null,
    deadline: (raw['deadline'] as string) ?? null,
    decidedBy: (raw['decided_by'] as string) ?? null,
    pushed: Boolean(raw['pushed']),
    withheld: Boolean(raw['withheld']),
    mailDate: (raw['mail_date'] as string) ?? null,
    createdAt: String(raw['created_at'] ?? ''),
    handledAt: (raw['handled_at'] as string) ?? null,
    snoozedUntil: (raw['snoozed_until'] as string) ?? null,
    ...(raw['snippet'] !== undefined ? { snippet: raw['snippet'] as string } : {}),
    ...(raw['verification_code'] ? { verificationCode: String(raw['verification_code']) } : {}),
    attachmentManifest: parseAttachmentManifest(raw['attachments_json']),
  };
}

function toPushSubscription(raw: Record<string, unknown>): PushSubscriptionRow {
  return {
    endpoint: String(raw['endpoint'] ?? ''),
    p256dh: String(raw['p256dh'] ?? ''),
    auth: String(raw['auth'] ?? ''),
    // Anything but the narrower choice reads as the default one.
    level: raw['level'] === 'critical' ? 'critical' : 'warning',
    codes: Boolean(raw['codes']),
    lang: String(raw['lang'] ?? 'en'),
    label: (raw['label'] as string) ?? null,
    origin: (raw['origin'] as string) ?? null,
    createdAt: String(raw['created_at'] ?? ''),
    lastOkAt: (raw['last_ok_at'] as string) ?? null,
    failures: Number(raw['failures'] ?? 0),
    credential: String(raw['credential'] ?? ''),
  };
}

const LOCAL_LABEL_MIGRATION_KEY = 'migrated_local_labels';
/** Set once the owner's earlier decisions have been read from the audit into seen.kept_at. */
const KEPT_BACKFILL_KEY = 'migrated_kept_at';

export class StateStore {
  private readonly db: DatabaseSync;

  constructor(path: string = process.env.STATE_DB_PATH ?? 'data/mailsift.db') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // The poller, its embedded MCP handler, the Docker healthcheck, and a
    // standalone stdio MCP process can all open this file. WAL separates readers
    // from the writer, but a second writer must wait for the lock instead of
    // failing immediately with SQLITE_BUSY. Set the timeout before switching the
    // journal mode, because that switch also needs the write lock.
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
    // Additive migration for databases created before attachment metadata was
    // exposed. Multiple service processes may open the same DB concurrently.
    const seenColumns = this.db.prepare('PRAGMA table_info(seen)').all() as Array<Record<string, unknown>>;
    for (const [name, definition] of [
      ['attachments_json', 'TEXT'], ['thread_key', 'TEXT'], ['verification_code', 'TEXT'], ['handled_at', 'TEXT'],
      ['uid', 'INTEGER'], ['uid_validity', 'TEXT'], ['snoozed_until', 'TEXT'],
      ['kept_at', 'TEXT'], ['withheld', 'INTEGER NOT NULL DEFAULT 0'], ['done_by_spam', 'INTEGER NOT NULL DEFAULT 0'],
    ] as const) {
      if (seenColumns.some((column) => column['name'] === name)) continue;
      try {
        this.db.exec(`ALTER TABLE seen ADD COLUMN ${name} ${definition}`);
      } catch (error) {
        if (!String(error).toLowerCase().includes('duplicate column name')) throw error;
      }
    }
    const outboxColumns = this.db.prepare('PRAGMA table_info(notification_outbox)').all() as Array<Record<string, unknown>>;
    if (!outboxColumns.some((column) => column['name'] === 'next_attempt_at')) {
      try {
        this.db.exec('ALTER TABLE notification_outbox ADD COLUMN next_attempt_at TEXT');
      } catch (error) {
        if (!String(error).toLowerCase().includes('duplicate column name')) throw error;
      }
    }
    const auditColumns = this.db.prepare('PRAGMA table_info(mcp_audit)').all() as Array<Record<string, unknown>>;
    if (!auditColumns.some((column) => column['name'] === 'target')) {
      try {
        this.db.exec('ALTER TABLE mcp_audit ADD COLUMN target TEXT');
      } catch (error) {
        if (!String(error).toLowerCase().includes('duplicate column name')) throw error;
      }
    }
    const actionColumns = this.db.prepare('PRAGMA table_info(mail_actions)').all() as Array<Record<string, unknown>>;
    if (!actionColumns.some((column) => column['name'] === 'client')) {
      try {
        this.db.exec('ALTER TABLE mail_actions ADD COLUMN client TEXT');
      } catch (error) {
        if (!String(error).toLowerCase().includes('duplicate column name')) throw error;
      }
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_outbox_retry ON notification_outbox (delivered_at, next_attempt_at, created_at)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_seen_thread ON seen (thread_key, created_at)');
    // Only the few rows with a reminder are in it, which is what the waker
    // and the list of what is put off look for.
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_seen_snoozed ON seen (snoozed_until) WHERE snoozed_until IS NOT NULL');
    // A reply found in Sent names the message it answers by Message-ID, and
    // a record is looked up by one; without this each lookup reads every row.
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_seen_message_id ON seen (message_id)');
    // The rules read feedback by label on every poll.
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_feedback_label ON feedback (label, dedup_key)');
    // Before 0.1.98, code mail mailsift handled itself was labelled
    // 'fallback', which reads as a failed model and made it a candidate for
    // re-triage after an LLM outage, where its stored code was lost. It was
    // judged locally; say so, once.
    if (this.getMeta(LOCAL_LABEL_MIGRATION_KEY) === undefined) {
      this.db.prepare(`UPDATE seen SET decided_by = 'local' WHERE decided_by = 'fallback' AND summary LIKE ?`)
        .run(`${VERIFICATION_SUMMARY_PREFIX}%`);
      this.setMeta(LOCAL_LABEL_MIGRATION_KEY, new Date().toISOString());
    }
    // Stamped the first time a release with the queue opens the database, so
    // the queue starts at the upgrade rather than at the first visit after it.
    // Read first: this constructor runs for every web request, and a write
    // that changes nothing would still queue behind the poller's lock.
    // The owner's decisions about a message from before kept_at existed are in
    // the audit: read once, so a reply in Sent dated before one of them (the
    // first look back reads a month) never overrides it.
    if (this.getMeta(KEPT_BACKFILL_KEY) === undefined && this.casMeta(KEPT_BACKFILL_KEY, undefined, now())) {
      this.backfillKeptAt();
    }
    if (this.getMeta(ATTENTION_SINCE_KEY) === undefined) {
      this.db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(ATTENTION_SINCE_KEY, now());
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- UID cursors ----

  getCursor(account: string, folder: string): { uidValidity: string; lastUid: number } | undefined {
    const row = this.db
      .prepare('SELECT uid_validity, last_uid FROM cursors WHERE account = ? AND folder = ?')
      .get(account, folder) as Record<string, unknown> | undefined;
    return row
      ? { uidValidity: String(row['uid_validity']), lastUid: Number(row['last_uid']) }
      : undefined;
  }

  saveCursor(account: string, folder: string, uidValidity: string, lastUid: number): void {
    this.db
      .prepare(
        `INSERT INTO cursors (account, folder, uid_validity, last_uid, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account, folder) DO UPDATE SET
           uid_validity = excluded.uid_validity,
           last_uid = excluded.last_uid,
           updated_at = excluded.updated_at`,
      )
      .run(account, folder, uidValidity, lastUid, now());
  }

  /**
   * Move a cursor forward. Unlike saveCursor it never rewinds within the same
   * UIDVALIDITY: a wake-up fetch and a scheduled poll can commit the same
   * folder in either order, and the later one may have seen fewer messages.
   */
  advanceCursor(account: string, folder: string, uidValidity: string, lastUid: number): void {
    this.db
      .prepare(
        `INSERT INTO cursors (account, folder, uid_validity, last_uid, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account, folder) DO UPDATE SET
           last_uid = CASE WHEN cursors.uid_validity = excluded.uid_validity
                           THEN MAX(cursors.last_uid, excluded.last_uid)
                           ELSE excluded.last_uid END,
           uid_validity = excluded.uid_validity,
           updated_at = excluded.updated_at`,
      )
      .run(account, folder, uidValidity, lastUid, now());
  }

  /**
   * Fallback messages still waiting in the digest and without an active push
   * retry. The digest join is the delivery boundary: messages already sent or
   * removed from the queue are never reconsidered.
   */
  fallbackDigestRows(): MailRow[] {
    const rows = this.db.prepare(
      `SELECT s.* FROM seen s
       JOIN digest_queue d ON d.dedup_key = s.dedup_key
       LEFT JOIN notification_outbox n
         ON n.notification_key = s.dedup_key AND n.delivered_at IS NULL
       WHERE s.decided_by = 'fallback' AND s.snippet IS NOT NULL
         AND n.notification_key IS NULL
       ORDER BY d.created_at`,
    ).all() as Array<Record<string, unknown>>;
    return rows.map(toRow);
  }

  /**
   * Every folder cursor, newest write first.
   *
   * Answers how far each folder has been processed, which is the first thing
   * to look at when a mailbox seems to be lagging.
   */
  listCursors(): CursorRow[] {
    return (
      this.db
        .prepare('SELECT account, folder, uid_validity, last_uid, updated_at FROM cursors ORDER BY updated_at DESC')
        .all() as Array<Record<string, unknown>>
    ).map((row) => ({
      account: String(row['account']),
      folder: String(row['folder']),
      uidValidity: String(row['uid_validity']),
      lastUid: Number(row['last_uid']),
      updatedAt: String(row['updated_at']),
    }));
  }

  clearCursors(account?: string): number {
    const result = account
      ? this.db.prepare('DELETE FROM cursors WHERE account = ?').run(account)
      : this.db.prepare('DELETE FROM cursors').run();
    return Number(result.changes);
  }

  // ---- Deduplication ----

  /** Read only. Marking waits until the message is fully processed. */
  isSeen(dedupKey: string): boolean {
    return this.db.prepare('SELECT 1 FROM seen WHERE dedup_key = ?').get(dedupKey) !== undefined;
  }

  /**
   * A message mailsift never stored that the owner moved by hand (into spam,
   * out of it, to the inbox or to any folder) from a folder listed live: the
   * owner has dealt with it, so where it lands it is not new mail, and the
   * poll does not judge, notify, queue or digest it. Kept as long as the rest.
   */
  fileByOwner(dedupKey: string, account: string): void {
    this.db.prepare('INSERT OR IGNORE INTO owner_filed (dedup_key, account, created_at) VALUES (?, ?, ?)')
      .run(dedupKey.slice(0, 1400), account.slice(0, 320), now());
  }

  /** Whether the owner filed this message by hand (see fileByOwner). */
  filedByOwner(dedupKey: string): boolean {
    return this.db.prepare('SELECT 1 FROM owner_filed WHERE dedup_key = ?').get(dedupKey) !== undefined;
  }

  markSeen(dedupKey: string, account: string, subject: string): boolean {
    const result = this.db
      .prepare('INSERT OR IGNORE INTO seen (dedup_key, account, subject, created_at) VALUES (?, ?, ?, ?)')
      .run(dedupKey, account, subject.slice(0, 300), now());
    return Number(result.changes) > 0;
  }

  recordOutcome(dedupKey: string, importance: string, pushed: boolean, fields: MailRecord = {}): void {
    const before = this.db.prepare('SELECT importance, pushed FROM seen WHERE dedup_key = ?').get(dedupKey) as
      | Record<string, unknown>
      | undefined;
    this.db
      .prepare(
        `UPDATE seen SET importance = ?, pushed = ?, message_id = ?, thread_key = ?, account_label = ?,
           sender = ?, sender_name = ?, folder = ?, in_spam = ?, category = ?,
           summary = ?, reason = ?, deadline = ?, decided_by = ?, mail_date = ?, snippet = ?, attachments_json = ?,
           verification_code = ?, uid = COALESCE(?, uid), uid_validity = COALESCE(?, uid_validity)
         WHERE dedup_key = ?`,
      )
      .run(
        importance, pushed ? 1 : 0,
        fields.messageId ?? null, fields.threadKey ?? null, fields.accountLabel ?? null,
        fields.sender ?? null, fields.senderName ?? null,
        fields.folder ?? null, fields.inSpam ? 1 : 0, fields.category ?? null,
        fields.summary ?? null, fields.reason ?? null, fields.deadline ?? null,
        fields.decidedBy ?? null, fields.mailDate ?? null, fields.snippet ?? null,
        fields.attachmentManifest ? JSON.stringify(fields.attachmentManifest) : null,
        fields.verificationCode ?? null,
        // A second verdict is made from the stored row and knows no UID; what the poll recorded stays.
        fields.uid && fields.uid > 0 && fields.uidValidity ? fields.uid : null,
        fields.uid && fields.uid > 0 && fields.uidValidity ? fields.uidValidity : null,
        dedupKey,
      );
    // A second verdict for a row that already had one. Its counts may be the
    // same as before, so the page is told through the revision, and a verdict
    // that now matters more is left for the notification dispatcher.
    if (before?.['importance']) {
      this.bumpMailRevision();
      if (before['importance'] !== importance || Boolean(before['pushed']) !== pushed) this.noteRejudged(dedupKey);
    }
  }

  /** Append one key to the re-judged list, in one statement so no reader can interleave. */
  private noteRejudged(dedupKey: string): void {
    this.db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, json_array(?))
       ON CONFLICT(key) DO UPDATE SET value = CASE
         WHEN NOT json_valid(value) THEN json_array(?)
         WHEN json_array_length(value) >= ? THEN value
         ELSE json_insert(value, '$[#]', ?) END`,
    ).run(REJUDGED_KEY, dedupKey, dedupKey, MAX_REJUDGED, dedupKey);
  }

  /** Count records marked without a triage result; normally zero. */
  countUndispatched(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM seen WHERE importance IS NULL').get() as
      | Record<string, unknown>
      | undefined;
    return Number(row?.['n'] ?? 0);
  }

  dropUndispatched(): number {
    return Number(this.db.prepare('DELETE FROM seen WHERE importance IS NULL').run().changes);
  }

  prune(keepDays = 90): number {
    const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();
    // A reminder may be asked for up to a year ahead, further than the rows
    // are kept. Its row stays until the reminder has come and its time in the
    // queue is over, or the owner would be promised a reminder that never comes.
    const reminded = new Date(Date.now() - ATTENTION_WINDOW_DAYS * 86_400_000).toISOString();
    const seen = Number(this.db.prepare(
      'DELETE FROM seen WHERE created_at < ? AND (snoozed_until IS NULL OR snoozed_until < ?)',
    ).run(cutoff, reminded).changes);
    const dead = Number(this.db.prepare('DELETE FROM dead_letter WHERE created_at < ?').run(cutoff).changes);
    const outbox = Number(this.db.prepare(
      'DELETE FROM notification_outbox WHERE delivered_at IS NOT NULL AND delivered_at < ?',
    ).run(cutoff).changes);
    const mcpAudit = Number(this.db.prepare('DELETE FROM mcp_audit WHERE created_at < ?').run(cutoff).changes);
    this.db.prepare('DELETE FROM owner_filed WHERE created_at < ?').run(cutoff);
    const mailActions = Number(this.db.prepare('DELETE FROM mail_actions WHERE created_at < ?').run(cutoff).changes);
    const digests = Number(this.db.prepare('DELETE FROM digest_log WHERE sent_at < ?').run(cutoff).changes);
    // The owner's own mail goes with the same retention, counted from the day
    // it was sent (a first look back stores a month of it at once), or from
    // the day it was stored when that is earlier, so a date in the future
    // does not keep a row for ever.
    const sent = Number(this.db.prepare(
      'DELETE FROM sent_mail WHERE MIN(COALESCE(mail_date, created_at), created_at) < ?',
    ).run(cutoff).changes);
    return seen + dead + outbox + mcpAudit + mailActions + digests + sent;
  }

  recordDeadLetter(input: {
    account: string; folder: string; uidValidity: string; uid: number;
    messageId: string; subject: string; reason: string;
  }): void {
    const deadKey = `${input.account}|${input.folder}|${input.uidValidity}|${input.uid}`;
    this.db.prepare(
      `INSERT OR IGNORE INTO dead_letter
       (dead_key, account, folder, uid_validity, uid, message_id, subject, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      deadKey, input.account, input.folder, input.uidValidity, input.uid,
      input.messageId || null, input.subject || null, input.reason, now(),
    );
  }

  listDeadLetters(limit = 50): DeadLetterRow[] {
    const rows = this.db.prepare(
      `SELECT dead_key, account, folder, uid_validity, uid, message_id, subject, reason, created_at
       FROM dead_letter ORDER BY created_at DESC LIMIT ?`,
    ).all(Math.max(1, Math.min(limit, 200))) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      deadKey: String(row['dead_key']),
      account: String(row['account']),
      folder: String(row['folder']),
      uidValidity: String(row['uid_validity']),
      uid: Number(row['uid']),
      messageId: (row['message_id'] as string) ?? null,
      subject: (row['subject'] as string) ?? null,
      reason: String(row['reason']),
      createdAt: String(row['created_at']),
    }));
  }

  retryDeadLetter(deadKey: string): boolean {
    const row = this.db.prepare(
      `SELECT account, folder, uid_validity, uid FROM dead_letter WHERE dead_key = ?`,
    ).get(deadKey) as Record<string, unknown> | undefined;
    if (!row) return false;

    const account = String(row['account']);
    const folder = String(row['folder']);
    const uidValidity = String(row['uid_validity']);
    const uid = Number(row['uid']);
    const cursor = this.getCursor(account, folder);
    if (cursor && cursor.uidValidity === uidValidity && cursor.lastUid >= uid) {
      this.saveCursor(account, folder, uidValidity, Math.max(0, uid - 1));
    }
    this.db.prepare('DELETE FROM dead_letter WHERE dead_key = ?').run(deadKey);
    return true;
  }

  enqueueNotification(notificationKey: string, message: MailMessage, result: TriageResult): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO notification_outbox
       (notification_key, payload, next_attempt_at, created_at) VALUES (?, ?, ?, ?)`,
    ).run(notificationKey, JSON.stringify({ message, result }), now(), now());
  }

  pendingNotifications(limit = 50, readyOnly = false): NotificationOutboxRow[] {
    const boundedLimit = Math.max(1, Math.min(limit, 200));
    const rows = readyOnly
      ? this.db.prepare(
        `SELECT notification_key, payload, attempts, last_error, next_attempt_at, created_at
         FROM notification_outbox
         WHERE delivered_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at LIMIT ?`,
      ).all(now(), boundedLimit)
      : this.db.prepare(
        `SELECT notification_key, payload, attempts, last_error, next_attempt_at, created_at
         FROM notification_outbox WHERE delivered_at IS NULL ORDER BY created_at LIMIT ?`,
      ).all(boundedLimit);
    const out: NotificationOutboxRow[] = [];
    for (const row of rows) {
      try {
        const payload = JSON.parse(String(row['payload'])) as { message: MailMessage; result: TriageResult };
        // Valid JSON of the wrong shape would otherwise reach every caller and
        // throw there instead of being skipped here.
        if (!payload?.message?.account || !payload?.result?.importance) {
          log.error(`Notification outbox record ${String(row['notification_key'])} has an unexpected shape`);
          continue;
        }
        out.push({
          notificationKey: String(row['notification_key']),
          message: payload.message,
          result: payload.result,
          attempts: Number(row['attempts']),
          lastError: (row['last_error'] as string) ?? null,
          nextAttemptAt: (row['next_attempt_at'] as string) ?? null,
          createdAt: String(row['created_at']),
        });
      } catch {
        log.error(`Notification outbox record ${String(row['notification_key'])} is corrupt`);
      }
    }
    return out;
  }

  markNotificationDelivered(notificationKey: string): void {
    const row = this.db.prepare(
      'SELECT payload FROM notification_outbox WHERE notification_key = ?',
    ).get(notificationKey) as Record<string, unknown> | undefined;
    let payload = row ? String(row['payload']) : undefined;
    if (payload) {
      try {
        const parsed = JSON.parse(payload) as {
          result?: { sensitiveVerification?: boolean; verificationCode?: string };
        };
        if (parsed.result?.sensitiveVerification && parsed.result.verificationCode) {
          delete parsed.result.verificationCode;
          payload = JSON.stringify(parsed);
        }
      } catch {
        // Delivery state must still be recorded if an older or corrupt payload cannot be parsed.
      }
    }
    if (payload !== undefined) {
      this.db.prepare(
        'UPDATE notification_outbox SET delivered_at = ?, last_error = NULL, next_attempt_at = NULL, payload = ? WHERE notification_key = ?',
      ).run(now(), payload, notificationKey);
    } else {
      this.db.prepare(
        'UPDATE notification_outbox SET delivered_at = ?, last_error = NULL, next_attempt_at = NULL WHERE notification_key = ?',
      ).run(now(), notificationKey);
    }
    // Delivered is notified, however late: on a retry, or when a held one's
    // time came. The row says so, for the queue, the "notified" mark and the
    // feedback asked about it, as it does for one delivered at once.
    this.db.prepare('UPDATE seen SET pushed = 1 WHERE dedup_key = ? AND pushed = 0').run(notificationKey);
  }

  /**
   * A notification owed for a message the owner dealt with before it could
   * go, in the page, through MCP or by answering it elsewhere: it is not
   * sent, its digest line goes with it, and the message is marked withheld,
   * so that putting it back returns it to the queue as a notified message
   * would. Who dealt with it makes no difference to that.
   */
  withholdNotification(notificationKey: string): void {
    this.db.prepare('DELETE FROM notification_outbox WHERE notification_key = ? AND delivered_at IS NULL').run(notificationKey);
    this.db.prepare('DELETE FROM digest_queue WHERE dedup_key = ?').run(notificationKey);
    this.db.prepare('UPDATE seen SET withheld = 1 WHERE dedup_key = ? AND withheld = 0').run(notificationKey);
  }

  /**
   * Forget an entry no output will ever accept.
   *
   * A declined notification is not a failed one: leaving it pending would grow
   * a backlog that never drains, and prune() only removes delivered rows.
   */
  dropNotification(notificationKey: string): void {
    this.db.prepare('DELETE FROM notification_outbox WHERE notification_key = ?').run(notificationKey);
  }

  markNotificationFailed(notificationKey: string, error: unknown): void {
    const row = this.db.prepare(
      'SELECT attempts FROM notification_outbox WHERE notification_key = ?',
    ).get(notificationKey) as Record<string, unknown> | undefined;
    if (!row) return;
    const attempts = Number(row['attempts'] ?? 0) + 1;
    const nextAttemptAt = new Date(Date.now() + notificationRetryDelayMs(attempts)).toISOString();
    this.db.prepare(
      `UPDATE notification_outbox SET attempts = ?, last_error = ?, next_attempt_at = ?
       WHERE notification_key = ?`,
    ).run(attempts, String(error).slice(0, 500), nextAttemptAt, notificationKey);
  }

  /** Hold a notification until a time, without counting an attempt: the owner put its message off until then. */
  deferNotification(notificationKey: string, until: string): void {
    this.db.prepare(
      'UPDATE notification_outbox SET next_attempt_at = ? WHERE notification_key = ? AND delivered_at IS NULL',
    ).run(until, notificationKey);
  }

  /**
   * Notifications not yet delivered, leaving out those held for a message the
   * owner put off: they wait for the time chosen, and are not a delivery
   * problem (see notificationOutboxHeld).
   */
  notificationOutboxPending(): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM notification_outbox n LEFT JOIN seen s ON s.dedup_key = n.notification_key
       WHERE n.delivered_at IS NULL AND NOT ${HELD_FOR_SNOOZE}`,
    ).get(now()) as Record<string, unknown>;
    return Number(row['n'] ?? 0);
  }

  /** Notifications held until the time the owner put their message off until. */
  notificationOutboxHeld(): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM notification_outbox n LEFT JOIN seen s ON s.dedup_key = n.notification_key
       WHERE n.delivered_at IS NULL AND ${HELD_FOR_SNOOZE}`,
    ).get(now()) as Record<string, unknown>;
    return Number(row['n'] ?? 0);
  }

  notificationOutboxDelayed(): number {
    const at = now();
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM notification_outbox n LEFT JOIN seen s ON s.dedup_key = n.notification_key
       WHERE n.delivered_at IS NULL AND n.next_attempt_at > ? AND NOT ${HELD_FOR_SNOOZE}`,
    ).get(at, at) as Record<string, unknown>;
    return Number(row['n'] ?? 0);
  }

  recordFeedback(messageId: string, label: FeedbackLabel, note = '', dedupKey?: string): void {
    // The caller may already know which stored copy it means; otherwise the id is looked up.
    const found = dedupKey
      ? (this.db.prepare('SELECT dedup_key FROM seen WHERE dedup_key = ?').get(dedupKey) as Record<string, unknown> | undefined)
      : undefined;
    const key = dedupKey ? (found ? String(found['dedup_key']) : undefined) : this.keyOf(messageId);
    const row = key === undefined ? undefined : { dedup_key: key };
    this.db.prepare(
      'INSERT INTO feedback (message_id, dedup_key, label, note, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(messageId, row ? String(row['dedup_key']) : null, label, note.slice(0, 1000), now());
    // "Handled" said through MCP takes the message off the page's queue too,
    // so an agent and the reader never disagree about what is still open.
    if (label === 'handled' && row) this.setHandled(String(row['dedup_key']), true);
  }

  feedbackSummary(): Record<string, number> {
    const summary: Record<string, number> = {};
    for (const row of this.db.prepare(
      'SELECT label, COUNT(*) AS n FROM feedback GROUP BY label ORDER BY label',
    ).all() as Array<Record<string, unknown>>) {
      summary[String(row['label'])] = Number(row['n']);
    }
    return summary;
  }

  feedbackRuleHints(minSamples = 2): { alwaysImportant: string[]; neverImportant: string[] } {
    const rows = this.db.prepare(
      // Counted in messages, not labels: one message marked twice is one
      // vote, or a single misjudged mail could mute its sender for good. A
      // message put in the spam folder is a vote that the sender does not
      // matter, as a false positive is, until the owner takes one of the
      // sender's messages out of spam again.
      // The latest not_spam per sender is worked out once, not once per vote.
      `WITH cleared AS (
         SELECT lower(t.sender) AS sender, MAX(g.id) AS id FROM feedback g JOIN seen t ON t.dedup_key = g.dedup_key
         WHERE g.label = 'not_spam' AND t.sender IS NOT NULL GROUP BY lower(t.sender))
       SELECT s.sender, CASE WHEN f.label = 'spam' THEN 'false_positive' ELSE f.label END AS vote, COUNT(DISTINCT f.dedup_key) AS n
       FROM feedback f JOIN seen s ON s.dedup_key = f.dedup_key
       LEFT JOIN cleared c ON c.sender = lower(s.sender)
       WHERE s.sender IS NOT NULL AND s.sender != ''
         AND (f.label IN ('missed', 'false_positive') OR (f.label = 'spam' AND (c.id IS NULL OR c.id < f.id)))
       GROUP BY s.sender, vote HAVING COUNT(DISTINCT f.dedup_key) >= ?`,
    ).all(Math.max(1, minSamples)) as Array<Record<string, unknown>>;
    const alwaysImportant: string[] = [];
    const neverImportant: string[] = [];
    for (const row of rows) {
      const sender = String(row['sender']).toLowerCase();
      if (row['vote'] === 'missed') alwaysImportant.push(sender);
      if (row['vote'] === 'false_positive' && !neverImportant.includes(sender)) neverImportant.push(sender);
    }
    return { alwaysImportant, neverImportant };
  }

  observability(): Record<string, unknown> {
    const totals = this.db.prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(pushed), 0) AS pushed,
              COALESCE(SUM(CASE WHEN importance IS NULL THEN 1 ELSE 0 END), 0) AS undecided
       FROM seen`,
    ).get() as Record<string, unknown>;
    return {
      seenTotal: Number(totals['total']),
      pushedTotal: Number(totals['pushed']),
      undecidedTotal: Number(totals['undecided']),
      deadLetterTotal: this.listDeadLetters(200).length,
      notificationOutboxPending: this.notificationOutboxPending(),
      notificationOutboxDelayed: this.notificationOutboxDelayed(),
      notificationOutboxHeld: this.notificationOutboxHeld(),
      feedback: this.feedbackSummary(),
      mailActionTotal: Number((this.db.prepare('SELECT COUNT(*) AS n FROM mail_actions').get() as Record<string, unknown>)['n'] ?? 0),
      mailActionFailures: Number((this.db.prepare('SELECT COUNT(*) AS n FROM mail_actions WHERE success = 0').get() as Record<string, unknown>)['n'] ?? 0),
      mcpAuditEvents: Number((this.db.prepare('SELECT COUNT(*) AS n FROM mcp_audit').get() as Record<string, unknown>)['n'] ?? 0),
      mcpAuditByAction: this.mcpAuditByAction(),
    };
  }

  /**
   * Audit rows grouped by the tool that ran.
   *
   * Without this the table is write-only: it can say how many calls arrived
   * but not whether a state-changing tool was ever among them, which is the
   * one question worth asking of it.
   */
  mcpAuditByAction(): Array<{ action: string; calls: number; failures: number; lastAt: string; clients: number }> {
    return (
      this.db
        .prepare(
          `SELECT action, COUNT(*) AS calls,
                  COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS failures,
                  MAX(created_at) AS last_at, COUNT(DISTINCT client) AS clients
           FROM mcp_audit GROUP BY action ORDER BY calls DESC, action ASC`,
        )
        .all() as Array<Record<string, unknown>>
    ).map((row) => ({
      action: String(row['action']),
      calls: Number(row['calls']),
      failures: Number(row['failures']),
      lastAt: String(row['last_at'] ?? ''),
      clients: Number(row['clients']),
    }));
  }

  recordMcpAudit(action: string, client: string, success: boolean, target?: string): void {
    this.db.prepare(
      'INSERT INTO mcp_audit (action, client, target, success, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      action.slice(0, 100), client.slice(0, 100), auditTargetValue(target), success ? 1 : 0, now(),
    );
  }

  listMcpAudit(limit = 50): McpAuditEvent[] {
    const rows = this.db.prepare(
      `SELECT action, client, target, success, created_at
       FROM mcp_audit ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(Math.max(1, Math.min(limit, 200))) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      action: String(row['action']),
      client: (row['client'] as string) ?? null,
      target: (row['target'] as string) ?? null,
      success: Boolean(row['success']),
      createdAt: String(row['created_at']),
    }));
  }

  // ---- Queries (MCP and troubleshooting) ----

  queryMail(options: QueryOptions = {}): MailRow[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (options.sinceHours !== undefined) {
      clauses.push('created_at >= ?');
      params.push(new Date(Date.now() - options.sinceHours * 3_600_000).toISOString());
    }
    if (options.importance) {
      clauses.push('importance = ?');
      params.push(options.importance);
    }
    // Exact match: categories are a fixed vocabulary, so a filter must not
    // behave like the substring search that `search` provides.
    if (options.category) {
      clauses.push('category = ?');
      params.push(options.category);
    }
    if (options.spamOnly) clauses.push('in_spam = 1');
    if (options.pushedOnly) clauses.push('pushed = 1');
    // A verification message without a stored code still belongs here: one
    // filed before codes were kept, or one whose code could not be extracted,
    // which is the one most worth opening.
    if (options.codesOnly) {
      clauses.push("((verification_code IS NOT NULL AND verification_code != '') OR summary LIKE ?)");
      params.push(`${VERIFICATION_SUMMARY_PREFIX}%`);
    }
    if (options.account) {
      clauses.push('(account = ? OR account_label = ?)');
      params.push(options.account, options.account);
    }
    if (options.search) {
      clauses.push(
        '(subject LIKE ? OR message_id LIKE ? OR thread_key LIKE ? OR sender LIKE ? OR sender_name LIKE ? '
          + 'OR reason LIKE ? OR category LIKE ? OR summary LIKE ? OR snippet LIKE ? OR attachments_json LIKE ?)',
      );
      params.push(...Array<string>(10).fill(`%${options.search}%`));
    }
    if (options.beforeCreatedAt) {
      if (options.beforeDedupKey) {
        clauses.push('(created_at < ? OR (created_at = ? AND dedup_key < ?))');
        params.push(options.beforeCreatedAt, options.beforeCreatedAt, options.beforeDedupKey);
      } else {
        clauses.push('created_at < ?');
        params.push(options.beforeCreatedAt);
      }
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(Math.max(1, Math.min(options.limit ?? 50, 200)));

    return (
      this.db
        .prepare(`SELECT ${ROW_COLUMNS.join(', ')} FROM seen ${where} ORDER BY created_at DESC, dedup_key DESC LIMIT ?`)
        .all(...params) as Array<Record<string, unknown>>
    ).map(toRow);
  }

  /**
   * Whether a string has the shape of a record key: an email address, a bar,
   * and the rest. A real Message-ID ("<...>", or a bare one with no bar
   * after an address) never does; a look-alike's does. Decided by shape
   * alone, so that it holds after retention has removed every record of a
   * mailbox, and for a mailbox no longer configured.
   */
  keyShaped(value: string): boolean {
    const text = value.trim();
    if (text.startsWith('<')) return false;
    const bar = text.indexOf('|');
    if (bar <= 0) return false;
    return /^[^\s@<>|]+@[^\s@<>|]+$/.test(text.slice(0, bar));
  }

  /**
   * Every stored record a Message-ID or a key names, with its mailbox. One
   * message can be stored once per mailbox (a forwarded copy, or a message
   * addressed to two of them), and getMail returns only one of those.
   */
  recordsFor(messageId: string): Array<{ dedupKey: string; account: string; by: 'messageId' | 'key' }> {
    // Every record the string names: as a Message-ID (one per mailbox it was
    // stored for), and as a record's own key. A sender can write a Message-ID
    // that spells another record's key, so a string can name both; the caller
    // decides what to do with that rather than this picking one.
    const byKeyAll = (this.db.prepare('SELECT dedup_key, account FROM seen WHERE dedup_key = ?')
      .all(messageId) as Array<Record<string, unknown>>)
      .map((row) => ({ dedupKey: String(row['dedup_key']), account: String(row['account'] ?? ''), by: 'key' as const }));
    // A string shaped like a key is matched as a Message-ID only to show that
    // it is also one, beside the record whose key it is. On its own it names
    // nothing: that record is gone, and the look-alike is not it.
    if (this.keyShaped(messageId) && !byKeyAll.length) return [];
    const byId = (this.db.prepare(
      'SELECT dedup_key, account FROM seen WHERE message_id = ? ORDER BY created_at, dedup_key',
    ).all(messageId) as Array<Record<string, unknown>>)
      .map((row) => ({ dedupKey: String(row['dedup_key']), account: String(row['account'] ?? ''), by: 'messageId' as const }));
    const byKey = byKeyAll.filter((row) => !byId.some((other) => other.dedupKey === row.dedupKey));
    return [...byId, ...byKey];
  }

  /**
   * The stored records of one mailbox for these Message-IDs, by Message-ID:
   * what a folder listed live from that mailbox already knows about. A record
   * is one mailbox's, so a message stored for another mailbox is not one of them.
   */
  storedFor(account: string, messageIds: readonly string[]): Map<string, MailRow> {
    const found = new Map<string, MailRow>();
    const wanted = [...new Set(messageIds.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 1000))];
    for (let at = 0; at < wanted.length; at += 200) {
      const chunk = wanted.slice(at, at + 200);
      const rows = this.db.prepare(
        `SELECT ${ROW_COLUMNS.join(', ')}, snippet FROM seen WHERE account = ? AND message_id IN (${chunk.map(() => '?').join(', ')})`,
      ).all(account, ...chunk) as Array<Record<string, unknown>>;
      for (const raw of rows) {
        const row = toRow(raw);
        if (row.messageId && !found.has(row.messageId)) found.set(row.messageId, row);
      }
    }
    return found;
  }

  getMail(messageId: string): MailRow | undefined {
    const key = this.keyOf(messageId);
    if (key === undefined) return undefined;
    const row = this.db.prepare(`SELECT ${ROW_COLUMNS.join(', ')}, snippet FROM seen WHERE dedup_key = ?`)
      .get(key) as Record<string, unknown> | undefined;
    return row ? toRow(row) : undefined;
  }

  // ---- The "needs you" queue ----

  /**
   * The record a page link, a key or a Message-ID names.
   *
   * A record's key is its own name and is tried first. Failing that, a
   * Message-ID, the first stored copy of it; but never a string shaped like a
   * key (see keyShaped). A sender can write a Message-ID that spells a key,
   * and such a string must not fall through to that look-alike when the
   * record it names is gone.
   */
  private keyOf(idOrKey: string): string | undefined {
    const exact = this.db.prepare('SELECT dedup_key FROM seen WHERE dedup_key = ?').get(idOrKey) as Record<string, unknown> | undefined;
    if (exact) return String(exact['dedup_key']);
    if (this.keyShaped(idOrKey)) return undefined;
    const byId = this.db.prepare(
      'SELECT dedup_key FROM seen WHERE message_id = ? ORDER BY created_at, dedup_key LIMIT 1',
    ).get(idOrKey) as Record<string, unknown> | undefined;
    return byId ? String(byId['dedup_key']) : undefined;
  }

  /**
   * Mark a message dealt with, or put it back.
   *
   * This is mailsift's own note about the message, not a mailbox flag: it
   * takes the row out of the queue on every device and changes nothing at the
   * provider. Marking twice keeps the first time.
   */
  /**
   * Done, or not. `bySpam`: it is put in spam, which counts it as done until
   * it is taken out again (see undoSpamDone). Any other change to whether it
   * is done, or to its reminder, is the owner's own, and Not spam leaves it.
   */
  setHandled(idOrKey: string, handled: boolean, bySpam = false): MailRow | undefined {
    const key = this.keyOf(idOrKey);
    if (key === undefined) return undefined;
    // Putting a message back is the owner's decision that it is still to deal
    // with, and is remembered (kept_at), so that a reply found in Sent later,
    // one written before that decision, does not take it away again.
    const result = handled
      ? this.db.prepare('UPDATE seen SET handled_at = ?, done_by_spam = ? WHERE dedup_key = ? AND handled_at IS NULL').run(now(), bySpam ? 1 : 0, key)
      : this.db.prepare('UPDATE seen SET handled_at = NULL, kept_at = ?, done_by_spam = 0 WHERE dedup_key = ? AND handled_at IS NOT NULL').run(now(), key);
    if (Number(result.changes) > 0) this.bumpMailRevision();
    return this.getMail(key);
  }

  /**
   * Taken out of spam: open again if being put in spam is what made it done,
   * and nothing changed it since. One the owner marked done stays done.
   */
  undoSpamDone(dedupKey: string): MailRow | undefined {
    const result = this.db.prepare(
      'UPDATE seen SET handled_at = NULL, kept_at = ?, done_by_spam = 0 WHERE dedup_key = ? AND done_by_spam = 1 AND handled_at IS NOT NULL',
    ).run(now(), dedupKey);
    if (Number(result.changes) > 0) this.bumpMailRevision();
    return this.getMail(dedupKey);
  }

  /** When the queue starts; see ATTENTION_SINCE_KEY. Set on first use if an older file lacks it. */
  attentionSince(): string {
    const stored = this.getMeta(ATTENTION_SINCE_KEY);
    if (stored) return stored;
    const at = now();
    this.casMeta(ATTENTION_SINCE_KEY, undefined, at);
    return this.getMeta(ATTENTION_SINCE_KEY) || at;
  }

  /**
   * What belongs in the queue: mail that was notified or judged critical and
   * that nobody has marked handled.
   *
   * A verification code or a sign-in link is not a to-do, it is gone in
   * minutes; mailsift's own health alerts and digests are not mail. Both stay
   * out, as does anything older than the queue itself or than a month. A
   * message the owner asked to be reminded of is out until that time, and
   * in from then on (see queueRule).
   */
  private attentionWhere(): { clause: string; params: string[] } {
    const rule = this.queueRule();
    return { clause: `handled_at IS NULL AND ${rule.clause}`, params: rule.params };
  }

  /**
   * What belongs in the queue, whether or not it has been dealt with.
   *
   * A row with a reminder goes by the reminder alone. Before its time it is
   * out, however it was judged. From its time on it is in, however it was
   * judged too, because the owner asked to be reminded of it, and the
   * queue's month is counted from the reminder rather than from the day the
   * message came, which may be long before.
   *
   * Notified means pushed, or withheld: due a notification that was not
   * sent because the owner had already answered the message from another
   * client (see handleAnswered), so that putting it back returns it here.
   *
   * The two cases are written as two halves of an OR, each bounded by a
   * column of its own, rather than as one CASE: SQLite then reads the first
   * half through the created_at index and the second through the index of
   * reminders, where a CASE would make it read every row kept.
   */
  private queueRule(): { clause: string; params: string[] } {
    const at = now();
    const start = this.queueStart(at);
    return {
      clause:
        `((snoozed_until IS NULL
           AND importance IS NOT NULL
           AND (pushed = 1 OR withheld = 1 OR importance = 'critical')
           AND (verification_code IS NULL OR verification_code = '')
           AND (summary IS NULL OR (summary NOT LIKE ? AND summary NOT LIKE ?))
           AND (decided_by IS NULL OR decided_by NOT IN ('health', 'digest'))
           AND created_at >= ?)
         OR (snoozed_until <= ? AND snoozed_until >= ?))`,
      params: [`${VERIFICATION_SUMMARY_PREFIX}%`, `${SIGN_IN_LINK_SUMMARY_PREFIX}%`, start, at, start],
    };
  }

  /** The earliest moment a row can count from and still be in the queue: its first day, or a month ago. */
  private queueStart(at: string): string {
    const monthAgo = new Date(Date.parse(at) - ATTENTION_WINDOW_DAYS * 86_400_000).toISOString();
    const since = this.attentionSince();
    return since > monthAgo ? since : monthAgo;
  }

  /**
   * What was dealt with lately, most recently dealt with first.
   *
   * This is the way back for a message marked done. It has left the queue,
   * and the list shows a window of days that the message may be older than,
   * so without this it is on neither. `queued` says whether putting the
   * message back returns it to the queue.
   */
  recentlyHandled(limit = 20): Array<{ row: MailRow; queued: boolean }> {
    const rule = this.queueRule();
    const since = new Date(Date.now() - RECENTLY_HANDLED_DAYS * 86_400_000).toISOString();
    return (
      this.db.prepare(
        `SELECT ${ROW_COLUMNS.join(', ')}, (CASE WHEN ${rule.clause} THEN 1 ELSE 0 END) AS would_queue
         FROM seen WHERE handled_at IS NOT NULL AND handled_at >= ?
         ORDER BY handled_at DESC, dedup_key DESC LIMIT ?`,
      ).all(...rule.params, since, Math.max(1, Math.min(Math.floor(limit), 100))) as Array<Record<string, unknown>>
    ).map((raw) => ({ row: toRow(raw), queued: Boolean(raw['would_queue']) }));
  }

  /**
   * The queue, newest first: by when each row came into it, which for a
   * message that was put off is when its reminder came, not when it arrived.
   */
  attention(limit = 50): MailRow[] {
    const { clause, params } = this.attentionWhere();
    return (
      this.db.prepare(
        `SELECT ${ROW_COLUMNS.join(', ')} FROM seen WHERE ${clause}
         ORDER BY COALESCE(snoozed_until, created_at) DESC, dedup_key DESC LIMIT ?`,
      ).all(...params, Math.max(1, Math.min(Math.floor(limit), 200))) as Array<Record<string, unknown>>
    ).map(toRow);
  }

  /** How long the queue is, which is also the number on the app's badge. */
  attentionCount(): number {
    const { clause, params } = this.attentionWhere();
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM seen WHERE ${clause}`).get(...params) as Record<string, unknown>;
    return Number(row['n'] ?? 0);
  }

  /** Whether one message is in the queue now. */
  inAttention(idOrKey: string): boolean {
    const key = this.keyOf(idOrKey);
    if (key === undefined) return false;
    const { clause, params } = this.attentionWhere();
    return this.db.prepare(`SELECT 1 FROM seen WHERE dedup_key = ? AND ${clause}`).get(key, ...params) !== undefined;
  }

  // ---- Reminders: "not now, remind me then" ----

  /**
   * Put a message off until a time, or with null cancel that.
   *
   * Like handled, this is mailsift's own note and changes nothing at the
   * provider. Asking to be reminded of a message says it is not done, so a
   * message marked done is put back by it; cancelling leaves done alone.
   * `until` is stored as given, which the caller has made an ISO 8601 UTC
   * time; the queue compares it with the clock as text.
   */
  setSnoozed(idOrKey: string, until: string | null): MailRow | undefined {
    const key = this.keyOf(idOrKey);
    if (key === undefined) return undefined;
    // Every reminder set, moved, brought forward or taken away is the owner
    // deciding about the message now, after any reply already in Sent: kept_at
    // remembers when, as for a message put back (see setHandled).
    const result = until
      ? this.db.prepare(
        `UPDATE seen SET snoozed_until = ?, handled_at = NULL, kept_at = ?, done_by_spam = 0
         WHERE dedup_key = ? AND (snoozed_until IS NOT ? OR handled_at IS NOT NULL)`,
      ).run(until, now(), key, until)
      : this.db.prepare('UPDATE seen SET snoozed_until = NULL, kept_at = ? WHERE dedup_key = ? AND snoozed_until IS NOT NULL').run(now(), key);
    // Open pages move the row out of the queue, or back into it.
    if (Number(result.changes) > 0) {
      this.bumpMailRevision();
      // A notification held for the old time comes no later than the new one,
      // or at once when the reminder is taken away: Feishu and the webhook have
      // no reminder of their own, so it is theirs. A later time defers it again
      // when the old one comes, since the outbox reads the row before sending.
      const due = until ?? now();
      this.db.prepare(
        `UPDATE notification_outbox SET next_attempt_at = ?
         WHERE notification_key = ? AND delivered_at IS NULL AND next_attempt_at > ?`,
      ).run(due, key, due);
    }
    return this.getMail(key);
  }

  /**
   * Bring a message back now: its reminder counts as having come.
   *
   * This is "Back now", and the way back to a reminder that had come and was
   * then put off again. Cancelling the reminder instead would hand the row
   * back to its judgement, which leaves out a message that was not judged to
   * matter or that arrived more than a month ago; the owner asked for it
   * back, so like any reminder that came it is in the queue whatever it was
   * judged, for a month from now.
   *
   * The time stored is the dispatcher's last look for reminders, which while
   * the page is served is less than a minute ago, rather than this moment.
   * The dispatcher announces only what came after its last look, so a message
   * brought back by hand is not announced again a minute later: the owner is
   * the one who asked. That look is used only while it is recent, which is
   * what says a dispatcher is keeping the time. An older one (the page has
   * not been served for a while, and MCP is answering on its own) would
   * count the month in the queue from then: the message would sort below
   * everything that came since, past the queue's first page, and leave it
   * early. So it is this moment whenever the look is not recent, or ahead of
   * the clock, or missing. A dispatcher that resumes later from its old look
   * may then remind of it once, within the day, which is the smaller harm
   * than a message asked back and quietly gone again.
   */
  wakeNow(idOrKey: string): MailRow | undefined {
    const at = now();
    const raw = this.getMeta(SNOOZE_CHECKED_KEY);
    const mark = raw && Number.isFinite(Date.parse(raw)) ? new Date(Date.parse(raw)).toISOString() : undefined;
    const recent = new Date(Date.parse(at) - FRESH_WAKE_MARK_MS).toISOString();
    const usable = mark !== undefined && mark <= at && mark >= recent;
    const row = this.setSnoozed(idOrKey, usable ? mark : at);
    // Nobody is told of it, on any output: a notification held until its
    // time is dropped, since the owner is the one who asked for it back.
    if (row) {
      this.db.prepare('DELETE FROM notification_outbox WHERE notification_key = ? AND delivered_at IS NULL').run(row.dedupKey);
    }
    return row;
  }

  /**
   * What is put off and still to come, soonest first.
   *
   * A message marked done after it was put off keeps its time but is not
   * listed: it will not come back, so saying when it would is not true.
   */
  snoozed(limit = 50): MailRow[] {
    return (
      this.db.prepare(
        `SELECT ${ROW_COLUMNS.join(', ')} FROM seen
         WHERE snoozed_until > ? AND handled_at IS NULL
         ORDER BY snoozed_until ASC, dedup_key ASC LIMIT ?`,
      ).all(now(), Math.max(1, Math.min(Math.floor(limit), 200))) as Array<Record<string, unknown>>
    ).map(toRow);
  }

  /** How many are put off and still to come: all of them, where snoozed() lists a page. */
  snoozedCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM seen WHERE snoozed_until > ? AND handled_at IS NULL')
      .get(now()) as Record<string, unknown> | undefined;
    return Number(row?.['n'] ?? 0);
  }

  /**
   * The rows whose reminder came after `after` and no later than `upTo`,
   * soonest first, and tell open pages that the queue changed if there are any.
   *
   * Nothing is written to a row: the queue reads the clock, so a reminder is
   * in it from its minute on whoever looks. What waking adds is the
   * announcement, since a page is otherwise told only of commits, and the
   * list of whom to remind.
   */
  wakeSnoozed(after: string, upTo: string): MailRow[] {
    const rows = (
      this.db.prepare(
        `SELECT ${ROW_COLUMNS.join(', ')} FROM seen
         WHERE snoozed_until > ? AND snoozed_until <= ?
         ORDER BY snoozed_until ASC, dedup_key ASC LIMIT 500`,
      ).all(after, upTo) as Array<Record<string, unknown>>
    ).map(toRow);
    if (rows.length) this.bumpMailRevision();
    return rows;
  }

  /** Where a message lives now, after an action moved it at the provider. */
  updateMailLocation(
    dedupKey: string, folder: string, inSpam: boolean, at: { uid?: number; uidValidity?: string } = {},
  ): void {
    // A moved message has a new UID. When the server said which, it is kept;
    // when it did not, the old one is forgotten rather than left to mislead.
    const known = at.uid !== undefined && at.uid > 0 && Boolean(at.uidValidity);
    const result = this.db.prepare('UPDATE seen SET folder = ?, in_spam = ?, uid = ?, uid_validity = ? WHERE dedup_key = ?')
      .run(folder.slice(0, 500), inSpam ? 1 : 0, known ? at.uid! : null, known ? at.uidValidity! : null, dedupKey);
    if (Number(result.changes) > 0) this.bumpMailRevision();
  }

  /**
   * Where a message is in its folder, when that is known (see MailRecord.uid).
   *
   * Asked for on its own rather than carried on MailRow: a row is what the
   * page and MCP clients are sent, and this is of use to neither.
   */
  placeOf(dedupKey: string): { uid: number; uidValidity: string } | undefined {
    const raw = this.db.prepare('SELECT uid, uid_validity FROM seen WHERE dedup_key = ?')
      .get(dedupKey) as Record<string, unknown> | undefined;
    const uid = raw?.['uid'];
    const uidValidity = raw?.['uid_validity'];
    return typeof uid === 'number' && uid > 0 && typeof uidValidity === 'string' && uidValidity
      ? { uid, uidValidity } : undefined;
  }

  /**
   * Note where a message was found, so the next time it is opened it is
   * fetched and not searched for. Nothing the page shows changes, so nothing
   * is announced; returns whether anything was written.
   */
  rememberUid(dedupKey: string, folder: string, uid: number, uidValidity: string): boolean {
    if (!(uid > 0) || !uidValidity) return false;
    return Number(this.db.prepare(
      `UPDATE seen SET uid = ?, uid_validity = ?
       WHERE dedup_key = ? AND folder IS ? AND (uid IS NOT ? OR uid_validity IS NOT ?)`,
    ).run(uid, uidValidity, dedupKey, folder, uid, uidValidity).changes) > 0;
  }

  private bumpMailRevision(): void {
    this.db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, '1')
       ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
    ).run(MAIL_REVISION_KEY);
  }

  // ---- Change tracking, for the live page and the push dispatcher ----

  /**
   * A counter SQLite moves whenever another connection commits.
   *
   * Reading it costs nothing, so a watcher can ask once a second and do real
   * work only when the number moved. Writes made through this same handle do
   * not move it, which is why each watcher keeps a handle of its own.
   */
  dataVersion(): number {
    const row = this.db.prepare('PRAGMA data_version').get() as Record<string, unknown> | undefined;
    return Number(row?.['data_version'] ?? 0);
  }

  /**
   * Two short strings that change when the page would draw something else.
   *
   * `mail` covers the list, the queue and the digest: a row added, judged,
   * notified, handled, moved, put off or come back from being put off (those
   * last three through the revision), a digest queued or sent. `poll` covers the
   * status line: the heartbeat, a mailbox starting or ceasing to fail, the
   * outbox. A commit that touches neither (an audit entry, a cursor) leaves
   * both alone, so the page is not told to redraw for nothing.
   *
   * The scan is bounded to recent rows, on a cutoff that only moves at
   * midnight, so it stays cheap on a large table and a row ageing out does not
   * read as a change more than once a day.
   */
  changeSignature(): { mail: string; poll: string } {
    const cutoff = new Date(Date.now() - SIGNATURE_WINDOW_DAYS * 86_400_000);
    cutoff.setUTCHours(0, 0, 0, 0);
    const rows = this.db.prepare(
      `SELECT COUNT(*) AS n, MAX(created_at) AS latest, COUNT(importance) AS judged,
              COALESCE(SUM(CASE importance WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END), 0) AS weight,
              COALESCE(SUM(pushed), 0) AS pushed, COALESCE(SUM(in_spam), 0) AS spam,
              COUNT(handled_at) AS handled, MAX(handled_at) AS handled_latest
       FROM seen WHERE created_at >= ?`,
    ).get(cutoff.toISOString()) as Record<string, unknown>;
    const queue = this.db.prepare(
      'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)), 0) AS size FROM digest_queue',
    ).get() as Record<string, unknown>;
    const sent = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM digest_log').get() as Record<string, unknown>;
    const mail = [
      rows['n'], rows['latest'] ?? '', rows['judged'], rows['weight'], rows['pushed'], rows['spam'],
      rows['handled'], rows['handled_latest'] ?? '', this.getMeta(MAIL_REVISION_KEY) ?? '0',
      queue['n'], queue['size'], sent['id'],
    ].join('|');

    const failing = this.listMeta('account_fail_count:').map((entry) => `${entry.key}=${entry.value}`).join(',');
    const poll = [this.getMeta('last_poll_at') ?? '', failing, this.notificationOutboxPending()].join('|');
    return { mail, poll };
  }

  /**
   * Judged rows strictly after a cursor, oldest first.
   *
   * A row is filed before it is judged, so the newest one may still be
   * waiting for its outcome; it is left out here and picked up on the next
   * read, because the cursor only ever moves to a row that was returned.
   */
  rowsAfter(cursor: RowCursor, limit = 50): MailRow[] {
    return (
      this.db.prepare(
        // The first condition is implied by the third; it is there so the
        // created_at index bounds the scan, which the OR alone would not let it do.
        `SELECT ${ROW_COLUMNS.join(', ')} FROM seen
         WHERE created_at >= ? AND importance IS NOT NULL
           AND (created_at > ? OR (created_at = ? AND dedup_key > ?))
         ORDER BY created_at ASC, dedup_key ASC LIMIT ?`,
      ).all(
        cursor.createdAt, cursor.createdAt, cursor.createdAt, cursor.dedupKey,
        Math.max(1, Math.min(Math.floor(limit), 200)),
      ) as
        Array<Record<string, unknown>>
    ).map(toRow);
  }

  // ---- Push subscriptions ----

  /**
   * Remember a browser that asked to be notified.
   *
   * Saving the same endpoint again updates what it wants and clears its
   * failure count, keeping the day it first subscribed. At the cap a new
   * endpoint is refused and false is returned: dropping the oldest instead
   * would let anyone who can subscribe push every real device out.
   */
  savePushSubscription(input: {
    endpoint: string; p256dh: string; auth: string; level: 'critical' | 'warning'; codes: boolean; lang: string;
    label?: string; origin?: string; credential?: string;
  }): boolean {
    const endpoint = input.endpoint.slice(0, 2048);
    const known = this.db.prepare('SELECT 1 FROM push_subscriptions WHERE endpoint = ?').get(endpoint) !== undefined;
    if (!known) {
      const held = this.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as Record<string, unknown>;
      if (Number(held['n'] ?? 0) >= MAX_PUSH_SUBSCRIPTIONS) return false;
    }
    this.db.prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, level, codes, lang, label, origin, created_at, failures, credential)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         p256dh = excluded.p256dh, auth = excluded.auth, level = excluded.level, codes = excluded.codes,
         lang = excluded.lang, label = excluded.label, origin = excluded.origin, failures = 0,
         credential = excluded.credential`,
    ).run(
      endpoint, input.p256dh.slice(0, 200), input.auth.slice(0, 100),
      input.level === 'critical' ? 'critical' : 'warning', input.codes ? 1 : 0, input.lang.slice(0, 16),
      input.label?.slice(0, 80) ?? null, input.origin?.slice(0, 200) ?? null, now(),
      (input.credential ?? '').slice(0, 64),
    );
    return true;
  }

  /**
   * End every subscription made under a credential that is no longer one of
   * this server's. Returns how many were ended.
   */
  prunePushSubscriptions(validCredentials: string[]): number {
    const valid = validCredentials.length ? validCredentials : [''];
    const marks = valid.map(() => '?').join(', ');
    return Number(
      this.db.prepare(`DELETE FROM push_subscriptions WHERE credential NOT IN (${marks})`).run(...valid).changes,
    );
  }

  getPushSubscription(endpoint: string): PushSubscriptionRow | undefined {
    const row = this.db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as
      | Record<string, unknown>
      | undefined;
    return row ? toPushSubscription(row) : undefined;
  }

  listPushSubscriptions(): PushSubscriptionRow[] {
    return (
      this.db.prepare('SELECT * FROM push_subscriptions ORDER BY created_at, rowid').all() as Array<Record<string, unknown>>
    ).map(toPushSubscription);
  }

  deletePushSubscription(endpoint: string): boolean {
    return Number(this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint).changes) > 0;
  }

  /**
   * Note how a delivery went, and say how many have now failed in a row.
   *
   * A success clears the count. The caller decides when the count means the
   * subscription is dead; an endpoint that is not stored reports zero.
   */
  recordPushResult(endpoint: string, ok: boolean): number {
    if (ok) {
      this.db.prepare('UPDATE push_subscriptions SET last_ok_at = ?, failures = 0 WHERE endpoint = ?').run(now(), endpoint);
      return 0;
    }
    this.db.prepare('UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ?').run(endpoint);
    const row = this.db.prepare('SELECT failures FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as
      | Record<string, unknown>
      | undefined;
    return Number(row?.['failures'] ?? 0);
  }

  /** Recent, already-processed messages from one mailbox thread. */
  getThreadContext(account: string, threadKey: string, limit = 3): MailRow[] {
    const safeLimit = Math.max(0, Math.min(Math.floor(limit), 5));
    if (safeLimit === 0) return [];
    return (
      this.db.prepare(
        `SELECT ${ROW_COLUMNS.join(', ')}, snippet FROM seen
         WHERE account = ? AND thread_key = ? AND importance IS NOT NULL
         ORDER BY COALESCE(mail_date, created_at) DESC, created_at DESC
         LIMIT ?`,
      ).all(account, threadKey, safeLimit) as Array<Record<string, unknown>>
    ).map(toRow);
  }

  /**
   * Every stored message in one thread, oldest first, for the thread resource.
   *
   * Unlike getThreadContext this spans accounts and keeps undecided rows: a
   * reader asking for a conversation wants all of it, not the part that was
   * triaged, and the same thread can land in two monitored mailboxes.
   */
  getThreadMail(threadKey: string, limit = 50): MailRow[] {
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 200));
    return (
      this.db.prepare(
        `SELECT ${ROW_COLUMNS.join(', ')}, snippet FROM seen
         WHERE thread_key = ?
         ORDER BY COALESCE(mail_date, created_at) ASC, created_at ASC
         LIMIT ?`,
      ).all(threadKey, safeLimit) as Array<Record<string, unknown>>
    ).map(toRow);
  }

  /** Group the bounded local mail view into conversation-like threads. */
  queryThreads(options: QueryOptions = {}): MailThread[] {
    const requested = Math.max(1, Math.min(options.limit ?? 30, 200));
    // A thread can contain many messages. Read a bounded multiplier so a busy
    // thread does not consume the whole page while keeping this query cheap.
    const scanLimit = Math.min(1000, Math.max(requested * 20, requested));
    const rows = this.queryMail({ ...options, limit: scanLimit });
    const groups = new Map<string, MailRow[]>();
    for (const row of rows) {
      const key = row.threadKey || `${row.account}|${row.messageId || row.dedupKey}`;
      const existing = groups.get(key);
      if (existing) existing.push(row);
      else groups.set(key, [row]);
    }

    // The list stays the received mail's: a thread is in it for its received
    // messages in the window, and the owner's own only add to what it says.
    // A received copy of one of the owner's own messages (a list sending a
    // post back to its poster, a Bcc to themselves) is the owner's message,
    // counted once, as sent.
    const own = this.ownCopies([...groups.keys()]);
    const threads = [...groups.entries()]
      .map(([threadKey, all]) => {
        const messages = all.filter((row) => !own.has(`${row.account}|${row.messageId ?? ''}`));
        if (!messages.length) return undefined;
        messages.sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt) || b.dedupKey.localeCompare(a.dedupKey));
        const latest = messages[0]!;
        return {
          threadKey,
          account: latest.account,
          accountLabel: latest.accountLabel,
          messageCount: messages.length,
          latest,
          messages,
          sentCount: 0,
          lastSentAt: null,
          lastWordYours: false,
        } as MailThread;
      })
      .filter((thread): thread is MailThread => thread !== undefined)
      .sort((a, b) =>
        b.latest.createdAt.localeCompare(a.latest.createdAt)
        || b.latest.dedupKey.localeCompare(a.latest.dedupKey))
      .slice(0, requested);
    // Counted in the same window as the received messages, so "N messages" means one thing.
    const since = options.sinceHours !== undefined
      ? new Date(Date.now() - options.sinceHours * 3_600_000).toISOString() : undefined;
    const sent = this.sentByThread(threads.map((thread) => thread.threadKey), since);
    for (const thread of threads) {
      const mine = sent.get(thread.threadKey);
      if (!mine) continue;
      thread.sentCount = mine.count;
      thread.lastSentAt = mine.lastAt;
      // Against the latest received message of the whole thread, not only of
      // the window: a reply to a message older than the window is still the last word.
      const received = this.latestReceivedIn(thread.threadKey) ?? thread.latest.mailDate ?? thread.latest.createdAt;
      thread.lastWordYours = Boolean(mine.lastAt) && mine.lastAt! > received;
    }
    return threads;
  }

  /** `account|Message-ID` of every sent message in these threads: what a received copy of one is matched on. */
  private ownCopies(threadKeys: readonly string[]): Set<string> {
    const out = new Set<string>();
    const keys = [...new Set(threadKeys)].filter(Boolean);
    for (let at = 0; at < keys.length; at += 200) {
      const chunk = keys.slice(at, at + 200);
      for (const row of this.db.prepare(
        `SELECT account, message_id FROM sent_mail WHERE thread_key IN (${chunk.map(() => '?').join(', ')})`,
      ).all(...chunk) as Array<Record<string, unknown>>) out.add(`${String(row['account'])}|${String(row['message_id'])}`);
    }
    return out;
  }

  /**
   * How many of the owner's messages each thread holds (since `since`, when
   * given, as the received messages it is shown with), and when the latest
   * of them all was sent.
   */
  private sentByThread(threadKeys: readonly string[], since?: string): Map<string, { count: number; lastAt: string | null }> {
    const out = new Map<string, { count: number; lastAt: string | null }>();
    const keys = [...new Set(threadKeys)].filter(Boolean);
    for (let at = 0; at < keys.length; at += 200) {
      const chunk = keys.slice(at, at + 200);
      const rows = this.db.prepare(
        `SELECT thread_key, COUNT(CASE WHEN COALESCE(mail_date, created_at) >= ? THEN 1 END) AS n,
                MAX(COALESCE(mail_date, created_at)) AS last_at
         FROM sent_mail WHERE thread_key IN (${chunk.map(() => '?').join(', ')}) GROUP BY thread_key`,
      ).all(since ?? '', ...chunk) as Array<Record<string, unknown>>;
      for (const row of rows) {
        out.set(String(row['thread_key']), { count: Number(row['n'] ?? 0), lastAt: (row['last_at'] as string) ?? null });
      }
    }
    return out;
  }

  /** When the newest received message of a thread is dated; a copy of the owner's own is not one. */
  private latestReceivedIn(threadKey: string): string | undefined {
    const row = this.db.prepare(
      `SELECT MAX(COALESCE(mail_date, created_at)) AS at FROM seen WHERE thread_key = ? AND NOT ${OWN_COPY}`,
    ).get(threadKey) as Record<string, unknown> | undefined;
    return (row?.['at'] as string) ?? undefined;
  }

  // ---- The owner's own mail, for the conversation only ----

  /**
   * Store one sent message, or complete the one already stored.
   *
   * One row per mailbox and Message-ID. A send from the page or MCP is stored
   * the moment it leaves, with its exact recipients and text; when the poll
   * then finds it in Sent it only fills in where it is. The poll storing it
   * first (a provider that files its copy at once) is completed the other way
   * round: the page's own record of whom it went to replaces the header's.
   * A page or MCP send has already dealt with the message it answers, so its
   * row is never held against the queue again (see answerFromSent).
   */
  recordSent(record: SentRecord): { id: number; inserted: boolean } {
    // Names in one Unicode form (NFKC: full-width letters, half-width kana and
    // accents written apart become what they look like), so a search for the
    // name finds them however the sender's client wrote it.
    const person = (kind: string) => (r: SentAddress) => ({ kind, name: r.name.normalize('NFKC'), address: r.address });
    const recipients = JSON.stringify([
      ...record.to.map(person('to')), ...record.cc.map(person('cc')), ...record.bcc.map(person('bcc')),
    ].slice(0, 300));
    const names = JSON.stringify(record.attachmentNames.slice(0, 50).map((name) => name.slice(0, 300)));
    const fromPoll = record.source === 'poll';
    const known = record.uid !== undefined && record.uid > 0 && Boolean(record.uidValidity);
    const find = (): Record<string, unknown> | undefined => this.db.prepare('SELECT id FROM sent_mail WHERE account = ? AND message_id = ?')
      .get(record.account, record.messageId) as Record<string, unknown> | undefined;
    let existing = find();
    if (!existing) {
      // OR IGNORE: the poll and a send from the page (two processes) can store the same letter at once.
      const result = this.db.prepare(
        `INSERT OR IGNORE INTO sent_mail
         (account, account_label, message_id, thread_key, in_reply_to, answers, subject, from_addr, from_name, recipients,
          mail_date, body, attachment_count, attachment_names, folder, uid, uid_validity, source, checked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.account, record.accountLabel ?? null, record.messageId.slice(0, 1000), record.threadKey.slice(0, 1400),
        record.inReplyTo?.slice(0, 1000) ?? null, record.answers?.slice(0, 1000) ?? null, record.subject.slice(0, 1000),
        record.fromAddr.slice(0, 320), record.fromName?.slice(0, 300) ?? null, recipients,
        record.date ?? null, record.text.slice(0, SENT_TEXT_CHARS), record.attachmentCount, names,
        record.folder ?? null, known ? record.uid! : null, known ? record.uidValidity! : null, record.source,
        fromPoll ? null : now(), now(),
      );
      if (Number(result.changes) > 0) {
        // Open pages show it: in a conversation, and in a thread's count.
        this.bumpMailRevision();
        return { id: Number(result.lastInsertRowid), inserted: true };
      }
      existing = find();
      if (!existing) throw new Error('a sent message could be neither stored nor found');
    }
    const id = Number(existing['id']);
    if (fromPoll) {
      this.db.prepare(
        `UPDATE sent_mail SET folder = COALESCE(?, folder), uid = COALESCE(?, uid), uid_validity = COALESCE(?, uid_validity)
         WHERE id = ?`,
      ).run(record.folder ?? null, known ? record.uid! : null, known ? record.uidValidity! : null, id);
    } else {
      this.db.prepare(
        `UPDATE sent_mail SET recipients = ?, body = ?, attachment_count = ?, attachment_names = ?, source = ?,
           checked_at = COALESCE(checked_at, ?)
         WHERE id = ?`,
      ).run(recipients, record.text.slice(0, SENT_TEXT_CHARS), record.attachmentCount, names, record.source, now(), id);
    }
    return { id, inserted: false };
  }

  getSent(id: number): SentRow | undefined {
    const raw = this.db.prepare('SELECT * FROM sent_mail WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return raw ? toSentRow(raw) : undefined;
  }

  /** The owner's messages in one thread, oldest first. */
  sentInThread(threadKey: string, limit = 200): SentRow[] {
    return (
      this.db.prepare(
        `SELECT * FROM (SELECT * FROM sent_mail WHERE thread_key = ?
           ORDER BY COALESCE(mail_date, created_at) DESC, id DESC LIMIT ?)
         ORDER BY COALESCE(mail_date, created_at) ASC, id ASC`,
      ).all(threadKey, Math.max(1, Math.min(Math.floor(limit), 500))) as Array<Record<string, unknown>>
    ).map(toSentRow);
  }

  /** How many sent messages are stored, for the log and the health view. */
  sentCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM sent_mail').get() as Record<string, unknown>;
    return Number(row['n'] ?? 0);
  }

  /**
   * The newest part of a thread: its received messages and the owner's own,
   * oldest first, at most `limit`, with `omitted` the true number of the
   * thread's stored messages left out. With `current`, that message is always
   * in it, with the newest of the rest. A received copy of one of the owner's
   * own messages is the owner's message: shown once, as sent, unless it is
   * the one being read.
   */
  threadWindow(
    threadKey: string, limit = CONVERSATION_LIMIT, current?: MailRow,
  ): { entries: ConversationEntry[]; omitted: number; between: number } {
    const bound = Math.max(1, Math.min(Math.floor(limit), CONVERSATION_LIMIT));
    const at = (value: string | null, fallback: string): string => value || fallback;
    // The newest of each table, which together hold the newest of the thread.
    const received: ConversationEntry[] = (
      this.db.prepare(
        `SELECT ${ROW_COLUMNS.join(', ')}, snippet FROM seen WHERE thread_key = ? AND NOT ${OWN_COPY}
         ORDER BY COALESCE(mail_date, created_at) DESC, created_at DESC LIMIT ?`,
      ).all(threadKey, bound) as Array<Record<string, unknown>>
    ).map(toRow).map((r) => ({ direction: 'in' as const, at: at(r.mailDate, r.createdAt), row: r }));
    let sent: ConversationEntry[] = this.sentInThread(threadKey, bound)
      .map((s) => ({ direction: 'out' as const, at: at(s.date, s.createdAt), sent: s }));
    const count = (sql: string): number => Number((this.db.prepare(sql).get(threadKey) as Record<string, unknown>)['n'] ?? 0);
    const total = count(`SELECT COUNT(*) AS n FROM seen WHERE thread_key = ? AND NOT ${OWN_COPY}`)
      + count('SELECT COUNT(*) AS n FROM sent_mail WHERE thread_key = ?');
    const isCurrent = (entry: ConversationEntry): boolean => Boolean(current) && entry.direction === 'in' && entry.row.dedupKey === current!.dedupKey;
    if (current && !received.some(isCurrent)) {
      // Read from a copy of the owner's own message: it stands for that message, which is not shown twice.
      sent = sent.filter((entry) => !(entry.direction === 'out' && entry.sent.account === current.account && entry.sent.messageId === current.messageId));
      received.push({ direction: 'in', at: at(current.mailDate, current.createdAt), row: current });
    }
    const all = [...received, ...sent].sort((a, b) => a.at.localeCompare(b.at));
    const others = all.filter((entry) => !isCurrent(entry));
    const kept = new Set<ConversationEntry>([...all.filter(isCurrent), ...others.slice(-(bound - all.filter(isCurrent).length))]);
    const entries = all.filter((entry) => kept.has(entry));
    const omitted = Math.max(0, total - entries.length);
    // An older message opened sits apart from the newest: how many of the
    // left-out messages lie between it and the next one shown, so the reader
    // can mark the gap (a reply to it may be among them).
    let between = 0;
    const at0 = entries.findIndex(isCurrent);
    const after = at0 === -1 ? undefined : entries[at0 + 1];
    if (omitted && at0 !== -1 && after) {
      const from = entries[at0]!.at;
      const span = (sql: string): number => Number((this.db.prepare(sql).get(threadKey, from, after.at) as Record<string, unknown>)['n'] ?? 0);
      between = span(`SELECT COUNT(*) AS n FROM seen WHERE thread_key = ? AND NOT ${OWN_COPY}
          AND COALESCE(mail_date, created_at) > ? AND COALESCE(mail_date, created_at) < ?`)
        + span(`SELECT COUNT(*) AS n FROM sent_mail WHERE thread_key = ?
          AND COALESCE(mail_date, created_at) > ? AND COALESCE(mail_date, created_at) < ?`);
      between = Math.min(between, omitted);
    }
    return { entries, omitted, between };
  }

  /**
   * One stored message's conversation, as the reader shows it under the
   * message: the message itself and the newest of the rest of its thread.
   */
  conversation(row: MailRow, limit = CONVERSATION_LIMIT): { entries: ConversationEntry[]; omitted: number; between: number } {
    if (!row.threadKey) return { entries: [{ direction: 'in', at: row.mailDate || row.createdAt, row }], omitted: 0, between: 0 };
    return this.threadWindow(row.threadKey, limit, row);
  }

  // ---- Answered elsewhere ----

  /** An answer that went only to the owner's own addresses answers nobody. */
  private answersSomeone(sent: SentRow, own: readonly string[]): boolean {
    return !toOwnOnly([...sent.to, ...sent.cc, ...sent.bcc], own);
  }

  /**
   * Whether an answer counts against the owner's latest decision about the
   * message (put back, put off, its reminder changed; see kept_at): only one
   * written after it does. The message's own date is not compared: an
   * answer names it by Message-ID, so it cannot be older than it, and a
   * sender's clock that runs ahead would only make a real answer miss.
   */
  private afterDecision(sentDate: string | null, keptAt: unknown): boolean {
    if (typeof keptAt !== 'string' || !keptAt) return true;
    return Boolean(sentDate) && sentDate! > keptAt;
  }

  /**
   * The stored received message a sent one takes off the queue, if any: of
   * the same mailbox, the message it answers, still to be dealt with (in the
   * queue, or put off), and not decided on by the owner after the answer was
   * written.
   */
  private answeredBy(sent: SentRow, own: readonly string[]): { key: string; messageId: string; folder: string | null } | undefined {
    if (!sent.answers || !this.answersSomeone(sent, own)) return undefined;
    const rule = this.queueRule();
    const raw = this.db.prepare(
      // In the queue, put off, or still owed a notification (one that failed
      // and waits for a retry): all are waiting on the owner.
      `SELECT dedup_key, message_id, folder, kept_at FROM seen
       WHERE account = ? AND message_id = ? AND handled_at IS NULL AND (${rule.clause} OR snoozed_until > ?
         OR EXISTS (SELECT 1 FROM notification_outbox n WHERE n.notification_key = seen.dedup_key AND n.delivered_at IS NULL))
       ORDER BY created_at LIMIT 1`,
    ).get(sent.account, sent.answers, ...rule.params, now()) as Record<string, unknown> | undefined;
    if (!raw || !this.afterDecision(sent.date, raw['kept_at'])) return undefined;
    return { key: String(raw['dedup_key']), messageId: String(raw['message_id'] ?? ''), folder: (raw['folder'] as string) ?? null };
  }

  /**
   * Take a received message off the queue because the owner answered it
   * elsewhere, as answering it in the page does, and say nothing more about
   * it: a notification still owed is dropped and its digest line removed.
   * `withheld` (or a notification found owed) keeps it eligible for the
   * queue as a notified message is, so putting it back returns it there.
   */
  private handleAnswered(target: { key: string; messageId: string; folder: string | null }, account: string, sentId: number, withheld: boolean): void {
    this.setHandled(target.key, true);
    const owed = this.db.prepare('SELECT 1 FROM notification_outbox WHERE notification_key = ? AND delivered_at IS NULL')
      .get(target.key) !== undefined;
    if (withheld || owed) this.withholdNotification(target.key);
    // Nothing more is said about it: not in a digest either.
    this.db.prepare('DELETE FROM digest_queue WHERE dedup_key = ?').run(target.key);
    this.db.prepare('UPDATE sent_mail SET answered_key = ? WHERE id = ?').run(target.key, sentId);
    this.recordMailAction({
      account, messageId: target.messageId, action: 'handled', success: true, client: SENT_FOLDER_CLIENT,
      ...(target.folder ? { sourceFolder: target.folder } : {}),
    });
  }

  /**
   * Hold the sent messages the poll stored, and has not yet looked at,
   * against the queue: each one that answers a message still to be dealt
   * with takes it off, as answering it in the page does. Every row is looked
   * at once, so a message the owner puts back is not taken off again by the
   * same answer; a send from the page or MCP was looked at when it left.
   * Returns the keys taken off.
   */
  answerFromSent(own: readonly string[]): string[] {
    const handled: string[] = [];
    const rows = (this.db.prepare(
      'SELECT * FROM sent_mail WHERE checked_at IS NULL ORDER BY id LIMIT ?',
    ).all(ANSWER_BATCH) as Array<Record<string, unknown>>).map(toSentRow);
    const checked = this.db.prepare('UPDATE sent_mail SET checked_at = ? WHERE id = ?');
    for (const sent of rows) {
      const target = this.answeredBy(sent, own);
      if (target) {
        this.handleAnswered(target, sent.account, sent.id, false);
        handled.push(target.key);
      }
      checked.run(now(), sent.id);
    }
    return handled;
  }

  /**
   * Before a message is put before the owner (stored and about to be
   * notified, judged again after an outage, or a notification retried):
   * whether a stored answer to it says the owner dealt with it already. If
   * so it is taken off as answerFromSent does and true is returned, and the
   * caller notifies nothing. Called before a new row is judged, so nothing
   * reading judged rows (web push above all) sees it waiting. `withheld`:
   * the caller was about to notify it. `messageId`: for a row just filed,
   * whose Message-ID is written with its verdict.
   */
  answerStored(key: string, own: readonly string[], withheld = false, messageId?: string): boolean {
    const raw = this.db.prepare('SELECT account, message_id, folder, handled_at, kept_at FROM seen WHERE dedup_key = ?')
      .get(key) as Record<string, unknown> | undefined;
    const id = (raw?.['message_id'] as string | null) || messageId;
    if (!raw || raw['handled_at'] || !id) return false;
    const account = String(raw['account']);
    const answer = (this.db.prepare(
      'SELECT * FROM sent_mail WHERE account = ? AND answers = ? ORDER BY COALESCE(mail_date, created_at) DESC LIMIT 20',
    ).all(account, id) as Array<Record<string, unknown>>).map(toSentRow)
      .find((sent) => this.answersSomeone(sent, own) && this.afterDecision(sent.date, raw['kept_at']));
    if (!answer) return false;
    this.handleAnswered({ key, messageId: id, folder: (raw['folder'] as string) ?? null }, account, answer.id, withheld);
    return true;
  }

  /**
   * Read the owner's decisions about each message from before kept_at was
   * kept, from the audit: putting a message back, and every reminder set,
   * brought back or taken away, in the page (whose rows name the record's
   * key) and through MCP (whose rows name a Message-ID or a key, and maybe
   * the mailbox). An MCP mark_handled row may have marked a message done
   * rather than put it back; counted all the same, it can only keep a reply
   * written before it from taking off a message the owner had just looked at.
   */
  private backfillKeptAt(): void {
    this.db.prepare(
      `UPDATE seen SET kept_at = decided.at FROM (
         SELECT key, MAX(at) AS at FROM (
           SELECT target AS key, created_at AS at FROM mcp_audit
           WHERE success = 1 AND target IS NOT NULL AND action IN ('web:unhandled', 'web:snooze', 'web:wake', 'web:unsnooze')
           UNION ALL
           SELECT s.dedup_key AS key, m.at AS at FROM (
             -- Read as JSON only where it is JSON, whatever order SQLite tests these in:
             -- the page's own rows name a key in plain text.
             SELECT created_at AS at,
                    json_extract(CASE WHEN json_valid(target) THEN target ELSE '{}' END, '$.messageId') AS mid,
                    json_extract(CASE WHEN json_valid(target) THEN target ELSE '{}' END, '$.account') AS mailbox
             FROM mcp_audit WHERE success = 1 AND action IN ('mark_handled', 'snooze')
           ) m JOIN seen s
             ON m.mid IS NOT NULL AND (s.dedup_key = m.mid OR (s.message_id = m.mid AND (m.mailbox IS NULL OR s.account = m.mailbox)))
         ) GROUP BY key
       ) AS decided
       WHERE seen.dedup_key = decided.key AND (seen.kept_at IS NULL OR seen.kept_at < decided.at)`,
    ).run();
  }

  // ---- Where the poll is in each Sent folder ----

  getSentCursor(account: string): SentCursorRow | undefined {
    const raw = this.db.prepare('SELECT * FROM sent_cursors WHERE account = ?').get(account) as Record<string, unknown> | undefined;
    return raw ? {
      folder: String(raw['folder']),
      uidValidity: String(raw['uid_validity']),
      lastUid: Number(raw['last_uid']),
      backfillBelow: Number(raw['backfill_below'] ?? 0),
      backfillLeft: Number(raw['backfill_left'] ?? 0),
      backfillSince: (raw['backfill_since'] as string) ?? null,
    } : undefined;
  }

  saveSentCursor(account: string, cursor: SentCursorRow): void {
    this.db.prepare(
      `INSERT INTO sent_cursors (account, folder, uid_validity, last_uid, backfill_below, backfill_left, backfill_since, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account) DO UPDATE SET folder = excluded.folder, uid_validity = excluded.uid_validity,
         last_uid = excluded.last_uid, backfill_below = excluded.backfill_below, backfill_left = excluded.backfill_left,
         backfill_since = excluded.backfill_since, updated_at = excluded.updated_at`,
    ).run(
      account, cursor.folder, cursor.uidValidity, cursor.lastUid, cursor.backfillBelow, cursor.backfillLeft,
      cursor.backfillSince, now(),
    );
  }

  // ---- Whom to write to ----

  /**
   * Addresses for what is being typed into To, Cc or Bcc, best first: those
   * the owner has written to, by how often and how lately; then people who
   * wrote to the owner and look like people (not spam, not bulk, notices or
   * codes, not an address that writes for a machine, not one of the owner's
   * own). At most `limit`; nothing for an empty query.
   */
  contacts(query: string, limit = 8, own: readonly string[] = []): Contact[] {
    const q = query.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!q) return [];
    const max = Math.max(1, Math.min(Math.floor(limit) || 8, MAX_CONTACTS));
    const nowMs = Date.now();
    const mine = new Set(own.map((address) => address.trim().toLowerCase()));
    // A coarse filter in SQL on the query's longest word, in the cases SQLite
    // can tell apart (it folds only ASCII), then the real match here.
    const longest = q.split(' ').sort((a, b) => b.length - a.length)[0]!;
    const variants = [...new Set([longest, longest.toUpperCase(), longest.charAt(0).toUpperCase() + longest.slice(1)])]
      .map((v) => `%${likeEscape(v)}%`);
    const like = (column: string): string => variants.map(() => `${column} LIKE ? ESCAPE '\\'`).join(' OR ');

    interface Seen { name: string; nameAt: string; weight: number; sent: Set<number>; received: number; lastAt: string | null; bulk: number }
    const people = new Map<string, Seen>();
    const person = (address: string): Seen => {
      let entry = people.get(address);
      if (!entry) {
        entry = { name: '', nameAt: '', weight: 0, sent: new Set(), received: 0, lastAt: null, bulk: 0 };
        people.set(address, entry);
      }
      return entry;
    };
    const named = (entry: Seen, name: string, at: string): void => {
      const clean = name.replace(/[\r\n\t]+/g, ' ').trim();
      if (clean && at >= entry.nameAt) { entry.name = clean.slice(0, 200); entry.nameAt = at; }
    };

    const sentRows = this.db.prepare(
      `SELECT s.id AS id, s.account AS account, COALESCE(s.mail_date, s.created_at) AS at,
              json_extract(r.value, '$.address') AS address, json_extract(r.value, '$.name') AS name
       FROM sent_mail s, json_each(s.recipients) r
       WHERE ${like("json_extract(r.value, '$.address')")} OR ${like("json_extract(r.value, '$.name')")}
       ORDER BY at DESC LIMIT ?`,
    ).all(...variants, ...variants, CONTACT_SCAN_ROWS) as Array<Record<string, unknown>>;
    const written = new Set<string>();
    for (const row of sentRows) {
      const address = String(row['address'] ?? '').trim().toLowerCase();
      const name = String(row['name'] ?? '');
      // A copy to the mailbox it left from is the owner keeping one, not someone written to.
      if (!address.includes('@') || address === String(row['account'] ?? '').toLowerCase()) continue;
      if (!contactMatches(q, name, address)) continue;
      const entry = person(address);
      const at = String(row['at'] ?? '');
      const id = Number(row['id']);
      if (!entry.sent.has(id)) { entry.sent.add(id); entry.weight += weightOf(at, nowMs); }
      if (!entry.lastAt || at > entry.lastAt) entry.lastAt = at;
      named(entry, name, at);
      written.add(address);
    }

    const seenColumns = `sender, sender_name, COALESCE(mail_date, created_at) AS at, category, in_spam, decided_by,
              verification_code, summary`;
    const seenRows = [
      ...this.db.prepare(
        `SELECT ${seenColumns} FROM seen WHERE sender LIKE '%@%' AND (${like('sender')} OR ${like('sender_name')})
         ORDER BY created_at DESC LIMIT ?`,
      ).all(...variants, ...variants, CONTACT_SCAN_ROWS) as Array<Record<string, unknown>>,
      // A received name stored in another Unicode form than the query's
      // (full-width Latin, half-width kana, an accent written apart) slips past
      // LIKE, which compares bytes: any name with a character outside ASCII
      // that the filter above left out is matched here instead, after NFKC.
      ...this.db.prepare(
        `SELECT ${seenColumns} FROM seen WHERE sender LIKE '%@%' AND sender_name GLOB '*[^ -~]*'
           AND NOT (${like('sender')} OR ${like('sender_name')})
         ORDER BY created_at DESC LIMIT ?`,
      ).all(...variants, ...variants, CONTACT_SCAN_ROWS) as Array<Record<string, unknown>>,
    ];
    const readers = new Map<string, Seen & { personal: number; score: number }>();
    for (const row of seenRows) {
      const address = String(row['sender'] ?? '').trim().toLowerCase();
      const name = String(row['sender_name'] ?? '');
      if (!contactMatches(q, name, address)) continue;
      const at = String(row['at'] ?? '');
      const category = String(row['category'] ?? '');
      const summary = String(row['summary'] ?? '');
      const bulk = Boolean(row['in_spam']) || BULK_CATEGORIES.has(category)
        || Boolean(row['verification_code']) || summary.startsWith(VERIFICATION_SUMMARY_PREFIX)
        || summary.startsWith(SIGN_IN_LINK_SUMMARY_PREFIX)
        || ['health', 'digest'].includes(String(row['decided_by'] ?? ''));
      // Whoever was written to keeps the name they were last seen under, from either side.
      if (written.has(address)) {
        // Spam or bulk mail from an address the owner writes to (a forged From
        // line, say) neither counts for it nor renames it.
        if (!bulk) {
          const entry = person(address);
          entry.received += 1;
          named(entry, name, at);
        }
        continue;
      }
      if (mine.has(address)) continue;
      let entry = readers.get(address);
      if (!entry) {
        entry = { name: '', nameAt: '', weight: 0, sent: new Set(), received: 0, lastAt: null, bulk: 0, personal: 0, score: 0 };
        readers.set(address, entry);
      }
      if (bulk) { entry.bulk += 1; continue; }
      if (!PERSONAL_CATEGORIES.has(category)) continue;
      entry.personal += 1;
      entry.score += weightOf(at, nowMs);
      if (!entry.lastAt || at > entry.lastAt) entry.lastAt = at;
      named(entry, name, at);
    }

    const order = (a: { weight: number; lastAt: string | null }, b: { weight: number; lastAt: string | null }): number =>
      b.weight - a.weight || String(b.lastAt ?? '').localeCompare(String(a.lastAt ?? ''));
    const first = [...people.entries()]
      .filter(([address]) => written.has(address))
      .map(([address, entry]) => ({ address, ...entry }))
      .sort(order)
      .map((entry): Contact => ({
        address: entry.address, name: entry.name, sent: entry.sent.size, received: entry.received, lastAt: entry.lastAt, source: 'sent',
      }));
    const second = [...readers.entries()]
      .filter(([address, entry]) => entry.personal > 0 && entry.bulk < entry.personal && !AUTOMATED_LOCAL.test(address.slice(0, address.lastIndexOf('@'))))
      .map(([address, entry]) => ({ address, ...entry, weight: entry.score }))
      .sort(order)
      .map((entry): Contact => ({
        address: entry.address, name: entry.name, sent: 0, received: entry.personal, lastAt: entry.lastAt, source: 'received',
      }));
    return [...first, ...second].slice(0, max);
  }

  recordMailAction(input: {
    account: string;
    messageId: string;
    action: string;
    sourceFolder?: string;
    destinationFolder?: string;
    success: boolean;
    error?: string;
    client?: string;
  }): void {
    this.db.prepare(
      `INSERT INTO mail_actions
       (account, message_id, action, source_folder, destination_folder, success, error, client, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.account.slice(0, 320), input.messageId.slice(0, 1000), input.action.slice(0, 80),
      input.sourceFolder?.slice(0, 500) ?? null, input.destinationFolder?.slice(0, 500) ?? null,
      input.success ? 1 : 0, input.error?.slice(0, 500) ?? null, input.client?.slice(0, 100) ?? null, now(),
    );
  }

  listMailActions(limit = 50): MailActionAudit[] {
    const rows = this.db.prepare(
      `SELECT account, message_id, action, source_folder, destination_folder,
              success, error, client, created_at
       FROM mail_actions ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(Math.max(1, Math.min(limit, 200))) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      account: String(row['account']),
      messageId: String(row['message_id']),
      action: String(row['action']),
      ...(row['source_folder'] ? { sourceFolder: String(row['source_folder']) } : {}),
      ...(row['destination_folder'] ? { destinationFolder: String(row['destination_folder']) } : {}),
      success: Boolean(row['success']),
      ...(row['error'] ? { error: String(row['error']) } : {}),
      ...(row['client'] ? { client: String(row['client']) } : {}),
      createdAt: String(row['created_at']),
    }));
  }

  summarize(sinceHours = 24): Record<string, unknown> {
    const cutoff = new Date(Date.now() - sinceHours * 3_600_000).toISOString();
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(pushed),0) AS pushed,
                COALESCE(SUM(in_spam),0) AS from_spam,
                COALESCE(SUM(CASE WHEN in_spam=1 AND pushed=1 THEN 1 ELSE 0 END),0) AS rescued
         FROM seen WHERE created_at >= ?`,
      )
      .get(cutoff) as Record<string, unknown>;

    const byImportance: Record<string, number> = {};
    for (const row of this.db
      .prepare(
        `SELECT COALESCE(importance,'Undecided') AS k, COUNT(*) AS n
         FROM seen WHERE created_at >= ? GROUP BY importance`,
      )
      .all(cutoff) as Array<Record<string, unknown>>) {
      byImportance[String(row['k'])] = Number(row['n']);
    }

    return {
      windowHours: sinceHours,
      total: Number(totals['total']),
      pushed: Number(totals['pushed']),
      fromSpamFolder: Number(totals['from_spam']),
      rescuedFromSpam: Number(totals['rescued']),
      byImportance,
    };
  }

  // ---- Digest queue ----

  queueDigest(dedupKey: string, payload: unknown): void {
    this.db
      .prepare('INSERT OR IGNORE INTO digest_queue (dedup_key, payload, created_at) VALUES (?, ?, ?)')
      .run(dedupKey, JSON.stringify(payload), now());
  }

  /** Replace an existing digest payload while preserving its place in the queue. */
  upsertDigest(dedupKey: string, payload: unknown): void {
    this.db.prepare(
      `INSERT INTO digest_queue (dedup_key, payload, created_at) VALUES (?, ?, ?)
       ON CONFLICT(dedup_key) DO UPDATE SET payload = excluded.payload`,
    ).run(dedupKey, JSON.stringify(payload), now());
  }

  /** Keep what a sent digest listed, so the page can still show it once the queue is cleared. */
  recordDigestLog(sentAt: string, entries: Array<{ dedupKey: string; payload: unknown }>): void {
    const items = entries.map((entry) => ({ ...(entry.payload as Record<string, unknown>), key: entry.dedupKey }));
    this.db.prepare('INSERT INTO digest_log (sent_at, items) VALUES (?, ?)').run(sentAt, JSON.stringify(items));
  }

  /** The most recent sent digest, or undefined when none is kept. */
  lastDigestLog(): { sentAt: string; items: Array<Record<string, unknown>> } | undefined {
    const row = this.db.prepare('SELECT sent_at, items FROM digest_log ORDER BY id DESC LIMIT 1').get() as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    try {
      const items = JSON.parse(String(row['items'])) as unknown;
      return Array.isArray(items) ? { sentAt: String(row['sent_at']), items: items as Array<Record<string, unknown>> } : undefined;
    } catch {
      return undefined;
    }
  }

  digestPending(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM digest_queue').get() as Record<string, unknown>;
    return Number(row['n'] ?? 0);
  }

  peekDigestEntries(): Array<{ dedupKey: string; payload: unknown }> {
    const rows = this.db
      .prepare('SELECT dedup_key, payload FROM digest_queue ORDER BY created_at')
      .all() as Array<Record<string, unknown>>;
    const items: Array<{ dedupKey: string; payload: unknown }> = [];
    for (const row of rows) {
      try {
        items.push({ dedupKey: String(row['dedup_key']), payload: JSON.parse(String(row['payload'])) });
      } catch {
        log.warn('A corrupt digest queue record was skipped.');
      }
    }
    return items;
  }

  peekDigest(): unknown[] {
    return this.peekDigestEntries().map((entry) => entry.payload);
  }

  clearDigest(dedupKeys?: string[]): void {
    if (!dedupKeys?.length) {
      this.db.exec('DELETE FROM digest_queue');
      return;
    }
    const remove = this.db.prepare('DELETE FROM digest_queue WHERE dedup_key = ?');
    for (const key of dedupKeys) remove.run(key);
  }

  drainDigest(): unknown[] {
    const items = this.peekDigest();
    this.clearDigest();
    return items;
  }

  // ---- meta ----

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | Record<string, unknown>
      | undefined;
    return row ? String(row['value']) : undefined;
  }

  /** Every meta row under a prefix, for keys that are grouped rather than single. */
  listMeta(prefix: string): Array<{ key: string; value: string }> {
    return (
      this.db
        .prepare("SELECT key, value FROM meta WHERE key LIKE ? || '%' AND value != '' ORDER BY key")
        .all(prefix) as Array<Record<string, unknown>>
    ).map((row) => ({ key: String(row['key']), value: String(row['value']) }));
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /** Remove a meta value outright, for a setting that is gone rather than set to nothing. */
  deleteMeta(key: string): void {
    this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
  }

  /**
   * Change a meta value only if it still holds what the caller last read.
   *
   * `expected` undefined means "only if the key is absent". True is returned
   * to the one caller whose write went in, so two processes racing for the
   * same step (minting a key pair, claiming a batch of rows) cannot both
   * believe they won. Swapping a value for itself changes nothing and wins
   * nothing.
   */
  casMeta(key: string, expected: string | undefined, next: string): boolean {
    if (expected === undefined) {
      return Number(this.db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(key, next).changes) > 0;
    }
    if (expected === next) return false;
    return Number(
      this.db.prepare('UPDATE meta SET value = ? WHERE key = ? AND value = ?').run(next, key, expected).changes,
    ) > 0;
  }

  /** Several keys in one statement, so they are written together or not at all. */
  setMetas(entries: Array<[string, string]>): void {
    if (entries.length === 0) return;
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES ${entries.map(() => '(?, ?)').join(', ')}
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(...entries.flat());
  }
}
