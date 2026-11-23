/**
 * Load and validate configuration.
 *
 * The server keeps its settings in its own database and hands them to this
 * module before anything else runs: the mailboxes through setSettingsAccounts,
 * everything else as the environment names below have always been read
 * (see services/settings-store.ts and bootstrap.ts). Without a settings store
 * (tests, one-off tools) the numbered MAIL_ACCOUNT_N variables are read instead.
 *
 * Zod provides runtime validation, TypeScript types, and readable startup errors.
 */
import { z } from 'zod';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Provider presets avoid repeating host, port, and auth settings.
 *
 * Any IMAP provider works: use `imap` and provide its host when it is not listed.
 * Gmail and Outlook require OAuth for most accounts because password auth is disabled.
 * Personal Gmail can use gmail_pw plus an app password; Workspace cannot.
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
  /**
   * Where this mailbox sends from, when that is not the provider's own
   * submission server: MAIL_ACCOUNT_N_SMTP_HOST and MAIL_ACCOUNT_N_SMTP_PORT.
   * Absent for most accounts, whose provider preset already names it; a
   * custom-host account has to set the host before it can send at all.
   */
  smtpHost?: string;
  smtpPort?: number;
  /** The name mail is sent under (MAIL_ACCOUNT_N_FROM_NAME); the bare address when unset. */
  fromName?: string;
  /**
   * What this mailbox's receiving server calls itself in Authentication-Results
   * (MAIL_ACCOUNT_N_AUTHSERV_ID). Only needed for a provider the reader does
   * not already know; `none` shows no sender verdict for this mailbox.
   */
  authservId?: string;
}

export interface Rules {
  alwaysImportant: string[];
  neverImportant: string[];
  keywords: string[];
  context: string;
  feedbackAlwaysImportant?: string[];
  feedbackNeverImportant?: string[];
  /**
   * Addresses of the other mailboxes this service monitors.
   *
   * Mail sent from one of them into another is a copy of something already
   * triaged at the source, so it must not raise a second notification. Empty
   * when the caller has turned that off.
   */
  selfAddresses?: string[];
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
        message: `Invalid format: expected provider|username[|password[|host]], got ${JSON.stringify(raw)}`,
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

function env(key: string, source: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = source[key];
  return value?.trim() ? value.trim() : undefined;
}

interface ParsedAccountLine {
  provider: string;
  username: string;
  // With exactOptionalPropertyTypes, explicitly include undefined: absence and
  // an undefined value are distinct types.
  password: string | undefined;
  host: string | undefined;
}

function normalizeAccount(parsed: ParsedAccountLine, index: number, varName: string, source: NodeJS.ProcessEnv): Account {
  const preset = (PROVIDER_PRESETS as Record<string, { host?: string; port: number; auth: AuthKind }>)[
    parsed.provider
  ];
  if (!preset) {
    throw new ConfigError(
      `${varName}: unknown provider "${parsed.provider}"; choose from ${Object.keys(PROVIDER_PRESETS).sort().join(' / ')}`,
    );
  }

  const prefix = `MAIL_ACCOUNT_${index}_`;
  const host = parsed.host ?? preset.host;
  if (!host) {
    throw new ConfigError(`${varName}: provider "${parsed.provider}" requires an explicit host`);
  }

  const auth = (env(prefix + 'AUTH', source) ?? preset.auth) as AuthKind;
  if (!['password', 'gmail_oauth', 'outlook_oauth'].includes(auth)) {
    throw new ConfigError(`${prefix}AUTH: unknown authentication method "${auth}"`);
  }
  if (auth === 'password' && !parsed.password) {
    throw new ConfigError(
      `${varName} (${parsed.username}): auth=password requires a password. ` +
        `Format: provider|email|app-password[|custom-host]; use an app password, not the normal login password.`,
    );
  }

  const portRaw = env(prefix + 'PORT', source);
  if (portRaw && !/^\d+$/.test(portRaw)) {
    throw new ConfigError(`${prefix}PORT must be numeric; got ${JSON.stringify(portRaw)}`);
  }
  const port = portRaw ? Number(portRaw) : preset.port;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError(`${prefix}PORT must be between 1 and 65535; got ${JSON.stringify(portRaw)}`);
  }

  const folders = splitList(env(prefix + 'FOLDERS', source));

  // Sending is optional, but a port that is not a number would only surface
  // as a refused connection on the first reply; say so at startup instead.
  const smtpHost = env(prefix + 'SMTP_HOST', source);
  const smtpPortRaw = env(prefix + 'SMTP_PORT', source);
  if (smtpPortRaw && !/^\d+$/.test(smtpPortRaw)) {
    throw new ConfigError(`${prefix}SMTP_PORT must be numeric; got ${JSON.stringify(smtpPortRaw)}`);
  }
  const smtpPort = smtpPortRaw ? Number(smtpPortRaw) : undefined;
  if (smtpPort !== undefined && (!Number.isSafeInteger(smtpPort) || smtpPort < 1 || smtpPort > 65_535)) {
    throw new ConfigError(`${prefix}SMTP_PORT must be between 1 and 65535; got ${JSON.stringify(smtpPortRaw)}`);
  }
  const fromName = env(prefix + 'FROM_NAME', source);
  const authservId = env(prefix + 'AUTHSERV_ID', source);

  return {
    name: env(prefix + 'NAME', source) ?? `${parsed.provider}-${parsed.username.split('@')[0]}`,
    provider: parsed.provider,
    username: parsed.username,
    host,
    port,
    auth,
    ...(parsed.password ? { password: parsed.password } : {}),
    folders: folders.length ? folders : [...DEFAULT_FOLDERS],
    useSsl: !['false', '0', 'no', 'off'].includes((env(prefix + 'SSL', source) ?? '').toLowerCase()),
    ...(smtpHost ? { smtpHost } : {}),
    ...(smtpPort !== undefined ? { smtpPort } : {}),
    ...(fromName ? { fromName } : {}),
    ...(authservId ? { authservId } : {}),
  };
}

/**
 * The mailboxes the settings page configured, once the server has loaded them.
 * Undefined until then, which is what tests and one-off tools see.
 */
let settingsAccounts: Account[] | undefined;

export function setSettingsAccounts(accounts: Account[] | undefined): void {
  settingsAccounts = accounts;
}

export function usingSettingsAccounts(): boolean {
  return settingsAccounts !== undefined;
}

/** The fields of a stored mailbox that matter for building an Account. */
export interface MailboxFields {
  provider: string;
  username: string;
  password?: string | undefined;
  name?: string | undefined;
  host?: string | undefined;
  port?: number | undefined;
  ssl?: boolean | undefined;
  folders?: readonly string[] | undefined;
  smtpHost?: string | undefined;
  smtpPort?: number | undefined;
  fromName?: string | undefined;
  authservId?: string | undefined;
}

function validPort(value: number | undefined, what: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new ConfigError(`${what} must be between 1 and 65535`);
  }
  return value;
}

/**
 * A stored mailbox as an Account, checked the way the numbered variables are.
 * `requirePassword` is off while a mailbox is being edited and its password
 * is kept from before.
 */
export function mailboxAccount(m: MailboxFields, options: { requirePassword?: boolean } = {}): Account {
  const preset = (PROVIDER_PRESETS as Record<string, { host?: string; port: number; auth: AuthKind }>)[m.provider];
  if (!preset) throw new ConfigError(`Unknown provider "${m.provider}"`);
  const username = m.username.trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(username)) throw new ConfigError(`"${username}" is not an email address`);
  const host = m.host?.trim() || preset.host;
  if (!host) throw new ConfigError(`${username}: this provider needs the IMAP server address`);
  if (!/^[a-z0-9.-]+$/i.test(host) && !/^\[[0-9a-f:.]+\]$/i.test(host)) throw new ConfigError(`${username}: "${host}" is not a server address`);
  if (preset.auth === 'password' && (options.requirePassword ?? true) && !m.password) {
    throw new ConfigError(`${username}: enter the app password (or IMAP password) for this mailbox`);
  }
  const port = validPort(m.port, `${username}: IMAP port`) ?? preset.port;
  const smtpPort = validPort(m.smtpPort, `${username}: SMTP port`);
  const smtpHost = m.smtpHost?.trim();
  if (smtpHost && !/^[a-z0-9.-]+$/i.test(smtpHost)) throw new ConfigError(`${username}: "${smtpHost}" is not a server address`);
  const folders = (m.folders ?? []).map((folder) => folder.trim()).filter(Boolean);
  return {
    name: m.name?.trim() || `${m.provider}-${username.split('@')[0]}`,
    provider: m.provider,
    username,
    host,
    port,
    auth: preset.auth,
    ...(m.password ? { password: m.password } : {}),
    folders: folders.length ? folders : [...DEFAULT_FOLDERS],
    useSsl: m.ssl ?? true,
    ...(smtpHost ? { smtpHost } : {}),
    ...(smtpPort !== undefined ? { smtpPort } : {}),
    ...(m.fromName?.trim() ? { fromName: m.fromName.trim() } : {}),
    ...(m.authservId?.trim() ? { authservId: m.authservId.trim() } : {}),
  };
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): WatchConfig {
  const numbered: Array<{ index: number; varName: string; raw: string }> = [];
  if (settingsAccounts) {
    if (settingsAccounts.length === 0) {
      throw new ConfigError('No mailbox is configured yet. Add one under Settings → Mailboxes.');
    }
    return { accounts: settingsAccounts.map((account) => ({ ...account, folders: [...account.folders] })), rules: rulesFrom(source) };
  }
  for (const [key, value] of Object.entries(source)) {
    const match = /^MAIL_ACCOUNT_(\d+)$/.exec(key);
    if (match && value?.trim()) {
      numbered.push({ index: Number(match[1]), varName: key, raw: value.trim() });
    }
  }
  numbered.sort((a, b) => a.index - b.index);

  if (numbered.length === 0) {
    if (settingsAccounts) {
      throw new ConfigError('No mailbox is configured yet. Add one under Settings → Mailboxes.');
    }
    throw new ConfigError(
      'No mail accounts configured. Add one under Settings → Mailboxes, or for a one-off tool set\n' +
        '  MAIL_ACCOUNT_1=qq|me@qq.com|app-password\n' +
        'Format: provider|email|app-password[|custom-host]; increment the account number.',
    );
  }

  const accounts = numbered.map(({ index, varName, raw }) => {
    const parsed = ACCOUNT_LINE.safeParse(raw);
    if (!parsed.success) {
      throw new ConfigError(`${varName} ${parsed.error.issues[0]?.message ?? 'parse failed'}`);
    }
    return normalizeAccount(parsed.data, index, varName, source);
  });

  return { accounts, rules: rulesFrom(source) };
}

function rulesFrom(source: NodeJS.ProcessEnv): Rules {
  return {
    // Normalize to lowercase so matching is case-insensitive.
    alwaysImportant: splitList(env('MAIL_ALWAYS_IMPORTANT', source)).map((s) => s.toLowerCase()),
    neverImportant: splitList(env('MAIL_NEVER_IMPORTANT', source)).map((s) => s.toLowerCase()),
    keywords: splitList(env('MAIL_KEYWORDS', source)).map((s) => s.toLowerCase()),
    context: env('MAIL_CONTEXT', source) ?? '',
  };
}

export function needsOAuth(account: Account): boolean {
  return account.auth === 'gmail_oauth' || account.auth === 'outlook_oauth';
}
