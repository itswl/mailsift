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

describe('account outages', () => {
  it('alerts immediately on authentication failures because they are deterministic', async () => {
    const s = store();
    const sink = new RecordingSink();
    expect(await recordAccountFailure(s, sink, GMAIL, new Error('invalid_grant'))).toBe(true);
    const [message, result] = sink.pushed[0]!;
    expect(result.importance).toBe('critical');
    expect(message.subject).toContain('unavailable');
  });

  it('waits for a second non-authentication failure', async () => {
    process.env.ACCOUNT_ALERT_AFTER_FAILURES = '2';
    const s = store();
    const sink = new RecordingSink();
    expect(await recordAccountFailure(s, sink, QQ, new Error('ETIMEDOUT'))).toBe(false);
    expect(await recordAccountFailure(s, sink, QQ, new Error('ETIMEDOUT'))).toBe(true);
  });

  it('does not repeat alerts during the cooldown', async () => {
    const s = store();
    const sink = new RecordingSink();
    for (let i = 0; i < 5; i += 1) await recordAccountFailure(s, sink, GMAIL, new Error('invalid_grant'));
    expect(sink.pushed).toHaveLength(1);
  });

  it('alerts again after the cooldown expires', async () => {
    const s = store();
    const sink = new RecordingSink();
    await recordAccountFailure(s, sink, GMAIL, new Error('invalid_grant'));
    s.setMeta(ALERTED_AT_KEY + GMAIL.username, new Date(Date.now() - 7 * 3_600_000).toISOString());
    await recordAccountFailure(s, sink, GMAIL, new Error('invalid_grant'));
    expect(sink.pushed).toHaveLength(2);
  });

  it('explains what is no longer being monitored', async () => {
    const s = store();
    const sink = new RecordingSink();
    await recordAccountFailure(s, sink, QQ, new Error('authentication failed'));
    expect(sink.pushed[0]![0].body).toContain('including spam');
  });

  it('mentions the Gmail seven-day testing trap in the recovery advice', async () => {
    const s = store();
    const sink = new RecordingSink();
    await recordAccountFailure(s, sink, GMAIL, new Error('invalid_grant'));
    const body = sink.pushed[0]![0].body;
    expect(body).toContain('7 days');
    expect(body).toContain('Testing');
  });

  it('mentions the Outlook IMAP switch first in the recovery advice', async () => {
    const s = store();
    const sink = new RecordingSink();
    await recordAccountFailure(s, sink, OUTLOOK, new Error('invalid_grant'));
    const body = sink.pushed[0]![0].body;
    expect(body).toContain('Forwarding and IMAP');
    expect(body).toContain('disabled by default');
  });

  it('includes the IMAP check for every provider', async () => {
    // Most mailboxes disable IMAP by default, making it the most common setup issue.
    const s = store();
    const sink = new RecordingSink();
    await recordAccountFailure(s, sink, QQ, new Error('login failed'));
    expect(sink.pushed[0]![0].body).toContain('IMAP');
  });

  it('sends a recovery notification', async () => {
    const s = store();
    const sink = new RecordingSink();
    await recordAccountFailure(s, sink, GMAIL, new Error('invalid_grant'));
    expect(await recordAccountSuccess(s, sink, GMAIL)).toBe(true);
    expect(sink.pushed[1]![0].subject).toContain('recovered');
  });

  it('does not notify when a transient failure recovers', async () => {
    process.env.ACCOUNT_ALERT_AFTER_FAILURES = '2';
    const s = store();
    const sink = new RecordingSink();
    await recordAccountFailure(s, sink, QQ, new Error('ETIMEDOUT'));
    expect(await recordAccountSuccess(s, sink, QQ)).toBe(false);
    expect(sink.pushed).toHaveLength(0);
  });

  it('does not emit messages for a continuously healthy account', async () => {
    const sink = new RecordingSink();
    expect(await recordAccountSuccess(store(), sink, QQ)).toBe(false);
    expect(sink.pushed).toHaveLength(0);
  });
});

describe('LLM outages', () => {
  it('alerts only after reaching the threshold', async () => {
    process.env.LLM_ALERT_AFTER_FAILURES = '2';
    const s = store();
    const sink = new RecordingSink();
    expect(await recordLlmFailure(s, sink, new Error('HTTP 401'))).toBe(false);
    expect(await recordLlmFailure(s, sink, new Error('HTTP 401'))).toBe(true);
    expect(sink.pushed[0]![1].importance).toBe('critical');
  });

  it('explains the consequences of fallback instead of only reporting the error', async () => {
    process.env.LLM_ALERT_AFTER_FAILURES = '1';
    const s = store();
    const sink = new RecordingSink();
    await recordLlmFailure(s, sink, new Error('HTTP 401 invalid api key'));
    const body = sink.pushed[0]![0].body;
    expect(body).toContain('keyword fallback');
    expect(body).toContain('daily digest');
    expect(body).toContain('401');
  });

  it('enforces the cooldown', async () => {
    process.env.LLM_ALERT_AFTER_FAILURES = '1';
    const s = store();
    const sink = new RecordingSink();
    for (let i = 0; i < 6; i += 1) await recordLlmFailure(s, sink, new Error('x'));
    expect(sink.pushed).toHaveLength(1);
  });

  it('points to the digest for review in the recovery notice', async () => {
    process.env.LLM_ALERT_AFTER_FAILURES = '1';
    const s = store();
    const sink = new RecordingSink();
    await recordLlmFailure(s, sink, new Error('x'));
    s.setMeta(LLM_ALERTED_AT_KEY, new Date().toISOString());
    expect(await recordLlmSuccess(s, sink)).toBe(true);
    expect(sink.pushed[1]![0].body).toContain('digest');
  });
});

describe('startup failures', () => {
  it('explains that nothing is being monitored and gives a check command', async () => {
    process.env.STATE_DB_PATH = ':memory:';
    const sink = new RecordingSink();
    expect(await recordStartupFailure(new Error('MAIL_ACCOUNT_1 格式不对'), sink)).toBe(true);
    const body = sink.pushed[0]![0].body;
    expect(body).toContain('will be checked');
    expect(body).toContain('--check');
  });

  it('logs without masking the original error when no sink is configured', async () => {
    process.env.STATE_DB_PATH = ':memory:';
    const sink = new RecordingSink();
    sink.configured = false;
    expect(await recordStartupFailure(new Error('x'), sink)).toBe(false);
  });
});
