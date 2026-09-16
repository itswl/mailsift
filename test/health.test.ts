import { describe, expect, it } from 'vitest';
import './setup.js';
import { RecordingSink } from './helpers.js';
import { StateStore } from '../src/services/state.js';
import type { Account } from '../src/config.js';
import {
  recordAccountFailure, recordAccountSuccess, recordLlmFailure, recordLlmSuccess,
  recordStartupFailure, ALERTED_AT_KEY, LLM_ALERTED_AT_KEY,
} from '../src/services/health.js';

const QQ: Account = {
  name: 'QQ-主号', provider: 'qq', username: 'me@qq.com',
  host: 'imap.qq.com', port: 993, auth: 'password', password: 'x',
  folders: ['INBOX', 'spam'], useSsl: true,
};
const GMAIL: Account = { ...QQ, name: 'Gmail', provider: 'gmail', username: 'me@gmail.com', auth: 'gmail_oauth' };
const OUTLOOK: Account = { ...QQ, name: 'Outlook', provider: 'outlook', username: 'me@outlook.com', auth: 'outlook_oauth' };

const store = () => new StateStore(':memory:');

describe('账号失联', () => {
  it('认证失败立即告警——那是确定性的，等两轮毫无意义', async () => {
    const s = store();
    const sink = new RecordingSink();
    expect(await recordAccountFailure(s, sink, GMAIL, new Error('invalid_grant'))).toBe(true);
    const [message, result] = sink.pushed[0]!;
    expect(result.importance).toBe('critical');
    expect(message.subject).toContain('失联');
  });

  it('非认证失败等第二次', async () => {
    process.env.ACCOUNT_ALERT_AFTER_FAILURES = '2';
    const s = store();
    const sink = new RecordingSink();
    expect(await recordAccountFailure(s, sink, QQ, new Error('ETIMEDOUT'))).toBe(false);
    expect(await recordAccountFailure(s, sink, QQ, new Error('ETIMEDOUT'))).toBe(true);
  });

  it('冷却期内不重复刷屏', async () => {
    const s = store();
    const sink = new RecordingSink();
    for (let i = 0; i < 5; i += 1) await recordAccountFailure(s, sink, GMAIL, new Error('invalid_grant'));
    expect(sink.pushed).toHaveLength(1);
  });

  it('冷却过期后可以再告警', async () => {
    const s = store();
    const sink = new RecordingSink();
    await recordAccountFailure(s, sink, GMAIL, new Error('invalid_grant'));
    s.setMeta(ALERTED_AT_KEY + GMAIL.username, new Date(Date.now() - 7 * 3_600_000).toISOString());
    await recordAccountFailure(s, sink, GMAIL, new Error('invalid_grant'));
    expect(sink.pushed).toHaveLength(2);
  });

  it('告警正文说清失去了什么', async () => {
    const s = store();
    const sink = new RecordingSink();
    await recordAccountFailure(s, sink, QQ, new Error('authentication failed'));
    expect(sink.pushed[0]![0].body).toContain('垃圾箱');
  });

  it('Gmail 的修复建议点出 7 天陷阱', async () => {
    const s = store();
    const sink = new RecordingSink();
    await recordAccountFailure(s, sink, GMAIL, new Error('invalid_grant'));
    const body = sink.pushed[0]![0].body;
    expect(body).toContain('7 天');
    expect(body).toContain('测试');
  });

  it('Outlook 的修复建议先提 IMAP 开关', async () => {
    const s = store();
    const sink = new RecordingSink();
    await recordAccountFailure(s, sink, OUTLOOK, new Error('invalid_grant'));
    const body = sink.pushed[0]![0].body;
    expect(body).toContain('转发和 IMAP');
    expect(body).toContain('默认是关的');
  });

  it('任何服务商的排查项都包含 IMAP 没开这条', async () => {
    // 大多数邮箱默认不开 IMAP，这是接入失败最常见的原因
    const s = store();
    const sink = new RecordingSink();
    await recordAccountFailure(s, sink, QQ, new Error('login failed'));
    expect(sink.pushed[0]![0].body).toContain('IMAP');
  });

  it('恢复后补一条通知', async () => {
    const s = store();
    const sink = new RecordingSink();
    await recordAccountFailure(s, sink, GMAIL, new Error('invalid_grant'));
    expect(await recordAccountSuccess(s, sink, GMAIL)).toBe(true);
    expect(sink.pushed[1]![0].subject).toContain('已恢复');
  });

  it('抖一下自己好了不打扰', async () => {
    process.env.ACCOUNT_ALERT_AFTER_FAILURES = '2';
    const s = store();
    const sink = new RecordingSink();
    await recordAccountFailure(s, sink, QQ, new Error('ETIMEDOUT'));
    expect(await recordAccountSuccess(s, sink, QQ)).toBe(false);
    expect(sink.pushed).toHaveLength(0);
  });

  it('一直正常的账号不产生任何消息', async () => {
    const sink = new RecordingSink();
    expect(await recordAccountSuccess(store(), sink, QQ)).toBe(false);
    expect(sink.pushed).toHaveLength(0);
  });
});

describe('模型不可用', () => {
  it('达到阈值才告警', async () => {
    process.env.LLM_ALERT_AFTER_FAILURES = '2';
    const s = store();
    const sink = new RecordingSink();
    expect(await recordLlmFailure(s, sink, new Error('HTTP 401'))).toBe(false);
    expect(await recordLlmFailure(s, sink, new Error('HTTP 401'))).toBe(true);
    expect(sink.pushed[0]![1].importance).toBe('critical');
  });

  it('正文说清降级后果，而不只是报错', async () => {
    process.env.LLM_ALERT_AFTER_FAILURES = '1';
    const s = store();
    const sink = new RecordingSink();
    await recordLlmFailure(s, sink, new Error('HTTP 401 invalid api key'));
    const body = sink.pushed[0]![0].body;
    expect(body).toContain('关键词兜底');
    expect(body).toContain('每日简报');
    expect(body).toContain('401');
  });

  it('冷却生效', async () => {
    process.env.LLM_ALERT_AFTER_FAILURES = '1';
    const s = store();
    const sink = new RecordingSink();
    for (let i = 0; i < 6; i += 1) await recordLlmFailure(s, sink, new Error('x'));
    expect(sink.pushed).toHaveLength(1);
  });

  it('恢复通知提醒去简报里复核', async () => {
    process.env.LLM_ALERT_AFTER_FAILURES = '1';
    const s = store();
    const sink = new RecordingSink();
    await recordLlmFailure(s, sink, new Error('x'));
    s.setMeta(LLM_ALERTED_AT_KEY, new Date().toISOString());
    expect(await recordLlmSuccess(s, sink)).toBe(true);
    expect(sink.pushed[1]![0].body).toContain('简报');
  });
});

describe('启动失败', () => {
  it('说清当前完全没在监控，并给出自检命令', async () => {
    process.env.STATE_DB_PATH = ':memory:';
    const sink = new RecordingSink();
    expect(await recordStartupFailure(new Error('MAIL_ACCOUNT_1 格式不对'), sink)).toBe(true);
    const body = sink.pushed[0]![0].body;
    expect(body).toContain('不会被检查');
    expect(body).toContain('--check');
  });

  it('没有出口时只记日志，不再抛异常盖住原始错误', async () => {
    process.env.STATE_DB_PATH = ':memory:';
    const sink = new RecordingSink();
    sink.configured = false;
    expect(await recordStartupFailure(new Error('x'), sink)).toBe(false);
  });
});
