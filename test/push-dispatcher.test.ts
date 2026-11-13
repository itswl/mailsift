import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import './setup.js';
import {
  fitNotice, noticeFor, PUSH_CURSOR_KEY, PushDispatcher, pushSubject, sendTestPush, vapidKeys, wants,
  type PushNotice,
} from '../src/services/push-dispatcher.js';
import { StateStore, type MailRow, type PushSubscriptionRow } from '../src/services/state.js';
import { MAX_PAYLOAD_BYTES, type PushSendResult, type sendPush } from '../src/services/webpush.js';

afterEach(() => {
  delete process.env.WEB_PUSH_SUBJECT;
});

interface Sent {
  endpoint: string;
  notice: PushNotice;
  ttl: number;
  urgency: string | undefined;
  subject: string;
  publicKey: string;
}

const endpoint = (name: string): string => `https://fcm.googleapis.com/fcm/send/${name}`;

/**
 * One pass, once the millisecond the test just wrote in is over: the
 * dispatcher leaves the current millisecond's rows for its next pass.
 */
async function pass(dispatcher: PushDispatcher, force = false): Promise<number> {
  await sleep(2);
  return dispatcher.tick(force);
}

/**
 * A database file with a writer (standing in for the poller), a fake push
 * service, and as many dispatchers as a test asks for, each on a handle of
 * its own the way separate processes would be.
 */
function world() {
  const path = join(mkdtempSync(join(tmpdir(), 'mailsift-push-')), 'state.db');
  const writer = new StateStore(path);
  const sent: Sent[] = [];
  const outcomes = new Map<string, PushSendResult>();
  const send = (async (target, payload, keys, options) => {
    sent.push({
      endpoint: target.endpoint, notice: payload as PushNotice, ttl: options.ttl, urgency: options.urgency,
      subject: options.subject, publicKey: keys.publicKey,
    });
    return outcomes.get(target.endpoint) ?? 'sent';
  }) as typeof sendPush;
  const dispatcher = (): PushDispatcher => new PushDispatcher({ openStore: () => new StateStore(path), send });

  /** Past the bootstrap: the cursor already exists, a minute back. */
  const started = (): void => {
    writer.setMeta(PUSH_CURSOR_KEY, JSON.stringify({ createdAt: new Date(Date.now() - 60_000).toISOString(), dedupKey: '' }));
  };
  const subscribe = (name: string, over: Partial<Pick<PushSubscriptionRow, 'level' | 'codes' | 'lang'>> & { origin?: string } = {}): string => {
    writer.savePushSubscription({
      endpoint: endpoint(name), p256dh: 'p256dh', auth: 'auth',
      level: over.level ?? 'warning', codes: over.codes ?? true, lang: over.lang ?? 'en',
      ...(over.origin ? { origin: over.origin } : {}),
    });
    return endpoint(name);
  };
  const file = (key: string, importance: string, fields: Record<string, unknown> = {}): void => {
    writer.markSeen(key, 'me@qq.com', `subject ${key}`);
    writer.recordOutcome(key, importance, importance !== 'info', {
      messageId: `<${key}@x>`, sender: 'sender@example.com', senderName: 'Sender', summary: `summary of ${key}`,
      decidedBy: 'llm', mailDate: new Date().toISOString(), ...fields,
    });
  };
  return { path, writer, sent, outcomes, dispatcher, started, subscribe, file };
}

const row = (over: Partial<MailRow> = {}): MailRow => ({
  dedupKey: 'me@qq.com|<one@x>', messageId: '<one@x>', threadKey: null, account: 'me@qq.com', accountLabel: 'QQ',
  subject: 'Invoice 42', sender: 'billing@example.com', senderName: 'Billing', folder: 'INBOX', inSpam: false,
  importance: 'warning', category: 'Finance', summary: 'Invoice 42 is due on the 30th.', reason: 'a date',
  deadline: null, decidedBy: 'llm', pushed: true, mailDate: new Date().toISOString(),
  createdAt: new Date().toISOString(), handledAt: null, ...over,
});

const device = (over: Partial<PushSubscriptionRow> = {}): PushSubscriptionRow => ({
  endpoint: endpoint('d'), p256dh: 'k', auth: 'a', level: 'warning', codes: true, lang: 'en', label: null,
  origin: null, createdAt: new Date().toISOString(), lastOkAt: null, failures: 0, ...over,
});

describe('where it starts', () => {
  it('sends nothing for mail that was already there when notifications began', async () => {
    const w = world();
    w.subscribe('phone');
    w.file('already-here', 'critical');
    const dispatcher = w.dispatcher();
    expect(await pass(dispatcher)).toBe(0);
    expect(JSON.parse(w.writer.getMeta(PUSH_CURSOR_KEY) ?? '{}')).toMatchObject({ createdAt: expect.any(String) });
    // Nothing is replayed on the next pass either.
    w.writer.setMeta('nudge', '1');
    expect(await pass(dispatcher)).toBe(0);
    expect(w.sent).toEqual([]);

    await sleep(5);
    w.file('arrived', 'critical');
    expect(await pass(dispatcher)).toBe(1);
    expect(w.sent.map((s) => s.notice.key)).toEqual(['arrived']);
    dispatcher.stop();
  });

  it('starts over from now when the cursor is unreadable, rather than from the beginning', async () => {
    const w = world();
    w.subscribe('phone');
    w.file('old', 'critical');
    w.writer.setMeta(PUSH_CURSOR_KEY, 'not json');
    const dispatcher = w.dispatcher();
    expect(await pass(dispatcher)).toBe(0);
    expect(JSON.parse(w.writer.getMeta(PUSH_CURSOR_KEY) ?? '{}')).toMatchObject({ dedupKey: expect.any(String) });
    expect(w.sent).toEqual([]);
    dispatcher.stop();
  });

  it('does no work until another connection commits', async () => {
    const w = world();
    w.started();
    let reads = 0;
    const dispatcher = new PushDispatcher({
      openStore: () => {
        const store = new StateStore(w.path);
        const original = store.rowsAfter.bind(store);
        store.rowsAfter = (...args) => { reads += 1; return original(...args); };
        return store;
      },
    });
    await pass(dispatcher);
    await pass(dispatcher);
    await pass(dispatcher);
    expect(reads).toBe(1);
    w.writer.setMeta('nudge', '1');
    await pass(dispatcher);
    expect(reads).toBe(2);
    // A caller writing through the dispatcher's own handle can insist.
    await pass(dispatcher, true);
    expect(reads).toBe(3);
    dispatcher.stop();
  });
});

describe('what each device is told', () => {
  it('sends a code to a device that wants codes and not to one that does not', async () => {
    const w = world();
    w.started();
    const yes = w.subscribe('codes-on');
    w.subscribe('codes-off', { codes: false });
    w.file('code', 'warning', { summary: '收到验证码邮件。', verificationCode: '482913', senderName: 'GitHub' });
    const dispatcher = w.dispatcher();
    expect(await pass(dispatcher)).toBe(1);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({
      endpoint: yes, ttl: 600, urgency: 'high',
      notice: { kind: 'code', title: '482 913', body: 'GitHub · verification code', tag: 'code', url: '/?focus=code' },
    });
    dispatcher.stop();
  });

  it('goes by level for everything else', async () => {
    const w = world();
    w.started();
    const wide = w.subscribe('warning-and-up');
    const narrow = w.subscribe('critical-only', { level: 'critical' });
    w.file('warn', 'warning');
    w.file('crit', 'critical');
    w.file('info', 'info');
    const dispatcher = w.dispatcher();
    expect(await pass(dispatcher)).toBe(3);
    const keysFor = (to: string): string[] => w.sent.filter((s) => s.endpoint === to).map((s) => String(s.notice.key)).sort();
    expect(keysFor(wide)).toEqual(['crit', 'warn']);
    expect(keysFor(narrow)).toEqual(['crit']);
    expect(w.sent.every((s) => s.ttl === 86_400)).toBe(true);
    dispatcher.stop();
  });

  it('skips what is stale, already handled, or a digest', async () => {
    const w = world();
    w.started();
    w.subscribe('phone');
    const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
    // Fetched now, but sent ninety minutes ago: mail catching up after downtime, and a code nobody can use.
    w.file('old-code', 'warning', { summary: '收到验证码邮件。', verificationCode: '111111', mailDate: ago(90) });
    w.file('backfill', 'critical', { mailDate: ago(2 * 24 * 60) });
    w.file('digest', 'warning', { decidedBy: 'digest' });
    w.file('done', 'critical');
    w.writer.setHandled('done', true);
    w.file('fresh', 'critical', { mailDate: ago(30) });
    const dispatcher = w.dispatcher();
    expect(await pass(dispatcher)).toBe(1);
    expect(w.sent.map((s) => s.notice.key)).toEqual(['fresh']);
    dispatcher.stop();
  });

  it('judges each case the same way on its own', () => {
    const now = Date.now();
    const ago = (minutes: number): string => new Date(now - minutes * 60_000).toISOString();
    expect(wants(device(), row({ importance: 'warning' }), now)).toBe(true);
    expect(wants(device({ level: 'critical' }), row({ importance: 'warning' }), now)).toBe(false);
    expect(wants(device({ level: 'critical' }), row({ importance: 'critical' }), now)).toBe(true);
    expect(wants(device(), row({ importance: 'info' }), now)).toBe(false);
    expect(wants(device(), row({ importance: null }), now)).toBe(false);
    expect(wants(device(), row({ handledAt: ago(1) }), now)).toBe(false);
    // A code answers to the codes switch alone, whatever the level setting.
    const code = row({ importance: 'warning', verificationCode: '482913', mailDate: ago(2) });
    expect(wants(device({ level: 'critical' }), code, now)).toBe(true);
    expect(wants(device({ codes: false }), code, now)).toBe(false);
    // Filed more than fifteen minutes ago: too late to type in, whenever it was sent.
    expect(wants(device(), row({ verificationCode: '482913', createdAt: ago(16) }), now)).toBe(false);
    // A sender whose clock runs twenty minutes slow, or fast, still gets its code through.
    expect(wants(device(), row({ verificationCode: '482913', mailDate: ago(20) }), now)).toBe(true);
    expect(wants(device(), row({ verificationCode: '482913', mailDate: ago(-20) }), now)).toBe(true);
    // Sent an hour and a half before it was fetched: this is catching up, not arriving.
    expect(wants(device(), row({ verificationCode: '482913', mailDate: ago(90) }), now)).toBe(false);
    // Other mail has a day on both clocks, and a future date does not make old mail new.
    expect(wants(device(), row({ mailDate: ago(23 * 60) }), now)).toBe(true);
    expect(wants(device(), row({ mailDate: ago(30 * 60) }), now)).toBe(false);
    expect(wants(device(), row({ mailDate: ago(-600), createdAt: ago(25 * 60) }), now)).toBe(false);
    // A verification email whose code could not be read is still a code to the switch.
    const unread = row({ summary: '收到验证码邮件，但未能自动提取验证码。', mailDate: ago(2) });
    expect(wants(device({ codes: false }), unread, now)).toBe(false);
    expect(wants(device(), unread, now)).toBe(true);
    // No date on the mail: the time it was filed stands in.
    expect(wants(device(), row({ mailDate: null, createdAt: ago(25 * 60) }), now)).toBe(false);
    expect(wants(device(), row({ mailDate: null, createdAt: ago(5) }), now)).toBe(true);
    // A health alert is news; it goes by its level like mail does.
    expect(wants(device(), row({ decidedBy: 'health', importance: 'warning' }), now)).toBe(true);
  });

  it('caps a catch-up at four and says how many more there are', async () => {
    const w = world();
    w.started();
    w.subscribe('phone');
    w.subscribe('zh-phone', { lang: 'zh-CN' });
    for (let n = 1; n <= 9; n += 1) w.file(`m${n}`, n === 9 ? 'critical' : 'warning');
    w.file('code', 'warning', { summary: '收到验证码邮件。', verificationCode: '12345678' });
    const dispatcher = w.dispatcher();
    expect(await pass(dispatcher)).toBe(10);
    const english = w.sent.filter((s) => s.endpoint === endpoint('phone'));
    expect(english).toHaveLength(5);
    // The code first, then the critical one, then the newest.
    expect(english.slice(0, 2).map((s) => s.notice.key)).toEqual(['code', 'm9']);
    expect(english[0]!.notice.title).toBe('1234 5678');
    expect(english[4]!.notice).toMatchObject({ kind: 'more', body: '6 more messages need you', url: '/', tag: 'more' });
    const chinese = w.sent.filter((s) => s.endpoint === endpoint('zh-phone'));
    expect(chinese[4]!.notice.body).toBe('还有 6 封邮件待你处理');
    expect(chinese[1]!.notice.title).toBe('紧急 · Sender');
    dispatcher.stop();
  });

  it('carries the length of the queue for the badge', async () => {
    const w = world();
    w.started();
    w.subscribe('phone');
    w.file('a', 'critical');
    w.file('b', 'warning');
    w.file('quiet', 'info');
    const dispatcher = w.dispatcher();
    await pass(dispatcher);
    expect(w.sent.map((s) => s.notice.badge)).toEqual([2, 2]);
    dispatcher.stop();
  });

  it('sends nothing, and still moves on, when nobody is subscribed', async () => {
    const w = world();
    w.started();
    w.file('unseen', 'critical');
    const dispatcher = w.dispatcher();
    expect(await pass(dispatcher)).toBe(0);
    // Subscribing afterwards does not bring it back.
    w.subscribe('late');
    expect(await pass(dispatcher)).toBe(0);
    expect(w.sent).toEqual([]);
    dispatcher.stop();
  });

  it('waits for a row that is filed but not judged yet', async () => {
    const w = world();
    w.started();
    w.subscribe('phone');
    w.writer.markSeen('pending', 'me@qq.com', 'pending');
    const dispatcher = w.dispatcher();
    expect(await pass(dispatcher)).toBe(0);
    w.writer.recordOutcome('pending', 'critical', true, { messageId: '<pending@x>', senderName: 'S', mailDate: new Date().toISOString() });
    expect(await pass(dispatcher)).toBe(1);
    dispatcher.stop();
  });
});

describe('a verdict that changes later', () => {
  it('tells a device about mail that was quiet when filed and matters once it is judged properly', async () => {
    const w = world();
    w.started();
    w.subscribe('phone');
    w.subscribe('strict', { level: 'critical' });
    // The model was down: the keyword fallback filed these quietly, and the cursor moved past them.
    w.file('outage', 'info', { decidedBy: 'fallback' });
    w.file('raised', 'warning', { decidedBy: 'fallback' });
    const dispatcher = w.dispatcher();
    expect(await pass(dispatcher)).toBe(1);
    expect(w.sent.map((s) => [s.endpoint, s.notice.key])).toEqual([[endpoint('phone'), 'raised']]);
    w.sent.length = 0;

    // The model is back and judges them again. Their place in the order is behind the cursor.
    w.writer.recordOutcome('outage', 'critical', true, { messageId: '<outage@x>', senderName: 'Bank', summary: 'Card blocked', decidedBy: 'llm', mailDate: new Date().toISOString() });
    w.writer.recordOutcome('raised', 'critical', true, { messageId: '<raised@x>', senderName: 'Bank', summary: 'Now urgent', decidedBy: 'llm', mailDate: new Date().toISOString() });
    await pass(dispatcher);
    const told = (name: string): Array<string | undefined> => w.sent.filter((s) => s.endpoint === endpoint(name)).map((s) => s.notice.key).sort();
    expect(told('phone')).toEqual(['outage', 'raised']);
    expect(told('strict')).toEqual(['outage', 'raised']);
    // Once: the list was taken, and the next pass has nothing to say.
    w.sent.length = 0;
    w.writer.setMeta('unrelated', String(Date.now()));
    expect(await pass(dispatcher)).toBe(0);
    dispatcher.stop();
  });

  it('says nothing about a second verdict that changes neither the level nor whether it was pushed', async () => {
    const w = world();
    w.started();
    w.subscribe('phone');
    w.file('same', 'warning');
    const dispatcher = w.dispatcher();
    expect(await pass(dispatcher)).toBe(1);
    w.sent.length = 0;
    w.writer.recordOutcome('same', 'warning', true, { messageId: '<same@x>', senderName: 'S', summary: 'reworded', mailDate: new Date().toISOString() });
    expect(await pass(dispatcher)).toBe(0);
    dispatcher.stop();
  });

  it('does not replay verdicts that changed before notifications were first turned on', async () => {
    const w = world();
    w.file('early', 'info');
    w.writer.recordOutcome('early', 'critical', true, { messageId: '<early@x>', senderName: 'S', mailDate: new Date().toISOString() });
    w.subscribe('phone');
    const dispatcher = w.dispatcher();
    expect(await pass(dispatcher)).toBe(0);
    w.writer.setMeta('unrelated', String(Date.now()));
    expect(await pass(dispatcher)).toBe(0);
    expect(w.sent).toEqual([]);
    dispatcher.stop();
  });
});

describe('a backlog larger than one pass takes', () => {
  it('keeps going on its own until the newest mail is reached', async () => {
    const w = world();
    w.started();
    w.subscribe('phone');
    // More than four batches of fifty quiet rows, and the one that matters last.
    for (let n = 0; n < 230; n += 1) w.file(`quiet-${String(n).padStart(3, '0')}`, 'info');
    await sleep(3);
    w.file('urgent', 'critical');
    const dispatcher = w.dispatcher();
    expect(await pass(dispatcher)).toBe(0);
    // Nobody else commits in between: the dispatcher has to come back by itself.
    expect(await pass(dispatcher)).toBe(1);
    expect(w.sent.map((s) => s.notice.key)).toEqual(['urgent']);
    dispatcher.stop();
  });
});

describe('a dry run', () => {
  it('tells nobody, and leaves nothing behind to announce afterwards', async () => {
    const w = world();
    w.started();
    w.subscribe('phone');
    process.env.DRY_RUN = 'true';
    w.file('during', 'critical');
    const dispatcher = w.dispatcher();
    expect(await pass(dispatcher)).toBe(0);
    expect(w.sent).toEqual([]);
    delete process.env.DRY_RUN;
    w.writer.setMeta('unrelated', String(Date.now()));
    expect(await pass(dispatcher)).toBe(0);
    w.file('after', 'critical');
    expect(await pass(dispatcher)).toBe(1);
    expect(w.sent.map((s) => s.notice.key)).toEqual(['after']);
    dispatcher.stop();
  });
});

describe('two processes serving the view', () => {
  it('send each row once between them', async () => {
    const w = world();
    w.started();
    w.subscribe('phone');
    const one = w.dispatcher();
    const two = w.dispatcher();
    // Both have looked once, so both now wait on the data version.
    await Promise.all([one.tick(), two.tick()]);
    for (let n = 1; n <= 3; n += 1) w.file(`m${n}`, 'critical');
    await sleep(2);
    const counts = await Promise.all([one.tick(), two.tick()]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(3);
    expect(w.sent.map((s) => String(s.notice.key)).sort()).toEqual(['m1', 'm2', 'm3']);
    w.file('m4', 'critical');
    await sleep(2);
    await Promise.all([two.tick(), one.tick()]);
    expect(w.sent.map((s) => String(s.notice.key)).sort()).toEqual(['m1', 'm2', 'm3', 'm4']);
    one.stop();
    two.stop();
  });

  it('share one identity towards push services', async () => {
    const w = world();
    const other = new StateStore(w.path);
    const first = vapidKeys(w.writer);
    expect(vapidKeys(other)).toEqual(first);
    expect(vapidKeys(w.writer)).toEqual(first);
    expect(Buffer.from(first.publicKey, 'base64url')).toHaveLength(65);
    expect(Buffer.from(first.privateKey, 'base64url')).toHaveLength(32);
    // The dispatcher signs with that same pair.
    w.started();
    w.subscribe('phone');
    w.file('m', 'critical');
    const dispatcher = w.dispatcher();
    await pass(dispatcher);
    expect(w.sent[0]!.publicKey).toBe(first.publicKey);
    dispatcher.stop();
    // A value nothing could have subscribed against is replaced, once.
    w.writer.setMeta('web_push_vapid', '{"publicKey":"short"}');
    const replaced = vapidKeys(w.writer);
    expect(replaced).not.toEqual(first);
    expect(vapidKeys(other)).toEqual(replaced);
    other.close();
  });
});

describe('rows filed in the same instant', () => {
  it('leaves the current millisecond for the next pass, and comes back for it unprompted', async () => {
    // Rows are ordered by millisecond and then by key. Claiming a millisecond
    // the poller is still filing into could strand a later row with a smaller key.
    const w = world();
    w.started();
    w.subscribe('phone');
    w.file('zz-first', 'critical');
    w.file('aa-second', 'critical');
    const soon = new Date(Date.now() + 40).toISOString();
    const raw = (w.writer as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db;
    raw.prepare('UPDATE seen SET created_at = ?').run(soon);
    const dispatcher = w.dispatcher();
    expect(await dispatcher.tick()).toBe(0);
    expect(w.sent).toEqual([]);
    // Nothing else commits; the dispatcher still looks again.
    await sleep(60);
    expect(await dispatcher.tick()).toBe(2);
    expect(w.sent.map((s) => String(s.notice.key)).sort()).toEqual(['aa-second', 'zz-first']);
    dispatcher.stop();
  });
});

describe('a stored identity', () => {
  it('keeps a key whose scalar was stored without its leading zero byte', () => {
    // About one generated key in 250 is 31 bytes as node returns it. Treating
    // that as damage would mint a new identity and orphan every subscription.
    const w = world();
    const full = vapidKeys(w.writer);
    // The shape such a key has on disk: 31 bytes, the zero byte left off.
    const short = Buffer.from(full.privateKey, 'base64url').subarray(1);
    const stored = { publicKey: full.publicKey, privateKey: short.toString('base64url') };
    w.writer.setMeta('web_push_vapid', JSON.stringify(stored));
    const read = vapidKeys(w.writer);
    expect(read.publicKey).toBe(full.publicKey);
    expect(Buffer.from(read.privateKey, 'base64url').equals(Buffer.concat([Buffer.from([0]), short]))).toBe(true);
    // Read as it is, not rewritten: the stored value stays the one browsers subscribed against.
    expect(JSON.parse(w.writer.getMeta('web_push_vapid') ?? '{}')).toEqual(stored);
    expect(vapidKeys(w.writer)).toEqual(read);
  });
});

describe('subscriptions that stop working', () => {
  it('forgets one its push service says is gone', async () => {
    const w = world();
    w.started();
    const gone = w.subscribe('uninstalled');
    const fine = w.subscribe('fine');
    w.outcomes.set(gone, 'gone');
    w.file('a', 'critical');
    w.file('b', 'critical');
    const dispatcher = w.dispatcher();
    expect(await pass(dispatcher)).toBe(2);
    expect(w.writer.listPushSubscriptions().map((s) => s.endpoint)).toEqual([fine]);
    // It was tried once, not once per message.
    expect(w.sent.filter((s) => s.endpoint === gone)).toHaveLength(1);
    expect(w.writer.getPushSubscription(fine)).toMatchObject({ failures: 0, lastOkAt: expect.any(String) });
    dispatcher.stop();
  });

  it('forgets one that failed twenty times in a row, and not before', async () => {
    const w = world();
    w.started();
    const flaky = w.subscribe('flaky');
    w.outcomes.set(flaky, 'failed');
    const dispatcher = w.dispatcher();
    for (let n = 1; n <= 19; n += 1) {
      w.file(`m${n}`, 'critical');
      w.file(`extra${n}`, 'critical');
      expect(await pass(dispatcher)).toBe(0);
    }
    // A pass counts as one failure however many messages it held.
    expect(w.writer.getPushSubscription(flaky)).toMatchObject({ failures: 19 });
    w.outcomes.set(flaky, 'sent');
    w.file('recovered', 'critical');
    expect(await pass(dispatcher)).toBe(1);
    expect(w.writer.getPushSubscription(flaky)).toMatchObject({ failures: 0 });

    w.outcomes.set(flaky, 'failed');
    for (let n = 1; n <= 20; n += 1) {
      w.file(`again${n}`, 'critical');
      await pass(dispatcher);
    }
    expect(w.writer.getPushSubscription(flaky)).toBeUndefined();
    dispatcher.stop();
  });
});

describe('the words of a notification', () => {
  it('makes a code its own title and names the sender under it', () => {
    const code = row({ verificationCode: '482913', senderName: 'GitHub', summary: '收到验证码邮件。' });
    expect(noticeFor(code, 'en')).toMatchObject({ kind: 'code', title: '482 913', body: 'GitHub · verification code' });
    expect(noticeFor(code, 'zh-CN')).toMatchObject({ title: '482 913', body: 'GitHub · 验证码' });
    expect(noticeFor(row({ verificationCode: 'AB12-CD', senderName: '' , sender: 'no-reply@x.com' }), 'en'))
      .toMatchObject({ title: 'AB12-CD', body: 'no-reply@x.com · verification code' });
    // The code is in the mail but was not read out of it: say so, and lead to it.
    expect(noticeFor(row({ summary: '收到验证码邮件，但未能自动提取验证码。', senderName: 'Bank' }), 'en'))
      .toMatchObject({ kind: 'code', title: 'Bank', body: 'Verification email · open it for the code', url: '/?focus=code' });
  });

  it('leads other mail with the sender and says what the summary says', () => {
    const mail = noticeFor(row(), 'en');
    expect(mail).toMatchObject({
      kind: 'mail', title: 'Billing', body: 'Invoice 42 is due on the 30th.',
      url: '/#m=me%40qq.com%7C%3Cone%40x%3E', key: 'me@qq.com|<one@x>', tag: 'me@qq.com|<one@x>',
    });
    expect(noticeFor(row({ importance: 'critical' }), 'en').title).toBe('Critical · Billing');
    expect(noticeFor(row({ importance: 'critical' }), 'zh-CN').title).toBe('紧急 · Billing');
    expect(noticeFor(row({ summary: null }), 'en').body).toBe('Invoice 42');
    expect(noticeFor(row({ senderName: null, sender: null }), 'zh-CN').title).toBe('未知发件人');
    const long = noticeFor(row({ summary: 'x'.repeat(500) }), 'en');
    expect(Array.from(long.body)).toHaveLength(180);
    expect(long.body.endsWith('…')).toBe(true);
    // A key too long for a tag is hashed, and stays the same for the same message.
    const key = `me@qq.com|<${'a'.repeat(200)}@x>`;
    const tagged = noticeFor(row({ dedupKey: key }), 'en');
    expect(tagged.tag).toMatch(/^m-[0-9a-f]{32}$/);
    expect(noticeFor(row({ dedupKey: key }), 'zh-CN').tag).toBe(tagged.tag);
  });

  it('stays inside one push message, whatever the text is made of', async () => {
    const bytes = (notice: PushNotice): number => Buffer.byteLength(JSON.stringify(notice), 'utf8');
    // Three bytes a character, and a message id that is a kilobyte before it is encoded.
    const cjk = row({
      summary: '域名即将到期，请尽快续费以免停止解析。'.repeat(40), senderName: '注册商'.repeat(40),
      dedupKey: `me@qq.com|<${'长'.repeat(400)}@x>`,
    });
    const fitted = fitNotice({ ...noticeFor(cjk, 'zh-CN'), badge: 12 });
    expect(bytes(fitted)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(fitted.title.length).toBeGreaterThan(0);
    expect(fitted.url.startsWith('/')).toBe(true);
    // An ordinary notice is left exactly as it was.
    const ordinary = { ...noticeFor(row(), 'en'), badge: 1 };
    expect(fitNotice(ordinary)).toEqual(ordinary);

    // And through the dispatcher: what reaches the push service fits.
    const w = world();
    w.started();
    w.subscribe('phone', { lang: 'zh-CN' });
    w.file(`me@qq.com|<${'长'.repeat(400)}@x>`, 'critical', { summary: '续费提醒。'.repeat(200), senderName: '注册商' });
    const dispatcher = w.dispatcher();
    expect(await pass(dispatcher)).toBe(1);
    expect(bytes(w.sent[0]!.notice)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    dispatcher.stop();
  });
});

describe('the contact given to a push service', () => {
  it('uses the address the page was served from when that is a public https name', () => {
    expect(pushSubject('https://mail.example.org')).toBe('https://mail.example.org');
    expect(pushSubject('https://mail.example.org:8443/path')).toBe('https://mail.example.org:8443');
  });

  it('falls back to a well-formed placeholder for loopback, LAN and plain http', () => {
    for (const origin of [
      undefined, null, '', 'http://mail.example.org', 'https://localhost', 'https://localhost:8410',
      'https://127.0.0.1', 'https://192.168.1.20:8410', 'https://[::1]:8410', 'https://nas.local', 'https://box',
      'not an origin',
    ]) expect(pushSubject(origin), String(origin)).toBe('mailto:mailsift@example.org');
  });

  it('lets the deployment name its own', () => {
    process.env.WEB_PUSH_SUBJECT = 'mailto:ops@example.org';
    expect(pushSubject('https://mail.example.org')).toBe('mailto:ops@example.org');
    process.env.WEB_PUSH_SUBJECT = 'ops@example.org';
    expect(pushSubject()).toBe('mailto:ops@example.org');
    process.env.WEB_PUSH_SUBJECT = 'https://status.example.org/contact';
    expect(pushSubject()).toBe('https://status.example.org/contact');
    // Not a contact a push service accepts: ignored rather than sent.
    process.env.WEB_PUSH_SUBJECT = 'ops';
    expect(pushSubject('https://mail.example.org')).toBe('https://mail.example.org');
  });

  it('reaches the push service with each message', async () => {
    const w = world();
    w.started();
    w.subscribe('phone', { origin: 'https://mail.example.org' });
    w.subscribe('lan', { origin: 'http://192.168.1.20:8410' });
    w.file('m', 'critical');
    const dispatcher = w.dispatcher();
    await pass(dispatcher);
    expect(w.sent.find((s) => s.endpoint === endpoint('phone'))?.subject).toBe('https://mail.example.org');
    expect(w.sent.find((s) => s.endpoint === endpoint('lan'))?.subject).toBe('mailto:mailsift@example.org');
    dispatcher.stop();
  });
});

describe('the test notification', () => {
  it('says only that notifications work, in the device\'s language', async () => {
    const w = world();
    const phone = w.subscribe('phone', { lang: 'zh-CN' });
    w.file('queued', 'critical');
    const calls: Sent[] = [];
    const send = (async (target, payload, keys, options) => {
      calls.push({ endpoint: target.endpoint, notice: payload as PushNotice, ttl: options.ttl, urgency: options.urgency, subject: options.subject, publicKey: keys.publicKey });
      return 'sent';
    }) as typeof sendPush;
    expect(await sendTestPush(w.writer, phone, send)).toBe('sent');
    expect(calls[0]!.notice).toMatchObject({ kind: 'test', title: 'mailsift', body: '这台设备的通知已开启。', url: '/', badge: 1 });
    expect(w.writer.getPushSubscription(phone)?.lastOkAt).toEqual(expect.any(String));
  });

  it('reports a device that is not subscribed, and forgets one that is gone', async () => {
    const w = world();
    const never = (async () => { throw new Error('must not be called'); }) as unknown as typeof sendPush;
    expect(await sendTestPush(w.writer, endpoint('nobody'), never)).toBe('gone');
    const phone = w.subscribe('phone');
    expect(await sendTestPush(w.writer, phone, (async () => 'failed') as unknown as typeof sendPush)).toBe('failed');
    expect(w.writer.getPushSubscription(phone)).toMatchObject({ failures: 1 });
    expect(await sendTestPush(w.writer, phone, (async () => 'gone') as unknown as typeof sendPush)).toBe('gone');
    expect(w.writer.getPushSubscription(phone)).toBeUndefined();
  });
});

describe('the watcher', () => {
  it('runs on a timer that sends what arrives, and stops when told', async () => {
    const w = world();
    w.started();
    w.subscribe('phone');
    const dispatcher = new PushDispatcher({
      openStore: () => new StateStore(w.path),
      send: (async (target, payload) => {
        w.sent.push({ endpoint: target.endpoint, notice: payload as PushNotice, ttl: 0, urgency: undefined, subject: '', publicKey: '' });
        return 'sent';
      }) as typeof sendPush,
      intervalMs: 10,
    });
    dispatcher.start();
    dispatcher.start();
    w.file('live', 'critical');
    for (let waited = 0; waited < 100 && w.sent.length === 0; waited += 1) await sleep(10);
    expect(w.sent.map((s) => s.notice.key)).toEqual(['live']);
    dispatcher.stop();
    w.file('after-stop', 'critical');
    await sleep(50);
    expect(w.sent).toHaveLength(1);
  });

  it('survives a pass that throws and tries again with a new handle', async () => {
    const w = world();
    w.started();
    w.subscribe('phone');
    let opened = 0;
    const dispatcher = new PushDispatcher({
      openStore: () => {
        opened += 1;
        const store = new StateStore(w.path);
        if (opened === 1) store.rowsAfter = () => { throw new Error('disk went away'); };
        return store;
      },
      send: (async () => 'sent') as unknown as typeof sendPush,
    });
    expect(await pass(dispatcher)).toBe(0);
    w.file('m', 'critical');
    expect(await pass(dispatcher)).toBe(1);
    expect(opened).toBe(2);
    dispatcher.stop();
  });
});
