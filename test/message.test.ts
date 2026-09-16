import { describe, expect, it } from 'vitest';
import { decodeEntities, extractBody, htmlToText } from '../src/imap/message.js';

/** 拼一封结构完整的 RFC822 报文 */
function raw(headers: string, body: string): Buffer {
  return Buffer.from(`${headers.trim()}\r\n\r\n${body}`, 'utf8');
}

describe('extractBody', () => {
  it('剥掉邮件头，只留正文', async () => {
    const source = raw(
      `Received: from mailm1sh.message.cmbchina.com (mailm1sh.message.cmbchina.com [220.196.84.228])
X-QQ-XMAILINFO: Md+gqEnjZRDSo6zPOtTt5DTvStQExvm4fj
Subject: test
Content-Type: text/plain; charset=utf-8`,
      '您的消费明细如下：CNY 496.00 尾号5657',
    );
    const { body } = await extractBody(source);

    expect(body).toBe('您的消费明细如下：CNY 496.00 尾号5657');
    // 这是最初的 bug：整封原文被当成正文喂给模型
    expect(body).not.toContain('X-QQ-XMAILINFO');
    expect(body).not.toContain('Received:');
  });

  it('解 quoted-printable', async () => {
    const source = raw(
      `Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable`,
      '=E9=87=91=E9=A2=9D 496.00',
    );
    expect((await extractBody(source)).body).toBe('金额 496.00');
  });

  it('解 base64', async () => {
    const source = raw(
      `Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: base64`,
      Buffer.from('验证码 123456', 'utf8').toString('base64'),
    );
    expect((await extractBody(source)).body).toBe('验证码 123456');
  });

  it('非 UTF-8 字符集按声明解码', async () => {
    const source = Buffer.concat([
      Buffer.from('Content-Type: text/plain; charset=gb2312\r\n\r\n', 'ascii'),
      Buffer.from([0xd5, 0xd0, 0xc9, 0xcc, 0xd2, 0xf8, 0xd0, 0xd0]), // 招商银行
    ]);
    expect((await extractBody(source)).body).toBe('招商银行');
  });

  it('纯 HTML 邮件转文本并解实体', async () => {
    const source = raw(
      'Content-Type: text/html; charset=utf-8',
      '<html><style>.x{color:red}</style><body><p>可用额度&nbsp;&nbsp;￥74,052.40</p></body></html>',
    );
    const { body } = await extractBody(source);
    expect(body).toBe('可用额度 ￥74,052.40');
    expect(body).not.toContain('color:red');
  });

  it('multipart 优先取 text/plain', async () => {
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

  it('识别附件', async () => {
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

  it('没有 source 或畸形报文时返回空，不抛异常', async () => {
    expect(await extractBody(undefined)).toEqual({ body: '', hasAttachments: false });
    const junk = await extractBody(Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    expect(junk.body).toBe('');
  });
});

describe('decodeEntities', () => {
  it('解命名实体', () => {
    expect(decodeEntities('a&nbsp;b &amp; c &lt;d&gt;')).toBe('a b & c <d>');
  });

  it('解十进制与十六进制数字实体', () => {
    expect(decodeEntities('&#20803; &#x5143;')).toBe('元 元');
  });

  it('未知实体原样保留，不吞字符', () => {
    expect(decodeEntities('&unknownthing; &amp;')).toBe('&unknownthing; &');
  });

  it('越界码点不抛异常', () => {
    expect(() => decodeEntities('&#x110000; &#0;')).not.toThrow();
  });
});

describe('htmlToText', () => {
  it('去标签、去 script/style、压空白', () => {
    const html = '<div>  你好 <script>alert(1)</script><b>世界</b>\n\n<style>p{}</style></div>';
    expect(htmlToText(html)).toBe('你好 世界');
  });
});
