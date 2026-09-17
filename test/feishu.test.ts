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

describe('self-contained cards', () => {
  it('puts the summary first', () => {
    // The user cannot see the raw message, so the summary must lead.
    const body = cardBody(buildCard(makeMessage(), makeResult()));
    expect(body.split('---')[0]).toContain('Namecheap 通知域名');
    expect(body).toContain('¥88');
  });

  it('shows the deadline separately', () => {
    const body = cardBody(buildCard(makeMessage(), makeResult()));
    expect(body).toContain('Deadline');
    expect(body).toContain('2026-09-20');
  });

  it('omits the deadline row when there is no deadline', () => {
    expect(cardBody(buildCard(makeMessage(), makeResult({ deadline: '' })))).not.toContain('截止');
  });

  it('falls back to the reason when there is no summary', () => {
    expect(cardBody(buildCard(makeMessage(), makeResult({ summary: '' })))).toContain('域名到期');
  });

  it('marks recovered spam in the title', () => {
    expect(cardTitle(buildCard(makeMessage({ inSpam: true, folder: 'Junk' }), makeResult()))).toContain('Recovered from spam');
  });

  it('colors by importance', () => {
    const color = (imp: 'critical' | 'info'): unknown =>
      (buildCard(makeMessage(), makeResult({ importance: imp }))['card'] as { header: { template: string } }).header.template;
    expect(color('critical')).toBe('red');
    expect(color('info')).toBe('blue');
  });

  it('escapes angle brackets so card Markdown does not swallow addresses', () => {
    expect(cardBody(buildCard(makeMessage({ fromAddr: 'a@b.com' }), makeResult()))).toContain('\\<a@b.com\\>');
  });

  it('formats timestamps for readability', () => {
    const body = cardBody(buildCard(makeMessage({ date: '2026-09-16T06:32:00.000Z' }), makeResult()));
    expect(body).not.toContain('T06:32:00');
  });

  it('renders the full digest body instead of the summary', () => {
    const long = Array.from({ length: 100 }, (_, i) => `- 第 ${i} 封`).join('\n');
    const card = buildCard(makeMessage({ subject: '每日邮件简报', body: long, extra: { digest: true } }), makeResult({ importance: 'info' }));
    expect(cardBody(card)).toContain('第 50 封');
  });
});

describe('navigation buttons', () => {
  it('locates Gmail messages precisely by Message-ID', () => {
    const card = buildCard(makeMessage({ provider: 'gmail', account: 'me@gmail.com', messageId: '<CAB=abc@mail.gmail.com>' }), makeResult());
    const action = cardElements(card).at(-1)!;
    const button = (action['actions'] as Array<Record<string, unknown>>)[0]!;
    expect(String(button['url'])).toContain('rfc822msgid');
    expect(button['type']).toBe('primary');
  });

  it('uses the QQ mailbox entry point without claiming to open the message', () => {
    const card = buildCard(makeMessage({ provider: 'qq' }), makeResult());
    const button = (cardElements(card).at(-1)!['actions'] as Array<Record<string, unknown>>)[0]!;
    expect((button['text'] as { content: string }).content).toBe('Open QQ Mail');
    expect(button['type']).toBe('default');
  });

  it('does not offer precise navigation for generated Message-IDs', () => {
    const link = buildLink('gmail', 'me@gmail.com', '<generated-abc@mailsift>');
    expect(link?.exact).toBe(false);
  });

  it('omits buttons for unknown providers', () => {
    const card = buildCard(makeMessage({ provider: 'imap' }), makeResult());
    expect(cardElements(card).every((e) => e['tag'] !== 'action')).toBe(true);
  });
});

describe('signatures and WebhookWise payloads', () => {
  it('generates deterministic signatures', () => {
    expect(sign('secret', 1_700_000_000)).toBe(sign('secret', 1_700_000_000));
    expect(sign('secret', 1_700_000_000)).not.toBe(sign('secret', 1_700_000_001));
  });

  it('includes paths required by the adapter spec', () => {
    // mailsift.yaml detect/identity rules depend on these paths; renaming them silently breaks deduplication.
    const payload = buildWebhookPayload(makeMessage({ inSpam: true }), makeResult());
    expect(payload['mail']).toMatchObject({ message_id: '<m1@example.com>', account: 'me@qq.com', in_spam: true });
    expect(payload['triage']).toMatchObject({ importance: 'critical', category: '账单续费' });
    expect(payload['signal']).toMatchObject({
      schema: 'signal.v1', source: 'mailsift', type: 'email.received',
      source_event_id: '<m1@example.com>', priority: 'critical',
      evidence_ref: { kind: 'mcp', uri: 'mailsift://mail/%3Cm1%40example.com%3E' },
    });
    expect((payload['signal'] as Record<string, unknown>)['payload']).not.toHaveProperty('body');
  });

  it('keeps the legacy mail / triage shape while adding the source-neutral signal', () => {
    expect(Object.keys(buildWebhookPayload(makeMessage(), makeResult())).sort()).toEqual(['mail', 'signal', 'triage']);
  });
});
