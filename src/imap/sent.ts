/**
 * The owner's own mail: read from each mailbox's Sent folder by the poll, and
 * recorded the moment a letter leaves from the page or through MCP.
 *
 * It is kept for the conversation and for nothing else. A sent message is
 * never judged, never shown to a model, never notified and never in a
 * digest; it is stored apart from received mail (see SentRecord) and joined
 * in only where a conversation is shown, a thread is counted, an address is
 * suggested, or an answer written elsewhere takes a message off the queue.
 *
 * Reading Sent costs the poll little and can never cost it its mail:
 *
 * - It has a cursor of its own (sent_cursors), so a Sent folder the owner
 *   also monitors as an inbound folder is read twice without either cursor
 *   moving the other.
 * - It has a budget of its own, SENT_PER_POLL per mailbox, outside
 *   MAX_MESSAGES_PER_POLL_TOTAL.
 * - The first look reaches back SENT_LOOKBACK_DAYS, newest first, at most
 *   SENT_LOOKBACK_MESSAGES messages, spread over as many polls as the budget
 *   needs; new mail is read before the rest of that look back.
 * - Of each message only its envelope, its References line, its structure
 *   and the first SENT_BITE_BYTES of its source are fetched: the text, never
 *   a whole attachment.
 * - A message that cannot be read is skipped, not a dead letter, and a Sent
 *   folder that cannot be read is logged and leaves the mailbox healthy.
 */
import type { FetchMessageObject, ImapFlow, MessageAddressObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Account } from '../config.js';
import { getLogger } from '../logger.js';
import { SENT_TEXT_CHARS, type SentAddress, type SentCursorRow, type SentRecord } from '../services/state.js';
import type { OutgoingMail } from '../smtp.js';
import { ownTextEnd } from './body.js';
import { referenceIds, threadKeyOf } from './client.js';
import { extractAttachmentManifest, fallbackMessageId, htmlToText } from './message.js';

const log = getLogger('sent');

/** Sent messages read from one mailbox in one poll: a budget of its own, small beside the inbound one. */
export const SENT_PER_POLL = 50;
/** The most the first look at a Sent folder reads, newest first, over as many polls as that takes. */
export const SENT_LOOKBACK_MESSAGES = 500;
/** How much of each sent message's source is read: its headers and its text, never a whole attachment. */
export const SENT_BITE_BYTES = 64 * 1024;
export const SENT_LOOKBACK_DEFAULT_DAYS = 30;
export const SENT_LOOKBACK_MAX_DAYS = 365;

/** SENT_MAIL_ENABLED: on unless switched off. Off, nothing new about sent mail is stored. */
export function sentMailEnabled(): boolean {
  return !['false', '0', 'no', 'off'].includes((process.env.SENT_MAIL_ENABLED ?? '').trim().toLowerCase());
}

/**
 * How far back the first look at a Sent folder reaches: SENT_LOOKBACK_DAYS,
 * 30 unless set, at most 365, and never further than the store keeps mail
 * (STATE_RETENTION_DAYS), since what is read past that is pruned the next day.
 * 0 is no look back at all: only what is sent from then on is read, and
 * nothing already sent takes a message off the queue.
 */
export function sentLookbackDays(): number {
  const raw = process.env.SENT_LOOKBACK_DAYS?.trim();
  const value = raw ? Number(raw) : SENT_LOOKBACK_DEFAULT_DAYS;
  if (value === 0) return 0;
  const days = Number.isFinite(value) && value >= 1 ? Math.min(Math.floor(value), SENT_LOOKBACK_MAX_DAYS) : SENT_LOOKBACK_DEFAULT_DAYS;
  const keep = Number(process.env.STATE_RETENTION_DAYS ?? 90);
  return Number.isFinite(keep) && keep >= 1 ? Math.min(days, Math.floor(keep)) : days;
}

/**
 * What the owner wrote in a message they sent: the text above the quoted
 * history ("On ... wrote:", "在 ... 写道：", an Outlook header block, an
 * "Original Message" rule) or above a message forwarded under it, without
 * lines quoted with `>`, bounded. Empty when they wrote nothing of their own.
 */
export function sentText(text: string): string {
  // Whitespace as normalizeWhitespace leaves it, but for the signature's
  // delimiter, whose trailing space is what makes it one.
  const lines = text.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/^(?!-- $)(.*?) +$/gm, '$1')
    .replace(/\n{3,}/g, '\n\n').trim().split('\n');
  const end = ownTextEnd(lines);
  const kept = (end === -1 ? lines : lines.slice(0, end)).filter((line) => !/^\s*>/.test(line));
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, SENT_TEXT_CHARS);
}

/** The Message-ID a message answers: its In-Reply-To, else the last of its References. */
export function answersOf(inReplyTo: string | undefined, references: readonly string[]): string | undefined {
  const replied = inReplyTo?.match(/<[^<>\s]+>/)?.[0] ?? (inReplyTo?.trim() || undefined);
  return replied || references.at(-1);
}

function addressesOf(list: readonly MessageAddressObject[] | undefined): SentAddress[] {
  const out: SentAddress[] = [];
  const taken = new Set<string>();
  for (const entry of list ?? []) {
    const address = (entry.address ?? '').trim().toLowerCase();
    if (!address.includes('@') || /[\s<>]/.test(address) || taken.has(address)) continue;
    taken.add(address);
    out.push({ name: (entry.name ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200), address: address.slice(0, 320) });
    if (out.length >= 100) break;
  }
  return out;
}

function isoOf(value: unknown): string | undefined {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : undefined;
  return date && !Number.isNaN(date.valueOf()) ? date.toISOString() : undefined;
}

/** The text of a message read from the bite of its source; '' when it cannot be parsed. */
async function biteText(source: Buffer | undefined): Promise<string> {
  if (!source?.length) return '';
  try {
    const parsed = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
    const text = parsed.text?.trim() ? parsed.text : typeof parsed.html === 'string' ? htmlToText(parsed.html) : '';
    return sentText(text);
  } catch {
    return '';
  }
}

/** The files a sent message carried: every attachment but the pictures its own markup shows. */
function filesOf(structure: FetchMessageObject['bodyStructure']): string[] {
  return extractAttachmentManifest(structure).items
    .filter((item) => !(item.inline && item.contentId && item.contentType.startsWith('image/')))
    .map((item) => item.filename ?? '');
}

/** One message read from Sent, as it is stored. */
export async function toSentRecord(raw: FetchMessageObject, account: Account, folder: string, uidValidity: string): Promise<SentRecord> {
  const envelope = raw.envelope;
  const headers = raw.headers?.toString('utf8') ?? '';
  const from = (envelope?.from ?? [])[0];
  const date = isoOf(envelope?.date) ?? isoOf(raw.internalDate);
  const messageId = envelope?.messageId?.trim() || fallbackMessageId(account.username, {
    date: date ?? '', subject: envelope?.subject ?? '', from: (from?.address ?? '').toLowerCase(), uid: raw.uid,
  });
  const files = filesOf(raw.bodyStructure);
  return {
    account: account.username,
    accountLabel: account.name,
    messageId,
    threadKey: threadKeyOf(account.username, headers, envelope?.inReplyTo, messageId),
    ...(envelope?.inReplyTo?.trim() ? { inReplyTo: envelope.inReplyTo.trim() } : {}),
    ...(answersOf(envelope?.inReplyTo, referenceIds(headers)) ? { answers: answersOf(envelope?.inReplyTo, referenceIds(headers))! } : {}),
    subject: (envelope?.subject ?? '').replace(/[\r\n]+/g, ' ').trim(),
    fromAddr: (from?.address ?? account.username).trim().toLowerCase(),
    ...(from?.name?.trim() ? { fromName: from.name.trim() } : {}),
    to: addressesOf(envelope?.to),
    cc: addressesOf(envelope?.cc),
    bcc: addressesOf(envelope?.bcc),
    ...(date ? { date } : {}),
    text: await biteText(raw.source),
    attachmentCount: files.length,
    attachmentNames: files.filter(Boolean),
    folder,
    uid: raw.uid,
    ...(uidValidity ? { uidValidity } : {}),
    source: 'poll',
  };
}

/** A server that refused to search a Sent folder: tried again next poll, and said once until it answers. */
export class SentSearchRefused extends Error {
  constructor(readonly folder: string) {
    super(`the server refused to search ${folder}`);
    this.name = 'SentSearchRefused';
  }
}

/** Sent folders whose server refuses to search, by account and path, so a lasting refusal is logged once. */
const refused = new Set<string>();

/** Whether this is the first refusal in a row for a folder; the next one is not. */
export function firstRefusal(key: string): boolean {
  if (refused.has(key)) return false;
  refused.add(key);
  return true;
}

/** That a folder's server answered a search again, so its next refusal is said. */
export function searchAnswered(key: string): void {
  refused.delete(key);
}

export interface SentFetch {
  messages: SentRecord[];
  cursor: SentCursorRow;
  /** Messages that could not be read, left behind: nothing is judged on them, so none is a dead letter. */
  skipped: number;
}

export interface SentFetchOptions {
  limit?: number;
  lookbackDays?: number;
  lookbackMessages?: number;
  biteBytes?: number;
  now?: number;
}

/**
 * Read what is new in a Sent folder since its cursor, and the next part of
 * its first look back, on a connection the poll already has open.
 *
 * Read-only, under a read-only lock: nothing in the mailbox changes, and no
 * message is marked read. A cursor for another folder or another UIDVALIDITY
 * is a first look again, as for an inbound folder; what was stored before is
 * found again by its Message-ID and kept once.
 */
export async function fetchSent(
  client: ImapFlow,
  account: Account,
  folder: string,
  cursor: SentCursorRow | undefined,
  options: SentFetchOptions = {},
): Promise<SentFetch> {
  const limit = Math.max(1, Math.floor(options.limit ?? SENT_PER_POLL));
  const lookbackMessages = Math.max(1, Math.floor(options.lookbackMessages ?? SENT_LOOKBACK_MESSAGES));
  const bite = Math.max(1024, Math.floor(options.biteBytes ?? SENT_BITE_BYTES));
  const nowMs = options.now ?? Date.now();
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    const mailbox = client.mailbox;
    const uidValidity = typeof mailbox === 'object' && mailbox ? String(mailbox.uidValidity ?? '') : '';
    const uidNext = typeof mailbox === 'object' && mailbox ? Number(mailbox.uidNext ?? 0) : 0;
    // A refusal (ImapFlow answers false) is not an empty folder: taken for
    // one, the look back would be skipped for good. Thrown, the cursor stays
    // where it was and the next poll asks again.
    const refusals = `${account.username}|${folder}`;
    let refusedNow = false;
    const ask = async (query: Record<string, unknown>): Promise<number[] | undefined> => {
      const found = await client.search(query, { uid: true });
      return Array.isArray(found) ? found : undefined;
    };
    const search = async (query: Record<string, unknown>): Promise<number[]> => {
      const found = await ask(query);
      if (!found) throw new SentSearchRefused(folder);
      return found;
    };
    const fresh = !cursor || cursor.folder !== folder || cursor.uidValidity !== uidValidity;
    if (cursor && fresh) {
      log.info(`[${account.name}/${folder}] Sent folder ${cursor.folder !== folder ? 'moved' : 'rebuilt'}; looking back again`);
    }

    const picked: number[] = [];
    let next: SentCursorRow;
    if (fresh) {
      const days = options.lookbackDays ?? sentLookbackDays();
      const since = new Date(nowMs - days * 86_400_000);
      // No look back: start above what the folder holds now.
      const found = days > 0 ? (await search({ since })).sort((a, b) => b - a) : [];
      const window = found.slice(0, lookbackMessages);
      const take = window.slice(0, limit);
      picked.push(...take);
      // Everything newer than the look back is read as new mail from here on.
      let highest = found[0] ?? Math.max(0, uidNext - 1);
      if (!highest && typeof mailbox === 'object' && mailbox && Number(mailbox.exists ?? 0) > 0) {
        const last = await client.fetchOne('*', { uid: true }).catch(() => false as const);
        highest = last ? last.uid : 0;
      }
      const more = window.length > take.length;
      next = {
        folder, uidValidity, lastUid: highest,
        backfillBelow: more ? Math.min(...take) : 0,
        backfillLeft: more ? lookbackMessages - take.length : 0,
        backfillSince: since.toISOString(),
      };
    } else {
      next = { ...cursor };
      // `UID n:*` answers with the last message even below n: filtered again here.
      const newer = (await search({ uid: `${cursor.lastUid + 1}:*` }))
        .filter((uid) => uid > cursor.lastUid).sort((a, b) => a - b).slice(0, limit);
      picked.push(...newer);
      if (newer.length) next.lastUid = newer.at(-1)!;
      const room = limit - newer.length;
      // The look back as the setting now has it: switched off (0) it ends,
      // and made shorter it reaches no further than the new setting.
      const days = options.lookbackDays ?? sentLookbackDays();
      if (days === 0) next.backfillBelow = 0;
      if (next.backfillBelow > 1 && next.backfillLeft > 0) {
        if (room > 0) {
          const reach = nowMs - days * 86_400_000;
          const stored = next.backfillSince ? Date.parse(next.backfillSince) : NaN;
          const since = new Date(Number.isFinite(stored) ? Math.max(stored, reach) : reach);
          next.backfillSince = since.toISOString();
          const found = await ask({ since, uid: `1:${next.backfillBelow - 1}` });
          if (found) {
            const older = found.filter((uid) => uid < next.backfillBelow).sort((a, b) => b - a);
            const take = older.slice(0, Math.min(room, next.backfillLeft));
            picked.push(...take);
            next.backfillLeft -= take.length;
            next.backfillBelow = take.length && older.length > take.length && next.backfillLeft > 0 ? Math.min(...take) : 0;
          } else {
            // Refused, the look back waits for a later poll; new mail is read meanwhile.
            refusedNow = true;
            if (firstRefusal(refusals)) {
              log.warn(`[${account.name}/${folder}] the server refused to search the look back; it is tried again on later polls`);
            }
          }
        }
      } else {
        next.backfillBelow = 0;
        next.backfillLeft = 0;
      }
    }
    if (next.backfillBelow === 0) next.backfillLeft = 0;
    // Every search was answered: a refusal after this is said again.
    if (!refusedNow) searchAnswered(refusals);
    if (!picked.length) return { messages: [], cursor: next, skipped: 0 };

    // Collected before anything is parsed: nothing else is asked of the
    // server while a fetch is being read.
    const fetched: FetchMessageObject[] = [];
    for await (const raw of client.fetch(
      picked,
      {
        uid: true, envelope: true, bodyStructure: true, internalDate: true,
        headers: ['references'], source: { maxLength: bite },
      },
      { uid: true },
    )) fetched.push(raw);

    const messages: SentRecord[] = [];
    let skipped = 0;
    for (const raw of fetched) {
      try {
        messages.push(await toSentRecord(raw, account, folder, uidValidity));
      } catch (error) {
        skipped += 1;
        log.warn(`[${account.name}/${folder}] a sent message (uid ${raw.uid}) could not be read; skipped: ${String(error).slice(0, 160)}`);
      }
    }
    return { messages, cursor: next, skipped };
  } finally {
    lock.release();
  }
}

/** The header block of a message as it was handed to the server, each header on one line. */
function headerBlock(raw: Buffer): string {
  const text = raw.subarray(0, 64 * 1024).toString('latin1');
  const end = text.search(/\r?\n\r?\n/);
  return end === -1 ? '' : text.slice(0, end).replace(/\r?\n[ \t]+/g, ' ');
}

/**
 * A letter that just left from the page or through MCP, as it is stored: its
 * exact Message-ID, recipients (Bcc included) and text, keyed into its
 * conversation from the headers it went out with, so that the poll finding
 * it in Sent later keys it the same and keeps one row.
 */
export function outgoingRecord(
  account: Account,
  mail: OutgoingMail,
  sent: { messageId: string; raw: Buffer },
  source: 'page' | 'mcp',
  at: Date = new Date(),
): SentRecord {
  const headers = headerBlock(sent.raw);
  // The headers it went out with, when it carries them; else what it was asked to carry.
  const own = /^message-id:/im.test(headers);
  const inReplyTo = own ? /^in-reply-to:[ \t]*(.*)$/im.exec(headers)?.[1]?.trim() || undefined : mail.inReplyTo;
  const references = own ? headers : (mail.references?.length ? `References: ${mail.references.join(' ')}` : '');
  const bare = (list: readonly string[] | undefined): SentAddress[] =>
    addressesOf((list ?? []).map((address) => ({ name: '', address })));
  const files = (mail.attachments ?? []).map((file) => file.filename);
  return {
    account: account.username,
    accountLabel: account.name,
    messageId: sent.messageId,
    threadKey: threadKeyOf(account.username, references, inReplyTo, sent.messageId),
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(answersOf(inReplyTo, referenceIds(references)) ? { answers: answersOf(inReplyTo, referenceIds(references))! } : {}),
    subject: mail.subject.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim(),
    fromAddr: account.username.trim().toLowerCase(),
    ...(account.fromName ? { fromName: account.fromName } : {}),
    to: bare(mail.to),
    cc: bare(mail.cc),
    bcc: bare(mail.bcc),
    date: at.toISOString(),
    text: sentText(mail.text),
    attachmentCount: files.length,
    attachmentNames: files,
    source,
  };
}
