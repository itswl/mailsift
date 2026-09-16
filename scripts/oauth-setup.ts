#!/usr/bin/env node
/**
 * 交互式 OAuth 授权，把 refresh_token 落盘。
 *
 * Gmail 和 Outlook 个人账号的 IMAP 都只认 XOAUTH2，这个脚本走一次
 * 授权码 + PKCE 流程，之后服务自己刷新 access_token，不用再管。
 *
 *   npm run oauth                      给所有需要授权的账号依次授权
 *   npm run oauth -- --account a@b.c   只授权某一个
 *   npm run oauth -- --manual          无浏览器环境（服务器 / 容器）
 *
 * 服务器上没有浏览器、也没法把 localhost:8765 暴露给你，所以 --manual
 * 只打印授权链接：你在自己电脑的浏览器里打开、同意，浏览器会跳到一个
 * 打不开的 localhost 地址——把**地址栏里的完整 URL** 粘回来即可。
 */
import '../src/env.js'; // 必须最先执行：把 .env 灌进 process.env
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { loadConfig, needsOAuth, type Account } from '../src/config.js';
import {
  AuthError, buildTokenRecord, exchangeCode, getOAuthProvider, TokenStore, type OAuthProvider,
} from '../src/imap/auth.js';

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(64).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** 尽力把授权 URL 交给系统浏览器打开；打不开也不影响主流程，上面已打印链接可手动开。 */
function openBrowser(url: string): void {
  const darwin = process.platform === 'darwin';
  const win32 = process.platform === 'win32';
  const cmd = darwin ? 'open' : win32 ? 'cmd' : 'xdg-open';
  const args = win32 ? ['/c', 'start', '', url] : [url];
  try {
    // 无头服务器上可能没有 xdg-open，错误必须就地吞掉，不能让进程崩
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    /* 忽略：浏览器打不开时用户照着打印的链接手动开即可 */
  }
}

function authorizeUrl(
  provider: OAuthProvider, redirectUri: string, challenge: string, loginHint: string,
): string {
  const params = new URLSearchParams({
    client_id: provider.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: provider.scope,
    state: randomBytes(16).toString('base64url'),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    login_hint: loginHint,
  });
  // 不加这两个参数 Google 不返回 refresh_token
  if (provider.name === 'gmail') {
    params.set('access_type', 'offline');
    params.set('prompt', 'consent');
  }
  return `${provider.authorizeUrl}?${params}`;
}

function codeFromInput(raw: string): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  if (text.startsWith('http://') || text.startsWith('https://')) {
    const url = new URL(text);
    if (url.searchParams.get('error')) {
      console.log(`❌ 授权被拒绝: ${url.searchParams.get('error')}`);
      return undefined;
    }
    return url.searchParams.get('code') ?? undefined;
  }
  return text;
}

async function waitForCallback(port: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      const code = url.searchParams.get('code') ?? undefined;
      const body = code
        ? '<h2>✅ 授权成功</h2><p>refresh_token 已写入本地，可以关掉这个页面了。</p>'
        : `<h2>❌ 授权失败</h2><p>${url.searchParams.get('error') ?? '未知错误'}</p>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:3rem;text-align:center">${body}</body>`);
      server.close();
      resolve(code);
    });
    server.listen(port, '127.0.0.1');
    setTimeout(() => {
      server.close();
      resolve(undefined);
    }, 300_000).unref();
  });
}

async function authorize(account: Account, store: TokenStore, manual: boolean): Promise<boolean> {
  const provider = getOAuthProvider(account.auth);
  const port = Number(process.env.OAUTH_REDIRECT_PORT ?? 8765);
  const redirectUri = `http://localhost:${port}/`;
  const { verifier, challenge } = pkcePair();
  const url = authorizeUrl(provider, redirectUri, challenge, account.username);

  console.log(`\n=== 授权 ${account.name} (${account.username}) via ${provider.name} ===`);

  let code: string | undefined;
  if (manual) {
    console.log('\n1) 在你自己电脑的浏览器里打开下面这个链接：\n');
    console.log(url);
    console.log(`\n2) 同意授权后浏览器会跳到 ${redirectUri}… 这个地址打不开是正常的。`);
    console.log('3) 把浏览器地址栏里的**完整 URL** 复制粘贴到这里（或只粘 code= 后面那段）：\n');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    code = codeFromInput(await rl.question('> '));
    rl.close();
  } else {
    console.log('浏览器将打开授权页；若没弹出，手动访问：');
    console.log(url);
    console.log(`\n（重定向 URI 必须已在应用里注册为 ${redirectUri} 或 http://localhost）`);
    console.log('等待授权回调…（5 分钟超时）');
    openBrowser(url);
    code = await waitForCallback(port);
  }

  if (!code) {
    console.log('❌ 没拿到授权码');
    return false;
  }
  try {
    await store.save(account.username, buildTokenRecord(await exchangeCode(provider, code, redirectUri, verifier)));
  } catch (error) {
    console.log(`❌ 换取 token 失败: ${error instanceof AuthError ? error.message : error}`);
    return false;
  }
  console.log(`✅ ${account.username} 授权完成，refresh_token 已写入`);
  return true;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      account: { type: 'string' },
      force: { type: 'boolean', default: false },
      manual: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const config = loadConfig();
  const store = new TokenStore();
  const existing = new Set(await store.usernames());

  let targets = config.accounts.filter(needsOAuth);
  if (values.account) {
    targets = targets.filter((a) => a.username === values.account);
    if (targets.length === 0) {
      console.log(`❌ 配置里没有需要 OAuth 的账号: ${values.account}`);
      return 1;
    }
  }
  if (targets.length === 0) {
    console.log('没有需要 OAuth 授权的账号（密码/授权码认证的邮箱不走这里）');
    return 0;
  }

  let failed = 0;
  for (const account of targets) {
    if (existing.has(account.username) && !values.force) {
      console.log(`⏭  ${account.username} 已授权，跳过（要重来加 --force）`);
      continue;
    }
    if (!(await authorize(account, store, values.manual))) failed += 1;
  }
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code));
