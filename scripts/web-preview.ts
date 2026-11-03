#!/usr/bin/env node
/**
 * Serve the browser view over fixture data, for working on its design.
 *
 * No mailbox and no LLM are involved: a throwaway state database is seeded
 * with a week of plausible triage results, and the same routeWeb the service
 * uses answers on a local port. It reads nothing from data/ or .env and
 * writes only to the system temp directory.
 *
 * Run with: npx tsx scripts/web-preview.ts [--port 8499] [--token secret]
 *
 * The refresh button is wired to a pretend poll that files one more message,
 * a verification code, so that path can be exercised without IMAP.
 */
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import type { AttachmentManifest } from '../src/imap/message.js';
import type { DigestItem } from '../src/services/digest.js';
import { StateStore, type MailRecord } from '../src/services/state.js';
import { HEARTBEAT_KEY, type PollStats } from '../src/services/watcher.js';
import { routeWeb } from '../src/web.js';

// The config reader wants mailboxes before it answers. These are fixtures: the
// names feed the mailbox filter and the provider feeds the "open in" link, and
// the host is a closed local port, so the live reads the page offers (full
// body, attachments, safety clues) fail at once instead of sending a login
// for a made-up address to a real provider.
process.env.MAIL_ACCOUNT_1 = 'qq|me@qq.com|fixture|127.0.0.1';
process.env.MAIL_ACCOUNT_1_PORT = '9';
process.env.MAIL_ACCOUNT_1_NAME = 'personal-qq';
process.env.MAIL_ACCOUNT_2 = 'gmail_pw|me@gmail.com|fixture|127.0.0.1';
process.env.MAIL_ACCOUNT_2_PORT = '9';
process.env.MAIL_ACCOUNT_2_NAME = 'work-gmail';
process.env.MAILSIFT_VERSION ??= '0.0.0-preview';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8499' },
    token: { type: 'string', default: '' },
  },
});
const port = Number(values.port);
const token = values.token ?? '';

const QQ = { account: 'me@qq.com', accountLabel: 'personal-qq' };
const GMAIL = { account: 'me@gmail.com', accountLabel: 'work-gmail' };

interface Fixture {
  /** How long ago the message was filed, in minutes. */
  age: number;
  account: string;
  accountLabel: string;
  importance: 'critical' | 'warning' | 'info';
  pushed: boolean;
  subject: string;
  fields: MailRecord;
}

const pdf = (filename: string, sizeBytes: number): AttachmentManifest => ({
  items: [{ partId: '2', filename, contentType: 'application/pdf', sizeBytes, inline: false }],
  truncated: false,
});

const H = 60;
const D = 24 * H;

const FIXTURES: Fixture[] = [
  { age: 4, ...GMAIL, importance: 'warning', pushed: true, subject: '[GitHub] Your verification code',
    fields: { sender: 'noreply@github.com', senderName: 'GitHub', folder: 'INBOX', category: 'Security',
      summary: 'One-time code for signing in to GitHub.', reason: 'Verification code; time-sensitive.',
      decidedBy: 'rule', verificationCode: '482913' } },
  { age: 23, ...QQ, importance: 'critical', pushed: true, subject: '您的 Apple 账户在新设备上登录',
    fields: { sender: 'noreply@email.apple.com', senderName: 'Apple', folder: 'INBOX', category: 'Security',
      summary: '一台未识别的 iPhone 从深圳登录了你的 Apple 账户。如果不是你本人，请立即修改密码。',
      reason: '新设备登录提醒，存在账户被盗用的风险。', decidedBy: 'llm' } },
  { age: 1 * H + 10, ...GMAIL, importance: 'warning', pushed: true, subject: 'Invoice #4821 is due on Friday',
    fields: { sender: 'billing@stripe.com', senderName: 'Stripe', folder: 'INBOX', category: 'Finance',
      summary: 'Invoice #4821 for $240.00 is due on 6 November. Pay from the dashboard or by bank transfer.',
      reason: 'An unpaid invoice with a deadline this week.', deadline: '2026-11-06', decidedBy: 'llm',
      attachmentManifest: pdf('invoice-4821.pdf', 48_120) } },
  { age: 2 * H + 5, ...QQ, importance: 'info', pushed: false, subject: '您的快递正在派送中',
    fields: { sender: 'service@sf-express.com', senderName: '顺丰速运', folder: 'INBOX', category: 'Delivery',
      summary: '快递单号 SF1234567890 正在派送，预计今天 18:00 前送达。', reason: '物流进度通知，无需操作。',
      decidedBy: 'llm' } },
  { age: 3 * H, ...QQ, importance: 'info', pushed: false, subject: '最后机会：全场 5 折，今晚截止',
    fields: { sender: 'promo@shop-mail.example', senderName: '优选商城', folder: '垃圾邮件', inSpam: true,
      category: 'Marketing', summary: '促销邮件，全场五折活动今晚截止。', reason: '营销推广，与近期活动无关。',
      decidedBy: 'llm' } },
  { age: 3 * H + 30, ...GMAIL, importance: 'warning', pushed: true, subject: 'Re: PR #61 needs your review before the release',
    fields: { sender: 'notifications@github.com', senderName: 'Mia (GitHub)', folder: 'INBOX', category: 'Work',
      threadKey: '<thread-pr61@github.com>', summary: 'Mia asked for a second review on PR #61 before tomorrow’s release; two comments are still unresolved.',
      reason: 'A direct request with a date attached.', deadline: '2026-11-03', decidedBy: 'llm' } },
  { age: 5 * H, ...QQ, importance: 'info', pushed: false, subject: '周六一起吃饭？',
    fields: { sender: 'lin@example.com', senderName: '林小雨', folder: 'INBOX', category: 'Personal',
      summary: '林小雨问周六晚上是否有空一起吃饭，地点待定。', reason: '个人社交邀约。', decidedBy: 'llm' } },
  { age: 6 * H, ...GMAIL, importance: 'critical', pushed: true, subject: 'Your domain mailsift.dev expires in 3 days',
    fields: { sender: 'renewals@registrar.example', senderName: 'Registrar', folder: '[Gmail]/Spam', inSpam: true,
      category: 'System', summary: 'The domain mailsift.dev expires on 5 November and auto-renew is off. Renew now to avoid downtime.',
      reason: 'A service you depend on lapses in days, and it landed in spam.', deadline: '2026-11-05', decidedBy: 'llm' } },
  { age: 8 * H, ...QQ, importance: 'info', pushed: false, subject: '就诊提醒：11 月 4 日 上午 9:30',
    fields: { sender: 'noreply@hospital.example', senderName: '市人民医院', folder: 'INBOX', category: 'Health',
      summary: '预约提醒：11 月 4 日上午 9:30 口腔科复诊，请提前 15 分钟到达。', reason: '预约提醒，日期在两天后。',
      deadline: '2026-11-04', decidedBy: 'llm' } },
  { age: 10 * H, ...GMAIL, importance: 'warning', pushed: true, subject: 'Gate change for flight CA1832',
    fields: { sender: 'no-reply@airchina.example', senderName: 'Air China', folder: 'INBOX', category: 'Travel',
      summary: 'Flight CA1832 on 3 November now boards at gate B27. Boarding closes 20 minutes before departure.',
      reason: 'A change to travel that is already booked.', deadline: '2026-11-03', decidedBy: 'llm',
      attachmentManifest: pdf('boarding-pass.pdf', 212_400) } },
  { age: 12 * H, ...GMAIL, importance: 'info', pushed: false, subject: 'Sam mentioned you in a post',
    fields: { sender: 'notify@social.example', senderName: 'Social', folder: 'INBOX', category: 'Social',
      summary: 'Sam mentioned you in a post about the conference.', reason: 'Social notification.', decidedBy: 'fallback' } },
  { age: 1 * D + 2 * H, ...QQ, importance: 'info', pushed: false, subject: '招商银行信用卡 10 月电子账单',
    fields: { sender: 'ccsvc@message.cmbchina.com', senderName: '招商银行信用卡', folder: 'INBOX', category: 'Finance',
      summary: '10 月账单已出，应还金额 ¥3,482.60，最后还款日 11 月 15 日。', reason: '例行账单，还款日尚远。',
      deadline: '2026-11-15', decidedBy: 'llm', attachmentManifest: pdf('statement-2026-10.pdf', 96_300) } },
  { age: 1 * D + 4 * H, ...GMAIL, importance: 'warning', pushed: true, subject: 'Your password was changed',
    fields: { sender: 'security@accounts.example', senderName: 'Accounts', folder: 'INBOX', category: 'Security',
      summary: 'The password for your account was changed from a Mac in Shanghai. If this was not you, reset it now.',
      reason: 'Account security change.', decidedBy: 'llm' } },
  { age: 1 * D + 6 * H, ...GMAIL, importance: 'info', pushed: false, subject: 'Weekly standup notes',
    fields: { sender: 'notes@team.example', senderName: 'Team notes', folder: 'INBOX', category: 'Work',
      summary: 'Notes from this week’s standup: release on Tuesday, on-call rotation unchanged.',
      reason: 'Informational team update.', decidedBy: 'llm' } },
  { age: 1 * D + 7 * H, ...QQ, importance: 'info', pushed: false, subject: '[广告] 双十一提前购，领券立减',
    fields: { sender: 'edm@mall.example', senderName: '商城', folder: '垃圾邮件', inSpam: true, category: 'Marketing',
      summary: '双十一促销预热。', reason: '营销邮件。', decidedBy: 'fallback' } },
  { age: 1 * D + 9 * H, ...GMAIL, importance: 'warning', pushed: true, subject: 'Signature requested: Consulting agreement',
    fields: { sender: 'dse@docusign.example', senderName: 'DocuSign', folder: 'INBOX', category: 'Legal',
      summary: 'Acme Ltd asks you to sign the consulting agreement by 10 November.',
      reason: 'A document waiting on your signature with a date.', deadline: '2026-11-10', decidedBy: 'llm' } },
  { age: 1 * D + 11 * H, ...QQ, importance: 'info', pushed: false, subject: '您的包裹已签收',
    fields: { sender: 'service@sf-express.com', senderName: '顺丰速运', folder: 'INBOX', category: 'Delivery',
      summary: '快递 SF0987654321 已由本人签收。', reason: '物流完成通知。', decidedBy: 'llm' } },
  { age: 1 * D + 12 * H, ...GMAIL, importance: 'info', pushed: false, subject: 'Nightly backup completed',
    fields: { sender: 'backup@infra.example', senderName: 'Backup', folder: 'INBOX', category: 'System',
      summary: 'The nightly backup finished in 14 minutes; 2.1 GB written.', reason: 'Routine success report.',
      decidedBy: 'rule' } },
  { age: 2 * D + 3 * H, ...GMAIL, importance: 'critical', pushed: true, subject: 'Payment failed for your subscription',
    fields: { sender: 'billing@cloud.example', senderName: 'Cloud', folder: 'INBOX', category: 'Finance',
      summary: 'The card ending 4242 was declined. Services are suspended if payment fails again on 4 November.',
      reason: 'Failed payment with service interruption ahead.', deadline: '2026-11-04', decidedBy: 'llm' } },
  { age: 2 * D + 5 * H, ...GMAIL, importance: 'warning', pushed: true, subject: 'Re: PR #61 needs your review before the release',
    fields: { sender: 'notifications@github.com', senderName: 'Mia (GitHub)', folder: 'INBOX', category: 'Work',
      threadKey: '<thread-pr61@github.com>', summary: 'Mia opened PR #61 and asked for review.',
      reason: 'Review request.', decidedBy: 'llm' } },
  { age: 2 * D + 8 * H, ...QQ, importance: 'info', pushed: false, subject: '12306 购票成功通知',
    fields: { sender: '12306@rails.com.cn', senderName: '中国铁路 12306', folder: 'INBOX', category: 'Travel',
      summary: '11 月 8 日 G1234 次 上海虹桥—北京南 二等座购票成功，取票号 E123456789。', reason: '出行确认信息。',
      decidedBy: 'llm' } },
  { age: 3 * D + 2 * H, ...QQ, importance: 'info', pushed: false, subject: 'Fwd: 下周团建安排',
    fields: { sender: 'me@gmail.com', senderName: 'me', folder: 'INBOX', category: 'Forwarded copy',
      summary: '从另一个受监控邮箱转发的副本。', reason: '发件人是已配置的邮箱之一。', decidedBy: 'rule' } },
  { age: 3 * D + 9 * H, ...GMAIL, importance: 'warning', pushed: true, subject: 'mailsift: personal-qq failed 3 polls in a row',
    fields: { sender: 'mailsift', senderName: 'mailsift', folder: '', category: 'Service failure',
      summary: 'IMAP login to imap.qq.com was refused three times; check the app password.',
      reason: 'Health alert from the poller.', decidedBy: 'health' } },
  { age: 4 * D + 4 * H, ...GMAIL, importance: 'info', pushed: false, subject: 'Your October usage report',
    fields: { sender: 'reports@analytics.example', senderName: 'Analytics', folder: 'INBOX', category: 'Work',
      summary: 'Monthly usage report: 12,400 requests, 99.98% availability.', reason: 'Routine report.', decidedBy: 'llm' } },
  { age: 5 * D + 6 * H, ...QQ, importance: 'warning', pushed: true, subject: '阿里云账户余额不足提醒',
    fields: { sender: 'notice@aliyun.com', senderName: '阿里云', folder: 'INBOX', category: 'Finance',
      summary: '账户余额低于 ¥100，部分按量付费服务可能在 3 天后停机。', reason: '余额不足会影响在线服务。',
      deadline: '2026-10-31', decidedBy: 'llm' } },
  { age: 6 * D + 1 * H, ...GMAIL, importance: 'info', pushed: false, subject: 'Welcome to the newsletter',
    fields: { sender: 'hello@newsletter.example', senderName: 'Newsletter', folder: '[Gmail]/Spam', inSpam: true,
      category: 'Marketing', summary: 'A welcome message from a newsletter you did not sign up for.',
      reason: 'Bulk mail.', decidedBy: 'fallback' } },
];

const DIGEST: DigestItem[] = [
  { accountLabel: 'personal-qq', folder: 'INBOX', inSpam: false, subject: '您的快递正在派送中', from: 'service@sf-express.com',
    fromName: '顺丰速运', importance: 'info', category: 'Delivery', summary: '快递单号 SF1234567890 正在派送。', deadline: '',
    actionRequired: false, threadCount: 1, date: new Date(Date.now() - (2 * H + 5) * 60_000).toISOString() },
  { accountLabel: 'personal-qq', folder: 'INBOX', inSpam: false, subject: '周六一起吃饭？', from: 'lin@example.com',
    fromName: '林小雨', importance: 'info', category: 'Personal', summary: '周六晚上是否有空一起吃饭。', deadline: '',
    actionRequired: true, threadCount: 1, date: new Date(Date.now() - 5 * H * 60_000).toISOString() },
  { accountLabel: 'work-gmail', folder: 'INBOX', inSpam: false, subject: 'Sam mentioned you in a post', from: 'notify@social.example',
    fromName: 'Social', importance: 'info', category: 'Social', summary: 'Sam mentioned you in a post about the conference.',
    deadline: '', actionRequired: false, threadCount: 1, date: new Date(Date.now() - 12 * H * 60_000).toISOString() },
  { accountLabel: 'personal-qq', folder: '垃圾邮件', inSpam: true, subject: '最后机会：全场 5 折，今晚截止', from: 'promo@shop-mail.example',
    fromName: '优选商城', importance: 'info', category: 'Marketing', summary: '促销邮件。', deadline: '',
    actionRequired: false, threadCount: 1, date: new Date(Date.now() - 3 * H * 60_000).toISOString() },
];

const dir = mkdtempSync(join(tmpdir(), 'mailsift-preview-'));
const dbPath = join(dir, 'preview.db');

function seed(): void {
  const store = new StateStore(dbPath);
  FIXTURES.forEach((fixture, index) => {
    const key = `preview-${String(index + 1).padStart(2, '0')}`;
    const at = new Date(Date.now() - fixture.age * 60_000).toISOString();
    store.markSeen(key, fixture.account, fixture.subject);
    store.recordOutcome(key, fixture.importance, fixture.pushed, {
      messageId: `<${key}@preview>`,
      accountLabel: fixture.accountLabel,
      mailDate: at,
      ...fixture.fields,
    });
  });
  DIGEST.forEach((item, index) => store.queueDigest(`preview-digest-${index}`, item));
  // A poll finished a few minutes ago, so the status line has something to say.
  store.setMeta(HEARTBEAT_KEY, new Date(Date.now() - 3 * 60_000).toISOString());
  store.close();

  // markSeen stamps "now"; move each row back to when it is meant to have arrived.
  const db = new DatabaseSync(dbPath);
  const backdate = db.prepare('UPDATE seen SET created_at = ? WHERE dedup_key = ?');
  FIXTURES.forEach((fixture, index) => {
    const key = `preview-${String(index + 1).padStart(2, '0')}`;
    backdate.run(new Date(Date.now() - fixture.age * 60_000).toISOString(), key);
  });
  db.close();
}

seed();
const store = new StateStore(dbPath);

let refreshes = 0;
/** The pretend poll: one new verification code each time, after a believable pause. */
async function pretendPoll(): Promise<PollStats> {
  await sleep(1200);
  refreshes += 1;
  const key = `preview-refresh-${refreshes}`;
  const code = String(100_000 + ((refreshes * 7919) % 900_000));
  store.markSeen(key, GMAIL.account, 'Your Cursor sign-in code');
  store.recordOutcome(key, 'warning', true, {
    messageId: `<${key}@preview>`, accountLabel: GMAIL.accountLabel, sender: 'no-reply@cursor.sh', senderName: 'Cursor',
    folder: 'INBOX', category: 'Security', summary: 'One-time sign-in code for Cursor.',
    reason: 'Verification code; time-sensitive.', decidedBy: 'rule', verificationCode: code,
    mailDate: new Date().toISOString(),
  });
  // A real poll ends by writing the heartbeat; the status line reads it.
  store.setMeta(HEARTBEAT_KEY, new Date().toISOString());
  return { accountsOk: 2, accountsFailed: 0, fetched: 1, fresh: 1, pushed: 1, queued: 0, spamRescued: 0, failures: [] };
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const answer = await routeWeb(req, url, token, store, 'preview', { onRefresh: pretendPoll });
      const headers: Record<string, string> = { 'content-type': answer.contentType };
      if (answer.cookie) headers['set-cookie'] = answer.cookie;
      if (answer.cacheControl) headers['cache-control'] = answer.cacheControl;
      Object.assign(headers, answer.headers);
      if (answer.status === 303) headers['location'] = '/';
      res.writeHead(answer.status, headers).end(answer.body);
    } catch (error) {
      console.error('preview request failed:', error);
      if (!res.headersSent) res.writeHead(500).end();
    }
  })();
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mailsift web preview: http://127.0.0.1:${port}/` + (token ? ` (token: ${token})` : '') + `\nfixtures: ${dbPath}`);
});
