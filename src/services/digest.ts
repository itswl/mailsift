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
/**
 * Backstop on how many entries are worth reading at once. The character budget
 * below is the real limit; this only guards against a flood of very short
 * entries turning the card into a wall.
 */
const MAX_INBOX_LINES = 50;
/**
 * Characters the rendered digest may use.
 *
 * The line caps above decide how much is worth reading; this one decides how
 * much the delivery channel can carry. Without it the two disagreed: the line
 * caps appended "N more" notices at the very end and the card then sliced the
 * text at a fixed width, so the notices were always the first thing lost and a
 * truncated digest looked like a complete one. Kept well under the Feishu card
 * budget so the slice there is a safety net rather than the real limit.
 */
export const DIGEST_MAX_CHARS = 4000;
/** Room held back so the closing notice always fits, however tight the budget. */
const CLOSING_RESERVE = 160;

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
  threadKey?: string;
  threadCount: number;
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
    ...(message.threadKey ? { threadKey: message.threadKey } : {}),
    threadCount: 1,
    date: message.date,
  };
}

function line(item: DigestItem): string {
  const sender = item.fromName || item.from || 'Unknown sender';
  const gist = (item.summary || '').trim();
  const shown = gist.length > 90 ? `${gist.slice(0, 90)}…` : gist;
  const marker = item.actionRequired ? '⚠️ ' : '';
  const count = item.threadCount > 1 ? ` (${item.threadCount} messages)` : '';
  return `- ${marker}**${markdownText(sender)}**: ${markdownText(shown)}${count}${item.deadline ? ` ⏰${markdownText(item.deadline)}` : ''}`;
}

function collapseThreads(items: DigestItem[]): DigestItem[] {
  const grouped = new Map<string, DigestItem>();
  for (const [index, item] of items.entries()) {
    const key = item.threadKey || `unthreaded-${index}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...item, threadCount: item.threadCount || 1 });
      continue;
    }
    existing.threadCount += item.threadCount || 1;
    if (item.date > existing.date) grouped.set(key, { ...item, threadCount: existing.threadCount });
  }
  return [...grouped.values()];
}

/**
 * Key for "this is the same recurring event".
 *
 * Automated senders put the volatile part of a notification in a trailing
 * identifier: a commit, a run number, an order. Strip it and ten CI failures
 * for one workflow line up behind one key, while a different workflow or a
 * different sender stays separate. Category is part of the key so unrelated
 * mail cannot merge just because its subject rhymes.
 */
function repeatKey(item: DigestItem): string {
  const subject = item.subject
    .replace(/\s*\((?:[0-9a-f]{6,40}|\d{3,})\)\s*$/i, '')
    .trim()
    .toLowerCase();
  return `${item.from.trim().toLowerCase()}|${item.category}|${subject}`;
}

/**
 * Fold repeats of one event into a single entry carrying the newest wording.
 *
 * collapseThreads only joins messages that reply to each other. Automated
 * notifications rarely do: every workflow run opens its own thread, so a day
 * of a failing pipeline arrived as dozens of separate lines that said the same
 * thing. Runs after thread collapsing, so a real conversation is still one unit
 * before repeats are considered.
 */
function collapseRepeats(items: DigestItem[]): DigestItem[] {
  /**
   * Which occurrence speaks for the group.
   *
   * The one that most deserves attention, so a later harmless repeat can never
   * bury an earlier one that needs action. Newest wins when they are equally
   * urgent, since that describes the current state of a recurring event.
   */
  const representative = (a: DigestItem, b: DigestItem): DigestItem => {
    if (urgency(a) !== urgency(b)) return urgency(a) > urgency(b) ? a : b;
    return a.date >= b.date ? a : b;
  };

  const grouped = new Map<string, DigestItem>();
  for (const item of items) {
    const key = repeatKey(item);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...item });
      continue;
    }
    grouped.set(key, {
      ...representative(existing, item),
      threadCount: existing.threadCount + item.threadCount,
    });
  }
  return [...grouped.values()];
}

function urgency(item: DigestItem): number {
  const importance = item.importance === 'critical' ? 2 : item.importance === 'warning' ? 1 : 0;
  return importance + (item.actionRequired ? 1 : 0);
}

export function renderDigest(items: DigestItem[], maxChars = DIGEST_MAX_CHARS): string {
  if (items.length === 0) return 'No messages require review from the past day.';

  const visibleItems = collapseRepeats(collapseThreads(items));

  const spam = visibleItems.filter((i) => i.inSpam);
  const inbox = visibleItems.filter((i) => !i.inSpam);

  const counts = new Map<string, number>();
  for (const item of visibleItems) {
    const key = item.category || 'Uncategorized';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const lines = [
    `**${items.length} messages**  ${visibleItems.length} entries · inbox ${inbox.length} · spam ${spam.length}`,
    ordered.slice(0, 8).map(([name, n]) => `${markdownText(name)} ${n}`).join('  '),
  ];

  let used = lines.reduce((n, l) => n + l.length + 1, 0);
  // Counted in messages, not entries: one entry can stand for a dozen repeats,
  // so counting entries would understate what the reader is not seeing.
  let omittedMessages = 0;
  const messagesIn = (group: DigestItem[]): number => group.reduce((n, i) => n + Math.max(1, i.threadCount), 0);
  /** Add a line unless it would eat into the room held for the closing notice. */
  const push = (text: string): boolean => {
    if (used + text.length + 1 > maxChars - CLOSING_RESERVE) return false;
    lines.push(text);
    used += text.length + 1;
    return true;
  };

  // Put spam first: it is easiest to miss and the main reason for the digest.
  if (spam.length) {
    push('');
    push(`**⚠️ Spam (${spam.length}; review provider-filtered messages)**`);
    let shownSpam = 0;
    for (const item of spam.slice(0, MAX_SPAM_LINES)) {
      if (!push(line(item))) break;
      shownSpam += 1;
    }
    omittedMessages += messagesIn(spam.slice(shownSpam));
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
    let budgetSpent = false;
    for (const [category, group] of groups) {
      if (remaining <= 0 || budgetSpent) {
        droppedCategories += 1;
        omittedMessages += messagesIn(group);
        continue;
      }
      const orderedItems = [...group].sort((a, b) =>
        urgency(b) - urgency(a) || Number(Boolean(b.deadline)) - Number(Boolean(a.deadline)) ||
        b.date.localeCompare(a.date),
      );
      const allowed = Math.min(group.length, remaining);
      if (!push('') || !push(`**${markdownText(category)} (${messagesIn(group)})**`)) {
        budgetSpent = true;
        droppedCategories += 1;
        omittedMessages += messagesIn(group);
        continue;
      }
      let shown = 0;
      for (const item of orderedItems.slice(0, allowed)) {
        if (!push(line(item))) {
          budgetSpent = true;
          break;
        }
        shown += 1;
      }
      remaining -= shown;
      omittedMessages += messagesIn(orderedItems.slice(shown));
    }
    if (droppedCategories) {
      lines.push('', `_${droppedCategories} more categories omitted_`);
    }
  }

  // Always the last word, and always inside the reserved room: a digest that
  // simply stops must never look like a complete one.
  if (omittedMessages > 0) {
    lines.push('', `_${omittedMessages} more messages not shown; use MCP list_digest or list_mail to see them_`);
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

  const sent = (await sink.push(message, result)) === 'delivered';
  if (sent) {
    state.clearDigest(entries.map((entry) => entry.dedupKey));
    state.setMeta(DIGEST_SENT_KEY, today);
  }
  log.info(`Digest sent: ${items.length} messages (success=${sent})`);
  return sent;
}
