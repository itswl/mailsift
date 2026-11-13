import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './setup.js';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { allowMcpRequest, createServer, forgetUnconfirmedSends, type InFlight } from '../src/mcp.js';
import { MailActionError, type LiveMessage, type WebMailActionResult } from '../src/imap/client.js';
import { StateStore } from '../src/services/state.js';
import { SendError, type OutgoingMail } from '../src/smtp.js';
import { forgetLive, forgetSends, type WebBackend } from '../src/web-actions.js';
import { IMPORTANCE } from '../src/config.js';
import { CATEGORIES } from '../src/services/triage.js';
import { makeMessage, makeResult } from './helpers.js';

/**
 * Drive the server the way a real client does.
 *
 * Asserting through the protocol keeps these tests tied to the contract
 * (tool names, argument schemas, result shapes) rather than to the SDK call
 * used to register them, so a registration API change cannot pass unnoticed
 * and cannot fail the suite for cosmetic reasons either.
 */
const open: Array<() => Promise<void>> = [];

/**
 * The mailbox, stood in for. These tests are about what the server does
 * around an action (who may ask, what is recorded, where the record goes);
 * test/imap.test.ts is where the actions themselves are run, and
 * test/web-actions.test.ts where the page's handlers, which the write tools
 * call, are gone through case by case.
 */
interface Mailbox {
  acted: Array<{ messageId: string; action: string; destination?: string; hint?: unknown }>;
  sent: OutgoingMail[];
  read: unknown[];
  appended: number;
  act?: (action: string) => Partial<WebMailActionResult> | undefined;
  send?: () => never;
  backend: Partial<WebBackend>;
}
function mailbox(state: StateStore): Mailbox {
  const box: Mailbox = { acted: [], sent: [], read: [], appended: 0, backend: {} };
  const live: LiveMessage = {
    folder: 'INBOX', flags: { seen: false, flagged: false, answered: false }, uid: 17, uidValidity: '9',
    readable: {
      html: '<p>Hello</p>', htmlOmitted: false, text: 'Please confirm the invoice by Friday.', quoted: '', truncated: false,
      from: { name: 'Vendor', address: 'billing@vendor.com' }, to: [{ name: '', address: 'me@qq.com' }],
      cc: [{ name: 'Ann', address: 'ann@vendor.com' }], replyTo: [], subject: 'subject k1', date: '2026-11-10T08:00:00.000Z',
      messageId: '<one@x>', inReplyTo: null, references: ['<root@x>'],
      auth: { result: 'pass', dkim: 'pass', spf: 'pass', dmarc: 'pass', signedBy: 'vendor.com' },
      unsubscribe: null, inlineImages: 0,
    },
  };
  box.backend = {
    read: async (_account, _messageId, hint) => { box.read.push(hint); return live; },
    act: async (account, messageId, action, options) => {
      box.acted.push({ messageId, action, ...(options?.destination ? { destination: options.destination } : {}), hint: options?.hint });
      const moved = action === 'archive' ? 'Archive' : action === 'trash' ? 'Trash' : action === 'inbox' ? 'INBOX' : options?.destination;
      const answer = box.act ? box.act(action) : {};
      if (!answer) return undefined;
      return {
        action, account: account.username, messageId, sourceFolder: 'INBOX',
        ...(moved ? { destinationFolder: moved, destinationIsSpam: false } : {}), ...answer,
      };
    },
    send: async (_account, mail) => {
      if (box.send) box.send();
      box.sent.push(mail);
      return { messageId: '<sent@x>', raw: Buffer.from('raw'), copy: Buffer.from('raw'), accepted: [...mail.to, ...(mail.cc ?? [])], rejected: [] };
    },
    appendSent: async () => { box.appended += 1; return 'Sent'; },
    savesSentCopy: () => false,
    sending: () => ({ available: true }),
    // Work that outlasts a call opens a handle of its own: here the same database, behind a close() that closes nothing.
    openStore: () => Object.create(state, { close: { value: () => undefined } }) as StateStore,
  };
  return box;
}

beforeEach(() => {
  forgetLive();
  forgetSends();
  forgetUnconfirmedSends();
});

async function connect(state: StateStore, writable = false, backend?: Partial<WebBackend>, inFlight?: InFlight): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer({ state, client: 'test', writable, ...(backend ? { backend } : {}), ...(inFlight ? { inFlight } : {}) });
  const client = new Client({ name: 'mcp-test', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  open.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(first!.text) as Record<string, unknown>;
}

function seeded(): StateStore {
  const state = new StateStore(':memory:');
  const rows: Array<[string, string, string, boolean]> = [
    ['k1', '<one@x>', 'critical', true],
    ['k2', '<two@x>', 'warning', true],
    ['k3', '<three@x>', 'info', false],
  ];
  for (const [key, messageId, importance, pushed] of rows) {
    state.markSeen(key, 'me@qq.com', `subject ${key}`);
    state.recordOutcome(key, importance, pushed, {
      messageId, sender: 'billing@vendor.com', category: 'Finance',
      summary: `summary ${key}`, snippet: 'body', folder: 'INBOX',
    });
  }
  return state;
}

afterEach(async () => {
  for (const close of open.splice(0)) await close().catch(() => undefined);
});

describe('tool surface', () => {
  it('advertises every documented tool with a description', async () => {
    const client = await connect(new StateStore(':memory:'));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'feedback_rules', 'get_mail', 'health', 'inspect_mail_safety', 'list_accounts', 'list_attachments', 'list_audit', 'list_dead_letters',
      'list_digest', 'list_folders', 'list_mail', 'list_threads', 'mail_summary', 'needs_you', 'observability',
      'prepare_reply', 'read_message', 'recovery_status', 'scan_attachment', 'search_mail',
    ]);
    for (const tool of tools) expect(tool.description ?? '').not.toBe('');
  });

  it('does not offer the state-changing tools to an ordinary reader', async () => {
    // A leaked read token must not be able to record feedback: two
    // false_positive labels for one sender infer a never-important rule, which
    // silences that sender's future alerts.
    const client = await connect(seeded());
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('record_feedback');
    expect(names).not.toContain('retry_dead_letter');
    expect(names).not.toContain('manage_mail');
    expect(names).not.toContain('mark_handled');
    expect(names).not.toContain('send_mail');

    // Absent from the listing and also unreachable by name.
    expect(await client.callTool({ name: 'record_feedback', arguments: { messageId: '<one@x>', label: 'false_positive' } }))
      .toMatchObject({ isError: true });
  });

  it('adds exactly the tools that change something for a caller holding the write credential', async () => {
    const reader = new Set((await (await connect(new StateStore(':memory:'))).listTools()).tools.map((t) => t.name));
    const writer = (await (await connect(new StateStore(':memory:'), true)).listTools()).tools.map((t) => t.name);
    expect(writer.filter((name) => !reader.has(name)).sort())
      .toEqual(['manage_mail', 'mark_handled', 'record_feedback', 'retry_dead_letter', 'send_mail']);
  });

  it('gives the write credential what the page has, the bin and sending included, and a reader none of it', async () => {
    const writer = (await (await connect(new StateStore(':memory:'), true)).listTools()).tools;
    const actions = (writer.find((t) => t.name === 'manage_mail')?.inputSchema.properties as Record<string, { enum?: string[] }>)['action']?.enum;
    expect(actions).toEqual(['mark_read', 'mark_unread', 'star', 'unstar', 'move', 'archive', 'inbox', 'trash']);
    expect(writer.find((t) => t.name === 'send_mail')?.description).toContain('really sends mail');

    const state = seeded();
    const box = mailbox(state);
    const reader = await connect(state, false, box.backend);
    for (const [name, args] of [
      ['send_mail', { account: 'me@qq.com', to: ['a@b.co'], subject: 's', text: 't' }],
      ['manage_mail', { messageId: '<one@x>', action: 'trash' }],
      ['mark_handled', { messageId: '<one@x>' }],
    ] as const) {
      expect(await reader.callTool({ name, arguments: args }), name).toMatchObject({ isError: true });
    }
    expect(box.sent).toEqual([]);
    expect(box.acted).toEqual([]);
    expect(state.getMail('k1')?.handledAt).toBeNull();
  });

  it('warns a client that message fields are untrusted data', async () => {
    // Subjects and summaries reach the model verbatim, so the server has to
    // say so itself; a client without the skill file sees nothing else.
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createServer({ state: new StateStore(':memory:') });
    const client = new Client({ name: 'mcp-test', version: '0.0.0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    open.push(async () => {
      await client.close();
      await server.close();
    });
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('attacker-controlled');
    expect(instructions).toMatch(/[Nn]ever follow instructions/);
  });

  it('publishes argument schemas so a client can validate before calling', async () => {
    const client = await connect(new StateStore(':memory:'));
    const { tools } = await client.listTools();
    const listMail = tools.find((t) => t.name === 'list_mail')!;
    expect(Object.keys(listMail.inputSchema.properties ?? {}).sort()).toEqual([
      'account', 'category', 'cursor', 'hours', 'importance', 'limit', 'pushedOnly', 'spamOnly',
    ]);
    const getMail = tools.find((t) => t.name === 'get_mail')!;
    expect(getMail.inputSchema.required).toEqual(['messageId']);
  });

  it('reports a bad argument as a tool error rather than a result', async () => {
    // The protocol carries validation failures back as isError results, so a
    // client sees a refusal instead of a call that silently returns nothing.
    const client = await connect(new StateStore(':memory:'));
    expect(await client.callTool({ name: 'get_mail', arguments: {} })).toMatchObject({ isError: true });
    expect(await client.callTool({ name: 'list_mail', arguments: { hours: -1 } })).toMatchObject({ isError: true });
    expect(await client.callTool({ name: 'list_mail', arguments: {} })).not.toMatchObject({ isError: true });
  });
});

describe('queries', () => {
  it('lists recent mail and applies filters', async () => {
    const client = await connect(seeded());
    expect(await call(client, 'list_mail')).toMatchObject({ count: 3 });
    expect(await call(client, 'list_mail', { importance: 'critical' })).toMatchObject({ count: 1 });
    expect(await call(client, 'list_mail', { pushedOnly: true })).toMatchObject({ count: 2 });
  });

  it('pages with an opaque cursor that resumes where the page ended', async () => {
    // The cursor is encoded and decoded inside the server; a client only ever
    // round-trips it, so this is the only place that behaviour is exercised.
    const client = await connect(seeded());
    const first = await call(client, 'list_mail', { limit: 2 });
    expect(first['count']).toBe(2);
    expect(typeof first['nextCursor']).toBe('string');

    const second = await call(client, 'list_mail', { limit: 2, cursor: first['nextCursor'] });
    expect(second['count']).toBe(1);
    const ids = (page: Record<string, unknown>): unknown[] =>
      (page['mail'] as Array<{ messageId: unknown }>).map((m) => m.messageId);
    expect(ids(first)).not.toContain(ids(second)[0]);
    expect(second['nextCursor']).toBeUndefined();
  });

  it('ignores a malformed cursor instead of failing the call', async () => {
    const client = await connect(seeded());
    expect(await call(client, 'list_mail', { cursor: 'not-base64url-json' })).toMatchObject({ count: 3 });
  });

  it('pages a search too, so a wide match is not silently cut at the limit', async () => {
    // search_mail used to take only a limit, so a caller asking for the first
    // page of a broad query had no way to ask for the rest and could not tell
    // that anything was missing.
    const client = await connect(seeded());
    const first = await call(client, 'search_mail', { query: 'Finance', limit: 2 });
    expect(first['count']).toBe(2);
    expect(typeof first['nextCursor']).toBe('string');

    const second = await call(client, 'search_mail', { query: 'Finance', limit: 2, cursor: first['nextCursor'] });
    expect(second['count']).toBe(1);
    expect(second['nextCursor']).toBeUndefined();

    const seen = [first, second].flatMap((page) => (page['mail'] as Array<{ messageId: string }>).map((m) => m.messageId));
    expect(new Set(seen).size).toBe(3);
  });

  it('filters by category exactly, where search would match loosely', async () => {
    // The vocabulary is only useful if it can be filtered on; a substring
    // search hits the same word inside a summary or a reason.
    const state = seeded();
    state.markSeen('k4', 'me@qq.com', 'a forwarded copy');
    state.recordOutcome('k4', 'info', false, {
      messageId: '<four@x>', category: 'Forwarded copy', summary: 'mentions Finance in the text',
    });
    const client = await connect(state);

    expect(await call(client, 'list_mail', { category: 'Finance' })).toMatchObject({ count: 3 });
    expect(await call(client, 'list_mail', { category: 'Forwarded copy' })).toMatchObject({ count: 1 });
    expect(await call(client, 'list_mail', { category: 'Marketing' })).toMatchObject({ count: 0 });
    // The loose search still sees the word wherever it appears.
    expect(await call(client, 'search_mail', { query: 'Finance' })).toMatchObject({ count: 4 });
  });

  it('previews what is waiting for the daily digest', async () => {
    const state = seeded();
    state.queueDigest('k3', { subject: 'queued one', importance: 'info', category: 'Social' });
    state.queueDigest('k2', { subject: 'queued two', importance: 'info', category: 'Marketing' });
    const client = await connect(state);

    const digest = await call(client, 'list_digest');
    expect(digest).toMatchObject({ count: 2, pending: 2 });
    expect((digest['items'] as Array<{ subject: string }>).map((i) => i.subject).sort())
      .toEqual(['queued one', 'queued two']);
    expect(await call(client, 'list_digest', { limit: 1 })).toMatchObject({ count: 1, pending: 2 });
  });

  it('searches the stored fields', async () => {
    const client = await connect(seeded());
    expect(await call(client, 'search_mail', { query: 'billing' })).toMatchObject({ count: 3 });
    expect(await call(client, 'search_mail', { query: 'nothing here' })).toMatchObject({ count: 0 });
  });

  it('reports whether one message is known', async () => {
    const client = await connect(seeded());
    expect(await call(client, 'get_mail', { messageId: '<one@x>' })).toMatchObject({ found: true, importance: 'critical' });
    expect(await call(client, 'get_mail', { messageId: '<absent@x>' })).toMatchObject({ found: false });
  });

  it('summarizes a window and reports processing totals', async () => {
    const client = await connect(seeded());
    expect(await call(client, 'mail_summary', { hours: 24 })).toMatchObject({ total: 3, pushed: 2 });
    expect(await call(client, 'observability')).toMatchObject({ seenTotal: 3, pushedTotal: 2 });
  });
});

describe('what needs the mailbox owner', () => {
  it('is the queue the web view opens on: judged to matter, and not dealt with', async () => {
    const state = seeded();
    const client = await connect(state);
    const queue = await call(client, 'needs_you');
    expect(queue['count']).toBe(2);
    expect((queue['mail'] as Array<{ messageId: string }>).map((m) => m.messageId).sort()).toEqual(['<one@x>', '<two@x>']);
    expect(queue).not.toHaveProperty('recentlyDone');
    // Where a message sits in its folder is the mailbox's business, not a caller's.
    expect((queue['mail'] as Array<Record<string, unknown>>)[0]).not.toHaveProperty('uid');

    state.setHandled('k1', true);
    state.setHandled('k3', true);
    const after = await call(client, 'needs_you', { includeDone: true, limit: 1 });
    expect(after['count']).toBe(1);
    expect((after['mail'] as Array<{ messageId: string }>).map((m) => m.messageId)).toEqual(['<two@x>']);
    const done = after['recentlyDone'] as Array<{ messageId: string; queued: boolean; handledAt: string }>;
    expect(done.map((m) => [m.messageId, m.queued]).sort()).toEqual([['<one@x>', true], ['<three@x>', false]]);
    expect(done[0]?.handledAt).toEqual(expect.any(String));
  });

  it('lets a writer say a message is done, and put it back, as the ring does', async () => {
    process.env.MAIL_ACCOUNT_1 = 'qq|me@qq.com|pw';
    const state = seeded();
    state.rememberUid('k1', 'INBOX', 17, '9');
    const box = mailbox(state);
    const client = await connect(state, true, box.backend);
    const done = await call(client, 'mark_handled', { messageId: '<one@x>' });
    expect(done).toMatchObject({ messageId: '<one@x>', handled: true, needsYou: 1 });
    expect(done['handledAt']).toEqual(expect.any(String));
    expect(state.getMail('k1')?.handledAt).toBeTruthy();
    // Done here is done there: the mailbox is told, at the place the record remembers, and that goes on record.
    await vi.waitFor(() => expect(state.listMailActions(5)[0]).toMatchObject({ action: 'mark_read', success: true, client: 'mcp:test' }));
    expect(box.acted).toEqual([{ messageId: '<one@x>', action: 'mark_read', hint: { folder: 'INBOX', uid: 17, uidValidity: '9' } }]);

    const back = await call(client, 'mark_handled', { messageId: '<one@x>', handled: false });
    expect(back).toMatchObject({ handled: false, handledAt: null, needsYou: 2 });
    // Putting one back changes nothing in the mailbox.
    expect(box.acted).toHaveLength(1);
    expect(await client.callTool({ name: 'mark_handled', arguments: { messageId: '<absent@x>' } })).toMatchObject({ isError: true });
  });
});

describe('acting on a mailbox', () => {
  beforeEach(() => { process.env.MAIL_ACCOUNT_1 = 'qq|me@qq.com|pw'; });

  it('keeps the record with the message when it is archived, and counts it dealt with', async () => {
    const state = seeded();
    state.rememberUid('k1', 'INBOX', 17, '9');
    const box = mailbox(state);
    box.act = (action) => (action === 'archive' ? { destinationUid: 101, destinationUidValidity: '4' } : action === 'inbox' ? { sourceFolder: 'Archive' } : {});
    const client = await connect(state, true, box.backend);
    const archived = await call(client, 'manage_mail', { messageId: '<one@x>', action: 'archive' });
    // What a caller is told is the action and where the message now is, not where in the folder.
    expect(archived).toEqual({
      success: true, action: 'archive', messageId: '<one@x>', account: 'me@qq.com', folder: 'Archive', inSpam: false,
      handledAt: expect.any(String), needsYou: 1,
    });
    expect(box.acted[0]).toMatchObject({ action: 'archive', hint: { folder: 'INBOX', uid: 17, uidValidity: '9' } });
    expect(state.getMail('k1')).toMatchObject({ folder: 'Archive', inSpam: false });
    expect(state.placeOf('k1')).toEqual({ uid: 101, uidValidity: '4' });
    expect(state.listMailActions(5)[0]).toMatchObject({ action: 'archive', success: true, destinationFolder: 'Archive', client: 'mcp:test' });
    expect((await call(client, 'needs_you'))['count']).toBe(1);

    // Brought back, it is looked for where the record now says it is; the server did not say where it landed.
    await call(client, 'manage_mail', { messageId: '<one@x>', action: 'inbox' });
    expect(box.acted[1]).toMatchObject({ action: 'inbox', hint: { folder: 'Archive', uid: 101, uidValidity: '4' } });
    expect(state.getMail('k1')).toMatchObject({ folder: 'INBOX' });
    expect(state.placeOf('k1')).toBeUndefined();
    // Starring moves nothing, and leaves the record alone.
    expect(await call(client, 'manage_mail', { messageId: '<two@x>', action: 'star' })).toMatchObject({ success: true, folder: 'INBOX', handledAt: null });
  });

  it('bins a message and moves one to a named folder, as the page\'s owner can', async () => {
    const state = seeded();
    const box = mailbox(state);
    const client = await connect(state, true, box.backend);
    expect(await call(client, 'manage_mail', { messageId: '<one@x>', action: 'trash' }))
      .toMatchObject({ success: true, action: 'trash', folder: 'Trash', handledAt: expect.any(String) });
    expect(state.listMailActions(5)[0]).toMatchObject({ action: 'trash', success: true, destinationFolder: 'Trash' });

    expect(await call(client, 'manage_mail', { messageId: '<two@x>', action: 'move', destination: 'Projects/2026' }))
      .toMatchObject({ success: true, folder: 'Projects/2026', handledAt: null });
    expect(box.acted[1]).toMatchObject({ action: 'move', destination: 'Projects/2026' });
    // A move with nowhere to go is a bad argument, and nothing is asked of the mailbox.
    expect(await client.callTool({ name: 'manage_mail', arguments: { messageId: '<three@x>', action: 'move' } })).toMatchObject({ isError: true });
    expect(box.acted).toHaveLength(2);
  });

  it('records a message that could not be found or an action the mailbox refused, and changes nothing', async () => {
    const state = seeded();
    const box = mailbox(state);
    box.act = () => undefined;
    const client = await connect(state, true, box.backend);
    const missing = await client.callTool({ name: 'manage_mail', arguments: { messageId: '<one@x>', action: 'archive' } });
    expect(missing).toMatchObject({ isError: true });
    expect(JSON.parse((missing.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ code: 'NOT_FOUND' });
    expect(state.getMail('k1')).toMatchObject({ folder: 'INBOX', handledAt: null });
    expect(state.listMailActions(5)[0]).toMatchObject({ action: 'archive', success: false });

    box.backend.act = async () => { throw new MailActionError('invalid_destination', 'this mailbox has no archive folder'); };
    const refused = await (await connect(state, true, box.backend)).callTool({ name: 'manage_mail', arguments: { messageId: '<one@x>', action: 'archive' } });
    expect(JSON.parse((refused.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ code: 'ACTION_REFUSED', message: expect.stringContaining('no archive folder') });
  });
});

describe('reading a message and answering it', () => {
  beforeEach(() => { process.env.MAIL_ACCOUNT_1 = 'qq|me@qq.com|pw'; });

  it('reads a message as the page shows it, to anyone who may read, and remembers where it was', async () => {
    const state = seeded();
    const box = mailbox(state);
    const message = await call(await connect(state, false, box.backend), 'read_message', { messageId: '<one@x>' });
    expect(message).toMatchObject({
      messageId: '<one@x>', account: 'me@qq.com', folder: 'INBOX', flags: { seen: false },
      from: { address: 'billing@vendor.com' }, subject: 'subject k1', text: 'Please confirm the invoice by Friday.',
      hasHtml: true, senderAuthentication: { result: 'pass', signedBy: 'vendor.com' }, importance: 'critical',
    });
    // The markup is the page's to draw; a model is given the text.
    expect(message).not.toHaveProperty('html');
    expect(box.read).toEqual([{ folder: 'INBOX' }]);
    expect(state.placeOf('k1')).toEqual({ uid: 17, uidValidity: '9' });
    expect(await (await connect(state)).callTool({ name: 'read_message', arguments: { messageId: '<absent@x>' } })).toMatchObject({ isError: true });
  });

  it('says what an answer would start from, and sends nothing', async () => {
    const state = seeded();
    const box = mailbox(state);
    const client = await connect(state, false, box.backend);
    expect(await call(client, 'prepare_reply', { messageId: '<one@x>' })).toMatchObject({
      account: 'me@qq.com', to: ['billing@vendor.com'], cc: [], subject: 'Re: subject k1', canSend: true,
      references: ['<root@x>', '<one@x>'], quoted: expect.stringContaining('> Please confirm the invoice by Friday.'),
    });
    // The line over the quote follows the language the answer is written in.
    expect((await call(client, 'prepare_reply', { messageId: '<one@x>', language: 'zh-CN' }))['quoted']).toContain('写道：');
    // Everyone the original went to, and never the owner's own address.
    expect(await call(client, 'prepare_reply', { messageId: '<one@x>', mode: 'replyAll' })).toMatchObject({ to: ['billing@vendor.com'], cc: ['ann@vendor.com'] });
    expect(box.sent).toEqual([]);
  });

  it('answers a message in one call: to its sender, in its thread, quoted, and counts it dealt with', async () => {
    const state = seeded();
    const box = mailbox(state);
    const client = await connect(state, true, box.backend);
    const sent = await call(client, 'send_mail', { replyTo: '<one@x>', text: 'Confirmed, thank you.' });
    expect(sent).toMatchObject({
      sent: true, messageId: '<sent@x>', to: ['billing@vendor.com'], cc: [], bccCount: 0, subject: 'Re: subject k1',
      accepted: 1, savedCopy: true, needsYou: 1,
    });
    expect(box.sent).toHaveLength(1);
    expect(box.sent[0]).toMatchObject({ to: ['billing@vendor.com'], subject: 'Re: subject k1', inReplyTo: '<one@x>' });
    // The thread it continues: what the original referred to, and the original. (The sender removes a repeat.)
    expect(box.sent[0]!.references).toEqual(expect.arrayContaining(['<root@x>', '<one@x>']));
    expect(box.sent[0]!.text.startsWith('Confirmed, thank you.\n\n')).toBe(true);
    expect(box.sent[0]!.text).toContain('> Please confirm the invoice by Friday.');
    // What the page does after a send: a copy in Sent, the original answered and done, all of it on record.
    expect(box.appended).toBe(1);
    expect(state.getMail('k1')?.handledAt).toBeTruthy();
    await vi.waitFor(() => expect(box.acted).toContainEqual(expect.objectContaining({ messageId: '<one@x>', action: 'answered' })));
    expect(state.listMailActions(10).map((row) => row.action)).toEqual(expect.arrayContaining(['send', 'answered']));
    expect(state.listMailActions(10).find((row) => row.action === 'send')).toMatchObject({ success: true, client: 'mcp:test' });
  });

  it('sends to whom it is told, without a quote when asked, and a new message from a named mailbox', async () => {
    const state = seeded();
    const box = mailbox(state);
    const client = await connect(state, true, box.backend);
    await call(client, 'send_mail', {
      replyTo: '<one@x>', replyAll: true, quote: false, to: ['ann@vendor.com'], cc: ['boss@example.org'], subject: 'About the invoice', text: 'See below.',
    });
    expect(box.sent[0]).toMatchObject({ to: ['ann@vendor.com'], cc: ['boss@example.org'], subject: 'About the invoice', text: 'See below.', inReplyTo: '<one@x>' });

    const fresh = await call(client, 'send_mail', { account: 'me@qq.com', to: ['friend@example.org'], subject: 'Lunch', text: 'Friday?' });
    expect(fresh).toMatchObject({ sent: true, to: ['friend@example.org'], subject: 'Lunch' });
    expect(fresh).not.toHaveProperty('needsYou', 0);
    expect(box.sent[1]).toMatchObject({ to: ['friend@example.org'], subject: 'Lunch', text: 'Friday?' });
    expect(box.sent[1]).not.toHaveProperty('inReplyTo');
  });

  it('refuses a letter with no sender or nobody to go to, before anything is sent', async () => {
    const state = seeded();
    const box = mailbox(state);
    const client = await connect(state, true, box.backend);
    const errorOf = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const answer = await client.callTool({ name: 'send_mail', arguments: args });
      expect(answer).toMatchObject({ isError: true });
      return JSON.parse((answer.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;
    };
    expect(await errorOf({ text: 'hello' })).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await errorOf({ account: 'me@qq.com', subject: 's', text: 'hello' })).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await errorOf({ account: 'nobody@example.org', to: ['a@b.co'], subject: 's', text: 'hello' })).toMatchObject({ code: 'ACCOUNT_UNKNOWN' });
    expect(await errorOf({ replyTo: '<absent@x>', text: 'hello' })).toMatchObject({ code: 'NOT_FOUND' });
    expect(box.sent).toEqual([]);
  });

  it('sends one letter once: the same request again is answered with what became of the first', async () => {
    const state = seeded();
    const box = mailbox(state);
    const client = await connect(state, true, box.backend);
    const letter = { account: 'me@qq.com', to: ['friend@example.org'], subject: 'Once', text: 'Only once.' };
    expect(await call(client, 'send_mail', letter)).toMatchObject({ sent: true, messageId: '<sent@x>' });
    // No name was given: the letter is its own name, which is what protects a caller that timed out and asked again.
    const again = await call(client, 'send_mail', letter);
    // The same account of it as the first time, and a notice that nothing went out again.
    expect(again).toMatchObject({
      sent: true, repeated: true, messageId: '<sent@x>', account: 'me@qq.com', to: ['friend@example.org'], cc: [], subject: 'Once',
    });
    expect(again['notice']).toContain('not sent again');
    expect(again).not.toHaveProperty('note');
    expect(box.sent).toHaveLength(1);

    // On purpose, under a name of its own, the same words do go out again...
    expect(await call(client, 'send_mail', { ...letter, id: 'second-copy' })).not.toHaveProperty('repeated');
    expect(box.sent).toHaveLength(2);
    // ...and a name stands for one letter only: reused for another, it does not answer for the first.
    const other = await call(client, 'send_mail', { ...letter, id: 'second-copy', text: 'A different letter.' });
    expect(other).toMatchObject({ sent: true });
    expect(other).not.toHaveProperty('repeated');
    expect(box.sent).toHaveLength(3);
    expect(box.sent[2]).toMatchObject({ text: 'A different letter.' });
  });

  it('says when a send may or may not have left, and does not try it again on the same request', async () => {
    const state = seeded();
    const box = mailbox(state);
    const client = await connect(state, true, box.backend);
    const letter = { account: 'me@qq.com', to: ['friend@example.org'], subject: 'Maybe', text: 'Did this leave?' };
    const errorOf = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const answer = await client.callTool({ name: 'send_mail', arguments: args });
      expect(answer).toMatchObject({ isError: true });
      return JSON.parse((answer.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;
    };

    box.send = () => { throw new SendError('rejected', 'the server refused the recipient', { detail: '550 no such user' }); };
    expect(await errorOf(letter)).toMatchObject({ code: 'ACTION_REFUSED', message: expect.stringContaining('550 no such user') });
    box.send = () => { throw new SendError('connection', 'could not reach the mail server'); };
    // Nothing left, and the answer says that trying again is safe.
    expect(await errorOf(letter)).toMatchObject({ code: 'MAILBOX_UNAVAILABLE', hint: expect.stringContaining('Nothing was sent') });

    let attempts = 0;
    box.send = () => { attempts += 1; throw new SendError('unknown', 'the connection ended after the message was handed over'); };
    expect(await errorOf(letter)).toMatchObject({ code: 'PROVIDER_ERROR', hint: expect.stringContaining('Do not send it again') });
    // The same request again is told the same, and the mail server is not handed the letter a second time.
    expect(await errorOf(letter)).toMatchObject({ code: 'PROVIDER_ERROR', message: expect.stringContaining('send_timeout') });
    expect(attempts).toBe(1);
    // Once the owner has looked in Sent and wants it sent after all, a new name sends it.
    delete box.send;
    expect(await call(client, 'send_mail', { ...letter, id: 'after-looking' })).toMatchObject({ sent: true });
    expect(box.sent).toHaveLength(1);
  });

  it('answers with what really happened once a send that was slow to confirm has gone through', async () => {
    vi.useFakeTimers();
    try {
      const state = seeded();
      const box = mailbox(state);
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const send = box.backend.send!;
      box.backend.send = async (account, mail) => { await held; return send(account, mail); };
      const client = await connect(state, true, box.backend);
      const letter = { account: 'me@qq.com', to: ['friend@example.org'], subject: 'Slow', text: 'Takes its time.' };
      // A client that is patient enough to hear the server's own answer; most give up at a minute themselves.
      const first = client.callTool({ name: 'send_mail', arguments: letter }, undefined, { timeout: 120_000 });
      // The mail server takes longer than a caller is made to wait.
      await vi.advanceTimersByTimeAsync(61_000);
      expect(JSON.parse(((await first).content as Array<{ text: string }>)[0]!.text)).toMatchObject({ code: 'PROVIDER_ERROR' });
      // ...and then takes the message after all.
      release();
      await vi.advanceTimersByTimeAsync(10);
      // Asked again, the answer is what became of it, not a warning that it may or may not have left.
      expect(await call(client, 'send_mail', letter)).toMatchObject({ sent: true, repeated: true, messageId: '<sent@x>' });
      expect(box.sent).toHaveLength(1);
      expect(state.listMailActions(5).find((row) => row.action === 'send' && row.success)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fills in to and cc each on its own, and says when an answer went to another domain than the sender\'s', async () => {
    const state = seeded();
    const box = mailbox(state);
    const client = await connect(state, true, box.backend);
    // Told who to answer, and asked to reply to all: the others still get their copy, and nobody gets two.
    await call(client, 'send_mail', { replyTo: '<one@x>', replyAll: true, to: ['ann@vendor.com'], text: 'To Ann, with the rest in copy.' });
    expect(box.sent[0]).toMatchObject({ to: ['ann@vendor.com'], cc: [] });
    await call(client, 'send_mail', { replyTo: '<one@x>', replyAll: true, to: ['boss@example.org'], text: 'Copying the thread.' });
    expect(box.sent[1]).toMatchObject({ to: ['boss@example.org'], cc: ['ann@vendor.com'] });
    // An empty cc is a decision, not an omission.
    await call(client, 'send_mail', { replyTo: '<one@x>', replyAll: true, cc: [], text: 'Only to the sender.' });
    expect(box.sent[2]).toMatchObject({ to: ['billing@vendor.com'], cc: [] });

    // A message that asks for answers somewhere else than it came from.
    const elsewhere = { ...(await box.backend.read!({} as never, '<one@x>'))! };
    elsewhere.readable = { ...elsewhere.readable, replyTo: [{ name: '', address: 'payments@other-domain.example' }] };
    box.backend.read = async () => elsewhere;
    forgetLive();
    // A server is given its mailbox when it is made, so this one is made anew.
    const wary = await connect(state, true, box.backend);
    expect(await call(wary, 'prepare_reply', { messageId: '<one@x>' }))
      .toMatchObject({ sender: 'billing@vendor.com', to: ['payments@other-domain.example'], replyToElsewhere: true });
    const sent = await call(wary, 'send_mail', { replyTo: '<one@x>', text: 'Paid.' });
    expect(sent).toMatchObject({ to: ['payments@other-domain.example'] });
    expect(sent['note']).toContain('another domain than its sender (billing@vendor.com)');
    // Addressed by the caller, there is nothing to point out.
    expect(await call(wary, 'send_mail', { replyTo: '<one@x>', to: ['billing@vendor.com'], text: 'Paid, to you directly.' })).not.toHaveProperty('note');

    // A sender with no address at all is no reassurance about where the answer is going.
    const nameless = { ...elsewhere, readable: { ...elsewhere.readable, from: null } };
    box.backend.read = async () => nameless;
    forgetLive();
    expect(await call(await connect(state, false, box.backend), 'prepare_reply', { messageId: '<one@x>' }))
      .toMatchObject({ sender: '', to: ['payments@other-domain.example'], replyToElsewhere: true });
  });
});

describe('the review of what goes out', () => {
  beforeEach(() => { process.env.MAIL_ACCOUNT_1 = 'qq|me@qq.com|pw'; });
  const errorOf = async (client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const answer = await client.callTool({ name, arguments: args });
    expect(answer, name).toMatchObject({ isError: true });
    return JSON.parse((answer.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;
  };

  it('asks which mailbox is meant when one message is stored for two, and acts on the one named', async () => {
    process.env.MAIL_ACCOUNT_2 = 'qq|work@qq.com|pw';
    const state = seeded();
    // The same message, stored a second time for another mailbox, and still waiting there.
    state.markSeen('work@qq.com|<one@x>', 'work@qq.com', 'subject k1');
    state.recordOutcome('work@qq.com|<one@x>', 'critical', true, { messageId: '<one@x>', folder: 'INBOX', sender: 'billing@vendor.com' });
    const box = mailbox(state);
    const client = await connect(state, true, box.backend);
    for (const [name, args] of [
      ['send_mail', { replyTo: '<one@x>', text: 'Which?' }],
      ['manage_mail', { messageId: '<one@x>', action: 'archive' }],
      ['mark_handled', { messageId: '<one@x>' }],
      ['read_message', { messageId: '<one@x>' }],
      ['prepare_reply', { messageId: '<one@x>' }],
    ] as const) {
      const refused = await errorOf(client, name, args);
      expect(refused, name).toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(String(refused['message']), name).toContain('work@qq.com');
    }
    expect(box.sent).toEqual([]);
    expect(box.acted).toEqual([]);

    const sent = await call(client, 'send_mail', { replyTo: '<one@x>', account: 'work@qq.com', text: 'From work.' });
    expect(sent).toMatchObject({ sent: true, account: 'work@qq.com' });
    // The copy that was answered is the one that is dealt with.
    expect(state.getMail('work@qq.com|<one@x>')?.handledAt).toBeTruthy();
    expect(state.getMail('k1')?.handledAt).toBeNull();
    expect(await errorOf(client, 'mark_handled', { messageId: '<one@x>', account: 'nobody@qq.com' })).toMatchObject({ code: 'NOT_FOUND' });
    expect(await call(client, 'mark_handled', { messageId: '<one@x>', account: 'me@qq.com' })).toMatchObject({ account: 'me@qq.com', handled: true });
  });

  it('holds the quote a reader is shown to the operator\'s limit, as it holds the message', async () => {
    const state = seeded();
    const box = mailbox(state);
    const long = { ...(await box.backend.read!({} as never, '<one@x>'))! };
    long.readable = { ...long.readable, text: 'a'.repeat(5000) };
    box.backend.read = async () => long;
    process.env.MCP_LIVE_BODY_CHARS = '1000';
    try {
      const draft = await call(await connect(state, false, box.backend), 'prepare_reply', { messageId: '<one@x>' });
      expect(String(draft['quoted']).length).toBeLessThanOrEqual(1005);
      expect(String(draft['quoted']).endsWith('[…]')).toBe(true);
    } finally {
      delete process.env.MCP_LIVE_BODY_CHARS;
    }
  });

  it('does not answer everyone a message went to when it names nobody to answer', async () => {
    const state = seeded();
    const box = mailbox(state);
    const nameless = { ...(await box.backend.read!({} as never, '<one@x>'))! };
    nameless.readable = { ...nameless.readable, from: null, replyTo: [], to: [{ name: '', address: 'me@qq.com' }, { name: '', address: 'all-staff@vendor.com' }] };
    box.backend.read = async () => nameless;
    const client = await connect(state, true, box.backend);
    expect(await call(client, 'prepare_reply', { messageId: '<one@x>' })).toMatchObject({ to: ['all-staff@vendor.com'], addressedTo: 'recipients' });
    expect(await errorOf(client, 'send_mail', { replyTo: '<one@x>', text: 'To whom?' })).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(box.sent).toEqual([]);
    // Told whom, it goes.
    expect(await call(client, 'send_mail', { replyTo: '<one@x>', to: ['billing@vendor.com'], text: 'To you.' })).toMatchObject({ sent: true });
  });

  it('says plainly when an answer went to a Reply-To and there is no sender to compare it with', async () => {
    const state = seeded();
    const box = mailbox(state);
    const odd = { ...(await box.backend.read!({} as never, '<one@x>'))! };
    odd.readable = { ...odd.readable, from: null, replyTo: [{ name: '', address: 'payments@other.example' }] };
    box.backend.read = async () => odd;
    const sent = await call(await connect(state, true, box.backend), 'send_mail', { replyTo: '<one@x>', text: 'Paid.' });
    expect(sent['note']).toContain('gives no sender address to compare it with');
    expect(String(sent['note'])).not.toContain('()');
  });

  it('answers a message it can no longer read when told whom and asked not to quote it', async () => {
    const state = seeded();
    const box = mailbox(state);
    box.backend.read = async () => undefined;
    const client = await connect(state, true, box.backend);
    const refused = await errorOf(client, 'send_mail', { replyTo: '<one@x>', text: 'Still here?' });
    expect(refused).toMatchObject({ code: 'NOT_FOUND', hint: expect.stringContaining('quote=false') });
    expect(box.sent).toEqual([]);
    const sent = await call(client, 'send_mail', { replyTo: '<one@x>', to: ['billing@vendor.com'], quote: false, text: 'Following up.' });
    expect(sent).toMatchObject({ sent: true, subject: 'Re: subject k1', note: expect.stringContaining('could not be read') });
    // Still in its thread, and the original still counted as answered.
    expect(box.sent[0]).toMatchObject({ inReplyTo: '<one@x>', text: 'Following up.' });
    expect(state.getMail('k1')?.handledAt).toBeTruthy();
  });

  it('carries the Reply-To warning and the recipients onto a repeated answer', async () => {
    const state = seeded();
    const box = mailbox(state);
    const elsewhere = { ...(await box.backend.read!({} as never, '<one@x>'))! };
    elsewhere.readable = { ...elsewhere.readable, replyTo: [{ name: '', address: 'payments@other.example' }] };
    box.backend.read = async () => elsewhere;
    const client = await connect(state, true, box.backend);
    const letter = { replyTo: '<one@x>', text: 'Paid.' };
    const first = await call(client, 'send_mail', letter);
    const again = await call(client, 'send_mail', letter);
    expect(again).toMatchObject({ repeated: true, to: ['payments@other.example'], note: first['note'] });
    expect(again['notice']).toContain('not sent again');
    expect(box.sent).toHaveLength(1);
  });

  it('answers a second identical call that arrived while the first was reading the original as a repeat', async () => {
    const state = seeded();
    const box = mailbox(state);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const read = box.backend.read!;
    let reads = 0;
    box.backend.read = async (...a) => { reads += 1; if (reads === 1) await held; return read(...a); };
    const client = await connect(state, true, box.backend);
    const letter = { replyTo: '<one@x>', text: 'Confirmed.' };
    const first = call(client, 'send_mail', letter);
    await vi.waitFor(() => expect(reads).toBe(1));
    const second = call(client, 'send_mail', letter);
    release();
    const answers = await Promise.all([first, second]);
    expect(box.sent).toHaveLength(1);
    expect(answers.filter((answer) => answer['repeated'] === true)).toHaveLength(1);
  });

  it('lets a letter go again once its unconfirmed attempt turned out to have failed before it left', async () => {
    vi.useFakeTimers();
    try {
      const state = seeded();
      const box = mailbox(state);
      let fail: (error: Error) => void = () => undefined;
      let attempts = 0;
      const send = box.backend.send!;
      box.backend.send = async (account, mail) => {
        attempts += 1;
        if (attempts === 1) await new Promise<void>((_, reject) => { fail = reject; });
        return send(account, mail);
      };
      const client = await connect(state, true, box.backend);
      const letter = { account: 'me@qq.com', to: ['friend@example.org'], subject: 'Hanging', text: 'Will it?' };
      const first = client.callTool({ name: 'send_mail', arguments: letter }, undefined, { timeout: 300_000 });
      await vi.advanceTimersByTimeAsync(61_000);
      expect(JSON.parse(((await first).content as Array<{ text: string }>)[0]!.text)).toMatchObject({ code: 'PROVIDER_ERROR' });
      // The attempt then fails before the message was handed over, with nobody waiting.
      fail(new SendError('connection', 'could not reach the mail server'));
      await vi.advanceTimersByTimeAsync(10);
      // That is known now: the same letter is sent, not refused as "may have left".
      expect(await call(client, 'send_mail', letter)).toMatchObject({ sent: true });
      expect(box.sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('acts on the message it was given, not on one whose Message-ID was made to look like the other\'s key', async () => {
    const state = new StateStore(':memory:');
    // The look-alike is stored first. Its sender chose a Message-ID that spells the real message's key.
    state.markSeen('me@qq.com|me@qq.com|<real@x>', 'me@qq.com', 'look-alike');
    state.recordOutcome('me@qq.com|me@qq.com|<real@x>', 'warning', true, { messageId: 'me@qq.com|<real@x>', sender: 'attacker@evil.example', folder: 'INBOX' });
    state.markSeen('me@qq.com|<real@x>', 'me@qq.com', 'the real one');
    state.recordOutcome('me@qq.com|<real@x>', 'critical', true, { messageId: '<real@x>', sender: 'boss@corp.example', folder: 'INBOX' });
    const box = mailbox(state);
    const client = await connect(state, true, box.backend);

    // Each by the Message-ID list_mail shows for it.
    const listed = (await call(client, 'list_mail'))['mail'] as Array<{ messageId: string; sender: string }>;
    const idOf = (sender: string): string => listed.find((m) => m.sender === sender)!.messageId;
    expect(await call(client, 'get_mail', { messageId: idOf('attacker@evil.example') })).toMatchObject({ sender: 'attacker@evil.example' });
    expect(await call(client, 'get_mail', { messageId: idOf('boss@corp.example') })).toMatchObject({ sender: 'boss@corp.example' });
    const page = await client.readResource({ uri: `mailsift://mail/${encodeURIComponent(idOf('attacker@evil.example'))}` });
    expect(String((page.contents[0] as { text: string }).text)).toContain('attacker@evil.example');

    await call(client, 'manage_mail', { messageId: idOf('attacker@evil.example'), action: 'trash' });
    expect(box.acted.at(-1)).toMatchObject({ messageId: 'me@qq.com|<real@x>', action: 'trash' });
    expect(state.getMail('me@qq.com|me@qq.com|<real@x>')?.handledAt).toBeTruthy();
    expect(state.getMail('me@qq.com|<real@x>')?.handledAt).toBeNull();

    await call(client, 'mark_handled', { messageId: idOf('boss@corp.example') });
    expect(state.getMail('me@qq.com|<real@x>')?.handledAt).toBeTruthy();
    await call(client, 'record_feedback', { messageId: idOf('attacker@evil.example'), label: 'false_positive' });
    await call(client, 'record_feedback', { messageId: idOf('attacker@evil.example'), label: 'false_positive' });
    expect(state.feedbackRuleHints(1).neverImportant).toEqual(['attacker@evil.example']);
  });

  it('does not answer everyone a message went to because its From line names the owner', async () => {
    const state = seeded();
    const box = mailbox(state);
    const forged = { ...(await box.backend.read!({} as never, '<one@x>'))! };
    forged.readable = {
      ...forged.readable, from: { name: 'Me', address: 'me@qq.com' }, replyTo: [], cc: [],
      to: [{ name: '', address: 'me@qq.com' }, { name: '', address: 'attacker@evil.example' }],
    };
    box.backend.read = async () => forged;
    const client = await connect(state, true, box.backend);
    expect(await call(client, 'prepare_reply', { messageId: '<one@x>' })).toMatchObject({ to: ['attacker@evil.example'], addressedTo: 'ownRecipients' });
    const refused = await errorOf(client, 'send_mail', { replyTo: '<one@x>', text: 'Hm.' });
    expect(refused).toMatchObject({ code: 'INVALID_ARGUMENT', hint: expect.stringContaining('prepare_reply') });
    // What a sender wrote stays in the data fields; the server's own words do not repeat it.
    expect(JSON.stringify(refused)).not.toContain('attacker@evil.example');
    expect(box.sent).toEqual([]);
    // Told whom, and asked to answer everyone: the others the composer would have addressed are copied.
    await call(client, 'send_mail', { replyTo: '<one@x>', to: ['boss@corp.example'], replyAll: true, text: 'Copying all.' });
    expect(box.sent[0]).toMatchObject({ to: ['boss@corp.example'], cc: ['attacker@evil.example'] });
  });

  it('does not drop a reply-all\'s other recipients when the original cannot be read to find them', async () => {
    const state = seeded();
    const box = mailbox(state);
    box.backend.read = async () => undefined;
    const client = await connect(state, true, box.backend);
    const refused = await errorOf(client, 'send_mail', { replyTo: '<one@x>', replyAll: true, to: ['billing@vendor.com'], quote: false, text: 'All of you.' });
    expect(refused).toMatchObject({ code: 'NOT_FOUND', hint: expect.stringContaining('cc as well') });
    expect(box.sent).toEqual([]);
    await call(client, 'send_mail', { replyTo: '<one@x>', replyAll: true, to: ['billing@vendor.com'], cc: ['ann@vendor.com'], quote: false, text: 'All of you.' });
    expect(box.sent[0]).toMatchObject({ to: ['billing@vendor.com'], cc: ['ann@vendor.com'] });
  });

  it('tells a second identical call that shared the first one\'s read of the original that it was a repeat', async () => {
    const state = seeded();
    const box = mailbox(state);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const read = box.backend.read!;
    let reads = 0;
    box.backend.read = async (...a) => { reads += 1; await held; return read(...a); };
    const client = await connect(state, true, box.backend);
    const letter = { replyTo: '<one@x>', text: 'Confirmed.' };
    const calls = [call(client, 'send_mail', letter), call(client, 'send_mail', letter), call(client, 'send_mail', letter)];
    // All three are waiting on the same read of the original before it comes back.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reads).toBe(1);
    release();
    const answers = await Promise.all(calls);
    expect(box.sent).toHaveLength(1);
    expect(answers.filter((answer) => answer['repeated'] === true)).toHaveLength(2);
    expect(answers.every((answer) => answer['messageId'] === '<sent@x>')).toBe(true);
  });

  it('records feedback against the copy meant, and get_mail says when there is more than one', async () => {
    process.env.MAIL_ACCOUNT_2 = 'qq|work@qq.com|pw';
    const state = seeded();
    state.markSeen('work@qq.com|<one@x>', 'work@qq.com', 'subject k1');
    state.recordOutcome('work@qq.com|<one@x>', 'critical', true, { messageId: '<one@x>', folder: 'INBOX' });
    const client = await connect(state, true, mailbox(state).backend);
    expect(await errorOf(client, 'record_feedback', { messageId: '<one@x>', label: 'handled' })).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await call(client, 'record_feedback', { messageId: '<one@x>', label: 'handled', account: 'work@qq.com' })).toMatchObject({ account: 'work@qq.com' });
    expect(state.getMail('work@qq.com|<one@x>')?.handledAt).toBeTruthy();
    expect(state.getMail('k1')?.handledAt).toBeNull();
    expect(await call(client, 'get_mail', { messageId: '<one@x>' })).toMatchObject({ found: true, storedFor: ['me@qq.com', 'work@qq.com'] });
    expect(await call(client, 'get_mail', { messageId: '<one@x>', account: 'work@qq.com' })).toMatchObject({ found: true, account: 'work@qq.com' });
  });

  it('survives an attempt it stopped waiting for that then ends without an answer', async () => {
    vi.useFakeTimers();
    try {
      const state = seeded();
      const box = mailbox(state);
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const send = box.backend.send!;
      box.backend.send = async (account, mail) => { await held; return send(account, mail); };
      // Filing the copy fails after the message has left, which no real backend does but nothing should die of.
      box.backend.savesSentCopy = () => { throw new Error('savesSentCopy threw'); };
      const client = await connect(state, true, box.backend);
      const letter = { account: 'me@qq.com', to: ['friend@example.org'], subject: 'Odd', text: 'Ends oddly.' };
      const first = client.callTool({ name: 'send_mail', arguments: letter }, undefined, { timeout: 300_000 });
      await vi.advanceTimersByTimeAsync(61_000);
      expect(JSON.parse(((await first).content as Array<{ text: string }>)[0]!.text)).toMatchObject({ code: 'PROVIDER_ERROR' });
      release();
      await vi.advanceTimersByTimeAsync(10);
      // Still uncertain: the same letter is not sent again.
      expect(await errorOf(client, 'send_mail', letter)).toMatchObject({ code: 'PROVIDER_ERROR' });
      expect(box.sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says whether a copy is in Sent, and the instructions only promise one when it is', async () => {
    const state = seeded();
    const box = mailbox(state);
    box.backend.appendSent = async () => undefined;
    const client = await connect(state, true, box.backend);
    expect(await call(client, 'send_mail', { account: 'me@qq.com', to: ['a@example.org'], subject: 's', text: 't' })).toMatchObject({ sent: true, savedCopy: false });
    const description = (await client.listTools()).tools.find((t) => t.name === 'send_mail')?.description ?? '';
    expect(description).toContain('savedCopy says whether');
    expect(description).not.toContain('A copy is kept in Sent');
  });
});

describe('a call that outlasts its caller', () => {
  beforeEach(() => { process.env.MAIL_ACCOUNT_1 = 'qq|me@qq.com|pw'; });

  it('is counted until it has finished and written its audit row, so its database handle is not closed under it', async () => {
    const state = seeded();
    const box = mailbox(state);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const send = box.backend.send!;
    box.backend.send = async (account, mail) => { await held; return send(account, mail); };
    const inFlight: InFlight = { count: 0 };
    let idle = 0;
    inFlight.idle = () => { idle += 1; };
    const client = await connect(state, true, box.backend, inFlight);

    const sending = call(client, 'send_mail', { account: 'me@qq.com', to: ['friend@example.org'], subject: 'Slow', text: 'Still leaving.' });
    await vi.waitFor(() => expect(inFlight.count).toBe(1));
    expect(idle).toBe(0);
    release();
    expect(await sending).toMatchObject({ sent: true });
    expect(inFlight.count).toBe(0);
    expect(idle).toBe(1);
    // What it did is on record: the message that left, and the call that sent it.
    expect(state.listMailActions(5).find((row) => row.action === 'send')).toMatchObject({ success: true });
    expect(state.listMcpAudit(5).find((row) => row.action === 'send_mail')).toMatchObject({ success: true, client: 'test' });
  });

  it('does not turn a message that left into an error because the audit row could not be written', async () => {
    const state = seeded();
    const box = mailbox(state);
    const client = await connect(state, true, box.backend);
    const audit = vi.spyOn(state, 'recordMcpAudit').mockImplementation(() => { throw new Error('database is locked'); });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await call(client, 'send_mail', { account: 'me@qq.com', to: ['friend@example.org'], subject: 'Sent', text: 'It left.' }))
        .toMatchObject({ sent: true });
      expect(box.sent).toHaveLength(1);
    } finally {
      audit.mockRestore();
      quiet.mockRestore();
    }
  });

  it('gives a reader no more of a message than the operator allowed MCP reads', async () => {
    const state = seeded();
    const box = mailbox(state);
    process.env.MCP_LIVE_BODY_CHARS = '1000';
    try {
      const long = { ...(await box.backend.read!({} as never, '<one@x>'))! };
      long.readable = { ...long.readable, text: 'a'.repeat(900), quoted: 'b'.repeat(900) };
      box.backend.read = async () => long;
      const message = await call(await connect(state, false, box.backend), 'read_message', { messageId: '<one@x>' });
      expect(String(message['text'])).toHaveLength(900);
      expect(String(message['quoted'])).toHaveLength(100);
      expect(message['truncated']).toBe(true);
    } finally {
      delete process.env.MCP_LIVE_BODY_CHARS;
    }
  });
});

describe('resources', () => {
  it('reads one stored record by Message-ID, as markdown a model can read', async () => {
    const client = await connect(seeded());
    const { contents } = await client.readResource({ uri: 'mailsift://mail/%3Cone%40x%3E' });
    const [first] = contents as Array<{ text: string; mimeType: string }>;
    expect(first!.mimeType).toBe('text/markdown');
    expect(first!.text).toContain('<one@x>');
    expect(first!.text).toMatch(/^# /);
    // The JSON form is still available from the tool, so nothing is lost.
    expect(await call(client, 'get_mail', { messageId: '<one@x>' })).toMatchObject({ messageId: '<one@x>' });
  });

  it('fails a read for a record that does not exist', async () => {
    const client = await connect(seeded());
    await expect(client.readResource({ uri: 'mailsift://mail/%3Cabsent%40x%3E' })).rejects.toThrow(/NOT_FOUND/);
  });

  it('serves the search syntax from the vocabulary the triage code uses', async () => {
    const client = await connect(seeded());
    const { contents } = await client.readResource({ uri: 'mailsift://search-syntax' });
    const [first] = contents as Array<{ text: string; mimeType: string }>;
    expect(first!.mimeType).toBe('text/markdown');
    for (const category of CATEGORIES) expect(first!.text).toContain(category);
    for (const level of IMPORTANCE) expect(first!.text).toContain(level);
    expect(first!.text).toContain('Forwarded copy');
  });

  it('lists the resources it offers', async () => {
    const client = await connect(seeded());
    const { resourceTemplates } = await client.listResourceTemplates();
    const uris = resourceTemplates.map((t) => t.uriTemplate);
    expect(uris).toContain('mailsift://mail/{messageId}');
    expect(uris).toContain('mailsift://thread/{threadKey}');
  });
});

describe('prompts', () => {
  it('offers the read-only workflows and names the tools to use', async () => {
    const client = await connect(seeded());
    const { prompts } = await client.listPrompts();
    const names = prompts.map((p) => p.name);
    expect(names).toContain('catch_up');
    expect(names).toContain('why_not_notified');
    // record_feedback is a write tool, so its workflow is not offered read-only.
    expect(names).not.toContain('review_triage');

    const { messages } = await client.getPrompt({ name: 'catch_up', arguments: { hours: '48' } });
    const text = (messages[0]!.content as { text: string }).text;
    expect(text).toContain('48');
    expect(text).toContain('list_digest');
  });

  it('adds the feedback workflow only where the write tools exist', async () => {
    const client = await connect(seeded(), true);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain('review_triage');
  });
});

describe('tool errors', () => {
  /** The structured body a failing tool now answers with. */
  async function errorBody(client: Client, name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    expect(result).toMatchObject({ isError: true });
    const [first] = result.content as Array<{ text: string }>;
    return JSON.parse(first!.text) as { code: string; message: string; hint?: string };
  }

  it('names an unknown mailbox and points at the tool that lists the real ones', async () => {
    process.env.MAIL_ACCOUNT_1 = 'qq|me@qq.com|secret';
    const client = await connect(seeded());
    const body = await errorBody(client, 'list_folders', { account: 'nobody@example.com' });
    expect(body.code).toBe('ACCOUNT_UNKNOWN');
    expect(body.hint).toMatch(/list_accounts/);
  });

  it('separates its own broken configuration from a caller mistake', async () => {
    // No MAIL_ACCOUNT_* is set here, so loading the configuration fails.
    const client = await connect(seeded());
    const body = await errorBody(client, 'list_folders', { account: 'me@qq.com' });
    expect(body.code).toBe('SERVER_MISCONFIGURED');
  });

  it('answers a Message-ID it has never seen without calling it an error', async () => {
    // Absence is an answer here: the tool reports found:false rather than failing.
    const client = await connect(seeded());
    expect(await call(client, 'get_mail', { messageId: '<absent@x>' })).toMatchObject({ found: false });
  });
});

describe('access audit', () => {
  it('names the tool that ran instead of recording that a request happened', async () => {
    // The audit used to store the constant "http_request" once per request, so
    // it could not answer whether a state-changing tool had ever been called.
    const state = seeded();
    const client = await connect(state);
    await call(client, 'list_mail');
    await call(client, 'list_mail');
    await call(client, 'search_mail', { query: 'Finance' });

    const byAction = Object.fromEntries(
      state.mcpAuditByAction().map((row) => [row.action, row]),
    );
    expect(byAction['list_mail']).toMatchObject({ calls: 2, failures: 0, clients: 1 });
    expect(byAction['search_mail']).toMatchObject({ calls: 1 });
    expect(byAction).not.toHaveProperty('http_request');
    expect(byAction['list_mail']!.lastAt).not.toBe('');
  });

  it('separates a failed call from a successful one', async () => {
    const state = seeded();
    const client = await connect(state);
    await client.callTool({ name: 'get_mail', arguments: { messageId: '<one@x>' } });
    await client.callTool({ name: 'get_mail', arguments: {} });

    const getMail = state.mcpAuditByAction().find((row) => row.action === 'get_mail')!;
    // A schema rejection never reaches the handler, so only the accepted call
    // is counted; what matters is that a counted call is a real one.
    expect(getMail).toMatchObject({ calls: 1, failures: 0 });
  });

  it('reports the breakdown through observability', async () => {
    const state = seeded();
    const client = await connect(state);
    await call(client, 'list_digest');
    const actions = (await call(client, 'observability'))['mcpAuditByAction'] as Array<{ action: string }>;
    expect(actions.map((row) => row.action)).toContain('list_digest');
  });
});

describe('feedback', () => {
  it('records a label and turns a repeated one into a sender rule', async () => {
    const state = seeded();
    const client = await connect(state, true);
    expect(await call(client, 'feedback_rules')).toMatchObject({ alwaysImportant: [], neverImportant: [] });

    for (const messageId of ['<one@x>', '<two@x>']) {
      expect(await call(client, 'record_feedback', { messageId, label: 'false_positive' }))
        .toMatchObject({ recorded: true });
    }

    expect(await call(client, 'feedback_rules')).toMatchObject({ neverImportant: ['billing@vendor.com'] });
    expect(await call(client, 'observability')).toMatchObject({ feedback: { false_positive: 2 } });
  });

  it('refuses a label outside the accepted set', async () => {
    const client = await connect(seeded(), true);
    expect(await client.callTool({ name: 'record_feedback', arguments: { messageId: '<one@x>', label: 'wrong' } }))
      .toMatchObject({ isError: true });
  });
});

describe('recovery and health', () => {
  it('lists dead letters and requeues one by key', async () => {
    const state = seeded();
    state.saveCursor('me@qq.com', 'INBOX', '7', 100);
    state.recordDeadLetter({
      account: 'me@qq.com', folder: 'INBOX', uidValidity: '7', uid: 42,
      messageId: '<bad@x>', subject: 'oversized', reason: 'source too large',
    });
    const client = await connect(state, true);

    expect(await call(client, 'list_dead_letters')).toMatchObject({ count: 1 });
    expect(await call(client, 'retry_dead_letter', { deadKey: 'me@qq.com|INBOX|7|42' })).toMatchObject({ requeued: true });
    expect(state.getCursor('me@qq.com', 'INBOX')).toEqual({ uidValidity: '7', lastUid: 41 });
    expect(await call(client, 'retry_dead_letter', { deadKey: 'nope' })).toMatchObject({ requeued: false });
  });

  it('reports health without a completed poll and with one', async () => {
    process.env.MAIL_ACCOUNT_1 = 'qq|me@qq.com|pw';
    const state = seeded();
    const client = await connect(state);

    expect(await call(client, 'health')).toMatchObject({ lastPollAt: null, healthy: false });
    state.setMeta('last_poll_at', new Date().toISOString());
    const healthy = await call(client, 'health');
    expect(healthy).toMatchObject({ healthy: true, failingAccounts: [] });
    expect(healthy['idle']).toMatchObject({ enabled: false });
    // A fresh heartbeat does not vouch for a mailbox that keeps failing.
    state.setMeta('account_fail_count:me@qq.com', '3');
    expect(await call(client, 'health')).toMatchObject({
      healthy: false, failingAccounts: [expect.objectContaining({ consecutiveFailures: 3 })],
    });
  });

  it('describes the configured accounts and the recovery backlog', async () => {
    process.env.MAIL_ACCOUNT_1 = 'qq|me@qq.com|pw';
    const client = await connect(seeded());
    const accounts = await call(client, 'list_accounts');
    expect(accounts).toMatchObject({ count: 1 });
    // Which credential an account uses tells a caller what to go after and
    // answers no query, so it is not part of the reply.
    for (const account of accounts['accounts'] as Array<Record<string, unknown>>) {
      expect(account).not.toHaveProperty('auth');
      expect(account).toMatchObject({ address: 'me@qq.com', provider: 'qq' });
    }
    expect(await call(client, 'recovery_status')).toMatchObject({ deadLetterCount: 0, notificationOutboxPending: 0 });
  });

  it('shows how far each folder has been processed', async () => {
    process.env.MAIL_ACCOUNT_1 = 'qq|me@qq.com|pw';
    const state = seeded();
    state.saveCursor('me@qq.com', 'INBOX', '7', 120);
    state.saveCursor('me@qq.com', 'Junk', '7', 8);
    const client = await connect(state);

    const cursors = (await call(client, 'recovery_status'))['cursors'] as Array<Record<string, unknown>>;
    expect(cursors.map((c) => `${String(c['folder'])}:${String(c['lastUid'])}`).sort())
      .toEqual(['INBOX:120', 'Junk:8']);
  });

  it('lists what is stuck in the outbox, without the message body', async () => {
    // A count alone cannot explain a backlog; these fields are what a stuck
    // entry has to be diagnosed from.
    process.env.MAIL_ACCOUNT_1 = 'qq|me@qq.com|pw';
    const state = seeded();
    state.enqueueNotification(
      'me@qq.com|<stuck@x>',
      makeMessage({ messageId: '<stuck@x>', subject: 'stuck one', inSpam: true, body: 'secret body text' }),
      makeResult({ importance: 'info', category: 'Marketing' }),
    );
    state.markNotificationFailed('me@qq.com|<stuck@x>', 'endpoint refused');
    const client = await connect(state);

    const status = await call(client, 'recovery_status');
    expect(status).toMatchObject({ notificationOutboxPending: 1 });
    const [entry] = status['notificationOutbox'] as Array<Record<string, unknown>>;
    expect(entry).toMatchObject({
      subject: 'stuck one', attempts: 1, inSpam: true, importance: 'info', category: 'Marketing',
    });
    expect(String(entry!['lastError'])).toContain('endpoint refused');
    expect(JSON.stringify(entry)).not.toContain('secret body text');
  });

  it('reports the thresholds that decide whether mail is pushed', async () => {
    // health is the first call when a notification is missing, so it has to
    // carry the settings that explain the decision.
    process.env.MAIL_ACCOUNT_1 = 'qq|me@qq.com|pw';
    process.env.PUSH_MIN_IMPORTANCE = 'critical';
    process.env.SPAM_RANK_BONUS = '2';
    process.env.SUPPRESS_SELF_FORWARDS = 'false';
    const client = await connect(seeded());

    const delivery = (await call(client, 'health'))['delivery'] as Record<string, unknown>;
    expect(delivery).toMatchObject({
      pushMinImportance: 'critical', pushMinRank: 2, spamRankBonus: 2,
      suppressSelfForwards: false, digestMinImportance: 'info', feishuMinImportanceOverride: null,
    });
    // The spam bonus reaches info at this threshold, so the warning comes too.
    expect(String(delivery['spamBonusWarning'])).toContain('every spam-folder message');
  });

  it('surfaces a configuration error instead of throwing', async () => {
    // No MAIL_ACCOUNT_* is set, so loadConfig fails inside the tool.
    const client = await connect(seeded());
    expect(String((await call(client, 'list_accounts'))['error'])).toContain('No mail accounts configured');
  });
});

describe('rate limiting', () => {
  it('allows a burst up to the limit and then refuses within the window', () => {
    process.env.MCP_RATE_LIMIT_PER_MINUTE = '3';
    const start = Date.parse('2026-09-28T00:00:00Z');
    expect([0, 1, 2].every((n) => allowMcpRequest('burst', start + n))).toBe(true);
    expect(allowMcpRequest('burst', start + 3)).toBe(false);
  });

  it('starts a fresh window after a minute', () => {
    process.env.MCP_RATE_LIMIT_PER_MINUTE = '1';
    const start = Date.parse('2026-09-28T00:00:00Z');
    expect(allowMcpRequest('window', start)).toBe(true);
    expect(allowMcpRequest('window', start + 59_000)).toBe(false);
    expect(allowMcpRequest('window', start + 60_000)).toBe(true);
  });

  it('counts each client separately', () => {
    process.env.MCP_RATE_LIMIT_PER_MINUTE = '1';
    const start = Date.parse('2026-09-28T00:00:00Z');
    expect(allowMcpRequest('alice', start)).toBe(true);
    expect(allowMcpRequest('bob', start)).toBe(true);
    expect(allowMcpRequest('alice', start + 1)).toBe(false);
  });

  it('falls back to the default when the limit is not a usable number', () => {
    process.env.MCP_RATE_LIMIT_PER_MINUTE = 'lots';
    const start = Date.parse('2026-09-28T00:00:00Z');
    expect(Array.from({ length: 120 }, (_, n) => allowMcpRequest('default', start + n)).every(Boolean)).toBe(true);
    expect(allowMcpRequest('default', start + 121)).toBe(false);
  });
});
