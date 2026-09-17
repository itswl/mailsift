import { describe, expect, it } from 'vitest';
import { decodeEntities, extractBody, htmlToText } from '../src/imap/message.js';

/** Build a structurally complete RFC822 message. */
function raw(headers: string, body: string): Buffer {
  return Buffer.from(`${headers.trim()}\r\n\r\n${body}`, 'utf8');
}

describe('extractBody', () => {
  it('strips mail headers and keeps only the body', async () => {
    const source = raw(
      `Received: from mailm1sh.message.cmbchina.com (mailm1sh.message.cmbchina.com [220.196.84.228])
X-QQ-XMAILINFO: Md+gqEnjZRDSo6zPOtTt5DTvStQExvm4fj
Subject: test
Content-Type: text/plain; charset=utf-8`,
      '您的消费明细如下：CNY 496.00 尾号5657',
    );
    const { body } = await extractBody(source);

    expect(body).toBe('您的消费明细如下：CNY 496.00 尾号5657');
    // This was the original bug: the entire raw message was sent to the model as the body.
    expect(body).not.toContain('X-QQ-XMAILINFO');
    expect(body).not.toContain('Received:');
  });

  it('decodes quoted-printable', async () => {
    const source = raw(
      `Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable`,
      '=E9=87=91=E9=A2=9D 496.00',
    );
    expect((await extractBody(source)).body).toBe('金额 496.00');
  });

  it('decodes base64', async () => {
    const source = raw(
      `Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: base64`,
      Buffer.from('验证码 123456', 'utf8').toString('base64'),
    );
    expect((await extractBody(source)).body).toBe('验证码 123456');
  });

  it('decodes non-UTF-8 charsets according to their declaration', async () => {
    const source = Buffer.concat([
      Buffer.from('Content-Type: text/plain; charset=gb2312\r\n\r\n', 'ascii'),
      Buffer.from([0xd5, 0xd0, 0xc9, 0xcc, 0xd2, 0xf8, 0xd0, 0xd0]), // 招商银行
    ]);
    expect((await extractBody(source)).body).toBe('招商银行');
  });

  it('converts pure HTML mail to text and decodes entities', async () => {
    const source = raw(
      'Content-Type: text/html; charset=utf-8',
      '<html><style>.x{color:red}</style><body><p>可用额度&nbsp;&nbsp;￥74,052.40</p></body></html>',
    );
    const { body } = await extractBody(source);
    expect(body).toBe('可用额度 ￥74,052.40');
    expect(body).not.toContain('color:red');
  });

  it('prefers text/plain in multipart messages', async () => {
    const source = Buffer.from(
      [
        'Content-Type: multipart/alternative; boundary="b1"',
        '',
        '--b1',
        'Content-Type: text/plain; charset=utf-8',
        '',
        '纯文本版本',
        '--b1',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>HTML 版本</p>',
        '--b1--',
      ].join('\r\n'),
      'utf8',
    );
    expect((await extractBody(source)).body).toBe('纯文本版本');
  });

  it('detects attachments', async () => {
    const source = Buffer.from(
      [
        'Content-Type: multipart/mixed; boundary="b2"',
        '',
        '--b2',
        'Content-Type: text/plain; charset=utf-8',
        '',
        '见附件',
        '--b2',
        'Content-Type: application/pdf; name="invoice.pdf"',
        'Content-Disposition: attachment; filename="invoice.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('%PDF-1.4').toString('base64'),
        '--b2--',
      ].join('\r\n'),
      'utf8',
    );
    const { body, hasAttachments } = await extractBody(source);
    expect(hasAttachments).toBe(true);
    expect(body).toBe('见附件');
  });

  it('returns an empty body for missing or malformed sources without throwing', async () => {
    expect(await extractBody(undefined)).toEqual({ body: '', hasAttachments: false });
    const junk = await extractBody(Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    expect(junk.body).toBe('');
  });
});

describe('decodeEntities', () => {
  it('decodes named entities', () => {
    expect(decodeEntities('a&nbsp;b &amp; c &lt;d&gt;')).toBe('a b & c <d>');
  });

  it('decodes decimal and hexadecimal numeric entities', () => {
    expect(decodeEntities('&#20803; &#x5143;')).toBe('元 元');
  });

  it('preserves unknown entities instead of swallowing characters', () => {
    expect(decodeEntities('&unknownthing; &amp;')).toBe('&unknownthing; &');
  });

  it('does not throw on out-of-range code points', () => {
    expect(() => decodeEntities('&#x110000; &#0;')).not.toThrow();
  });
});

describe('htmlToText', () => {
  it('removes tags and script/style content and collapses whitespace', () => {
    const html = '<div>  你好 <script>alert(1)</script><b>世界</b>\n\n<style>p{}</style></div>';
    expect(htmlToText(html)).toBe('你好 世界');
  });
});
