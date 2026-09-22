/**
 * Short retry loop for outbound notifications.
 *
 * A push that fails on a network error, a timeout, or HTTP 408/429/5xx is
 * retried a few times seconds apart, so a momentary blip does not delay an
 * alert until the outbox retries it on the next poll. Permanent rejections
 * (other 4xx, provider business errors) are returned immediately.
 *
 * Once an endpoint exhausts its retries, later pushes make a single attempt
 * until one succeeds: a dead endpoint must not multiply the poll duration.
 */
import { getLogger } from '../logger.js';

const log = getLogger('delivery');

/** Delay before each retry; later retries reuse the last value. */
export const RETRY_DELAYS_MS = [2_000, 5_000] as const;

export interface DeliveryOutcome {
  delivered: boolean;
  /** Whether a retry could plausibly succeed. */
  retryable: boolean;
  detail: string;
}

/** Per-endpoint memory of whether the last round of retries ran out. */
export interface RetryState {
  exhausted: boolean;
}

export function retryAttempts(): number {
  const raw = Number(process.env.SINK_RETRY_ATTEMPTS ?? 3);
  return Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), 5) : 3;
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function deliverWithRetry(
  label: string,
  state: RetryState,
  attempt: () => Promise<DeliveryOutcome>,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<boolean> {
  const maxAttempts = state.exhausted ? 1 : retryAttempts();
  for (let n = 1; ; n += 1) {
    const outcome = await attempt();
    if (outcome.delivered) {
      state.exhausted = false;
      return true;
    }
    if (!outcome.retryable) {
      log.error(`${label} | rejected, not retrying | ${outcome.detail}`);
      return false;
    }
    if (n >= maxAttempts) {
      state.exhausted = true;
      log.error(`${label} | failed after ${n} attempt${n === 1 ? '' : 's'} | ${outcome.detail}`);
      return false;
    }
    const delay = RETRY_DELAYS_MS[Math.min(n, RETRY_DELAYS_MS.length) - 1]!;
    log.warn(`${label} | attempt ${n}/${maxAttempts} failed, retrying in ${delay}ms | ${outcome.detail}`);
    await sleep(delay);
  }
}
