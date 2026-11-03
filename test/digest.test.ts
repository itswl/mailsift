import { describe, expect, it } from 'vitest';
import './setup.js';
import { makeMessage, makeResult, RecordingSink } from './helpers.js';
import {
  DIGEST_MAX_CHARS, digestHour, nextDigestAt, renderDigest, sendDigest, shouldSend, toDigestItem, type DigestItem,
} from '../src/services/digest.js';
import { buildCard } from '../src/services/feishu.js';
import { buildMailSignalEvent } from '../src/services/signal.js';
import { buildWebhookPayload } from '../src/services/sink.js';
import { StateStore } from '../src/services/state.js';

function items(spam: number, inbox: number): DigestItem[] {
  const out: DigestItem[] = [];
  for (let i = 0; i < spam; i += 1) {
    out.push(toDigestItem(makeMessage({ messageId: `<s${i}@x>`, inSpam: true, folder: 'Junk', subject: `垃圾箱${i}` }),
      makeResult({ importance: 'info', category: '营销', summary: `营销内容 ${i}` })));
  }
  for (let i = 0; i < inbox; i += 1) {
    out.push(toDigestItem(makeMessage({ messageId: `<i${i}@x>`, subject: `收件箱${i}` }),
      makeResult({ importance: 'info', category: '通知', summary: `通知内容 ${i}` })));
  }
  return out;
}

describe('rendering', () => {
  it('puts spam first because it is a primary reason for the digest', () => {
    const body = renderDigest(items(1, 1));
    expect(body.indexOf('⚠️ Spam')).toBeLessThan(body.indexOf('**通知 ('));
  });

  it('counts both sources', () => {
    expect(renderDigest(items(2, 3))).toContain('**5 messages**');
    expect(renderDigest(items(2, 3))).toContain('inbox 3 · spam 2');
  });

  it('shows fallback text for an empty queue', () => {
    expect(renderDigest([])).toContain('No messages require review');
  });

  it('groups by category and sorts larger groups first', () => {
    const rows = [
      toDigestItem(makeMessage({ messageId: '<a@x>', subject: '电费账单' }), makeResult({ category: '账单缴费', summary: '账单 1' })),
      toDigestItem(makeMessage({ messageId: '<b@x>', subject: '水费账单' }), makeResult({ category: '账单缴费', summary: '账单 2' })),
      toDigestItem(makeMessage({ messageId: '<c@x>', subject: '包裹通知' }), makeResult({ category: '快递物流', summary: '包裹待取' })),
    ];
    const body = renderDigest(rows);
    expect(body).toContain('**账单缴费 (2)**');
    expect(body.indexOf('账单缴费 (2)')).toBeLessThan(body.indexOf('快递物流 (1)'));
  });

  it('shows the summary instead of the subject on each line', () => {
    // Subjects often say very little; the summary is what the user needs.
    const row = toDigestItem(
      makeMessage({ subject: 'Re: FW: 通知', fromName: '张三' }),
      makeResult({ summary: '客户询问报价单何时发出，要求本周内回复', deadline: '本周内' }),
    );
    const body = renderDigest([row]);
    expect(body).toContain('客户询问报价单何时发出');
    expect(body).toContain('张三');
    expect(body).toContain('⏰本周内');
  });

  it('marks action-required messages and puts them first within a category', () => {
    const body = renderDigest([
      toDigestItem(makeMessage({ fromName: 'FYI', subject: '周报' }), makeResult({ actionRequired: false, summary: '仅供了解' })),
      toDigestItem(makeMessage({ fromName: 'Action', subject: '待办' }), makeResult({ actionRequired: true, summary: '需要今天处理' })),
    ]);
    expect(body).toContain('⚠️ **Action**');
    expect(body.indexOf('需要今天处理')).toBeLessThan(body.indexOf('仅供了解'));
  });

  it('collapses messages that share an IMAP reply thread', () => {
    const body = renderDigest([
      toDigestItem(makeMessage({ messageId: '<root@x>', threadKey: 'me@qq.com|<root@x>' }), makeResult({ summary: '原始问题' })),
      toDigestItem(makeMessage({ messageId: '<reply@x>', threadKey: 'me@qq.com|<root@x>', date: '2026-09-17T10:00:00.000Z' }), makeResult({ summary: '最新回复' })),
    ]);
    expect(body).toContain('2 messages');
    expect(body).toContain('最新回复');
    expect(body).not.toContain('原始问题');
  });

  it('escapes Markdown control characters from mail data', () => {
    const row = toDigestItem(
      makeMessage({ fromName: '*sender* [external]' }),
      makeResult({ category: 'billing_[urgent]', summary: 'Pay `now` *please*', deadline: '[today]' }),
    );
    const body = renderDigest([row]);
    expect(body).toContain('**\\*sender\\* \\[external\\]**');
    expect(body).toContain('billing\\_\\[urgent\\]');
    expect(body).toContain('Pay \\`now\\` \\*please\\*');
    expect(body).toContain('⏰\\[today\\]');
  });

  it('folds repeats of one recurring event into a single counted entry', () => {
    // A failing pipeline opens a fresh thread per run, so thread collapsing
    // never joined them and a day of failures arrived as dozens of identical lines.
    const runs = ['a1b2c3d', 'e4f5a6b', '7c8d9e0'].map((sha, i) =>
      toDigestItem(
        makeMessage({ messageId: `<r${i}@x>`, fromAddr: 'notifications@github.com', subject: `[owner/repo] Run failed: ci - main (${sha})`, date: `2026-09-28T0${i}:00:00.000Z` }),
        makeResult({ importance: 'info', category: 'Work', actionRequired: false, summary: `run ${i} failed` }),
      ));
    const body = renderDigest(runs);
    expect(body).toContain('3 messages');
    expect(body).toContain('(3 messages)');
    expect(body).toContain('1 entries');
    // The newest wording represents the group.
    expect(body).toContain('run 2 failed');
  });

  it('never folds a quarantined copy into an inbox entry', () => {
    // Merging across the spam boundary made the entry inherit inSpam:false and
    // the spam section stopped rendering, which is the one thing this digest
    // exists to surface.
    const body = renderDigest([
      toDigestItem(makeMessage({ messageId: '<i@x>', subject: '同一主题', date: '2026-09-28T02:00:00.000Z' }), makeResult({ category: 'Work' })),
      toDigestItem(makeMessage({ messageId: '<s@x>', subject: '同一主题', inSpam: true, folder: 'Junk', date: '2026-09-28T01:00:00.000Z' }), makeResult({ category: 'Work' })),
    ]);
    expect(body).toContain('2 entries');
    expect(body).toContain('spam 1');
    expect(body).toContain('Spam (');
  });

  it('counts the spam heading in messages, like every other count on the card', () => {
    const repeats = ['f9e809f', 'a3baeb4', 'c0ee030', '644e3ab', '89888f2'].map((sha, i) =>
      toDigestItem(
        makeMessage({ messageId: `<z${i}@x>`, inSpam: true, folder: 'Junk', fromAddr: 'bot@example.com', subject: `[r] Run failed: ci - main (${sha})`, date: `2026-09-28T0${i}:00:00.000Z` }),
        makeResult({ category: 'Work' }),
      ));
    const body = renderDigest(repeats);
    expect(body).toContain('**5 messages**');
    expect(body).toContain('Spam (5;');
  });

  it('never prints a category heading with nothing under it', () => {
    // A heading that fits while its first entry does not announced a count and
    // then showed no entries, and undercounted the omitted categories too.
    const many = Array.from({ length: 40 }, (_, i) =>
      toDigestItem(makeMessage({ messageId: `<c${i}@x>`, subject: `subj ${i}` }),
        makeResult({ category: `C${i % 8}`, summary: 'x'.repeat(88) })));
    for (const budget of [780, 820, 900, 1100, 1500]) {
      const rendered = renderDigest(many, budget).split('\n');
      const orphan = rendered.findIndex((l, n) => /^\*\*C\d+ \(\d+\)\*\*$/.test(l) && !(rendered[n + 1] ?? '').startsWith('- '));
      expect(orphan).toBe(-1);
    }
  });

  it('never merges on a plain number, only on something hash-shaped', () => {
    // Three invoices or two years of one report share everything but a number.
    // Merging them would hide a payment, while failing to merge costs a line,
    // so the suffix has to look like a hash before it is treated as volatile.
    const numbered = (n: string, i: number) =>
      toDigestItem(makeMessage({ messageId: `<p${i}@x>`, subject: `账单 (${n})` }), makeResult({ category: 'Finance', summary: `账单 ${n}` }));
    expect(renderDigest([numbered('1001', 1), numbered('1002', 2), numbered('1003', 3)])).toContain('3 entries');
    expect(renderDigest([numbered('2024', 4), numbered('2025', 5)])).toContain('2 entries');
    // Six or more digits still read as a number, not as a commit.
    expect(renderDigest([numbered('100123', 6), numbered('100124', 7)])).toContain('2 entries');

    const hashed = (sha: string, i: number) =>
      toDigestItem(makeMessage({ messageId: `<h${i}@x>`, fromAddr: 'notifications@github.com', subject: `[owner/repo] Run failed: ci - main (${sha})` }), makeResult({ category: 'Work', summary: `run ${i}` }));
    expect(renderDigest([hashed('f9e809f', 1), hashed('a3baeb4', 2), hashed('644e3ab', 3)])).toContain('1 entries');
  });

  it('gives one category the same count in the summary line and its heading', () => {
    // Counting entries in one place and messages in the other put two different
    // numbers for the same category in the same card.
    const runs = ['f9e809f', 'a3baeb4', 'c0ee030'].map((sha, i) =>
      toDigestItem(makeMessage({ messageId: `<c${i}@x>`, fromAddr: 'notifications@github.com', subject: `[owner/repo] Run failed: ci - main (${sha})` }), makeResult({ category: 'Work', summary: `run ${i}` })));
    const body = renderDigest(runs);
    expect(body.split('\n')[1]).toContain('Work 3');
    expect(body).toContain('**Work (3)**');
  });

  it('holds its budget down to the documented floor', () => {
    // The heading and the closing notice are not optional, so a request below
    // the floor is treated as the floor rather than silently overrun.
    for (const budget of [4000, 900, 400, 50, 0]) {
      expect(renderDigest(items(20, 200), budget).length).toBeLessThanOrEqual(Math.max(budget, 400));
    }
  });

  it('keeps different workflows and different senders apart', () => {
    const rows = [
      toDigestItem(makeMessage({ messageId: '<x1@x>', fromAddr: 'notifications@github.com', subject: '[owner/repo] Run failed: ci - main (aaaaaaa)' }), makeResult({ category: 'Work', summary: 'ci failed' })),
      toDigestItem(makeMessage({ messageId: '<x2@x>', fromAddr: 'notifications@github.com', subject: '[owner/repo] Run failed: release - main (bbbbbbb)' }), makeResult({ category: 'Work', summary: 'release failed' })),
      toDigestItem(makeMessage({ messageId: '<x3@x>', fromAddr: 'ci@elsewhere.com', subject: '[owner/repo] Run failed: ci - main (ccccccc)' }), makeResult({ category: 'Work', summary: 'other sender' })),
    ];
    expect(renderDigest(rows)).toContain('3 entries');
  });

  it('lets the occurrence that needs action speak for the group', () => {
    // Otherwise a later harmless repeat would bury an earlier actionable one.
    const rows = [
      toDigestItem(makeMessage({ messageId: '<n1@x>', subject: '构建失败 (a1b2c3d)', date: '2026-09-28T01:00:00.000Z' }), makeResult({ importance: 'critical', actionRequired: true, summary: '需要今天处理' })),
      toDigestItem(makeMessage({ messageId: '<n2@x>', subject: '构建失败 (e4f5a6b)', date: '2026-09-28T09:00:00.000Z' }), makeResult({ importance: 'info', actionRequired: false, summary: '仅供了解' })),
    ];
    const body = renderDigest(rows);
    expect(body).toContain('1 entries');
    expect(body).toContain('需要今天处理');
    expect(body).toContain('⚠️');
  });

  it('marks the cut inside a section, as well as in the closing line', () => {
    // A reader scanning one category could not otherwise tell it was truncated.
    const body = renderDigest(items(0, 60));
    expect(body).toMatch(/- …\d+ more in this category/);
    expect(body).toMatch(/_\d+ more messages not shown/);
  });

  it('says how many messages it left out', () => {
    const body = renderDigest(items(0, 60));
    expect(body).toMatch(/_\d+ more messages not shown; use MCP list_digest or list_mail to see them_/);
  });

  it('stays inside the character budget however much is queued', () => {
    // The card slices at a fixed width, so a render that overruns loses its own
    // tail: the notice saying content was dropped is the last thing written and
    // so the first thing lost, and a truncated digest then reads as a complete one.
    for (const count of [60, 200, 600]) {
      expect(renderDigest(items(0, count)).length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    }
  });

  it('keeps the closing notice even when the budget is far too small', () => {
    const body = renderDigest(items(0, 60), 400);
    expect(body.length).toBeLessThanOrEqual(400);
    expect(body).toContain('more messages not shown');
  });

  it('counts dropped messages, not dropped entries', () => {
    // One entry can stand for a dozen repeats, so counting entries would
    // understate what the reader is not seeing.
    const entryLines = (text: string): string[] =>
      text.split('\n').filter((l) => l.startsWith('- ') && !l.startsWith('- …'));
    const body = renderDigest(items(0, 60));
    const omitted = Number(/_(\d+) more messages not shown/.exec(body)?.[1]);
    expect(omitted + entryLines(body).length).toBe(60);

    const repeats = Array.from({ length: 40 }, (_, i) =>
      toDigestItem(
        makeMessage({ messageId: `<q${i}@x>`, fromAddr: 'bot@example.com', subject: `[repo] Run failed: ci - main (${String(i).padStart(7, '0')})` }),
        makeResult({ category: 'Work', summary: `run ${i}` }),
      ));
    const mixed = renderDigest([...items(0, 40), ...repeats]);
    const hidden = Number(/_(\d+) more messages not shown/.exec(mixed)?.[1] ?? 0);
    const visible = entryLines(mixed)
      .reduce((n, l) => n + Number(/\((\d+) messages\)/.exec(l)?.[1] ?? 1), 0);
    expect(visible + hidden).toBe(80);
  });

  it('marks a card that still had to be cut, rather than stopping mid-sentence', () => {
    const card = buildCard(
      makeMessage({ subject: 'digest', body: 'x'.repeat(9000), extra: { digest: true } }),
      makeResult({ importance: 'info' }),
    );
    const content = String(((card['card'] as { elements: Array<Record<string, unknown>> }).elements[0])!['content']);
    expect(content).toContain('truncated to fit the card');
  });

  it('gives a digest more card room than a single mail card', () => {
    // 3000 characters could not hold a day of mail; Feishu allows a 20 KB body.
    const card = buildCard(
      makeMessage({ subject: 'digest', body: 'y'.repeat(5000), extra: { digest: true } }),
      makeResult({ importance: 'info' }),
    );
    const content = String(((card['card'] as { elements: Array<Record<string, unknown>> }).elements[0])!['content']);
    expect(content.length).toBeGreaterThan(4000);
    expect(content).not.toContain('truncated');
  });
});

describe('send timing', () => {
  it('waits until the configured hour', () => {
    const state = new StateStore(':memory:');
    process.env.DIGEST_HOUR = '9';
    expect(shouldSend(state, new Date('2026-09-16T08:59:00'))).toBe(false);
    expect(shouldSend(state, new Date('2026-09-16T09:00:00'))).toBe(true);
  });

  it('sends at most once per day', () => {
    const state = new StateStore(':memory:');
    process.env.DIGEST_HOUR = '0';
    const at = new Date('2026-09-16T10:00:00');
    state.setMeta('digest_last_sent_date', at.toISOString().slice(0, 10));
    expect(shouldSend(state, at)).toBe(false);
  });

  it('can be disabled', () => {
    process.env.DIGEST_ENABLED = 'false';
    expect(shouldSend(new StateStore(':memory:'), new Date('2026-09-16T23:00:00'))).toBe(false);
  });

  it('treats an hour that is not a whole hour from 0 to 23 as the default, everywhere', () => {
    const state = new StateStore(':memory:');
    for (const raw of ['24', '8.5', 'nine']) {
      process.env.DIGEST_HOUR = raw;
      expect(digestHour()).toEqual({ hour: 9, invalid: raw });
      expect(shouldSend(state, new Date('2026-09-16T08:59:00'))).toBe(false);
      expect(shouldSend(state, new Date('2026-09-16T09:00:00'))).toBe(true);
      expect(nextDigestAt(state, new Date('2026-09-16T06:00:00'))?.getHours()).toBe(9);
    }
    process.env.DIGEST_HOUR = '0';
    expect(digestHour()).toEqual({ hour: 0 });
  });
});

/** Run fn with the process in another time zone; Node re-reads TZ when it is assigned. */
async function inZone<T>(zone: string, fn: () => Promise<T> | T): Promise<T> {
  const saved = process.env.TZ;
  process.env.TZ = zone;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}

/**
 * Poll every five minutes from one instant to another, queueing one entry
 * before each send so the delivered path does the bookkeeping. Returns the
 * instants a digest went out.
 */
async function polls(state: StateStore, from: string, to: string, sink = new RecordingSink()): Promise<string[]> {
  const sent: string[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 5 * 60_000) {
    const at = new Date(t);
    if (!shouldSend(state, at)) continue;
    state.queueDigest(`entry-${t}`, items(0, 1)[0]!);
    expect(await sendDigest(state, sink, at)).toBe(true);
    sent.push(at.toISOString());
  }
  return sent;
}

describe('the digest calendar', () => {
  it('goes out once a day at the hour when the hour falls before the UTC offset', async () => {
    // At 07:00 in UTC+8 the UTC date is still yesterday's. Counting the day in
    // UTC held the digest back to 08:00, and sent it twice on a first day.
    await inZone('Asia/Shanghai', async () => {
      process.env.DIGEST_HOUR = '7';
      const state = new StateStore(':memory:');
      const sink = new RecordingSink();
      expect(await polls(state, '2026-11-02T16:00:00Z', '2026-11-05T15:55:00Z', sink)).toEqual([
        '2026-11-02T23:00:00.000Z', '2026-11-03T23:00:00.000Z', '2026-11-04T23:00:00.000Z',
      ]);
      expect(state.getMeta('digest_last_sent_local_date')).toBe('2026-11-05 2026-11-04');
      expect(new Set(sink.pushed.map(([message]) => message.messageId)).size).toBe(3);
      expect(sink.pushed[1]![1].reason).toMatch(/^2026-11-04 daily digest/);
      expect(nextDigestAt(state, new Date('2026-11-05T01:00:00Z'))?.toISOString()).toBe('2026-11-05T23:00:00.000Z');
    });
  });

  it('goes out at the hour behind UTC too, where the old rule waited for the evening', async () => {
    await inZone('America/New_York', async () => {
      process.env.DIGEST_HOUR = '9';
      const state = new StateStore(':memory:');
      expect(await polls(state, '2026-11-02T05:00:00Z', '2026-11-05T04:55:00Z')).toEqual([
        '2026-11-02T14:00:00.000Z', '2026-11-03T14:00:00.000Z', '2026-11-04T14:00:00.000Z',
      ]);
    });
  });

  it('after an upgrade behind UTC, sends when the old rule would have, then at the hour', async () => {
    await inZone('America/New_York', async () => {
      process.env.DIGEST_HOUR = '9';
      const state = new StateStore(':memory:');
      // 0.1.97 sent at 20:00 on 2 November, when the UTC date became the 3rd.
      state.setMeta('digest_last_sent_date', '2026-11-03');
      const upgraded = '2026-11-03T13:00:00Z'; // 08:00 local
      // The page names the moment the next send will really happen.
      expect(nextDigestAt(state, new Date('2026-11-03T15:00:00Z'))?.toISOString()).toBe('2026-11-04T00:00:00.000Z');
      expect(await polls(state, upgraded, '2026-11-05T04:55:00Z')).toEqual([
        '2026-11-04T00:00:00.000Z', // 19:00 on the 3rd: the UTC date changed, as before
        '2026-11-04T14:00:00.000Z', // 09:00 on the 4th: the hour, from now on
      ]);
    });
  });

  it('after an upgrade ahead of UTC, sends when the old rule would have, then at the hour', async () => {
    await inZone('Asia/Shanghai', async () => {
      process.env.DIGEST_HOUR = '7';
      const state = new StateStore(':memory:');
      // 0.1.97 sent at 08:00 on 3 November, when the UTC date became the 3rd.
      state.setMeta('digest_last_sent_date', '2026-11-03');
      expect(nextDigestAt(state, new Date('2026-11-03T02:00:00Z'))?.toISOString()).toBe('2026-11-04T00:00:00.000Z');
      const sink = new RecordingSink();
      expect(await polls(state, '2026-11-03T02:00:00Z', '2026-11-05T15:55:00Z', sink)).toEqual([
        '2026-11-04T00:00:00.000Z', // 08:00 on the 4th
        '2026-11-04T23:00:00.000Z', // 07:00 on the 5th
      ]);
      // Two local days' digests that share a UTC date (the 4th) must not share an id.
      const [first, second] = sink.pushed.map(([message]) => message.messageId);
      expect(first).not.toBe(second);
    });
  });

  it('after an upgrade, names the next send at the hour when the hour comes after UTC midnight', async () => {
    await inZone('Asia/Shanghai', async () => {
      process.env.DIGEST_HOUR = '9';
      const state = new StateStore(':memory:');
      state.setMeta('digest_last_sent_date', '2026-11-03'); // 09:00 on the 3rd
      expect(nextDigestAt(state, new Date('2026-11-03T02:00:00Z'))?.toISOString()).toBe('2026-11-04T01:00:00.000Z');
    });
  });

  it('names tomorrow at the hour even on a day the hour did not exist', async () => {
    await inZone('Europe/London', async () => {
      process.env.DIGEST_HOUR = '1';
      const state = new StateStore(':memory:');
      // Clocks go forward at 01:00 on 28 March 2027: the first poll at or after 1 is at 02:00.
      expect(await polls(state, '2027-03-28T00:30:00Z', '2027-03-28T01:30:00Z')).toEqual(['2027-03-28T01:00:00.000Z']);
      expect(nextDigestAt(state, new Date('2027-03-28T10:00:00Z'))?.toISOString()).toBe('2027-03-29T00:00:00.000Z');
    });
  });

  it('does not trust the local record once an older release has sent since', async () => {
    await inZone('Asia/Shanghai', async () => {
      process.env.DIGEST_HOUR = '9';
      const state = new StateStore(':memory:');
      expect(await polls(state, '2026-11-01T00:30:00Z', '2026-11-01T01:30:00Z')).toEqual(['2026-11-01T01:00:00.000Z']);
      // Rolled back: the old release sent at 09:00 on the 2nd, 3rd and 4th,
      // writing only the UTC date.
      state.setMeta('digest_last_sent_date', '2026-11-04');
      expect(await polls(state, '2026-11-04T02:00:00Z', '2026-11-04T15:55:00Z')).toEqual([]);
    });
  });
});

describe('sending', () => {
  it('drains the queue and records the date', async () => {
    const state = new StateStore(':memory:');
    for (const item of items(2, 1)) state.queueDigest(item.subject, item);
    const sink = new RecordingSink();
    const at = new Date('2026-09-16T09:30:00');

    expect(await sendDigest(state, sink, at)).toBe(true);
    expect(state.digestPending()).toBe(0);
    expect(state.getMeta('digest_last_sent_date')).toBe(at.toISOString().slice(0, 10));
    expect(state.getMeta('digest_last_sent_local_date')).toBe(`2026-09-16 ${at.toISOString().slice(0, 10)}`);

    const [message, result] = sink.pushed[0]!;
    expect(result.importance).toBe('info');
    expect(message.subject).toContain('spam 2');
  });

  it('records the date for an empty queue to avoid repeated checks', async () => {
    const state = new StateStore(':memory:');
    const sink = new RecordingSink();
    const at = new Date('2026-09-16T09:00:00');
    expect(await sendDigest(state, sink, at)).toBe(false);
    expect(sink.pushed).toHaveLength(0);
    // The UTC date of a local 09:00 depends on the zone the suite runs in.
    expect(state.getMeta('digest_last_sent_date')).toBe(at.toISOString().slice(0, 10));
    expect(state.getMeta('digest_last_sent_local_date')).toBe(`2026-09-16 ${at.toISOString().slice(0, 10)}`);
    expect(shouldSend(state, new Date('2026-09-16T23:00:00'))).toBe(false);
  });

  it('delivers a digest that lists a verification code as a digest', async () => {
    // The code entry reads "收到验证码邮件". Sniffed like a mail, it turned the
    // whole digest into a code card and borrowed a number from the next line.
    const state = new StateStore(':memory:');
    const code = toDigestItem(
      makeMessage({ messageId: '<code@x>', subject: 'Your code', body: '验证码 482913' }),
      makeResult({ importance: 'info', sensitiveVerification: true, verificationCode: '482913', summary: '收到验证码邮件。' }),
    );
    const order = toDigestItem(
      makeMessage({ messageId: '<order@x>', subject: 'Order shipped' }),
      makeResult({ importance: 'info', category: 'Delivery', summary: 'Order 20261103 shipped.' }),
    );
    state.queueDigest('code', code);
    state.queueDigest('order', order);
    const sink = new RecordingSink();
    expect(await sendDigest(state, sink, new Date('2026-11-03T09:00:00'))).toBe(true);
    const [message, result] = sink.pushed[0]!;

    const card = JSON.stringify(buildCard(message, result));
    expect(card).toContain('📮 Daily mail digest');
    expect(card).toContain('Order 20261103 shipped.');
    expect(card).not.toContain('验证码** 20261103');
    expect(card).not.toContain('482913');

    const payload = buildWebhookPayload(message, result) as { mail: { subject: string; snippet: string } };
    expect(payload.mail.subject).toBe(message.subject);
    expect(payload.mail.snippet).toContain('Order 20261103 shipped.');
    expect(buildMailSignalEvent(message, result).title).toBe(message.subject);
  });

  it('retains the queue and does not record the date when delivery fails', async () => {
    const state = new StateStore(':memory:');
    state.queueDigest('failed', items(0, 1)[0]!);
    const at = new Date('2026-09-16T09:00:00');
    expect(await sendDigest(state, new RecordingSink('failed'), at)).toBe(false);
    expect(state.digestPending()).toBe(1);
    expect(state.getMeta('digest_last_sent_date')).toBeUndefined();
  });
});

describe('kept after sending', () => {
  it('logs the sent entries before the queue is cleared', async () => {
    const state = new StateStore(':memory:');
    state.queueDigest('k1', { subject: 'queued', fromName: 'F', from: 'f@x', importance: 'info', category: 'Other' });
    expect(await sendDigest(state, new RecordingSink(), new Date('2026-11-03T09:00:00'))).toBe(true);
    expect(state.digestPending()).toBe(0);
    expect(state.lastDigestLog()?.items).toEqual([expect.objectContaining({ key: 'k1', subject: 'queued' })]);
  });
});
