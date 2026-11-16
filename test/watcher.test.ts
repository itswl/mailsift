import { afterEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => vi.unstubAllGlobals());

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

  it('files where each message is in its folder, so the reader can fetch it without searching', async () => {
    const { w, state } = watcher();
    stubTriage({ '<a@x>': makeResult(), '<b@x>': makeResult() });
    await w.dispatch(w.filterFresh([
      makeMessage({ messageId: '<a@x>', uid: 31, uidValidity: '1700000000' }),
      // A message that did not come from a mailbox fetch says nothing, and nothing is made up for it.
      makeMessage({ messageId: '<b@x>', uid: 32 }),
    ]), stats());
    expect(state.placeOf('me@qq.com|<a@x>')).toEqual({ uid: 31, uidValidity: '1700000000' });
    expect(state.placeOf('me@qq.com|<b@x>')).toBeUndefined();
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
    const { w } = watcher(new RecordingSink('failed'));
    stubTriage({ '<c@x>': makeResult({ importance: 'critical' }) });
    const s = stats();
    await w.dispatch([makeMessage({ messageId: '<c@x>' })], s);
    expect(s.pushed).toBe(0);
  });

  it('records undelivered messages accurately', async () => {
    // If success is reported incorrectly, there is no way to find the missing message later.
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    const { w, state } = watcher(new RecordingSink('failed'));
    stubTriage({ '<c@x>': makeResult({ importance: 'critical' }) });
    await w.dispatch(w.filterFresh([makeMessage({ messageId: '<c@x>' })]), stats());
    expect(state.queryMail({ pushedOnly: true })).toHaveLength(0);
  });

  it('queues failed deliveries in the digest instead of losing them', async () => {
    // The message is marked seen and will not be fetched next round, so failures need a destination.
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    const { w, state } = watcher(new RecordingSink('failed'));
    stubTriage({ '<c@x>': makeResult({ importance: 'critical' }) });
    const s = stats();
    await w.dispatch([makeMessage({ messageId: '<c@x>' })], s);
    expect(s.queued).toBe(1);
    expect(state.digestPending()).toBe(1);
  });
});

/** Two monitored mailboxes, so one can forward into the other. */
function twoMailboxes(): WatchConfig {
  const base = { port: 993, folders: ['INBOX'], useSsl: true } as const;
  return {
    accounts: [
      { ...base, name: 'qq', provider: 'qq', username: 'me@qq.com', host: 'imap.qq.com', auth: 'password', password: 'x' },
      { ...base, name: 'live', provider: 'outlook', username: 'me@live.com', host: 'outlook.office365.com', auth: 'outlook_oauth' },
    ],
    rules: { alwaysImportant: [], neverImportant: [], keywords: [], context: '' },
  };
}

describe('self-forwarded copies', () => {
  it('records the copy but neither pushes it nor repeats it in the digest', async () => {
    // Earlier tests leave triage() mocked; this one needs the real rule layer.
    vi.restoreAllMocks();
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    process.env.LLM_API_KEY = 'k';
    const llm = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', llm);
    const state = new StateStore(':memory:');
    const sink = new RecordingSink();
    const w = new Watcher(twoMailboxes(), state, sink);
    const s = stats();

    await w.dispatch([makeMessage({
      messageId: '<fwd@x>', account: 'me@qq.com', fromAddr: 'me@live.com', subject: '转发: 登录提醒',
    })], s);

    // The rule layer settles it, so the copy costs no tokens.
    expect(llm).not.toHaveBeenCalled();
    expect(sink.pushed).toHaveLength(0);
    expect(s.pushed).toBe(0);
    // The original was triaged at its source, so repeating the copy in the
    // digest would only crowd out mail that has not been seen.
    expect(state.digestPending()).toBe(0);
    expect(s.queued).toBe(0);
    // The record stays, so list_mail still finds it.
    expect(state.queryMail({})[0]).toMatchObject({ importance: 'info', decidedBy: 'rule', category: 'Forwarded copy' });
  });

  it('is never pushed, whatever the thresholds allow', async () => {
    // The guard used to sit only on the below-threshold branch, so a spam bonus
    // or PUSH_MIN_IMPORTANCE=info let the second notification through anyway.
    for (const [bonus, threshold, inSpam] of [['1', 'warning', true], ['0', 'info', false]] as const) {
      vi.restoreAllMocks();
      process.env.SPAM_RANK_BONUS = bonus;
      process.env.PUSH_MIN_IMPORTANCE = threshold;
      process.env.LLM_API_KEY = 'k';
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
      const sink = new RecordingSink();
      const state = new StateStore(':memory:');
      const w = new Watcher(twoMailboxes(), state, sink);
      const s = stats();

      await w.dispatch([makeMessage({
        messageId: '<fwd@x>', account: 'me@qq.com', fromAddr: 'me@live.com',
        inSpam, folder: inSpam ? 'Junk' : 'INBOX', subject: '转发: 登录提醒',
      })], s);

      expect(sink.pushed).toHaveLength(0);
      expect(s.pushed).toBe(0);
      expect(state.digestPending()).toBe(0);
    }
  });

  it('keeps pushing the copy when suppression is turned off', async () => {
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    process.env.SUPPRESS_SELF_FORWARDS = 'false';
    const sink = new RecordingSink();
    const w = new Watcher(twoMailboxes(), new StateStore(':memory:'), sink);
    stubTriage({ '<fwd@x>': makeResult({ importance: 'critical' }) });

    await w.dispatch([makeMessage({
      messageId: '<fwd@x>', account: 'me@qq.com', fromAddr: 'me@live.com',
    })], stats());

    expect(sink.pushed).toHaveLength(1);
  });
});

describe('declined deliveries', () => {
  it('does not leave a declined message in the retry outbox', async () => {
    // The spam bonus made the watcher push a message the output refused by its
    // own policy. Marking that refusal as a failure left an entry that retried
    // on every poll forever and showed up as a permanent delivery backlog.
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    process.env.SPAM_RANK_BONUS = '1';
    const { w, state } = watcher(new RecordingSink('declined'));
    stubTriage({ '<s@x>': makeResult({ importance: 'info' }) });
    const s = stats();

    await w.dispatch([makeMessage({ messageId: '<s@x>', inSpam: true })], s);

    expect(state.notificationOutboxPending()).toBe(0);
    expect(s.pushed).toBe(0);
    // The message still reaches the user through the digest.
    expect(state.digestPending()).toBe(1);
    expect(s.queued).toBe(1);
  });

  it('keeps a failed delivery queued for the next poll', async () => {
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    const { w, state } = watcher(new RecordingSink('failed'));
    stubTriage({ '<c@x>': makeResult({ importance: 'critical' }) });

    await w.dispatch([makeMessage({ messageId: '<c@x>' })], stats());

    expect(state.notificationOutboxPending()).toBe(1);
  });

  it('drains an outbox entry that every output now declines', async () => {
    // Entries stranded by the older behaviour clear themselves on the next poll.
    const { w, state } = watcher(new RecordingSink('declined'));
    state.enqueueNotification('stranded', makeMessage(), makeResult());
    vi.spyOn(w, 'collectAll').mockResolvedValue({ messages: [], cursors: [] });
    expect(state.notificationOutboxPending()).toBe(1);

    await w.pollOnce();

    expect(state.notificationOutboxPending()).toBe(0);
  });

  it('drains the outbox even when mail collection fails', async () => {
    // Retrying a queued notification needs no IMAP state, so a provider that
    // accepts the connection and then hangs must not also stall deliveries
    // that are already waiting.
    const { w, state, sink } = watcher();
    state.enqueueNotification('waiting', makeMessage(), makeResult());
    vi.spyOn(w, 'collectAll').mockRejectedValue(new Error('imap wedged'));

    await expect(w.pollOnce()).rejects.toThrow('imap wedged');

    expect(sink.pushed).toHaveLength(1);
    expect(state.notificationOutboxPending()).toBe(0);
  });

  it('queues a declined entry for the digest before dropping it', async () => {
    // A crash between enqueueNotification and queueDigest leaves a row whose
    // message is marked seen and queued nowhere; dropping it on the assumption
    // that the digest carries it would lose the message entirely.
    const { w, state } = watcher(new RecordingSink('declined'));
    state.enqueueNotification('orphan', makeMessage(), makeResult());
    vi.spyOn(w, 'collectAll').mockResolvedValue({ messages: [], cursors: [] });

    await w.pollOnce();

    expect(state.notificationOutboxPending()).toBe(0);
    expect(state.digestPending()).toBe(1);
  });

  it('skips an outbox payload of the wrong shape instead of failing every reader', async () => {
    const { state } = watcher();
    state.enqueueNotification('good', makeMessage(), makeResult());
    (state as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db
      .prepare('INSERT INTO notification_outbox (notification_key, payload, created_at) VALUES (?, ?, ?)')
      .run('broken', JSON.stringify({ nothing: true }), new Date().toISOString());

    expect(state.pendingNotifications().map((e) => e.notificationKey)).toEqual(['good']);
  });

  it('holds an entry for a message put off until its time, and drops one dealt with', async () => {
    const { w, state, sink } = watcher();
    const later = new Date(Date.now() + 3 * 86_400_000).toISOString();
    for (const key of ['put-off', 'done', 'plain']) {
      state.markSeen(key, 'me@qq.com', 'Invoice');
      state.recordOutcome(key, 'critical', false, { messageId: `<${key}@x>`, subject: 'Invoice', folder: 'INBOX' });
      state.enqueueNotification(key, makeMessage({ messageId: `<${key}@x>` }), makeResult({ importance: 'critical' }));
    }
    state.setSnoozed('put-off', later);
    state.setHandled('done', true);
    vi.spyOn(w, 'collectAll').mockResolvedValue({ messages: [], cursors: [] });

    await w.pollOnce();

    expect(sink.pushed.map(([m]) => m.messageId)).toEqual(['<plain@x>']);
    const left = state.pendingNotifications(50, false);
    expect(left.map((e) => e.notificationKey)).toEqual(['put-off']);
    // Waiting, not failing: no attempt counted, and due at the time chosen.
    expect(left[0]).toMatchObject({ attempts: 0, nextAttemptAt: later });
    expect(state.pendingNotifications(50, true)).toEqual([]);
    // Dealt with, it is not listed again in a digest that may have gone out already.
    expect(state.digestPending()).toBe(0);
    // Held is not failing: health counts it apart.
    expect(state.notificationOutboxPending()).toBe(0);
    expect(state.notificationOutboxHeld()).toBe(1);
    // Brought forward, it goes at the new time; taken back now, nobody is told.
    const sooner = new Date(Date.now() + 3_600_000).toISOString();
    state.setSnoozed('put-off', sooner);
    expect(state.pendingNotifications(50, false)[0]).toMatchObject({ nextAttemptAt: sooner });
    state.setSnoozed('put-off', later);
    expect(state.pendingNotifications(50, false)[0]).toMatchObject({ nextAttemptAt: sooner });
    state.wakeNow('put-off');
    expect(state.pendingNotifications(50, false)).toEqual([]);
  });

  it('sends a held entry at once when the reminder is taken away', async () => {
    const { w, state, sink } = watcher();
    state.markSeen('k', 'me@qq.com', 'Invoice');
    state.recordOutcome('k', 'critical', false, { messageId: '<k@x>', subject: 'Invoice', folder: 'INBOX' });
    state.enqueueNotification('k', makeMessage({ messageId: '<k@x>' }), makeResult({ importance: 'critical' }));
    state.setSnoozed('k', new Date(Date.now() + 86_400_000).toISOString());
    vi.spyOn(w, 'collectAll').mockResolvedValue({ messages: [], cursors: [] });
    await w.pollOnce();
    expect(sink.pushed).toEqual([]);

    state.setSnoozed('k', null);
    await w.pollOnce();
    expect(sink.pushed.map(([m]) => m.messageId)).toEqual(['<k@x>']);
  });

  it('retries an outbox entry whose delivery failed', async () => {
    const { w, state } = watcher(new RecordingSink('failed'));
    state.enqueueNotification('pending', makeMessage(), makeResult());
    vi.spyOn(w, 'collectAll').mockResolvedValue({ messages: [], cursors: [] });

    await w.pollOnce();

    expect(state.notificationOutboxPending()).toBe(1);
    expect(state.pendingNotifications()[0]?.attempts).toBe(1);
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
    // Keyed by folder: one healthy listener must not vouch for a dead sibling.
    expect(state.getMeta('idle_last_wake_at:me@qq.com|INBOX')).toBeTruthy();
    expect(state.listMeta('idle_last_wake_at:').map((r) => r.key))
      .toEqual(['idle_last_wake_at:me@qq.com|INBOX']);
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

describe('re-triage after an LLM outage', () => {
  it('leaves a code it handled itself alone, stored code and all', async () => {
    vi.restoreAllMocks(); // the real triage, not an earlier test's stub
    process.env.PUSH_MIN_IMPORTANCE = 'critical';
    process.env.LLM_API_KEY = 'k';
    const { w, state } = watcher();
    // A row as 0.1.97 left it: a code handled locally but labelled 'fallback',
    // waiting in the digest, while the LLM was down.
    state.markSeen('old-code', 'me@qq.com', '验证码邮件');
    state.recordOutcome('old-code', 'warning', false, {
      decidedBy: 'fallback', summary: '收到验证码邮件。', verificationCode: '482913',
      snippet: '验证码邮件（正文已隐藏）', subject: '验证码邮件', folder: 'INBOX',
    });
    state.queueDigest('old-code', { subject: '验证码邮件' });
    state.setMeta('llm_fail_count', '3');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results: [
      { index: 0, importance: 'info', category: 'Other', summary: 'ok', reason: 'ok', deadline: '', action_required: false },
    ] }) } }] }), { status: 200 })));

    await w.dispatch([makeMessage({ messageId: '<new@x>', subject: 'Weekly notes' })], stats());

    const row = state.getMail('old-code');
    expect(row).toMatchObject({ verificationCode: '482913', summary: '收到验证码邮件。' });
  });

  it('does not notify a message put off, or one dealt with, when the late verdict would', async () => {
    vi.restoreAllMocks();
    process.env.PUSH_MIN_IMPORTANCE = 'critical';
    process.env.LLM_API_KEY = 'k';
    const { w, state, sink } = watcher();
    const later = new Date(Date.now() + 3 * 86_400_000).toISOString();
    // Filed by the keyword fallback while the model was down, then seen in the page.
    for (const key of ['put-off', 'done']) {
      state.markSeen(key, 'me@qq.com', 'Invoice');
      state.recordOutcome(key, 'info', false, {
        messageId: `<${key}@x>`, decidedBy: 'fallback', summary: 'Invoice', snippet: 'Please pay the invoice by Friday',
        subject: 'Invoice', folder: 'INBOX',
      });
      state.queueDigest(key, { subject: 'Invoice' });
    }
    state.setSnoozed('put-off', later);
    state.setHandled('done', true);
    state.setMeta('llm_fail_count', '3');
    // One verdict per message asked about: critical, every one.
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      const asked = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ content?: string }> };
      const user = asked.messages?.findLast?.((m) => String(m.content ?? '').includes('"emails"'))?.content ?? '{"emails":[]}';
      const count = (JSON.parse(user) as { emails: unknown[] }).emails.length;
      const results = Array.from({ length: count }, (_, index) => ({
        index, importance: 'critical', category: 'Finance', summary: 'Pay the invoice', reason: 'due', deadline: '', action_required: true,
      }));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }), { status: 200 });
    }));

    await w.dispatch([makeMessage({ messageId: '<new@x>', subject: 'Weekly notes' })], stats());

    const pushed = sink.pushed.map(([m]) => m.messageId);
    expect(pushed).not.toContain('<put-off@x>');
    expect(pushed).not.toContain('<done@x>');
    // The verdict is kept, and the digest carries both as usual.
    expect(state.getMail('put-off')).toMatchObject({ importance: 'critical', pushed: false, snoozedUntil: later });
    expect(state.getMail('done')).toMatchObject({ importance: 'critical', pushed: false });
    // The one put off waits for the time chosen, for the outputs without reminders of their own,
    // and that is its only way out: no digest lists it meanwhile.
    const waiting = state.pendingNotifications(50, false);
    expect(waiting.map((e) => e.notificationKey)).toEqual(['put-off']);
    expect(waiting[0]).toMatchObject({ attempts: 0, nextAttemptAt: later });
    expect(state.pendingNotifications(50, true)).toEqual([]);
    expect(state.digestPending()).toBe(1);
  });

  it('decides on the message as it is after the model answers, not as it was before', async () => {
    vi.restoreAllMocks();
    process.env.PUSH_MIN_IMPORTANCE = 'critical';
    process.env.LLM_API_KEY = 'k';
    const { w, state, sink } = watcher();
    state.markSeen('late', 'me@qq.com', 'Invoice');
    state.recordOutcome('late', 'info', false, {
      messageId: '<late@x>', decidedBy: 'fallback', summary: 'Invoice', snippet: 'Please pay the invoice by Friday',
      subject: 'Invoice', folder: 'INBOX',
    });
    state.queueDigest('late', { subject: 'Invoice' });
    state.setMeta('llm_fail_count', '3');
    const later = new Date(Date.now() + 86_400_000).toISOString();
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      const asked = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ content?: string }> };
      const user = asked.messages?.findLast?.((m) => String(m.content ?? '').includes('"emails"'))?.content ?? '{"emails":[]}';
      const emails = (JSON.parse(user) as { emails: Array<{ subject?: string }> }).emails;
      // The owner puts it off in the page while the backlog is being judged.
      if (emails.some((e) => e.subject === 'Invoice')) state.setSnoozed('late', later);
      const results = emails.map((_, index) => ({
        index, importance: 'critical', category: 'Finance', summary: 'Pay', reason: 'due', deadline: '', action_required: true,
      }));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }), { status: 200 });
    }));

    await w.dispatch([makeMessage({ messageId: '<new@x>', subject: 'Weekly notes' })], stats());

    expect(sink.pushed.map(([m]) => m.messageId)).not.toContain('<late@x>');
    expect(state.pendingNotifications(50, false)).toEqual([expect.objectContaining({ notificationKey: 'late', nextAttemptAt: later })]);
  });
});

describe('sign-in link mail through dispatch', () => {
  const token = 'https://medium.com/m/callback/email?token=0123456789abcdefABCDEF_-xyz&operation=login';

  it('stores and queues it hidden, keeping its kind for a retried card', async () => {
    vi.restoreAllMocks(); // the real triage
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    const { w, state } = watcher(new RecordingSink('failed'));
    await w.dispatch([makeMessage({ messageId: '<link@x>', subject: 'Sign in to Medium', body: `Click: ${token}` })], stats());

    const row = state.getMail('<link@x>');
    expect(row).toMatchObject({ subject: '登录链接邮件', summary: '收到登录链接邮件。' });
    expect(JSON.stringify(row)).not.toContain('0123456789abcdefABCDEF');
    const [entry] = state.pendingNotifications();
    expect(entry!.result.sensitiveKind).toBe('link');
    expect(JSON.stringify(entry)).not.toContain('0123456789abcdefABCDEF');
    const { buildCard } = await import('../src/services/feishu.js');
    const card = JSON.stringify(buildCard(entry!.message, entry!.result));
    expect(card).toContain('登录链接');
    expect(card).not.toContain('验证码');
  });

  it('does not push a reset link from spam when the model it would have asked is missing', async () => {
    vi.restoreAllMocks();
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    process.env.LLM_SKIP_SENSITIVE = 'false'; // asks the model, but no LLM_API_KEY: keyword fallback
    const { w, sink, state } = watcher();
    const s = stats();
    await w.dispatch([makeMessage({
      messageId: '<phish@x>', inSpam: true, folder: 'Junk', fromAddr: 'security@paypa1-support.xyz',
      subject: 'Reset your password immediately', body: 'https://paypa1-support.xyz/login/session-7f3a9c2e1b4d8f6a0c5e',
    })], s);
    expect(s.pushed).toBe(0);
    expect(sink.pushed).toHaveLength(0);
    expect(state.getMail('<phish@x>')).toMatchObject({ importance: 'info', summary: '收到登录链接邮件（如果不是你刚刚请求的，请勿打开）。' });
  });
});
