/**
 * IMAP authentication: password and XOAUTH2.
 *
 * Most providers use an app password (plain LOGIN). Gmail and personal Outlook
 * accounts have disabled basic auth, so they require XOAUTH2.
 *
 * access_token values are short-lived; refresh_token values are persisted.
 * Initial authorization is handled by the server settings page.
 */
import { readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname } from 'node:path';
import { getLogger } from '../logger.js';
import { readOAuthTokens, updateOAuthTokens } from '../services/settings-store.js';
import type { AuthKind } from '../config.js';

const log = getLogger('auth');

/** Treat access_token as expired this many seconds early. */
const EXPIRY_SKEW_SECONDS = 120;

export class AuthError extends Error {
  override name = 'AuthError';
}

export interface OAuthProvider {
  name: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  clientId: string;
  clientSecret?: string;
}

export interface TokenRecord {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  /**
   * The scopes this authorization was asked for. A refresh must ask for the
   * same ones: asking for more than was consented to is refused, and that
   * would take reading down with it. Absent on records made before sending
   * existed, which were all asked for the provider's default.
   */
  scope?: string;
}

/**
 * Microsoft consents to sending separately from reading. Asked for when
 * sending is on (SMTP_ENABLED), so the consent screen offers it.
 */
export const OUTLOOK_SEND_SCOPE = 'https://outlook.office.com/SMTP.Send';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTokenStore(value: unknown): Record<string, TokenRecord> {
  if (!isRecord(value)) throw new AuthError('Token store must contain a JSON object');
  const records: Record<string, TokenRecord> = {};
  for (const [username, raw] of Object.entries(value)) {
    if (!isRecord(raw) || typeof raw.refreshToken !== 'string' || !raw.refreshToken ||
        typeof raw.accessToken !== 'string' || typeof raw.expiresAt !== 'number' ||
        !Number.isFinite(raw.expiresAt)) {
      throw new AuthError(`Token store record for ${username} is invalid`);
    }
    records[username] = {
      refreshToken: raw.refreshToken,
      accessToken: raw.accessToken,
      expiresAt: raw.expiresAt,
      ...(typeof raw.scope === 'string' && raw.scope ? { scope: raw.scope } : {}),
    };
  }
  return records;
}

/**
 * Where token records live: encrypted in the settings database, unless
 * TOKEN_STORE_PATH names a JSON file (tests and one-off tools use that).
 */
export function tokenStorePath(): string | undefined {
  return process.env.TOKEN_STORE_PATH?.trim() || undefined;
}

/** The records in the settings database, read synchronously; an unreadable store holds none. */
function storedRecords(): Record<string, TokenRecord> {
  try {
    const raw = readOAuthTokens();
    return raw ? parseTokenStore(JSON.parse(raw) as unknown) : {};
  } catch (error) {
    log.warn(`OAuth token records cannot be read: ${error instanceof Error ? error.message : error}`);
    return {};
  }
}

/** Which addresses have an authorization stored, lowercased; synchronous for startup. */
export function authorizedUsernames(path = tokenStorePath()): Set<string> {
  if (path) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      return new Set(isRecord(parsed) ? Object.keys(parsed).map((name) => name.toLowerCase()) : []);
    } catch {
      return new Set();
    }
  }
  return new Set(Object.keys(storedRecords()).map((name) => name.toLowerCase()));
}

/**
 * The scopes a mailbox was authorized with, read from its protected token store.
 *
 * Synchronous because whether a mailbox can send is asked during page loads.
 * Undefined when there is no record or it predates stored scopes.
 */
let scopeCache: { path: string; mtimeMs: number; scopes: Map<string, string> } | undefined;
export function authorizedScope(username: string, path = tokenStorePath()): string | undefined {
  if (!path) return storedRecords()[username]?.scope;
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (!scopeCache || scopeCache.path !== path || scopeCache.mtimeMs !== mtimeMs) {
      const scopes = new Map<string, string>();
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (isRecord(parsed)) {
        for (const [name, raw] of Object.entries(parsed)) {
          if (isRecord(raw) && typeof raw.scope === 'string' && raw.scope) scopes.set(name, raw.scope);
        }
      }
      scopeCache = { path, mtimeMs, scopes };
    }
    return scopeCache.scopes.get(username);
  } catch {
    // No token file, or one that cannot be read: nothing is known to be granted.
    return undefined;
  }
}

export function getOAuthProvider(
  auth: AuthKind,
  options: { send?: boolean; source?: Record<string, string | undefined> } = {},
): OAuthProvider {
  const source = options.source ?? process.env;
  if (auth === 'gmail_oauth') {
    const clientId = source.GMAIL_CLIENT_ID?.trim();
    if (!clientId) {
      throw new AuthError(
        'Signing in to Gmail needs a Google OAuth client. Enter its client ID and secret under ' +
          'Settings → Mailboxes → Gmail and Outlook sign-in. Personal Gmail can use an app password instead.',
      );
    }
    return {
      name: 'gmail',
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scope: 'https://mail.google.com/',
      clientId,
      ...(source.GMAIL_CLIENT_SECRET?.trim()
        ? { clientSecret: source.GMAIL_CLIENT_SECRET.trim() }
        : {}),
    };
  }

  if (auth === 'outlook_oauth') {
    const clientId = source.OUTLOOK_CLIENT_ID?.trim();
    if (!clientId) {
      throw new AuthError(
        'Signing in to Outlook needs a Microsoft application (client) ID. Register one in Microsoft Entra ' +
          'with the redirect URI http://localhost, and enter it under Settings → Mailboxes → Gmail and Outlook sign-in.',
      );
    }
    const tenant = source.OUTLOOK_TENANT?.trim() || 'common';
    return {
      name: 'outlook',
      authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
      tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      // Reading only, unless sending was asked for: the consent screen should
      // not offer "send mail as you" to someone who wants their mail triaged.
      scope: [
        'https://outlook.office.com/IMAP.AccessAsUser.All',
        ...(options.send ? [OUTLOOK_SEND_SCOPE] : []),
        'offline_access',
      ].join(' '),
      clientId,
      ...(source.OUTLOOK_CLIENT_SECRET?.trim()
        ? { clientSecret: source.OUTLOOK_CLIENT_SECRET.trim() }
        : {}),
    };
  }

  throw new AuthError(`Unknown OAuth type: ${auth}`);
}

/**
 * Persistent refresh_token storage. By default the records are encrypted in
 * the settings database. Explicit paths remain available to local tooling.
 */
export class TokenStore {
  private static readonly saveQueues = new Map<string, Promise<void>>();

  constructor(private readonly path: string | undefined = tokenStorePath()) {}

  private async readAll(): Promise<Record<string, TokenRecord>> {
    let raw: string;
    if (!this.path) {
      raw = readOAuthTokens() ?? '{}';
    } else {
      try {
        raw = await readFile(this.path, 'utf8');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return {};
        log.error(`Cannot read token file safely: ${this.path} -> ${error}`);
        throw new AuthError('Token store cannot be read; refusing to replace it');
      }
    }
    try {
      return parseTokenStore(JSON.parse(raw) as unknown);
    } catch (error) {
      if (error instanceof AuthError) throw error;
      log.error(`Cannot parse token file safely: ${this.path} -> ${error}`);
      throw new AuthError('Token store is not valid JSON; refusing to replace it');
    }
  }

  async get(username: string): Promise<TokenRecord | undefined> {
    return (await this.readAll())[username];
  }

  async save(username: string, record: TokenRecord): Promise<void> {
    const queueKey = this.path ?? `sqlite:${process.env.STATE_DB_PATH?.trim() || 'data/mailsift.db'}`;
    const previous = TokenStore.saveQueues.get(queueKey) ?? Promise.resolve();
    let current: Promise<void>;
    current = previous.catch(() => undefined).then(async () => {
      if (!this.path) {
        updateOAuthTokens((raw) => {
          const all = parseTokenStore(raw ? JSON.parse(raw) as unknown : {});
          all[username] = record;
          return JSON.stringify(all);
        });
        return;
      }
      // The lock directory lives beside the token file, so create its parent
      // before attempting to acquire it on first use.
      const targetPath = this.path;
      await mkdir(dirname(targetPath), { recursive: true });
      await this.withFileLock(async () => {
        const all = await this.readAll();
        all[username] = record;
        const tmp = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await writeFile(tmp, JSON.stringify(all, null, 2), 'utf8');
          await chmod(tmp, 0o600);
          await rename(tmp, targetPath);
        } finally {
          await unlink(tmp).catch(() => undefined);
        }
      });
    });
    TokenStore.saveQueues.set(queueKey, current);
    try {
      await current;
    } finally {
      if (TokenStore.saveQueues.get(queueKey) === current) TokenStore.saveQueues.delete(queueKey);
    }
  }

  private async withFileLock<T>(work: () => Promise<T>): Promise<T> {
    const lockPath = `${this.path}.lock`;
    const started = Date.now();
    for (;;) {
      try {
        await mkdir(lockPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const age = Date.now() - (await stat(lockPath)).mtimeMs;
          if (age > 60_000) {
            await rm(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          // The owner may have released the lock between stat and retry.
        }
        if (Date.now() - started > 30_000) {
          throw new AuthError('Timed out waiting for the token store lock');
        }
        await sleep(50);
      }
    }
    try {
      return await work();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  async usernames(): Promise<string[]> {
    return Object.keys(await this.readAll()).sort();
  }

  /** Forget one mailbox's authorization (the mailbox was removed). Only the settings database is supported. */
  async remove(username: string): Promise<void> {
    if (this.path) throw new AuthError('Removing records from a token file is not supported');
    updateOAuthTokens((raw) => {
      const all = parseTokenStore(raw ? JSON.parse(raw) as unknown : {});
      delete all[username];
      return JSON.stringify(all);
    });
  }
}

async function postToken(provider: OAuthProvider, body: Record<string, string>): Promise<unknown> {
  const params = new URLSearchParams({ ...body, client_id: provider.clientId });
  if (provider.clientSecret) params.set('client_secret', provider.clientSecret);

  const response = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new AuthError(
      `${provider.name} token request failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`,
    );
  }
  return response.json();
}

export function exchangeCode(
  provider: OAuthProvider,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<unknown> {
  return postToken(provider, {
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  });
}

/**
 * Convert a token response into a persistent record.
 *
 * Refresh responses may omit refresh_token (Google usually does); preserve the
 * previous value or one refresh would lose the long-lived credential.
 */
export function buildTokenRecord(payload: unknown, previous?: TokenRecord, scope?: string): TokenRecord {
  if (!isRecord(payload)) throw new AuthError('Authorization response is not an object');
  const data = payload as { refresh_token?: unknown; access_token?: unknown; expires_in?: unknown };
  const refreshToken = data.refresh_token ?? previous?.refreshToken;
  if (typeof refreshToken !== 'string' || !refreshToken) {
    throw new AuthError('Authorization response has no refresh_token and no previous value is available');
  }
  if (typeof data.access_token !== 'string' || !data.access_token) {
    throw new AuthError('Authorization response has no access_token');
  }
  const expiresIn = data.expires_in === undefined ? 3600 : Number(data.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new AuthError('Authorization response has an invalid expires_in');
  }
  const asked = scope ?? previous?.scope;
  return {
    refreshToken,
    accessToken: data.access_token,
    expiresAt: Date.now() / 1000 + expiresIn,
    ...(asked ? { scope: asked } : {}),
  };
}

/** Return a usable access_token, refreshing and persisting it when expired. */
export async function getAccessToken(
  username: string,
  auth: AuthKind,
  store: TokenStore = new TokenStore(),
): Promise<string> {
  const record = await store.get(username);
  if (!record) {
    throw new AuthError(`${username} has no authorization record. Sign in to it under Settings → Mailboxes.`);
  }
  if (record.accessToken && record.expiresAt - EXPIRY_SKEW_SECONDS > Date.now() / 1000) {
    return record.accessToken;
  }

  const provider = getOAuthProvider(auth);
  log.info(`Refreshing access_token: ${username} (${provider.name})`);
  const updated = buildTokenRecord(
    await postToken(provider, {
      refresh_token: record.refreshToken,
      grant_type: 'refresh_token',
      // What this mailbox was authorized for, not what a new one would ask.
      scope: record.scope ?? provider.scope,
    }),
    record,
  );
  await store.save(username, updated);
  return updated.accessToken;
}
