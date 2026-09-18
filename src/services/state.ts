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
import type { MailMessage } from '../imap/message.js';
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
  message_id TEXT, subject TEXT, sender TEXT, sender_name TEXT,
  folder TEXT, in_spam INTEGER NOT NULL DEFAULT 0,
  importance TEXT, category TEXT, summary TEXT, reason TEXT, deadline TEXT,
  decided_by TEXT, pushed INTEGER NOT NULL DEFAULT 0,
  mail_date TEXT, snippet TEXT, created_at TEXT NOT NULL
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
  last_error TEXT, created_at TEXT NOT NULL, delivered_at TEXT
);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, dedup_key TEXT,
  label TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_seen_created ON seen (created_at);
CREATE INDEX IF NOT EXISTS idx_seen_importance ON seen (importance);
`;

export interface MailRecord {
  messageId?: string;
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
}

export interface MailRow {
  dedupKey: string;
  messageId: string | null;
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
  snippet?: string | null;
}

export interface QueryOptions {
  sinceHours?: number;
  importance?: string;
  spamOnly?: boolean;
  pushedOnly?: boolean;
  account?: string;
  search?: string;
  limit?: number;
  beforeCreatedAt?: string;
  beforeDedupKey?: string;
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

export interface NotificationOutboxRow {
  notificationKey: string;
  message: MailMessage;
  result: TriageResult;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

export type FeedbackLabel = 'false_positive' | 'missed' | 'handled' | 'correct';

function now(): string {
  return new Date().toISOString();
}

const ROW_COLUMNS = [
  'dedup_key', 'message_id', 'account', 'account_label', 'subject', 'sender', 'sender_name',
  'folder', 'in_spam', 'importance', 'category', 'summary', 'reason', 'deadline',
  'decided_by', 'pushed', 'mail_date', 'created_at',
] as const;

function toRow(raw: Record<string, unknown>): MailRow {
  return {
    dedupKey: String(raw['dedup_key'] ?? ''),
    messageId: (raw['message_id'] as string) ?? null,
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
    ...(raw['snippet'] !== undefined ? { snippet: raw['snippet'] as string } : {}),
  };
}

export class StateStore {
  private readonly db: DatabaseSync;

  constructor(path: string = process.env.STATE_DB_PATH ?? 'data/mailsift.db') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
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
    this.db
      .prepare(
        `UPDATE seen SET importance = ?, pushed = ?, message_id = ?, account_label = ?,
           sender = ?, sender_name = ?, folder = ?, in_spam = ?, category = ?,
           summary = ?, reason = ?, deadline = ?, decided_by = ?, mail_date = ?, snippet = ?
         WHERE dedup_key = ?`,
      )
      .run(
        importance, pushed ? 1 : 0,
        fields.messageId ?? null, fields.accountLabel ?? null,
        fields.sender ?? null, fields.senderName ?? null,
        fields.folder ?? null, fields.inSpam ? 1 : 0, fields.category ?? null,
        fields.summary ?? null, fields.reason ?? null, fields.deadline ?? null,
        fields.decidedBy ?? null, fields.mailDate ?? null, fields.snippet ?? null,
        dedupKey,
      );
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
    return seen + dead + outbox;
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
       (notification_key, payload, created_at) VALUES (?, ?, ?)`,
    ).run(notificationKey, JSON.stringify({ message, result }), now());
  }

  pendingNotifications(limit = 50): NotificationOutboxRow[] {
    const rows = this.db.prepare(
      `SELECT notification_key, payload, attempts, last_error, created_at
       FROM notification_outbox WHERE delivered_at IS NULL ORDER BY created_at LIMIT ?`,
    ).all(Math.max(1, Math.min(limit, 200))) as Array<Record<string, unknown>>;
    const out: NotificationOutboxRow[] = [];
    for (const row of rows) {
      try {
        const payload = JSON.parse(String(row['payload'])) as { message: MailMessage; result: TriageResult };
        out.push({
          notificationKey: String(row['notification_key']),
          message: payload.message,
          result: payload.result,
          attempts: Number(row['attempts']),
          lastError: (row['last_error'] as string) ?? null,
          createdAt: String(row['created_at']),
        });
      } catch {
        log.error(`Notification outbox record ${String(row['notification_key'])} is corrupt`);
      }
    }
    return out;
  }

  markNotificationDelivered(notificationKey: string): void {
    this.db.prepare(
      'UPDATE notification_outbox SET delivered_at = ?, last_error = NULL WHERE notification_key = ?',
    ).run(now(), notificationKey);
  }

  markNotificationFailed(notificationKey: string, error: unknown): void {
    this.db.prepare(
      `UPDATE notification_outbox SET attempts = attempts + 1, last_error = ?
       WHERE notification_key = ?`,
    ).run(String(error).slice(0, 500), notificationKey);
  }

  notificationOutboxPending(): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM notification_outbox WHERE delivered_at IS NULL',
    ).get() as Record<string, unknown>;
    return Number(row['n'] ?? 0);
  }

  recordFeedback(messageId: string, label: FeedbackLabel, note = ''): void {
    const row = this.db.prepare(
      'SELECT dedup_key FROM seen WHERE message_id = ? OR dedup_key = ? LIMIT 1',
    ).get(messageId, messageId) as Record<string, unknown> | undefined;
    this.db.prepare(
      'INSERT INTO feedback (message_id, dedup_key, label, note, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(messageId, row ? String(row['dedup_key']) : null, label, note.slice(0, 1000), now());
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
      feedback: this.feedbackSummary(),
    };
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
    if (options.spamOnly) clauses.push('in_spam = 1');
    if (options.pushedOnly) clauses.push('pushed = 1');
    if (options.account) {
      clauses.push('(account = ? OR account_label = ?)');
      params.push(options.account, options.account);
    }
    if (options.search) {
      clauses.push(
        '(subject LIKE ? OR sender LIKE ? OR sender_name LIKE ? OR reason LIKE ? OR category LIKE ? OR summary LIKE ?)',
      );
      params.push(...Array<string>(6).fill(`%${options.search}%`));
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

  getMail(messageId: string): MailRow | undefined {
    const row = this.db
      .prepare(
        `SELECT ${ROW_COLUMNS.join(', ')}, snippet FROM seen
         WHERE message_id = ? OR dedup_key = ? LIMIT 1`,
      )
      .get(messageId, messageId) as Record<string, unknown> | undefined;
    return row ? toRow(row) : undefined;
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

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }
}
