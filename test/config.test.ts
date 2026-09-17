import { describe, expect, it } from 'vitest';
import './setup.js';
import { loadConfig, needsOAuth, PROVIDER_PRESETS } from '../src/config.js';

function env(pairs: Record<string, string>): void {
  Object.assign(process.env, pairs);
}

describe('account parsing', () => {
  it('fills in presets from the minimum configuration', () => {
    env({ MAIL_ACCOUNT_1: 'qq|me@qq.com|authcode' });
    const [account] = loadConfig().accounts;
    expect(account).toMatchObject({
      provider: 'qq', username: 'me@qq.com', password: 'authcode',
      host: 'imap.qq.com', port: 993, auth: 'password',
    });
    expect(account!.folders).toEqual(['INBOX', 'spam']);
  });

  it('sorts by account number rather than environment-variable order', () => {
    env({ MAIL_ACCOUNT_10: 'qq|j@qq.com|pw', MAIL_ACCOUNT_2: 'qq|b@qq.com|pw', MAIL_ACCOUNT_1: 'qq|a@qq.com|pw' });
    expect(loadConfig().accounts.map((a) => a.username)).toEqual(['a@qq.com', 'b@qq.com', 'j@qq.com']);
  });

  it('explicit host overrides the preset', () => {
    env({ MAIL_ACCOUNT_1: '163|me@163.com|pw|imap-proxy.internal' });
    expect(loadConfig().accounts[0]!.host).toBe('imap-proxy.internal');
  });

  it('allows colons in the authorization code', () => {
    // Use pipes instead of colons because authorization codes often contain colons.
    env({ MAIL_ACCOUNT_1: 'qq|me@qq.com|a:b:c' });
    expect(loadConfig().accounts[0]!.password).toBe('a:b:c');
  });

  it('does not require a password for OAuth accounts', () => {
    env({ MAIL_ACCOUNT_1: 'gmail|me@gmail.com' });
    const [account] = loadConfig().accounts;
    expect(account!.password).toBeUndefined();
    expect(needsOAuth(account!)).toBe(true);
  });
});

describe('per-account options', () => {
  it('supports a custom name and folder list', () => {
    env({
      MAIL_ACCOUNT_1: 'qq|me@qq.com|pw',
      MAIL_ACCOUNT_1_NAME: 'QQ-主号',
      MAIL_ACCOUNT_1_FOLDERS: 'INBOX,spam,归档',
    });
    const [account] = loadConfig().accounts;
    expect(account!.name).toBe('QQ-主号');
    expect(account!.folders).toEqual(['INBOX', 'spam', '归档']);
  });

  it('supports a custom port and plaintext connection', () => {
    // Local gateways such as Proton Bridge use a plaintext port.
    env({
      MAIL_ACCOUNT_1: 'imap|me@proton.me|pw|127.0.0.1',
      MAIL_ACCOUNT_1_PORT: '1143',
      MAIL_ACCOUNT_1_SSL: 'false',
    });
    expect(loadConfig().accounts[0]).toMatchObject({ host: '127.0.0.1', port: 1143, useSsl: false });
  });

  it('enables SSL by default', () => {
    env({ MAIL_ACCOUNT_1: 'qq|me@qq.com|pw' });
    expect(loadConfig().accounts[0]!.useSsl).toBe(true);
  });

  it('allows overriding the authentication method', () => {
    env({ MAIL_ACCOUNT_1: 'gmail|me@gmail.com|apppassword', MAIL_ACCOUNT_1_AUTH: 'password' });
    const [account] = loadConfig().accounts;
    expect(account!.auth).toBe('password');
    expect(needsOAuth(account!)).toBe(false);
  });
});

describe('clear configuration errors', () => {
  it('gives useful guidance when no accounts are configured', () => {
    expect(() => loadConfig()).toThrow(/MAIL_ACCOUNT_1/);
  });

  it('rejects malformed account entries', () => {
    env({ MAIL_ACCOUNT_1: 'justoneField' });
    expect(() => loadConfig()).toThrow(/Invalid format/);
  });

  it('rejects password authentication without a password', () => {
    env({ MAIL_ACCOUNT_1: 'qq|me@qq.com' });
    expect(() => loadConfig()).toThrow(/requires a password/);
  });

  it('rejects an unknown provider', () => {
    env({ MAIL_ACCOUNT_1: 'foxmail|me@x.com|pw' });
    expect(() => loadConfig()).toThrow(/unknown provider/);
  });

  it('requires a host for generic IMAP', () => {
    env({ MAIL_ACCOUNT_1: 'imap|me@x.com|pw' });
    expect(() => loadConfig()).toThrow(/requires an explicit host/);
  });

  it('requires a numeric port', () => {
    env({ MAIL_ACCOUNT_1: 'qq|me@qq.com|pw', MAIL_ACCOUNT_1_PORT: '九九三' });
    expect(() => loadConfig()).toThrow(/must be numeric/);
  });

  it('ignores non-numeric account suffixes', () => {
    env({ MAIL_ACCOUNT_FOO: 'qq|x@qq.com|pw', MAIL_ACCOUNT_1: 'qq|me@qq.com|pw' });
    expect(loadConfig().accounts).toHaveLength(1);
  });
});

describe('rules', () => {
  it('reads rules from the environment and normalizes addresses', () => {
    env({
      MAIL_ACCOUNT_1: 'qq|me@qq.com|pw',
      MAIL_CONTEXT: '我关心账单',
      MAIL_ALWAYS_IMPORTANT: '@bank.com, Billing@',
      MAIL_NEVER_IMPORTANT: 'newsletter@',
      MAIL_KEYWORDS: '域名到期,服务器续费',
    });
    const { rules } = loadConfig();
    expect(rules.context).toBe('我关心账单');
    expect(rules.alwaysImportant).toEqual(['@bank.com', 'billing@']);
    expect(rules.keywords).toEqual(['域名到期', '服务器续费']);
  });
});

describe('provider presets', () => {
  it.each([
    ['163', 'imap.163.com'], ['126', 'imap.126.com'], ['icloud', 'imap.mail.me.com'],
    ['fastmail', 'imap.fastmail.com'], ['feishu', 'imap.feishu.cn'],
    ['yahoo', 'imap.mail.yahoo.com'], ['zoho', 'imap.zoho.com'], ['gmail_pw', 'imap.gmail.com'],
  ])('%s -> %s and uses password authentication', (provider, host) => {
    env({ MAIL_ACCOUNT_1: `${provider}|me@example.com|pw` });
    const [account] = loadConfig().accounts;
    expect(account!.host).toBe(host);
    expect(account!.auth).toBe('password');
  });

  it('requires OAuth only for Gmail and Outlook', () => {
    // This is the point of the generic presets: not every provider needs an OAuth app.
    const oauth = Object.entries(PROVIDER_PRESETS)
      .filter(([, preset]) => preset.auth !== 'password')
      .map(([name]) => name);
    expect(new Set(oauth)).toEqual(new Set(['gmail', 'outlook']));
  });

  it('gmail and gmail_pw differ only in authentication method', () => {
    expect(PROVIDER_PRESETS.gmail.host).toBe(PROVIDER_PRESETS.gmail_pw.host);
    expect(PROVIDER_PRESETS.gmail.auth).toBe('gmail_oauth');
    expect(PROVIDER_PRESETS.gmail_pw.auth).toBe('password');
  });
});
