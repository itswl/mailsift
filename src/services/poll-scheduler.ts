/**
 * One poll at a time, whether it came due or was asked for.
 *
 * The scheduled loop and the web view's refresh button both end up here. A
 * click during a running poll joins it instead of opening a second IMAP
 * session; a click between polls starts one immediately. The loop's wait is
 * interruptible too, so a shutdown signal does not have to sit out the rest of
 * a fifteen-minute interval.
 */
import type { PollStats } from './watcher.js';

export class PollCoordinator {
  private inFlight: Promise<PollStats> | undefined;
  private readonly wakeups = new Set<() => void>();

  constructor(private readonly poll: () => Promise<PollStats>) {}

  /** Poll now, or join the poll already running. A failed poll is not cached. */
  now(): Promise<PollStats> {
    if (this.inFlight) return this.inFlight;
    const run = this.poll().finally(() => {
      if (this.inFlight === run) this.inFlight = undefined;
    });
    this.inFlight = run;
    return run;
  }

  /** Sleep for `ms`, unless wake() cuts it short first. */
  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.wakeups.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wakeups.add(done);
    });
  }

  /** End the current wait, so the loop can check whether it should stop. */
  wake(): void {
    for (const done of [...this.wakeups]) done();
  }
}
