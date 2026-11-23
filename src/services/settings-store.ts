/**
 * The server's own configuration, kept in its database instead of a file the
 * operator edits.
 *
 * Everything an administrator enters on the settings page lives in one
 * document: the scalar settings (named as the environment variables the rest
 * of the code has always read), the mailboxes, and whether first-run setup has
 * been finished. The document and the OAuth token records are encrypted with
 * AES-256-GCM under a key kept in a file of its own (MAILSIFT_KEY_FILE, by
 * default beside the database). In the container that file sits on a separate
 * volume, so a copy of the database alone does not carry a single credential.
 *
 * Administrator access is stored here as well: an scrypt hash of the password,
 * the hash of the one-time setup code printed while no password exists, and
 * the hashes of signed-in browser sessions.
 */
import {
  createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual,
} from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = import('node:sqlite').DatabaseSync;

const SETTINGS_ROW = 'settings.v2';
const TOKENS_ROW = 'oauth-tokens.v1';
const PENDING_ROW = 'oauth-pending.v1';
const ADMIN_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD = 10;
const MAX_PASSWORD = 1024;

export class SettingsKeyError extends Error {
  override name = 'SettingsKeyError';
}

/** One monitored mailbox, as the settings page edits it. */
export interface MailboxSettings {
  /** Stable identifier; the address can be edited, this cannot. */
  id: string;
  provider: string;
  username: string;
  /** App password or IMAP password; absent for OAuth mailboxes. */
  password?: string;
  name?: string;
  host?: string;
  port?: number;
  ssl?: boolean;
  /** IMAP folder paths or the keywords `all` and `spam`; empty means INBOX and spam. */
  folders?: string[];
  smtpHost?: string;
  smtpPort?: number;
  fromName?: string;
  authservId?: string;
  /** A disabled mailbox stays configured but is not polled or shown. */
  enabled: boolean;
}

export interface SettingsDocument {
  /** Scalar settings, keyed by their environment names. Absent means default. */
  values: Record<string, string>;
  mailboxes: MailboxSettings[];
  /** When the administrator finished first-run setup; monitoring starts after it. */
  setupCompletedAt?: string;
}

const emptyDocument = (): SettingsDocument => ({ values: {}, mailboxes: [] });

// ---------------------------------------------------------------------------
// Database and key
// ---------------------------------------------------------------------------

export function settingsDbPath(): string {
  return process.env.STATE_DB_PATH?.trim() || 'data/mailsift.db';
}

/** Where the encryption key lives. In the image this is a volume of its own. */
export function settingsKeyPath(): string {
  const configured = process.env.MAILSIFT_KEY_FILE?.trim();
  return resolve(configured || resolve(dirname(settingsDbPath()), 'mailsift.key'));
}

let connection: { path: string; db: DatabaseSync } | undefined;
const memoryKey = randomBytes(32);
let cachedKey: { path: string; key: Buffer } | undefined;

function database(): DatabaseSync {
  const path = settingsDbPath();
  if (connection?.path === path) return connection.db;
  closeSettingsStore();
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings_store (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings_admin (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      password_hash TEXT,
      setup_code_hash TEXT,
      changed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS settings_admin_sessions (
      token_hash TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  if (path !== ':memory:') {
    try { chmodSync(path, 0o600); } catch { /* not ours to change, e.g. a read-only mount */ }
  }
  connection = { path, db };
  return db;
}

/** Close the shared connection; the next call opens it again (tests, CLI tools). */
export function closeSettingsStore(): void {
  try { connection?.db.close(); } catch { /* already closed */ }
  connection = undefined;
  cachedKey = undefined;
}

function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function readKeyFile(path: string): Buffer | undefined {
  try {
    const key = readFileSync(path);
    if (key.length !== 32) throw new SettingsKeyError(`The settings key at ${path} is not a 32-byte key.`);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * The key, created on first use. Never created when encrypted data already
 * exists: a fresh key could not read it, and writing over it would silently
 * destroy every stored credential.
 */
function encryptionKey(): Buffer {
  if (settingsDbPath() === ':memory:') return memoryKey;
  const path = settingsKeyPath();
  if (cachedKey?.path === path) return cachedKey.key;
  let key = readKeyFile(path);
  if (!key) {
    const existing = database().prepare('SELECT COUNT(*) AS n FROM settings_store WHERE key IN (?, ?, ?)')
      .get(SETTINGS_ROW, TOKENS_ROW, PENDING_ROW) as { n: number };
    if (existing.n > 0) {
      throw new SettingsKeyError(
        `The stored settings are encrypted, but the key file ${path} is missing. ` +
        'Restore it from the backup of the secrets volume, or start with an empty data volume.',
      );
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    key = readKeyFile(path);
    if (!key) throw new SettingsKeyError(`Could not create the settings key at ${path}.`);
  }
  try { chmodSync(path, 0o600); } catch { /* read-only secret mounts are fine */ }
  cachedKey = { path, key };
  return key;
}

function encrypt(purpose: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(`mailsift:${purpose}`));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

function decrypt(purpose: string, sealed: string): string {
  const [version, iv, tag, body] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || body === undefined) {
    throw new SettingsKeyError('Stored settings have an unknown format.');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(`mailsift:${purpose}`));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error instanceof SettingsKeyError) throw error;
    throw new SettingsKeyError(
      `The stored settings cannot be decrypted with the key at ${settingsKeyPath()}. ` +
      'It is not the key they were written with.',
    );
  }
}

function readSealed(row: string): string | undefined {
  const found = database().prepare('SELECT value FROM settings_store WHERE key = ?').get(row) as { value: string } | undefined;
  return found ? decrypt(row, found.value) : undefined;
}

function writeSealed(row: string, plaintext: string): void {
  database().prepare('INSERT INTO settings_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(row, encrypt(row, plaintext));
}

// ---------------------------------------------------------------------------
// The settings document
// ---------------------------------------------------------------------------

function normalizeMailbox(raw: unknown): MailboxSettings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const m = raw as Record<string, unknown>;
  const str = (key: string): string | undefined => typeof m[key] === 'string' && m[key] ? m[key] as string : undefined;
  const num = (key: string): number | undefined => typeof m[key] === 'number' && Number.isFinite(m[key]) ? m[key] as number : undefined;
  const id = str('id');
  const provider = str('provider');
  const username = str('username');
  if (!id || !provider || !username) return undefined;
  const folders = Array.isArray(m['folders']) ? (m['folders'] as unknown[]).filter((f): f is string => typeof f === 'string' && f !== '') : [];
  const out: MailboxSettings = { id, provider, username, enabled: m['enabled'] !== false };
  const optional: Array<[keyof MailboxSettings, unknown]> = [
    ['password', str('password')], ['name', str('name')], ['host', str('host')], ['port', num('port')],
    ['ssl', typeof m['ssl'] === 'boolean' ? m['ssl'] : undefined], ['smtpHost', str('smtpHost')],
    ['smtpPort', num('smtpPort')], ['fromName', str('fromName')], ['authservId', str('authservId')],
  ];
  for (const [key, value] of optional) if (value !== undefined) (out as unknown as Record<string, unknown>)[key] = value;
  if (folders.length) out.folders = folders;
  return out;
}

function parseDocument(raw: string | undefined): SettingsDocument {
  if (!raw) return emptyDocument();
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyDocument();
  const p = parsed as Record<string, unknown>;
  const values: Record<string, string> = {};
  if (p['values'] && typeof p['values'] === 'object' && !Array.isArray(p['values'])) {
    for (const [key, value] of Object.entries(p['values'] as Record<string, unknown>)) {
      if (typeof value === 'string') values[key] = value;
    }
  }
  const mailboxes = Array.isArray(p['mailboxes'])
    ? (p['mailboxes'] as unknown[]).map(normalizeMailbox).filter((m): m is MailboxSettings => Boolean(m))
    : [];
  return {
    values,
    mailboxes,
    ...(typeof p['setupCompletedAt'] === 'string' && p['setupCompletedAt'] ? { setupCompletedAt: p['setupCompletedAt'] } : {}),
  };
}

export function readSettings(): SettingsDocument {
  return parseDocument(readSealed(SETTINGS_ROW));
}

/** Change the document atomically: concurrent saves from two tabs cannot lose each other's changes. */
export function updateSettings(change: (doc: SettingsDocument) => void): SettingsDocument {
  const db = database();
  return transaction(db, () => {
    const doc = parseDocument(readSealed(SETTINGS_ROW));
    change(doc);
    writeSealed(SETTINGS_ROW, JSON.stringify(doc));
    return doc;
  });
}

export function newMailboxId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

/** Random API credentials, created once so MCP and the page always have a key of their own. */
export function ensureAccessTokens(): { read: string; write: string } {
  const values = readSettings().values;
  if (values['MCP_TOKEN'] && values['MCP_WRITE_TOKEN'] && values['MCP_TOKEN'] !== values['MCP_WRITE_TOKEN']) {
    return { read: values['MCP_TOKEN'], write: values['MCP_WRITE_TOKEN'] };
  }
  const doc = updateSettings((d) => {
    if (!d.values['MCP_TOKEN']) d.values['MCP_TOKEN'] = newAccessToken();
    if (!d.values['MCP_WRITE_TOKEN'] || d.values['MCP_WRITE_TOKEN'] === d.values['MCP_TOKEN']) {
      d.values['MCP_WRITE_TOKEN'] = newAccessToken();
    }
  });
  return { read: doc.values['MCP_TOKEN']!, write: doc.values['MCP_WRITE_TOKEN']! };
}

export function newAccessToken(): string {
  return `ms_${randomBytes(24).toString('base64url')}`;
}

// ---------------------------------------------------------------------------
// OAuth token records (read and written by imap/auth.ts)
// ---------------------------------------------------------------------------

export function readOAuthTokens(): string | undefined {
  return readSealed(TOKENS_ROW);
}

/** Read, change and write the token records in one transaction, so two refreshes cannot overwrite each other. */
export function updateOAuthTokens(change: (current: string | undefined) => string): void {
  const db = database();
  transaction(db, () => {
    writeSealed(TOKENS_ROW, change(readSealed(TOKENS_ROW)));
  });
}

/**
 * An OAuth sign-in between its start and the provider's redirect. Kept in the
 * database rather than in memory, because saving the mailbox it belongs to
 * may restart the service in between.
 */
export interface PendingOAuth {
  mailboxId: string;
  username: string;
  verifier: string;
  redirectUri: string;
  scope: string;
  /** The page's own origin, to go back to after the provider's redirect. */
  returnTo: string;
  expiresAt: number;
}

function readPending(): Record<string, PendingOAuth> {
  const raw = readSealed(PENDING_ROW);
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const now = Date.now();
  const out: Record<string, PendingOAuth> = {};
  for (const [state, value] of Object.entries(parsed as Record<string, PendingOAuth>)) {
    if (value && typeof value === 'object' && typeof value.expiresAt === 'number' && value.expiresAt > now) out[state] = value;
  }
  return out;
}

export function savePendingOAuth(state: string, pending: PendingOAuth): void {
  const db = database();
  transaction(db, () => {
    const all = readPending();
    // One sign-in per mailbox at a time: starting again replaces the earlier one.
    for (const [key, value] of Object.entries(all)) if (value.mailboxId === pending.mailboxId) delete all[key];
    all[state] = pending;
    writeSealed(PENDING_ROW, JSON.stringify(all));
  });
}

/** The pending sign-in for this state, removed so it is used once. */
export function takePendingOAuth(state: string): PendingOAuth | undefined {
  if (!state || state.length > 200) return undefined;
  const db = database();
  return transaction(db, () => {
    const all = readPending();
    const found = all[state];
    if (!found) return undefined;
    delete all[state];
    writeSealed(PENDING_ROW, JSON.stringify(all));
    return found;
  });
}

/** Whether a state belongs to a pending sign-in, without using it. */
export function hasPendingOAuth(state: string): boolean {
  return Boolean(state && state.length <= 200 && readPending()[state]);
}

// ---------------------------------------------------------------------------
// Administrator access
// ---------------------------------------------------------------------------

const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

function digestMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(digest(presented), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

const SCRYPT = { N: 32_768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 } as const;

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password.normalize('NFKC'), salt, 32, SCRYPT);
  return `scrypt$32768$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

function passwordMatches(encoded: string, password: string): boolean {
  const [scheme, cost, salt, hash] = encoded.split('$');
  if (scheme !== 'scrypt' || !cost || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = scryptSync(password.normalize('NFKC'), Buffer.from(salt, 'base64url'), expected.length, {
    ...SCRYPT, N: Number(cost),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function passwordProblem(password: string): 'short' | 'long' | undefined {
  if ([...password].length < MIN_PASSWORD) return 'short';
  if (password.length > MAX_PASSWORD) return 'long';
  return undefined;
}

export const ADMIN_PASSWORD_MIN = MIN_PASSWORD;

/** Crockford's alphabet: nothing that reads as another character in a log. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function newSetupCode(): string {
  const bytes = randomBytes(16);
  let code = '';
  for (let i = 0; i < 16; i += 1) code += CODE_ALPHABET[bytes[i]! % 32];
  return code.match(/.{4}/g)!.join('-');
}

/** How a typed code is compared: case, spaces and dashes do not matter, nor O for 0 or I/L for 1. */
export function normalizeSetupCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

interface AdminRow { password_hash: string | null; setup_code_hash: string | null }

function adminRow(): AdminRow | undefined {
  return database().prepare('SELECT password_hash, setup_code_hash FROM settings_admin WHERE id = 1').get() as AdminRow | undefined;
}

export function adminPasswordSet(): boolean {
  return Boolean(adminRow()?.password_hash);
}

/**
 * A new one-time setup code while no administrator password exists, else
 * nothing. Each start replaces the previous code, so a code lost with a
 * rotated log is never a dead end: restarting prints a fresh one.
 */
export function issueSetupCode(): string | undefined {
  const db = database();
  return transaction(db, () => {
    if (adminRow()?.password_hash) return undefined;
    const code = newSetupCode();
    db.prepare(`INSERT INTO settings_admin (id, password_hash, setup_code_hash, changed_at) VALUES (1, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET setup_code_hash = excluded.setup_code_hash, changed_at = excluded.changed_at`)
      .run(digest(normalizeSetupCode(code)), new Date().toISOString());
    return code;
  });
}

/** Forget the password and every session, and return a new setup code (`--reset-admin`). */
export function resetAdmin(): string {
  const db = database();
  return transaction(db, () => {
    const code = newSetupCode();
    db.prepare(`INSERT INTO settings_admin (id, password_hash, setup_code_hash, changed_at) VALUES (1, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET password_hash = NULL, setup_code_hash = excluded.setup_code_hash, changed_at = excluded.changed_at`)
      .run(digest(normalizeSetupCode(code)), new Date().toISOString());
    db.exec('DELETE FROM settings_admin_sessions');
    return code;
  });
}

function newSession(db: DatabaseSync): string {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('DELETE FROM settings_admin_sessions WHERE expires_at <= ?').run(now);
  db.prepare('INSERT INTO settings_admin_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)')
    .run(digest(token), now, now + ADMIN_SESSION_TTL_MS);
  return token;
}

/**
 * Use the setup code to set the first password. The code is spent here and
 * cannot be used again; the result is a signed-in session.
 */
export function claimAdmin(code: string, password: string): string | undefined {
  if (passwordProblem(password)) return undefined;
  const db = database();
  // Hash outside the transaction: scrypt takes a moment and must not hold the write lock.
  const hashed = hashPassword(password);
  return transaction(db, () => {
    const row = adminRow();
    if (!row || row.password_hash || !row.setup_code_hash) return undefined;
    if (!digestMatches(row.setup_code_hash, normalizeSetupCode(code))) return undefined;
    db.prepare('UPDATE settings_admin SET password_hash = ?, setup_code_hash = NULL, changed_at = ? WHERE id = 1')
      .run(hashed, new Date().toISOString());
    return newSession(db);
  });
}

export function signInAdmin(password: string): string | undefined {
  const row = adminRow();
  if (!row?.password_hash || !password || password.length > MAX_PASSWORD) return undefined;
  if (!passwordMatches(row.password_hash, password)) return undefined;
  return newSession(database());
}

/** Change the password; every other session ends, the one returned replaces the caller's. */
export function changeAdminPassword(current: string, next: string): string | undefined {
  if (passwordProblem(next)) return undefined;
  const row = adminRow();
  if (!row?.password_hash || !passwordMatches(row.password_hash, current)) return undefined;
  const hashed = hashPassword(next);
  const db = database();
  return transaction(db, () => {
    db.prepare('UPDATE settings_admin SET password_hash = ?, changed_at = ? WHERE id = 1').run(hashed, new Date().toISOString());
    db.exec('DELETE FROM settings_admin_sessions');
    return newSession(db);
  });
}

export function adminSessionValid(token: string): boolean {
  if (!token) return false;
  const row = database().prepare('SELECT expires_at FROM settings_admin_sessions WHERE token_hash = ?').get(digest(token)) as
    { expires_at: number } | undefined;
  return Boolean(row && row.expires_at > Date.now());
}

export function endAdminSession(token: string): void {
  if (token) database().prepare('DELETE FROM settings_admin_sessions WHERE token_hash = ?').run(digest(token));
}

/** End every browser session except the caller's. */
export function endOtherAdminSessions(keep: string): number {
  const result = database().prepare('DELETE FROM settings_admin_sessions WHERE token_hash <> ?').run(digest(keep));
  return Number(result.changes);
}
