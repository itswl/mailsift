/**
 * An optional ping to an outside monitor after every completed poll.
 *
 * Every alarm mailsift can raise is sent from inside its own process, so a
 * dead process or host says nothing at all. A monitor that expects a ping
 * each interval, such as an Uptime Kuma push monitor or a healthchecks-style
 * service, notices the silence instead. The ping carries nothing about mail.
 */
import { getLogger } from '../logger.js';

const log = getLogger('heartbeat');
const TIMEOUT_MS = 5_000;

/**
 * Why a configured HEARTBEAT_PING_URL is not used, for --check; undefined when
 * it is fine or unset. A URL with a user name or password is refused by fetch
 * before anything is sent, with an error that quotes it whole, so it is turned
 * away here instead of failing, and leaking, after every poll.
 */
export function heartbeatProblem(): string | undefined {
  const raw = process.env.HEARTBEAT_PING_URL?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'is not a URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'is not an http(s) URL';
  if (url.username || url.password) {
    return 'carries a user name or password, which fetch will not send; use the token URL the monitor gives you';
  }
  return undefined;
}

/** The configured monitor URL, or undefined when unset or unusable (see heartbeatProblem). */
export function heartbeatUrl(): URL | undefined {
  const raw = process.env.HEARTBEAT_PING_URL?.trim();
  return raw && !heartbeatProblem() ? new URL(raw) : undefined;
}

/** Pings still on their way, so a one-shot run can wait for its own. */
const inFlight = new Set<Promise<void>>();

/**
 * Ping the monitor. Never throws and is not awaited by the poll: a slow or
 * failing monitor must not hold up mail. Only the host and the kind of
 * failure are logged, because the URL itself is usually the monitor's secret.
 */
export function pingHeartbeat(fetcher: typeof fetch = fetch): Promise<void> {
  const url = heartbeatUrl();
  if (!url) return Promise.resolve();
  const ping = fetcher(url, { method: 'GET', signal: AbortSignal.timeout(TIMEOUT_MS) })
    .then((response) => {
      if (!response.ok) log.warn(`Heartbeat ping to ${url.host} answered HTTP ${response.status}`);
    })
    .catch((error: unknown) => {
      log.warn(`Heartbeat ping to ${url.host} failed (${failureKind(error)})`);
    })
    .finally(() => {
      inFlight.delete(ping);
    });
  inFlight.add(ping);
  return ping;
}

/**
 * Wait for pings already sent. A --once run from cron exits as soon as its
 * poll returns, which would cut the ping off before it connected; the ping's
 * own timeout bounds the wait.
 */
export async function flushHeartbeats(): Promise<void> {
  await Promise.all([...inFlight]);
}

/** A name for what went wrong that cannot carry the URL: fetch errors quote it. */
function failureKind(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timed out';
  const code = (error as { cause?: { code?: unknown } }).cause?.code;
  return typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code : error.name;
}
