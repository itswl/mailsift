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
import type { MailRow, SentAddress, SentRow } from './services/state.js';

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

/** When a stored message is dated, received or sent. */
const dateOf = (entry: { kind: 'in'; row: MailRow } | { kind: 'out'; sent: SentRow }): string =>
  entry.kind === 'in' ? entry.row.mailDate ?? entry.row.createdAt : entry.sent.date ?? entry.sent.createdAt;

const people = (list: readonly SentAddress[]): string =>
  list.map((p) => (p.name ? `${p.name} <${p.address}>` : p.address)).join(', ');

/** A subject without its "Re:" and "Fwd:", to tell a new subject from the same one answered. */
function bareSubject(value: string | null): string {
  let subject = (value ?? '').trim();
  for (let i = 0; i < 5; i += 1) {
    const next = subject.replace(/^(re|fwd?|fw|aw|wg|sv|vs|回复|答复|回覆|转发|轉發)\s*(\[\d+\])?\s*[:：]\s*/i, '');
    if (next === subject) break;
    subject = next;
  }
  return subject.toLowerCase();
}

/** One of the owner's own messages, as a section of the thread page; its subject only when it says something new. */
function sentToMarkdown(sent: SentRow, threadSubject: string | null): string {
  const lines = [
    '- Sent by: the owner (this is their own message)',
    line('Mailbox', sent.accountLabel ? `${sent.accountLabel} (${sent.account})` : sent.account),
    line('To', people(sent.to)),
    line('Cc', people(sent.cc)),
    line('Bcc', people(sent.bcc)),
    line('Date', sent.date ?? sent.createdAt),
    line('Subject', bareSubject(sent.subject) !== bareSubject(threadSubject) ? sent.subject : null),
    line('Files', sent.attachmentCount ? (sent.attachmentNames.length ? sent.attachmentNames.join(', ') : String(sent.attachmentCount)) : null),
    line('Message id', `\`${sent.messageId}\``),
  ].filter((l): l is string => l !== null);
  lines.push('', '### What the owner wrote', '', sent.text.trim() || '_(nothing of their own: the message only quoted or forwarded)_');
  lines.push('', '_Stored text, without the quoted history, bounded. Kept for the conversation only._');
  return lines.join('\n');
}

/**
 * A whole conversation as one page: the thread key, then each message in
 * turn, oldest first. The owner's own messages, stored from Sent and from
 * what was sent through mailsift, are among them and say so.
 */
export function threadToMarkdown(threadKey: string, rows: readonly MailRow[], sent: readonly SentRow[] = [], omitted = 0): string {
  const ordered = [
    ...rows.map((row) => ({ kind: 'in' as const, row })),
    ...sent.map((s) => ({ kind: 'out' as const, sent: s })),
  ].sort((a, b) => (Date.parse(dateOf(a)) || 0) - (Date.parse(dateOf(b)) || 0));
  const first = ordered.find((entry) => entry.kind === 'in') as { kind: 'in'; row: MailRow } | undefined;
  const subject = first?.row.subject ?? (ordered[0]?.kind === 'out' ? ordered[0].sent.subject : null) ?? null;
  const head = [
    title(subject),
    '',
    `- Thread key: \`${threadKey}\``,
    `- Messages: ${ordered.length}${sent.length ? ` (${sent.length} sent by the owner)` : ''}`,
    ...(omitted > 0 ? [`- Older messages not shown: ${omitted} (this page holds the newest)`] : []),
  ];
  if (ordered.length === 0) return `${[...head, '', '_(no messages)_'].join('\n')}\n`;

  const sections = ordered.map((entry, index) => {
    const when = dateOf(entry);
    if (entry.kind === 'out') {
      const to = people(entry.sent.to) || people(entry.sent.cc) || people(entry.sent.bcc) || 'nobody named';
      return `\n## ${index + 1}. From the owner to ${to} on ${when}\n\n${sentToMarkdown(entry.sent, subject)}`;
    }
    const row = entry.row;
    const sender = row.senderName || row.sender || 'unknown sender';
    // The per-message title is already in the heading, so the record's own is dropped.
    const body = mailRecordToMarkdown(row).split('\n').slice(1).join('\n').trim();
    return `\n## ${index + 1}. From ${sender} on ${when}\n\n${body}`;
  });
  return `${head.join('\n')}\n${sections.join('\n')}\n`;
}
