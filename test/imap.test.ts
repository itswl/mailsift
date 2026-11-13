import { beforeEach, describe, expect, it, vi } from 'vitest';
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
      server.calls.push(`lock ${path} ${options?.readOnly ? 'ro' : 'rw'}`);
      return { path, release: () => { server.calls.push(`release ${path}`); } };
    }

    private here(): FakeMessage[] {
      return server.mail.get(this.current) ?? [];
    }

    async search(query: { header?: Record<string, string>; text?: string }): Promise<number[]> {
      if (query.header) return this.here().filter((m) => m.messageId === query.header!['message-id']).map((m) => m.uid);
      if (query.text) return [];
      return this.here().map((m) => m.uid);
    }

    private shape(message: FakeMessage, query: { source?: unknown; flags?: boolean; headers?: unknown }): Record<string, unknown> {
      if (query.source) server.calls.push(`source ${message.messageId}`);
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
        // Asked for whole, the header block as the message has it; otherwise none of the two named.
        headers: query.headers === true ? Buffer.from(`${text.slice(0, text.indexOf('\r\n\r\n'))}\r\n\r\n`, 'latin1') : Buffer.from(''),
        ...(query.source ? { source: message.source } : {}),
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

    async messageMove(range: number[], destination: string): Promise<{ destination: string } | false> {
      const moving = this.here().filter((m) => range.includes(m.uid));
      server.mail.set(this.current, this.here().filter((m) => !range.includes(m.uid)));
      server.mail.set(destination, [...(server.mail.get(destination) ?? []), ...moving]);
      server.calls.push(`move ${this.current} -> ${destination}`);
      return { destination };
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

import {
  closeSessions, connectInteractive, openSessions, resumeConnecting, stopConnecting, warmSession, withSession,
} from '../src/imap/connection.js';
import {
  appendToSent, applyMessageAction, applyWebMailAction, connect, connectAttempts, fetchAttachmentManifestByMessageId,
  fetchByMessageId, fetchReadableByMessageId, imapErrorText, isOversizedLookback, isTransientConnectError,
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
    const live = await fetchReadableByMessageId(ME, '<one@x>');
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
    const vouched = await fetchReadableByMessageId({ ...ME, authservId: 'mx.qq.com' }, '<one@x>');
    expect(vouched?.readable.auth).toMatchObject({ result: 'pass', signedBy: 'example.com' });
    const elsewhere = await fetchReadableByMessageId({ ...ME, authservId: 'mx.other.example' }, '<one@x>');
    expect(elsewhere?.readable.auth.result).toBe('none');
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
  it('adds what a mail client does without widening the MCP tool', () => {
    expect([...MAIL_ACTIONS]).toEqual(['mark_read', 'mark_unread', 'star', 'unstar', 'move']);
    expect([...WEB_MAIL_ACTIONS]).toEqual([...MAIL_ACTIONS, 'archive', 'trash', 'inbox', 'answered']);
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

describe('the MCP action path', () => {
  it('still refuses to move anything to a trash folder', async () => {
    put('INBOX', '<one@x>');
    await expect(applyMessageAction(ME, '<one@x>', 'move', 'Trash')).rejects.toMatchObject({ code: 'invalid_destination' });
    await expect(applyMessageAction(ME, '<one@x>', 'move', '已删除')).rejects.toThrow(/delete\/trash folder is disabled/);
    // Refused before any connection: nothing reached the server.
    expect(fake.server.calls).toEqual([]);
    await expect(applyMessageAction(ME, '<one@x>', 'trash' as never)).rejects.toMatchObject({ code: 'invalid_action' });
  });

  it('keeps its actions, its result shape and its configured folders', async () => {
    put('INBOX', '<one@x>');
    put('Archive', '<moved@x>');
    expect(await applyMessageAction(ME, '<one@x>', 'star')).toEqual({
      action: 'star', account: 'me@qq.com', messageId: '<one@x>', sourceFolder: 'INBOX',
    });
    expect(await applyMessageAction(ME, '<one@x>', 'move', 'Archive')).toEqual({
      action: 'move', account: 'me@qq.com', messageId: '<one@x>', sourceFolder: 'INBOX', destinationFolder: 'Archive',
    });
    // No hint on this path: a message outside the configured folders stays out of reach.
    expect(await applyMessageAction(ME, '<moved@x>', 'mark_read')).toBeUndefined();
    await expect(applyMessageAction(ME, '<one@x>', 'move', 'Projects')).rejects.toThrow(/not found or not selectable/);
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
    await expect(connectInteractive(ME, quick)).rejects.toThrow(/Login failed/);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fake.server.calls.slice(before).filter((call) => call === 'connect')).toHaveLength(2);
  });

  it('keeps its own clock: a server that greets and then never signs anyone in is given up on', async () => {
    // The library's timeouts cover reaching the server, not the sign-in after it.
    fake.server.connectPlan = ['hang', 'hang', 'hang'];
    const started = Date.now();
    await expect(connectInteractive(ME, { attemptMs: 60, hedgeAfterMs: 15, attempts: 3 })).rejects.toThrow(/did not complete the sign-in in time/);
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
