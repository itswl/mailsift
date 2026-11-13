import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './setup.js';

/**
 * A mail server small enough to read: folders, the messages in each, and a
 * record of what was asked of it. It stands in for ImapFlow so the lookups and
 * actions below run their real code without a socket.
 */
const fake = vi.hoisted(() => {
  interface FakeFolder { path: string; flags?: string[]; specialUse?: string; delimiter?: string }
  interface FakeMessage {
    uid: number; messageId: string; source: Buffer; flags: Set<string>; size?: number;
    /** Body parts by part id, decoded, for a message that is read part by part. */
    parts?: Record<string, { type: string; content: Buffer; filename?: string }>;
  }
  const server = {
    folders: [] as FakeFolder[],
    mail: new Map<string, FakeMessage[]>(),
    unopenable: new Set<string>(),
    calls: [] as string[],
    appended: [] as Array<{ path: string; raw: Buffer; flags: string[] }>,
    refuseAppend: false,
    /** What the next connections do, in order: connect, hang until hung up on, or fail. */
    connectPlan: [] as Array<'ok' | 'hang' | Error>,
    /** Connections hung up on without a goodbye. */
    closed: 0,
    /** Every connection made, so a test can cut one from the server's side. */
    clients: [] as Array<{ usable: boolean }>,
    /** How it answers a search for one Message-ID: properly, or as QQ does (no header search, text matches everything). */
    searching: 'exact' as 'exact' | 'qq',
    /** UIDVALIDITY per folder; 1 unless a test rebuilds the folder. */
    validity: new Map<string, bigint>(),
    /** Whether a move says where the message landed (UIDPLUS). */
    saysWhereMoved: false,
    reset(): void {
      this.folders = [];
      this.mail = new Map();
      this.unopenable = new Set();
      this.calls = [];
      this.appended = [];
      this.refuseAppend = false;
      this.connectPlan = [];
      this.closed = 0;
      this.clients = [];
      this.searching = 'exact';
      this.validity = new Map();
      this.saysWhereMoved = false;
    },
  };

  class ImapFlow {
    private current = '';
    mailbox: { uidValidity: bigint } | false = false;

    usable = false;
    private pending: ((error: Error) => void) | undefined;

    on(): this { return this; }
    async connect(): Promise<void> {
      server.calls.push('connect');
      server.clients.push(this);
      const plan = server.connectPlan.shift() ?? 'ok';
      if (plan === 'hang') await new Promise<void>((_, reject) => { this.pending = reject; });
      else if (plan !== 'ok') throw plan;
      this.usable = true;
    }
    close(): void {
      this.usable = false;
      server.closed += 1;
      // The library's own words for a connection closed on it before it was signed in.
      this.pending?.(Object.assign(new Error('Unexpected close'), { code: 'ClosedAfterConnectTLS' }));
      this.pending = undefined;
    }
    async logout(): Promise<void> { this.usable = false; server.calls.push('logout'); }

    async list(): Promise<unknown[]> {
      server.calls.push('list');
      return server.folders.map((folder) => ({
        path: folder.path, pathAsListed: folder.path, name: folder.path.split('/').at(-1),
        delimiter: folder.delimiter ?? '/', flags: new Set(folder.flags ?? []),
        ...(folder.specialUse ? { specialUse: folder.specialUse } : {}), subscribed: true, listed: true,
      }));
    }

    async getMailboxLock(path: string, options?: { readOnly?: boolean }): Promise<{ path: string; release: () => void }> {
      if (server.unopenable.has(path) || !server.folders.some((folder) => folder.path === path)) {
        server.calls.push(`refused ${path}`);
        throw new Error(`NO [NONEXISTENT] Unknown Mailbox: ${path}`);
      }
      this.current = path;
      this.mailbox = { uidValidity: server.validity.get(path) ?? 1n };
      server.calls.push(`lock ${path} ${options?.readOnly ? 'ro' : 'rw'}`);
      return { path, release: () => { server.calls.push(`release ${path}`); } };
    }

    private here(): FakeMessage[] {
      return server.mail.get(this.current) ?? [];
    }

    async search(query: { header?: Record<string, string>; text?: string }): Promise<number[]> {
      server.calls.push(`search ${query.header ? 'header' : query.text ? 'text' : 'since'}`);
      const everything = this.here().map((m) => m.uid);
      if (query.header) {
        return server.searching === 'qq' ? [] : this.here().filter((m) => m.messageId === query.header!['message-id']).map((m) => m.uid);
      }
      if (query.text) return server.searching === 'qq' ? everything : [];
      return everything;
    }

    private shape(message: FakeMessage, query: { source?: unknown; flags?: boolean; headers?: unknown }): Record<string, unknown> {
      if (query.source) server.calls.push(`source ${message.messageId}`);
      else server.calls.push(query.headers === true ? `headers ${message.messageId}` : `envelope ${message.messageId}`);
      const limit = typeof query.source === 'object' && query.source !== null
        ? (query.source as { maxLength?: number }).maxLength : undefined;
      const text = message.source.toString('latin1');
      const structure = message.parts
        ? {
          type: 'multipart/mixed',
          childNodes: Object.entries(message.parts).map(([part, body]) => ({
            type: body.type, part,
            ...(body.filename ? { disposition: 'attachment', dispositionParameters: { filename: body.filename } } : {}),
          })),
        }
        : { type: 'text/plain', part: '1' };
      return {
        uid: message.uid,
        size: message.size ?? message.source.length,
        envelope: {
          messageId: message.messageId, subject: 'subject', date: new Date('2026-11-12T02:00:00Z'),
          from: [{ name: 'Sender', address: 'sender@example.com' }], to: [{ address: 'me@qq.com' }],
        },
        bodyStructure: structure,
        // Asked for whole, the header block as the message has it; asked for by name, those lines of it, in its order.
        headers: query.headers === true
          ? Buffer.from(`${text.slice(0, text.indexOf('\r\n\r\n'))}\r\n\r\n`, 'latin1')
          : Buffer.from(Array.isArray(query.headers)
            ? text.slice(0, text.indexOf('\r\n\r\n')).split('\r\n')
              .filter((line) => (query.headers as string[]).includes(line.slice(0, line.indexOf(':')).toLowerCase()))
              .map((line) => `${line}\r\n`).join('')
            : '', 'latin1'),
        // No more of the source than was asked for, as a server sends it. A message said to be
        // larger than the few lines kept here is filled out to that size, up to what was asked for.
        ...(query.source ? { source: !limit ? message.source : Buffer.concat([
          message.source, Buffer.alloc(Math.max(0, Math.min(message.size ?? 0, limit) - message.source.length), 0x78),
        ]).subarray(0, limit) } : {}),
        ...(query.flags ? { flags: new Set(message.flags) } : {}),
      };
    }

    async *fetch(range: number[], query: { source?: unknown; flags?: boolean; headers?: unknown }): AsyncGenerator<Record<string, unknown>> {
      for (const message of this.here()) if (range.includes(message.uid)) yield this.shape(message, query);
    }

    async fetchOne(uid: number, query: { source?: unknown; flags?: boolean; headers?: unknown }): Promise<Record<string, unknown> | false> {
      const message = this.here().find((m) => m.uid === Number(uid));
      return message ? this.shape(message, query) : false;
    }

    /** One part, decoded, as a stream; the real client converts text to UTF-8 the same way. */
    async download(uid: number, part: string, options?: { maxBytes?: number }): Promise<{ content?: AsyncIterable<Buffer> & { destroy: () => void } }> {
      const message = this.here().find((m) => m.uid === Number(uid));
      const body = message?.parts?.[part];
      server.calls.push(`download ${part}`);
      if (!body) return {};
      const content = body.content.subarray(0, options?.maxBytes ?? body.content.length);
      return { content: Object.assign((async function* () { yield content; })(), { destroy: () => undefined }) };
    }

    async messageFlagsAdd(range: number[], flags: string[]): Promise<boolean> {
      for (const message of this.here()) if (range.includes(message.uid)) for (const flag of flags) message.flags.add(flag);
      server.calls.push(`+flags ${flags.join(',')}`);
      return true;
    }

    async messageFlagsRemove(range: number[], flags: string[]): Promise<boolean> {
      for (const message of this.here()) if (range.includes(message.uid)) for (const flag of flags) message.flags.delete(flag);
      server.calls.push(`-flags ${flags.join(',')}`);
      return true;
    }

    async messageMove(
      range: number[], destination: string,
    ): Promise<{ destination: string; uidMap?: Map<number, number>; uidValidity?: bigint } | false> {
      const moving = this.here().filter((m) => range.includes(m.uid));
      server.mail.set(this.current, this.here().filter((m) => !range.includes(m.uid)));
      const there = server.mail.get(destination) ?? [];
      server.calls.push(`move ${this.current} -> ${destination}`);
      if (!server.saysWhereMoved) {
        server.mail.set(destination, [...there, ...moving]);
        return { destination };
      }
      // A moved message gets a new UID in the folder it lands in.
      const uidMap = new Map<number, number>();
      let next = Math.max(100, ...there.map((m) => m.uid)) + 1;
      for (const message of moving) { uidMap.set(message.uid, next); message.uid = next; next += 1; }
      server.mail.set(destination, [...there, ...moving]);
      return { destination, uidMap, uidValidity: server.validity.get(destination) ?? 1n };
    }

    async append(path: string, raw: Buffer, flags: string[] = []): Promise<{ destination: string } | false> {
      if (server.refuseAppend) return false;
      server.appended.push({ path, raw, flags });
      return { destination: path };
    }
  }

  return { server, ImapFlow };
});

vi.mock('imapflow', () => ({ ImapFlow: fake.ImapFlow }));
// A mailbox that signs in with a token gets one here without a token file or a provider.
vi.mock('../src/imap/auth.js', async (original) => ({
  ...(await original<typeof import('../src/imap/auth.js')>()),
  getAccessToken: async () => 'access-token',
}));

import {
  closeSessions, connectInteractive, MailboxUnreachableError, openSessions, resumeConnecting, setSignInGap,
  stopConnecting, warmSession, withSession,
} from '../src/imap/connection.js';
import {
  appendToSent, applyWebMailAction, connect, connectAttempts, fetchAttachmentManifestByMessageId,
  fetchByMessageId, fetchReadableByMessageId, imapErrorText, inspectMailSafety, isOversizedLookback, isTransientConnectError,
  MAIL_ACTIONS, MailActionError, orderLookupFolders, resolveActionDestination, retryDelayMs, selectFetchUids,
  sentFolderPath, WEB_MAIL_ACTIONS,
} from '../src/imap/client.js';
import { resolveFolders } from '../src/imap/folders.js';
import type { ListResponse } from 'imapflow';
import type { Account } from '../src/config.js';

const OUTLOOK: Account = {
  name: 'Outlook', provider: 'outlook', username: 'me@outlook.com',
  host: 'outlook.office365.com', port: 993, auth: 'outlook_oauth', folders: ['INBOX'], useSsl: true,
};
const QQ: Account = { ...OUTLOOK, name: 'QQ', provider: 'qq', auth: 'password', password: 'x' };

describe('IMAP fetch caps', () => {
  it('takes the oldest UIDs first so a cap does not skip the backlog', () => {
    expect(selectFetchUids([9, 2, 7, 3, 1], 0, 3)).toEqual([1, 2, 3]);
  });

  it('never returns UIDs at or below the cursor', () => {
    expect(selectFetchUids([2, 3, 4, 5], 3, 10)).toEqual([4, 5]);
  });

  it('returns no UIDs when the shared budget is exhausted', () => {
    expect(selectFetchUids([1, 2, 3], 0, 0)).toEqual([]);
  });

  it('detects an oversized fresh lookback for bounded backfill', () => {
    expect(isOversizedLookback(Array.from({ length: 500 }, (_, i) => i + 1), 500)).toBe(false);
    expect(isOversizedLookback(Array.from({ length: 501 }, (_, i) => i + 1), 500)).toBe(true);
  });
});

describe('IMAP connection errors', () => {
  it('preserves the provider response in the diagnostic text', () => {
    const error = {
      message: 'Command failed',
      response: '3 NO User is authenticated but not connected.',
      responseText: 'User is authenticated but not connected.',
      responseStatus: 'NO',
    };
    expect(imapErrorText(error)).toContain('User is authenticated but not connected.');
    expect(imapErrorText(error)).toContain('NO');
  });

  it('recognizes transient connection failures without retrying auth rejection', () => {
    expect(isTransientConnectError({ responseText: 'User is authenticated but not connected.' })).toBe(true);
    expect(isTransientConnectError({ responseText: 'AUTHENTICATE failed.' })).toBe(false);
  });

  it('uses the same bounded retry profile for every provider', () => {
    expect(connectAttempts(OUTLOOK)).toBe(4);
    expect(retryDelayMs(OUTLOOK, 1)).toBe(2000);
    expect(retryDelayMs(OUTLOOK, 3)).toBe(8000);
    expect(connectAttempts(QQ)).toBe(4);
    expect(retryDelayMs(QQ, 1)).toBe(2000);
  });
});

// ---- Live lookups and actions, against the fake server above ----

const ME: Account = {
  name: 'personal', provider: 'qq', username: 'me@qq.com', host: 'imap.qq.com', port: 993,
  auth: 'password', password: 'x', folders: ['INBOX', 'spam'], useSsl: true,
};
const GMAIL: Account = { ...ME, name: 'work', provider: 'gmail_pw', username: 'me@gmail.com', host: 'imap.gmail.com' };
/** The same mailbox on a server whose name for itself nobody has said. */
const ELSEWHERE: Account = { ...ME, name: 'elsewhere', provider: 'custom', username: 'me@example.org', host: 'mail.example.org' };

const entry = (path: string, specialUse?: string, flags: string[] = []): ListResponse => ({
  path, pathAsListed: path, name: path.split('/').at(-1) ?? path, delimiter: '/', flags: new Set(flags),
  ...(specialUse ? { specialUse } : {}), subscribed: true, listed: true,
}) as unknown as ListResponse;

const source = (id: string, body = 'Hello there.'): Buffer => Buffer.from([
  'Authentication-Results: mx.qq.com; dkim=pass header.d=example.com; dmarc=pass header.from=example.com',
  'From: Sender <sender@example.com>',
  'To: me@qq.com',
  'Subject: A subject',
  `Message-ID: ${id}`,
  'Date: Thu, 12 Nov 2026 10:00:00 +0800',
  'Content-Type: text/plain; charset=utf-8',
  '',
  body,
].join('\r\n'));

function put(
  folder: string, id: string,
  options: { uid?: number; flags?: string[]; size?: number; parts?: Record<string, { type: string; content: Buffer; filename?: string }> } = {},
): void {
  const list = fake.server.mail.get(folder) ?? [];
  list.push({
    uid: options.uid ?? list.length + 1, messageId: id, source: source(id), flags: new Set(options.flags ?? []),
    ...(options.size ? { size: options.size } : {}),
    ...(options.parts ? { parts: options.parts } : {}),
  });
  fake.server.mail.set(folder, list);
}

/** The server drops every kept connection, as an idle timeout would; what the client remembers stays. */
const closeSessionsKeepingMemory = (): void => { for (const client of fake.server.clients) client.usable = false; };

/** The reader's connection is kept between requests; closing it is when the goodbye is said. */
const hungUp = (): string | undefined => { closeSessions(); return fake.server.calls.at(-1); };

const flagsOf = (folder: string, id: string): string[] =>
  [...(fake.server.mail.get(folder)?.find((m) => m.messageId === id)?.flags ?? [])].sort();
const idsIn = (folder: string): string[] => (fake.server.mail.get(folder) ?? []).map((m) => m.messageId);

beforeEach(() => {
  // No connection is carried from one test into the next.
  closeSessions();
  resumeConnecting();
  // No provider here to be polite to; the test that is about the pause sets it.
  setSignInGap(0);
  fake.server.reset();
  fake.server.folders = [
    { path: 'INBOX' },
    { path: 'Junk', specialUse: '\\Junk' },
    { path: 'Archive', specialUse: '\\Archive' },
    { path: 'Deleted Messages', specialUse: '\\Trash' },
    { path: 'Sent Messages', specialUse: '\\Sent' },
    { path: 'Projects', flags: ['\\Noselect'] },
    { path: 'Projects/2026' },
  ];
});

describe('where one message is looked for', () => {
  const entries = [entry('INBOX'), entry('Junk', '\\Junk'), entry('Archive', '\\Archive'), entry('Projects', undefined, ['\\Noselect'])];
  const configured = resolveFolders(entries, ['INBOX', 'spam']);
  const paths = (hint?: string): string[] => orderLookupFolders(entries, configured, hint).map((folder) => folder.path);

  it('is the configured folders, in their order, when nothing else is known', () => {
    expect(paths()).toEqual(['INBOX', 'Junk']);
    expect(paths('   ')).toEqual(['INBOX', 'Junk']);
  });

  it('starts where the message was last seen, without searching that folder twice', () => {
    expect(paths('Junk')).toEqual(['Junk', 'INBOX']);
    expect(orderLookupFolders(entries, configured, 'Junk')[0]).toMatchObject({ isSpam: true });
  });

  it('reaches a folder outside the configured ones, and treats it as one that may be gone', () => {
    const ordered = orderLookupFolders(entries, configured, 'Archive');
    expect(ordered.map((folder) => folder.path)).toEqual(['Archive', 'INBOX', 'Junk']);
    expect(ordered[0]).toMatchObject({ optional: true, isSpam: false });
    expect(ordered[1]).not.toHaveProperty('optional');
  });

  it('ignores a hint that names nothing a message can be in', () => {
    expect(paths('No Such Folder')).toEqual(['INBOX', 'Junk']);
    expect(paths('Projects')).toEqual(['INBOX', 'Junk']);
  });
});

describe('reading one message live', () => {
  it('returns the message as a reader sees it, with its folder and flags, and changes nothing', async () => {
    put('INBOX', '<other@x>');
    put('INBOX', '<one@x>', { flags: ['\\Seen', '\\Answered'] });
    const live = await fetchReadableByMessageId(ELSEWHERE, '<one@x>');
    expect(live).toMatchObject({
      folder: 'INBOX',
      flags: { seen: true, flagged: false, answered: true },
      readable: {
        text: 'Hello there.', subject: 'A subject', messageId: '<one@x>',
        from: { name: 'Sender', address: 'sender@example.com' },
        // The header names a server this mailbox is not known to be on, so it
        // is not taken as anyone's verdict: a sender could have written it.
        auth: { result: 'none', signedBy: null },
      },
    });

    // Read-only locks only: opening a message here does not mark it read.
    expect(fake.server.calls.filter((call) => call.startsWith('lock'))).toEqual(['lock INBOX ro']);
    expect(fake.server.calls).not.toContain('+flags \\Seen');
    expect(hungUp()).toBe('logout');
    expect(flagsOf('INBOX', '<one@x>')).toEqual(['\\Answered', '\\Seen']);
  });

  it('takes the sender verdict once the account says what its receiving server is called', async () => {
    put('INBOX', '<one@x>');
    const vouched = await fetchReadableByMessageId({ ...ELSEWHERE, authservId: 'mx.qq.com' }, '<one@x>');
    expect(vouched?.readable.auth).toMatchObject({ result: 'pass', signedBy: 'example.com' });
    const elsewhere = await fetchReadableByMessageId({ ...ELSEWHERE, authservId: 'mx.other.example' }, '<one@x>');
    expect(elsewhere?.readable.auth.result).toBe('none');
  });

  it('believes QQ\'s own header on a QQ mailbox without being told its name', async () => {
    put('INBOX', '<one@x>');
    const live = await fetchReadableByMessageId(ME, '<one@x>');
    expect(live?.readable.auth).toMatchObject({ result: 'pass', signedBy: 'example.com' });
    // What the operator says still decides: a name that is not on the header means no verdict.
    const overridden = await fetchReadableByMessageId({ ...ME, authservId: 'mx.other.example' }, '<one@x>');
    expect(overridden?.readable.auth.result).toBe('none');
  });

  it('finds a message that was archived, because it is told where to look first', async () => {
    put('Archive', '<moved@x>', { flags: ['\\Flagged'] });
    // Without the hint it is in no configured folder.
    expect(await fetchReadableByMessageId(ME, '<moved@x>')).toBeUndefined();
    fake.server.calls = [];
    const live = await fetchReadableByMessageId(ME, '<moved@x>', 'Archive');
    expect(live).toMatchObject({ folder: 'Archive', flags: { seen: false, flagged: true, answered: false } });
    expect(fake.server.calls.filter((call) => call.startsWith('lock'))).toEqual(['lock Archive ro']);
  });

  it('falls back to the configured folders when the remembered one is gone', async () => {
    put('Junk', '<back@x>');
    fake.server.unopenable.add('Archive');
    const live = await fetchReadableByMessageId(ME, '<back@x>', 'Archive');
    expect(live?.folder).toBe('Junk');
    expect(fake.server.calls).toContain('refused Archive');
  });

  it('still fails loudly when a configured folder cannot be opened', async () => {
    fake.server.unopenable.add('INBOX');
    await expect(fetchReadableByMessageId(ME, '<one@x>')).rejects.toThrow(/Unknown Mailbox/);
    expect(hungUp()).toBe('logout');
  });

  it('opens a message with a large attachment by reading its headers and its text, and nothing else', async () => {
    // Twenty megabytes of scan around three lines of text: the reader wants the three lines.
    put('INBOX', '<huge@x>', {
      size: 20 * 1024 * 1024,
      parts: {
        '1': { type: 'text/plain', content: Buffer.from('请查收附件。\n\nSee the scan attached.') },
        '2': { type: 'text/html', content: Buffer.from('<p>请查收附件。</p><p>See the scan <b>attached</b>.</p>') },
        '3': { type: 'application/pdf', content: Buffer.alloc(64), filename: 'scan.pdf' },
        '4': { type: 'text/plain', content: Buffer.from('not the body'), filename: 'notes.txt' },
      },
    });
    const live = await fetchReadableByMessageId({ ...ME, authservId: 'mx.qq.com' }, '<huge@x>');
    expect(live?.readable).toMatchObject({
      text: '请查收附件。\n\nSee the scan attached.',
      html: '<p>请查收附件。</p><p>See the scan <b>attached</b>.</p>',
      subject: 'A subject', messageId: '<huge@x>', from: { name: 'Sender', address: 'sender@example.com' },
      // The message's own headers came along, so its sender is still vouched for.
      auth: { result: 'pass', signedBy: 'example.com' },
    });
    // The whole source was never asked for, and neither was any attachment.
    expect(fake.server.calls.filter((call) => call.startsWith('source'))).toEqual([]);
    expect(fake.server.calls.filter((call) => call.startsWith('download'))).toEqual(['download 1', 'download 2']);
    expect(fake.server.calls.filter((call) => call.startsWith('lock'))).toEqual(['lock INBOX ro']);
  });

  it('reads a message of ordinary size whole, once it knows it is the right one', async () => {
    put('INBOX', '<one@x>');
    await fetchReadableByMessageId(ME, '<one@x>');
    expect(fake.server.calls.filter((call) => call.startsWith('source'))).toEqual(['source <one@x>']);
    expect(fake.server.calls.filter((call) => call.startsWith('download'))).toEqual([]);
  });

  it('still refuses an oversized message to the MCP reader, which wants one bounded body', async () => {
    put('INBOX', '<huge@x>', { size: 6 * 1024 * 1024 });
    await expect(fetchByMessageId(ME, '<huge@x>')).rejects.toThrow(/MCP_LIVE_SOURCE_BYTES/);
  });

  it('leaves the MCP reader exactly as it was: configured folders, one-line body', async () => {
    put('Archive', '<moved@x>');
    put('INBOX', '<one@x>');
    expect(await fetchByMessageId(ME, '<moved@x>')).toBeUndefined();
    const message = await fetchByMessageId(ME, '<one@x>');
    expect(message).toMatchObject({ messageId: '<one@x>', folder: 'INBOX', body: 'Hello there.', inSpam: false });
    expect(fake.server.calls.filter((call) => call === 'list')).toHaveLength(2);
  });

  it('passes the same hint to the attachment lookup', async () => {
    put('Archive', '<moved@x>');
    expect(await fetchAttachmentManifestByMessageId(ME, '<moved@x>')).toBeUndefined();
    expect(await fetchAttachmentManifestByMessageId(ME, '<moved@x>', 'Archive')).toMatchObject({ folder: 'Archive' });
  });
});

describe('opening a message whose place in the mailbox is remembered', () => {
  const searches = (): string[] => fake.server.calls.filter((call) => call.startsWith('search'));
  const fetched = (): string[] => fake.server.calls.filter((call) => /^(source|headers|envelope) /.test(call));

  it('says where it found a message, and fetches it there the next time without searching', async () => {
    put('INBOX', '<other@x>');
    put('INBOX', '<one@x>', { flags: ['\\Seen'] });
    const first = await fetchReadableByMessageId(ME, '<one@x>');
    expect(first).toMatchObject({ folder: 'INBOX', uid: 2, uidValidity: '1' });
    expect(searches()).toEqual(['search header']);

    fake.server.calls = [];
    const again = await fetchReadableByMessageId(ME, '<one@x>', { folder: 'INBOX', uid: 2, uidValidity: '1' });
    expect(again).toMatchObject({
      folder: 'INBOX', uid: 2, uidValidity: '1', flags: { seen: true, flagged: false, answered: false },
      readable: { text: 'Hello there.', messageId: '<one@x>', auth: { result: 'pass' } },
    });
    // One request brought the whole message; nothing was searched for.
    expect(searches()).toEqual([]);
    expect(fetched()).toEqual(['source <one@x>']);
    expect(fake.server.calls.filter((call) => call.startsWith('lock'))).toEqual(['lock INBOX ro']);
  });

  it('checks that what is there is still the message, and searches when it is not', async () => {
    put('INBOX', '<other@x>');
    put('INBOX', '<one@x>');
    // UID 1 is another message now: the remembered place is wrong.
    const live = await fetchReadableByMessageId(ME, '<one@x>', { folder: 'INBOX', uid: 1, uidValidity: '1' });
    expect(live).toMatchObject({ uid: 2, readable: { messageId: '<one@x>' } });
    expect(searches()).toEqual(['search header']);
    // And a UID nothing has any more is no different.
    fake.server.calls = [];
    expect(await fetchReadableByMessageId(ME, '<one@x>', { folder: 'INBOX', uid: 77, uidValidity: '1' })).toMatchObject({ uid: 2 });
    expect(searches()).toEqual(['search header']);
  });

  it('does not use a UID from before the folder was rebuilt, or one that belongs to another folder', async () => {
    put('INBOX', '<other@x>');
    put('INBOX', '<one@x>');
    fake.server.validity.set('INBOX', 7n);
    const rebuilt = await fetchReadableByMessageId(ME, '<one@x>', { folder: 'INBOX', uid: 2, uidValidity: '1' });
    expect(rebuilt).toMatchObject({ uid: 2, uidValidity: '7' });
    // Not even looked at by its old number: the search is the first thing asked.
    expect(fetched()[0]).toBe('headers <one@x>');
    expect(searches()).toEqual(['search header']);

    fake.server.calls = [];
    put('Archive', '<filed@x>', { uid: 2 });
    const filed = await fetchReadableByMessageId(ME, '<one@x>', { folder: 'Archive', uid: 2, uidValidity: '7' });
    expect(filed).toMatchObject({ folder: 'INBOX', uid: 2 });
  });

  it('reads a larger message in a second request, and a huge one as its text alone', async () => {
    const big = Buffer.concat([source('<big@x>'), Buffer.alloc(300 * 1024, 0x61)]);
    fake.server.mail.set('INBOX', [{ uid: 5, messageId: '<big@x>', source: big, flags: new Set() }]);
    const live = await fetchReadableByMessageId(ME, '<big@x>', { folder: 'INBOX', uid: 5, uidValidity: '1' });
    expect(live?.readable.text.startsWith('Hello there.')).toBe(true);
    // More than the first request brought, so the second one did read the rest (the reader then shows a bounded part of it).
    expect(live?.readable.text.length).toBeGreaterThan(50_000);
    expect(fetched()).toEqual(['source <big@x>', 'source <big@x>']);
    expect(searches()).toEqual([]);

    fake.server.calls = [];
    put('INBOX', '<huge@x>', {
      uid: 6, size: 20 * 1024 * 1024,
      parts: {
        '1': { type: 'text/plain', content: Buffer.from('See the scan attached.') },
        '2': { type: 'application/pdf', content: Buffer.alloc(64), filename: 'scan.pdf' },
      },
    });
    const huge = await fetchReadableByMessageId(ME, '<huge@x>', { folder: 'INBOX', uid: 6, uidValidity: '1' });
    expect(huge?.readable).toMatchObject({ text: 'See the scan attached.', messageId: '<huge@x>', auth: { result: 'pass' } });
    expect(fake.server.calls.filter((call) => call.startsWith('download'))).toEqual(['download 1']);
    expect(searches()).toEqual([]);
  });

  it('uses the remembered place for the attachment list and for an action', async () => {
    fake.server.searching = 'qq';
    for (let n = 1; n <= 30; n += 1) put('INBOX', `<m${n}@x>`);
    const place = { folder: 'INBOX', uid: 17, uidValidity: '1' };
    expect(await fetchAttachmentManifestByMessageId(ME, '<m17@x>', place)).toMatchObject({ folder: 'INBOX' });
    expect(await applyWebMailAction(ME, '<m17@x>', 'star', { hint: place })).toMatchObject({ sourceFolder: 'INBOX' });
    expect(flagsOf('INBOX', '<m17@x>')).toEqual(['\\Flagged']);
    expect(searches()).toEqual([]);
    // Nothing but the one message was asked about.
    expect(new Set(fetched().map((call) => call.split(' ')[1]))).toEqual(new Set(['<m17@x>']));
  });
});

describe('a server that answers a search for one message with the whole folder', () => {
  // QQ: no header search, and a text search that matches everything.
  beforeEach(() => { fake.server.searching = 'qq'; });
  afterEach(() => { delete process.env.MCP_LIVE_SEARCH_MAX_MESSAGES; });
  const asked = (what: string): string[] => fake.server.calls.filter((call) => call.startsWith(`${what} `));

  it('finds the one by reading envelopes, and fetches no other message', async () => {
    for (let n = 1; n <= 40; n += 1) put('INBOX', `<m${n}@x>`);
    const live = await fetchReadableByMessageId(ME, '<m17@x>');
    expect(live).toMatchObject({ folder: 'INBOX', uid: 17, readable: { messageId: '<m17@x>', text: 'Hello there.' } });
    expect(asked('envelope')).toHaveLength(40);
    expect(asked('headers')).toEqual(['headers <m17@x>']);
    expect(asked('source')).toEqual(['source <m17@x>']);
  });

  it('does the same for an attachment list and an action', async () => {
    for (let n = 1; n <= 40; n += 1) put('INBOX', `<m${n}@x>`);
    expect(await fetchAttachmentManifestByMessageId(ME, '<m9@x>')).toMatchObject({ folder: 'INBOX' });
    expect(await applyWebMailAction(ME, '<m9@x>', 'mark_read')).toMatchObject({ sourceFolder: 'INBOX' });
    expect(flagsOf('INBOX', '<m9@x>')).toEqual(['\\Seen']);
    expect(flagsOf('INBOX', '<m8@x>')).toEqual([]);
    expect(asked('source')).toEqual([]);
    expect(asked('headers')).toEqual([]);
  });

  it('goes through the newest of a very large folder, and says so when the message is not among them', async () => {
    process.env.MCP_LIVE_SEARCH_MAX_MESSAGES = '10';
    for (let n = 1; n <= 40; n += 1) put('INBOX', `<m${n}@x>`);
    expect(await fetchReadableByMessageId(ME, '<m35@x>')).toMatchObject({ uid: 35 });
    expect(asked('envelope')).toHaveLength(10);
    // Older than the ones looked at: not "gone", which nobody checked.
    await expect(fetchReadableByMessageId(ME, '<m5@x>')).rejects.toThrow(/MCP_LIVE_SEARCH_MAX_MESSAGES/);
    // Remembered, the same message is one fetch away however large the folder is.
    fake.server.calls = [];
    expect(await fetchReadableByMessageId(ME, '<m5@x>', { folder: 'INBOX', uid: 5, uidValidity: '1' })).toMatchObject({ uid: 5 });
    expect(asked('envelope')).toEqual([]);
  });

  it('still takes a short answer from a text search as it is', async () => {
    fake.server.searching = 'exact';
    put('INBOX', '<one@x>');
    // An honest server with no such message: nothing found, and no folder read through for it twice.
    expect(await fetchReadableByMessageId(ME, '<absent@x>')).toBeUndefined();
    expect(asked('source')).toEqual([]);
  });
});

describe('where a moving action puts a message', () => {
  it('archives by special use first, then by a name the server did not flag', () => {
    expect(resolveActionDestination([entry('INBOX'), entry('Saved', '\\Archive')], 'archive')).toEqual({ path: 'Saved', isSpam: false });
    expect(resolveActionDestination([entry('INBOX'), entry('Archives')], 'archive').path).toBe('Archives');
    expect(resolveActionDestination([entry('INBOX'), entry('其他文件夹/归档')], 'archive').path).toBe('其他文件夹/归档');
  });

  it('archives on Gmail by leaving the inbox for All Mail', () => {
    const gmail = [entry('INBOX'), entry('[Gmail]', undefined, ['\\Noselect']), entry('[Gmail]/所有邮件', '\\All'), entry('[Gmail]/Trash', '\\Trash')];
    expect(resolveActionDestination(gmail, 'archive', 'gmail_pw').path).toBe('[Gmail]/所有邮件');
    // Recognised by its path even when the provider name does not say Gmail.
    expect(resolveActionDestination(gmail, 'archive', 'custom').path).toBe('[Gmail]/所有邮件');
    // An \All view on another server is a search, not somewhere to move mail.
    expect(() => resolveActionDestination([entry('INBOX'), entry('virtual/All', '\\All')], 'archive', 'custom'))
      .toThrow(/no archive folder/);
  });

  it('bins by special use, then by name', () => {
    expect(resolveActionDestination([entry('INBOX'), entry('[Gmail]/Bin', '\\Trash')], 'trash').path).toBe('[Gmail]/Bin');
    expect(resolveActionDestination([entry('INBOX'), entry('已删除')], 'trash').path).toBe('已删除');
  });

  it('refuses rather than inventing a folder the mailbox does not have', () => {
    for (const action of ['archive', 'trash'] as const) {
      try {
        resolveActionDestination([entry('INBOX'), entry('Junk', '\\Junk')], action);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(MailActionError);
        expect((error as MailActionError).code).toBe('invalid_destination');
      }
    }
    // A container node is not a folder mail can be moved to.
    expect(() => resolveActionDestination([entry('Archive', '\\Archive', ['\\Noselect'])], 'archive')).toThrow(MailActionError);
  });

  it('knows the inbox, and says when an explicit destination is a spam folder', () => {
    expect(resolveActionDestination([entry('Inbox', '\\Inbox')], 'inbox')).toEqual({ path: 'Inbox', isSpam: false });
    expect(resolveActionDestination([], 'inbox')).toEqual({ path: 'INBOX', isSpam: false });
    expect(resolveActionDestination([entry('INBOX'), entry('Junk', '\\Junk')], 'move', 'qq', 'Junk')).toEqual({ path: 'Junk', isSpam: true });
    expect(() => resolveActionDestination([entry('INBOX')], 'move', 'qq', 'Nowhere')).toThrow(/not found or not selectable/);
    expect(() => resolveActionDestination([entry('INBOX')], 'move', 'qq')).toThrow(/requires a destination/);
  });
});

describe('acting on a message from the web view', () => {
  it('has one list of what may be asked for a message, and one thing nobody asks for', () => {
    expect([...MAIL_ACTIONS]).toEqual(['mark_read', 'mark_unread', 'star', 'unstar', 'move', 'archive', 'inbox', 'trash']);
    // Marking a message answered is what a reply leaving does, not a request.
    expect([...WEB_MAIL_ACTIONS]).toEqual([...MAIL_ACTIONS, 'answered']);
  });

  it('marks, stars and records an answer under a writable lock', async () => {
    put('INBOX', '<one@x>');
    expect(await applyWebMailAction(ME, '<one@x>', 'mark_read')).toEqual({
      action: 'mark_read', account: 'me@qq.com', messageId: '<one@x>', sourceFolder: 'INBOX',
    });
    await applyWebMailAction(ME, '<one@x>', 'star');
    await applyWebMailAction(ME, '<one@x>', 'answered');
    expect(flagsOf('INBOX', '<one@x>')).toEqual(['\\Answered', '\\Flagged', '\\Seen']);
    await applyWebMailAction(ME, '<one@x>', 'mark_unread');
    await applyWebMailAction(ME, '<one@x>', 'unstar');
    expect(flagsOf('INBOX', '<one@x>')).toEqual(['\\Answered']);
    expect(fake.server.calls.filter((call) => call.startsWith('lock'))).toEqual(Array(5).fill('lock INBOX rw'));
  });

  it('archives, and can then act again on the message where it now is', async () => {
    put('INBOX', '<one@x>');
    const archived = await applyWebMailAction(ME, '<one@x>', 'archive');
    expect(archived).toEqual({
      action: 'archive', account: 'me@qq.com', messageId: '<one@x>',
      sourceFolder: 'INBOX', destinationFolder: 'Archive', destinationIsSpam: false,
    });
    expect(idsIn('INBOX')).toEqual([]);
    expect(idsIn('Archive')).toEqual(['<one@x>']);

    // It has left the configured folders: only the hint reaches it now.
    expect(await applyWebMailAction(ME, '<one@x>', 'star')).toBeUndefined();
    const starred = await applyWebMailAction(ME, '<one@x>', 'star', { folderHint: archived!.destinationFolder! });
    expect(starred).toMatchObject({ sourceFolder: 'Archive' });
    expect(flagsOf('Archive', '<one@x>')).toEqual(['\\Flagged']);

    const back = await applyWebMailAction(ME, '<one@x>', 'inbox', { folderHint: 'Archive' });
    expect(back).toMatchObject({ sourceFolder: 'Archive', destinationFolder: 'INBOX', destinationIsSpam: false });
    expect(idsIn('INBOX')).toEqual(['<one@x>']);
  });

  it('reports where a moved message landed when the server says, so it can be found there directly', async () => {
    fake.server.saysWhereMoved = true;
    put('INBOX', '<one@x>');
    const archived = await applyWebMailAction(ME, '<one@x>', 'archive', { hint: { folder: 'INBOX', uid: 1, uidValidity: '1' } });
    expect(archived).toMatchObject({ destinationFolder: 'Archive', destinationUid: 101, destinationUidValidity: '1' });

    fake.server.calls = [];
    const place = { folder: 'Archive', uid: archived!.destinationUid!, uidValidity: archived!.destinationUidValidity! };
    expect(await fetchReadableByMessageId(ME, '<one@x>', place)).toMatchObject({ folder: 'Archive', uid: 101 });
    expect(fake.server.calls.filter((call) => call.startsWith('search'))).toEqual([]);
    // The old place says nothing about the new folder.
    expect(await applyWebMailAction(ME, '<one@x>', 'star', { hint: { folder: 'INBOX', uid: 1, uidValidity: '1' } })).toBeUndefined();
  });

  it('says when a move put the message in the bin, by the bin\'s name or under it', async () => {
    put('INBOX', '<one@x>');
    put('INBOX', '<two@x>');
    fake.server.folders.push({ path: 'Deleted Messages/kept' });
    expect(await applyWebMailAction(ME, '<one@x>', 'move', { destination: 'Deleted Messages' }))
      .toMatchObject({ destinationFolder: 'Deleted Messages', destinationIsTrash: true });
    expect(await applyWebMailAction(ME, '<two@x>', 'move', { destination: 'Deleted Messages/kept' }))
      .toMatchObject({ destinationIsTrash: true });
    expect(await applyWebMailAction(ME, '<two@x>', 'inbox', { folderHint: 'Deleted Messages/kept' })).not.toHaveProperty('destinationIsTrash');
    expect(await applyWebMailAction(ME, '<two@x>', 'trash')).toMatchObject({ destinationIsTrash: true });
  });

  it('does an action on a new connection when the kept one is found dead before anything was changed', async () => {
    put('INBOX', '<one@x>');
    // A read keeps a connection, and the server then drops it without a word.
    await fetchReadableByMessageId(ME, '<one@x>');
    const [kept] = fake.server.clients;
    const lock = (kept as unknown as { getMailboxLock: (...a: unknown[]) => Promise<unknown> }).getMailboxLock.bind(kept);
    let dropped = false;
    (kept as unknown as { getMailboxLock: (...a: unknown[]) => Promise<unknown> }).getMailboxLock = async (...a: unknown[]) => {
      if (!dropped) { dropped = true; kept!.usable = false; throw Object.assign(new Error('Connection not available'), { code: 'NoConnection' }); }
      return lock(...a);
    };
    expect(await applyWebMailAction(ME, '<one@x>', 'archive')).toMatchObject({ sourceFolder: 'INBOX', destinationFolder: 'Archive' });
    expect(idsIn('Archive')).toEqual(['<one@x>']);
    expect(fake.server.calls.filter((call) => call.startsWith('move'))).toEqual(['move INBOX -> Archive']);
  });

  it('never sends a change twice: a line that drops after the change was sent fails the action', async () => {
    put('INBOX', '<one@x>');
    await fetchReadableByMessageId(ME, '<one@x>');
    const [kept] = fake.server.clients;
    const move = (kept as unknown as { messageMove: (...a: unknown[]) => Promise<unknown> }).messageMove.bind(kept);
    (kept as unknown as { messageMove: (...a: unknown[]) => Promise<unknown> }).messageMove = async (...a: unknown[]) => {
      await move(...a);
      kept!.usable = false;
      throw Object.assign(new Error('Connection not available'), { code: 'NoConnection' });
    };
    await expect(applyWebMailAction(ME, '<one@x>', 'archive')).rejects.toThrow(/Connection not available/);
    // Moved once, and not tried again on a new connection.
    expect(fake.server.calls.filter((call) => call.startsWith('move'))).toEqual(['move INBOX -> Archive']);
  });

  it('rescues a message from spam and can send one to the bin', async () => {
    put('Junk', '<rescued@x>');
    expect(await applyWebMailAction(ME, '<rescued@x>', 'inbox')).toMatchObject({ sourceFolder: 'Junk', destinationFolder: 'INBOX' });
    expect(idsIn('INBOX')).toEqual(['<rescued@x>']);
    expect(await applyWebMailAction(ME, '<rescued@x>', 'trash')).toMatchObject({
      sourceFolder: 'INBOX', destinationFolder: 'Deleted Messages', destinationIsSpam: false,
    });
    expect(idsIn('Deleted Messages')).toEqual(['<rescued@x>']);
  });

  it('moves to a named folder, and says so when that folder is spam', async () => {
    put('INBOX', '<one@x>');
    expect(await applyWebMailAction(ME, '<one@x>', 'move', { destination: 'Junk' })).toMatchObject({
      destinationFolder: 'Junk', destinationIsSpam: true,
    });
    await expect(applyWebMailAction(ME, '<one@x>', 'move', { destination: 'Projects' })).rejects.toThrow(/not selectable/);
    await expect(applyWebMailAction(ME, '<one@x>', 'move')).rejects.toThrow(/requires a destination/);
  });

  it('refuses a move that would go nowhere, and an action it does not know', async () => {
    put('INBOX', '<one@x>');
    await expect(applyWebMailAction(ME, '<one@x>', 'inbox')).rejects.toMatchObject({ code: 'invalid_destination' });
    await expect(applyWebMailAction(ME, '<one@x>', 'delete' as never)).rejects.toMatchObject({ code: 'invalid_action' });
    // Refused before a connection is opened.
    expect(fake.server.calls.filter((call) => call === 'connect')).toHaveLength(1);
    expect(idsIn('INBOX')).toEqual(['<one@x>']);
  });

  it('says a mailbox has no archive rather than making one', async () => {
    fake.server.folders = [{ path: 'INBOX' }, { path: 'Junk', specialUse: '\\Junk' }];
    put('INBOX', '<one@x>');
    await expect(applyWebMailAction(ME, '<one@x>', 'archive')).rejects.toMatchObject({
      code: 'invalid_destination', message: 'this mailbox has no archive folder',
    });
    expect(hungUp()).toBe('logout');
  });

  it('archives on Gmail into All Mail', async () => {
    fake.server.folders = [
      { path: 'INBOX' }, { path: '[Gmail]', flags: ['\\Noselect'] },
      { path: '[Gmail]/All Mail', specialUse: '\\All' }, { path: '[Gmail]/Spam', specialUse: '\\Junk' },
    ];
    put('INBOX', '<one@x>');
    expect(await applyWebMailAction(GMAIL, '<one@x>', 'archive')).toMatchObject({ destinationFolder: '[Gmail]/All Mail' });
  });

  it('reports a message that is in none of the folders searched', async () => {
    expect(await applyWebMailAction(ME, '<absent@x>', 'mark_read')).toBeUndefined();
    expect(hungUp()).toBe('logout');
  });
});

describe('what the safety report says of the sender', () => {
  it('repeats the mailbox provider\'s verdict, and none where the provider is not one whose header can be told', async () => {
    put('INBOX', '<one@x>');
    const known = await inspectMailSafety(ME, '<one@x>');
    expect(known?.senderSignals).toMatchObject({
      fromAddress: 'sender@example.com',
      authentication: { result: 'pass', dmarc: 'pass', dkim: 'pass', signedBy: 'example.com' },
    });
    expect(known?.limitations).toMatch(/what the mailbox provider reported/);
    // The same header on a server nobody has named: a sender could have written it.
    const unknown = await inspectMailSafety(ELSEWHERE, '<one@x>');
    expect(unknown?.senderSignals.authentication).toMatchObject({ result: 'none', signedBy: null });
  });

  it('believes only the first header, which is the one the mailbox wrote', async () => {
    const forged = Buffer.from([
      'Authentication-Results: mx.qq.com; dmarc=fail header.from=example.com',
      'Authentication-Results: mx.qq.com; dkim=pass header.d=example.com; dmarc=pass header.from=example.com',
      'From: Sender <sender@example.com>', 'Subject: A subject', 'Message-ID: <forged@x>', '', 'hi',
    ].join('\r\n'));
    fake.server.mail.set('INBOX', [{ uid: 3, messageId: '<forged@x>', source: forged, flags: new Set() }]);
    expect((await inspectMailSafety(ME, '<forged@x>'))?.senderSignals.authentication).toMatchObject({ result: 'fail', dmarc: 'fail' });
  });
});

describe('keeping a copy of what was sent', () => {
  const raw = Buffer.from('From: me@qq.com\r\nTo: you@example.com\r\nSubject: Re: hello\r\n\r\nSent from mailsift.\r\n');

  it('files the message in the Sent folder, already read', async () => {
    expect(await appendToSent(ME, raw)).toBe('Sent Messages');
    expect(fake.server.appended).toEqual([{ path: 'Sent Messages', raw, flags: ['\\Seen'] }]);
    expect(hungUp()).toBe('logout');
  });

  it('finds the folder by name when the server flags nothing', () => {
    expect(sentFolderPath([entry('INBOX'), entry('已发送')])).toBe('已发送');
    expect(sentFolderPath([entry('INBOX'), entry('其他文件夹/Sent Items')])).toBe('其他文件夹/Sent Items');
    expect(sentFolderPath([entry('INBOX'), entry('[Gmail]/已发邮件', '\\Sent')])).toBe('[Gmail]/已发邮件');
    expect(sentFolderPath([entry('INBOX'), entry('Sent', '\\Sent', ['\\Noselect'])])).toBeUndefined();
  });

  it('does nothing, without an error, for a mailbox that has no Sent folder', async () => {
    fake.server.folders = [{ path: 'INBOX' }];
    expect(await appendToSent(ME, raw)).toBeUndefined();
    expect(fake.server.appended).toEqual([]);
  });

  it('reports a copy the server would not take', async () => {
    fake.server.refuseAppend = true;
    await expect(appendToSent(ME, raw)).rejects.toThrow(/rejected the append to Sent Messages/);
    expect(hungUp()).toBe('logout');
  });
});

describe('the reader\'s kept connection', () => {
  const connects = (): number => fake.server.calls.filter((call) => call === 'connect').length;
  const lists = (): number => fake.server.calls.filter((call) => call === 'list').length;

  it('pays for one handshake when a message, its attachments and another message are read in a row', async () => {
    put('INBOX', '<one@x>');
    put('INBOX', '<two@x>');
    await fetchReadableByMessageId(ME, '<one@x>', 'INBOX');
    await fetchAttachmentManifestByMessageId(ME, '<one@x>', 'INBOX');
    await fetchReadableByMessageId(ME, '<two@x>', 'INBOX');
    expect(connects()).toBe(1);
    // The folder list is asked for once, too.
    expect(lists()).toBe(1);
    expect(fake.server.calls).not.toContain('logout');
    expect(openSessions()).toBe(1);
    closeSessions();
    expect(fake.server.calls.at(-1)).toBe('logout');
    expect(openSessions()).toBe(0);
  });

  it('keeps one connection per mailbox, and they do not wait for each other', async () => {
    put('INBOX', '<one@x>');
    await Promise.all([fetchReadableByMessageId(ME, '<one@x>'), fetchReadableByMessageId(GMAIL, '<one@x>')]);
    expect(connects()).toBe(2);
    expect(openSessions()).toBe(2);
  });

  it('answers requests for one mailbox one at a time, in the order they were made', async () => {
    const order: string[] = [];
    const slow = withSession(ME, async () => { order.push('first starts'); await new Promise((r) => setTimeout(r, 20)); order.push('first ends'); });
    const quick = withSession(ME, async () => { order.push('second'); });
    await Promise.all([slow, quick]);
    expect(order).toEqual(['first starts', 'first ends', 'second']);
    expect(connects()).toBe(1);
    // One that failed does not hold up the next.
    await expect(withSession(ME, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(withSession(ME, async () => 'still here')).resolves.toBe('still here');
    expect(connects()).toBe(1);
  });

  it('reads again on a new connection when the kept one died while it sat idle', async () => {
    put('INBOX', '<one@x>');
    await fetchReadableByMessageId(ME, '<one@x>', 'INBOX');
    // The server dropped it without a word; the first use finds out.
    let first = true;
    const live = await withSession(ME, async (client) => {
      if (first) { first = false; client.close(); throw new Error('read ECONNRESET'); }
      return 'read on the second connection';
    });
    expect(live).toBe('read on the second connection');
    expect(connects()).toBe(2);
  });

  it('does not do a change to the mailbox twice on the strength of a dropped line', async () => {
    put('INBOX', '<one@x>');
    await fetchReadableByMessageId(ME, '<one@x>', 'INBOX');
    let attempts = 0;
    await expect(withSession(ME, async (client) => {
      attempts += 1;
      client.close();
      throw new Error('read ECONNRESET');
    }, { repeatable: false })).rejects.toThrow('ECONNRESET');
    expect(attempts).toBe(1);
    // The dead connection is not kept; the next request makes its own.
    expect(openSessions()).toBe(0);
    await withSession(ME, async () => undefined);
    expect(connects()).toBe(2);
  });

  it('gives up on a request that outlasts its time, and frees the mailbox for the next', async () => {
    const stuck = withSession(ME, () => new Promise<never>(() => undefined), { timeoutMs: 30 });
    const next = withSession(ME, async () => 'answered');
    await expect(stuck).rejects.toThrow(/did not answer in time/);
    await expect(next).resolves.toBe('answered');
    // The connection the stuck request was on was closed under it, not reused.
    expect(fake.server.closed).toBeGreaterThanOrEqual(1);
    expect(connects()).toBe(2);
  });
});

describe('when the mailbox cannot be reached', () => {
  const refuse = (): Error => new Error('read ECONNRESET');
  const quickly = { timing: { attemptMs: 200, hedgeAfterMs: 10, attempts: 3 } };

  it('tells the requests that follow at once, instead of making each wait through the same attempts', async () => {
    fake.server.connectPlan = [refuse(), refuse(), refuse()];
    // The page asks for a message's text and its attachment list together.
    const text = withSession(ME, async () => 'text', quickly);
    const list = withSession(ME, async () => 'list', quickly);
    await expect(text).rejects.toThrow(/ECONNRESET/);
    await expect(list).rejects.toThrow(/ECONNRESET/);
    expect(fake.server.calls.filter((call) => call === 'connect')).toHaveLength(3);
    expect(openSessions()).toBe(0);
  });
});

describe('having a connection ready before it is asked for', () => {
  const connects = (): number => fake.server.calls.filter((call) => call === 'connect').length;

  it('connects when the page is opened, so the first message does not pay for it', async () => {
    put('INBOX', '<one@x>');
    warmSession(ME);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(connects()).toBe(1);
    expect(openSessions()).toBe(1);
    await fetchReadableByMessageId(ME, '<one@x>', 'INBOX');
    expect(connects()).toBe(1);
  });

  it('does nothing when a connection is already kept or being made, and tries at most once a minute', async () => {
    const t0 = Date.now();
    warmSession(ME, t0);
    warmSession(ME, t0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    warmSession(ME, t0 + 5_000);
    expect(connects()).toBe(1);
    // The connection went away and the page is still open: not again within the minute.
    closeSessionsKeepingMemory();
    warmSession(ME, t0 + 30_000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(connects()).toBe(1);
    warmSession(ME, t0 + 61_000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(connects()).toBe(2);
  });

  it('is quiet about a mailbox that cannot be reached, and makes nothing once told to stop', async () => {
    fake.server.connectPlan = Array.from({ length: 4 }, () => new Error('read ECONNRESET'));
    warmSession(GMAIL);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(openSessions()).toBe(0);
    stopConnecting();
    const before = connects();
    warmSession(ME);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(connects()).toBe(before);
  });
});

describe('connecting for someone who is waiting', () => {
  const quick = { attemptMs: 400, hedgeAfterMs: 20, attempts: 3 };

  it('starts a second attempt beside one that is not answering, and uses whichever connects', async () => {
    fake.server.connectPlan = ['hang', 'ok'];
    const started = Date.now();
    const client = await connectInteractive(ME, quick);
    expect(client.usable).toBe(true);
    expect(Date.now() - started).toBeLessThan(300);
    expect(fake.server.calls.filter((call) => call === 'connect')).toHaveLength(2);
    // The one that never answered is hung up on at once, not left to run out its time.
    expect(fake.server.closed).toBe(1);
    expect(fake.server.clients.filter((c) => c.usable)).toHaveLength(1);
    client.close();
  });

  it('does not open a second connection when the first answers at once', async () => {
    const client = await connectInteractive(ME, quick);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fake.server.calls.filter((call) => call === 'connect')).toHaveLength(1);
    client.close();
  });

  it('replaces an attempt that failed outright, and reports the last failure when none got through', async () => {
    fake.server.connectPlan = [new Error('read ECONNRESET'), 'ok'];
    const client = await connectInteractive(ME, quick);
    expect(client.usable).toBe(true);
    client.close();

    fake.server.connectPlan = [new Error('read ECONNRESET'), new Error('Connection timed out'), new Error('read ECONNRESET')];
    await expect(connectInteractive(ME, quick)).rejects.toThrow(/ECONNRESET/);
  });

  it('tries a refused sign-in once more, and a wrong password never a third time', async () => {
    const refused = (): Error => Object.assign(new Error('Command failed'), { responseText: 'Login failed.' });
    // A provider in trouble says "Login failed" to a token it took a second ago.
    fake.server.connectPlan = [refused(), 'ok'];
    const client = await connectInteractive(ME, quick);
    expect(client.usable).toBe(true);
    client.close();
    // A password that really is wrong is presented twice, not once per attempt allowed.
    fake.server.connectPlan = [refused(), refused(), 'ok'];
    const before = fake.server.calls.length;
    const refusal = await connectInteractive(ME, quick).catch((error: unknown) => error);
    expect(String(refusal)).toMatch(/Login failed/);
    // The server answered and said no: that is not the same as not answering.
    expect(refusal).not.toBeInstanceOf(MailboxUnreachableError);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fake.server.calls.slice(before).filter((call) => call === 'connect')).toHaveLength(2);
  });

  it('keeps its own clock: a server that greets and then never signs anyone in is given up on', async () => {
    // The library's timeouts cover reaching the server, not the sign-in after it.
    fake.server.connectPlan = ['hang', 'hang', 'hang'];
    const started = Date.now();
    const failure = await connectInteractive(ME, { attemptMs: 60, hedgeAfterMs: 15, attempts: 3 }).catch((error: unknown) => error);
    expect(String(failure)).toMatch(/did not complete the sign-in in time/);
    // Said as what it is: the provider is not answering. Not a fault in the message or the account.
    expect(failure).toBeInstanceOf(MailboxUnreachableError);
    expect(Date.now() - started).toBeLessThan(400);
    expect(fake.server.calls.filter((call) => call === 'connect')).toHaveLength(3);
    // All three were hung up on; none is left open behind the failure.
    expect(fake.server.closed).toBeGreaterThanOrEqual(3);
    expect(fake.server.clients.filter((c) => c.usable)).toHaveLength(0);
  });

  it('counts an attempt it timed out as a stall, and still uses a later one that answers', async () => {
    fake.server.connectPlan = ['hang', 'hang', 'ok'];
    const client = await connectInteractive(ME, { attemptMs: 200, hedgeAfterMs: 15, attempts: 3 });
    expect(client.usable).toBe(true);
    client.close();
  });

  it('a slower twin that connects after the winner says goodbye instead of lingering', async () => {
    let release: () => void = () => undefined;
    const original = fake.ImapFlow.prototype.connect;
    let n = 0;
    fake.ImapFlow.prototype.connect = async function patched(this: InstanceType<typeof fake.ImapFlow>): Promise<void> {
      n += 1;
      fake.server.calls.push('connect');
      if (n === 1) await new Promise<void>((resolve) => { release = resolve; });
      this.usable = true;
    };
    try {
      const client = await connectInteractive(ME, quick);
      expect(n).toBe(2);
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fake.server.calls).toContain('logout');
      expect(client.usable).toBe(true);
      client.close();
    } finally {
      fake.ImapFlow.prototype.connect = original;
    }
  });
});

describe('being told to stop', () => {
  it('hangs up on connections still being made, and makes no more', async () => {
    // A poll stuck on a server that is not answering: each attempt would wait a minute and a half.
    fake.server.connectPlan = ['hang', 'hang', 'hang', 'hang'];
    const stuck = connect(ME);
    await new Promise((resolve) => setTimeout(resolve, 10));
    stopConnecting();
    await expect(stuck).rejects.toThrow(/Unexpected close/);
    // No second attempt, no two-second pause before it.
    expect(fake.server.calls.filter((call) => call === 'connect')).toHaveLength(1);
    await expect(connect(ME)).rejects.toThrow(/shutting down/);
    await expect(connectInteractive(ME)).rejects.toThrow(/shutting down/);
  });

  it('closes the reader\'s kept connections too', async () => {
    put('INBOX', '<one@x>');
    await fetchReadableByMessageId(ME, '<one@x>', 'INBOX');
    expect(openSessions()).toBe(1);
    stopConnecting();
    expect(openSessions()).toBe(0);
    expect(fake.server.calls.at(-1)).toBe('logout');
  });
});

describe('signing in when nobody is waiting', () => {
  const refused = (): Error => Object.assign(new Error('Command failed'), { responseText: 'Login failed.' });

  it('spaces out sign-ins to one mailbox: the poll and the listeners no longer start at the same instant', async () => {
    // What a restart used to do: three connections to the same mailbox begun together.
    setSignInGap(40);
    const starts: number[] = [];
    const original = fake.ImapFlow.prototype.connect;
    fake.ImapFlow.prototype.connect = async function timed(this: InstanceType<typeof fake.ImapFlow>): Promise<void> {
      starts.push(Date.now());
      this.usable = true;
    };
    try {
      const clients = await Promise.all([
        connect(ME, { purpose: 'the poll' }), connect(ME, { idle: true, purpose: 'listening on INBOX' }), connect(ME, { idle: true, purpose: 'listening on Junk' }),
      ]);
      expect(starts).toHaveLength(3);
      expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(35);
      expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(35);
      for (const client of clients) client.close();
      // Another mailbox is not made to wait for this one.
      starts.length = 0;
      const began = Date.now();
      const other = await connect(GMAIL);
      expect(starts[0]! - began).toBeLessThan(30);
      other.close();
    } finally {
      fake.ImapFlow.prototype.connect = original;
    }
  });

  it('does not put one caller behind another whose sign-in is hanging', async () => {
    // Only the start is spaced. With a provider that leaves sign-ins hanging,
    // waiting for the one before would put everyone behind the slowest.
    setSignInGap(20);
    fake.server.connectPlan = ['hang', 'ok'];
    const stuck = connect(ME, { purpose: 'the poll', attemptMs: 5_000 });
    stuck.catch(() => undefined);
    const started = Date.now();
    const client = await connect(ME, { purpose: 'listening on INBOX' });
    expect(Date.now() - started).toBeLessThan(500);
    expect(client.usable).toBe(true);
    client.close();
    stopConnecting();
    await expect(stuck).rejects.toThrow();
  });

  it('gives up on an attempt whose sign-in never comes, instead of holding the poll for minutes', async () => {
    fake.server.connectPlan = ['hang', 'ok'];
    const started = Date.now();
    const client = await connect(ME, { attemptMs: 50 });
    // One stalled attempt, the two-second pause, then a connection.
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(fake.server.calls.filter((call) => call === 'connect')).toHaveLength(2);
    expect(fake.server.closed).toBeGreaterThanOrEqual(1);
    client.close();
  }, 10_000);

  it('never asks a second time with a password that was refused', async () => {
    // That is how accounts get locked.
    fake.server.connectPlan = [refused(), 'ok'];
    await expect(connect(ME)).rejects.toThrow(/Login failed/);
    expect(fake.server.calls.filter((call) => call === 'connect')).toHaveLength(1);
  });

  it('asks once more with a token that was refused, and only once', async () => {
    // A provider in trouble says "Login failed" to a token it accepts a moment later.
    fake.server.connectPlan = [refused(), 'ok'];
    const client = await connect(OUTLOOK);
    expect(client.usable).toBe(true);
    expect(fake.server.calls.filter((call) => call === 'connect')).toHaveLength(2);
    client.close();
    // Refused twice running, it is taken at its word.
    fake.server.calls.length = 0;
    fake.server.connectPlan = [refused(), refused(), 'ok'];
    await expect(connect(OUTLOOK)).rejects.toThrow(/Login failed/);
    expect(fake.server.calls.filter((call) => call === 'connect')).toHaveLength(2);
  }, 15_000);
});
