/**
 * IMAP 认证：明文密码 与 XOAUTH2。
 *
 * 绝大多数邮箱走授权码（明文 LOGIN）；Gmail 和 Outlook 个人账号自
 * 2024-09 起基本认证已关闭，必须 XOAUTH2。三家在 IMAP 这一层是同一个
 * 引擎，差别只在这里。
 *
 * access_token 短命（约 1 小时），refresh_token 长期有效并落盘。
 * 首次授权由 scripts/oauth-setup.ts 交互完成。
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getLogger } from '../logger.js';
import type { AuthKind } from '../config.js';

const log = getLogger('auth');

/** access_token 提前这么多秒视为过期，避免卡在边界上 */
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

export function tokenStorePath(): string {
  return process.env.TOKEN_STORE_PATH ?? 'data/tokens.json';
}

export function getOAuthProvider(auth: AuthKind): OAuthProvider {
  if (auth === 'gmail_oauth') {
    const clientId = process.env.GMAIL_CLIENT_ID?.trim();
    if (!clientId) {
      throw new AuthError(
        'Gmail 账号需要 GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET。' +
          '在 Google Cloud Console 建「桌面应用」型 OAuth 客户端后填进 .env。\n' +
          '个人 Gmail 也可以改用 gmail_pw + 应用专用密码，不必注册应用。',
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
        'Outlook 账号需要 OUTLOOK_CLIENT_ID。在 Entra 注册「公共客户端」应用，' +
          '重定向 URI 填 http://localhost:8765/ 后填进 .env',
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

  throw new AuthError(`未知 OAuth 类型: ${auth}`);
}

/**
 * refresh_token 的落盘存储。
 *
 * 文件权限收到 0600——里面是长期有效的邮箱访问凭据，泄漏等同于邮箱被接管。
 */
export class TokenStore {
  constructor(private readonly path: string = tokenStorePath()) {}

  private async readAll(): Promise<Record<string, TokenRecord>> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Record<string, TokenRecord>;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') log.error(`token 文件读不了，当作空处理: ${this.path} -> ${error}`);
      return {};
    }
  }

  async get(username: string): Promise<TokenRecord | undefined> {
    return (await this.readAll())[username];
  }

  async save(username: string, record: TokenRecord): Promise<void> {
    const all = await this.readAll();
    all[username] = record;
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(all, null, 2), 'utf8');
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
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
      `${provider.name} token 请求失败: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`,
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
 * 把 token 响应转成落盘记录。
 *
 * 刷新响应里不一定回带 refresh_token（Google 通常不带），这时沿用旧的，
 * 否则一次刷新就把长期凭据弄丢了。
 */
export function buildTokenRecord(payload: unknown, previous?: TokenRecord): TokenRecord {
  const data = payload as { refresh_token?: string; access_token?: string; expires_in?: number };
  const refreshToken = data.refresh_token ?? previous?.refreshToken;
  if (!refreshToken) {
    throw new AuthError('授权响应里没有 refresh_token，且本地也没有旧值可沿用');
  }
  return {
    refreshToken,
    accessToken: data.access_token ?? '',
    expiresAt: Date.now() / 1000 + (data.expires_in ?? 3600),
  };
}

/** 取可用的 access_token，过期就自动刷新并回写。 */
export async function getAccessToken(
  username: string,
  auth: AuthKind,
  store: TokenStore = new TokenStore(),
): Promise<string> {
  const record = await store.get(username);
  if (!record) {
    throw new AuthError(`${username} 还没有授权记录。先跑: npm run oauth -- --account ${username}`);
  }
  if (record.accessToken && record.expiresAt - EXPIRY_SKEW_SECONDS > Date.now() / 1000) {
    return record.accessToken;
  }

  const provider = getOAuthProvider(auth);
  log.info(`刷新 access_token: ${username} (${provider.name})`);
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
