import { describe, expect, it, vi } from 'vitest';
import './setup.js';
import { makeMessage, makeResult, RecordingSink } from './helpers.js';
import { StateStore } from '../src/services/state.js';
import { Watcher } from '../src/services/watcher.js';
import type { WatchConfig } from '../src/config.js';
import * as triageModule from '../src/services/triage.js';
import * as clientModule from '../src/imap/client.js';
import type { ImapFlow } from 'imapflow';
import type { Account } from '../src/config.js';
import type { Folder } from '../src/imap/folders.js';
import type { MailMessage } from '../src/imap/message.js';
import type { TriageResult } from '../src/services/triage.js';

const CONFIG: WatchConfig = {
  accounts: [],
  rules: { alwaysImportant: [], neverImportant: [], keywords: [], context: '' },
};

function watcher(sink = new RecordingSink()): { w: Watcher; sink: RecordingSink; state: StateStore } {
  const state = new StateStore(':memory:');
  return { w: new Watcher(CONFIG, state, sink), sink, state };
}

function stubTriage(mapping: Record<string, TriageResult>): void {
  vi.spyOn(triageModule, 'triage').mockImplementation(
    async (messages: MailMessage[]) => messages.map((m) => [m, mapping[m.messageId]!] as [MailMessage, TriageResult]),
  );
}

const stats = () => ({
  accountsOk: 0, accountsFailed: 0, fetched: 0, fresh: 0,
  pushed: 0, queued: 0, spamRescued: 0, failures: [] as string[],
});

describe('push threshold', () => {
  it('pushes in real time only at or above the threshold', async () => {
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    const { w, sink } = watcher();
    stubTriage({
      '<c@x>': makeResult({ importance: 'critical' }),
      '<w@x>': makeResult({ importance: 'warning' }),
      '<i@x>': makeResult({ importance: 'info' }),
    });
    const s = stats();
    await w.dispatch(
      [makeMessage({ messageId: '<c@x>' }), makeMessage({ messageId: '<w@x>' }), makeMessage({ messageId: '<i@x>' })],
      s,
    );
    expect(s.pushed).toBe(2);
    expect(sink.pushed.map(([m]) => m.messageId)).toEqual(['<c@x>', '<w@x>']);
  });

  it('queues below-threshold messages for the digest', async () => {
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    const { w, state } = watcher();
    stubTriage({ '<i@x>': makeResult({ importance: 'info' }) });
    const s = stats();
    await w.dispatch([makeMessage({ messageId: '<i@x>' })], s);
    expect(s.pushed).toBe(0);
    expect(state.digestPending()).toBe(1);
  });
});

describe('spam strategy', () => {
  it('does not boost spam by default because pushing all spam moves noise to IM', async () => {
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    const { w, state } = watcher();
    stubTriage({ '<s@x>': makeResult({ importance: 'info' }) });
    const s = stats();
    await w.dispatch([makeMessage({ messageId: '<s@x>', inSpam: true })], s);
    expect(s.pushed).toBe(0);
    expect(state.digestPending()).toBe(1);
  });

  it('always includes spam in the digest regardless of the digest threshold', async () => {
    // This ensures spam is not a black hole.
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    process.env.DIGEST_MIN_IMPORTANCE = 'critical';
    const { w, state } = watcher();
    stubTriage({
      '<s@x>': makeResult({ importance: 'info' }),
      '<i@x>': makeResult({ importance: 'info' }),
    });
    await w.dispatch([makeMessage({ messageId: '<s@x>', inSpam: true }), makeMessage({ messageId: '<i@x>' })], stats());
    expect(state.digestPending()).toBe(1);
  });

  it('supports an optional spam boost', async () => {
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    process.env.SPAM_RANK_BONUS = '1';
    const { w } = watcher();
    stubTriage({ '<s@x>': makeResult({ importance: 'info' }) });
    const s = stats();
    await w.dispatch([makeMessage({ messageId: '<s@x>', inSpam: true })], s);
    expect(s.pushed).toBe(1);
  });

  it('tracks rescued spam separately', async () => {
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    const { w } = watcher();
    stubTriage({
      '<s@x>': makeResult({ importance: 'critical' }),
      '<n@x>': makeResult({ importance: 'critical' }),
    });
    const s = stats();
    await w.dispatch([makeMessage({ messageId: '<s@x>', inSpam: true }), makeMessage({ messageId: '<n@x>' })], s);
    expect(s.pushed).toBe(2);
    expect(s.spamRescued).toBe(1);
  });
});

describe('deduplication', () => {
  it('deduplicates within a batch when one message appears in two folders', () => {
    const { w } = watcher();
    const fresh = w.filterFresh([
      makeMessage({ messageId: '<a@x>' }),
      makeMessage({ messageId: '<a@x>' }),
      makeMessage({ messageId: '<b@x>' }),
    ]);
    expect(fresh).toHaveLength(2);
  });

  it('filterFresh reads without writing', () => {
    // Defer marking until dispatch so a crash does not silently lose a message.
    const { w, state } = watcher();
    const messages = [makeMessage({ messageId: '<a@x>' })];
    expect(w.filterFresh(messages)).toHaveLength(1);
    expect(w.filterFresh(messages)).toHaveLength(1);
    expect(state.isSeen('me@qq.com|<a@x>')).toBe(false);
  });

  it('counts the same message once per mailbox', () => {
    const { w } = watcher();
    const fresh = w.filterFresh([
      makeMessage({ messageId: '<a@x>', account: 'me@qq.com' }),
      makeMessage({ messageId: '<a@x>', account: 'me@gmail.com' }),
    ]);
    expect(fresh).toHaveLength(2);
  });

  it('does not reprocess handled messages on the next round', async () => {
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    const { w } = watcher();
    stubTriage({ '<a@x>': makeResult({ importance: 'critical' }) });
    await w.dispatch(w.filterFresh([makeMessage({ messageId: '<a@x>' })]), stats());
    expect(w.filterFresh([makeMessage({ messageId: '<a@x>' })])).toHaveLength(0);
  });
});

describe('delivery failures', () => {
  it('does not count failed deliveries as pushes', async () => {
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    const { w } = watcher(new RecordingSink(false));
    stubTriage({ '<c@x>': makeResult({ importance: 'critical' }) });
    const s = stats();
    await w.dispatch([makeMessage({ messageId: '<c@x>' })], s);
    expect(s.pushed).toBe(0);
  });

  it('records undelivered messages accurately', async () => {
    // If success is reported incorrectly, there is no way to find the missing message later.
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    const { w, state } = watcher(new RecordingSink(false));
    stubTriage({ '<c@x>': makeResult({ importance: 'critical' }) });
    await w.dispatch(w.filterFresh([makeMessage({ messageId: '<c@x>' })]), stats());
    expect(state.queryMail({ pushedOnly: true })).toHaveLength(0);
  });

  it('queues failed deliveries in the digest instead of losing them', async () => {
    // The message is marked seen and will not be fetched next round, so failures need a destination.
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    const { w, state } = watcher(new RecordingSink(false));
    stubTriage({ '<c@x>': makeResult({ importance: 'critical' }) });
    const s = stats();
    await w.dispatch([makeMessage({ messageId: '<c@x>' })], s);
    expect(s.queued).toBe(1);
    expect(state.digestPending()).toBe(1);
  });
});

describe('IDLE wake-ups', () => {
  const ACCOUNT: Account = {
    name: 'qq', provider: 'qq', username: 'me@qq.com', host: 'imap.qq.com', port: 993,
    auth: 'password', password: 'x', folders: ['INBOX'], useSsl: true,
  };
  const INBOX: Folder = { path: 'INBOX', rawPath: 'INBOX', flags: new Set(), isSpam: false, selectable: true };
  const CLIENT = {} as ImapFlow;

  it('leaves a folder without a cursor to the scheduled poll', async () => {
    // The poll's bounded lookback handles first contact; a wake-up must not double it.
    const { w } = watcher();
    const fetch = vi.spyOn(clientModule, 'fetchNew');
    const stats = await w.pollFolder(ACCOUNT, INBOX, CLIENT);
    expect(fetch).not.toHaveBeenCalled();
    expect(stats.fetched).toBe(0);
  });

  it('pushes a message once when a wake-up and a poll both carry it', async () => {
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    const { w, sink, state } = watcher();
    state.saveCursor('me@qq.com', 'INBOX', '1', 100);
    const message = makeMessage({ messageId: '<a@x>' });
    stubTriage({ '<a@x>': makeResult({ importance: 'critical' }) });
    vi.spyOn(clientModule, 'fetchNew').mockResolvedValue({
      messages: [message], cursor: { uidValidity: '1', lastUid: 101 }, failures: [],
    });
    vi.spyOn(w, 'collectAll').mockResolvedValue({
      messages: [message], cursors: [['me@qq.com', 'INBOX', '1', 103]],
    });

    await Promise.all([w.pollFolder(ACCOUNT, INBOX, CLIENT), w.pollOnce()]);

    expect(sink.pushed).toHaveLength(1);
    // Whichever commits second saw fewer messages and must not rewind the cursor.
    expect(state.getCursor('me@qq.com', 'INBOX')).toEqual({ uidValidity: '1', lastUid: 103 });
  });

  it('records the wake-up time for health reporting', async () => {
    const { w, state } = watcher();
    state.saveCursor('me@qq.com', 'INBOX', '1', 100);
    vi.spyOn(clientModule, 'fetchNew').mockResolvedValue({
      messages: [], cursor: { uidValidity: '1', lastUid: 100 }, failures: [],
    });
    await w.pollFolder(ACCOUNT, INBOX, CLIENT);
    expect(state.getMeta('idle_last_wake_at:me@qq.com')).toBeTruthy();
  });
});

describe('crash safety', () => {
  it('does not advance the cursor when triage fails', async () => {
    // Otherwise this batch could never be fetched again and would disappear silently.
    const { w, state } = watcher();
    vi.spyOn(w, 'collectAll').mockResolvedValue({
      messages: [makeMessage({ messageId: '<a@x>' })],
      cursors: [['me@qq.com', 'INBOX', '1', 99]],
    });
    vi.spyOn(triageModule, 'triage').mockRejectedValue(new Error('crashed'));

    await expect(w.pollOnce()).rejects.toThrow('crashed');
    expect(state.getCursor('me@qq.com', 'INBOX')).toBeUndefined();
    expect(state.isSeen('me@qq.com|<a@x>')).toBe(false);
  });

  it('advances the cursor only after success', async () => {
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    const { w, state } = watcher();
    vi.spyOn(w, 'collectAll').mockResolvedValue({
      messages: [makeMessage({ messageId: '<a@x>' })],
      cursors: [['me@qq.com', 'INBOX', '1', 99]],
    });
    stubTriage({ '<a@x>': makeResult({ importance: 'critical' }) });

    await w.pollOnce();
    expect(state.getCursor('me@qq.com', 'INBOX')).toEqual({ uidValidity: '1', lastUid: 99 });
    expect(state.isSeen('me@qq.com|<a@x>')).toBe(true);
  });

  it('writes a heartbeat for health checks', async () => {
    const { w, state } = watcher();
    vi.spyOn(w, 'collectAll').mockResolvedValue({ messages: [], cursors: [] });
    expect(state.getMeta('last_poll_at')).toBeUndefined();
    await w.pollOnce();
    expect(state.getMeta('last_poll_at')).toBeTruthy();
  });

  it('prunes the state store once per day', async () => {
    const { w, state } = watcher();
    vi.spyOn(w, 'collectAll').mockResolvedValue({ messages: [], cursors: [] });
    const spy = vi.spyOn(state, 'prune').mockReturnValue(0);
    await w.pollOnce();
    await w.pollOnce();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(90);
  });

  it('allows pruning to be disabled', async () => {
    process.env.STATE_RETENTION_DAYS = '0';
    const { w, state } = watcher();
    vi.spyOn(w, 'collectAll').mockResolvedValue({ messages: [], cursors: [] });
    const spy = vi.spyOn(state, 'prune');
    await w.pollOnce();
    expect(spy).not.toHaveBeenCalled();
  });
});
