import { afterEach, describe, expect, it, vi } from 'vitest';
import './setup.js';

/**
 * The mailbox is stood in for here: these tests are about what the server
 * does around an action (who may ask, what is recorded, where the record
 * goes), and test/imap.test.ts is where the action itself is run.
 */
const mailbox = vi.hoisted(() => ({
  calls: [] as Array<{ messageId: string; action: string; destination?: string; hint: unknown }>,
  answer: undefined as undefined | ((action: string) => Record<string, unknown> | undefined),
}));
vi.mock('../src/imap/client.js', async (original) => {
  const real = await original<typeof import('../src/imap/client.js')>();
  return {
    ...real,
    applyMessageAction: async (account: { username: string }, messageId: string, action: string, destination?: string, hint?: unknown) => {
      if (!mailbox.answer) return real.applyMessageAction(account as never, messageId, action as never, destination, hint as never);
      mailbox.calls.push({ messageId, action, ...(destination ? { destination } : {}), hint });
      const answer = mailbox.answer(action);
      return answer ? { action, account: account.username, messageId, sourceFolder: 'INBOX', ...answer } : undefined;
    },
  };
});
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { allowMcpRequest, createServer } from '../src/mcp.js';
import { StateStore } from '../src/services/state.js';
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

async function connect(state: StateStore, writable = false): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer({ state, client: 'test', writable });
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
      'recovery_status', 'scan_attachment', 'search_mail',
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

    // Absent from the listing and also unreachable by name.
    expect(await client.callTool({ name: 'record_feedback', arguments: { messageId: '<one@x>', label: 'false_positive' } }))
      .toMatchObject({ isError: true });
  });

  it('adds exactly the tools that change something for a caller holding the write credential', async () => {
    const reader = new Set((await (await connect(new StateStore(':memory:'))).listTools()).tools.map((t) => t.name));
    const writer = (await (await connect(new StateStore(':memory:'), true)).listTools()).tools.map((t) => t.name);
    expect(writer.filter((name) => !reader.has(name)).sort()).toEqual(['manage_mail', 'mark_handled', 'record_feedback', 'retry_dead_letter']);
  });

  it('offers no way to send mail or to delete it, to anyone', async () => {
    const writer = (await (await connect(new StateStore(':memory:'), true)).listTools()).tools;
    expect(writer.map((t) => t.name).filter((name) => /send|reply|delete|trash|bin/i.test(name))).toEqual([]);
    const actions = (writer.find((t) => t.name === 'manage_mail')?.inputSchema.properties as Record<string, { enum?: string[] }>)['action']?.enum;
    expect(actions).toEqual(['mark_read', 'mark_unread', 'star', 'unstar', 'move', 'archive', 'inbox']);
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

  it('lets a writer say a message is done, and put it back', async () => {
    const state = seeded();
    const client = await connect(state, true);
    // No mailbox is configured here: the message is done all the same, and the answer says the mailbox was not told.
    const done = await call(client, 'mark_handled', { messageId: '<one@x>' });
    expect(done).toMatchObject({ messageId: '<one@x>', handled: true, markedRead: false, needsYou: 1 });
    expect(done['handledAt']).toEqual(expect.any(String));
    expect(state.getMail('k1')?.handledAt).toBeTruthy();
    expect(state.listMailActions(5)[0]).toMatchObject({ action: 'mark_read', success: false, client: 'test' });

    const back = await call(client, 'mark_handled', { messageId: '<one@x>', handled: false });
    expect(back).toMatchObject({ handled: false, handledAt: null, needsYou: 2 });
    expect(back).not.toHaveProperty('markedRead');
    expect(await client.callTool({ name: 'mark_handled', arguments: { messageId: '<absent@x>' } })).toMatchObject({ isError: true });
  });

  it('marks a done message read in its mailbox, at the place the record remembers', async () => {
    process.env.MAIL_ACCOUNT_1 = 'qq|me@qq.com|pw';
    const state = seeded();
    state.rememberUid('k1', 'INBOX', 17, '9');
    mailbox.calls = [];
    mailbox.answer = () => ({});
    try {
      const done = await call(await connect(state, true), 'mark_handled', { messageId: '<one@x>' });
      expect(done).toMatchObject({ handled: true, markedRead: true, needsYou: 1 });
      expect(mailbox.calls).toEqual([{ messageId: '<one@x>', action: 'mark_read', hint: { folder: 'INBOX', uid: 17, uidValidity: '9' } }]);
      expect(state.listMailActions(5)[0]).toMatchObject({ action: 'mark_read', success: true, sourceFolder: 'INBOX' });
    } finally {
      mailbox.answer = undefined;
    }
  });
});

describe('acting on a mailbox', () => {
  it('keeps the record with the message when it is archived, and counts it dealt with', async () => {
    process.env.MAIL_ACCOUNT_1 = 'qq|me@qq.com|pw';
    const state = seeded();
    state.rememberUid('k1', 'INBOX', 17, '9');
    mailbox.calls = [];
    mailbox.answer = (action) => (action === 'archive'
      ? { destinationFolder: 'Archive', destinationIsSpam: false, destinationUid: 101, destinationUidValidity: '4' }
      : action === 'inbox' ? { sourceFolder: 'Archive', destinationFolder: 'INBOX', destinationIsSpam: false } : {});
    try {
      const client = await connect(state, true);
      const archived = await call(client, 'manage_mail', { messageId: '<one@x>', action: 'archive' });
      // What a caller is told is the action and the folders, not where in the folder.
      expect(archived).toEqual({
        success: true, action: 'archive', account: 'me@qq.com', messageId: '<one@x>', sourceFolder: 'INBOX', destinationFolder: 'Archive',
      });
      expect(mailbox.calls[0]).toMatchObject({ action: 'archive', hint: { folder: 'INBOX', uid: 17, uidValidity: '9' } });
      expect(state.getMail('k1')).toMatchObject({ folder: 'Archive', inSpam: false });
      expect(state.getMail('k1')?.handledAt).toBeTruthy();
      expect(state.placeOf('k1')).toEqual({ uid: 101, uidValidity: '4' });
      expect(state.listMailActions(5)[0]).toMatchObject({ action: 'archive', success: true, destinationFolder: 'Archive' });
      expect((await call(client, 'needs_you'))['count']).toBe(1);

      // Brought back, it is looked for where the record now says it is; the server did not say where it landed.
      await call(client, 'manage_mail', { messageId: '<one@x>', action: 'inbox' });
      expect(mailbox.calls[1]).toMatchObject({ action: 'inbox', hint: { folder: 'Archive', uid: 101, uidValidity: '4' } });
      expect(state.getMail('k1')).toMatchObject({ folder: 'INBOX' });
      expect(state.placeOf('k1')).toBeUndefined();
      // Starring moves nothing, and leaves the record alone.
      await call(client, 'manage_mail', { messageId: '<two@x>', action: 'star' });
      expect(state.getMail('k2')).toMatchObject({ folder: 'INBOX', handledAt: null });
    } finally {
      mailbox.answer = undefined;
    }
  });

  it('records a message that could not be found, and changes nothing', async () => {
    process.env.MAIL_ACCOUNT_1 = 'qq|me@qq.com|pw';
    const state = seeded();
    mailbox.answer = () => undefined;
    try {
      const client = await connect(state, true);
      expect(await client.callTool({ name: 'manage_mail', arguments: { messageId: '<one@x>', action: 'archive' } })).toMatchObject({ isError: true });
      expect(state.getMail('k1')).toMatchObject({ folder: 'INBOX', handledAt: null });
      expect(state.listMailActions(5)[0]).toMatchObject({ action: 'archive', success: false });
    } finally {
      mailbox.answer = undefined;
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
