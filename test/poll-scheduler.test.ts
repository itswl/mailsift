import { describe, expect, it, vi } from 'vitest';
import './setup.js';
import { PollCoordinator } from '../src/services/poll-scheduler.js';
import type { PollStats } from '../src/services/watcher.js';

function stats(fresh: number): PollStats {
  return {
    accountsOk: 1, accountsFailed: 0, fetched: fresh, fresh,
    pushed: 0, queued: 0, spamRescued: 0, failures: [],
  };
}

describe('PollCoordinator', () => {
  it('joins the poll already running instead of opening a second one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const poll = vi.fn(async () => { await gate; return stats(1); });
    const coordinator = new PollCoordinator(poll);

    const first = coordinator.now();
    const second = coordinator.now();
    expect(poll).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);

    release();
    await expect(second).resolves.toMatchObject({ fresh: 1 });

    // Once it has settled, the next request starts a fresh poll rather than
    // handing back the old result.
    await expect(coordinator.now()).resolves.toMatchObject({ fresh: 1 });
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed poll', async () => {
    const poll = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(stats(2));
    const coordinator = new PollCoordinator(poll);

    await expect(coordinator.now()).rejects.toThrow('boom');
    await expect(coordinator.now()).resolves.toMatchObject({ fresh: 2 });
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('cuts a wait short when woken', async () => {
    const coordinator = new PollCoordinator(async () => stats(0));
    const started = Date.now();
    const waiting = coordinator.wait(10_000);
    setTimeout(() => coordinator.wake(), 20);

    await waiting;
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('ignores a wake with no waiter and still sleeps the full time', async () => {
    const coordinator = new PollCoordinator(async () => stats(0));
    coordinator.wake();

    const started = Date.now();
    await coordinator.wait(30);
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });
});
