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

describe('渲染', () => {
  it('垃圾箱排最前——那是简报存在的主要理由', () => {
    const body = renderDigest(items(1, 1));
    expect(body.indexOf('⚠️ 垃圾箱')).toBeLessThan(body.indexOf('**通知（'));
  });

  it('统计两个来源', () => {
    expect(renderDigest(items(2, 3))).toContain('共 5 封');
    expect(renderDigest(items(2, 3))).toContain('收件箱 3 · 垃圾箱 2');
  });

  it('空队列有兜底文案', () => {
    expect(renderDigest([])).toContain('没有需要回顾');
  });

  it('按分类归拢，条目多的排前面', () => {
    const rows = [
      toDigestItem(makeMessage({ messageId: '<a@x>' }), makeResult({ category: '账单缴费', summary: '账单 1' })),
      toDigestItem(makeMessage({ messageId: '<b@x>' }), makeResult({ category: '账单缴费', summary: '账单 2' })),
      toDigestItem(makeMessage({ messageId: '<c@x>' }), makeResult({ category: '快递物流', summary: '包裹待取' })),
    ];
    const body = renderDigest(rows);
    expect(body).toContain('**账单缴费（2）**');
    expect(body.indexOf('账单缴费（2）')).toBeLessThan(body.indexOf('快递物流（1）'));
  });

  it('每行展示摘要而不是标题', () => {
    // 标题常常什么都没说，摘要才是用户要的信息
    const row = toDigestItem(
      makeMessage({ subject: 'Re: FW: 通知', fromName: '张三' }),
      makeResult({ summary: '客户询问报价单何时发出，要求本周内回复', deadline: '本周内' }),
    );
    const body = renderDigest([row]);
    expect(body).toContain('客户询问报价单何时发出');
    expect(body).toContain('张三');
    expect(body).toContain('⏰本周内');
  });

  it('超长时截断并说明', () => {
    expect(renderDigest(items(0, 60))).toContain('本类另有');
  });
});

describe('发送时机', () => {
  it('等到设定的小时', () => {
    const state = new StateStore(':memory:');
    process.env.DIGEST_HOUR = '9';
    expect(shouldSend(state, new Date('2026-09-16T08:59:00'))).toBe(false);
    expect(shouldSend(state, new Date('2026-09-16T09:00:00'))).toBe(true);
  });

  it('一天只发一次', () => {
    const state = new StateStore(':memory:');
    process.env.DIGEST_HOUR = '0';
    const at = new Date('2026-09-16T10:00:00');
    state.setMeta('digest_last_sent_date', at.toISOString().slice(0, 10));
    expect(shouldSend(state, at)).toBe(false);
  });

  it('可以关闭', () => {
    process.env.DIGEST_ENABLED = 'false';
    expect(shouldSend(new StateStore(':memory:'), new Date('2026-09-16T23:00:00'))).toBe(false);
  });
});

describe('发送', () => {
  it('排空队列并记录日期', async () => {
    const state = new StateStore(':memory:');
    for (const item of items(2, 1)) state.queueDigest(item.subject, item);
    const sink = new RecordingSink();
    const at = new Date('2026-09-16T09:30:00');

    expect(await sendDigest(state, sink, at)).toBe(true);
    expect(state.digestPending()).toBe(0);
    expect(state.getMeta('digest_last_sent_date')).toBe(at.toISOString().slice(0, 10));

    const [message, result] = sink.pushed[0]!;
    expect(result.importance).toBe('info');
    expect(message.subject).toContain('垃圾箱 2');
  });

  it('队列为空也记日期，免得整天反复检查', async () => {
    const state = new StateStore(':memory:');
    const sink = new RecordingSink();
    expect(await sendDigest(state, sink, new Date('2026-09-16T09:00:00'))).toBe(false);
    expect(sink.pushed).toHaveLength(0);
    expect(state.getMeta('digest_last_sent_date')).toBe('2026-09-16');
  });
});
