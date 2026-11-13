import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import './setup.js';
import { StateStore } from '../src/services/state.js';
import { LiveHub, liveHub, type LiveChannel } from '../src/web-live.js';

/** A response stand-in: what was written to it, and a way to hang up. */
class Page implements LiveChannel {
  readonly chunks: string[] = [];
  private listeners: Array<() => void> = [];
  failWrites = false;

  write(chunk: string): void {
    if (this.failWrites) throw new Error('socket closed');
    this.chunks.push(chunk);
  }

  onClose(listener: () => void): void {
    this.listeners.push(listener);
  }

  ended = false;
  close(): void {
    this.ended = true;
  }

  hangUp(): void {
    for (const listener of this.listeners) listener();
  }

  /** Every event written so far, as [name, parsed data]. */
  events(): Array<[string, Record<string, string>]> {
    return this.chunks.join('').split('\n\n')
      .map((block) => /^event: (\w+)\ndata: (.*)$/s.exec(block.trim()))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => [match[1]!, JSON.parse(match[2]!) as Record<string, string>]);
  }

  names(): string[] {
    return this.events().map(([name]) => name);
  }
}

/** A database file, the poller's handle on it, and a hub whose handles are counted. */
function world(options: { maxClients?: number; keepAliveMs?: number; intervalMs?: number } = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'mailsift-live-')), 'state.db');
  const writer = new StateStore(path);
  const opened: StateStore[] = [];
  const closed: StateStore[] = [];
  const hub = new LiveHub({
    // Long enough that only an explicit check() runs unless a test asks otherwise.
    intervalMs: 60_000, keepAliveMs: 60_000, ...options,
    openStore: () => {
      const store = new StateStore(path);
      const close = store.close.bind(store);
      store.close = () => { closed.push(store); close(); };
      opened.push(store);
      return store;
    },
  });
  const file = (key: string, importance = 'critical', pushed = true): void => {
    writer.markSeen(key, 'me@qq.com', key);
    writer.recordOutcome(key, importance, pushed, { messageId: `<${key}@x>`, folder: 'INBOX' });
  };
  return { path, writer, hub, opened, closed, file };
}

describe('joining the stream', () => {
  it('greets a page with the reconnect delay and the current signatures', () => {
    const w = world();
    w.file('k1');
    const page = new Page();
    expect(w.hub.attach(page)).toBe(true);
    expect(w.hub.size).toBe(1);
    expect(page.chunks[0]!.startsWith('retry: 3000\n\n')).toBe(true);
    const [name, data] = page.events()[0]!;
    expect(name).toBe('hello');
    expect(data).toEqual(w.writer.changeSignature());
    w.hub.close();
  });

  it('tells a newcomer the present, and the others what they had not heard yet', () => {
    const w = world();
    const first = new Page();
    w.hub.attach(first);
    w.file('k1');
    // No check has run since the row arrived; a second page joins.
    const second = new Page();
    w.hub.attach(second);
    expect(first.names()).toEqual(['hello', 'mail']);
    expect(second.names()).toEqual(['hello']);
    expect(second.events()[0]![1]).toEqual(w.writer.changeSignature());
    // And the newcomer is not told again about what its hello already covered.
    w.hub.check();
    expect(second.names()).toEqual(['hello']);
    w.hub.close();
  });

  it('gives one client only its share of the places', () => {
    const w = world({ maxClients: 5, maxPerOwner: 2 });
    const mine = [new Page(), new Page(), new Page()];
    expect(w.hub.attach(mine[0]!, 'a')).toBe(true);
    expect(w.hub.attach(mine[1]!, 'a')).toBe(true);
    expect(w.hub.hasRoom('a')).toBe(false);
    expect(w.hub.attach(mine[2]!, 'a')).toBe(false);
    // Another client is not shut out by the first one's tabs.
    expect(w.hub.hasRoom('b')).toBe(true);
    expect(w.hub.attach(new Page(), 'b')).toBe(true);
    mine[0]!.hangUp();
    expect(w.hub.attach(mine[2]!, 'a')).toBe(true);
    w.hub.close();
    expect(w.hub.hasRoom('a')).toBe(true);
  });

  it('refuses a page when it is full, so the caller can answer 503', () => {
    const w = world({ maxClients: 2 });
    const pages = [new Page(), new Page(), new Page()];
    expect(w.hub.attach(pages[0]!)).toBe(true);
    expect(w.hub.attach(pages[1]!)).toBe(true);
    expect(w.hub.attach(pages[2]!)).toBe(false);
    expect(pages[2]!.chunks).toEqual([]);
    expect(w.hub.size).toBe(2);
    // A page leaving makes room again.
    pages[0]!.hangUp();
    expect(w.hub.attach(pages[2]!)).toBe(true);
    w.hub.close();
  });

  it('does not lose a change to a read that failed, and reads again on a new handle', () => {
    const w = world();
    const page = new Page();
    w.hub.attach(page);
    expect(page.names()).toEqual(['hello']);
    // The database is busy the one time the hub looks after new mail arrived.
    const first = w.opened[0]!;
    const real = first.changeSignature.bind(first);
    let failures = 1;
    first.changeSignature = () => {
      if (failures > 0) { failures -= 1; throw new Error('database is locked'); }
      return real();
    };
    w.file('arrived');
    w.hub.check();
    expect(page.names()).toEqual(['hello']);
    // Nothing else commits. The next pass still announces it, through a handle of its own.
    w.hub.check();
    expect(page.names()).toEqual(['hello', 'mail']);
    expect(w.closed.includes(first)).toBe(true);
    expect(w.opened.length).toBe(2);
    // And it is announced once.
    w.hub.check();
    expect(page.names()).toEqual(['hello', 'mail']);
    w.hub.close();
  });

  it('refuses rather than throws when the database cannot be opened', () => {
    const hub = new LiveHub({ openStore: () => { throw new Error('no such file'); } });
    const page = new Page();
    expect(hub.attach(page)).toBe(false);
    expect(hub.size).toBe(0);
  });
});

describe('saying what changed', () => {
  it('announces mail when a row is judged, handled or put back', () => {
    const w = world();
    const page = new Page();
    w.hub.attach(page);
    w.file('k1');
    w.hub.check();
    expect(page.names()).toEqual(['hello', 'mail']);
    expect(page.events()[1]![1]).toEqual({ sig: w.writer.changeSignature().mail });
    w.writer.setHandled('k1', true);
    w.hub.check();
    w.writer.setHandled('k1', false);
    w.hub.check();
    expect(page.names()).toEqual(['hello', 'mail', 'mail', 'mail']);
    // Each announcement carries a signature the page has not seen.
    expect(new Set(page.events().slice(1).map(([, data]) => data['sig'])).size).toBe(3);
    w.hub.close();
  });

  it('announces a poll when the heartbeat moves, without calling it mail', () => {
    const w = world();
    const page = new Page();
    w.hub.attach(page);
    w.writer.setMeta('last_poll_at', new Date().toISOString());
    w.hub.check();
    expect(page.names()).toEqual(['hello', 'poll']);
    expect(page.events()[1]![1]).toEqual({ sig: w.writer.changeSignature().poll });
    // A poll that also filed mail says both, each once.
    w.file('k1');
    w.writer.setMeta('last_poll_at', new Date(Date.now() + 1000).toISOString());
    w.hub.check();
    expect(page.names()).toEqual(['hello', 'poll', 'mail', 'poll']);
    w.hub.close();
  });

  it('says nothing when the commit was to something the page does not show', () => {
    const w = world();
    const page = new Page();
    w.hub.attach(page);
    w.writer.recordMcpAudit('web:list-attachments', 'reader', true, '<k1@x>');
    w.writer.saveCursor('me@qq.com', 'INBOX', '1', 42);
    w.hub.check();
    expect(page.names()).toEqual(['hello']);
    // And nothing at all when nothing was committed.
    w.hub.check();
    w.hub.check();
    expect(page.chunks).toHaveLength(1);
    w.hub.close();
  });

  it('reaches every page that is listening', () => {
    const w = world();
    const pages = [new Page(), new Page(), new Page()];
    for (const page of pages) w.hub.attach(page);
    w.file('k1');
    w.hub.check();
    for (const page of pages) expect(page.names()).toEqual(['hello', 'mail']);
    w.hub.close();
  });

  it('checks on its own timer while someone is listening', async () => {
    const w = world({ intervalMs: 10 });
    const page = new Page();
    w.hub.attach(page);
    w.file('k1');
    for (let waited = 0; waited < 100 && page.names().length < 2; waited += 1) await sleep(10);
    expect(page.names()).toEqual(['hello', 'mail']);
    w.hub.close();
  });

  it('keeps a quiet stream open with a comment no handler sees', async () => {
    const w = world({ keepAliveMs: 10 });
    const page = new Page();
    w.hub.attach(page);
    for (let waited = 0; waited < 100 && page.chunks.length < 3; waited += 1) await sleep(10);
    expect(page.chunks.slice(1).every((chunk) => chunk === ': keep-alive\n\n')).toBe(true);
    expect(page.chunks.length).toBeGreaterThanOrEqual(3);
    expect(page.names()).toEqual(['hello']);
    w.hub.close();
  });
});

describe('leaving', () => {
  it('forgets a page when its response closes', () => {
    const w = world();
    const stays = new Page();
    const leaves = new Page();
    w.hub.attach(stays);
    w.hub.attach(leaves);
    leaves.hangUp();
    expect(w.hub.size).toBe(1);
    w.file('k1');
    w.hub.check();
    expect(stays.names()).toEqual(['hello', 'mail']);
    expect(leaves.names()).toEqual(['hello']);
    // Hanging up twice is the same as once.
    leaves.hangUp();
    expect(w.hub.size).toBe(1);
    w.hub.close();
  });

  it('drops a page whose response can no longer be written to', () => {
    const w = world();
    const broken = new Page();
    const fine = new Page();
    w.hub.attach(broken);
    w.hub.attach(fine);
    broken.failWrites = true;
    w.file('k1');
    w.hub.check();
    expect(w.hub.size).toBe(1);
    expect(fine.names()).toEqual(['hello', 'mail']);
    w.hub.close();
  });

  it('holds a database handle only while someone is listening', () => {
    const w = world();
    expect(w.opened).toHaveLength(0);
    const one = new Page();
    const two = new Page();
    w.hub.attach(one);
    w.hub.attach(two);
    // One handle for every page, not one each.
    expect(w.opened).toHaveLength(1);
    one.hangUp();
    expect(w.closed).toHaveLength(0);
    two.hangUp();
    expect(w.closed).toEqual(w.opened);
    expect(w.hub.size).toBe(0);
    // With nobody listening a check is a no-op, not a read of a closed handle.
    expect(() => w.hub.check()).not.toThrow();

    // The next page opens a fresh one and is greeted with the present.
    w.file('while-away');
    const back = new Page();
    w.hub.attach(back);
    expect(w.opened).toHaveLength(2);
    expect(back.events()[0]![1]).toEqual(w.writer.changeSignature());
    w.hub.close();
    expect(w.closed).toHaveLength(2);
  });

  it('lets a page that was away notice what it missed from the hello alone', () => {
    const w = world();
    const before = new Page();
    w.hub.attach(before);
    const seen = before.events()[0]![1];
    before.hangUp();
    w.file('arrived-while-away');
    const after = new Page();
    w.hub.attach(after);
    const now = after.events()[0]![1];
    expect(now['mail']).not.toBe(seen['mail']);
    expect(now['poll']).toBe(seen['poll']);
    w.hub.close();
  });

  it('closes down completely when told to', () => {
    const w = world();
    const page = new Page();
    w.hub.attach(page);
    w.hub.close();
    expect(w.hub.size).toBe(0);
    expect(w.closed).toHaveLength(1);
    w.file('k1');
    w.hub.check();
    expect(page.names()).toEqual(['hello']);
    // Closing twice, or a late hang-up, is harmless.
    w.hub.close();
    page.hangUp();
  });
});

describe('the shared hub', () => {
  it('exists for the routes to use and starts with nobody on it', () => {
    expect(liveHub).toBeInstanceOf(LiveHub);
    expect(liveHub.size).toBe(0);
  });
});
