import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import './setup.js';
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';
import {
  adminPasswordSet, adminSessionValid, changeAdminPassword, claimAdmin, closeSettingsStore, endOtherAdminSessions,
  ensureAccessTokens, issueSetupCode, newAccessToken, normalizeSetupCode, readSettings, resetAdmin, savePendingSignIn, settingsKeyPath,
  signInAdmin, SettingsKeyError, startAdminSession, takePendingSignIn, updateSettings,
} from '../src/services/settings-store.js';
import { applySettings, differsFromBoot, mailboxReadiness, rememberBootState } from '../src/services/settings-runtime.js';
import { checkField, crossFieldProblems, FIELD_BY_KEY, SECRET_KEYS, TRIAGE_RULE_KEYS } from '../src/settings-catalog.js';
import { loadConfig, setSettingsAccounts } from '../src/config.js';
import { requestChannel } from '../src/web-access.js';
import { authorizedUsernames, TokenStore } from '../src/imap/auth.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailsift-settings-'));
  process.env.STATE_DB_PATH = join(dir, 'data', 'mailsift.db');
  process.env.MAILSIFT_KEY_FILE = join(dir, 'secrets', 'mailsift.key');
});

afterEach(() => {
  closeSettingsStore();
  setSettingsAccounts(undefined);
  rmSync(dir, { recursive: true, force: true });
});

function rawRows(): string {
  const db = new DatabaseSync(process.env.STATE_DB_PATH!, { readOnly: true });
  try {
    return JSON.stringify(db.prepare('SELECT * FROM settings_store').all());
  } finally {
    db.close();
  }
}

describe('the settings document', () => {
  it('is encrypted at rest under a key kept in its own file', () => {
    updateSettings((doc) => {
      doc.values['LLM_API_KEY'] = 'sk-very-secret-value';
      doc.mailboxes.push({ id: 'a', provider: 'qq', username: 'me@qq.com', password: 'app|pass|with|pipes', enabled: true });
    });
    closeSettingsStore();
    const raw = rawRows();
    expect(raw).not.toContain('sk-very-secret-value');
    expect(raw).not.toContain('app|pass');
    expect(raw).not.toContain('me@qq.com');
    expect(statSync(settingsKeyPath()).mode & 0o777).toBe(0o600);
    expect(readFileSync(settingsKeyPath())).toHaveLength(32);
    const doc = readSettings();
    expect(doc.values['LLM_API_KEY']).toBe('sk-very-secret-value');
    expect(doc.mailboxes[0]!.password).toBe('app|pass|with|pipes');
  });

  it('refuses to start over when the key that wrote it is missing or different', () => {
    updateSettings((doc) => { doc.values['LLM_MODEL'] = 'x'; });
    closeSettingsStore();
    unlinkSync(settingsKeyPath());
    expect(() => readSettings()).toThrow(SettingsKeyError);
    expect(() => readSettings()).toThrow(/missing/);
    closeSettingsStore();
    writeFileSync(settingsKeyPath(), Buffer.alloc(32, 7));
    expect(() => readSettings()).toThrow(/not the key/);
  });

  it('creates the API tokens once, different from each other, and never the admin token', () => {
    const first = ensureAccessTokens();
    expect(first.read).not.toBe(first.write);
    expect(first.read).toMatch(/^ms_/);
    expect(ensureAccessTokens()).toEqual(first);
    // The admin token carries everything: it exists only once an administrator asks for it (see test/admin-api.test.ts).
    expect(readSettings().values['MCP_ADMIN_TOKEN']).toBeUndefined();
    expect(ensureAccessTokens()).toEqual(first);
    expect(readSettings().values['MCP_ADMIN_TOKEN']).toBeUndefined();
    // Once one is issued it is left alone, like the other two.
    updateSettings((doc) => { doc.values['MCP_ADMIN_TOKEN'] = newAccessToken(); });
    expect(ensureAccessTokens()).toEqual(first);
    expect(readSettings().values['MCP_ADMIN_TOKEN']).toMatch(/^ms_/);
  });

  it('keeps a pending OAuth sign-in across a restart, for one use only', () => {
    savePendingSignIn('state-1', {
      mailboxId: 'm', username: 'a@gmail.com', verifier: 'v', redirectUri: 'http://localhost:8410/', scope: 's',
      returnTo: 'http://127.0.0.1:8410', expiresAt: Date.now() + 60_000,
    });
    closeSettingsStore();
    expect(takePendingSignIn('state-1')?.mailboxId).toBe('m');
    expect(takePendingSignIn('state-1')).toBeUndefined();
    savePendingSignIn('old', {
      mailboxId: 'm', username: 'a@gmail.com', verifier: 'v', redirectUri: 'r', scope: 's', returnTo: '', expiresAt: Date.now() - 1,
    });
    expect(takePendingSignIn('old')).toBeUndefined();
  });
});

// Each password check is a deliberately slow scrypt; give these room under a busy test run.
describe('administrator access', { timeout: 30_000 }, () => {
  it('is claimed once with the setup code, which is then spent', () => {
    expect(adminPasswordSet()).toBe(false);
    const code = issueSetupCode()!;
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    expect(claimAdmin('WRONG-CODE-0000-0000', 'a long password')).toBeUndefined();
    expect(claimAdmin(code, 'short')).toBeUndefined();
    // Typed loosely: lower case, spaces, O for 0.
    const loose = code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o');
    const session = claimAdmin(loose, 'a long password');
    expect(session).toBeTruthy();
    expect(adminSessionValid(session!)).toBe(true);
    expect(adminPasswordSet()).toBe(true);
    expect(claimAdmin(code, 'another long password')).toBeUndefined();
    expect(issueSetupCode()).toBeUndefined();
  });

  it('prints a new code at each start until claimed; the older one stops working', () => {
    const first = issueSetupCode()!;
    const second = issueSetupCode()!;
    expect(second).not.toBe(first);
    expect(claimAdmin(first, 'a long password')).toBeUndefined();
    expect(claimAdmin(second, 'a long password')).toBeTruthy();
  });

  it('signs in with the password; changing it ends every other session', () => {
    const one = claimAdmin(issueSetupCode()!, 'a long password')!;
    expect(signInAdmin('wrong password')).toBeUndefined();
    const two = signInAdmin('a long password')!;
    expect(adminSessionValid(two)).toBe(true);
    expect(changeAdminPassword('wrong password', 'a new long password')).toBe(false);
    expect(adminSessionValid(two)).toBe(true);
    expect(changeAdminPassword('a long password', 'a new long password')).toBe(true);
    expect(adminSessionValid(one)).toBe(false);
    expect(adminSessionValid(two)).toBe(false);
    const three = startAdminSession();
    expect(adminSessionValid(three)).toBe(true);
    const four = signInAdmin('a new long password')!;
    expect(endOtherAdminSessions(four)).toBe(1);
    expect(adminSessionValid(three)).toBe(false);
    expect(adminSessionValid(four)).toBe(true);
  });

  it('can be reset from the server, which signs everyone out', () => {
    const session = claimAdmin(issueSetupCode()!, 'a long password')!;
    const code = resetAdmin();
    expect(adminPasswordSet()).toBe(false);
    expect(adminSessionValid(session)).toBe(false);
    expect(claimAdmin(code, 'a fresh long password')).toBeTruthy();
  });

  it('loses no API token to that reset: they are settings, replaced one at a time by their own route', () => {
    updateSettings((doc) => { doc.values['MCP_ADMIN_TOKEN'] = 'ms_admin'; });
    resetAdmin();
    // A reset is for an administrator who forgot the password. A token that may have leaked is replaced after signing
    // back in, which is what the page's Access section and rotate_token do.
    expect(readSettings().values['MCP_ADMIN_TOKEN']).toBe('ms_admin');
  });

  it('compares setup codes leniently but exactly', () => {
    expect(normalizeSetupCode('ab1o-il22')).toBe('AB10112' + '2');
  });
});

describe('the field catalog', () => {
  it('checks numbers, choices, addresses and lists', () => {
    const field = (key: string) => FIELD_BY_KEY.get(key)!;
    expect(checkField(field('POLL_INTERVAL_SECONDS'), '20')).toHaveProperty('problem');
    expect(checkField(field('POLL_INTERVAL_SECONDS'), ' 600 ')).toEqual({ value: '600' });
    expect(checkField(field('POLL_INTERVAL_SECONDS'), '6e2')).toHaveProperty('problem');
    expect(checkField(field('PUSH_MIN_IMPORTANCE'), 'urgent')).toHaveProperty('problem');
    expect(checkField(field('FEISHU_WEBHOOK_URL'), 'javascript:alert(1)')).toHaveProperty('problem');
    expect(checkField(field('MAIL_ALWAYS_IMPORTANT'), 'a@b.c,\n @boss.com ,')).toEqual({ value: 'a@b.c,@boss.com' });
    expect(checkField(field('TZ'), 'Mars/Olympus')).toHaveProperty('problem');
    expect(checkField(field('TZ'), 'Europe/Berlin')).toEqual({ value: 'Europe/Berlin' });
    expect(checkField(field('DIGEST_HOUR'), '')).toEqual({ value: '' });
  });

  it('says when two settings do not fit together', () => {
    expect(crossFieldProblems({ LLM_PROVIDER: 'custom' }).map((p) => p.key)).toEqual(['LLM_BASE_URL']);
    expect(crossFieldProblems({ LLM_PROVIDER: 'custom', LLM_BASE_URL: 'https://x/v1' })).toEqual([]);
    expect(crossFieldProblems({ IMAP_IDLE_FOLDERS: 'INBOX,all' }).map((p) => p.key)).toEqual(['IMAP_IDLE_FOLDERS']);
  });

  it('keeps every credential among the secrets, and the tokens and the rules out of the field list', () => {
    for (const key of ['LLM_API_KEY', 'DECIDER_API_TOKEN', 'FEISHU_WEBHOOK_URL', 'FEISHU_WEBHOOK_SECRET', 'WEBHOOK_URL',
      'WEBHOOK_TOKEN', 'HEARTBEAT_PING_URL', 'GMAIL_CLIENT_SECRET', 'OUTLOOK_CLIENT_SECRET']) {
      expect(SECRET_KEYS.has(key), key).toBe(true);
    }
    // Each token is managed by its own control, never through the field list.
    for (const key of ['MCP_TOKEN', 'MCP_WRITE_TOKEN', 'MCP_ADMIN_TOKEN']) expect(FIELD_BY_KEY.has(key), key).toBe(false);
    // The four settings a writer may change without being the administrator, and no more.
    expect([...TRIAGE_RULE_KEYS].sort()).toEqual(['MAIL_ALWAYS_IMPORTANT', 'MAIL_CONTEXT', 'MAIL_KEYWORDS', 'MAIL_NEVER_IMPORTANT']);
    for (const key of TRIAGE_RULE_KEYS) expect(FIELD_BY_KEY.has(key), key).toBe(true);
  });
});

describe('handing the settings to the service', () => {
  it('sets the environment and the ready mailboxes, and puts back what it replaced', () => {
    process.env.LOG_LEVEL = 'error';
    const doc = updateSettings((d) => {
      d.values['LOG_LEVEL'] = 'debug';
      d.values['NOT_A_SETTING'] = 'ignored';
      d.mailboxes.push(
        { id: 'a', provider: 'qq', username: 'me@qq.com', password: 'pw', enabled: true },
        { id: 'b', provider: 'gmail', username: 'me@gmail.com', enabled: true },
        { id: 'c', provider: '163', username: 'off@163.com', password: 'pw', enabled: false },
      );
    });
    const accounts = applySettings(doc, new Set());
    expect(process.env.LOG_LEVEL).toBe('debug');
    expect(process.env.NOT_A_SETTING).toBeUndefined();
    expect(accounts.map((a) => a.username)).toEqual(['me@qq.com']);
    expect(loadConfig().accounts.map((a) => a.username)).toEqual(['me@qq.com']);
    expect(mailboxReadiness(doc.mailboxes[1]!, new Set())).toBe('needs-authorization');
    expect(mailboxReadiness(doc.mailboxes[1]!, new Set(['me@gmail.com']))).toBe('ready');
    expect(mailboxReadiness(doc.mailboxes[2]!, new Set())).toBe('disabled');
    const cleared = updateSettings((d) => { delete d.values['LOG_LEVEL']; });
    applySettings(cleared, new Set());
    expect(process.env.LOG_LEVEL).toBe('error');
  });

  it('gives the service a token issued in Settings in place of the one it was started with', () => {
    process.env.MCP_ADMIN_TOKEN = 'ms_from-the-environment';
    const doc = updateSettings((d) => { d.values['MCP_ADMIN_TOKEN'] = 'ms_rotated'; });
    applySettings(doc, new Set());
    // What the endpoint reads at its next start is the one generated in Settings.
    expect(process.env.MCP_ADMIN_TOKEN).toBe('ms_rotated');
    const cleared = updateSettings((d) => { delete d.values['MCP_ADMIN_TOKEN']; });
    applySettings(cleared, new Set());
    expect(process.env.MCP_ADMIN_TOKEN).toBe('ms_from-the-environment');
  });

  it('needs a restart only when what the service runs on changed', () => {
    const doc = updateSettings((d) => { d.values['POLL_INTERVAL_SECONDS'] = '600'; d.setupCompletedAt = 'now'; });
    rememberBootState(doc, new Set());
    // A Gmail mailbox that waits for sign-in changes nothing that runs.
    const waiting = updateSettings((d) => { d.mailboxes.push({ id: 'g', provider: 'gmail', username: 'me@gmail.com', enabled: true }); });
    expect(differsFromBoot(waiting, new Set())).toBe(false);
    expect(differsFromBoot(waiting, new Set(['me@gmail.com']))).toBe(true);
    const changed = updateSettings((d) => { d.values['POLL_INTERVAL_SECONDS'] = '900'; });
    expect(differsFromBoot(changed, new Set())).toBe(true);
  });

  it('keeps OAuth records encrypted beside the settings, and can forget one', async () => {
    const store = new TokenStore();
    await store.save('me@gmail.com', { refreshToken: '1//refresh-secret', accessToken: 'ya29.token', expiresAt: 1, scope: 's' });
    expect(authorizedUsernames()).toEqual(new Set(['me@gmail.com']));
    expect(rawRows()).not.toContain('refresh-secret');
    await store.remove('me@gmail.com');
    expect(authorizedUsernames()).toEqual(new Set());
  });
});

describe('the channel a request came over', () => {
  const req = (headers: Record<string, string>, encrypted = false): IncomingMessage =>
    ({ headers, socket: { encrypted, remoteAddress: '172.18.0.1' } }) as unknown as IncomingMessage;

  it('takes the browser on this machine or through a tunnel, whatever peer Docker shows', () => {
    expect(requestChannel(req({ host: '127.0.0.1:8410' }))).toBe('loopback');
    expect(requestChannel(req({ host: 'localhost:9000' }))).toBe('loopback');
    expect(requestChannel(req({ host: '[::1]:8410' }))).toBe('loopback');
    expect(requestChannel(req({ host: '127.0.0.1:8410', origin: 'http://localhost:8410' }))).toBe('loopback');
  });

  it('refuses plain HTTP under any other name', () => {
    expect(requestChannel(req({ host: '203.0.113.9:8410' }))).toBe('insecure');
    expect(requestChannel(req({ host: 'mail.example.com' }))).toBe('insecure');
    // A proxy that rewrote Host to loopback still shows the browser's origin.
    expect(requestChannel(req({ host: '127.0.0.1:8410', origin: 'http://mail.example.com' }))).toBe('insecure');
    // A proxy that says the browser used plain HTTP.
    expect(requestChannel(req({ host: '127.0.0.1:8410', 'x-forwarded-proto': 'http' }))).toBe('insecure');
    expect(requestChannel(req({}))).toBe('insecure');
  });

  it('takes HTTPS, on the socket or from a proxy that terminated it', () => {
    expect(requestChannel(req({ host: 'mail.example.com' }, true))).toBe('https');
    expect(requestChannel(req({ host: 'mail.example.com', 'x-forwarded-proto': 'https' }))).toBe('https');
    expect(requestChannel(req({ host: 'mail.example.com', forwarded: 'for=1.2.3.4;proto=https' }))).toBe('https');
    expect(requestChannel(req({ host: '127.0.0.1:8410', origin: 'https://mail.example.com' }))).toBe('https');
  });
});
