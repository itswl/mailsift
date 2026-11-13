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
  uid INTEGER, uid_validity TEXT,
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
  mailDate: string | null;
  createdAt: string;
  /** When the reader marked it dealt with, in the page or through feedback; null while it still needs them. */
  handledAt: string | null;
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
  messageCount: number;
  latest: MailRow;
  messages: MailRow[];
}

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

export type FeedbackLabel = 'false_positive' | 'missed' | 'handled' | 'correct';

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
 * between two folders, or one marked handled while another is put back.
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
/** Nobody may be reading the list (notifications off); it must not grow without end. */
const MAX_REJUDGED = 200;
/** How far back the change signature looks; a little past the widest window the page offers. */
const SIGNATURE_WINDOW_DAYS = 35;
/** More than anyone has browsers; the oldest gives way to the newest. */
const MAX_PUSH_SUBSCRIPTIONS = 50;
/** What a sign-in link summary starts with, whichever of its two wordings was stored. */
const SIGN_IN_LINK_SUMMARY_PREFIX = SIGN_IN_LINK_SUMMARY.replace(/[。.]$/, '');

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
  'decided_by', 'pushed', 'mail_date', 'attachments_json', 'verification_code', 'handled_at', 'created_at',
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
    mailDate: (raw['mail_date'] as string) ?? null,
    createdAt: String(raw['created_at'] ?? ''),
    handledAt: (raw['handled_at'] as string) ?? null,
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
      ['uid', 'INTEGER'], ['uid_validity', 'TEXT'],
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
    const seen = Number(this.db.prepare('DELETE FROM seen WHERE created_at < ?').run(cutoff).changes);
    const dead = Number(this.db.prepare('DELETE FROM dead_letter WHERE created_at < ?').run(cutoff).changes);
    const outbox = Number(this.db.prepare(
      'DELETE FROM notification_outbox WHERE delivered_at IS NOT NULL AND delivered_at < ?',
    ).run(cutoff).changes);
    const mcpAudit = Number(this.db.prepare('DELETE FROM mcp_audit WHERE created_at < ?').run(cutoff).changes);
    const mailActions = Number(this.db.prepare('DELETE FROM mail_actions WHERE created_at < ?').run(cutoff).changes);
    const digests = Number(this.db.prepare('DELETE FROM digest_log WHERE sent_at < ?').run(cutoff).changes);
    return seen + dead + outbox + mcpAudit + mailActions + digests;
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

  notificationOutboxPending(): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM notification_outbox WHERE delivered_at IS NULL',
    ).get() as Record<string, unknown>;
    return Number(row['n'] ?? 0);
  }

  notificationOutboxDelayed(): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM notification_outbox WHERE delivered_at IS NULL AND next_attempt_at > ?',
    ).get(now()) as Record<string, unknown>;
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
      // vote, or a single misjudged mail could mute its sender for good.
      `SELECT s.sender, f.label, COUNT(DISTINCT f.dedup_key) AS n
       FROM feedback f JOIN seen s ON s.dedup_key = f.dedup_key
       WHERE s.sender IS NOT NULL AND s.sender != ''
         AND f.label IN ('missed', 'false_positive')
       GROUP BY s.sender, f.label HAVING COUNT(DISTINCT f.dedup_key) >= ?`,
    ).all(Math.max(1, minSamples)) as Array<Record<string, unknown>>;
    const alwaysImportant: string[] = [];
    const neverImportant: string[] = [];
    for (const row of rows) {
      const sender = String(row['sender']).toLowerCase();
      if (row['label'] === 'missed') alwaysImportant.push(sender);
      if (row['label'] === 'false_positive') neverImportant.push(sender);
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
   * Every stored record a Message-ID or a key names, with its mailbox. One
   * message can be stored once per mailbox (a forwarded copy, or a message
   * addressed to two of them), and getMail returns only one of those.
   */
  /**
   * Whether a string has the shape of a record key: a mailbox this store
   * holds mail for, a bar, and the rest. A real Message-ID ("<...>", or a
   * bare one with no bar) never does; a look-alike's does.
   */
  keyShaped(value: string): boolean {
    const text = value.trim();
    if (text.startsWith('<')) return false;
    const bar = text.indexOf('|');
    if (bar <= 0) return false;
    return Boolean(this.db.prepare('SELECT 1 FROM seen WHERE account = ? LIMIT 1').get(text.slice(0, bar)));
  }

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
  setHandled(idOrKey: string, handled: boolean): MailRow | undefined {
    const key = this.keyOf(idOrKey);
    if (key === undefined) return undefined;
    const result = handled
      ? this.db.prepare('UPDATE seen SET handled_at = ? WHERE dedup_key = ? AND handled_at IS NULL').run(now(), key)
      : this.db.prepare('UPDATE seen SET handled_at = NULL WHERE dedup_key = ? AND handled_at IS NOT NULL').run(key);
    if (Number(result.changes) > 0) this.bumpMailRevision();
    return this.getMail(key);
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
   * out, as does anything older than the queue itself or than a month.
   */
  private attentionWhere(): { clause: string; params: string[] } {
    const rule = this.queueRule();
    return { clause: `handled_at IS NULL AND ${rule.clause}`, params: rule.params };
  }

  /** What belongs in the queue, whether or not it has been dealt with. */
  private queueRule(): { clause: string; params: string[] } {
    const monthAgo = new Date(Date.now() - ATTENTION_WINDOW_DAYS * 86_400_000).toISOString();
    const since = this.attentionSince();
    return {
      clause:
        `importance IS NOT NULL
         AND (pushed = 1 OR importance = 'critical')
         AND (verification_code IS NULL OR verification_code = '')
         AND (summary IS NULL OR (summary NOT LIKE ? AND summary NOT LIKE ?))
         AND (decided_by IS NULL OR decided_by NOT IN ('health', 'digest'))
         AND created_at >= ?`,
      params: [`${VERIFICATION_SUMMARY_PREFIX}%`, `${SIGN_IN_LINK_SUMMARY_PREFIX}%`, since > monthAgo ? since : monthAgo],
    };
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

  /** The queue, newest first. */
  attention(limit = 50): MailRow[] {
    const { clause, params } = this.attentionWhere();
    return (
      this.db.prepare(
        `SELECT ${ROW_COLUMNS.join(', ')} FROM seen WHERE ${clause}
         ORDER BY created_at DESC, dedup_key DESC LIMIT ?`,
      ).all(...params, Math.max(1, Math.min(Math.floor(limit), 200))) as Array<Record<string, unknown>>
    ).map(toRow);
  }

  /** How long the queue is, which is also the number on the app's badge. */
  attentionCount(): number {
    const { clause, params } = this.attentionWhere();
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM seen WHERE ${clause}`).get(...params) as Record<string, unknown>;
    return Number(row['n'] ?? 0);
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
   * notified, handled or moved, a digest queued or sent. `poll` covers the
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

    return [...groups.entries()]
      .map(([threadKey, messages]) => {
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
        } satisfies MailThread;
      })
      .sort((a, b) =>
        b.latest.createdAt.localeCompare(a.latest.createdAt)
        || b.latest.dedupKey.localeCompare(a.latest.dedupKey))
      .slice(0, requested);
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
