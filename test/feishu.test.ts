import { describe, expect, it } from 'vitest';
import './setup.js';
import { makeMessage, makeResult } from './helpers.js';
import { buildCard, sign } from '../src/services/feishu.js';
import { buildWebhookPayload } from '../src/services/sink.js';
import { buildLink } from '../src/links.js';

function cardBody(card: Record<string, unknown>): string {
  const elements = (card['card'] as { elements: Array<Record<string, unknown>> }).elements;
  return String(elements[0]!['content']);
}
function cardElements(card: Record<string, unknown>): Array<Record<string, unknown>> {
  return (card['card'] as { elements: Array<Record<string, unknown>> }).elements;
}
function cardTitle(card: Record<string, unknown>): string {
  const header = (card['card'] as { header: { title: { content: string } } }).header;
  return header.title.content;
}

describe('卡片要能独立看懂', () => {
  it('摘要放最前面', () => {
    // 用户看不到原文，摘要必须领头
    const body = cardBody(buildCard(makeMessage(), makeResult()));
    expect(body.split('---')[0]).toContain('Namecheap 通知域名');
    expect(body).toContain('¥88');
  });

  it('截止时间单独标出', () => {
    const body = cardBody(buildCard(makeMessage(), makeResult()));
    expect(body).toContain('截止');
    expect(body).toContain('2026-09-20');
  });

  it('没有截止时间就不显示那一行', () => {
    expect(cardBody(buildCard(makeMessage(), makeResult({ deadline: '' })))).not.toContain('截止');
  });

  it('没有摘要时退回理由', () => {
    expect(cardBody(buildCard(makeMessage(), makeResult({ summary: '' })))).toContain('域名到期');
  });

  it('垃圾箱捞回在标题标出来', () => {
    expect(cardTitle(buildCard(makeMessage({ inSpam: true, folder: 'Junk' }), makeResult()))).toContain('垃圾箱捞回');
  });

  it('按重要性着色', () => {
    const color = (imp: 'critical' | 'info'): unknown =>
      (buildCard(makeMessage(), makeResult({ importance: imp }))['card'] as { header: { template: string } }).header.template;
    expect(color('critical')).toBe('red');
    expect(color('info')).toBe('blue');
  });

  it('尖括号转义，否则地址会被卡片 markdown 吞掉', () => {
    expect(cardBody(buildCard(makeMessage({ fromAddr: 'a@b.com' }), makeResult()))).toContain('\\<a@b.com\\>');
  });

  it('时间转成可读格式', () => {
    const body = cardBody(buildCard(makeMessage({ date: '2026-09-16T06:32:00.000Z' }), makeResult()));
    expect(body).not.toContain('T06:32:00');
  });

  it('简报渲染完整正文而不是摘要', () => {
    const long = Array.from({ length: 100 }, (_, i) => `- 第 ${i} 封`).join('\n');
    const card = buildCard(makeMessage({ subject: '每日邮件简报', body: long, extra: { digest: true } }), makeResult({ importance: 'info' }));
    expect(cardBody(card)).toContain('第 50 封');
  });
});

describe('跳转按钮', () => {
  it('Gmail 能按 Message-ID 精确定位', () => {
    const card = buildCard(makeMessage({ provider: 'gmail', account: 'me@gmail.com', messageId: '<CAB=abc@mail.gmail.com>' }), makeResult());
    const action = cardElements(card).at(-1)!;
    const button = (action['actions'] as Array<Record<string, unknown>>)[0]!;
    expect(String(button['url'])).toContain('rfc822msgid');
    expect(button['type']).toBe('primary');
  });

  it('QQ 只能给邮箱入口，文案不能骗人说"打开这封"', () => {
    const card = buildCard(makeMessage({ provider: 'qq' }), makeResult());
    const button = (cardElements(card).at(-1)!['actions'] as Array<Record<string, unknown>>)[0]!;
    expect((button['text'] as { content: string }).content).toBe('打开 QQ 邮箱');
    expect(button['type']).toBe('default');
  });

  it('生成的 Message-ID 不做精确跳转', () => {
    const link = buildLink('gmail', 'me@gmail.com', '<generated-abc@mailsift>');
    expect(link?.exact).toBe(false);
  });

  it('不认识的 provider 没有按钮', () => {
    const card = buildCard(makeMessage({ provider: 'imap' }), makeResult());
    expect(cardElements(card).every((e) => e['tag'] !== 'action')).toBe(true);
  });
});

describe('签名与 WebhookWise payload', () => {
  it('签名是确定性的', () => {
    expect(sign('secret', 1_700_000_000)).toBe(sign('secret', 1_700_000_000));
    expect(sign('secret', 1_700_000_000)).not.toBe(sign('secret', 1_700_000_001));
  });

  it('payload 带齐适配器 spec 依赖的路径', () => {
    // mailsift.yaml 的 detect/identity 依赖这几个路径，改名会静默丢去重
    const payload = buildWebhookPayload(makeMessage({ inSpam: true }), makeResult());
    expect(payload['mail']).toMatchObject({ message_id: '<m1@example.com>', account: 'me@qq.com', in_spam: true });
    expect(payload['triage']).toMatchObject({ importance: 'critical', category: '账单续费' });
  });

  it('顶层只有 mail / triage，避开 generic_json 适配器的检测', () => {
    expect(Object.keys(buildWebhookPayload(makeMessage(), makeResult())).sort()).toEqual(['mail', 'triage']);
  });
});
