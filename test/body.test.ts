import { describe, expect, it } from 'vitest';
import {
  cleanBody,
  findQuoteStart,
  MIN_BODY_AFTER_SIGNATURE,
  normalizeWhitespace,
  stripQuotes,
  stripSignature,
} from '../src/imap/body.js';

/** Enough text that the signature guard never keeps a block just because the rest is short. */
const LONG = 'The quarterly invoice is attached and payment is due on the 30th. '.repeat(4);

describe('stripQuotes', () => {
  it('cuts at an English attribution line', () => {
    const text = [
      'Yes, Friday works.',
      '',
      'On Mon, 3 Nov 2026 at 10:00, Ada <ada@example.com> wrote:',
      '> Can we meet on Friday?',
      '> Ada',
    ].join('\n');
    expect(stripQuotes(text)).toBe('Yes, Friday works.');
  });

  it('cuts at an attribution wrapped onto two lines', () => {
    const text = [
      'Approved.',
      '',
      'On Mon, 3 Nov 2026 at 10:00',
      'Ada <ada@example.com> wrote:',
      'Please approve the budget.',
    ].join('\n');
    expect(stripQuotes(text)).toBe('Approved.');
  });

  it('cuts at the Chinese attribution QQ and 163 write', () => {
    const text = ['好的，周五可以。', '', '在 2026年11月3日 10:00，张三 <zhang@qq.com> 写道：', '周五有空吗？'].join('\n');
    expect(stripQuotes(text)).toBe('好的，周五可以。');
  });

  it('cuts at a Chinese original-message separator', () => {
    const text = ['已收到，谢谢。', '------------------ 原始邮件 ------------------', '发件人: 李四', '内容'].join('\n');
    expect(stripQuotes(text)).toBe('已收到，谢谢。');
  });

  it('cuts at an Outlook header block in English and in Chinese', () => {
    const english = ['Noted.', '', 'From: Ada <ada@example.com>', 'Sent: Monday 3 November', 'To: Bob', 'Subject: Budget'].join('\n');
    expect(stripQuotes(english)).toBe('Noted.');

    const chinese = ['收到。', '', '发件人：张三', '发送时间：2026年11月3日', '收件人：李四', '主题：预算'].join('\n');
    expect(stripQuotes(chinese)).toBe('收到。');
  });

  it('leaves a lone From: line alone, because prose uses it too', () => {
    const text = 'From: the desk of the chairman\n\nWe are pleased to announce the results.';
    expect(stripQuotes(text)).toBe(text);
  });

  it('keeps a forwarded message, header block and all', () => {
    const text = [
      'FYI, see below.',
      '---------- Forwarded message ----------',
      'From: Ada <ada@example.com>',
      'Sent: Monday 3 November',
      'Subject: Invoice 42',
      'The invoice is due on the 30th.',
    ].join('\n');
    expect(stripQuotes(text)).toContain('Invoice 42');
    expect(stripQuotes(text)).toContain('due on the 30th');
  });

  it('removes quoted lines that appear above the cut', () => {
    expect(stripQuotes('New text.\n> old line\nMore new text.')).toBe('New text.\nMore new text.');
  });

  it('gives the original back when the message is nothing but a quote', () => {
    const text = 'On Mon, 3 Nov 2026 at 10:00, Ada <ada@example.com> wrote:\n> the only content';
    expect(stripQuotes(text)).toBe(text);
  });

  it('does not treat ordinary Chinese prose as an attribution', () => {
    const text = '他说道：这个方案可行。\n我们按这个执行。';
    expect(stripQuotes(text)).toBe(text);
  });

  it('reports where the quote starts', () => {
    expect(findQuoteStart(['a', 'b', '> c'])).toBe(-1);
    expect(findQuoteStart(['a', '-----Original Message-----', 'b'])).toBe(1);
  });
});

describe('stripSignature', () => {
  it('cuts at the "-- " delimiter', () => {
    expect(stripSignature(`${LONG}\n-- \nAda\nCFO, Example Ltd`)).toBe(LONG.trim());
  });

  it('cuts at a sign-off line', () => {
    expect(stripSignature(`${LONG}\nRegards,\nAda\nCFO`)).toBe(LONG.trim());
    expect(stripSignature(`${LONG}\n此致\n敬礼\n张三`)).toBe(LONG.trim());
    expect(stripSignature(`${LONG}\nSent from my iPhone`)).toBe(LONG.trim());
  });

  it('keeps the signature when too little would be left to judge the message on', () => {
    const short = 'Thanks';
    expect(stripSignature(short)).toBe(short);
    const brief = 'Code is 123456.\nRegards,\nAda';
    expect(brief.length).toBeLessThan(MIN_BODY_AFTER_SIGNATURE);
    expect(stripSignature(brief)).toBe(brief);
  });

  it('ignores a sign-off word far from the end', () => {
    const text = `Thanks\n${LONG}\n${LONG}`;
    expect(stripSignature(text)).toBe(text.trim());
  });

  it('does not take "--" without the trailing space as the delimiter', () => {
    const text = `${LONG}\n--\nstill the message body and not a signature block at all`;
    expect(stripSignature(text)).toContain('still the message body');
  });
});

describe('normalizeWhitespace', () => {
  it('keeps line breaks while collapsing the spaces around them', () => {
    expect(normalizeWhitespace('a    b\r\n\r\n\r\n\r\nc　d')).toBe('a b\n\nc d');
  });
});

describe('cleanBody', () => {
  it('removes the quote and the signature together', () => {
    const text = [
      LONG,
      '',
      'Regards,',
      'Ada',
      '',
      'On Mon, 3 Nov 2026 at 10:00, Bob <bob@example.com> wrote:',
      '> Where is the invoice?',
    ].join('\n');
    expect(cleanBody(text)).toBe(LONG.trim());
  });

  it('keeps a short message whole, signature and all, once the quote is gone', () => {
    const text = [
      'Approved, go ahead.',
      'Regards,',
      'Ada',
      'On Mon, 3 Nov 2026 at 10:00, Bob <bob@example.com> wrote:',
      '> May I go ahead?',
    ].join('\n');
    // Under MIN_BODY_AFTER_SIGNATURE the sign-off stays: there is little else to judge on.
    expect(cleanBody(text)).toBe('Approved, go ahead.\nRegards,\nAda');
  });

  it('keeps a verification code that sits next to a sign-off', () => {
    expect(cleanBody('验证码 123456，5 分钟内有效。\n谢谢\n客服团队')).toContain('123456');
  });

  it('is empty only for empty input', () => {
    expect(cleanBody('   \n\n  ')).toBe('');
    expect(cleanBody('hi')).toBe('hi');
  });
});
