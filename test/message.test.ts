import { describe, expect, it } from 'vitest';
import {
  containsSensitiveVerificationContent,
  decodeEntities,
  extractBody,
  extractVerificationCode,
  htmlToText,
  isSensitiveVerificationMessage,
} from '../src/imap/message.js';
import { containsSignInLink, sensitiveKindOf, snippet as messageSnippet } from '../src/imap/message.js';
import { makeMessage } from './helpers.js';

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

  it('drops the quoted history a reply carries, so the model reads only the new text', async () => {
    const source = raw(
      'Content-Type: text/plain; charset=utf-8',
      [
        '好的，这笔款项我今天安排付掉，发票请寄到公司地址，收到后我会再确认一次给你。',
        '',
        '在 2026年11月3日 10:00，财务 <billing@example.com> 写道：',
        '> 发票 42 号金额 CNY 496.00，请在 30 日前支付。',
        '> 财务部',
      ].join('\r\n'),
    );
    const { body } = await extractBody(source);

    expect(body).toContain('今天安排付掉');
    expect(body).not.toContain('写道');
    expect(body).not.toContain('496.00');
  });

  it('keeps a verification code that arrives with a signature', async () => {
    const source = raw(
      'Content-Type: text/plain; charset=utf-8',
      ['您的验证码是 123456，5 分钟内有效。', '', '谢谢', '安全团队'].join('\r\n'),
    );
    const { body } = await extractBody(source);

    expect(extractVerificationCode('验证码', body)).toBe('123456');
  });

  it('finds a quote marker in HTML mail, where it is inside a div', async () => {
    const source = raw(
      'Content-Type: text/html; charset=utf-8',
      '<div>Yes, Friday works for me and I will bring the signed contract along.</div>'
        + '<div class="gmail_quote"><div>On Mon, 3 Nov 2026 at 10:00, Ada &lt;ada@example.com&gt; wrote:</div>'
        + '<blockquote>Can we meet on Friday?</blockquote></div>',
    );
    const { body } = await extractBody(source);

    expect(body).toContain('Friday works for me');
    expect(body).not.toContain('Can we meet');
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

describe('sensitive verification detection', () => {
  it('recognises labelled English and Chinese codes', () => {
    expect(containsSensitiveVerificationContent('Your ChatGPT code', 'Your verification code is 123456'))
      .toBe(true);
    expect(extractVerificationCode('Your ChatGPT code', 'Your verification code is 123456'))
      .toBe('123456');
    expect(containsSensitiveVerificationContent('验证码', '您的验证码是 123456，5 分钟内有效')).toBe(true);
    expect(extractVerificationCode('验证码', '您的验证码是 123456，5 分钟内有效')).toBe('123456');
  });

  it('matches OTP as a standalone word', () => {
    expect(containsSensitiveVerificationContent('登录确认', 'Your OTP is 482913')).toBe(true);
    expect(extractVerificationCode('登录确认', 'Your OTP is 482913')).toBe('482913');
    // Adjacent CJK characters do not form an opaque run.
    expect(isSensitiveVerificationMessage({ subject: '安全', body: 'OTP已发送至邮箱' })).toBe(true);
  });

  it('ignores a keyword embedded in base64 image data', () => {
    // The real false positive: a ChatGPT marketing mail whose inline image data
    // contained "otp" between alphanumeric characters. It was flagged as a code
    // mail, so its subject, body, and summary were all hidden from the user.
    const body = [
      '分享一张穿搭照片，查找相似单品。',
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJIzMotpvAAAAAElFTkSuQmCC',
    ].join('\n');
    expect(isSensitiveVerificationMessage({ subject: '根据照片匹配风格', body })).toBe(false);
    expect(extractVerificationCode('根据照片匹配风格', body)).toBeUndefined();
  });

  it('ignores a keyword embedded in a token or URL', () => {
    expect(containsSensitiveVerificationContent('Weekly picks', 'https://e.example.com/c?token=9otp8x')).toBe(false);
    expect(containsSensitiveVerificationContent('Weekly picks', 'iVBORw0KGgoAAAANSUhE/otp/AAAA')).toBe(false);
  });
});

describe('sign-in and reset links', () => {
  const token = 'https://medium.com/m/callback/email?token=0123456789abcdefABCDEF_-xyz&operation=login';
  it('recognises a link mail by its subject and a token-bearing link', () => {
    expect(containsSignInLink('Sign in to Medium', `Click to sign in: ${token}`)).toBe(true);
    expect(containsSignInLink('[GitHub] Please reset your password', 'https://github.com/password_reset/AbCdEf0123456789AbCdEf0123')).toBe(true);
    expect(containsSignInLink('重置密码', '点击 https://example.cn/reset?t=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 完成')).toBe(true);
  });

  it('leaves alerts and newsletters that merely mention signing in alone', () => {
    expect(containsSignInLink('Your Apple ID was used to sign in to iCloud', `If this was not you: ${token}`)).toBe(false);
    expect(containsSignInLink('New sign-in to your account', `Review: ${token}`)).toBe(false);
    expect(containsSignInLink('Weekly newsletter', `Sign in to read more: ${token}`)).toBe(false);
    expect(containsSignInLink('Sign in to Medium', 'Read https://medium.com/about')).toBe(false);
  });

  it('recognises the common reset and sign-in formats', () => {
    const cases: Array<[string, string]> = [
      ['Reset password instructions', 'https://gitlab.example.com/users/password/edit?reset_password_token=sPd3Kq9xYzAbCdEf1234'],
      ['Reset your Dropbox password', 'https://www.dropbox.com/forgot_finish?t=AAB3xYz9876543210QwErTy'],
      ['Forgot your password?', 'https://app.example.com/password/reset/3f9a2c7e1b5d4a8c9e0f1a2b'],
      ['Login to Acme', 'https://acme.io/login?token=Zx9Yw8Vu7Ts6Rq5Po4Nm'],
      ['Sign into Acme', 'https://acme.io/magic?code=Zx9Yw8Vu7Ts6Rq5Po4Nm'],
      ['Fwd: [Medium] Sign in to Medium', token],
      ['【网易】密码找回', 'https://reg.163.com/reset?ticket=8a7b6c5d4e3f2a1b0c9d8e7f'],
      ['重置您的密码', 'https://example.cn/password/reset/9f8e7d6c5b4a3210fedcba98'],
      ['密碼重設通知', 'https://example.tw/reset?token=9f8e7d6c5b4a3210fedcba98'],
      ['Reset your password', 'https://example.com/reset/MQ/bk3n2c-6d1e1d5f8c9a0b3c2d1e/'],
    ];
    for (const [subject, body] of cases) expect(containsSignInLink(subject, body), subject).toBe(true);
  });

  it('leaves replies, notifications, confirmations and slugs alone', () => {
    const cases: Array<[string, string]> = [
      ['Re: [acme/web] Fix password reset email template (PR #812)', 'https://github.com/notifications/unsubscribe-auth/AAB3XYZ0123456789ABCDEFGHIJKLMN'],
      ['[acme/web] Fix password reset email template (PR #812)', 'https://github.com/acme/web/pull/812#pullrequestreview-1234567890123'],
      ['Re: Password reset flow — need your sign-off by Friday', 'https://docs.google.com/document/d/1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdefgh/edit'],
      ['Password reset successful', 'https://u123.ct.sendgrid.net/ls/click?upn=aBcD1234EfGh5678IjKl9012MnOp'],
      ['Your password reset was successful', 'https://support.example.com/account-security-recovery-help'],
      ['Sign in to view your October statement', 'https://bank.example.com/statements?qs=0123456789abcdef0123456789abcdef01234567'],
      ['Log in to see your 5 new notifications', 'https://social.example.com/notifications?ref=email_digest_notifications_weekly'],
      ['Log in to claim your 20% welcome discount', 'https://shop.us1.list-manage.com/track/click?u=abc123def456abc123def456&id=0123456789'],
      ['您已成功重置密码', 'https://help.example.cn/articles/account-security-center-guide'],
      ['Product update: password reset is now easier', 'https://example.com/password-reset-improvements-announcement'],
      ['Reset your password', 'Unsubscribe: https://news.example.com/unsubscribe?token=0123456789abcdefABCDEF'],
    ];
    for (const [subject, body] of cases) expect(containsSignInLink(subject, body), subject).toBe(false);
  });

  it('finds the token in base64url, behind link wrappers and inside app fragments', () => {
    const cases: Array<[string, string]> = [
      ['Reset password instructions', 'https://gitlab.example.com/users/password/edit?reset_password_token=J8CWo_-2oUsZhRNgQyAL'],
      ['Reset your password', 'https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fapp.example.com%2Freset-password%3Ftoken%3DZx9Yw8Vu7Ts6Rq5Po4Nm&data=05%7C01'],
      ['Reset your password', 'https://abc.r.us-east-1.awstrack.me/L0/https:%2F%2Fexample.com%2Freset%3Ftoken=Zx9Yw8Vu7Ts6Rq5Po4Nm/1/0100018b-abc/xyz='],
      ['重置您的密码', 'https://admin.example.cn/#/reset-password?token=9f8e7d6c5b4a3210fedcba9876543210'],
      ['Reset your password', 'https://app.netlify.com/#recovery_token=Zx9Yw8Vu7Ts6Rq5Po4Nm'],
      ['Reset your password', 'https://app.example.com/password_resets/J8CWo_-2oUsZhRNgQyAL/edit'],
    ];
    for (const [subject, body] of cases) expect(containsSignInLink(subject, body), body).toBe(true);
  });

  it('accepts hex tokens and looks past short ids to the token', () => {
    const cases: Array<[string, string]> = [
      ['Reset your password', 'https://app.example.com/reset?token=2fd4e1c67a2d28fced849ee1bb76e7391b93eb12'],
      ['Reset your password', 'https://app.example.com/password/reset/2fd4e1c67a2d28fced849ee1bb76e7391b93eb12'],
      ['Reset your password at Example', 'https://example.com/user/reset/42/1793683768/Hk3dR9sQ2mZpXy7Lw0vT5nB8aEcFgJ1u/login'],
    ];
    for (const [subject, body] of cases) expect(containsSignInLink(subject, body), body).toBe(true);
  });

  it('leaves wiki pages, docs slugs and plain anchors alone', () => {
    const cases: Array<[string, string]> = [
      ['Password reset flow is documented now', 'https://github.com/acme/auth/wiki/Password-Reset-Flow'],
      ['Password reset help', 'https://help.acme.com/login/how-to-set-up-2fa-on-your-account'],
      ['Password reset for API clients', 'https://docs.acme.dev/auth/oauth2-client-credentials'],
      ['Reset your password: read this first', 'https://en.wikipedia.org/wiki/Password#Password_cracking'],
      ['Login link problems', 'https://wiki.example.com/wiki/Login#Troubleshooting_Login_Errors'],
      ['Password reset fix is merged', 'https://bitbucket.org/acme/auth/src/9f2c4e1a7b3d5f6081a2b3c4d5e6f7a8b9c0d1e2/README.md'],
    ];
    for (const [subject, body] of cases) expect(containsSignInLink(subject, body), body).toBe(false);
  });

  it('does not take a commit hash or a storage signature for a sign-in token', () => {
    const cases: Array<[string, string]> = [
      ['Password reset fix is merged', 'https://github.com/acme/auth/commit/9f2c4e1a7b3d5f6081a2b3c4d5e6f7a8b9c0d1e2'],
      ['Password reset fix is merged', 'https://gitlab.com/acme/login/-/blob/9f2c4e1a7b3d5f6081a2b3c4d5e6f7a8b9c0d1e2/README.md'],
      ['Password reset policy update (Q4)', 'https://acme.blob.core.windows.net/docs/policy.pdf?sv=2022-11-02&sig=Zx9Yw8Vu7Ts6Rq5Po4NmAbCdEf%3D'],
      ['Reset your password', 'https://blog.example.com/2026-year-in-review-and-what-comes-next'],
    ];
    for (const [subject, body] of cases) expect(containsSignInLink(subject, body), body).toBe(false);
  });

  it('prefers the code when a message carries both, and hides a link mail like a code mail', () => {
    expect(sensitiveKindOf('Your verification code is 123456', `or use ${token}`)).toBe('code');
    expect(sensitiveKindOf('Sign in to Medium', token)).toBe('link');
    expect(messageSnippet(makeMessage({ subject: 'Sign in to Medium', body: `Click: ${token}` }))).toBe('登录链接邮件（正文已隐藏）');
  });
});
