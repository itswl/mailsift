import { describe, expect, it } from 'vitest';
import './setup.js';
import { makeMessage, makeResult, RecordingSink } from './helpers.js';
import { renderDigest, sendDigest, shouldSend, toDigestItem, type DigestItem } from '../src/services/digest.js';
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
      toDigestItem(makeMessage({ messageId: '<a@x>' }), makeResult({ category: '账单缴费', summary: '账单 1' })),
      toDigestItem(makeMessage({ messageId: '<b@x>' }), makeResult({ category: '账单缴费', summary: '账单 2' })),
      toDigestItem(makeMessage({ messageId: '<c@x>' }), makeResult({ category: '快递物流', summary: '包裹待取' })),
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

  it('truncates long categories and explains the omission', () => {
    expect(renderDigest(items(0, 60))).toContain('more in this category');
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

    const [message, result] = sink.pushed[0]!;
    expect(result.importance).toBe('info');
    expect(message.subject).toContain('spam 2');
  });

  it('records the date for an empty queue to avoid repeated checks', async () => {
    const state = new StateStore(':memory:');
    const sink = new RecordingSink();
    expect(await sendDigest(state, sink, new Date('2026-09-16T09:00:00'))).toBe(false);
    expect(sink.pushed).toHaveLength(0);
    expect(state.getMeta('digest_last_sent_date')).toBe('2026-09-16');
  });
});
