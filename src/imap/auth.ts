/**
 * IMAP authentication: password and XOAUTH2.
 *
 * Most providers use an app password (plain LOGIN). Gmail and personal Outlook
 * accounts have disabled basic auth, so they require XOAUTH2.
 *
 * access_token values are short-lived; refresh_token values are persisted.
 * Initial authorization is handled by scripts/oauth-setup.ts.
 */
import { chmod, mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { getLogger } from '../logger.js';
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
}

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
    };
  }
  return records;
}

export function tokenStorePath(): string {
  return process.env.TOKEN_STORE_PATH ?? 'data/tokens.json';
}

export function getOAuthProvider(auth: AuthKind): OAuthProvider {
  if (auth === 'gmail_oauth') {
    const clientId = process.env.GMAIL_CLIENT_ID?.trim();
    if (!clientId) {
      throw new AuthError(
        'Gmail accounts require GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET. ' +
          'Create a desktop OAuth client in Google Cloud Console and add it to .env.\n' +
          'Personal Gmail can use gmail_pw plus an app password instead.',
      );
    }
    return {
      name: 'gmail',
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scope: 'https://mail.google.com/',
      clientId,
      ...(process.env.GMAIL_CLIENT_SECRET?.trim()
        ? { clientSecret: process.env.GMAIL_CLIENT_SECRET.trim() }
        : {}),
    };
  }

  if (auth === 'outlook_oauth') {
    const clientId = process.env.OUTLOOK_CLIENT_ID?.trim();
    if (!clientId) {
      throw new AuthError(
        'Outlook accounts require OUTLOOK_CLIENT_ID. Register a public client in Entra, ' +
          'set its redirect URI to http://localhost:8765/, and add it to .env.',
      );
    }
    const tenant = process.env.OUTLOOK_TENANT?.trim() || 'common';
    return {
      name: 'outlook',
      authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
      tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      scope: 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access',
      clientId,
      ...(process.env.OUTLOOK_CLIENT_SECRET?.trim()
        ? { clientSecret: process.env.OUTLOOK_CLIENT_SECRET.trim() }
        : {}),
    };
  }

  throw new AuthError(`Unknown OAuth type: ${auth}`);
}

/**
 * Persistent refresh_token storage.
 *
 * File mode is 0600: these are long-lived mailbox credentials.
 */
export class TokenStore {
  private static readonly saveQueues = new Map<string, Promise<void>>();

  constructor(private readonly path: string = tokenStorePath()) {}

  private async readAll(): Promise<Record<string, TokenRecord>> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return {};
      log.error(`Cannot read token file safely: ${this.path} -> ${error}`);
      throw new AuthError('Token store cannot be read; refusing to replace it');
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
    const previous = TokenStore.saveQueues.get(this.path) ?? Promise.resolve();
    let current: Promise<void>;
    current = previous.catch(() => undefined).then(async () => {
      // The lock directory lives beside the token file, so create its parent
      // before attempting to acquire it on first use.
      await mkdir(dirname(this.path), { recursive: true });
      await this.withFileLock(async () => {
        const all = await this.readAll();
        all[username] = record;
        const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await writeFile(tmp, JSON.stringify(all, null, 2), 'utf8');
          await chmod(tmp, 0o600);
          await rename(tmp, this.path);
        } finally {
          await unlink(tmp).catch(() => undefined);
        }
      });
    });
    TokenStore.saveQueues.set(this.path, current);
    try {
      await current;
    } finally {
      if (TokenStore.saveQueues.get(this.path) === current) TokenStore.saveQueues.delete(this.path);
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
        await new Promise((resolve) => setTimeout(resolve, 50));
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
export function buildTokenRecord(payload: unknown, previous?: TokenRecord): TokenRecord {
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
  return {
    refreshToken,
    accessToken: data.access_token,
    expiresAt: Date.now() / 1000 + expiresIn,
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
    throw new AuthError(`${username} has no authorization record. Run: npm run oauth -- --account ${username}`);
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
      scope: provider.scope,
    }),
    record,
  );
  await store.save(username, updated);
  return updated.accessToken;
}
