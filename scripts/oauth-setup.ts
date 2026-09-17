#!/usr/bin/env node
/**
 * Interactive OAuth setup that persists refresh_token values.
 *
 * Gmail and personal Outlook IMAP require XOAUTH2. This script runs the
 * authorization-code + PKCE flow once; the service refreshes access_token later.
 *
 *   npm run oauth                      authorize all OAuth accounts
 *   npm run oauth -- --account a@b.c   authorize one account
 *   npm run oauth -- --manual          headless server/container mode
 *
 * On a server, --manual prints the authorization URL. Open it on your computer,
 * approve access, then paste the complete redirected URL back into the terminal.
 */
import '../src/env.js'; // Must run first so .env is loaded.
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

/** Try the system browser; a failure is harmless because the URL is printed. */
function openBrowser(url: string): void {
  const darwin = process.platform === 'darwin';
  const win32 = process.platform === 'win32';
  const cmd = darwin ? 'open' : win32 ? 'cmd' : 'xdg-open';
  const args = win32 ? ['/c', 'start', '', url] : [url];
  try {
    // Headless servers may not have xdg-open; do not crash.
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    /* The printed URL can be opened manually. */
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
  // Google does not return refresh_token without these parameters.
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
      console.log(`❌ Authorization denied: ${url.searchParams.get('error')}`);
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
        ? '<h2>✅ Authorization succeeded</h2><p>refresh_token was saved. You can close this page.</p>'
        : `<h2>❌ Authorization failed</h2><p>${url.searchParams.get('error') ?? 'Unknown error'}</p>`;
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

  console.log(`\n=== Authorizing ${account.name} (${account.username}) via ${provider.name} ===`);

  let code: string | undefined;
  if (manual) {
    console.log('\n1) Open this link in a browser on your computer:\n');
    console.log(url);
    console.log(`\n2) After approval the browser redirects to ${redirectUri}; it is normal that it does not load.`);
    console.log('3) Paste the complete URL from the address bar (or only the value after code=):\n');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    code = codeFromInput(await rl.question('> '));
    rl.close();
  } else {
    console.log('Opening the authorization page; open this URL manually if needed:');
    console.log(url);
    console.log(`\n(The redirect URI must be registered as ${redirectUri} or http://localhost.)`);
    console.log('Waiting for the authorization callback (5-minute timeout)...');
    openBrowser(url);
    code = await waitForCallback(port);
  }

  if (!code) {
    console.log('❌ No authorization code received.');
    return false;
  }
  try {
    await store.save(account.username, buildTokenRecord(await exchangeCode(provider, code, redirectUri, verifier)));
  } catch (error) {
    console.log(`❌ Token exchange failed: ${error instanceof AuthError ? error.message : error}`);
    return false;
  }
  console.log(`✅ ${account.username} authorized; refresh_token saved.`);
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
      console.log(`❌ No OAuth account configured for ${values.account}.`);
      return 1;
    }
  }
  if (targets.length === 0) {
    console.log('No OAuth accounts configured; password/app-password accounts do not use this flow.');
    return 0;
  }

  let failed = 0;
  for (const account of targets) {
    if (existing.has(account.username) && !values.force) {
      console.log(`⏭  ${account.username} is already authorized; skipping (use --force to repeat).`);
      continue;
    }
    if (!(await authorize(account, store, values.manual))) failed += 1;
  }
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code));
