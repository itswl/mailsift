/**
 * Stored triage records as markdown, for the resource views.
 *
 * The tools keep returning JSON, which is what an application parses. This is
 * the reading form of the same record: a model spends fewer tokens on it and
 * does not have to be told which field means what, because the headings say so.
 * It is a view, never a second shape, so nothing is computed here that the
 * record does not already carry.
 *
 * Pure. Everything stored is mail-derived text, so it is written as-is; a model
 * reads this, and escaping would only make the content harder to follow.
 */
import type { MailRow } from './services/state.js';

/** A field is omitted entirely rather than rendered as an empty bullet. */
function line(label: string, value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  return text === '' ? null : `- ${label}: ${text}`;
}

function title(subject: string | null): string {
  const oneLine = (subject ?? '').replace(/\s+/g, ' ').trim();
  return `# ${oneLine || '(no subject)'}`;
}

/** Spam and a missing push are the two things worth seeing before the summary. */
function flags(row: MailRow): string | null {
  const set: string[] = [];
  if (row.inSpam) set.push('filed as spam');
  set.push(row.pushed ? 'notified in real time' : 'not notified, carried by the daily digest');
  if (row.verificationCode) set.push('carries a verification code');
  return `- Delivery: ${set.join('; ')}`;
}

/**
 * One stored judgement as markdown. The body preview is labelled as bounded,
 * so a model knows to read mailsift://imap/... when it needs the whole message.
 */
export function mailRecordToMarkdown(row: MailRow): string {
  const judgement = [row.importance, row.category].filter((v) => (v ?? '') !== '').join(' · ');
  const lines = [
    title(row.subject),
    '',
    ...[
      line('From', row.senderName ? `${row.senderName} <${row.sender ?? ''}>` : row.sender),
      line('Mailbox', row.accountLabel ? `${row.accountLabel} (${row.account})` : row.account),
      line('Folder', row.folder),
      line('Date', row.mailDate ?? row.createdAt),
      line('Judged', judgement || null),
      line('Decided by', row.decidedBy),
      line('Deadline', row.deadline),
      flags(row),
      line('Message id', row.messageId ? `\`${row.messageId}\`` : null),
      line('Thread key', row.threadKey ? `\`${row.threadKey}\`` : null),
    ].filter((l): l is string => l !== null),
  ];

  if ((row.summary ?? '').trim() !== '') lines.push('', '## Summary', '', row.summary!.trim());
  if ((row.reason ?? '').trim() !== '') lines.push('', '## Why it was judged so', '', row.reason!.trim());

  if ((row.snippet ?? '').trim() !== '') {
    lines.push(
      '',
      '## Body preview',
      '',
      row.snippet!.trim(),
      '',
      '_Bounded preview of the stored text. Read `mailsift://imap/{account}/{messageId}` for the message itself._',
    );
  }

  const files = row.attachmentManifest?.items ?? [];
  if (files.length > 0) {
    lines.push('', '## Attachments', '');
    for (const file of files) {
      const size = typeof file.sizeBytes === 'number' ? `, ${file.sizeBytes} bytes` : '';
      const cautions = file.safetyWarnings?.length ? `, caution: ${file.safetyWarnings.join(', ')}` : '';
      lines.push(
        `- ${file.filename || '(unnamed)'} (${file.contentType || 'unknown type'}${size}, part \`${file.partId}\`${cautions})`,
      );
    }
    if (row.attachmentManifest?.truncated) lines.push('- _(the list was truncated at the stored limit)_');
    lines.push('', '_Names and types only. `list_attachments` fetches a file from the mailbox on demand._');
  }

  return `${lines.join('\n')}\n`;
}

/** Oldest first, so a conversation reads top to bottom. */
function byDate(a: MailRow, b: MailRow): number {
  const key = (row: MailRow) => Date.parse(row.mailDate ?? row.createdAt) || 0;
  return key(a) - key(b);
}

/** A whole conversation as one page: the thread key, then each judgement in turn. */
export function threadToMarkdown(threadKey: string, rows: readonly MailRow[]): string {
  const ordered = [...rows].sort(byDate);
  const head = [
    title(ordered[0]?.subject ?? null),
    '',
    `- Thread key: \`${threadKey}\``,
    `- Messages: ${ordered.length}`,
  ];
  if (ordered.length === 0) return `${[...head, '', '_(no messages)_'].join('\n')}\n`;

  const sections = ordered.map((row, index) => {
    const sender = row.senderName || row.sender || 'unknown sender';
    const when = row.mailDate ?? row.createdAt;
    // The per-message title is already in the heading, so the record's own is dropped.
    const body = mailRecordToMarkdown(row).split('\n').slice(1).join('\n').trim();
    return `\n## ${index + 1}. From ${sender} on ${when}\n\n${body}`;
  });
  return `${head.join('\n')}\n${sections.join('\n')}\n`;
}
