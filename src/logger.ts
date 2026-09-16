/** 进程内统一日志：级别与格式只在这里决定一次。 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

function currentLevel(): number {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as Level;
  return LEVELS[raw] ?? LEVELS.info;
}

function emit(level: Level, scope: string, message: string, ...rest: unknown[]): void {
  if (LEVELS[level] < currentLevel()) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${scope}: ${message}`;
  // stdout 在 MCP 的 stdio 传输下属于协议通道，日志一律走 stderr
  process.stderr.write(rest.length ? `${line} ${rest.map(String).join(' ')}\n` : `${line}\n`);
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
