import { describe, expect, it } from 'vitest';
import './setup.js';
import { mailRecordToMarkdown, threadToMarkdown } from '../src/mcp-markdown.js';
import { renderSearchSyntax } from '../src/mcp-syntax.js';
import { MCP_ERROR_CODES, McpToolError, toResourceError, toToolError } from '../src/mcp-errors.js';
import { ConfigError } from '../src/config.js';
import { CATEGORIES, RULE_CATEGORIES } from '../src/services/triage.js';
import type { MailRow } from '../src/services/state.js';

function row(over: Partial<MailRow> = {}): MailRow {
  return {
    dedupKey: 'k1', messageId: '<one@x>', threadKey: 't1', account: 'me@qq.com', accountLabel: 'QQ',
    subject: 'Invoice 42', sender: 'billing@example.com', senderName: 'Billing', folder: 'INBOX',
    inSpam: false, importance: 'critical', category: 'Finance', summary: 'Invoice 42 is due on the 30th.',
    reason: 'Names an amount and a date', deadline: '2026-11-30', decidedBy: 'llm', pushed: true,
    mailDate: '2026-11-03T08:00:00.000Z', createdAt: '2026-11-03T08:01:00.000Z',
    snippet: 'Invoice 42, CNY 496.00, due 30 November.',
    ...over,
  };
}

describe('mailRecordToMarkdown', () => {
  it('leads with the subject and labels every field it shows', () => {
    const text = mailRecordToMarkdown(row());
    expect(text.startsWith('# Invoice 42\n')).toBe(true);
    expect(text).toContain('- From: Billing <billing@example.com>');
    expect(text).toContain('- Judged: critical · Finance');
    expect(text).toContain('- Deadline: 2026-11-30');
    expect(text).toContain('## Summary');
    expect(text).toContain('## Why it was judged so');
  });

  it('says how the message was delivered, which no single field states', () => {
    expect(mailRecordToMarkdown(row())).toContain('notified in real time');
    expect(mailRecordToMarkdown(row({ pushed: false }))).toContain('carried by the daily digest');
    expect(mailRecordToMarkdown(row({ inSpam: true }))).toContain('filed as spam');
  });

  it('marks the preview as bounded so a reader knows to fetch the body', () => {
    expect(mailRecordToMarkdown(row())).toContain('mailsift://imap/{account}/{messageId}');
  });

  it('omits empty fields instead of printing blank bullets', () => {
    const text = mailRecordToMarkdown(row({ deadline: '', reason: null, snippet: null, subject: null }));
    expect(text).toContain('# (no subject)');
    expect(text).not.toContain('- Deadline:');
    expect(text).not.toContain('## Why it was judged so');
    expect(text).not.toContain('## Body preview');
  });

  it('lists attachments with their part id and any caution', () => {
    const text = mailRecordToMarkdown(row({
      attachmentManifest: {
        items: [{ partId: '2', filename: 'invoice.pdf', contentType: 'application/pdf', sizeBytes: 1024, inline: false }],
        truncated: false,
      },
    }));
    expect(text).toContain('- invoice.pdf (application/pdf, 1024 bytes, part `2`)');
  });
});

describe('threadToMarkdown', () => {
  it('numbers the messages oldest first', () => {
    const text = threadToMarkdown('t1', [
      row({ messageId: '<b@x>', mailDate: '2026-11-03T10:00:00.000Z', subject: 'Re: Invoice 42' }),
      row({ messageId: '<a@x>', mailDate: '2026-11-03T08:00:00.000Z', subject: 'Invoice 42' }),
    ]);
    expect(text).toContain('- Messages: 2');
    expect(text.indexOf('<a@x>')).toBeLessThan(text.indexOf('<b@x>'));
    expect(text).toContain('## 1. From Billing on 2026-11-03T08:00:00.000Z');
  });
});

describe('renderSearchSyntax', () => {
  it('is rendered from the vocabulary the triage code uses, so it cannot drift', () => {
    const page = renderSearchSyntax();
    for (const category of CATEGORIES) expect(page).toContain(`\`${category}\``);
    for (const label of Object.values(RULE_CATEGORIES)) expect(page).toContain(`\`${label}\``);
  });

  it('says what the store does not hold, so a caller stops asking for it', () => {
    const page = renderSearchSyntax();
    expect(page).toContain('Full message bodies');
    expect(page).toContain('Verification codes');
  });
});

describe('typed errors', () => {
  it('carries a code, a message and a hint a caller can act on', () => {
    const result = toToolError(new McpToolError('NOT_FOUND'));
    expect(result.isError).toBe(true);
    const [first, second] = result.content as Array<{ text: string }>;
    expect(JSON.parse(first!.text)).toMatchObject({ code: 'NOT_FOUND' });
    // The second block is the same thing in one line, for a person reading a log.
    expect(second!.text).toMatch(/^NOT_FOUND: /);
  });

  it('never passes an unknown throw through, because it may carry a credential', () => {
    const [first] = toToolError(new Error('LOGIN failed for Bearer sk-abcdef0123456789')).content as Array<{ text: string }>;
    const body = JSON.parse(first!.text) as { code: string; message: string };
    expect(body.code).toBe('PROVIDER_ERROR');
    expect(body.message).not.toContain('sk-abcdef');
  });

  it('redacts a credential inside a message it does keep', () => {
    const [first] = toToolError(new McpToolError('MAILBOX_UNAVAILABLE', 'refresh_token=abcdef123456 rejected')).content as Array<{ text: string }>;
    expect((JSON.parse(first!.text) as { message: string }).message).not.toContain('abcdef123456');
  });

  it('tells a broken configuration apart from a caller mistake', () => {
    const [first] = toToolError(new ConfigError('No mail accounts configured')).content as Array<{ text: string }>;
    expect(JSON.parse(first!.text)).toMatchObject({ code: 'SERVER_MISCONFIGURED' });
  });

  it('keeps the body in the data of a resource error, which has no result shape', () => {
    const error = toResourceError(new McpToolError('NOT_FOUND', 'mail record not found'));
    expect(error.message).toContain('NOT_FOUND');
    expect(error.data).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('gives every code a hint except the catch-all', () => {
    for (const code of MCP_ERROR_CODES) {
      const body = new McpToolError(code).toBody();
      if (code === 'PROVIDER_ERROR') expect(body.hint).toBeUndefined();
      else expect(body.hint).toBeTruthy();
    }
  });
});
