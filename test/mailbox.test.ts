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
    /** How long some commands take, in milliseconds; a connection closed meanwhile fails them, as a real one does. */
    delay: { search: 0, fetchOne: 0, move: 0, connect: 0 },
    /** Sign-ins completed, when each began (ms), and how many connections are open now and were at most. */
    connects: 0,
    connectStarts: [] as number[],
    open: 0,
    maxOpen: 0,
    /** A move the server makes and then never answers: the line drops after it. */
    loseMoveAnswer: false,
    reset(): void {
      this.folders = []; this.mail = new Map(); this.validity = new Map(); this.capabilities = new Set();
      this.calls = []; this.searching = 'exact'; this.searches = []; this.delay = { search: 0, fetchOne: 0, move: 0, connect: 0 };
      this.connects = 0; this.connectStarts = []; this.open = 0; this.maxOpen = 0; this.loseMoveAnswer = false;
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
    // HEADER Message-ID is exact, as servers that have it answer it; TEXT is anywhere in the message.
    if (query['header'] !== undefined) return (m.messageId ?? '') === String((query['header'] as Record<string, unknown>)['message-id']);
    if (query['text'] !== undefined) return has(query['text'], `${m.messageId ?? ''} ${m.subject} ${m.from} ${m.body ?? ''}`);
    if (query['since'] !== undefined) return m.date.valueOf() >= (query['since'] as Date).valueOf();
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
    private waiting: Array<() => void> = [];
    private async wait(ms: number): Promise<void> {
      if (!ms) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        this.waiting.push(() => { clearTimeout(timer); reject(new Error('Connection closed')); });
      });
    }
    on(): this { return this; }
    async connect(): Promise<void> {
      server.connectStarts.push(Date.now());
      this.signingIn = true;
      try {
        await this.wait(server.delay.connect);
      } finally {
        this.signingIn = false;
      }
      if (this.closed) throw new Error('Connection closed');
      this.usable = true; server.connects += 1; server.open += 1; server.maxOpen = Math.max(server.maxOpen, server.open);
    }
    private signingIn = false;
    private closed = false;
    private hangUp(): void {
      if (this.usable) server.open -= 1;
      this.usable = false;
    }
    close(): void { this.closed = true; this.hangUp(); for (const fail of this.waiting.splice(0)) fail(); }
    async logout(): Promise<void> { this.hangUp(); }

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
      if (!query['uid']) await this.wait(server.delay.search);
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
      await this.wait(server.delay.fetchOne);
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
      await this.wait(server.delay.move);
      const moving = this.here().filter((m) => range.includes(m.uid));
      server.mail.set(this.current, (server.mail.get(this.current) ?? []).filter((m) => !range.includes(m.uid)));
      const there = server.mail.get(destination) ?? [];
      const uidMap = new Map<number, number>();
      let next = Math.max(0, ...there.map((m) => m.uid)) + 1;
      for (const m of moving) { uidMap.set(m.uid, next); m.uid = next; next += 1; }
      server.mail.set(destination, [...there, ...moving]);
      server.calls.push(`move ${this.current} -> ${destination}`);
      if (server.loseMoveAnswer) { this.close(); throw new Error('Connection closed'); }
      return { destination, uidMap, uidValidity: server.validity.get(destination) ?? 1n };
    }
  }
  return { server, ImapFlow };
});

vi.mock('imapflow', () => ({ ImapFlow: fake.ImapFlow }));

import { applyMailActions, applyWebMailAction, fetchAttachmentManifestByMessageId, fetchReadableByMessageId, LiveMailError } from '../src/imap/client.js';
import { closeSessions, ownConnections, resumeConnecting, setSignInGap } from '../src/imap/connection.js';
import { createHmac, randomBytes } from 'node:crypto';
import {
  browseFolder, envelopeMatches, forgetScans, HANDLE_KEY_META, handleShaped, liveHandle, mailboxFolders, parseLiveHandle, searchMailbox,
  SearchCancelled, setSearchTimeout, untrustedSearch, useHandleKey, type LiveHandle,
} from '../src/imap/mailbox.js';
import type { Account } from '../src/config.js';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { fallbackMessageId } from '../src/imap/message.js';
import { StateStore } from '../src/services/state.js';
import { Watcher } from '../src/services/watcher.js';
import { forgetLive } from '../src/web-actions.js';
import { routeWeb, SESSION_COOKIE } from '../src/web.js';
import { makeMessage, RecordingSink } from './helpers.js';

const ME: Account = {
  name: 'personal', provider: 'imap', username: 'me@example.org', host: 'mail.example.org', port: 993,
  auth: 'password', password: 'x', folders: ['INBOX', 'spam'], useSsl: true,
};
const QQ: Account = { ...ME, name: 'qq', provider: 'qq', username: 'me@qq.com', host: 'imap.qq.com' };
const GMAIL: Account = { ...ME, name: 'work', provider: 'gmail_pw', username: 'me@gmail.com', host: 'imap.gmail.com' };

let clock = Date.parse('2026-11-01T08:00:00Z');
function put(
  folder: string, subject: string,
  options: { id?: string | null; from?: string; name?: string; body?: string; seen?: boolean; uid?: number; date?: Date } = {},
): number {
  const list = fake.server.mail.get(folder) ?? [];
  const uid = options.uid ?? Math.max(0, ...list.map((m) => m.uid)) + 1;
  clock += 3_600_000;
  list.push({
    uid, subject, from: options.from ?? 'sender@example.com', ...(options.name ? { name: options.name } : {}),
    ...(options.id === null ? {} : { messageId: options.id ?? `<${folder.toLowerCase().replace(/\W/g, '')}-${uid}@x>` }),
    body: options.body ?? '', flags: new Set(options.seen ? ['\\Seen'] : []), date: options.date ?? new Date(clock),
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

  it('is always one this server takes back, whatever a sender wrote as the Message-ID', () => {
    const control = Array.from({ length: 500 }, (_, n) => String.fromCharCode(n % 31 + 1)).join('');
    for (const messageId of ['<' + 'x'.repeat(1200) + '@spam.example>', control, '<' + '"\\'.repeat(400) + '>', '<' + '发'.repeat(900) + '>']) {
      const made = liveHandle({ ...handle, messageId });
      const back = parseLiveHandle(made);
      expect(back, messageId.slice(0, 20)).toBeDefined();
      // Short enough to be given back in any request that takes one.
      expect(made.length).toBeLessThanOrEqual(4096);
      // Too long to carry, it is carried as its digest, and spelled one way.
      if (JSON.stringify(messageId).length > 512) expect(back).toMatchObject({ messageId: '', idDigest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
      else expect(back).toMatchObject({ messageId });
      expect(liveHandle(back!)).toBe(made);
    }
  });

  it('adopts the key another process kept first, rather than writing over it', () => {
    const state = new StateStore(':memory:');
    const theirs = randomBytes(32).toString('base64');
    // This process looked before the other one wrote, and saw nothing; the other then kept its key.
    let looked = false;
    const racing = Object.create(state, {
      getMeta: { value: (key: string) => { if (!looked) { looked = true; state.setMeta(HANDLE_KEY_META, theirs); return undefined; } return state.getMeta(key); } },
    }) as StateStore;
    useHandleKey(racing);
    expect(state.getMeta(HANDLE_KEY_META)).toBe(theirs);
    // What this process signs now, the other one takes: it is signed with the key that was kept.
    const made = liveHandle(handle);
    const payload = made.slice('live:'.length, made.lastIndexOf('.'));
    const signature = createHmac('sha256', Buffer.from(theirs, 'base64')).update(`live:${payload}`, 'utf8').digest('base64url').slice(0, 22);
    expect(made.endsWith(`.${signature}`)).toBe(true);
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

describe('one action on many messages', () => {
  const at = (folder: string, uid: number, id: string) => ({ messageId: id, hint: { folder, uid, uidValidity: '1', exact: true } });

  it('acts on each over one connection, each with an outcome of its own', async () => {
    put('INBOX', 'one'); put('INBOX', 'two'); put('Projects/2026', 'three');
    const outcomes = await applyMailActions(ME, [
      at('INBOX', 1, '<inbox-1@x>'),
      at('INBOX', 2, '<someone-else@x>'),
      { messageId: '<projects2026-1@x>', folderHint: 'Projects/2026' },
      { messageId: '<nowhere@x>' },
    ], 'star');
    expect(outcomes[0]).toMatchObject({ done: { sourceFolder: 'INBOX' } });
    expect((outcomes[1] as { error: unknown }).error).toMatchObject({ code: 'moved' });
    expect(outcomes[2]).toMatchObject({ done: { sourceFolder: 'Projects/2026' } });
    expect(outcomes[3]).toEqual({ missing: true });
    expect(fake.server.calls.filter((call) => call === 'list')).toHaveLength(1);
    expect([...fake.server.mail.get('INBOX')![0]!.flags]).toEqual(['\\Flagged']);
    expect([...fake.server.mail.get('INBOX')![1]!.flags]).toEqual([]);
  });

  it('files spam in the spam folder, says where each landed, and moves only spam back with not_spam', async () => {
    put('INBOX', 'offer'); put('INBOX', 'prize');
    const told: number[] = [];
    const spam = await applyMailActions(ME, [at('INBOX', 1, '<inbox-1@x>'), at('INBOX', 2, '<inbox-2@x>')], 'spam', {}, (index) => told.push(index));
    expect(told).toEqual([0, 1]);
    expect(spam.map((o) => (o as { done: { destinationFolder: string; destinationIsSpam: boolean } }).done)).toMatchObject([
      { destinationFolder: 'Junk', destinationIsSpam: true, destinationUid: 1 }, { destinationFolder: 'Junk', destinationUid: 2 },
    ]);
    put('Archive', 'kept');
    const back = await applyMailActions(ME, [at('Junk', 1, '<inbox-1@x>'), at('Archive', 1, '<archive-1@x>')], 'not_spam');
    expect(back[0]).toMatchObject({ done: { sourceFolder: 'Junk', destinationFolder: 'INBOX' } });
    expect((back[1] as { error: unknown }).error).toMatchObject({ code: 'not_applicable' });
    expect(fake.server.mail.get('Archive')).toHaveLength(1);
  });

  it('says a mailbox has no spam folder rather than guessing one, for every message', async () => {
    fake.server.folders = fake.server.folders.filter((f) => f.path !== 'Junk');
    put('INBOX', 'offer');
    const outcomes = await applyMailActions(ME, [at('INBOX', 1, '<inbox-1@x>')], 'spam');
    expect((outcomes[0] as { error: unknown }).error).toMatchObject({ code: 'invalid_destination', message: 'this mailbox has no spam folder' });
    expect(fake.server.mail.get('INBOX')).toHaveLength(1);
  });

  it('refuses a move to nowhere for every message without touching any', async () => {
    put('INBOX', 'one');
    const outcomes = await applyMailActions(ME, [at('INBOX', 1, '<inbox-1@x>')], 'move', { destination: 'Nowhere' });
    expect((outcomes[0] as { error: unknown }).error).toMatchObject({ code: 'invalid_destination' });
    expect((await applyMailActions(ME, [at('INBOX', 1, '<inbox-1@x>')], 'move'))[0]).toMatchObject({ error: { code: 'invalid_destination' } });
  });
});

// ---- What a review of this stage found, each against the fake server above ----

describe('which stored record a live message is, through the real routes', () => {
  const store = (): StateStore => new StateStore(':memory:');
  function request(path: string, options: { method?: string; body?: unknown; as?: 'read' | 'write' } = {}): IncomingMessage {
    const payload = options.body === undefined ? '' : JSON.stringify(options.body);
    return Object.assign(Readable.from(payload ? [Buffer.from(payload)] : []), {
      method: options.method ?? 'GET', url: path,
      headers: { cookie: `${SESSION_COOKIE}=${options.as === 'read' ? 'read-token' : 'write-token'}` },
    }) as unknown as IncomingMessage;
  }
  async function call(state: StateStore, path: string, options: { method?: string; body?: unknown; as?: 'read' | 'write' } = {}): Promise<Record<string, unknown>> {
    const answer = await routeWeb(request(path, options), new URL(path, 'http://127.0.0.1:8410'), 'read-token', state, 'probe', { writeToken: 'write-token' });
    return JSON.parse(String(answer.body)) as Record<string, unknown>;
  }
  /** A message the poller stored: where it found it, and (unless left out) its UID there. */
  function stored(state: StateStore, key: string, id: string, folder: string, sender: string, uid?: number): void {
    state.markSeen(key, ME.username, 'stored');
    state.recordOutcome(key, 'critical', true, {
      messageId: id, sender, folder, summary: 'the real one', ...(uid ? { uid, uidValidity: '1' } : {}),
    });
  }
  const folder = async (state: StateStore, path: string): Promise<Array<Record<string, unknown>>> =>
    (await call(state, `/api/folder?account=${encodeURIComponent(ME.username)}&folder=${encodeURIComponent(path)}`))['items'] as Array<Record<string, unknown>>;
  const where = (): string[] => [...fake.server.mail.entries()].flatMap(([path, list]) => list.map((m) => `${path}#${m.uid}#${m.from}`)).sort();

  beforeEach(() => {
    process.env.MAIL_ACCOUNT_1 = `imap|${ME.username}|x|${ME.host}`;
    forgetLive();

  });

  it('leaves a stored message alone when its Sent copy, which shares its Message-ID, is binned, and acts on the message by its key after', async () => {
    const state = store();
    put('INBOX', 'note to self', { id: '<note@x>', from: ME.username });
    put('Sent Messages', 'note to self', { id: '<note@x>', from: ME.username });
    stored(state, 'k', '<note@x>', 'INBOX', ME.username, 1);
    const [copy] = await folder(state, 'Sent Messages');
    // The copy is not the record's message: no key, no judgement.
    expect(copy).not.toHaveProperty('key');
    expect(await call(state, '/api/action', { method: 'POST', body: { key: copy!['handle'], action: 'trash' } })).toMatchObject({ ok: true });
    expect(state.getMail('k')).toMatchObject({ folder: 'INBOX', handledAt: null });
    expect(state.placeOf('k')).toEqual({ uid: 1, uidValidity: '1' });
    // By its key, the record's own message is the one archived; the binned copy stays binned.
    expect(await call(state, '/api/action', { method: 'POST', body: { key: 'k', action: 'archive' } })).toMatchObject({ ok: true });
    expect(where()).toEqual([`Archive#1#${ME.username}`, `Deleted Messages#1#${ME.username}`]);
  });

  it('does not let a spoof in the same folder take the record over by being read or binned', async () => {
    const state = store();
    put('INBOX', 'Q3 numbers', { id: '<q3@corp>', from: 'boss@corp.com' });
    put('INBOX', 'Q3 numbers', { id: '<q3@corp>', from: 'attacker@evil.example' });
    stored(state, 'k', '<q3@corp>', 'INBOX', 'boss@corp.com', 1);
    const items = await folder(state, 'INBOX');
    expect(items.map((item) => [item['uid'], item['key'] ?? null])).toEqual([[2, null], [1, 'k']]);
    const spoof = items[0]!['handle'] as string;
    // Read by a read session: the record still remembers its own message.
    const read = await call(state, `/api/message?id=${encodeURIComponent(spoof)}&live=true`, { as: 'read' });
    expect(read).toMatchObject({ stored: false, sender: 'attacker@evil.example' });
    expect(read['importance']).toBeNull();
    expect(state.placeOf('k')).toEqual({ uid: 1, uidValidity: '1' });
    expect((await call(state, '/api/reply?key=k'))['to']).toEqual(['boss@corp.com']);
    // Binned, and put in spam, as the owner would a spoof: the record is not touched, and its sender is not muted.
    expect(await call(state, '/api/bulk', { method: 'POST', body: { items: [spoof], action: 'spam' } })).toMatchObject({ done: 1 });
    expect(state.getMail('k')).toMatchObject({ folder: 'INBOX', handledAt: null });
    expect(state.feedbackSummary()['spam']).toBeUndefined();
    expect(state.feedbackRuleHints(1).neverImportant).toEqual([]);
    expect((await call(state, '/api/reply?key=k'))['to']).toEqual(['boss@corp.com']);
  });

  it('reads a record by its key from its own sender only, and never moves where it says its message is to a look-alike', async () => {
    const state = store();
    put('INBOX', 'Q3 numbers', { id: '<q3@corp>', from: 'attacker@evil.example' });
    put('INBOX', 'Q3 numbers', { id: '<q3@corp>', from: 'boss@corp.com' });
    // No place known yet: the look-alike, older, is found first by its Message-ID, and passed over. The real one is read, and its place learnt.
    stored(state, 'k', '<q3@corp>', 'INBOX', 'boss@corp.com');
    const read = async (on: StateStore): Promise<Record<string, unknown>> => { forgetLive(); return call(on, '/api/message?id=k&live=true'); };
    expect(await read(state)).toMatchObject({ dedupKey: 'k', from: { address: 'boss@corp.com' } });
    expect(state.placeOf('k')).toEqual({ uid: 2, uidValidity: '1' });
    // Known: the real one is moved away by another mail client. The look-alike is not it: not found, and the place stays.
    fake.server.mail.set('INBOX', fake.server.mail.get('INBOX')!.filter((m) => m.uid !== 2));
    const gone = await read(state);
    expect(gone).toMatchObject({ code: 'notInMailbox' });
    expect(JSON.stringify(gone)).not.toContain('attacker@evil.example');
    expect(state.placeOf('k')).toEqual({ uid: 2, uidValidity: '1' });
    // A record whose sender the remaining message is from: that is its message, and its place is learnt.
    const other = store();
    stored(other, 'k', '<q3@corp>', 'INBOX', 'attacker@evil.example');
    expect(await read(other)).toMatchObject({ from: { address: 'attacker@evil.example' } });
    expect(other.placeOf('k')).toEqual({ uid: 1, uidValidity: '1' });
  });

  it('does not answer, read or act on a look-alike by the record\'s key once the real message left its place', async () => {
    const state = store();
    put('INBOX', 'Q3 numbers', { id: '<q3@corp>', from: 'boss@corp.com' });
    put('INBOX', 'Q3 numbers', { id: '<q3@corp>', from: 'attacker@evil.example' });
    stored(state, 'k', '<q3@corp>', 'INBOX', 'boss@corp.com', 1);
    // Another mail client archives the real one.
    const real = fake.server.mail.get('INBOX')!.find((m) => m.uid === 1)!;
    fake.server.mail.set('INBOX', fake.server.mail.get('INBOX')!.filter((m) => m !== real));
    fake.server.mail.set('Archive', [{ ...real, uid: 1 }]);
    const reply = await call(state, '/api/reply?key=k');
    expect(JSON.stringify(reply)).not.toContain('attacker@evil.example');
    expect(JSON.stringify(await call(state, '/api/message?id=k&live=true'))).not.toContain('attacker@evil.example');
    // Bin by the key: the look-alike is not touched, and the record is not handed to it.
    expect(await call(state, '/api/action', { method: 'POST', body: { key: 'k', action: 'trash' } })).toMatchObject({ code: 'actionNotFound' });
    expect(where()).toEqual(['Archive#1#boss@corp.com', 'INBOX#2#attacker@evil.example']);
    expect(state.getMail('k')).toMatchObject({ folder: 'INBOX', handledAt: null });
    expect(state.placeOf('k')).toEqual({ uid: 1, uidValidity: '1' });
    const [listed] = await folder(state, 'INBOX');
    expect(listed).not.toHaveProperty('key');
  });

  it('does not take a look-alike in spam for the record\'s message when the real one was deleted', async () => {
    const state = store();
    put('INBOX', 'Q3 numbers', { id: '<q3@corp>', from: 'boss@corp.com' });
    put('Junk', 'Q3 numbers', { id: '<q3@corp>', from: 'attacker@evil.example' });
    stored(state, 'k', '<q3@corp>', 'INBOX', 'boss@corp.com', 1);
    // Deleted on the phone.
    fake.server.mail.set('INBOX', []);
    expect(JSON.stringify(await call(state, '/api/reply?key=k'))).not.toContain('attacker@evil.example');
    expect(await call(state, '/api/action', { method: 'POST', body: { key: 'k', action: 'archive' } })).toMatchObject({ code: 'actionNotFound' });
    // The spam stays in spam, and the record stays where it was, open.
    expect(where()).toEqual(['Junk#1#attacker@evil.example']);
    expect(state.getMail('k')).toMatchObject({ folder: 'INBOX', handledAt: null });
    expect(state.placeOf('k')).toEqual({ uid: 1, uidValidity: '1' });
  });

  it('finds the record\'s own message by its key wherever its sender\'s copy went, as before', async () => {
    const state = store();
    put('INBOX', 'Q3 numbers', { id: '<q3@corp>', from: 'boss@corp.com' });
    stored(state, 'k', '<q3@corp>', 'INBOX', 'boss@corp.com', 1);
    // Moved within the inbox by another client (a new UID): the record's sender's, so it is the record's.
    fake.server.mail.get('INBOX')![0]!.uid = 7;
    expect(await call(state, '/api/action', { method: 'POST', body: { key: 'k', action: 'archive' } })).toMatchObject({ ok: true, row: { folder: 'Archive' } });
    expect(where()).toEqual(['Archive#1#boss@corp.com']);
    expect(state.getMail('k')?.handledAt).not.toBeNull();
  });

  it('matches a stored message without a Message-ID by its place, in the listing, by its handle and by its key', async () => {
    const state = store();
    put('INBOX', 'scan from the copier', { id: null, from: 'copier@office.example' });
    const landed = fake.server.mail.get('INBOX')![0]!;
    const made = fallbackMessageId(ME.username, { date: landed.date.toISOString(), subject: landed.subject, from: landed.from, uid: 1 });
    stored(state, 'k', made, 'INBOX', 'copier@office.example', 1);
    const [item] = await folder(state, 'INBOX');
    expect(item).toMatchObject({ key: 'k', messageId: '' });
    // Read and acted on by its handle: the record's books are kept.
    expect(await call(state, `/api/message?id=${encodeURIComponent(String(item!['handle']))}&live=true`)).toMatchObject({ stored: true, dedupKey: 'k' });
    expect(await call(state, '/api/action', { method: 'POST', body: { key: item!['handle'], action: 'star' } })).toMatchObject({ ok: true, row: { dedupKey: 'k' } });
    // And by its key, at its own place.
    expect(await call(state, '/api/action', { method: 'POST', body: { key: 'k', action: 'archive' } })).toMatchObject({ ok: true, row: { folder: 'Archive' } });
    expect(where()).toEqual(['Archive#1#copier@office.example']);
    expect(state.getMail('k')?.handledAt).not.toBeNull();
  });

  it('opens, bins and puts in spam a message whose Message-ID is far too long, by the handle it was listed with', async () => {
    const state = store();
    const long = '<' + 'x'.repeat(1100) + '@spam.example>';
    put('INBOX', 'buy now', { id: long, from: 'spam@spam.example' });
    put('INBOX', 'buy later', { id: '<' + 'y'.repeat(1100) + '@spam.example>', from: 'spam@spam.example' });
    const items = await folder(state, 'INBOX');
    expect(items.map((item) => item['messageId'])).toContain(long);
    const opened = await call(state, `/api/message?id=${encodeURIComponent(String(items[1]!['handle']))}&live=true`);
    expect(opened).toMatchObject({ stored: false, subject: 'buy now' });
    expect(await call(state, '/api/bulk', { method: 'POST', body: { items: [items[1]!['handle']], action: 'spam' } })).toMatchObject({ done: 1 });
    expect(await call(state, '/api/action', { method: 'POST', body: { key: items[0]!['handle'], action: 'trash' } })).toMatchObject({ ok: true });
    expect(where()).toEqual(['Deleted Messages#1#spam@spam.example', 'Junk#1#spam@spam.example']);
  });

  it('files a message mailsift never stored as the owner\'s before moving it, so a lost answer does not make it new mail', async () => {
    const state = store();
    put('Archive', 'old invoice', { id: '<lost-answer@vendor.example>' });
    put('Archive', 'older invoice', { id: '<lost-too@vendor.example>' });
    const items = await folder(state, 'Archive');
    // The server moves it, and the line drops before it says so.
    fake.server.loseMoveAnswer = true;
    const one = await call(state, '/api/action', { method: 'POST', body: { key: items[0]!['handle'], action: 'inbox' } });
    expect(one['ok']).toBeUndefined();
    const batch = await call(state, '/api/bulk', { method: 'POST', body: { items: [items[1]!['handle']], action: 'spam' } });
    expect(batch).toMatchObject({ done: 0 });
    expect(where()).toEqual(['INBOX#1#sender@example.com', 'Junk#1#sender@example.com']);
    const poller = new Watcher({ accounts: [], rules: { alwaysImportant: [], neverImportant: [], keywords: [], context: '' } }, state, new RecordingSink());
    const arriving = [
      makeMessage({ account: ME.username, messageId: '<lost-answer@vendor.example>', folder: 'INBOX' }),
      makeMessage({ account: ME.username, messageId: '<lost-too@vendor.example>', folder: 'Junk', inSpam: true }),
    ];
    expect(poller.filterFresh(arriving)).toEqual([]);
  });

  it('says a search that was slow is slow, not that the provider is down', async () => {
    const state = store();
    put('INBOX', 'invoice');
    setSearchTimeout(60);
    fake.server.delay.search = 400;
    try {
      const path = `/api/search?account=${encodeURIComponent(ME.username)}&q=invoice&folder=INBOX`;
      const answer = await routeWeb(request(path), new URL(path, 'http://127.0.0.1:8410'), 'read-token', state, 'probe', { writeToken: 'write-token' });
      expect(answer.status).toBe(504);
      expect(JSON.parse(String(answer.body))).toMatchObject({ code: 'searchTimeout' });
    } finally {
      setSearchTimeout(null);
    }
  });

  it('remembers where a listing found a record that had no place, so its handle is the record\'s after a restart too', async () => {
    const state = store();
    put('INBOX', 'Q3 numbers', { id: '<q3@corp>', from: 'boss@corp.com' });
    stored(state, 'k', '<q3@corp>', 'INBOX', 'boss@corp.com');
    const [item] = await folder(state, 'INBOX');
    expect(item).toMatchObject({ key: 'k' });
    // Kept in the database, not in this process's memory.
    expect(state.placeOf('k')).toEqual({ uid: 1, uidValidity: '1' });
    expect(await call(state, '/api/bulk', { method: 'POST', body: { items: [item!['handle']], action: 'spam' } })).toMatchObject({ done: 1 });
    expect(state.getMail('k')).toMatchObject({ folder: 'Junk', inSpam: true });
    expect(state.feedbackSummary()).toMatchObject({ spam: 1 });
  });

  it('matches a record with no remembered place by its folder and its sender as listed, and keeps its books only then', async () => {
    const state = store();
    put('INBOX', 'Q3 numbers', { id: '<q3@corp>', from: 'boss@corp.com' });
    put('INBOX', 'Q3 numbers', { id: '<q3@corp>', from: 'attacker@evil.example' });
    stored(state, 'k', '<q3@corp>', 'INBOX', 'boss@corp.com');
    const items = await folder(state, 'INBOX');
    expect(items.map((item) => [item['uid'], item['key'] ?? null])).toEqual([[2, null], [1, 'k']]);
    expect(await call(state, '/api/action', { method: 'POST', body: { key: items[0]!['handle'], action: 'trash' } })).toMatchObject({ ok: true });
    expect(state.getMail('k')?.handledAt).toBeNull();
    // The real one, as listed: the record follows it and it is dealt with.
    expect(await call(state, '/api/action', { method: 'POST', body: { key: items[1]!['handle'], action: 'archive' } })).toMatchObject({ ok: true, row: { dedupKey: 'k', folder: 'Archive' } });
    expect(state.getMail('k')?.handledAt).not.toBeNull();
  });

  it('never takes a Message-ID a sender wrote as a handle, however it is spelled', async () => {
    const state = store();
    put('INBOX', 'contract', { id: '<contract@x>' });
    // A handle as an older server spelled it, and one with a made-up signature: both are text a sender can write.
    const parts = Buffer.from(JSON.stringify([1, ME.username, 'INBOX', '1', 1, '<contract@x>'])).toString('base64url');
    const signedParts = Buffer.from(JSON.stringify([2, ME.username, 'INBOX', '1', 1, '<contract@x>'])).toString('base64url');
    for (const forged of [`live:${parts}`, `live:${signedParts}.${'A'.repeat(22)}`]) {
      put('Work', 'newsletter', { id: forged });
      fake.server.folders.push({ path: 'Work' });
      const [item] = await folder(state, 'Work');
      expect(item!['messageId']).toBe(forged);
      const answer = await call(state, '/api/bulk', { method: 'POST', body: { items: [item!['messageId']], action: 'trash' } });
      expect(answer['results']).toEqual([expect.objectContaining({ status: 'failed', code: 'badHandle' })]);
      expect(fake.server.mail.get('INBOX')).toHaveLength(1);
      fake.server.mail.delete('Work');
    }
  });

  it('files a message mailsift never stored where the owner moves it, so the poll does not take it for new mail', async () => {
    const state = store();
    put('Archive', 'old invoice', { id: '<old-invoice@vendor.example>' });
    const [item] = await folder(state, 'Archive');
    expect(await call(state, '/api/bulk', { method: 'POST', body: { items: [item!['handle']], action: 'spam' } })).toMatchObject({ done: 1 });
    expect(fake.server.mail.get('Junk')?.map((m) => m.messageId)).toEqual(['<old-invoice@vendor.example>']);
    expect(state.filedByOwner(`${ME.username}|<old-invoice@vendor.example>`)).toBe(true);
    const poller = new Watcher({ accounts: [], rules: { alwaysImportant: [], neverImportant: [], keywords: [], context: '' } }, state, new RecordingSink());
    const arriving = makeMessage({ account: ME.username, messageId: '<old-invoice@vendor.example>', folder: 'Junk', inSpam: true });
    expect(poller.filterFresh([arriving])).toEqual([]);
    // A message without a Message-ID is filed under the id the poller makes up for it where it landed.
    put('Archive', 'no id', { id: null });
    const [plain] = await folder(state, 'Archive');
    expect(await call(state, '/api/action', { method: 'POST', body: { key: plain!['handle'], action: 'not_spam' } })).toMatchObject({ code: 'action_not_applicable' });
    expect(await call(state, '/api/action', { method: 'POST', body: { key: plain!['handle'], action: 'inbox' } })).toMatchObject({ ok: true });
    const landed = fake.server.mail.get('INBOX')!.find((m) => m.subject === 'no id')!;
    const made = fallbackMessageId(ME.username, { date: landed.date.toISOString(), subject: 'no id', from: landed.from, uid: landed.uid });
    expect(state.filedByOwner(`${ME.username}|${made}`)).toBe(true);
  });
});

describe('searches, on connections of their own', () => {
  const search = (query: string, signal?: AbortSignal) => searchMailbox(ME, { query, folder: 'INBOX', ...(signal ? { signal } : {}) });

  it('opens at most two connections to a mailbox for searches, however many are asked for at once', async () => {
    put('INBOX', 'invoice');
    fake.server.delay.search = 40;
    const answers = await Promise.all(Array.from({ length: 6 }, () => search('invoice')));
    expect(answers.every((answer) => answer.total === 1)).toBe(true);
    expect(fake.server.maxOpen).toBeLessThanOrEqual(2);
    expect(fake.server.connects).toBeLessThanOrEqual(2);
  });

  it('keeps a search\'s connection a moment, so the next page does not sign in again', async () => {
    put('INBOX', 'invoice');
    await search('invoice');
    await search('invoice');
    expect(fake.server.connects).toBe(1);
  });

  it('signs in in turn with the mailbox\'s other sign-ins', async () => {
    put('INBOX', 'invoice');
    setSignInGap(120);
    try {
      fake.server.delay.search = 30;
      await Promise.all([search('invoice'), search('invoice')]);
      const [first, second] = fake.server.connectStarts;
      expect(second! - first!).toBeGreaterThanOrEqual(100);
    } finally {
      setSignInGap(0);
    }
  });

  it('stops signing in at once when the search is given up on, and gives its place back', async () => {
    put('INBOX', 'invoice');
    fake.server.delay.connect = 400;
    const stop = new AbortController();
    const started = Date.now();
    const given = search('invoice', stop.signal).then(() => 'finished', (error: unknown) => (error instanceof SearchCancelled ? 'cancelled' : String(error)));
    await new Promise((resolve) => setTimeout(resolve, 30));
    stop.abort();
    expect(await given).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(200);
    expect(fake.server.connects).toBe(0);
    expect(ownConnections(ME.username)).toBe(0);
  });

  it('lets a search waiting for a connection be given up on, and the others go on', async () => {
    put('INBOX', 'invoice');
    fake.server.delay.search = 150;
    const busy = [search('invoice'), search('invoice')];
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stop = new AbortController();
    const waiting = search('invoice', stop.signal).then(() => 'finished', (error: unknown) => (error instanceof SearchCancelled ? 'cancelled' : String(error)));
    stop.abort();
    expect(await waiting).toBe('cancelled');
    expect((await Promise.all(busy)).map((answer) => answer.total)).toEqual([1, 1]);
    expect(fake.server.connects).toBe(2);
  });
});

describe('the mailbox connection, shared fairly', () => {
  const exactOf = (folder: string, uid: number, id: string) => ({ messageId: id, hint: { folder, uid, uidValidity: '1', exact: true } });

  it('lets reading in between a long batch, which gives the connection up every few messages', async () => {
    const targets = Array.from({ length: 24 }, (_, n) => { put('INBOX', `m${n}`); return exactOf('INBOX', n + 1, `<inbox-${n + 1}@x>`); });
    fake.server.delay.fetchOne = 8;
    fake.server.delay.move = 8;
    const started = Date.now();
    let batchDone = 0, readDone = 0;
    const batch = applyMailActions(ME, targets, 'archive').then((outcomes) => { batchDone = Date.now() - started; return outcomes; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await mailboxFolders(ME).then(() => { readDone = Date.now() - started; });
    const outcomes = await batch;
    expect(outcomes.every((outcome) => 'done' in outcome)).toBe(true);
    expect(readDone).toBeLessThan(batchDone);
    // Each message's envelope is fetched once, not again before it is moved.
    expect(fake.server.calls.filter((call) => call.startsWith('fetchOne'))).toHaveLength(24);
  });

  it('runs a search on a connection of its own, and closes it when the search is given up on', async () => {
    put('INBOX', 'invoice');
    fake.server.delay.search = 400;
    const stop = new AbortController();
    const started = Date.now();
    const search = searchMailbox(ME, { query: 'invoice', folder: 'INBOX', signal: stop.signal }).then(
      () => 'finished', (error: unknown) => (error instanceof SearchCancelled ? `cancelled at ${Date.now() - started}` : `failed: ${String(error)}`),
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    // Reading the mailbox does not wait for the search.
    const read = await fetchReadableByMessageId(ME, '<inbox-1@x>', { folder: 'INBOX', uid: 1, uidValidity: '1' });
    expect(read?.readable.subject).toBe('invoice');
    expect(Date.now() - started).toBeLessThan(300);
    stop.abort();
    const said = await search;
    expect(said).toMatch(/^cancelled at \d+$/);
    expect(Number(said.split(' ').at(-1))).toBeLessThan(300);
    expect(fake.server.connects).toBe(2);
  });
});

describe('a search across folders, page after page', () => {
  it('gives every hit once, when an archive\'s UIDs and dates run in different orders', async () => {
    const day = (n: number): Date => new Date(Date.UTC(2026, 9, n));
    for (const n of [1, 3, 5, 7]) put('INBOX', `invoice inbox ${n}`, { date: day(n) });
    // Archived lately, written long ago: the higher the UID, the older.
    for (const n of [8, 6, 4, 2]) put('Archive', `invoice archive ${n}`, { date: day(n) });
    const seen: string[] = [];
    let before: string | null = null;
    for (let page = 0; page < 6; page += 1) {
      const answer = await searchMailbox(ME, { query: 'invoice', limit: 2, before });
      seen.push(...answer.items.map((item) => item.subject));
      before = answer.next;
      if (!before) break;
    }
    expect(seen.sort()).toEqual([
      'invoice archive 2', 'invoice archive 4', 'invoice archive 6', 'invoice archive 8',
      'invoice inbox 1', 'invoice inbox 3', 'invoice inbox 5', 'invoice inbox 7',
    ]);
  });
});

describe('folder counts, within their budget', () => {
  it('asks for the counts of the folders shown first, wherever the server lists them', async () => {
    fake.server.folders = [
      ...Array.from({ length: 70 }, (_, n) => ({ path: `Label ${String(n).padStart(2, '0')}` })),
      { path: 'INBOX' }, { path: 'Junk', specialUse: '\\Junk' },
    ];
    put('INBOX', 'one');
    const folders = await mailboxFolders(ME, { counts: true });
    expect(folders[0]).toMatchObject({ path: 'INBOX', messages: 1, unseen: 1 });
    expect(folders[1]).toMatchObject({ path: 'Junk', messages: 0 });
  });
});
