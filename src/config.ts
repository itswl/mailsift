/**
 * 配置加载与校验。唯一来源是环境变量（实践中就是 .env）。
 *
 * 用 zod 而不是手工解析：一份 schema 同时产出运行时校验、TypeScript 类型
 * 和人能看懂的报错。配置错误全部在启动时抛出，不留到运行期。
 */
import { z } from 'zod';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * provider 预设：只是省去手写 host/port/auth 的快捷方式。
 *
 * **任何支持 IMAP 的邮箱都能接**——不在表里的用 `imap` 加自己的 host。
 * 只有 Gmail 和 Outlook 特殊：它们关掉了密码认证必须走 OAuth。
 * 个人 Gmail 可以用 gmail_pw + 应用专用密码绕开（Workspace 不行）。
 */
export const PROVIDER_PRESETS = {
  gmail: { host: 'imap.gmail.com', port: 993, auth: 'gmail_oauth' },
  outlook: { host: 'outlook.office365.com', port: 993, auth: 'outlook_oauth' },
  gmail_pw: { host: 'imap.gmail.com', port: 993, auth: 'password' },

  qq: { host: 'imap.qq.com', port: 993, auth: 'password' },
  qq_biz: { host: 'imap.exmail.qq.com', port: 993, auth: 'password' },
  '163': { host: 'imap.163.com', port: 993, auth: 'password' },
  '126': { host: 'imap.126.com', port: 993, auth: 'password' },
  sina: { host: 'imap.sina.com', port: 993, auth: 'password' },
  aliyun: { host: 'imap.aliyun.com', port: 993, auth: 'password' },
  feishu: { host: 'imap.feishu.cn', port: 993, auth: 'password' },
  lark: { host: 'imap.larksuite.com', port: 993, auth: 'password' },

  icloud: { host: 'imap.mail.me.com', port: 993, auth: 'password' },
  fastmail: { host: 'imap.fastmail.com', port: 993, auth: 'password' },
  yahoo: { host: 'imap.mail.yahoo.com', port: 993, auth: 'password' },
  zoho: { host: 'imap.zoho.com', port: 993, auth: 'password' },
  yandex: { host: 'imap.yandex.com', port: 993, auth: 'password' },
  gmx: { host: 'imap.gmx.com', port: 993, auth: 'password' },

  imap: { port: 993, auth: 'password' },
} as const satisfies Record<string, { host?: string; port: number; auth: AuthKind }>;

export type ProviderName = keyof typeof PROVIDER_PRESETS;
export type AuthKind = 'password' | 'gmail_oauth' | 'outlook_oauth';

export const IMPORTANCE = ['info', 'warning', 'critical'] as const;
export type Importance = (typeof IMPORTANCE)[number];
export const IMPORTANCE_RANK: Record<Importance, number> = { info: 0, warning: 1, critical: 2 };

export const DEFAULT_FOLDERS = ['INBOX', 'spam'] as const;

export interface Account {
  name: string;
  provider: string;
  username: string;
  host: string;
  port: number;
  auth: AuthKind;
  password?: string;
  folders: string[];
  useSsl: boolean;
}

export interface Rules {
  alwaysImportant: string[];
  neverImportant: string[];
  keywords: string[];
  context: string;
}

export interface WatchConfig {
  accounts: Account[];
  rules: Rules;
}

/** `provider|username[|password[|host]]` */
const ACCOUNT_LINE = z
  .string()
  .trim()
  .min(1)
  .transform((raw, ctx) => {
    const parts = raw.split('|').map((p) => p.trim());
    const [provider, username, password, host] = parts;
    if (!provider || !username) {
      ctx.addIssue({
        code: 'custom',
        message: `格式不对：期望 provider|username[|password[|host]]，实际是 ${JSON.stringify(raw)}`,
      });
      return z.NEVER;
    }
    return { provider, username, password: password || undefined, host: host || undefined };
  });

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function env(key: string): string | undefined {
  const value = process.env[key];
  return value?.trim() ? value.trim() : undefined;
}

interface ParsedAccountLine {
  provider: string;
  username: string;
  // exactOptionalPropertyTypes 下要显式带上 undefined：
  // 「字段不存在」和「字段值是 undefined」是两回事
  password: string | undefined;
  host: string | undefined;
}

function normalizeAccount(parsed: ParsedAccountLine, index: number, varName: string): Account {
  const preset = (PROVIDER_PRESETS as Record<string, { host?: string; port: number; auth: AuthKind }>)[
    parsed.provider
  ];
  if (!preset) {
    throw new ConfigError(
      `${varName}: 未知 provider "${parsed.provider}"，可选 ${Object.keys(PROVIDER_PRESETS).sort().join(' / ')}`,
    );
  }

  const prefix = `MAIL_ACCOUNT_${index}_`;
  const host = parsed.host ?? preset.host;
  if (!host) {
    throw new ConfigError(`${varName}: provider "${parsed.provider}" 需要显式指定 host`);
  }

  const auth = (env(prefix + 'AUTH') ?? preset.auth) as AuthKind;
  if (!['password', 'gmail_oauth', 'outlook_oauth'].includes(auth)) {
    throw new ConfigError(`${prefix}AUTH: 未知认证方式 "${auth}"`);
  }
  if (auth === 'password' && !parsed.password) {
    throw new ConfigError(
      `${varName} (${parsed.username}): auth=password 但没有 password。` +
        `格式是 provider|邮箱|授权码，授权码不是登录密码`,
    );
  }

  const portRaw = env(prefix + 'PORT');
  if (portRaw && !/^\d+$/.test(portRaw)) {
    throw new ConfigError(`${prefix}PORT 必须是数字，实际是 ${JSON.stringify(portRaw)}`);
  }

  const folders = splitList(env(prefix + 'FOLDERS'));

  return {
    name: env(prefix + 'NAME') ?? `${parsed.provider}-${parsed.username.split('@')[0]}`,
    provider: parsed.provider,
    username: parsed.username,
    host,
    port: portRaw ? Number(portRaw) : preset.port,
    auth,
    ...(parsed.password ? { password: parsed.password } : {}),
    folders: folders.length ? folders : [...DEFAULT_FOLDERS],
    useSsl: !['false', '0', 'no', 'off'].includes((env(prefix + 'SSL') ?? '').toLowerCase()),
  };
}

export function loadConfig(): WatchConfig {
  const numbered: Array<{ index: number; varName: string; raw: string }> = [];
  for (const [key, value] of Object.entries(process.env)) {
    const match = /^MAIL_ACCOUNT_(\d+)$/.exec(key);
    if (match && value?.trim()) {
      numbered.push({ index: Number(match[1]), varName: key, raw: value.trim() });
    }
  }
  numbered.sort((a, b) => a.index - b.index);

  if (numbered.length === 0) {
    throw new ConfigError(
      '没有配置任何邮箱账号。在 .env 里加一行，例如：\n' +
        '  MAIL_ACCOUNT_1=qq|me@qq.com|授权码\n' +
        '格式是 provider|邮箱地址|授权码[|自定义host]，序号从 1 往下加。\n' +
        '完整说明见 .env.example。',
    );
  }

  const accounts = numbered.map(({ index, varName, raw }) => {
    const parsed = ACCOUNT_LINE.safeParse(raw);
    if (!parsed.success) {
      throw new ConfigError(`${varName} ${parsed.error.issues[0]?.message ?? '解析失败'}`);
    }
    return normalizeAccount(parsed.data, index, varName);
  });

  return {
    accounts,
    rules: {
      // 统一小写，匹配时不必再关心大小写
      alwaysImportant: splitList(env('MAIL_ALWAYS_IMPORTANT')).map((s) => s.toLowerCase()),
      neverImportant: splitList(env('MAIL_NEVER_IMPORTANT')).map((s) => s.toLowerCase()),
      keywords: splitList(env('MAIL_KEYWORDS')).map((s) => s.toLowerCase()),
      context: env('MAIL_CONTEXT') ?? '',
    },
  };
}

export function needsOAuth(account: Account): boolean {
  return account.auth === 'gmail_oauth' || account.auth === 'outlook_oauth';
}
