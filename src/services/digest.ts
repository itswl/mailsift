/**
 * Daily digest: collect messages that do not need real-time interruption.
 *
 * The digest is the main review surface on a phone, so each line shows a summary
 * instead of a subject. Subjects often omit the useful context.
 */
import { SENSITIVE_WORDS, sensitiveKindOf, type MailMessage } from '../imap/message.js';
import { headline, sensitiveWords, type TriageResult } from './triage.js';
import type { Sink } from './sink.js';
import type { StateStore } from './state.js';
import { getLogger } from '../logger.js';

const log = getLogger('digest');

export const DIGEST_SENT_KEY = 'digest_last_sent_date';
/**
 * The local calendar date of the last send, then the UTC date written with it:
 * "2026-11-04 2026-11-03".
 *
 * The hour that lets a digest go out is local (DIGEST_HOUR against the
 * server's clock), so "already sent today" must be counted on the same
 * calendar. DIGEST_SENT_KEY holds the UTC date and is still written for
 * anything that reads it. Comparing a local hour with that UTC date held the
 * digest back until the UTC date changed whenever the hour fell before the
 * local time of UTC midnight (before 08:00 in UTC+8, before 19:00 or 20:00 in
 * New York), and sent it twice on a first day or after a day without polls.
 */
export const DIGEST_SENT_LOCAL_KEY = 'digest_last_sent_local_date';

/** YYYY-MM-DD on the server's own calendar. */
function localDay(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * The local date of the last send, when the local record can be trusted: it
 * was written together with the UTC date that is still on record. A release
 * from before the local record wrote only the UTC date, so after a rollback
 * and an upgrade again the UTC date has moved on and the local one is stale.
 */
function localRecord(state: StateStore): string | undefined {
  const [local, utc] = (state.getMeta(DIGEST_SENT_LOCAL_KEY) ?? '').split(' ');
  return local && utc === state.getMeta(DIGEST_SENT_KEY) ? local : undefined;
}

/**
 * Whether today's digest has gone out.
 *
 * Without a trusted local record (a database from before 0.1.98, or one an
 * older release has sent from since) the UTC date is read with its old meaning
 * until the next send writes both. The first digest after an upgrade therefore
 * goes out when the old rule would have sent it, which in the setups that rule
 * got wrong can be later than DIGEST_HOUR, or a second time that day when the
 * upgrade lands between the old rule's two sends. From then on it goes out
 * once a day at the hour.
 */
function sentToday(state: StateStore, at: Date): boolean {
  const local = localRecord(state);
  if (local === undefined) return state.getMeta(DIGEST_SENT_KEY) === at.toISOString().slice(0, 10);
  return local === localDay(at);
}

/**
 * Record a send (or a skipped empty queue) on both calendars, in one
 * statement: a record half written would let the old rule decide again.
 */
export function markDigestSent(state: StateStore, at: Date): void {
  const utc = at.toISOString().slice(0, 10);
  state.setMetas([[DIGEST_SENT_KEY, utc], [DIGEST_SENT_LOCAL_KEY, `${localDay(at)} ${utc}`]]);
}

const DEFAULT_DIGEST_HOUR = 9;
/**
 * DIGEST_HOUR as the whole hour it is used as everywhere: an integer from 0
 * to 23. Anything else is ignored in favour of the documented default, 9, and
 * reported by --check, so the page never promises an hour the scheduler does
 * not use.
 */
export function digestHour(): { hour: number; invalid?: string } {
  const raw = process.env.DIGEST_HOUR?.trim();
  if (!raw) return { hour: DEFAULT_DIGEST_HOUR };
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 && value <= 23
    ? { hour: value }
    : { hour: DEFAULT_DIGEST_HOUR, invalid: raw };
}

function digestEnabled(): boolean {
  return (process.env.DIGEST_ENABLED ?? 'true').toLowerCase() !== 'false';
}

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
/**
 * Smallest budget the guarantee holds for.
 *
 * The heading and the closing notice are not optional, so below this there is
 * nothing left to cut. A smaller request is treated as this rather than
 * silently overrun.
 */
const MIN_DIGEST_CHARS = 400;

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
  const kind = result.sensitiveKind ?? sensitiveKindOf(message.subject, message.body);
  const sensitiveVerification = Boolean(result.sensitiveVerification || kind);
  const words = sensitiveWords(message, result);
  return {
    accountLabel: message.accountLabel,
    folder: message.folder,
    inSpam: message.inSpam,
    subject: sensitiveVerification ? words.subject : message.subject || '(no subject)',
    from: message.fromAddr,
    fromName: message.fromName,
    importance: result.importance,
    category: sensitiveVerification ? 'Security' : result.category,
    summary: sensitiveVerification ? words.summary : headline(result),
    deadline: sensitiveVerification ? '' : result.deadline,
    actionRequired: sensitiveVerification ? !result.sensitiveUnasked : result.actionRequired,
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
  // The spam flag is part of the key. Folding a quarantined copy into an inbox
  // entry made it inherit inSpam:false, and the spam section — the one thing
  // this digest exists to surface — stopped being rendered at all.
  // Scoped to one mailbox, like threadKey and dedupKey. Folding across
  // mailboxes hid that an alert had reached both of them, and under-merging is
  // the safer direction here as it is everywhere else in this key.
  const where = item.inSpam ? 'spam' : 'inbox';
  return `${item.accountLabel}|${where}|${item.from.trim().toLowerCase()}|${item.category}|${withoutBuildSuffix(item.subject)}`;
}

/**
 * Drop a trailing identifier only when it looks like a hash.
 *
 * Hex and long enough, and containing a letter. A plain number is far more
 * likely to be a business identifier, and merging on one is the dangerous
 * direction: three invoices, or two years of the same annual report, would
 * become a single line. Under-merging costs a line; over-merging can hide a
 * payment. Measured against a real mailbox, requiring the letter collapses 62
 * of 67 build notifications and loses one entry out of fifty.
 */
function withoutBuildSuffix(subject: string): string {
  return subject
    .replace(/\s*\(([0-9a-f]{6,40})\)\s*$/i, (whole, token: string) => (/[a-f]/i.test(token) ? '' : whole))
    .trim()
    .toLowerCase();
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

  // Counted in messages, like the section headings below. Counting entries here
  // put two different numbers for one category in the same card.
  const counts = new Map<string, number>();
  for (const item of visibleItems) {
    const key = item.category || 'Uncategorized';
    counts.set(key, (counts.get(key) ?? 0) + Math.max(1, item.threadCount));
  }
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const lines = [
    `**${items.length} messages**  ${visibleItems.length} entries · inbox ${inbox.length} · spam ${spam.length}`,
    ordered.slice(0, 8).map(([name, n]) => `${markdownText(name)} ${n}`).join('  '),
  ];

  const budget = Math.max(maxChars, MIN_DIGEST_CHARS);
  let used = lines.reduce((n, l) => n + l.length + 1, 0);
  // Counted in messages, not entries: one entry can stand for a dozen repeats,
  // so counting entries would understate what the reader is not seeing.
  let omittedMessages = 0;
  const messagesIn = (group: DigestItem[]): number => group.reduce((n, i) => n + Math.max(1, i.threadCount), 0);
  const fits = (cost: number): boolean => used + cost <= budget - CLOSING_RESERVE;
  /** Add a line unless it would eat into the room held for the closing notice. */
  const push = (text: string): boolean => {
    if (!fits(text.length + 1)) return false;
    lines.push(text);
    used += text.length + 1;
    return true;
  };

  // Put spam first: it is easiest to miss and the main reason for the digest.
  if (spam.length) {
    push('');
    push(`**⚠️ Spam (${messagesIn(spam)}; review provider-filtered messages)**`);
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
      const heading = `**${markdownText(category)} (${messagesIn(group)})**`;
      // Blank line, heading and the first entry are checked together. Checking
      // only the heading left sections that announced a count and then showed
      // nothing, and undercounted droppedCategories as well.
      const firstLine = line(orderedItems[0]!);
      if (!fits(1 + heading.length + 1 + firstLine.length + 1)) {
        budgetSpent = true;
        droppedCategories += 1;
        omittedMessages += messagesIn(group);
        continue;
      }
      push('');
      push(heading);
      let shown = 0;
      for (const item of orderedItems.slice(0, allowed)) {
        if (!push(line(item))) {
          budgetSpent = true;
          break;
        }
        shown += 1;
      }
      remaining -= shown;
      const hidden = messagesIn(orderedItems.slice(shown));
      omittedMessages += hidden;
      // Say it at the cut as well. A reader scanning one section could not
      // otherwise tell that section was incomplete; the closing line is the
      // guarantee, this is the signpost, so a budget refusal here is fine.
      if (hidden > 0) push(`- …${hidden} more in this category`);
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
  if (!digestEnabled()) return false;
  if (at.getHours() < digestHour().hour) return false;
  return !sentToday(state, at);
}

/**
 * When the next digest is due, by the rule shouldSend applies: the first poll at
 * or after DIGEST_HOUR, on a day it has not gone out yet. Null when it is off.
 * A digest already due but not yet sent reports today's hour, which is when it
 * became due.
 */
export function nextDigestAt(state: StateStore, now: Date = new Date()): Date | null {
  if (!digestEnabled()) return null;
  const { hour } = digestHour();
  const at = new Date(now);
  at.setHours(hour, 0, 0, 0);
  if (!sentToday(state, now)) return at;
  if (localRecord(state) !== undefined) {
    // The day first, then the hour: set on a spring-forward day, an hour that
    // does not exist would carry over to tomorrow as the next hour.
    at.setDate(at.getDate() + 1);
    at.setHours(hour, 0, 0, 0);
    return at;
  }
  // Read the old way, today's send stands until the UTC date changes; the next
  // one is the first moment after that at or past the hour.
  const utcMidnight = new Date(now);
  utcMidnight.setUTCHours(24, 0, 0, 0);
  const thatDay = new Date(utcMidnight);
  thatDay.setHours(hour, 0, 0, 0);
  return thatDay > utcMidnight ? thatDay : utcMidnight;
}

/** Send the digest and record the date, including when the queue is empty. */
export async function sendDigest(state: StateStore, sink: Sink, at: Date = new Date()): Promise<boolean> {
  const today = localDay(at);
  const entries = state.peekDigestEntries();
  const items = entries.map((entry) => entry.payload) as DigestItem[];

  if (items.length === 0) {
    log.info('Digest queue is empty; skipping.');
    markDigestSent(state, at);
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
    // One id per send: two local days' digests can share a UTC date, and a
    // receiver that de-duplicates on the id must not drop the second.
    messageId: `<digest-${at.toISOString().replace(/[-:]|\.\d+/g, '')}@mailsift>`,
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
    // Kept so the page can still list what went out once the queue is empty.
    state.recordDigestLog(at.toISOString(), entries);
    state.clearDigest(entries.map((entry) => entry.dedupKey));
    markDigestSent(state, at);
  }
  log.info(`Digest sent: ${items.length} messages (success=${sent})`);
  return sent;
}
