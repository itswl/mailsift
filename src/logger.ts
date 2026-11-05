/** Central process logger: levels, redaction and formatting are defined here. */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

export const REDACTED = '[redacted]';

/**
 * Credential shapes blanked in everything this logger writes.
 *
 * Most log lines are built from an error, and a provider puts whatever it likes
 * in one: an IMAP server echoing the LOGIN command, an HTTP client printing the
 * request URL, a token endpoint quoting the body it rejected. Redacting at the
 * call site means remembering every one of those, so it is done here instead,
 * for every line, as a net under the per-site care taken elsewhere.
 *
 * Patterns are anchored on the shape of the secret rather than the name of the
 * setting it came from, because the name is usually not in the string.
 */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Google OAuth: access token, refresh token, desktop client secret.
  [/\bya29\.[\w.-]+/g, REDACTED],
  [/\b1\/\/[\w-]{20,}/g, REDACTED],
  [/\bGOCSPX-[\w-]+/g, REDACTED],
  // Any JWT, which is what Microsoft hands out.
  [/\beyJ[\w-]{8,}\.[\w-]+\.[\w-]*/g, REDACTED],
  // Authorization headers, ours and the providers'.
  [/\b(Bearer|Basic)\s+[\w.~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // Secrets carried in a query string or a form body.
  [/\b(access_token|refresh_token|id_token|token|api[_-]?key|apikey|password|passwd|secret)=[^&\s"'`]+/gi, `$1=${REDACTED}`],
  // The path segment that is the whole credential: Feishu bot hooks, push monitors.
  [/(https?:\/\/[^\s"'`]*\/(?:hook|ping|webhook)\/)[\w-]{8,}/gi, `$1${REDACTED}`],
  // A user name and password in a URL.
  [/(https?:\/\/)[^\s:/@]+:[^\s@/]+@/gi, `$1${REDACTED}@`],
  // Our own account format, in case a configuration error quotes the line.
  [/\b(MAIL_ACCOUNT_\d+)=([^|\s]*\|[^|\s]*)\|\S+/g, `$1=$2|${REDACTED}`],
];

/** Blank every known credential shape in a string. Exported for the tests and for reuse. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function currentLevel(): number {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as Level;
  return LEVELS[raw] ?? LEVELS.info;
}

function emit(level: Level, scope: string, message: string, ...rest: unknown[]): void {
  if (LEVELS[level] < currentLevel()) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${scope}: ${redactSecrets(message)}`;
  const extra = rest.length ? ` ${redactSecrets(rest.map(String).join(' '))}` : '';
  // stdout is the MCP protocol channel in stdio mode; logs always use stderr.
  process.stderr.write(`${line}${extra}\n`);
}

export interface Logger {
  debug(message: string, ...rest: unknown[]): void;
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
}

export function getLogger(scope: string): Logger {
  return {
    debug: (m, ...r) => emit('debug', scope, m, ...r),
    info: (m, ...r) => emit('info', scope, m, ...r),
    warn: (m, ...r) => emit('warn', scope, m, ...r),
    error: (m, ...r) => emit('error', scope, m, ...r),
  };
}
