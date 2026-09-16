import { describe, expect, it } from 'vitest';
import './setup.js';
import { loadConfig, needsOAuth, PROVIDER_PRESETS } from '../src/config.js';

function env(pairs: Record<string, string>): void {
  Object.assign(process.env, pairs);
}

describe('账号解析', () => {
  it('最小配置能补齐预设', () => {
    env({ MAIL_ACCOUNT_1: 'qq|me@qq.com|authcode' });
    const [account] = loadConfig().accounts;
    expect(account).toMatchObject({
      provider: 'qq', username: 'me@qq.com', password: 'authcode',
      host: 'imap.qq.com', port: 993, auth: 'password',
    });
    expect(account!.folders).toEqual(['INBOX', 'spam']);
  });

  it('按序号排序而不是环境变量顺序', () => {
    env({ MAIL_ACCOUNT_10: 'qq|j@qq.com|pw', MAIL_ACCOUNT_2: 'qq|b@qq.com|pw', MAIL_ACCOUNT_1: 'qq|a@qq.com|pw' });
    expect(loadConfig().accounts.map((a) => a.username)).toEqual(['a@qq.com', 'b@qq.com', 'j@qq.com']);
  });

  it('显式 host 压过预设', () => {
    env({ MAIL_ACCOUNT_1: '163|me@163.com|pw|imap-proxy.internal' });
    expect(loadConfig().accounts[0]!.host).toBe('imap-proxy.internal');
  });

  it('授权码里可以有冒号', () => {
    // 用竖线分隔而不是冒号——授权码里出现冒号的概率高得多
    env({ MAIL_ACCOUNT_1: 'qq|me@qq.com|a:b:c' });
    expect(loadConfig().accounts[0]!.password).toBe('a:b:c');
  });

  it('OAuth 账号不需要密码', () => {
    env({ MAIL_ACCOUNT_1: 'gmail|me@gmail.com' });
    const [account] = loadConfig().accounts;
    expect(account!.password).toBeUndefined();
    expect(needsOAuth(account!)).toBe(true);
  });
});

describe('每账号可选设置', () => {
  it('名字与文件夹', () => {
    env({
      MAIL_ACCOUNT_1: 'qq|me@qq.com|pw',
      MAIL_ACCOUNT_1_NAME: 'QQ-主号',
      MAIL_ACCOUNT_1_FOLDERS: 'INBOX,spam,归档',
    });
    const [account] = loadConfig().accounts;
    expect(account!.name).toBe('QQ-主号');
    expect(account!.folders).toEqual(['INBOX', 'spam', '归档']);
  });

  it('自定义端口与明文连接', () => {
    // Proton Bridge 这类本地网关走明文端口
    env({
      MAIL_ACCOUNT_1: 'imap|me@proton.me|pw|127.0.0.1',
      MAIL_ACCOUNT_1_PORT: '1143',
      MAIL_ACCOUNT_1_SSL: 'false',
    });
    expect(loadConfig().accounts[0]).toMatchObject({ host: '127.0.0.1', port: 1143, useSsl: false });
  });

  it('默认开 SSL', () => {
    env({ MAIL_ACCOUNT_1: 'qq|me@qq.com|pw' });
    expect(loadConfig().accounts[0]!.useSsl).toBe(true);
  });

  it('可以覆盖认证方式', () => {
    env({ MAIL_ACCOUNT_1: 'gmail|me@gmail.com|apppassword', MAIL_ACCOUNT_1_AUTH: 'password' });
    const [account] = loadConfig().accounts;
    expect(account!.auth).toBe('password');
    expect(needsOAuth(account!)).toBe(false);
  });
});

describe('出错要说清楚', () => {
  it('一个账号都没有时给出可用提示', () => {
    expect(() => loadConfig()).toThrow(/MAIL_ACCOUNT_1/);
  });

  it('格式不对', () => {
    env({ MAIL_ACCOUNT_1: 'justoneField' });
    expect(() => loadConfig()).toThrow(/格式不对/);
  });

  it('密码认证却没给密码', () => {
    env({ MAIL_ACCOUNT_1: 'qq|me@qq.com' });
    expect(() => loadConfig()).toThrow(/没有 password/);
  });

  it('未知 provider', () => {
    env({ MAIL_ACCOUNT_1: 'foxmail|me@x.com|pw' });
    expect(() => loadConfig()).toThrow(/未知 provider/);
  });

  it('通用 imap 必须给 host', () => {
    env({ MAIL_ACCOUNT_1: 'imap|me@x.com|pw' });
    expect(() => loadConfig()).toThrow(/需要显式指定 host/);
  });

  it('端口必须是数字', () => {
    env({ MAIL_ACCOUNT_1: 'qq|me@qq.com|pw', MAIL_ACCOUNT_1_PORT: '九九三' });
    expect(() => loadConfig()).toThrow(/必须是数字/);
  });

  it('非数字后缀被忽略', () => {
    env({ MAIL_ACCOUNT_FOO: 'qq|x@qq.com|pw', MAIL_ACCOUNT_1: 'qq|me@qq.com|pw' });
    expect(loadConfig().accounts).toHaveLength(1);
  });
});

describe('规则', () => {
  it('从环境变量读取并统一小写', () => {
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

describe('预设', () => {
  it.each([
    ['163', 'imap.163.com'], ['126', 'imap.126.com'], ['icloud', 'imap.mail.me.com'],
    ['fastmail', 'imap.fastmail.com'], ['feishu', 'imap.feishu.cn'],
    ['yahoo', 'imap.mail.yahoo.com'], ['zoho', 'imap.zoho.com'], ['gmail_pw', 'imap.gmail.com'],
  ])('%s -> %s，且走密码认证', (provider, host) => {
    env({ MAIL_ACCOUNT_1: `${provider}|me@example.com|pw` });
    const [account] = loadConfig().accounts;
    expect(account!.host).toBe(host);
    expect(account!.auth).toBe('password');
  });

  it('只有 gmail 和 outlook 需要 OAuth', () => {
    // 这是"通用"的关键：不必每家都注册 OAuth 应用
    const oauth = Object.entries(PROVIDER_PRESETS)
      .filter(([, preset]) => preset.auth !== 'password')
      .map(([name]) => name);
    expect(new Set(oauth)).toEqual(new Set(['gmail', 'outlook']));
  });

  it('gmail 与 gmail_pw 只差认证方式', () => {
    expect(PROVIDER_PRESETS.gmail.host).toBe(PROVIDER_PRESETS.gmail_pw.host);
    expect(PROVIDER_PRESETS.gmail.auth).toBe('gmail_oauth');
    expect(PROVIDER_PRESETS.gmail_pw.auth).toBe('password');
  });
});
