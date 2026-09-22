import { afterEach, describe, expect, it, vi } from 'vitest';
import './setup.js';
import { makeMessage, makeResult } from './helpers.js';
import {
  deliverWithRetry, isRetryableStatus, retryAttempts, type DeliveryOutcome,
} from '../src/services/delivery.js';
import { FeishuSink } from '../src/services/feishu.js';
import { WebhookWiseSink } from '../src/services/sink.js';

const ok: DeliveryOutcome = { delivered: true, retryable: false, detail: '' };
const transient: DeliveryOutcome = { delivered: false, retryable: true, detail: 'ECONNRESET' };
const rejected: DeliveryOutcome = { delivered: false, retryable: false, detail: 'HTTP 400' };
const noSleep = async (): Promise<void> => undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('short retry loop', () => {
  it('retries a transient failure seconds apart and reports the eventual success', async () => {
    const attempts = vi.fn<() => Promise<DeliveryOutcome>>()
      .mockResolvedValueOnce(transient)
      .mockResolvedValueOnce(transient)
      .mockResolvedValueOnce(ok);
    const delays: number[] = [];
    const state = { exhausted: false };
    expect(await deliverWithRetry('test', state, attempts, async (ms) => { delays.push(ms); })).toBe(true);
    expect(attempts).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([2_000, 5_000]);
    expect(state.exhausted).toBe(false);
  });

  it('does not retry a permanent rejection', async () => {
    const attempts = vi.fn<() => Promise<DeliveryOutcome>>().mockResolvedValue(rejected);
    expect(await deliverWithRetry('test', { exhausted: false }, attempts, noSleep)).toBe(false);
    expect(attempts).toHaveBeenCalledTimes(1);
  });

  it('makes a single attempt for an endpoint that stays down until one push succeeds', async () => {
    // A dead endpoint must not multiply the poll duration: after one exhausted
    // round, later pushes try once (as before) until a delivery gets through.
    const attempts = vi.fn<() => Promise<DeliveryOutcome>>().mockResolvedValue(transient);
    const state = { exhausted: false };
    expect(await deliverWithRetry('test', state, attempts, noSleep)).toBe(false);
    expect(attempts).toHaveBeenCalledTimes(3);
    expect(state.exhausted).toBe(true);

    expect(await deliverWithRetry('test', state, attempts, noSleep)).toBe(false);
    expect(attempts).toHaveBeenCalledTimes(4);

    attempts.mockResolvedValueOnce(ok);
    expect(await deliverWithRetry('test', state, attempts, noSleep)).toBe(true);
    expect(state.exhausted).toBe(false);

    attempts.mockResolvedValueOnce(transient).mockResolvedValueOnce(ok);
    expect(await deliverWithRetry('test', state, attempts, noSleep)).toBe(true);
    expect(attempts).toHaveBeenCalledTimes(7);
  });

  it('lets SINK_RETRY_ATTEMPTS=1 disable immediate retries', async () => {
    process.env.SINK_RETRY_ATTEMPTS = '1';
    expect(retryAttempts()).toBe(1);
    const attempts = vi.fn<() => Promise<DeliveryOutcome>>().mockResolvedValue(transient);
    expect(await deliverWithRetry('test', { exhausted: false }, attempts, noSleep)).toBe(false);
    expect(attempts).toHaveBeenCalledTimes(1);
  });

  it('retries only statuses that can clear on their own', () => {
    expect([408, 429, 500, 502, 503, 504].every(isRetryableStatus)).toBe(true);
    expect([400, 401, 403, 404, 422].some(isRetryableStatus)).toBe(false);
  });
});

describe('sink wiring', () => {
  it('Feishu retries a network error and reports the eventual delivery', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(new Response('{"code":0}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const pending = new FeishuSink('https://example.invalid/hook').push(makeMessage(), makeResult());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toBe('delivered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('Feishu does not retry a business error other than rate limiting', async () => {
    const fetchMock = vi.fn(async () => new Response('{"code":19001,"msg":"param invalid"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await new FeishuSink('https://example.invalid/hook').push(makeMessage(), makeResult())).toBe('failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('Feishu retries when the bot is rate limited', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"code":11232,"msg":"too many request"}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{"code":0}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const pending = new FeishuSink('https://example.invalid/hook').push(makeMessage(), makeResult());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toBe('delivered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('generic webhook retries 5xx but not 4xx', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('down', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const sink = new WebhookWiseSink('https://example.invalid', 'token');
    const pending = sink.push(makeMessage(), makeResult());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toBe('delivered');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValueOnce(new Response('bad', { status: 400 }));
    expect(await sink.push(makeMessage(), makeResult())).toBe('failed');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
