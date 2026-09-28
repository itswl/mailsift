import { afterEach, describe, expect, it } from 'vitest';
import './setup.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { allowMcpRequest, createServer } from '../src/mcp.js';
import { StateStore } from '../src/services/state.js';
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

async function connect(state: StateStore): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer({ state });
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
      'feedback_rules', 'get_mail', 'health', 'list_accounts', 'list_dead_letters',
      'list_digest', 'list_mail', 'mail_summary', 'observability', 'record_feedback',
      'recovery_status', 'retry_dead_letter', 'search_mail',
    ]);
    for (const tool of tools) expect(tool.description ?? '').not.toBe('');
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

describe('resources', () => {
  it('reads one stored record by Message-ID', async () => {
    const client = await connect(seeded());
    const { contents } = await client.readResource({ uri: 'mailsift://mail/%3Cone%40x%3E' });
    const [first] = contents as Array<{ text: string; mimeType: string }>;
    expect(JSON.parse(first!.text)).toMatchObject({ found: true, messageId: '<one@x>' });
  });

  it('fails a read for a record that does not exist', async () => {
    const client = await connect(seeded());
    await expect(client.readResource({ uri: 'mailsift://mail/%3Cabsent%40x%3E' })).rejects.toThrow();
  });
});

describe('feedback', () => {
  it('records a label and turns a repeated one into a sender rule', async () => {
    const state = seeded();
    const client = await connect(state);
    expect(await call(client, 'feedback_rules')).toMatchObject({ alwaysImportant: [], neverImportant: [] });

    for (const messageId of ['<one@x>', '<two@x>']) {
      expect(await call(client, 'record_feedback', { messageId, label: 'false_positive' }))
        .toMatchObject({ recorded: true });
    }

    expect(await call(client, 'feedback_rules')).toMatchObject({ neverImportant: ['billing@vendor.com'] });
    expect(await call(client, 'observability')).toMatchObject({ feedback: { false_positive: 2 } });
  });

  it('refuses a label outside the accepted set', async () => {
    const client = await connect(seeded());
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
    const client = await connect(state);

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
  });

  it('describes the configured accounts and the recovery backlog', async () => {
    process.env.MAIL_ACCOUNT_1 = 'qq|me@qq.com|pw';
    const client = await connect(seeded());
    expect(await call(client, 'list_accounts')).toMatchObject({ count: 1 });
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
