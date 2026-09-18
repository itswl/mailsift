/**
 * Daily digest: collect messages that do not need real-time interruption.
 *
 * The digest is the main review surface on a phone, so each line shows a summary
 * instead of a subject. Subjects often omit the useful context.
 */
import type { MailMessage } from '../imap/message.js';
import { headline, type TriageResult } from './triage.js';
import type { Sink } from './sink.js';
import type { StateStore } from './state.js';
import { getLogger } from '../logger.js';

const log = getLogger('digest');

export const DIGEST_SENT_KEY = 'digest_last_sent_date';
const MAX_SPAM_LINES = 15;
const MAX_INBOX_LINES = 35;

export interface DigestItem {
  accountLabel: string;
  folder: string;
  inSpam: boolean;
  subject: string;
  from: string;
  fromName: string;
  importance: string;
  category: string;
  summary: string;
  deadline: string;
  actionRequired: boolean;
  date: string;
}

export function toDigestItem(message: MailMessage, result: TriageResult): DigestItem {
  return {
    accountLabel: message.accountLabel,
    folder: message.folder,
    inSpam: message.inSpam,
    subject: message.subject || '(no subject)',
    from: message.fromAddr,
    fromName: message.fromName,
    importance: result.importance,
    category: result.category,
    summary: headline(result),
    deadline: result.deadline,
    actionRequired: result.actionRequired,
    date: message.date,
  };
}

function line(item: DigestItem): string {
  const sender = item.fromName || item.from || 'Unknown sender';
  const gist = (item.summary || '').trim();
  const shown = gist.length > 90 ? `${gist.slice(0, 90)}…` : gist;
  const marker = item.actionRequired ? '⚠️ ' : '';
  return `- ${marker}**${markdownText(sender)}**: ${markdownText(shown)}${item.deadline ? ` ⏰${markdownText(item.deadline)}` : ''}`;
}

function urgency(item: DigestItem): number {
  const importance = item.importance === 'critical' ? 2 : item.importance === 'warning' ? 1 : 0;
  return importance + (item.actionRequired ? 1 : 0);
}

export function renderDigest(items: DigestItem[]): string {
  if (items.length === 0) return 'No messages require review from the past day.';

  const spam = items.filter((i) => i.inSpam);
  const inbox = items.filter((i) => !i.inSpam);

  const counts = new Map<string, number>();
  for (const item of items) {
    const key = item.category || 'Uncategorized';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const lines = [
    `**${items.length} messages**  inbox ${inbox.length} · spam ${spam.length}`,
    ordered.slice(0, 8).map(([name, n]) => `${markdownText(name)} ${n}`).join('  '),
  ];

  // Put spam first: it is easiest to miss and the main reason for the digest.
  if (spam.length) {
    lines.push('', `**⚠️ Spam (${spam.length}; review provider-filtered messages)**`);
    for (const item of spam.slice(0, MAX_SPAM_LINES)) lines.push(line(item));
    if (spam.length > MAX_SPAM_LINES) lines.push(`- …${spam.length - MAX_SPAM_LINES} more`);
  }

  if (inbox.length) {
    const grouped = new Map<string, DigestItem[]>();
    for (const item of inbox) {
      const key = item.category || 'Uncategorized';
      (grouped.get(key) ?? grouped.set(key, []).get(key)!).push(item);
    }
    const groups = [...grouped.entries()].sort((a, b) => {
      const aUrgency = Math.max(...a[1].map(urgency));
      const bUrgency = Math.max(...b[1].map(urgency));
      return bUrgency - aUrgency || b[1].length - a[1].length || a[0].localeCompare(b[0]);
    });

    let remaining = MAX_INBOX_LINES;
    let droppedCategories = 0;
    for (const [category, group] of groups) {
      if (remaining <= 0) {
        droppedCategories += 1;
        continue;
      }
      lines.push('', `**${markdownText(category)} (${group.length})**`);
      const shown = Math.min(group.length, remaining);
      const orderedItems = [...group].sort((a, b) =>
        urgency(b) - urgency(a) || Number(Boolean(b.deadline)) - Number(Boolean(a.deadline)) ||
        b.date.localeCompare(a.date),
      );
      for (const item of orderedItems.slice(0, shown)) lines.push(line(item));
      remaining -= shown;
      if (group.length > shown) lines.push(`- …${group.length - shown} more in this category`);
    }
    if (droppedCategories) {
      lines.push('', `_${droppedCategories} more categories omitted; use MCP list_mail to view all_`);
    }
  }

  return lines.join('\n');
}

function markdownText(value: string): string {
  return value.replace(/[\\`*_~\[\]]/g, '\\$&');
}

export function shouldSend(state: StateStore, at: Date = new Date()): boolean {
  if ((process.env.DIGEST_ENABLED ?? 'true').toLowerCase() === 'false') return false;
  if (at.getHours() < Number(process.env.DIGEST_HOUR ?? 9)) return false;
  return state.getMeta(DIGEST_SENT_KEY) !== at.toISOString().slice(0, 10);
}

/** Send the digest and record the date, including when the queue is empty. */
export async function sendDigest(state: StateStore, sink: Sink, at: Date = new Date()): Promise<boolean> {
  const today = at.toISOString().slice(0, 10);
  const entries = state.peekDigestEntries();
  const items = entries.map((entry) => entry.payload) as DigestItem[];

  if (items.length === 0) {
    log.info('Digest queue is empty; skipping.');
    state.setMeta(DIGEST_SENT_KEY, today);
    return false;
  }

  const spamCount = items.filter((i) => i.inSpam).length;
  const message: MailMessage = {
    account: 'mailsift',
    accountLabel: 'Daily digest',
    provider: '',
    folder: 'digest',
    inSpam: false,
    uid: 0,
    messageId: `<digest-${today}@mailsift>`,
    subject: `Daily mail digest · ${items.length} messages (spam ${spamCount})`,
    fromAddr: 'digest@mailsift',
    fromName: 'mailsift',
    toAddrs: [],
    date: at.toISOString(),
    body: renderDigest(items),
    hasAttachments: false,
    listUnsubscribe: false,
    extra: { digest: true },
  };
  const result: TriageResult = {
    importance: 'info',
    score: 0,
    summary: '',
    reason: `${today} daily digest: ${items.length} messages, including ${spamCount} spam`,
    deadline: '',
    category: 'Daily digest',
    actionRequired: false,
    decidedBy: 'digest',
  };

  const sent = await sink.push(message, result);
  if (sent) {
    state.clearDigest(entries.map((entry) => entry.dedupKey));
    state.setMeta(DIGEST_SENT_KEY, today);
  }
  log.info(`Digest sent: ${items.length} messages (success=${sent})`);
  return sent;
}
