import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import './setup.js';
import type { ImapFlow, ListResponse } from 'imapflow';
import type { Account } from '../src/config.js';
import {
  FolderListener, IdleSupervisor, idleEnabled, idleFolderTokens, reconnectDelayMs, type ListenerDeps,
} from '../src/imap/idle.js';

const ACCOUNT: Account = {
  name: 'qq', provider: 'qq', username: 'me@qq.com', host: 'imap.qq.com', port: 993,
  auth: 'password', password: 'x', folders: ['INBOX', 'spam'], useSsl: true,
};

function entry(path: string, specialUse?: string): ListResponse {
  return {
    path, pathAsListed: path, name: path, delimiter: '/', flags: new Set(['\\HasNoChildren']),
    listed: true, subscribed: true, ...(specialUse ? { specialUse } : {}),
  } as unknown as ListResponse;
}

/** Just enough of ImapFlow for the listener: capabilities, LIST, open, events, logout. */
class FakeClient extends EventEmitter {
  capabilities = new Map<string, boolean | number>([['IDLE', true]]);
  usable = true;
  list = vi.fn(async () => [entry('INBOX'), entry('Junk', '\\Junk'), entry('Archive')]);
  mailboxOpen = vi.fn(async (path: string) => ({ path }));
  logout = vi.fn(async () => this.close());
  close = vi.fn(() => {
    if (!this.usable) return;
    this.usable = false;
    this.emit('close');
  });
  asImapFlow(): ImapFlow {
    return this as unknown as ImapFlow;
  }
}

/**
 * Test doubles for the listener's environment. `sleep` resolves immediately for
 * the first `instantSleeps` calls and then parks forever, so a listener that
 * keeps failing waits in its backoff instead of spinning.
 */
function harness(clients: FakeClient[], instantSleeps = 0): {
  deps: ListenerDeps; sleeps: number[]; connect: ReturnType<typeof vi.fn>;
} {
  const sleeps: number[] = [];
  const connect = vi.fn(async () => {
    const next = clients.shift();
    if (!next) throw new Error('AUTHENTICATE failed');
    return next.asImapFlow();
  });
  const sleep = (ms: number): Promise<void> => {
    sleeps.push(ms);
    return sleeps.length <= instantSleeps ? Promise.resolve() : new Promise(() => undefined);
  };
  return { deps: { connect, sleep, debounceMs: 5 }, sleeps, connect };
}

const settle = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('IDLE listener', () => {
  it('opens the folder read-only and coalesces a burst of notifications into one wake-up', async () => {
    const client = new FakeClient();
    const onWake = vi.fn(async () => undefined);
    const listener = new FolderListener(ACCOUNT, 'INBOX', onWake, harness([client]).deps);
    listener.start();
    await settle();
    expect(client.mailboxOpen).toHaveBeenCalledWith('INBOX', { readOnly: true });

    for (let count = 11; count <= 13; count += 1) client.emit('exists', { path: 'INBOX', count, prevCount: count - 1 });
    await settle();
    expect(onWake).toHaveBeenCalledTimes(1);
    // The wake-up reuses the listening connection: no second TLS handshake or LOGIN.
    expect(onWake).toHaveBeenCalledWith(ACCOUNT, expect.objectContaining({ path: 'INBOX' }), client);

    await listener.stop();
    expect(client.logout).toHaveBeenCalledTimes(1);
  });

  it('fetches once more when notifications arrive during a wake-up', async () => {
    const client = new FakeClient();
    let finishFirst: () => void = () => undefined;
    const onWake = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; }))
      .mockResolvedValue(undefined);
    const listener = new FolderListener(ACCOUNT, 'INBOX', onWake, harness([client]).deps);
    listener.start();
    await settle();

    client.emit('exists', { path: 'INBOX', count: 11, prevCount: 10 });
    await settle();
    expect(onWake).toHaveBeenCalledTimes(1);
    client.emit('exists', { path: 'INBOX', count: 12, prevCount: 11 });
    client.emit('exists', { path: 'INBOX', count: 13, prevCount: 12 });
    finishFirst();
    await settle();
    expect(onWake).toHaveBeenCalledTimes(2);
    await listener.stop();
  });

  it('resolves the spam token like the poll does', async () => {
    const client = new FakeClient();
    const listener = new FolderListener(ACCOUNT, 'spam', vi.fn(), harness([client]).deps);
    listener.start();
    await settle();
    expect(client.mailboxOpen).toHaveBeenCalledWith('Junk', { readOnly: true });
    await listener.stop();
  });

  it('stays on polling when the server does not advertise IDLE', async () => {
    const client = new FakeClient();
    client.capabilities.clear();
    const h = harness([client]);
    const listener = new FolderListener(ACCOUNT, 'INBOX', vi.fn(), h.deps);
    listener.start();
    await settle();
    expect(client.mailboxOpen).not.toHaveBeenCalled();
    expect(client.logout).toHaveBeenCalledTimes(1);
    // No reconnect loop: the folder is simply left to the scheduled poll.
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.sleeps).toEqual([]);
    await listener.stop();
  });

  it('refuses a folder the scheduled poll does not reconcile', async () => {
    const client = new FakeClient();
    const listener = new FolderListener({ ...ACCOUNT, folders: ['INBOX'] }, 'Archive', vi.fn(), harness([client]).deps);
    listener.start();
    await settle();
    expect(client.mailboxOpen).not.toHaveBeenCalled();
    expect(client.logout).toHaveBeenCalledTimes(1);
    await listener.stop();
  });

  it('reconnects with backoff after the server drops the connection', async () => {
    const first = new FakeClient();
    const second = new FakeClient();
    const h = harness([first, second], 1);
    const listener = new FolderListener(ACCOUNT, 'INBOX', vi.fn(), h.deps);
    listener.start();
    await settle();
    first.close();
    await settle();
    expect(h.sleeps).toEqual([2_000]);
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(second.mailboxOpen).toHaveBeenCalledWith('INBOX', { readOnly: true });
    await listener.stop();
    expect(second.logout).toHaveBeenCalledTimes(1);
  });

  it('backs off for a long time on non-transient failures and still stops promptly', async () => {
    const h = harness([]);
    const listener = new FolderListener(ACCOUNT, 'INBOX', vi.fn(), h.deps);
    listener.start();
    await settle();
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.sleeps).toEqual([5 * 60_000]);
    // stop() must not wait out a 15 minute backoff.
    await expect(Promise.race([listener.stop(), settle(500).then(() => 'timeout')])).resolves.toBeUndefined();
  });

  it('caps reconnect delays by failure type', () => {
    expect(reconnectDelayMs(1, true)).toBe(2_000);
    expect(reconnectDelayMs(3, true)).toBe(8_000);
    expect(reconnectDelayMs(10, true)).toBe(60_000);
    expect(reconnectDelayMs(1, false)).toBe(5 * 60_000);
    expect(reconnectDelayMs(2, false)).toBe(10 * 60_000);
    expect(reconnectDelayMs(20, false)).toBe(15 * 60_000);
  });
});

describe('IDLE supervisor', () => {
  it('is off unless IMAP_IDLE_ENABLED=true', () => {
    expect(idleEnabled()).toBe(false);
    process.env.IMAP_IDLE_ENABLED = 'true';
    expect(idleEnabled()).toBe(true);
  });

  it('creates one listener per account and folder and rejects the all token', () => {
    process.env.IMAP_IDLE_FOLDERS = 'INBOX, all, spam';
    expect(idleFolderTokens()).toEqual(['INBOX', 'all', 'spam']);
    const supervisor = new IdleSupervisor([ACCOUNT, { ...ACCOUNT, name: 'work', username: 'w@qq.com' }], vi.fn());
    expect(supervisor.listeners.map((l) => `${l.account.name}:${l.token}`).sort()).toEqual([
      'qq:INBOX', 'qq:spam', 'work:INBOX', 'work:spam',
    ]);
  });
});
