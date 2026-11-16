import { beforeEach, describe, expect, it, vi } from 'vitest';
import './setup.js';

/**
 * A mail server with folders, sequence numbers and the searches the live
 * views ask for, small enough to read. It stands in for ImapFlow, so that
 * listing, paging, searching and the exact lookups a live handle makes run
 * their real code without a socket. test/imap.test.ts has the server the
 * stored lookups are tried against.
 */
const fake = vi.hoisted(() => {
  interface FakeFolder { path: string; flags?: string[]; specialUse?: string }
  interface FakeMessage { uid: number; messageId?: string; subject: string; from: string; name?: string; body?: string; flags: Set<string>; date: Date }
  const server = {
    folders: [] as FakeFolder[],
    mail: new Map<string, FakeMessage[]>(),
    validity: new Map<string, bigint>(),
    capabilities: new Set<string>(),
    calls: [] as string[],
    /** How a search is answered: properly, refused (NO), or matching nothing outside ASCII. */
    searching: 'exact' as 'exact' | 'refuse' | 'ascii',
    searches: [] as unknown[],
    reset(): void {
      this.folders = []; this.mail = new Map(); this.validity = new Map(); this.capabilities = new Set();
      this.calls = []; this.searching = 'exact'; this.searches = [];
    },
  };

  const matches = (m: FakeMessage, query: Record<string, unknown>): boolean => {
    const has = (value: unknown, text: string): boolean => {
      const q = String(value);
      if (server.searching === 'ascii' && /[^\x20-\x7e]/.test(q)) return false;
      return text.toLowerCase().includes(q.toLowerCase());
    };
    if (query['or']) return (query['or'] as Array<Record<string, unknown>>).some((part) => matches(m, part));
    if (query['subject'] !== undefined) return has(query['subject'], m.subject);
    if (query['from'] !== undefined) return has(query['from'], `${m.name ?? ''} ${m.from}`);
    if (query['body'] !== undefined) return has(query['body'], m.body ?? '');
    if (query['gmraw'] !== undefined) return has(query['gmraw'], `${m.subject} ${m.from} ${m.body ?? ''}`);
    if (query['uid'] !== undefined) {
      const [low, high] = String(query['uid']).split(':').map(Number);
      return m.uid >= low! && m.uid <= high!;
    }
    return true;
  };

  class ImapFlow {
    private current = '';
    mailbox: { uidValidity: bigint; exists: number } | false = false;
    usable = false;
    get capabilities(): Map<string, boolean> { return new Map([...server.capabilities].map((c) => [c, true])); }
    on(): this { return this; }
    async connect(): Promise<void> { this.usable = true; }
    close(): void { this.usable = false; }
    async logout(): Promise<void> { this.usable = false; }

    private entries(): Array<Record<string, unknown>> {
      return server.folders.map((folder) => ({
        path: folder.path, pathAsListed: folder.path, name: folder.path.split('/').at(-1), delimiter: '/',
        flags: new Set(folder.flags ?? []), ...(folder.specialUse ? { specialUse: folder.specialUse } : {}), subscribed: true, listed: true,
      }));
    }
    async list(options?: { statusQuery?: Record<string, boolean> }): Promise<unknown[]> {
      server.calls.push(options?.statusQuery ? 'list-status' : 'list');
      return this.entries().map((entry) => (options?.statusQuery && !(entry['flags'] as Set<string>).has('\\Noselect')
        ? { ...entry, status: this.statusOf(String(entry['path'])) } : entry));
    }
    private statusOf(path: string): { messages: number; unseen: number } {
      const here = server.mail.get(path) ?? [];
      return { messages: here.length, unseen: here.filter((m) => !m.flags.has('\\Seen')).length };
    }
    async status(path: string): Promise<{ messages: number; unseen: number }> {
      server.calls.push(`status ${path}`);
      return this.statusOf(path);
    }
    async getMailboxLock(path: string, options?: { readOnly?: boolean }): Promise<{ release: () => void }> {
      if (!server.folders.some((folder) => folder.path === path)) throw new Error(`NO [NONEXISTENT] ${path}`);
      this.current = path;
      this.mailbox = { uidValidity: server.validity.get(path) ?? 1n, exists: this.here().length };
      server.calls.push(`lock ${path} ${options?.readOnly ? 'ro' : 'rw'}`);
      return { release: () => undefined };
    }
    private here(): FakeMessage[] {
      return [...(server.mail.get(this.current) ?? [])].sort((a, b) => a.uid - b.uid);
    }
    async search(query: Record<string, unknown>): Promise<number[] | false> {
      server.searches.push(query);
      server.calls.push('search');
      if (server.searching === 'refuse' && !query['uid'] && !query['header']) return false;
      return this.here().filter((m) => matches(m, query)).map((m) => m.uid);
    }
    private shape(m: FakeMessage, seq: number): Record<string, unknown> {
      return {
        seq, uid: m.uid, size: 1000 + m.uid, flags: new Set(m.flags), internalDate: m.date,
        envelope: {
          ...(m.messageId !== undefined ? { messageId: m.messageId } : {}), subject: m.subject, date: m.date,
          from: [{ name: m.name ?? '', address: m.from }], to: [{ address: 'me@qq.com' }],
        },
        bodyStructure: { type: 'text/plain', part: '1' },
        source: Buffer.from(`Message-ID: ${m.messageId ?? ''}\r\nSubject: ${m.subject}\r\nFrom: ${m.from}\r\n\r\n${m.body ?? ''}`),
        headers: Buffer.from(`Message-ID: ${m.messageId ?? ''}\r\nSubject: ${m.subject}\r\n\r\n`),
      };
    }
    async *fetch(range: string | number[], _query: unknown, options?: { uid?: boolean }): AsyncGenerator<Record<string, unknown>> {
      const all = this.here();
      if (Array.isArray(range) || options?.uid) {
        const wanted = Array.isArray(range) ? range : [];
        server.calls.push(`fetch uids ${wanted.length}`);
        for (const [i, m] of all.entries()) if (wanted.includes(m.uid)) yield this.shape(m, i + 1);
        return;
      }
      const [from, to] = String(range).split(':').map(Number);
      server.calls.push(`fetch seq ${from}:${to}`);
      for (const [i, m] of all.entries()) if (i + 1 >= from! && i + 1 <= to!) yield this.shape(m, i + 1);
    }
    async fetchOne(uid: string | number): Promise<Record<string, unknown> | false> {
      const all = this.here();
      const at = all.findIndex((m) => m.uid === Number(uid));
      server.calls.push(`fetchOne ${uid}`);
      return at === -1 ? false : this.shape(all[at]!, at + 1);
    }
    async messageFlagsAdd(range: number[], flags: string[]): Promise<boolean> {
      for (const m of this.here()) if (range.includes(m.uid)) for (const flag of flags) m.flags.add(flag);
      server.calls.push(`+flags ${flags.join(',')}`);
      return true;
    }
    async messageFlagsRemove(range: number[], flags: string[]): Promise<boolean> {
      for (const m of this.here()) if (range.includes(m.uid)) for (const flag of flags) m.flags.delete(flag);
      return true;
    }
    async messageMove(range: number[], destination: string): Promise<{ destination: string; uidMap: Map<number, number>; uidValidity: bigint }> {
      const moving = this.here().filter((m) => range.includes(m.uid));
      server.mail.set(this.current, (server.mail.get(this.current) ?? []).filter((m) => !range.includes(m.uid)));
      const there = server.mail.get(destination) ?? [];
      const uidMap = new Map<number, number>();
      let next = Math.max(0, ...there.map((m) => m.uid)) + 1;
      for (const m of moving) { uidMap.set(m.uid, next); m.uid = next; next += 1; }
      server.mail.set(destination, [...there, ...moving]);
      server.calls.push(`move ${this.current} -> ${destination}`);
      return { destination, uidMap, uidValidity: server.validity.get(destination) ?? 1n };
    }
  }
  return { server, ImapFlow };
});

vi.mock('imapflow', () => ({ ImapFlow: fake.ImapFlow }));

import { applyWebMailAction, fetchAttachmentManifestByMessageId, fetchReadableByMessageId, LiveMailError } from '../src/imap/client.js';
import { closeSessions, resumeConnecting, setSignInGap } from '../src/imap/connection.js';
import {
  browseFolder, envelopeMatches, forgetScans, handleShaped, liveHandle, mailboxFolders, parseLiveHandle, searchMailbox,
  SearchCancelled, untrustedSearch, type LiveHandle,
} from '../src/imap/mailbox.js';
import type { Account } from '../src/config.js';

const ME: Account = {
  name: 'personal', provider: 'imap', username: 'me@example.org', host: 'mail.example.org', port: 993,
  auth: 'password', password: 'x', folders: ['INBOX', 'spam'], useSsl: true,
};
const QQ: Account = { ...ME, name: 'qq', provider: 'qq', username: 'me@qq.com', host: 'imap.qq.com' };
const GMAIL: Account = { ...ME, name: 'work', provider: 'gmail_pw', username: 'me@gmail.com', host: 'imap.gmail.com' };

let clock = Date.parse('2026-11-01T08:00:00Z');
function put(folder: string, subject: string, options: { id?: string | null; from?: string; name?: string; body?: string; seen?: boolean; uid?: number } = {}): number {
  const list = fake.server.mail.get(folder) ?? [];
  const uid = options.uid ?? Math.max(0, ...list.map((m) => m.uid)) + 1;
  clock += 3_600_000;
  list.push({
    uid, subject, from: options.from ?? 'sender@example.com', ...(options.name ? { name: options.name } : {}),
    ...(options.id === null ? {} : { messageId: options.id ?? `<${folder.toLowerCase().replace(/\W/g, '')}-${uid}@x>` }),
    body: options.body ?? '', flags: new Set(options.seen ? ['\\Seen'] : []), date: new Date(clock),
  });
  fake.server.mail.set(folder, list);
  return uid;
}

beforeEach(() => {
  closeSessions();
  resumeConnecting();
  setSignInGap(0);
  forgetScans();
  fake.server.reset();
  fake.server.folders = [
    { path: 'INBOX' }, { path: 'Archive', specialUse: '\\Archive' }, { path: 'Junk', specialUse: '\\Junk' },
    { path: 'Sent Messages', specialUse: '\\Sent' }, { path: 'Deleted Messages', specialUse: '\\Trash' },
    { path: 'Projects', flags: ['\\Noselect'] }, { path: 'Projects/2026' }, { path: 'Drafts', specialUse: '\\Drafts' },
  ];
});

describe('a live handle', () => {
  const handle: LiveHandle = { account: 'me@qq.com', folder: '其他文件夹/发票', uidValidity: '1700000000', uid: 42, messageId: '<a@x>' };

  it('says where one message is, and is read back exactly', () => {
    const made = liveHandle(handle);
    expect(made.startsWith('live:')).toBe(true);
    expect(handleShaped(made)).toBe(true);
    expect(parseLiveHandle(made)).toEqual(handle);
    // A message with no Message-ID is named by its place alone.
    expect(parseLiveHandle(liveHandle({ ...handle, messageId: '' }))).toEqual({ ...handle, messageId: '' });
  });

  it('refuses what this server did not make', () => {
    const made = liveHandle(handle);
    const body = (parts: unknown[]): string => `live:${Buffer.from(JSON.stringify(parts)).toString('base64url')}`;
    for (const forged of [
      'live:', 'live:not base64!', `${made}x`, made.replace('live:', 'live:A'),
      body([2, 'me@qq.com', 'INBOX', '1', 1, '']), body([1, 'me@qq.com', 'INBOX', 'one', 1, '']),
      body([1, 'me@qq.com', 'INBOX', '1', 0, '']), body([1, 'me@qq.com', 'INBOX', '1', 1.5, '']), body([1, '', 'INBOX', '1', 1, '']),
      body([1, 'me@qq.com', 'INBOX', '1', 1]),
      // The same parts spelled another way: one message has one handle.
      `live:${Buffer.from(JSON.stringify([1, 'me@qq.com', 'INBOX', '1', 1, ''], null, 1)).toString('base64url')}`,
    ]) expect(parseLiveHandle(forged), forged).toBeUndefined();
    expect(handleShaped('<live:a@x>')).toBe(false);
    expect(handleShaped('me@qq.com|<a@x>')).toBe(false);
  });
});

describe('the folders of a mailbox', () => {
  it('lists them as a mail client does, with their counts, from LIST-STATUS when the server has it', async () => {
    fake.server.capabilities.add('LIST-STATUS');
    put('INBOX', 'one'); put('INBOX', 'two', { seen: true }); put('Projects/2026', 'plan', { seen: true });
    const folders = await mailboxFolders(ME, { counts: true });
    expect(folders.map((f) => [f.path, f.role])).toEqual([
      ['INBOX', 'inbox'], ['Drafts', 'drafts'], ['Sent Messages', 'sent'], ['Archive', 'archive'], ['Junk', 'junk'],
      ['Deleted Messages', 'trash'], ['Projects', null], ['Projects/2026', null],
    ]);
    expect(folders[0]).toMatchObject({ messages: 2, unseen: 1, depth: 0, parent: null });
    expect(folders.find((f) => f.path === 'Projects/2026')).toMatchObject({ name: '2026', parent: 'Projects', depth: 1, messages: 1, unseen: 0 });
    expect(folders.find((f) => f.path === 'Projects')).toMatchObject({ selectable: false });
    expect(folders.find((f) => f.path === 'Projects')).not.toHaveProperty('messages');
    expect(fake.server.calls).toContain('list-status');
    expect(fake.server.calls.filter((call) => call.startsWith('status'))).toEqual([]);
  });

  it('asks STATUS one folder at a time where LIST cannot say, and nothing for a folder that holds only folders', async () => {
    put('INBOX', 'one');
    const folders = await mailboxFolders(ME, { counts: true });
    expect(folders[0]).toMatchObject({ path: 'INBOX', messages: 1, unseen: 1 });
    expect(fake.server.calls).toContain('status INBOX');
    expect(fake.server.calls).not.toContain('status Projects');
    // Without counts, LIST alone.
    closeSessions();
    fake.server.calls = [];
    expect((await mailboxFolders(ME))[0]).not.toHaveProperty('messages');
    expect(fake.server.calls.filter((call) => call.startsWith('status'))).toEqual([]);
  });

  it('puts the folders every mailbox has first, wherever the server keeps them', async () => {
    fake.server.folders = [
      { path: 'INBOX' }, { path: '[Gmail]', flags: ['\\Noselect'] }, { path: '[Gmail]/All Mail', specialUse: '\\All' },
      { path: '[Gmail]/Spam', specialUse: '\\Junk' }, { path: '[Gmail]/Trash', specialUse: '\\Trash' }, { path: 'Receipts' },
    ];
    const folders = await mailboxFolders(GMAIL);
    expect(folders.map((f) => [f.path, f.role])).toEqual([
      ['INBOX', 'inbox'], ['[Gmail]/All Mail', 'all'], ['[Gmail]/Spam', 'junk'], ['[Gmail]/Trash', 'trash'], ['[Gmail]', null], ['Receipts', null],
    ]);
  });
});

describe('a folder, a page at a time', () => {
  it('lists the newest first, and pages under the oldest it showed', async () => {
    for (let i = 1; i <= 7; i += 1) put('Archive', `message ${i}`, { seen: i < 6 });
    const first = await browseFolder(ME, 'Archive', { limit: 3 });
    expect(first.items.map((item) => item.subject)).toEqual(['message 7', 'message 6', 'message 5']);
    expect(first).toMatchObject({ total: 7, folder: 'Archive', uidValidity: '1', next: '1.5' });
    expect(first.items[0]).toMatchObject({ uid: 7, flags: { seen: false, flagged: false, answered: false }, from: { address: 'sender@example.com' } });
    // Envelopes and flags, never a body, under a read-only lock.
    expect(fake.server.calls).toContain('fetch seq 5:7');
    expect(fake.server.calls.filter((call) => call.startsWith('lock'))).toEqual(['lock Archive ro']);
    const second = await browseFolder(ME, 'Archive', { limit: 3, before: first.next });
    expect(second.items.map((item) => item.uid)).toEqual([4, 3, 2]);
    const last = await browseFolder(ME, 'Archive', { limit: 3, before: second.next });
    expect(last.items.map((item) => item.uid)).toEqual([1]);
    expect(last.next).toBeNull();
    // Each item's handle names it where it was listed.
    expect(parseLiveHandle(first.items[0]!.handle)).toEqual({ account: ME.username, folder: 'Archive', uidValidity: '1', uid: 7, messageId: '<archive-7@x>' });
  });

  it('pages on from a message that has gone since, by counting what is below it', async () => {
    for (let i = 1; i <= 6; i += 1) put('INBOX', `message ${i}`);
    const page = await browseFolder(ME, 'INBOX', { limit: 2 });
    expect(page.next).toBe('1.5');
    fake.server.mail.set('INBOX', fake.server.mail.get('INBOX')!.filter((m) => m.uid !== 5));
    const next = await browseFolder(ME, 'INBOX', { limit: 2, before: page.next });
    expect(next.items.map((item) => item.uid)).toEqual([4, 3]);
  });

  it('refuses to page on in a folder that was rebuilt, and refuses a folder that is not there', async () => {
    put('INBOX', 'one'); put('INBOX', 'two');
    const page = await browseFolder(ME, 'INBOX', { limit: 1 });
    fake.server.validity.set('INBOX', 2n);
    await expect(browseFolder(ME, 'INBOX', { before: page.next })).rejects.toMatchObject({ code: 'cursor' });
    await expect(browseFolder(ME, 'INBOX', { before: 'nonsense' })).rejects.toMatchObject({ code: 'cursor' });
    await expect(browseFolder(ME, 'Nowhere')).rejects.toBeInstanceOf(LiveMailError);
    await expect(browseFolder(ME, 'Projects')).rejects.toMatchObject({ code: 'folder' });
  });

  it('gives a message without a Message-ID the id a stored copy of it carries', async () => {
    put('INBOX', 'no id', { id: null });
    const [item] = (await browseFolder(ME, 'INBOX')).items;
    expect(item!.messageId).toBe('');
    expect(item!.storedId).toMatch(/^<generated-[0-9a-f]{32}@mailsift>$/);
  });
});

describe('reading and acting on a message by its handle', () => {
  const exact = (handle: string) => {
    const h = parseLiveHandle(handle)!;
    return { messageId: h.messageId, hint: { folder: h.folder, uid: h.uid, uidValidity: h.uidValidity, exact: true } };
  };

  it('reads it where the folder listed it, without searching for it', async () => {
    put('Projects/2026', 'plan', { body: 'The plan.' });
    const [item] = (await browseFolder(ME, 'Projects/2026')).items;
    fake.server.calls = [];
    const asked = exact(item!.handle);
    const live = await fetchReadableByMessageId(ME, asked.messageId, asked.hint);
    expect(live).toMatchObject({ folder: 'Projects/2026', uid: 1, readable: { subject: 'plan' } });
    expect(fake.server.calls).not.toContain('search');
  });

  it('is refused, never followed, once the message has moved, the folder was rebuilt or is gone', async () => {
    put('INBOX', 'one');
    const [item] = (await browseFolder(ME, 'INBOX')).items;
    const asked = exact(item!.handle);
    // Moved to the archive: the same Message-ID is there now, and is not looked for.
    fake.server.mail.set('Archive', fake.server.mail.get('INBOX')!);
    fake.server.mail.set('INBOX', []);
    await expect(fetchReadableByMessageId(ME, asked.messageId, asked.hint)).rejects.toMatchObject({ code: 'moved' });
    await expect(applyWebMailAction(ME, asked.messageId, 'trash', { folderHint: 'INBOX', hint: asked.hint })).rejects.toMatchObject({ code: 'moved' });
    expect(fake.server.calls).not.toContain('search');
    expect(fake.server.mail.get('Archive')).toHaveLength(1);

    // Another message took the UID.
    put('INBOX', 'someone else', { uid: 1, id: '<other@x>' });
    await expect(fetchAttachmentManifestByMessageId(ME, asked.messageId, asked.hint)).rejects.toMatchObject({ code: 'moved' });
    // The folder was rebuilt.
    fake.server.validity.set('INBOX', 9n);
    await expect(fetchReadableByMessageId(ME, asked.messageId, asked.hint)).rejects.toMatchObject({ code: 'stale' });
    await expect(applyWebMailAction(ME, asked.messageId, 'star', { hint: asked.hint })).rejects.toMatchObject({ code: 'stale' });
    // The folder is gone.
    const elsewhere = { ...asked.hint, folder: 'Gone' };
    await expect(fetchReadableByMessageId(ME, asked.messageId, elsewhere)).rejects.toMatchObject({ code: 'folder' });
    expect([...fake.server.mail.get('INBOX')![0]!.flags]).toEqual([]);
  });

  it('acts on it inside the writable lock once it is known to be that message, and says where it went', async () => {
    put('INBOX', 'one');
    const [item] = (await browseFolder(ME, 'INBOX')).items;
    const asked = exact(item!.handle);
    const done = await applyWebMailAction(ME, asked.messageId, 'archive', { folderHint: 'INBOX', hint: asked.hint });
    expect(done).toMatchObject({ sourceFolder: 'INBOX', destinationFolder: 'Archive', destinationUid: 1, destinationUidValidity: '1' });
    expect(fake.server.calls).toContain('lock INBOX rw');
    expect(fake.server.calls).not.toContain('search');
  });

  it('names a message with no Message-ID by its place alone, and refuses one that has an id when the handle has none', async () => {
    put('INBOX', 'no id', { id: null });
    const [item] = (await browseFolder(ME, 'INBOX')).items;
    const asked = exact(item!.handle);
    expect(asked.messageId).toBe('');
    await expect(applyWebMailAction(ME, '', 'star', { hint: asked.hint })).resolves.toMatchObject({ sourceFolder: 'INBOX' });
    expect([...fake.server.mail.get('INBOX')![0]!.flags]).toEqual(['\\Flagged']);
    fake.server.mail.set('INBOX', []);
    put('INBOX', 'with an id', { uid: 1, id: '<late@x>' });
    await expect(applyWebMailAction(ME, '', 'star', { hint: asked.hint })).rejects.toMatchObject({ code: 'moved' });
  });
});

describe('searching the mailbox', () => {
  beforeEach(() => {
    put('INBOX', 'Invoice 7 for October', { from: 'billing@vendor.example', name: 'Vendor' });
    put('INBOX', 'Lunch?', { from: 'ann@example.com', name: 'Ann', body: 'about the invoice' });
    put('INBOX', '发票已开具', { from: 'fapiao@example.cn', name: '税务' });
    put('Archive', 'Old invoice', { from: 'billing@vendor.example' });
    put('Junk', 'Invoice prize', {});
  });

  it('asks the server for the subject, the sender and the body, in the inbox and the archive by default', async () => {
    const page = await searchMailbox(ME, { query: 'invoice' });
    expect(page.folders).toEqual(['INBOX', 'Archive']);
    expect(page.items.map((item) => item.subject)).toEqual(['Old invoice', 'Lunch?', 'Invoice 7 for October']);
    expect(page.total).toBe(3);
    expect(page.limited).toBeUndefined();
    expect(fake.server.searches[0]).toEqual({ or: [{ subject: 'invoice' }, { from: 'invoice' }, { body: 'invoice' }] });
    // One folder when one is named.
    expect((await searchMailbox(ME, { query: 'invoice', folder: 'Junk' })).items.map((item) => item.subject)).toEqual(['Invoice prize']);
  });

  it('asks Gmail in its own words, in All Mail alone', async () => {
    fake.server.folders = [{ path: 'INBOX' }, { path: '[Gmail]/All Mail', specialUse: '\\All' }];
    put('[Gmail]/All Mail', 'Invoice 9', {});
    const page = await searchMailbox(GMAIL, { query: 'from:vendor has:attachment' });
    expect(page.folders).toEqual(['[Gmail]/All Mail']);
    expect(fake.server.searches).toEqual([{ gmraw: 'from:vendor has:attachment' }]);
  });

  it('pages on across the folders it searched', async () => {
    const first = await searchMailbox(ME, { query: 'invoice', limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.next).not.toBeNull();
    const second = await searchMailbox(ME, { query: 'invoice', limit: 2, before: first.next });
    expect(second.items.map((item) => item.subject)).toEqual(['Invoice 7 for October']);
    expect(second.next).toBeNull();
    await expect(searchMailbox(ME, { query: 'invoice', before: '!!' })).rejects.toMatchObject({ code: 'cursor' });
  });

  it('reads only the subject and sender of the newest mail on QQ, and says so', async () => {
    const page = await searchMailbox(QQ, { query: '发票' });
    expect(fake.server.searches).toEqual([]);
    expect(page.items.map((item) => item.subject)).toEqual(['发票已开具']);
    expect(page.limited).toEqual({ reason: 'provider', scanned: 3 });
    // A word that is only in a body is not found this way, and the answer does not pretend otherwise.
    const body = await searchMailbox(QQ, { query: 'about the invoice', folder: 'INBOX' });
    expect(body.items).toEqual([]);
    expect(body.limited?.reason).toBe('provider');
    expect(untrustedSearch({ ...ME, provider: 'imap', host: 'imap.exmail.qq.com' })).toBe(true);
  });

  it('falls back the same way when the server refuses, or finds nothing for text outside ASCII', async () => {
    fake.server.searching = 'refuse';
    const refused = await searchMailbox(ME, { query: 'Ann', folder: 'INBOX' });
    expect(refused.items.map((item) => item.subject)).toEqual(['Lunch?']);
    expect(refused.limited?.reason).toBe('refused');
    fake.server.searching = 'ascii';
    const unicode = await searchMailbox(ME, { query: '税务', folder: 'INBOX' });
    expect(unicode.items.map((item) => item.subject)).toEqual(['发票已开具']);
    expect(unicode.limited?.reason).toBe('unicode');
    // A search the server answers, with nothing found for plain ASCII, is an answer.
    const none = await searchMailbox(ME, { query: 'nothing like it', folder: 'INBOX' });
    expect(none.limited).toBeUndefined();
  });

  it('stops when a newer search takes its place', async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(searchMailbox(ME, { query: 'invoice', signal: stop.signal })).rejects.toBeInstanceOf(SearchCancelled);
  });

  it('matches every word in the subject or the sender, in any case and width', () => {
    const item = { subject: 'Ｉｎｖｏｉｃｅ for October', from: { name: 'Vendor Ltd', address: 'billing@vendor.example' } };
    expect(envelopeMatches(item, 'invoice october')).toBe(true);
    expect(envelopeMatches(item, 'vendor.example')).toBe(true);
    expect(envelopeMatches(item, 'invoice november')).toBe(false);
    expect(envelopeMatches(item, '   ')).toBe(false);
  });
});
