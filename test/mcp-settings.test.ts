import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './setup.js';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp.js';
import * as imapClient from '../src/imap/client.js';
import { authorizedUsernames } from '../src/imap/auth.js';
import { setSettingsAccounts } from '../src/config.js';
import { StateStore } from '../src/services/state.js';
import {
  adminSessionValid, claimAdmin, closeSettingsStore, issueSetupCode, readSettings, signInAdmin, startAdminSession, updateSettings,
} from '../src/services/settings-store.js';
import { rememberBootState } from '../src/services/settings-runtime.js';
import { onRestartRequested, resetRuntimeControl, setServerMode } from '../src/services/runtime-control.js';

/**
 * The settings API of the page, as tools.
 *
 * Each of these tools is one route of admin-api.ts run in-process, so what is
 * tested here is the join: that a caller is admitted by its credential alone,
 * that what the page is handed to redraw itself with becomes an answer a
 * caller can read, and that a refusal comes back under the codes the other
 * tools use. What each route checks for itself is in test/admin-api.test.ts.
 */
const open: Array<() => Promise<void>> = [];

let dir: string;
let store: StateStore;
/** Each test is its own caller: the settings API keeps its rate limits per client. */
let caller = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailsift-mcp-settings-'));
  process.env.STATE_DB_PATH = join(dir, 'mailsift.db');
  process.env.MAILSIFT_KEY_FILE = join(dir, 'mailsift.key');
  store = new StateStore(':memory:');
  resetRuntimeControl();
  // Set up and running, as the server is once it is used: a save takes effect
  // through a restart, and nothing is written into this process's environment.
  setServerMode('running');
  caller += 1;
});

afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  store.close();
  closeSettingsStore();
  setSettingsAccounts(undefined);
  resetRuntimeControl();
  rmSync(dir, { recursive: true, force: true });
});

function connect(options: { writable?: boolean; admin?: boolean; headers?: IncomingHttpHeaders } = {}): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer({
    state: store, client: `test-${caller}`, writable: options.writable ?? false, admin: options.admin ?? false,
    ...(options.headers ? { headers: options.headers } : {}),
  });
  const client = new Client({ name: 'mcp-test', version: '0.0.0' });
  return Promise.all([server.connect(serverSide), client.connect(clientSide)]).then(async () => {
    open.push(async () => {
      await client.close();
      await server.close();
    });
    return client;
  });
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(first!.text) as Record<string, unknown>;
}

/** A tool's refusal, as the caller reads it: the body's code, message and hint. */
async function refusal(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const answer = await client.callTool({ name, arguments: args });
  expect(answer, name).toMatchObject({ isError: true });
  return JSON.parse((answer.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;
}

/** The administrator password, set as the first-run form sets it. */
function claim(password: string): void {
  expect(claimAdmin(issueSetupCode()!, password)).toBeTruthy();
}

const settingsOf = (answer: Record<string, unknown>): Record<string, Record<string, unknown>> =>
  Object.fromEntries((answer['settings'] as Array<Record<string, unknown>>).map((field) => [field['key'], field]));

const PASSWORD = 'the first password';

describe('the rules that decide mail without a model', () => {
  it('gives them to a writer as the service will run on them, and changes only what is asked', async () => {
    const writer = await connect({ writable: true });
    expect(await call(writer, 'get_triage_rules'))
      .toEqual({ alwaysImportant: [], neverImportant: [], keywords: [], context: '' });

    const saved = await call(writer, 'set_triage_rules', {
      alwaysImportant: ['boss@corp.com', '@vendor.com'], keywords: ['invoice', 'urgent'],
      context: 'The owner is a designer; receipts matter.',
    });
    expect(saved).toMatchObject({
      saved: true,
      rules: {
        alwaysImportant: ['boss@corp.com', '@vendor.com'], neverImportant: [], keywords: ['invoice', 'urgent'],
        context: 'The owner is a designer; receipts matter.',
      },
    });
    // Stored as the page stores a list: one setting, separated by commas, which the service reads as it is.
    expect(readSettings().values).toMatchObject({ MAIL_ALWAYS_IMPORTANT: 'boss@corp.com,@vendor.com', MAIL_KEYWORDS: 'invoice,urgent' });

    // A rule left out keeps what is stored.
    const one = await call(writer, 'set_triage_rules', { neverImportant: ['newsletter@lists.example'] });
    expect(one['rules']).toMatchObject({
      alwaysImportant: ['boss@corp.com', '@vendor.com'], keywords: ['invoice', 'urgent'], neverImportant: ['newsletter@lists.example'],
    });
    // An empty list, or empty text, is the default again, which is nothing.
    const cleared = await call(writer, 'set_triage_rules', { alwaysImportant: [], context: '' });
    expect(cleared['rules']).toMatchObject({ alwaysImportant: [], context: '', keywords: ['invoice', 'urgent'], neverImportant: ['newsletter@lists.example'] });
    expect(readSettings().values['MAIL_ALWAYS_IMPORTANT']).toBeUndefined();
    // Until one is stored, what the environment gave is what the service runs on.
    process.env.MAIL_CONTEXT = 'From the environment.';
    expect(await call(writer, 'get_triage_rules')).toMatchObject({ context: 'From the environment.' });
  });

  it('saves no rule unless every one given passes, and no other setting at all', async () => {
    const writer = await connect({ writable: true });
    // A list longer than its setting takes refuses the lot, the good rule beside it too.
    const tooLong = await refusal(writer, 'set_triage_rules', {
      alwaysImportant: ['ceo@corp.com'], keywords: Array.from({ length: 21 }, () => 'k'.repeat(200)),
    });
    expect(tooLong).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(String(tooLong['message'])).toContain('MAIL_KEYWORDS');
    expect(readSettings().values).toEqual({});
    // Nothing to change is not a change.
    expect(await refusal(writer, 'set_triage_rules', {})).toMatchObject({ code: 'INVALID_ARGUMENT' });
    // The four rules are all this credential reaches: another setting, named here, names no rule.
    expect(await refusal(writer, 'set_triage_rules', { LLM_MODEL: 'some-model' })).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(readSettings().values).toEqual({});
  });

  it('says how a change takes effect, as the page does: now, by a restart that is coming, or by one due by hand', async () => {
    const writer = await connect({ writable: true });
    // Nothing restarts this server by itself.
    rememberBootState(readSettings(), authorizedUsernames());
    const manual = await call(writer, 'set_triage_rules', { keywords: ['invoice'] });
    expect(manual).toMatchObject({ applied: 'manual' });
    expect(String(manual['restart'])).toContain('restarted by hand');

    // Saving what is stored already asks for no second restart, and does not hide that the first is still due.
    rememberBootState(readSettings(), authorizedUsernames());
    const again = await call(writer, 'set_triage_rules', { keywords: ['invoice'] });
    expect(again).toMatchObject({ applied: 'none' });
    expect(again['restart']).toBe('In effect now. An earlier change still waits for mailsift to be restarted by hand.');

    // Under a supervisor the restart is coming, and it carries the earlier change with it.
    process.env.MAILSIFT_SUPERVISED = '1';
    onRestartRequested(() => undefined);
    const scheduled = await call(writer, 'set_triage_rules', { context: 'The owner is a designer.' });
    expect(scheduled).toMatchObject({ applied: 'scheduled' });
    expect(scheduled['restart']).toBe(
      'The server restarts in a moment to put the change into effect; until then it still runs on the old settings.',
    );

    // While the server is still being set up nothing runs on the old values, so a save is in effect at once.
    resetRuntimeControl();
    setServerMode('setup');
    const now = await call(writer, 'set_triage_rules', { keywords: ['receipt'] });
    expect(now).toMatchObject({ applied: 'none' });
    expect(now['restart']).toBe('In effect now.');
  });
});

describe('the administrator’s tools', () => {
  it('are reached by the token alone: nothing else is asked of the caller, and the page’s whole state is never handed over', async () => {
    // No password is set and no browser is signed in: an administrator who issued the token is not made to sign in again.
    expect(readSettings().setupCompletedAt).toBeUndefined();
    const holder = await connect({ admin: true });
    const all = await call(holder, 'get_settings');
    expect(all).toMatchObject({
      mode: 'running', setupComplete: false, restart: { pending: false, manual: false }, supervised: false,
      tokens: { read: false, write: false, admin: false }, oauthApps: { gmail: false, outlook: false },
    });
    expect(typeof all['timeZone']).toBe('string');
    // The page's copies of the values, and where the request came from, are the page's business.
    for (const key of ['values', 'secrets', 'channel']) expect(all).not.toHaveProperty(key);
  });

  it('lists every setting with its meaning, its limits and its value, and a secret only as set', async () => {
    const holder = await connect({ admin: true });
    const fields = settingsOf(await call(holder, 'get_settings'));
    expect(fields['DIGEST_HOUR']).toMatchObject({
      key: 'DIGEST_HOUR', section: 'schedule', type: 'number', label: 'Digest hour (0–23)', value: '', default: '9', min: 0, max: 23,
    });
    expect(fields['LLM_PROVIDER']).toMatchObject({
      type: 'select', value: '', default: 'deepseek',
      options: ['deepseek', 'openai', 'openrouter', 'dashscope', 'moonshot', 'glm', 'zhipu', 'minimax', 'siliconflow', 'xai', 'custom'],
    });
    expect(fields['MAIL_CONTEXT']).toMatchObject({ section: 'triage', type: 'textarea', maxLength: 4000 });
    expect(fields['MAIL_CONTEXT']).not.toHaveProperty('advanced');
    // A secret is never given back, only whether one is stored; the words of the page are English here, whoever asks.
    expect(fields['LLM_API_KEY']).toMatchObject({ type: 'secret', label: 'API key', set: false });
    expect(fields['LLM_API_KEY']).not.toHaveProperty('value');
    // The tokens are replaced one at a time by rotate_token, and are not among the settings.
    for (const key of ['MCP_TOKEN', 'MCP_WRITE_TOKEN', 'MCP_ADMIN_TOKEN']) expect(fields[key]).toBeUndefined();

    await call(holder, 'update_settings', { values: { LLM_API_KEY: 'sk-secret-123', DIGEST_HOUR: '8' } });
    const after = await call(holder, 'get_settings');
    const stored = settingsOf(after);
    expect(stored['LLM_API_KEY']).toMatchObject({ set: true });
    expect(stored['DIGEST_HOUR']).toMatchObject({ value: '8' });
    expect(JSON.stringify(after)).not.toContain('sk-secret-123');
  });

  it('asks for some of the settings by key, and says which key is none', async () => {
    const holder = await connect({ admin: true });
    const some = await call(holder, 'get_settings', { keys: ['DIGEST_HOUR', 'NOPE', 'SMTP_ENABLED'] });
    expect((some['settings'] as unknown[]).map((field) => (field as { key: string }).key)).toEqual(['DIGEST_HOUR', 'SMTP_ENABLED']);
    expect(some['unknown']).toEqual(['NOPE']);
    // The rest of the answer is the same as it is without keys.
    expect(some).toMatchObject({ mode: 'running', tokens: { read: false, write: false, admin: false } });
  });

  it('saves settings as the page does, all of a save or none of it, and says how the change takes effect', async () => {
    const holder = await connect({ admin: true });
    const saved = await call(holder, 'update_settings', { values: { DIGEST_HOUR: '9', LLM_API_KEY: 'sk-secret-123' } });
    expect(saved).toMatchObject({ saved: true, applied: 'manual' });
    expect(String(saved['restart'])).toContain('restarted by hand');
    expect(saved).not.toHaveProperty('state');
    expect(readSettings().values).toMatchObject({ DIGEST_HOUR: '9', LLM_API_KEY: 'sk-secret-123' });

    // One value that does not pass refuses the save, and each problem is named.
    const refused = await refusal(holder, 'update_settings', { values: { DIGEST_HOUR: '25', LLM_MODEL: 'x'.repeat(201), NOT_A_KEY: 'x' } });
    expect(refused).toMatchObject({ code: 'INVALID_ARGUMENT' });
    for (const key of ['DIGEST_HOUR', 'LLM_MODEL', 'NOT_A_KEY']) expect(String(refused['message'])).toContain(key);
    expect(readSettings().values['LLM_MODEL']).toBeUndefined();

    // An empty string leaves a secret as it is and restores the default of anything else; null removes what is stored.
    await call(holder, 'update_settings', { values: { LLM_API_KEY: '', DIGEST_HOUR: '' } });
    expect(readSettings().values['LLM_API_KEY']).toBe('sk-secret-123');
    expect(readSettings().values['DIGEST_HOUR']).toBeUndefined();
    await call(holder, 'update_settings', { values: { LLM_API_KEY: null } });
    expect(readSettings().values['LLM_API_KEY']).toBeUndefined();

    // Nothing to save is refused, and so is a save too large for the page to read whole.
    expect(await refusal(holder, 'update_settings', { values: {} })).toMatchObject({ code: 'INVALID_ARGUMENT' });
    const many = Object.fromEntries(Array.from({ length: 201 }, (_, n) => [`K${n}`, 'x']));
    expect(await refusal(holder, 'update_settings', { values: many })).toMatchObject({ code: 'INVALID_ARGUMENT' });
    // The API tokens are not settings: one is replaced by rotate_token alone.
    expect(await refusal(holder, 'update_settings', { values: { MCP_ADMIN_TOKEN: 'ms_mine' } })).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(readSettings().values['MCP_ADMIN_TOKEN']).toBeUndefined();
  });

  it('adds, changes, tries and removes a mailbox, changing only the fields given', async () => {
    const holder = await connect({ admin: true });
    const added = await call(holder, 'manage_mailbox', {
      action: 'save', mailbox: { provider: 'qq', username: 'Me@QQ.com', password: 'p|w', name: 'Personal', folders: ['all'] },
    });
    expect(added).toMatchObject({ saved: true, applied: 'manual' });
    expect(added['mailbox']).toMatchObject({ username: 'me@qq.com', hasPassword: true, readiness: 'ready', name: 'Personal', folders: ['all'], enabled: true });
    // The password goes in, and is in no answer.
    expect(JSON.stringify(added)).not.toContain('p|w');
    const id = String((added['mailbox'] as Record<string, unknown>)['id']);

    // A change touches the fields given only: the rest goes back as stored, the password and the folders included.
    await call(holder, 'manage_mailbox', { action: 'save', id, mailbox: { enabled: false } });
    const changed = await call(holder, 'manage_mailbox', { action: 'save', id, mailbox: { name: 'Work', password: '' } });
    expect(readSettings().mailboxes).toHaveLength(1);
    expect(readSettings().mailboxes[0]).toMatchObject({ id, provider: 'qq', username: 'me@qq.com', name: 'Work', password: 'p|w', folders: ['all'], enabled: false });
    expect(changed['mailbox']).toMatchObject({ name: 'Work', enabled: false });

    // Empty text clears a field, and a null port goes back to the provider's own.
    await call(holder, 'manage_mailbox', { action: 'save', id, mailbox: { name: '', port: null, smtpPort: null } });
    const listed = ((await call(holder, 'get_settings'))['mailboxes'] as Array<Record<string, unknown>>)[0]!;
    expect(listed).toMatchObject({ id, name: '', port: null, smtpPort: null, folders: ['all'] });

    // What is not a mailbox is refused in the page's words, and nothing is stored.
    const invalid = await refusal(holder, 'manage_mailbox', { action: 'save', mailbox: { provider: 'imap', username: 'me@corp.example', password: 'x' } });
    expect(invalid).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(String(invalid['message'])).toContain('invalid_mailbox');
    expect(readSettings().mailboxes).toHaveLength(1);

    const removed = await call(holder, 'manage_mailbox', { action: 'delete', id });
    expect(removed).toMatchObject({ deleted: true, applied: 'manual' });
    expect(readSettings().mailboxes).toEqual([]);
  });

  it('tries a mailbox against the real one, and says a failure to connect as the test’s own answer', async () => {
    const folders = vi.spyOn(imapClient, 'discoverMailboxFolders');
    const holder = await connect({ admin: true });
    const id = String(((await call(holder, 'manage_mailbox', {
      action: 'save', mailbox: { provider: 'qq', username: 'me@qq.com', password: 'pw' },
    }))['mailbox'] as Record<string, unknown>)['id']);

    folders.mockResolvedValue([
      { path: 'INBOX', name: 'INBOX', delimiter: '/', flags: [], specialUse: '\\Inbox', specialUseSource: null, selectable: true, subscribed: true },
      { path: 'Notes', name: 'Notes', delimiter: '/', flags: ['\\NoSelect'], specialUse: null, specialUseSource: null, selectable: false, subscribed: true },
    ]);
    // A stored one by its id, and one not saved yet by its fields; the account it was tried with is the stored one.
    expect(await call(holder, 'manage_mailbox', { action: 'test', id })).toEqual({
      connected: true, folders: [{ path: 'INBOX', specialUse: '\\Inbox' }],
    });
    expect(folders.mock.calls.at(-1)![0]).toMatchObject({ username: 'me@qq.com', password: 'pw' });
    await call(holder, 'manage_mailbox', { action: 'test', mailbox: { provider: 'qq', username: 'other@qq.com', password: 'x' } });
    expect(folders.mock.calls.at(-1)![0]).toMatchObject({ username: 'other@qq.com' });
    // Nothing tried was saved by the test.
    expect(readSettings().mailboxes).toHaveLength(1);

    // A mailbox that cannot be reached is the test's answer, as it is for the page, not a failed call.
    folders.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const down = await call(holder, 'manage_mailbox', { action: 'test', id });
    expect(down).toMatchObject({ connected: false });
    expect(String(down['message'])).toContain('Could not reach the server');
    // A form that is not a mailbox is refused before anything is tried.
    expect(await refusal(holder, 'manage_mailbox', { action: 'test', mailbox: { provider: 'imap', username: 'me@corp.example' } }))
      .toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('names a mailbox nothing is stored about as not found, and an action that names none as a wrong argument', async () => {
    const holder = await connect({ admin: true });
    for (const args of [
      { action: 'save', id: 'not-a-mailbox', mailbox: { name: 'x' } },
      { action: 'test', id: 'not-a-mailbox' },
      { action: 'delete', id: 'not-a-mailbox' },
      { action: 'start_sign_in', id: 'not-a-mailbox' },
    ]) {
      expect(await refusal(holder, 'manage_mailbox', args), JSON.stringify(args)).toMatchObject({ code: 'NOT_FOUND' });
    }
    for (const args of [{ action: 'save' }, { action: 'test' }, { action: 'delete' }, { action: 'start_sign_in' }, { action: 'finish_sign_in' }]) {
      expect(await refusal(holder, 'manage_mailbox', args), JSON.stringify(args)).toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
  });

  it('starts a mailbox’s OAuth sign-in from where the server was reached, and finishes it with the address the owner was sent to', async () => {
    // Reached at a loopback address: the provider sends the browser straight back, and the server finishes it.
    const local = await connect({ admin: true, headers: { host: '127.0.0.1:8410' } });
    const id = await gmailMailbox(local);
    const direct = await call(local, 'manage_mailbox', { action: 'start_sign_in', id });
    expect(direct).toMatchObject({ mode: 'direct' });
    // The state is in the URL and in the way back, which are the server's to check: neither is given out.
    expect(direct).not.toHaveProperty('state');
    expect(direct).not.toHaveProperty('redirectUri');
    expect(new URL(String(direct['url'])).origin).toBe('https://accounts.google.com');
    expect(String(direct['next'])).toContain('nothing is left to call');

    // Reached through a proxy by its name: the browser lands on an address that loads nothing, which is pasted back.
    const remote = await connect({ admin: true, headers: { host: 'mail.example.com', 'x-forwarded-proto': 'https' } });
    const pasted = await call(remote, 'manage_mailbox', { action: 'start_sign_in', id });
    expect(pasted).toMatchObject({ mode: 'paste' });
    expect(String(pasted['next'])).toContain('finish_sign_in');
    const state = new URL(String(pasted['url'])).searchParams.get('state')!;

    // An address that was not started here, or that carries a refusal, changes nothing; each is said in its own words.
    const forged = await refusal(remote, 'manage_mailbox', { action: 'finish_sign_in', url: 'http://localhost:8765/?state=forged&code=x' });
    expect(forged).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(String(forged['message'])).toContain('expired');
    const declined = await refusal(remote, 'manage_mailbox', {
      action: 'finish_sign_in', url: `http://localhost:8765/?state=${state}&error=access_denied`,
    });
    expect(declined).toMatchObject({ code: 'ACTION_REFUSED' });
    expect(authorizedUsernames()).toEqual(new Set());

    // Started again, and the provider does not hand over a token.
    const again = new URL(String((await call(remote, 'manage_mailbox', { action: 'start_sign_in', id }))['url'])).searchParams.get('state')!;
    const exchange = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status: 500 }));
    const failed = await refusal(remote, 'manage_mailbox', {
      action: 'finish_sign_in', url: `http://localhost:8765/?state=${again}&code=abc`,
    });
    expect(failed).toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(String(failed['message'])).toContain('exchange_failed');
    expect(authorizedUsernames()).toEqual(new Set());

    // The provider hands one over: the mailbox is ready, and the answer is the page's without the page's state.
    const last = new URL(String((await call(remote, 'manage_mailbox', { action: 'start_sign_in', id }))['url'])).searchParams.get('state')!;
    exchange.mockResolvedValue(new Response(
      JSON.stringify({ access_token: 'ya29.access', refresh_token: '1//refresh', expires_in: 3600 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const done = await call(remote, 'manage_mailbox', { action: 'finish_sign_in', url: `http://localhost:8765/?state=${last}&code=abc` });
    expect(done).toMatchObject({ authorized: true, mailbox: id, applied: 'manual' });
    expect(done).not.toHaveProperty('state');
    expect(String(exchange.mock.calls[0]![0])).toContain('oauth2.googleapis.com/token');
    expect(authorizedUsernames()).toEqual(new Set(['me@gmail.com']));
    // Each sign-in is good once.
    expect(await refusal(remote, 'manage_mailbox', {
      action: 'finish_sign_in', url: `http://localhost:8765/?state=${last}&code=abc`,
    })).toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('sends a test notification, and says whether it was delivered in the channel’s own words', async () => {
    const holder = await connect({ admin: true });
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    // Nothing to send to: said, not thrown.
    const nowhere = await call(holder, 'test_notifications');
    expect(nowhere).toMatchObject({ delivered: false });
    expect(String(nowhere['message'])).toContain('Add a Feishu bot or a webhook first');

    // Settings to try before they are saved; nothing of them is stored by the test.
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const webhook = { values: { WEBHOOK_URL: 'https://hooks.example.com/mailsift', WEBHOOK_TOKEN: 'a-token' } };
    expect(await call(holder, 'test_notifications', webhook)).toEqual({ delivered: true, message: 'Delivered to Webhook.' });
    expect(String(fetchMock.mock.calls.at(-1)![0])).toBe('https://hooks.example.com/mailsift');
    expect(readSettings().values['WEBHOOK_URL']).toBeUndefined();

    fetchMock.mockResolvedValue(new Response('', { status: 500 }));
    const failed = await call(holder, 'test_notifications', webhook);
    expect(failed).toMatchObject({ delivered: false });
    expect(String(failed['message'])).toContain('HTTP 500');
    // A value that is no setting is refused as a wrong argument, before anything is sent.
    expect(await refusal(holder, 'test_notifications', { values: { WEBHOOK_URL: 'not an address' } })).toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('asks the model once, and says whether it answered', async () => {
    const holder = await connect({ admin: true });
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    // With no key stored there is nothing to ask with.
    const noKey = await call(holder, 'test_model');
    expect(noKey).toMatchObject({ ok: false });
    expect(String(noKey['message'])).toContain('Enter an API key first');

    const values = { values: { LLM_API_KEY: 'sk-test-key', LLM_MODEL: 'some-model', LLM_BASE_URL: 'https://llm.example.com/v1' } };
    fetchMock.mockResolvedValue(new Response('no', { status: 401 }));
    const rejected = await call(holder, 'test_model', values);
    expect(rejected).toMatchObject({ ok: false });
    expect(String(rejected['message'])).toContain('HTTP 401');
    // The key is never repeated in what is said of a failure.
    expect(JSON.stringify(rejected)).not.toContain('sk-test-key');

    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const answered = await call(holder, 'test_model', values);
    expect(answered).toMatchObject({ ok: true });
    expect(String(answered['message'])).toMatch(/answered in \d+ ms/);
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(String(url)).toBe('https://llm.example.com/v1/chat/completions');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer sk-test-key' });
    expect(readSettings().values['LLM_API_KEY']).toBeUndefined();
  });

  it('replaces any of the three tokens, and gives the new one once', async () => {
    const holder = await connect({ admin: true });
    const issued: Record<string, string> = {};
    for (const kind of ['read', 'write', 'admin']) {
      const answer = await call(holder, 'rotate_token', { kind });
      expect(answer).toMatchObject({ kind, applied: 'manual' });
      expect(answer).not.toHaveProperty('state');
      issued[kind] = String(answer['token']);
      expect(issued[kind]).toMatch(/^ms_/);
    }
    // Each is its own value, and each is what is stored under its own key.
    expect(new Set(Object.values(issued)).size).toBe(3);
    expect(readSettings().values).toMatchObject({ MCP_TOKEN: issued['read'], MCP_WRITE_TOKEN: issued['write'], MCP_ADMIN_TOKEN: issued['admin'] });
    expect((await call(holder, 'get_settings'))['tokens']).toEqual({ read: true, write: true, admin: true });
    // A kind that is not one of the three is a wrong argument, and replaces nothing.
    expect(await refusal(holder, 'rotate_token', { kind: 'root' })).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(Object.keys(readSettings().values)).toHaveLength(3);
  });

  it('changes the administrator password only with the current one, as the page asks for it', async () => {
    claim(PASSWORD);
    const holder = await connect({ admin: true });
    // A leaked token does not lock its owner out: the current password is still needed.
    const wrong = await refusal(holder, 'change_admin_password', { current: 'not the password', next: 'the second password' });
    expect(wrong).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(String(wrong['message'])).toContain('not_accepted');
    expect(String(wrong['hint'])).toContain('Ask the owner for it');
    expect(await refusal(holder, 'change_admin_password', { current: PASSWORD, next: 'short' })).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(signInAdmin(PASSWORD)).toBeTruthy();

    // Every session of the page is ended by the change; the tokens are as they were.
    const browser = startAdminSession();
    await call(holder, 'rotate_token', { kind: 'admin' });
    expect(await call(holder, 'change_admin_password', { current: PASSWORD, next: 'the second password' }))
      .toMatchObject({ changed: true });
    expect(adminSessionValid(browser)).toBe(false);
    expect(signInAdmin(PASSWORD)).toBeUndefined();
    expect(signInAdmin('the second password')).toBeTruthy();
    expect(readSettings().values['MCP_ADMIN_TOKEN']).toMatch(/^ms_/);
  });

  it('signs out every browser session of the page', async () => {
    claim(PASSWORD);
    const holder = await connect({ admin: true });
    const one = startAdminSession();
    const two = startAdminSession();
    // The caller holding the token keeps no session, so every one there is belongs to a browser: the two here, and the
    // one the claim form opened.
    expect(await call(holder, 'end_other_sessions')).toEqual({ ended: 3 });
    expect(adminSessionValid(one)).toBe(false);
    expect(adminSessionValid(two)).toBe(false);
    expect(await call(holder, 'end_other_sessions')).toEqual({ ended: 0 });
    // Signing in again is as it was.
    expect(signInAdmin(PASSWORD)).toBeTruthy();
  });

  it('puts on record which setting, token and mailbox a call was about, and never a value', async () => {
    const holder = await connect({ admin: true });
    await call(holder, 'update_settings', { values: { LLM_API_KEY: 'sk-secret-123', DIGEST_HOUR: '8' } });
    await call(holder, 'rotate_token', { kind: 'admin' });
    const added = await call(holder, 'manage_mailbox', { action: 'save', mailbox: { provider: 'qq', username: 'me@qq.com', password: 'p|w' } });
    const id = String((added['mailbox'] as Record<string, unknown>)['id']);
    await call(holder, 'manage_mailbox', { action: 'save', id, mailbox: { name: 'Work', password: 'another|one' } });
    const targets = (action: string): Array<Record<string, string>> => store.listMcpAudit(20)
      .filter((row) => row.action === action).map((row) => JSON.parse(row.target ?? '{}') as Record<string, string>);
    expect(targets('update_settings')).toEqual([{ settings: 'LLM_API_KEY,DIGEST_HOUR' }]);
    expect(targets('rotate_token')).toEqual([{ kind: 'admin' }]);
    // Newest first, as list_audit gives them.
    expect(targets('manage_mailbox')).toEqual([{ action: 'save', id }, { action: 'save' }]);
    // A value may be a secret, a password or a token: none of them is written down.
    const written = JSON.stringify(store.listMcpAudit(50));
    for (const secret of ['sk-secret-123', 'p|w', 'another|one', readSettings().values['MCP_ADMIN_TOKEN']!]) {
      expect(written, 'a value in the audit').not.toContain(secret);
    }
  });
});

/** A Gmail mailbox that signs in with OAuth, saved as the page saves one. */
async function gmailMailbox(client: Client): Promise<string> {
  await call(client, 'update_settings', {
    values: { GMAIL_CLIENT_ID: 'client.apps.googleusercontent.com', GMAIL_CLIENT_SECRET: 'GOCSPX-x' },
  });
  const saved = await call(client, 'manage_mailbox', { action: 'save', mailbox: { provider: 'gmail', username: 'me@gmail.com' } });
  expect(saved['mailbox']).toMatchObject({ readiness: 'needs-authorization', hasPassword: false });
  return String((saved['mailbox'] as Record<string, unknown>)['id']);
}
