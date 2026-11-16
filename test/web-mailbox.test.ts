import { beforeEach, describe, expect, it } from 'vitest';
import './setup.js';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { LiveMailError, type LiveMessage, type MessageHint } from '../src/imap/client.js';
import { liveHandle, SearchCancelled, type LiveItem, type LivePage, type SearchPage } from '../src/imap/mailbox.js';
import type { ReadableMessage } from '../src/imap/readable.js';
import { StateStore } from '../src/services/state.js';
import { forgetLive, forgetSends, type WebBackend } from '../src/web-actions.js';
import { routeWeb, SESSION_COOKIE, type WebResponse } from '../src/web.js';

/**
 * The page's routes for the rest of the mailbox: folders, a folder's
 * messages, a search, and everything a message listed there can be read and
 * acted on with. The mailbox is stood in for here; test/mailbox.test.ts runs
 * the IMAP side against a fake server.
 */
const READ = 'read-token';
const WRITE = 'write-token';

function request(options: { method?: string; url?: string; body?: unknown; as?: 'read' | 'write' } = {}): IncomingMessage {
  const payload = options.body === undefined ? '' : JSON.stringify(options.body);
  const stream = Readable.from(payload ? [Buffer.from(payload)] : []);
  return Object.assign(stream, {
    method: options.method ?? 'GET', url: options.url ?? '/',
    headers: { cookie: `${SESSION_COOKIE}=${options.as === 'read' ? READ : WRITE}` },
  }) as unknown as IncomingMessage;
}

function seeded(): StateStore {
  const state = new StateStore(':memory:');
  state.markSeen('k1', 'me@qq.com', 'subject k1');
  state.recordOutcome('k1', 'critical', true, {
    messageId: '<one@x>', category: 'Finance', sender: 'billing@vendor.com', senderName: 'Vendor', summary: 'summary of k1', folder: 'INBOX',
  });
  return state;
}

function readable(partial: Partial<ReadableMessage> = {}): ReadableMessage {
  return {
    html: null, htmlOmitted: false, text: 'Hello', quoted: '', truncated: false,
    from: { name: 'Ann', address: 'ann@example.com' }, to: [{ name: '', address: 'me@qq.com' }], cc: [], replyTo: [],
    subject: 'Old news', date: '2025-01-02T03:04:05.000Z', messageId: '<old@x>', inReplyTo: null, references: [],
    auth: { result: 'none', dkim: null, spf: null, dmarc: null, signedBy: null }, unsubscribe: null, inlineImages: 0, ...partial,
  };
}

const OLD = liveHandle({ account: 'me@qq.com', folder: 'Archive', uidValidity: '5', uid: 9, messageId: '<old@x>' });
const ONE = liveHandle({ account: 'me@qq.com', folder: 'Archive', uidValidity: '5', uid: 3, messageId: '<one@x>' });

function item(uid: number, messageId: string, subject: string): LiveItem {
  return {
    handle: liveHandle({ account: 'me@qq.com', folder: 'Archive', uidValidity: '5', uid, messageId }), account: 'me@qq.com', folder: 'Archive',
    uid, uidValidity: '5', messageId, storedId: messageId, subject, from: { name: 'Ann', address: 'ann@example.com' }, to: [],
    date: '2025-01-02T03:04:05.000Z', size: 1200, flags: { seen: false, flagged: false, answered: false }, attachments: false,
  };
}

interface Calls { read: Array<{ messageId: string; hint: unknown }>; act: Array<{ messageId: string; action: string; hint: unknown }>; searched: unknown[] }

function fake(overrides: Partial<WebBackend> = {}): { calls: Calls; backend: Partial<WebBackend> } {
  const calls: Calls = { read: [], act: [], searched: [] };
  return {
    calls,
    backend: {
      read: async (_account, messageId, hint) => {
        calls.read.push({ messageId, hint });
        return { readable: readable({ messageId }), folder: 'Archive', flags: { seen: false, flagged: false, answered: false }, uid: 9, uidValidity: '5' } as LiveMessage;
      },
      act: async (account, messageId, action, options) => {
        calls.act.push({ messageId, action, hint: options?.hint });
        const moved = action === 'archive' ? 'Archive2' : action === 'trash' ? 'Trash' : action === 'move' ? options?.destination : undefined;
        return {
          action, account: account.username, messageId, sourceFolder: 'Archive',
          ...(moved ? { destinationFolder: moved, destinationIsSpam: false, destinationUid: 77, destinationUidValidity: '6' } : {}),
          ...(action === 'trash' ? { destinationIsTrash: true } : {}),
        };
      },
      send: async (_account, mail) => ({ messageId: '<sent@x>', raw: Buffer.from('raw'), copy: Buffer.from('raw'), accepted: mail.to, rejected: [] }),
      attachments: async () => ({ folder: 'Archive', manifest: { items: [], truncated: false } }),
      appendSent: async () => 'Sent',
      savesSentCopy: () => true,
      sending: () => ({ available: true }),
      folders: async () => [{
        path: 'INBOX', name: 'INBOX', parent: null, depth: 0, delimiter: '/', flags: [], specialUse: null, specialUseSource: null,
        role: 'inbox', selectable: true, subscribed: true, messages: 3, unseen: 1,
      }],
      browse: async (_account, folder): Promise<LivePage> => ({
        account: 'me@qq.com', folder, uidValidity: '5', total: 2, items: [item(9, '<old@x>', 'Old news'), item(3, '<one@x>', 'subject k1')], next: '5.3',
      }),
      search: async (_account, options): Promise<SearchPage> => {
        calls.searched.push(options.query);
        return { account: 'me@qq.com', query: options.query, folders: ['INBOX'], items: [item(9, '<old@x>', 'Old news')], total: 1, next: null, limited: { reason: 'provider', scanned: 2000 } };
      },
      ...overrides,
    },
  };
}

const url = (path: string): URL => new URL(path, 'http://127.0.0.1:8410');
let seq = 0;
async function call(
  store: StateStore, path: string, options: Parameters<typeof request>[0] = {}, mailbox = fake(),
): Promise<{ answer: WebResponse; json: Record<string, unknown> }> {
  seq += 1;
  const late = (): StateStore => Object.create(store, { close: { value: () => undefined } }) as StateStore;
  const answer = await routeWeb(request({ ...options, url: path }), url(path), READ, store, `client-${seq}`,
    { writeToken: WRITE, backend: { openStore: late, ...mailbox.backend } });
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(String(answer.body)) as Record<string, unknown>; } catch { /* not JSON */ }
  return { answer, json };
}
const post = (store: StateStore, path: string, body: unknown, mailbox = fake(), as: 'read' | 'write' = 'write') =>
  call(store, path, { method: 'POST', body, as }, mailbox);

beforeEach(() => {
  forgetLive();
  forgetSends();
  process.env.MAIL_ACCOUNT_1 = 'qq|me@qq.com|pw';
  process.env.MAIL_ACCOUNT_1_NAME = 'personal';
});

describe('listing the rest of the mailbox', () => {
  it('lists a mailbox\'s folders to any session, and refuses one that is not configured', async () => {
    const store = seeded();
    const listed = await call(store, '/api/folders?account=me%40qq.com', { as: 'read' });
    expect(listed.answer.status).toBe(200);
    expect(listed.json).toMatchObject({ account: 'me@qq.com', name: 'personal', folders: [{ path: 'INBOX', role: 'inbox', unseen: 1 }] });
    expect(listed.answer.cacheControl).toBe('no-store');
    expect((await call(store, '/api/folders?account=other%40x.com')).json).toMatchObject({ code: 'unconfigured' });
  });

  it('lists a folder with each message\'s handle, and what was stored about the ones mailsift keeps', async () => {
    const store = seeded();
    const { json } = await call(store, '/api/folder?account=me%40qq.com&folder=Archive', { as: 'read' });
    const items = json['items'] as Array<Record<string, unknown>>;
    expect(json).toMatchObject({ folder: 'Archive', total: 2, next: '5.3' });
    expect(items[0]).toMatchObject({ handle: OLD, subject: 'Old news', flags: { seen: false } });
    expect(items[0]).not.toHaveProperty('key');
    // The stored one: its key, how it was judged, whether it was dealt with.
    expect(items[1]).toMatchObject({ handle: ONE, key: 'k1', stored: { importance: 'critical', summary: 'summary of k1', handledAt: null } });
    // Nothing listed live is stored.
    expect(store.getMail('<old@x>')).toBeUndefined();
    expect((await call(store, '/api/folder?account=me%40qq.com')).json).toMatchObject({ code: 'badRequest' });
  });

  it('says a folder that is gone, or that changed under the pages already shown, in words of its own', async () => {
    const store = seeded();
    const gone = fake({ browse: async () => { throw new LiveMailError('folder', 'no such folder'); } });
    expect((await call(store, '/api/folder?account=me%40qq.com&folder=Gone', {}, gone)).json).toMatchObject({ code: 'noFolder' });
    const rebuilt = fake({ browse: async () => { throw new LiveMailError('cursor', 'rebuilt'); } });
    const answer = await call(store, '/api/folder?account=me%40qq.com&folder=Archive&before=4.9', {}, rebuilt);
    expect(answer.answer.status).toBe(409);
    expect(answer.json).toMatchObject({ code: 'liveCursor' });
  });

  it('searches the mailbox, and passes on that a search was limited to recent subjects and senders', async () => {
    const store = seeded();
    const mailbox = fake();
    const { json } = await call(store, '/api/search?account=me%40qq.com&q=old', { as: 'read' }, mailbox);
    expect(json).toMatchObject({ query: 'old', total: 1, limited: { reason: 'provider', scanned: 2000 }, items: [{ handle: OLD }] });
    expect(mailbox.calls.searched).toEqual(['old']);
    expect((await call(store, '/api/search?account=me%40qq.com&q=%20')).json).toMatchObject({ code: 'badRequest' });
    // Which mailbox was searched is on record, never what for.
    expect(store.listMcpAudit(5).find((row) => row.action === 'web:search')?.target).toBe('me@qq.com|');
  });

  it('lets a newer search from the page take the place of one still running', async () => {
    const store = seeded();
    let firstStopped = false;
    let release!: () => void;
    const slow = fake({
      search: (_account, options) => new Promise<SearchPage>((resolve, reject) => {
        options.signal?.addEventListener('abort', () => { firstStopped = true; reject(new SearchCancelled()); });
        release = () => resolve({ account: 'me@qq.com', query: options.query, folders: [], items: [], total: 0, next: null });
      }),
    });
    const client = 'one-page';
    const ask = (q: string) => routeWeb(request({ url: `/api/search?account=me%40qq.com&q=${q}` }), url(`/api/search?account=me%40qq.com&q=${q}`), READ, store, client, { writeToken: WRITE, backend: slow.backend });
    const first = ask('a');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = ask('ab');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(firstStopped).toBe(true);
    release();
    expect((await second).status).toBe(200);
    const stopped = await first;
    expect(stopped.status).toBe(409);
    expect(JSON.parse(String(stopped.body))).toMatchObject({ code: 'superseded' });
  });
});

describe('a message named by its handle', () => {
  it('is read exactly where the folder listed it, and described by what the mailbox says when nothing was stored', async () => {
    const store = seeded();
    const mailbox = fake();
    const { answer, json } = await call(store, `/api/message?id=${encodeURIComponent(OLD)}`, { as: 'read' }, mailbox);
    expect(answer.status).toBe(200);
    expect(json).toMatchObject({ handle: OLD, stored: false, subject: 'Old news', sender: 'ann@example.com', text: 'Hello', liveFolder: 'Archive' });
    expect(mailbox.calls.read).toEqual([{ messageId: '<old@x>', hint: { folder: 'Archive', uid: 9, uidValidity: '5', exact: true } }]);
  });

  it('is the stored record when the mailbox has one with its Message-ID', async () => {
    const store = seeded();
    const { json } = await call(store, `/api/message?id=${encodeURIComponent(ONE)}&live=true`);
    expect(json).toMatchObject({ dedupKey: 'k1', importance: 'critical', handle: ONE, stored: true });
  });

  it('is refused when forged, when it is also a stored message\'s Message-ID, and for a mailbox not configured', async () => {
    const store = seeded();
    expect((await call(store, '/api/message?id=live%3Anonsense')).json).toMatchObject({ code: 'badHandle' });
    // A sender can write a Message-ID that spells a handle: neither is guessed.
    store.markSeen('k9', 'me@qq.com', 'look-alike');
    store.recordOutcome('k9', 'info', false, { messageId: OLD, folder: 'INBOX' });
    expect((await call(store, `/api/message?id=${encodeURIComponent(OLD)}`)).json).toMatchObject({ code: 'ambiguousHandle' });
    const elsewhere = liveHandle({ account: 'other@x.com', folder: 'INBOX', uidValidity: '1', uid: 1, messageId: '<a@x>' });
    expect((await call(store, `/api/message?id=${encodeURIComponent(elsewhere)}`)).json).toMatchObject({ code: 'unconfigured' });
  });

  it('is refused once the message is no longer where the folder listed it', async () => {
    const store = seeded();
    const moved = fake({
      read: async () => { throw new LiveMailError('moved', 'gone'); },
      act: async () => { throw new LiveMailError('stale', 'rebuilt'); },
    });
    const read = await call(store, `/api/message?id=${encodeURIComponent(OLD)}`, {}, moved);
    expect(read.answer.status).toBe(409);
    expect(read.json).toMatchObject({ code: 'liveStale', reason: 'moved' });
    const acted = await post(store, '/api/action', { key: OLD, action: 'star' }, moved);
    expect(acted.json).toMatchObject({ code: 'liveStale', reason: 'stale' });
    // Refused, and on record as refused.
    expect(store.listMailActions(1)[0]).toMatchObject({ action: 'star', success: false, messageId: '<old@x>' });
  });

  it('is acted on where it is, and the answer says where it went', async () => {
    const store = seeded();
    const mailbox = fake();
    const { json } = await post(store, '/api/action', { key: OLD, action: 'move', destination: 'Projects' }, mailbox);
    expect(json).toMatchObject({ ok: true, action: 'move', moved: { folder: 'Projects' } });
    expect(json).not.toHaveProperty('row');
    const after = (json['moved'] as { handle: string }).handle;
    expect(after).toBe(liveHandle({ account: 'me@qq.com', folder: 'Projects', uidValidity: '6', uid: 77, messageId: '<old@x>' }));
    expect(mailbox.calls.act[0]).toEqual({ messageId: '<old@x>', action: 'move', hint: { folder: 'Archive', uid: 9, uidValidity: '5', exact: true } });
    expect(store.listMailActions(1)[0]).toMatchObject({ action: 'move', success: true, sourceFolder: 'Archive', destinationFolder: 'Projects' });
  });

  it('keeps the books of the stored record it names: binned is dealt with, and the record follows the message', async () => {
    const store = seeded();
    const { json } = await post(store, '/api/action', { key: ONE, action: 'trash' });
    expect(json).toMatchObject({ ok: true, row: { dedupKey: 'k1', folder: 'Trash' } });
    expect(store.getMail('k1')?.handledAt).not.toBeNull();
    expect(store.placeOf('k1')).toEqual({ uid: 77, uidValidity: '6' });
  });

  it('has a place in the queue only when mailsift stored it', async () => {
    const store = seeded();
    const refused = await post(store, '/api/handled', { key: OLD, handled: true });
    expect(refused.answer.status).toBe(409);
    expect(refused.json).toMatchObject({ code: 'notStored' });
    expect((await post(store, '/api/snooze', { key: OLD, until: 'now' })).json).toMatchObject({ code: 'notStored' });
    expect((await post(store, '/api/feedback', { key: OLD, label: 'correct' })).json).toMatchObject({ code: 'notStored' });
    const marked = await post(store, '/api/handled', { key: ONE, handled: true });
    expect(marked.json).toMatchObject({ key: 'k1', handled: true });
  });

  it('is answered as any message is, threaded and flagged answered where it is, and leaves the queue alone when nothing was stored', async () => {
    const store = seeded();
    const mailbox = fake();
    const draft = await call(store, `/api/reply?key=${encodeURIComponent(OLD)}`, {}, mailbox);
    expect(draft.json).toMatchObject({ key: OLD, to: ['ann@example.com'], subject: 'Re: Old news' });
    const sent = await post(store, '/api/send', { replyTo: OLD, to: ['ann@example.com'], subject: 'Re: Old news', text: 'Thanks' }, mailbox);
    expect(sent.json).toMatchObject({ sent: true });
    expect(sent.json).not.toHaveProperty('handled');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mailbox.calls.act).toEqual([{ messageId: '<old@x>', action: 'answered', hint: { folder: 'Archive', uid: 9, uidValidity: '5', exact: true } }]);
    // Answering the stored one from its folder deals with it in the queue.
    const stored = await post(store, '/api/send', { replyTo: ONE, to: ['ann@example.com'], subject: 'Re', text: 'Thanks' }, mailbox);
    expect(stored.json).toMatchObject({ sent: true, handled: true });
    expect(store.getMail('k1')?.handledAt).not.toBeNull();
  });

  it('is forwarded with its files, read where it is', async () => {
    const store = seeded();
    const fetched: Array<{ messageId: string; hint: MessageHint | string | undefined }> = [];
    const mailbox = fake({
      attachments: async (_account, messageId, hint) => {
        fetched.push({ messageId, hint });
        return { folder: 'Archive', manifest: { items: [{ partId: '2', filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 10, inline: false }], truncated: false } };
      },
      attachment: async (_account, _messageId, partId) => ({ metadata: { partId, filename: 'a.pdf', contentType: 'application/pdf', inline: false }, content: Buffer.from('pdf') }),
    });
    const draft = await call(store, `/api/forward?key=${encodeURIComponent(OLD)}`, {}, mailbox);
    expect(draft.json).toMatchObject({ key: OLD, subject: 'Fwd: Old news', attachments: [{ partId: '2', filename: 'a.pdf' }] });
    expect(fetched[0]).toEqual({ messageId: '<old@x>', hint: { folder: 'Archive', uid: 9, uidValidity: '5', exact: true } });
    const sent = await post(store, '/api/send', { forwardOf: OLD, forwardAttachments: ['2'], to: ['bob@example.com'], subject: 'Fwd', text: '' }, mailbox);
    expect(sent.json).toMatchObject({ sent: true });
  });

  it('has its attachments listed where it is, and no conversation when nothing was stored', async () => {
    const store = seeded();
    const listed = await call(store, `/api/attachments?id=${encodeURIComponent(OLD)}`);
    expect(listed.json).toMatchObject({ folder: 'Archive', attachments: [] });
    const conversation = await call(store, `/api/conversation?key=${encodeURIComponent(OLD)}`);
    expect(conversation.json).toMatchObject({ count: 0, messages: [] });
  });
});
