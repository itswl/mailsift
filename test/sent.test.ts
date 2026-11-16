import { describe, expect, it, vi } from 'vitest';
import './setup.js';
import type { ImapFlow } from 'imapflow';
import type { Account } from '../src/config.js';
import { threadKeyOf } from '../src/imap/client.js';
import {
  answersOf, fetchSent, outgoingRecord, SENT_BITE_BYTES, SENT_LOOKBACK_MESSAGES, SENT_PER_POLL, sentLookbackDays,
  sentMailEnabled, sentText, toSentRecord,
} from '../src/imap/sent.js';
import type { SentCursorRow } from '../src/services/state.js';

const ACCOUNT: Account = {
  name: 'work', provider: 'imap', username: 'me@example.com', host: 'imap.example.com', port: 993,
  auth: 'password', password: 'x', folders: ['INBOX'], useSsl: true,
};

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-17T09:00:00Z');

interface FakeSent {
  uid: number;
  date: Date;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  text?: string;
  /** Bytes of an attachment after the text, which the bite must never reach. */
  attachmentBytes?: number;
  to?: Array<{ name?: string; address: string }>;
  bcc?: Array<{ name?: string; address: string }>;
  broken?: boolean;
}

/** A message as a server stores it: headers, a text part, and maybe a large file after it. */
function sourceOf(m: FakeSent): Buffer {
  const head = [
    `Message-ID: ${m.messageId ?? `<s${m.uid}@example.com>`}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`] : []),
    ...(m.references ? [`References: ${m.references}`] : []),
    'From: Me <me@example.com>', 'To: Ann <ann@example.org>', 'Subject: s', 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b"',
  ].join('\r\n');
  const text = m.text ?? `Reply number ${m.uid}.`;
  const file = m.attachmentBytes
    ? `--b\r\nContent-Type: application/pdf; name="big.pdf"\r\nContent-Disposition: attachment; filename="big.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${'A'.repeat(m.attachmentBytes)}\r\n`
    : '';
  return Buffer.from(`${head}\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n${file}--b--\r\n`, 'utf8');
}

/** A Sent folder small enough to read, and a record of what was asked of it. */
function sentFolder(messages: FakeSent[], options: { validity?: bigint; uidNext?: number } = {}) {
  const asked = { searches: [] as Array<Record<string, unknown>>, fetches: [] as Array<{ range: number[]; query: Record<string, unknown> }>, locks: [] as Array<[string, unknown]> };
  const client = {
    mailbox: {
      uidValidity: options.validity ?? 7n,
      uidNext: options.uidNext ?? Math.max(0, ...messages.map((m) => m.uid)) + 1,
      exists: messages.length,
    },
    async getMailboxLock(path: string, opts: unknown) {
      asked.locks.push([path, opts]);
      return { release: () => undefined };
    },
    async search(query: Record<string, unknown>) {
      asked.searches.push(query);
      let found = messages;
      if (query['since']) found = found.filter((m) => m.date.getTime() >= (query['since'] as Date).getTime());
      if (typeof query['uid'] === 'string') {
        const [from, to] = (query['uid'] as string).split(':');
        const low = Number(from);
        if (to === '*') {
          const above = found.filter((m) => m.uid >= low);
          // As servers do: `n:*` names the last message even when it is below n.
          return (above.length ? above : found.slice(-1)).map((m) => m.uid);
        }
        found = found.filter((m) => m.uid >= low && m.uid <= Number(to));
      }
      return found.map((m) => m.uid);
    },
    async *fetch(range: number[], query: Record<string, unknown>) {
      asked.fetches.push({ range: [...range], query });
      const bite = (query['source'] as { maxLength?: number } | undefined)?.maxLength;
      for (const m of messages) {
        if (!range.includes(m.uid)) continue;
        const source = sourceOf(m);
        const raw = {
          uid: m.uid,
          internalDate: m.date,
          bodyStructure: {
            type: 'multipart/mixed', childNodes: [
              { type: 'text/plain', part: '1' },
              ...(m.attachmentBytes ? [{ type: 'application/pdf', part: '2', disposition: 'attachment', dispositionParameters: { filename: 'big.pdf' } }] : []),
              { type: 'image/png', part: '3', id: '<logo>', disposition: 'inline', dispositionParameters: { filename: 'logo.png' } },
            ],
          },
          headers: Buffer.from(m.references ? `References: ${m.references}\r\n\r\n` : '\r\n'),
          source: bite ? source.subarray(0, bite) : source,
        } as Record<string, unknown>;
        Object.defineProperty(raw, 'envelope', {
          get: () => {
            if (m.broken) throw new Error('unreadable envelope');
            return {
              messageId: m.messageId ?? `<s${m.uid}@example.com>`, subject: `Re: thing ${m.uid}`, date: m.date,
              inReplyTo: m.inReplyTo, from: [{ name: 'Me', address: 'me@example.com' }],
              to: m.to ?? [{ name: 'Ann', address: 'Ann@Example.org' }], cc: [], bcc: m.bcc ?? [],
            };
          },
        });
        yield raw;
      }
    },
    async fetchOne() { return false; },
  };
  return { client: client as unknown as ImapFlow, asked };
}

/** The UIDs a read returned, newest first, whatever order the server sent them in. */
const uids = (result: { messages: Array<{ uid?: number | undefined }> }): number[] =>
  result.messages.map((m) => m.uid!).sort((a, b) => b - a);

/** Messages one an hour back from NOW, the newest with the highest UID. */
function hourly(count: number, firstUid = 1): FakeSent[] {
  return Array.from({ length: count }, (_, i) => ({ uid: firstUid + i, date: new Date(NOW - (count - i) * 3_600_000) }));
}

describe('what the owner wrote', () => {
  it('keeps the words above the quoted history, in every form a client writes it', () => {
    expect(sentText('Sounds good.\n\nOn Mon, 16 Nov 2026 at 10:00, Ann <ann@example.org> wrote:\n> Lunch?\n> Ann')).toBe('Sounds good.');
    expect(sentText('好的，周六见。\n\n在 2026年11月16日 10:00，读书会 <club@example.com> 写道：\n> 周六聚餐？')).toBe('好的，周六见。');
    expect(sentText('Approved.\n\nFrom: Ann Lee\nSent: Monday, 16 November 2026 10:00\nTo: Me\nSubject: Budget\n\nCan you approve?'))
      .toBe('Approved.');
    expect(sentText('Done.\n\n-----Original Message-----\nFrom: Ann')).toBe('Done.');
    // Lines quoted inline with > go too; what was written between them stays.
    expect(sentText('> Can you come?\nYes.\n> And bring the slides?\nAlready sent.')).toBe('Yes.\nAlready sent.');
    // A forward keeps the note above it, not the message it carries.
    expect(sentText('FYI, see below.\n\n---------- Forwarded message ---------\nFrom: Ann\nDate: today\nSubject: x\nTo: me\n\nBody'))
      .toBe('FYI, see below.');
    // Nothing of their own: nothing stored, rather than the quote as if they wrote it.
    expect(sentText('On Mon, Ann wrote:\n> Hello')).toBe('');
    // The signature is what they sent, and stays.
    expect(sentText('Thanks!\n\n-- \nAlex')).toBe('Thanks!\n\n-- \nAlex');
  });

  it('keeps at most 8,000 characters', () => {
    expect(sentText('x'.repeat(20_000))).toHaveLength(8000);
  });

  it('names the message a reply answers: In-Reply-To first, else the last reference', () => {
    expect(answersOf('<a@x>', ['<root@x>', '<b@x>'])).toBe('<a@x>');
    expect(answersOf(' <a@x> (comment)', [])).toBe('<a@x>');
    expect(answersOf(undefined, ['<root@x>', '<b@x>'])).toBe('<b@x>');
    expect(answersOf('', [])).toBeUndefined();
  });
});

describe('the setting', () => {
  it('is on unless switched off, and looks back 30 days, at most 365 and never past the retention', () => {
    expect(sentMailEnabled()).toBe(true);
    process.env.SENT_MAIL_ENABLED = 'false';
    expect(sentMailEnabled()).toBe(false);
    process.env.SENT_MAIL_ENABLED = 'true';
    expect(sentMailEnabled()).toBe(true);
    expect(sentLookbackDays()).toBe(30);
    process.env.SENT_LOOKBACK_DAYS = '5000';
    process.env.STATE_RETENTION_DAYS = '0';
    expect(sentLookbackDays()).toBe(365);
    process.env.STATE_RETENTION_DAYS = '90';
    expect(sentLookbackDays()).toBe(90);
    process.env.SENT_LOOKBACK_DAYS = 'soon';
    expect(sentLookbackDays()).toBe(30);
    process.env.SENT_LOOKBACK_DAYS = '-3';
    expect(sentLookbackDays()).toBe(30);
    // 0 is no look back at all, not the default.
    process.env.SENT_LOOKBACK_DAYS = '0';
    expect(sentLookbackDays()).toBe(0);
  });
});

describe('a message read from Sent', () => {
  it('is keyed into its conversation exactly as received mail is', async () => {
    const { client } = sentFolder([{
      uid: 9, date: new Date(NOW), inReplyTo: '<Q2@example.org>', references: '<Root@Example.org> <q2@example.org>',
      bcc: [{ name: 'Boss', address: 'boss@example.com' }],
    }]);
    const [raw] = await (async () => { const out = []; for await (const r of client.fetch([9], { source: { maxLength: 4096 } })) out.push(r); return out; })();
    const record = await toSentRecord(raw as never, ACCOUNT, 'Sent', '7');
    // The same function received mail is keyed with, on the same headers.
    expect(record.threadKey).toBe(threadKeyOf('me@example.com', 'References: <Root@Example.org> <q2@example.org>\r\n', '<Q2@example.org>', record.messageId));
    expect(record.threadKey).toBe('me@example.com|<root@example.org>');
    expect(record).toMatchObject({
      answers: '<Q2@example.org>', inReplyTo: '<Q2@example.org>', folder: 'Sent', uid: 9, uidValidity: '7', source: 'poll',
      to: [{ name: 'Ann', address: 'ann@example.org' }], bcc: [{ name: 'Boss', address: 'boss@example.com' }],
      text: 'Reply number 9.', date: new Date(NOW).toISOString(),
    });
    // A picture its own markup shows is not one of its files.
    expect(record.attachmentCount).toBe(0);
  });
});

describe('reading a Sent folder', () => {
  it('looks back newest first on first sight, within its own budget, and carries on below where it stopped', async () => {
    const mail = hourly(120);
    const { client, asked } = sentFolder(mail);
    const first = await fetchSent(client, ACCOUNT, 'Sent', undefined, { now: NOW });
    expect(asked.locks).toEqual([['Sent', { readOnly: true }]]);
    expect(uids(first)).toEqual(Array.from({ length: SENT_PER_POLL }, (_, i) => 120 - i));
    expect(first.cursor).toMatchObject({ folder: 'Sent', uidValidity: '7', lastUid: 120, backfillBelow: 71, backfillLeft: SENT_LOOKBACK_MESSAGES - SENT_PER_POLL });

    // Two new messages since: read first, then the look back goes on below where it stopped.
    mail.push({ uid: 121, date: new Date(NOW + 60_000) }, { uid: 122, date: new Date(NOW + 120_000) });
    const second = await fetchSent(client, ACCOUNT, 'Sent', first.cursor, { now: NOW });
    expect(uids(second)).toEqual([122, 121, ...Array.from({ length: SENT_PER_POLL - 2 }, (_, i) => 70 - i)]);
    expect(second.cursor.lastUid).toBe(122);
    expect(second.cursor.backfillBelow).toBe(23);

    const third = await fetchSent(client, ACCOUNT, 'Sent', second.cursor, { now: NOW });
    expect(uids(third)).toEqual(Array.from({ length: 22 }, (_, i) => 22 - i));
    expect(third.cursor).toMatchObject({ backfillBelow: 0, backfillLeft: 0 });
    // Nothing new and nothing left to look back at: nothing fetched.
    asked.fetches.length = 0;
    const quiet = await fetchSent(client, ACCOUNT, 'Sent', third.cursor, { now: NOW });
    expect(quiet.messages).toEqual([]);
    expect(asked.fetches).toEqual([]);
  });

  it('reads no further back than the look back reaches, and no more of it than its cap', async () => {
    const old = { uid: 1, date: new Date(NOW - 40 * DAY) };
    const recent = hourly(9, 2);
    const { client } = sentFolder([old, ...recent]);
    let cursor: SentCursorRow | undefined;
    const read: number[] = [];
    for (let poll = 0; poll < 6; poll += 1) {
      const result = await fetchSent(client, ACCOUNT, 'Sent', cursor, { now: NOW, limit: 2, lookbackMessages: 5 });
      read.push(...uids(result));
      cursor = result.cursor;
    }
    // The five newest, two a poll; never the one from forty days ago.
    expect(read).toEqual([10, 9, 8, 7, 6]);
    expect(cursor).toMatchObject({ lastUid: 10, backfillBelow: 0, backfillLeft: 0 });
  });

  it('reads a bounded bite of each message: its text, never a whole attachment', async () => {
    const { client, asked } = sentFolder([{ uid: 3, date: new Date(NOW), text: 'Here is the report.', attachmentBytes: 3 * 1024 * 1024 }]);
    const result = await fetchSent(client, ACCOUNT, 'Sent', undefined, { now: NOW });
    expect(asked.fetches).toHaveLength(1);
    expect(asked.fetches[0]!.query['source']).toEqual({ maxLength: SENT_BITE_BYTES });
    expect(asked.fetches[0]!.query).not.toHaveProperty('bodyParts');
    expect(result.messages[0]).toMatchObject({ text: 'Here is the report.', attachmentCount: 1, attachmentNames: ['big.pdf'] });
  });

  it('keeps a cursor of its own, and starts over when the folder is rebuilt or another one is Sent now', async () => {
    const { client } = sentFolder(hourly(3), { validity: 8n });
    const stale: SentCursorRow = { folder: 'Sent', uidValidity: '7', lastUid: 3, backfillBelow: 0, backfillLeft: 0, backfillSince: null };
    const rebuilt = await fetchSent(client, ACCOUNT, 'Sent', stale, { now: NOW });
    expect(uids(rebuilt)).toEqual([3, 2, 1]);
    expect(rebuilt.cursor.uidValidity).toBe('8');
    const moved = await fetchSent(client, ACCOUNT, 'Sent Items', { ...rebuilt.cursor }, { now: NOW });
    expect(moved.messages).toHaveLength(3);
    expect(moved.cursor.folder).toBe('Sent Items');
  });

  it('does not read the last message again when nothing is new', async () => {
    const { client } = sentFolder(hourly(4));
    const cursor: SentCursorRow = { folder: 'Sent', uidValidity: '7', lastUid: 4, backfillBelow: 0, backfillLeft: 0, backfillSince: null };
    expect((await fetchSent(client, ACCOUNT, 'Sent', cursor, { now: NOW })).messages).toEqual([]);
  });

  it('starts an empty look back above what the folder holds', async () => {
    const { client } = sentFolder([{ uid: 40, date: new Date(NOW - 90 * DAY) }], { uidNext: 41 });
    const result = await fetchSent(client, ACCOUNT, 'Sent', undefined, { now: NOW });
    expect(result.messages).toEqual([]);
    expect(result.cursor).toMatchObject({ lastUid: 40, backfillBelow: 0 });
  });

  it('reads only what is sent from now on when there is no look back', async () => {
    process.env.SENT_LOOKBACK_DAYS = '0';
    const mail = hourly(5);
    const { client, asked } = sentFolder(mail);
    const first = await fetchSent(client, ACCOUNT, 'Sent', undefined, { now: NOW });
    expect(first.messages).toEqual([]);
    expect(asked.searches).toEqual([]);
    expect(first.cursor).toMatchObject({ lastUid: 5, backfillBelow: 0, backfillLeft: 0 });
    mail.push({ uid: 6, date: new Date(NOW + 60_000) });
    expect(uids(await fetchSent(client, ACCOUNT, 'Sent', first.cursor, { now: NOW }))).toEqual([6]);
  });

  it('takes a refused search for a failure to try again, never for an empty folder', async () => {
    const { client } = sentFolder(hourly(5));
    (client as unknown as { search: () => Promise<false> }).search = async () => false;
    await expect(fetchSent(client, ACCOUNT, 'Sent', undefined, { now: NOW })).rejects.toThrow(/refused to search/);
    const later: SentCursorRow = { folder: 'Sent', uidValidity: '7', lastUid: 2, backfillBelow: 2, backfillLeft: 10, backfillSince: null };
    await expect(fetchSent(client, ACCOUNT, 'Sent', later, { now: NOW })).rejects.toThrow(/refused to search/);
  });

  it('keeps reading new mail while the server refuses to search the look back, and says so once', async () => {
    const mail = hourly(6);
    const { client } = sentFolder(mail);
    const search = (client as unknown as { search: (q: Record<string, unknown>) => Promise<number[] | false> }).search.bind(client);
    (client as unknown as { search: unknown }).search = async (q: Record<string, unknown>) => (q['since'] ? false : search(q));
    const cursor: SentCursorRow = {
      folder: 'Sent', uidValidity: '7', lastUid: 5, backfillBelow: 4, backfillLeft: 10, backfillSince: new Date(NOW - 30 * DAY).toISOString(),
    };
    const written: string[] = [];
    process.env.LOG_LEVEL = 'warn';
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => { written.push(String(chunk)); return true; }) as never);
    try {
      const first = await fetchSent(client, ACCOUNT, 'Sent', cursor, { now: NOW });
      expect(uids(first)).toEqual([6]);
      // The look back waits where it was, for a later poll.
      expect(first.cursor).toMatchObject({ lastUid: 6, backfillBelow: 4, backfillLeft: 10 });
      await fetchSent(client, ACCOUNT, 'Sent', first.cursor, { now: NOW });
      expect(written.filter((line) => line.includes('refused to search the look back'))).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('stops a look back under way when it is switched off, and shortens it when it is made shorter', async () => {
    const { client } = sentFolder(hourly(5).map((m, i) => ({ ...m, date: new Date(NOW - (5 - i) * 3 * DAY) })));
    const cursor: SentCursorRow = {
      folder: 'Sent', uidValidity: '7', lastUid: 5, backfillBelow: 4, backfillLeft: 10, backfillSince: new Date(NOW - 30 * DAY).toISOString(),
    };
    process.env.SENT_LOOKBACK_DAYS = '0';
    const off = await fetchSent(client, ACCOUNT, 'Sent', cursor, { now: NOW });
    expect(off.messages).toEqual([]);
    expect(off.cursor).toMatchObject({ backfillBelow: 0, backfillLeft: 0 });
    // Ten days: of what is left of the look back (UIDs 1 to 3, sent 15, 12 and 9 days ago), only what was sent in them.
    process.env.SENT_LOOKBACK_DAYS = '10';
    const shorter = await fetchSent(client, ACCOUNT, 'Sent', cursor, { now: NOW });
    expect(uids(shorter)).toEqual([3]);
  });

  it('skips a message it cannot read, and moves on past it', async () => {
    const { client } = sentFolder([{ uid: 1, date: new Date(NOW - 60_000), broken: true }, { uid: 2, date: new Date(NOW) }]);
    const result = await fetchSent(client, ACCOUNT, 'Sent', undefined, { now: NOW });
    expect(result.skipped).toBe(1);
    expect(result.messages.map((m) => m.uid)).toEqual([2]);
    expect(result.cursor.lastUid).toBe(2);
  });
});

describe('a letter sent from the page or through MCP', () => {
  const mail = {
    to: ['Ann@Example.org'], cc: ['bob@example.org'], bcc: ['boss@example.com'], subject: 'Re: Budget',
    text: 'Approved.\n\n-- \nAlex\n\nOn Mon, Ann <ann@example.org> wrote:\n> Can you approve?',
    inReplyTo: '<q@example.org>', references: ['<root@example.org>', '<q@example.org>'],
    attachments: [{ filename: 'budget.xlsx', content: Buffer.from('x'), contentType: 'application/octet-stream' }],
  };

  it('is stored with its exact id, recipients (Bcc too) and words, keyed by the headers it went out with', () => {
    const raw = Buffer.from([
      'Message-ID: <out@example.com>', 'In-Reply-To:', ' <q@example.org>',
      'References: <root@example.org>', ' <q@example.org>', 'Subject: Re: Budget', '', 'Approved.',
    ].join('\r\n'));
    const at = new Date('2026-11-17T09:30:00Z');
    const record = outgoingRecord({ ...ACCOUNT, fromName: 'Alex' }, mail, { messageId: '<out@example.com>', raw }, 'page', at);
    expect(record).toMatchObject({
      account: 'me@example.com', accountLabel: 'work', messageId: '<out@example.com>', source: 'page',
      threadKey: 'me@example.com|<root@example.org>', answers: '<q@example.org>', inReplyTo: '<q@example.org>',
      to: [{ name: '', address: 'ann@example.org' }], cc: [{ name: '', address: 'bob@example.org' }],
      bcc: [{ name: '', address: 'boss@example.com' }], date: at.toISOString(), fromName: 'Alex',
      text: 'Approved.\n\n-- \nAlex', attachmentCount: 1, attachmentNames: ['budget.xlsx'],
    });
  });

  it('falls back on what it was asked to carry when its bytes have no headers to read', () => {
    const record = outgoingRecord(ACCOUNT, mail, { messageId: '<out@example.com>', raw: Buffer.from('Approved.') }, 'mcp');
    expect(record).toMatchObject({ threadKey: 'me@example.com|<root@example.org>', answers: '<q@example.org>', source: 'mcp' });
    const fresh = outgoingRecord(ACCOUNT, { to: ['a@b.co'], subject: 'Hello', text: 'Hi' }, { messageId: '<New@example.com>', raw: Buffer.from('') }, 'page');
    expect(fresh.threadKey).toBe('me@example.com|<new@example.com>');
    expect(fresh).not.toHaveProperty('answers');
  });
});
