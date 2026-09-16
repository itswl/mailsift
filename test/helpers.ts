import type { MailMessage } from '../src/imap/message.js';
import type { TriageResult } from '../src/services/triage.js';

export function makeMessage(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    account: 'me@qq.com',
    accountLabel: 'QQ-主号',
    provider: 'qq',
    folder: 'INBOX',
    inSpam: false,
    uid: 1,
    messageId: '<m1@example.com>',
    subject: '测试主题',
    fromAddr: 'sender@example.com',
    fromName: 'Sender',
    toAddrs: ['me@qq.com'],
    date: '2026-09-16T10:00:00.000Z',
    body: '正文内容',
    hasAttachments: false,
    listUnsubscribe: false,
    ...overrides,
  };
}

export function makeResult(overrides: Partial<TriageResult> = {}): TriageResult {
  return {
    importance: 'critical',
    score: 92,
    summary: 'Namecheap 通知域名 example.com 将于 9 月 20 日到期，需续费 ¥88 否则停止解析',
    reason: '域名到期',
    deadline: '2026-09-20',
    category: '账单续费',
    actionRequired: true,
    decidedBy: 'llm',
    ...overrides,
  };
}

export class RecordingSink {
  readonly pushed: Array<[MailMessage, TriageResult]> = [];
  configured = true;
  constructor(private readonly ok = true) {}
  async push(message: MailMessage, result: TriageResult): Promise<boolean> {
    this.pushed.push([message, result]);
    return this.ok;
  }
}
