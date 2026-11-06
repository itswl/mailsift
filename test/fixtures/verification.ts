/**
 * Shapes seen in real verification mail, with synthetic codes.
 *
 * This file is the regression set: when a heuristic changes, these cases say
 * what must keep working. Add the message that fooled the extractor as a new
 * entry rather than only fixing the rule.
 */
export interface VerificationCase {
  name: string;
  subject: string;
  body: string;
  /** Expected code, or undefined when the mail has none to show. */
  code?: string;
  /** Expected sensitive kind; null means ordinary mail. */
  kind: 'code' | 'link' | 'secret' | null;
}

export const VERIFICATION_CASES: VerificationCase[] = [
  {
    name: 'english label before the code',
    subject: 'Your ChatGPT code',
    body: 'Your verification code is 123456. It expires in 10 minutes.',
    code: '123456',
    kind: 'code',
  },
  {
    name: 'code before the label',
    subject: '892391 is your X verification code',
    body: 'X\nConfirm your email address\nYou can use this code as a backup: 892391',
    code: '892391',
    kind: 'code',
  },
  {
    name: 'chinese subject carries the code',
    subject: '322435是你的 Zoom 验证码',
    body: '验证你的电子邮件\n请在接下来的 10 分钟内输入此代码以进行注册：322435',
    code: '322435',
    kind: 'code',
  },
  {
    name: 'forwarded header date is not the code',
    subject: '转发: 322435是你的 Zoom 验证码',
    body: [
      '发件人: Zoom <no-reply@zoom.us>',
      '已发送: 2026年9月27日星期日 22:56:35 (UTC+08:00)',
      '主题: 322435是你的 Zoom 验证码',
      '请在接下来的10分钟内输入此代码以进行注册：322435',
    ].join('\n'),
    code: '322435',
    kind: 'code',
  },
  {
    name: 'announced code without the words verification code',
    subject: 'Verify your account',
    body: 'Use the code below to complete your registration: 083897\nFor your security, do not share this code.',
    code: '083897',
    kind: 'code',
  },
  {
    name: 'code in the sentence after the label',
    subject: 'Complete code challenge',
    body: "We've issued a one-time code challenge as an additional security check. Please enter the code below in your open browser window to complete the challenge. 726637 This code expires in 10 minutes.",
    code: '726637',
    kind: 'code',
  },
  {
    name: 'upper-case label on its own line',
    subject: 'Your Multica verification code',
    body: 'YOUR VERIFICATION CODE 587571\nThis code expires in 10 minutes.',
    code: '587571',
    kind: 'code',
  },
  {
    name: 'authorization code with expiry',
    subject: 'Backblaze Authentication',
    body: 'This Backblaze Authorization Code is required for security. Backblaze Authorization Code: 565818\nCode expires in 20 minutes.',
    code: '565818',
    kind: 'code',
  },
  {
    name: 'chinese delivery phrase',
    subject: 'iKuuu VPN - 验证邮件',
    body: '以下 6 位数字是邮箱验证码，请在网站上填写以通过验证 (如果并非你本人操作，请忽略此邮件) 098754',
    code: '098754',
    kind: 'code',
  },
  {
    name: 'code split into two groups of three',
    subject: 'Your verification code',
    body: 'Your verification code is 613 254',
    code: '613254',
    kind: 'code',
  },
  {
    name: 'code split into two groups of four',
    subject: '验证码',
    body: '验证码是 4210-9987',
    code: '42109987',
    kind: 'code',
  },
  {
    name: 'year and date near the label are skipped',
    subject: '验证码',
    body: '您的验证码已发送\n有效期至 2026-11-05\n083897',
    code: '083897',
    kind: 'code',
  },
  {
    name: 'four digit code',
    subject: '验证码',
    body: '验证码：1234，5 分钟内有效',
    code: '1234',
    kind: 'code',
  },
  {
    name: 'otp',
    subject: '登录确认',
    body: 'Your OTP is 482913',
    code: '482913',
    kind: 'code',
  },
  {
    name: 'code mail without a code',
    subject: '验证码邮件',
    body: '验证码已发送，请查收。',
    code: undefined,
    kind: 'code',
  },
  {
    name: 'order number in a code mail is not the code',
    subject: '验证码邮件',
    body: '订单 123456 已发货，验证码另行发送。',
    code: undefined,
    kind: 'code',
  },
  {
    name: 'phone grouping is not joined into a code',
    subject: '验证码邮件',
    body: '如需帮助请拨打 138 0013 8000，验证码另行发送。',
    code: undefined,
    kind: 'code',
  },
  {
    name: 'promo code is not a verification code',
    subject: 'Weekly sale',
    body: 'Use code SAVE20 at checkout. Offer ends Friday.',
    code: undefined,
    kind: null,
  },
  {
    name: 'sign-in link mail',
    subject: 'Sign in to Medium',
    body: 'Click to sign in: https://medium.com/m/callback/email?token=0123456789abcdefABCDEF_-xyz&operation=login',
    code: undefined,
    kind: 'link',
  },
  {
    name: 'credential mail',
    subject: 'Your new API key',
    body: 'Keep it safe: sk-abcdefghijklmnopqrstuvwx',
    code: undefined,
    kind: 'secret',
  },
];
