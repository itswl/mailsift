import { beforeEach, describe, expect, it, vi } from 'vitest';
import './setup.js';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { MailActionError, type LiveMessage } from '../src/imap/client.js';
import { MailboxUnreachableError } from '../src/imap/connection.js';
import type { ReadableMessage } from '../src/imap/readable.js';
import { AssistantError } from '../src/services/assistant.js';
import { StateStore } from '../src/services/state.js';
import { SendError, type OutgoingMail, type SentMail } from '../src/smtp.js';
import { forgetLive, forgetSends, resetAssistantBudget, type WebBackend } from '../src/web-actions.js';
import { credentialMark, localHost, secretEquals, tokenMatches } from '../src/web-http.js';
import { liveHub } from '../src/web-live.js';
import { routeWeb, SESSION_COOKIE, type WebResponse } from '../src/web.js';

const READ = 'read-token';
const WRITE = 'write-token';

function request(options: {
  method?: string; url?: string; headers?: Record<string, string>; body?: unknown; as?: 'read' | 'write' | 'none';
} = {}): IncomingMessage {
  const payload = options.body === undefined ? '' : typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  const stream = Readable.from(payload ? [Buffer.from(payload)] : []);
  const as = options.as ?? 'write';
  const cookie = as === 'none' ? {} : { cookie: `${SESSION_COOKIE}=${as === 'write' ? WRITE : READ}` };
  return Object.assign(stream, {
    method: options.method ?? 'GET',
    url: options.url ?? '/',
    headers: { ...cookie, ...(options.headers ?? {}) },
  }) as unknown as IncomingMessage;
}

function seeded(): StateStore {
  const state = new StateStore(':memory:');
  const rows: Array<[string, string, string, boolean, boolean]> = [
    ['k1', '<one@x>', 'critical', true, false],
    ['k2', '<two@x>', 'info', false, true],
    ['k3', '<three@x>', 'warning', true, false],
  ];
  for (const [key, messageId, importance, pushed, inSpam] of rows) {
    state.markSeen(key, 'me@qq.com', `subject ${key}`);
    state.recordOutcome(key, importance, pushed, {
      messageId, category: 'Finance', inSpam, sender: 'billing@vendor.com', senderName: 'Vendor',
      summary: `summary of ${key}`, reason: 'because', snippet: 'body text', folder: inSpam ? 'Junk' : 'INBOX',
    });
  }
  return state;
}

function readable(partial: Partial<ReadableMessage> = {}): ReadableMessage {
  return {
    html: '<p>Hello</p>', htmlOmitted: false, text: 'Hello', quoted: '', truncated: false,
    from: { name: 'Vendor', address: 'billing@vendor.com' }, to: [{ name: '', address: 'me@qq.com' }],
    cc: [{ name: 'Ann', address: 'ann@vendor.com' }], replyTo: [], subject: 'subject k1', date: '2026-11-10T08:00:00.000Z',
    messageId: '<one@x>', inReplyTo: null, references: ['<root@x>'],
    auth: { result: 'pass', dkim: 'pass', spf: 'pass', dmarc: 'pass', signedBy: 'vendor.com' },
    unsubscribe: null, inlineImages: 0, ...partial,
  };
}

interface Calls {
  read: string[];
  /** What each read and each action was told about where the message is. */
  readHints: unknown[];
  actHints: unknown[];
  act: Array<{ messageId: string; action: string; folderHint?: string }>;
  sent: OutgoingMail[];
  appended: number;
  asked: string[];
  drafted: Array<{ text: string; instruction?: string }>;
}

function backend(overrides: Partial<WebBackend> = {}): { calls: Calls; backend: Partial<WebBackend> } {
  const calls: Calls = { read: [], readHints: [], actHints: [], act: [], sent: [], appended: 0, asked: [], drafted: [] };
  const live: LiveMessage = { readable: readable(), folder: 'INBOX', flags: { seen: false, flagged: false, answered: false } };
  return {
    calls,
    backend: {
      read: async (_account, messageId, hint) => { calls.read.push(messageId); calls.readHints.push(hint); return live; },
      act: async (account, messageId, action, options) => {
        calls.act.push({ messageId, action, ...(options?.folderHint ? { folderHint: options.folderHint } : {}) });
        calls.actHints.push(options?.hint);
        const moved = action === 'archive' ? 'Archive' : action === 'trash' ? 'Trash' : action === 'inbox' ? 'INBOX' : undefined;
        return { action, account: account.username, messageId, sourceFolder: 'INBOX', ...(moved ? { destinationFolder: moved, destinationIsSpam: false } : {}) };
      },
      send: async (_account, mail) => {
        calls.sent.push(mail);
        return { messageId: '<sent@x>', raw: Buffer.from('raw'), copy: Buffer.from('Bcc: kept\r\nraw'), accepted: mail.to, rejected: [] };
      },
      appendSent: async () => { calls.appended += 1; return 'Sent'; },
      savesSentCopy: () => true,
      sending: () => ({ available: true }),
      assistant: () => true,
      ask: async (_store, question) => {
        calls.asked.push(question);
        return { answer: 'One thing [1].', citations: [{ n: 1, key: 'k1' }], considered: 3 };
      },
      draft: async (input) => {
        calls.drafted.push({ text: input.text, ...(input.instruction ? { instruction: input.instruction } : {}) });
        return { draft: 'Thanks, will do.' };
      },
      testPush: async () => 'sent',
      ...overrides,
    },
  };
}

const url = (path: string): URL => new URL(path, 'http://127.0.0.1:8410');

let clientSeq = 0;
/** Each call gets its own client name, so one test's rate budget never reaches another. */
async function call(
  store: StateStore, path: string, options: Parameters<typeof request>[0] = {}, fake = backend(), client?: string,
): Promise<{ answer: WebResponse; json: Record<string, unknown> }> {
  clientSeq += 1;
  // Work that outlasts a request opens a handle of its own. Here that is the
  // same in-memory database, behind a view whose close() closes nothing.
  const late = (): StateStore => Object.create(store, { close: { value: () => undefined } }) as StateStore;
  const answer = await routeWeb(
    request({ ...options, url: path }), url(path), READ, store, client ?? `client-${clientSeq}`,
    { writeToken: WRITE, backend: { openStore: late, ...fake.backend } },
  );
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(String(answer.body)) as Record<string, unknown>; } catch { /* not JSON */ }
  return { answer, json };
}
const post = (store: StateStore, path: string, body: unknown, options: Parameters<typeof request>[0] = {}, fake = backend(), client?: string) =>
  call(store, path, { method: 'POST', body, ...options }, fake, client);

beforeEach(() => {
  forgetLive();
  forgetSends();
  resetAssistantBudget();
  delete process.env.WEB_ASSISTANT_DAILY_LIMIT;
  delete process.env.MCP_ALLOWED_HOSTS;
  process.env.MAIL_ACCOUNT_1 = 'qq|me@qq.com|pw';
  process.env.MAIL_ACCOUNT_1_NAME = 'personal';
});

describe('what a session may do', () => {
  it('lets either token sign in, and tells the page which kind of session it got', async () => {
    const store = seeded();
    for (const [token, writable] of [[READ, false], [WRITE, true]] as const) {
      const signIn = await routeWeb(
        request({ method: 'POST', url: '/auth', body: `token=${token}`, as: 'none' }), url('/auth'), READ, store, `signin-${token}`,
        { writeToken: WRITE },
      );
      expect(signIn.status).toBe(303);
      expect(signIn.cookie).toContain(`${SESSION_COOKIE}=${token}`);
      const summary = await call(store, '/api/summary', { as: writable ? 'write' : 'read' });
      expect(summary.json['session']).toMatchObject({ writable, writeConfigured: true, auth: true });
    }
    const refused = await routeWeb(
      request({ method: 'POST', url: '/auth', body: 'token=neither', as: 'none' }), url('/auth'), READ, store, 'signin-wrong',
      { writeToken: WRITE },
    );
    expect(refused.status).toBe(401);
  });

  it('never treats an empty write token as a credential', async () => {
    // With no write token configured nothing may write, whatever is presented.
    const store = seeded();
    const answer = await routeWeb(
      request({ method: 'POST', url: '/api/action', body: { key: 'k1', action: 'archive' }, headers: { cookie: `${SESSION_COOKIE}=${READ}` } }),
      url('/api/action'), READ, store, 'no-write', { backend: backend().backend },
    );
    expect(answer.status).toBe(403);
    expect(JSON.parse(String(answer.body))).toMatchObject({ code: 'readOnly' });
  });

  it('keeps the read token away from everything that changes a mailbox, sends mail or teaches triage', async () => {
    const store = seeded();
    const fake = backend();
    for (const [path, body] of [
      ['/api/action', { key: 'k1', action: 'archive' }],
      ['/api/feedback', { key: 'k1', label: 'false_positive' }],
      ['/api/send', { account: 'me@qq.com', to: ['a@b.co'], subject: 's', text: 't' }],
      ['/api/draft', { key: 'k1', instruction: 'say yes' }],
    ] as const) {
      const { answer, json } = await post(store, path, body, { as: 'read' }, fake);
      expect(answer.status, path).toBe(403);
      expect(json['code'], path).toBe('readOnly');
    }
    expect(fake.calls.act).toHaveLength(0);
    expect(fake.calls.sent).toHaveLength(0);
    expect(fake.calls.drafted).toHaveLength(0);
    expect(store.feedbackSummary()).toEqual({});
  });

  it('refuses a POST another site started, whatever cookie came with it', async () => {
    const store = seeded();
    const fake = backend();
    const crossSite = await post(store, '/api/handled', { key: 'k1' }, { headers: { 'sec-fetch-site': 'cross-site' } }, fake);
    expect(crossSite.answer.status).toBe(403);
    expect(crossSite.json['code']).toBe('crossSite');
    const foreignOrigin = await post(store, '/api/handled', { key: 'k1' }, { headers: { origin: 'https://evil.example', host: 'mail.example' } }, fake);
    expect(foreignOrigin.answer.status).toBe(403);
    expect(store.getMail('k1')?.handledAt).toBeNull();
    const sameOrigin = await post(store, '/api/handled', { key: 'k1' }, { headers: { 'sec-fetch-site': 'same-origin' } }, fake);
    expect(sameOrigin.answer.status).toBe(200);
  });

  it('does not sign a browser in from another site’s form', async () => {
    // Otherwise a page elsewhere could swap a write session for a read one.
    const store = seeded();
    const answer = await routeWeb(
      request({ method: 'POST', url: '/auth', body: `token=${READ}`, as: 'none', headers: { 'sec-fetch-site': 'cross-site' } }),
      url('/auth'), READ, store, 'signin-cross', { writeToken: WRITE },
    );
    expect(answer.status).toBe(403);
    expect(answer.cookie).toBeUndefined();
  });

  it('compares tokens without ever throwing, whatever bytes are presented', () => {
    // Same length as a string, different length as bytes: this used to throw.
    expect(tokenMatches('abcd', 'ab\u00e9d')).toBe(false);
    expect(secretEquals('abcd', 'ab\u00e9d')).toBe(false);
    expect(secretEquals('s\u00e9cret', 's\u00e9cret')).toBe(true);
    expect(tokenMatches('token', 'token')).toBe(true);
    expect(tokenMatches('token', 'tokeN')).toBe(false);
    expect(tokenMatches('token', '')).toBe(false);
    expect(secretEquals('', '')).toBe(true);
  });

  it('answers only to this machine’s names while no token is set', async () => {
    const store = seeded();
    const open = (host: string | undefined, path = '/api/summary'): Promise<WebResponse> => routeWeb(
      request({ url: path, as: 'none', ...(host ? { headers: { host } } : {}) }), url(path), '', store, 'rebind', { backend: backend().backend },
    );
    for (const host of ['localhost:8410', '127.0.0.1:8410', '127.0.0.1', '[::1]:8410', 'mail.localhost', undefined]) {
      expect((await open(host)).status, String(host)).toBe(200);
    }
    // A page on another site that pointed its own name at 127.0.0.1.
    for (const host of ['evil.example', 'evil.example:8410', '127.0.0.1.evil.example', 'localhost.evil.example', '192.168.1.5:8410']) {
      const answer = await open(host);
      expect(answer.status, host).toBe(421);
      expect(String(answer.body), host).not.toContain('subject');
      expect((await open(host, '/')).status, host).toBe(421);
    }
    process.env.MCP_ALLOWED_HOSTS = 'mail.example.org, other.example';
    expect((await open('mail.example.org')).status).toBe(200);
    expect((await open('Mail.Example.org:443')).status).toBe(200);
    expect((await open('evil.example')).status).toBe(421);
    expect(localHost('evil.example', '')).toBe(false);
    // With a token the name does not matter: the credential is what is checked.
    const withToken = await call(store, '/api/summary', { as: 'read', headers: { host: 'mail.example.org' } });
    expect(withToken.answer.status).toBe(200);
  });

  it('is not an image, a stylesheet or a frame for any document, a message included', async () => {
    // A message shown with its remote images can name this server as one.
    const store = seeded();
    for (const dest of ['image', 'style', 'script', 'iframe', 'audio', 'font']) {
      for (const path of ['/api/events', '/api/message?live=true&id=k1', '/api/summary', '/api/push/key']) {
        const { answer, json } = await call(store, path, { headers: { 'sec-fetch-dest': dest } });
        expect(answer.status, `${dest} ${path}`).toBe(403);
        expect(json['code']).toBe('embedded');
      }
    }
    expect(liveHub.size).toBe(0);
    // What the page itself does: a fetch, or a link to an attachment.
    expect((await call(store, '/api/summary', { headers: { 'sec-fetch-dest': 'empty' } })).answer.status).toBe(200);
    expect((await call(store, '/api/summary', { headers: { 'sec-fetch-dest': 'document' } })).answer.status).toBe(200);
    // The frame a message is drawn in is a frame, and is not under /api.
    expect((await call(store, '/mail-frame', { headers: { 'sec-fetch-dest': 'iframe' } })).answer.status).toBe(200);
  });

  it('signs out by ending the cookie', async () => {
    const { answer } = await post(seeded(), '/auth/signout', {});
    expect(answer.status).toBe(200);
    expect(answer.cookie).toContain(`${SESSION_COOKIE}=;`);
    expect(answer.cookie).toContain('Max-Age=0');
  });

  it('offers the sign-in form on its own address, for moving from reading to acting', async () => {
    const { answer } = await call(seeded(), '/signin', { as: 'read' });
    expect(answer.status).toBe(200);
    expect(String(answer.body)).toContain('action="/auth"');
    expect(String(answer.body)).toContain('write token');
  });
});

describe('what needs the reader', () => {
  it('lists what was judged to matter and has not been dealt with', async () => {
    const store = seeded();
    const { json } = await call(store, '/api/attention', { as: 'read' });
    expect(json['count']).toBe(2);
    expect((json['mail'] as Array<{ dedupKey: string }>).map((m) => m.dedupKey).sort()).toEqual(['k1', 'k3']);
    expect((json['mail'] as Array<Record<string, unknown>>)[0]).toHaveProperty('link');
  });

  it('keeps the way back: what was dealt with lately is listed with the queue, and returns to it', async () => {
    const store = seeded();
    expect((await call(store, '/api/attention', { as: 'read' })).json['done']).toEqual([]);
    await post(store, '/api/handled', { key: 'k1' });
    // k2 was never in the queue (not notified, not critical): filed away, it would not come back to it.
    await post(store, '/api/action', { key: 'k2', action: 'archive' });

    const { json } = await call(store, '/api/attention', { as: 'read' });
    expect(json['count']).toBe(1);
    expect((json['mail'] as Array<{ dedupKey: string }>).map((m) => m.dedupKey)).toEqual(['k3']);
    const done = json['done'] as Array<Record<string, unknown>>;
    expect(done.map((m) => m['dedupKey']).sort()).toEqual(['k1', 'k2']);
    expect(done.find((m) => m['dedupKey'] === 'k1')).toMatchObject({ queued: true, handledAt: expect.any(String) });
    expect(done.find((m) => m['dedupKey'] === 'k2')).toMatchObject({ queued: false, folder: 'Archive' });
    expect(done[0]).toHaveProperty('link');

    await post(store, '/api/handled', { key: 'k1', handled: false });
    const after = (await call(store, '/api/attention', { as: 'read' })).json;
    expect((after['mail'] as Array<{ dedupKey: string }>).map((m) => m.dedupKey).sort()).toEqual(['k1', 'k3']);
    expect((after['done'] as Array<{ dedupKey: string }>).map((m) => m.dedupKey)).toEqual(['k2']);
  });

  it('records "not important" against the message pressed, whatever its Message-ID spells', async () => {
    const store = seeded();
    // A look-alike whose Message-ID is spelled like k1's key. The page holds keys, and presses this one.
    store.markSeen('me@qq.com|k1', 'me@qq.com', 'look-alike');
    store.recordOutcome('me@qq.com|k1', 'info', false, { messageId: 'k1', sender: 'attacker@evil.example' });
    for (let n = 0; n < 2; n += 1) {
      expect((await post(store, '/api/feedback', { key: 'me@qq.com|k1', label: 'false_positive' })).answer.status).toBe(200);
    }
    expect(store.feedbackRuleHints(1).neverImportant).toEqual(['attacker@evil.example']);
  });

  it('marks a message dealt with, and back again', async () => {
    const store = seeded();
    const done = await post(store, '/api/handled', { key: 'k1' });
    expect(done.json).toMatchObject({ key: 'k1', handled: true, attention: 1 });
    expect(store.getMail('k1')?.handledAt).toBeTruthy();
    const undone = await post(store, '/api/handled', { key: 'k1', handled: false });
    expect(undone.json).toMatchObject({ handled: false, attention: 2 });
    expect(store.getMail('k1')?.handledAt).toBeNull();
    expect((await post(store, '/api/handled', { key: 'absent' })).answer.status).toBe(404);
    expect(store.listMcpAudit(10).map((event) => event.action)).toEqual(expect.arrayContaining(['web:handled', 'web:unhandled']));
  });

  it('keeps that from the read token once a write token exists', async () => {
    // The queue is shared: what one reader ticks off is gone for everyone.
    const store = seeded();
    const refused = await post(store, '/api/handled', { key: 'k1' }, { as: 'read' });
    expect(refused.answer.status).toBe(403);
    expect(refused.json['code']).toBe('readOnly');
    expect(store.getMail('k1')?.handledAt).toBeNull();
    expect((await call(store, '/api/summary', { as: 'read' })).json['session']).toMatchObject({ canMark: false });
    expect((await call(store, '/api/summary', { as: 'write' })).json['session']).toMatchObject({ canMark: true });
  });

  it('lets the only credential keep the page’s books where no write token is set, without touching the mailbox', async () => {
    const store = seeded();
    const fake = backend();
    const single = (path: string, options: Parameters<typeof request>[0]): Promise<WebResponse> => routeWeb(
      request({ ...options, url: path, headers: { cookie: `${SESSION_COOKIE}=${READ}` } }), url(path), READ, store, 'single', { backend: fake.backend },
    );
    const done = await single('/api/handled', { method: 'POST', body: { key: 'k1' } });
    expect(done.status).toBe(200);
    expect(store.getMail('k1')?.handledAt).toBeTruthy();
    await new Promise((resolve) => setImmediate(resolve));
    expect(fake.calls.act).toHaveLength(0);
    const summary = JSON.parse(String((await single('/api/summary', {})).body)) as { session: Record<string, unknown> };
    expect(summary.session).toMatchObject({ canMark: true, writable: false, writeConfigured: false });
  });

  it('marks it read in the mailbox too, for the session that may write', async () => {
    const store = seeded();
    const writer = backend();
    await post(store, '/api/handled', { key: 'k3' }, { as: 'write' }, writer);
    await new Promise((resolve) => setImmediate(resolve));
    expect(writer.calls.act).toEqual([{ messageId: '<three@x>', action: 'mark_read', folderHint: 'INBOX' }]);
    // It changed a mailbox, so it is on record like any other action, and so is one that failed.
    expect(store.listMailActions(5)[0]).toMatchObject({ action: 'mark_read', success: true, messageId: '<three@x>' });
    const refusing = backend({ act: async () => { throw new Error('mailbox is read-only'); } });
    await post(store, '/api/handled', { key: 'k1' }, { as: 'write' }, refusing);
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.listMailActions(5)[0]).toMatchObject({ action: 'mark_read', success: false, messageId: '<one@x>' });
    expect(store.getMail('k1')?.handledAt).toBeTruthy();
  });
});

describe('remembering where a message is in its mailbox', () => {
  const live = (place: Partial<LiveMessage> = {}): LiveMessage => (
    { readable: readable(), folder: 'INBOX', flags: { seen: false, flagged: false, answered: false }, ...place }
  );

  it('learns the place the first time a message is read, and passes it to every lookup after', async () => {
    const store = seeded();
    const fake = backend({ read: async (_account, _id, hint) => { fake.calls.readHints.push(hint); return live({ uid: 17, uidValidity: '9' }); } });
    const first = await call(store, '/api/message?live=true&id=k1', {}, fake);
    expect(first.answer.status).toBe(200);
    // Nothing was known, so only the folder could be said.
    expect(fake.calls.readHints).toEqual([{ folder: 'INBOX' }]);
    expect(store.placeOf('k1')).toEqual({ uid: 17, uidValidity: '9' });
    // Where the message sits is the server's business: the page is not sent it.
    expect(first.json).not.toHaveProperty('uid');
    expect(first.json).not.toHaveProperty('uidValidity');

    await call(store, '/api/message?live=true&fresh=true&id=k1', {}, fake);
    expect(fake.calls.readHints[1]).toEqual({ folder: 'INBOX', uid: 17, uidValidity: '9' });
    await post(store, '/api/action', { key: 'k1', action: 'star' }, {}, fake);
    expect(fake.calls.actHints).toEqual([{ folder: 'INBOX', uid: 17, uidValidity: '9' }]);
  });

  it('does not note a place in a folder the record does not say the message is in', async () => {
    const store = seeded();
    const fake = backend({ read: async () => live({ folder: 'Archive', uid: 3, uidValidity: '2' }) });
    await call(store, '/api/message?live=true&id=k1', {}, fake);
    expect(store.placeOf('k1')).toBeUndefined();
  });

  it('follows a message that was filed away: to its new place when the server said, to none when it did not', async () => {
    const store = seeded();
    store.rememberUid('k1', 'INBOX', 17, '9');
    store.rememberUid('k3', 'INBOX', 18, '9');
    const said = backend({
      act: async (account, messageId, action) => ({
        action, account: account.username, messageId, sourceFolder: 'INBOX',
        destinationFolder: 'Archive', destinationIsSpam: false, destinationUid: 101, destinationUidValidity: '4',
      }),
    });
    await post(store, '/api/action', { key: 'k1', action: 'archive' }, {}, said);
    expect(store.getMail('k1')).toMatchObject({ folder: 'Archive' });
    expect(store.placeOf('k1')).toEqual({ uid: 101, uidValidity: '4' });

    await post(store, '/api/action', { key: 'k3', action: 'archive' });
    expect(store.getMail('k3')).toMatchObject({ folder: 'Archive' });
    expect(store.placeOf('k3')).toBeUndefined();
  });

  it('tells the mailbox where an answered message is, read before the message was sent', async () => {
    const store = seeded();
    store.rememberUid('k1', 'INBOX', 17, '9');
    const fake = backend();
    const sent = await post(store, '/api/send', { account: 'me@qq.com', replyTo: 'k1', to: ['billing@vendor.com'], subject: 'Re: subject k1', text: 'Thanks.' }, {}, fake);
    expect(sent.answer.status).toBe(200);
    await vi.waitFor(() => expect(fake.calls.act).toContainEqual({ messageId: '<one@x>', action: 'answered', folderHint: 'INBOX' }));
    expect(fake.calls.actHints).toContainEqual({ folder: 'INBOX', uid: 17, uidValidity: '9' });
  });
});

describe('acting on a mailbox', () => {
  it('counts a move into the bin as dealt with, and records where a refused move was aimed', async () => {
    const store = seeded();
    const binning = backend({
      act: async (account, messageId, action, options) => ({
        action, account: account.username, messageId, sourceFolder: 'INBOX',
        destinationFolder: options?.destination ?? '', destinationIsSpam: false, destinationIsTrash: true,
      }),
    });
    expect((await post(store, '/api/action', { key: 'k1', action: 'move', destination: 'Deleted Messages' }, {}, binning)).answer.status).toBe(200);
    expect(store.getMail('k1')).toMatchObject({ folder: 'Deleted Messages', handledAt: expect.any(String) });

    const refusing = backend({ act: async () => { throw new MailActionError('invalid_destination', 'destination folder not found or not selectable: Nope'); } });
    expect((await post(store, '/api/action', { key: 'k3', action: 'move', destination: 'Nope' }, {}, refusing)).answer.status).toBe(409);
    expect(store.listMailActions(1)[0]).toMatchObject({ action: 'move', success: false, destinationFolder: 'Nope' });
  });

  it('moves a message to a named folder, and needs to be told which', async () => {
    const store = seeded();
    const fake = backend({
      act: async (account, messageId, action, options) => {
        fake.calls.act.push({ messageId, action, ...(options?.destination ? { folderHint: `to:${options.destination}` } : {}) });
        return { action, account: account.username, messageId, sourceFolder: 'INBOX', destinationFolder: options?.destination ?? '', destinationIsSpam: false };
      },
    });
    const moved = await post(store, '/api/action', { key: 'k1', action: 'move', destination: 'Projects/2026' }, {}, fake);
    expect(moved.answer.status).toBe(200);
    expect(fake.calls.act).toEqual([{ messageId: '<one@x>', action: 'move', folderHint: 'to:Projects/2026' }]);
    expect(store.getMail('k1')).toMatchObject({ folder: 'Projects/2026', handledAt: null });
    // Nowhere to go: refused before the mailbox is asked anything.
    expect((await post(store, '/api/action', { key: 'k1', action: 'move' }, {}, fake)).answer.status).toBe(400);
    expect(fake.calls.act).toHaveLength(1);
    // And a reader's session moves nothing.
    expect((await post(store, '/api/action', { key: 'k1', action: 'move', destination: 'Archive' }, { as: 'read' }, fake)).answer.status).toBe(403);
  });

  it('files a message away, follows it to its new folder and counts it dealt with', async () => {
    const store = seeded();
    const fake = backend();
    const { answer, json } = await post(store, '/api/action', { key: 'k1', action: 'archive' }, {}, fake, 'archiver');
    expect(answer.status).toBe(200);
    expect(answer.cacheControl).toBe('no-store');
    expect(fake.calls.act).toEqual([{ messageId: '<one@x>', action: 'archive', folderHint: 'INBOX' }]);
    expect(json['row']).toMatchObject({ folder: 'Archive', inSpam: false });
    expect(json['attention']).toBe(1);
    expect(store.getMail('k1')).toMatchObject({ folder: 'Archive' });
    expect(store.getMail('k1')?.handledAt).toBeTruthy();
    expect(store.listMailActions(5)[0]).toMatchObject({
      action: 'archive', success: true, sourceFolder: 'INBOX', destinationFolder: 'Archive', client: 'archiver',
    });
  });

  it('follows a message the mailbox moved after the page stopped waiting', async () => {
    vi.useFakeTimers();
    try {
      const store = seeded();
      let moved: () => void = () => undefined;
      const fake = backend({
        act: (account, messageId, action) => new Promise((resolve) => {
          moved = () => resolve({ action, account: account.username, messageId, sourceFolder: 'INBOX', destinationFolder: 'Archive', destinationIsSpam: false });
        }),
      });
      const waiting = post(store, '/api/action', { key: 'k1', action: 'archive' }, {}, fake, 'slow-box');
      await vi.advanceTimersByTimeAsync(31_000);
      const first = await waiting;
      expect(first.answer.status).toBe(504);
      expect(first.json['code']).toBe('actionTimeout');
      expect(store.getMail('k1')).toMatchObject({ folder: 'INBOX', handledAt: null });

      // The mailbox gets there in the end. The row must not be left pointing at a folder the message has left.
      moved();
      await vi.advanceTimersByTimeAsync(50);
      expect(store.getMail('k1')).toMatchObject({ folder: 'Archive' });
      expect(store.getMail('k1')?.handledAt).toBeTruthy();
      const rows = store.listMailActions(5).filter((row) => row.action === 'archive');
      expect(rows.map((row) => [row.success, row.error ?? row.destinationFolder])).toEqual([[true, 'Archive'], [false, 'timeout']]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('brings a message out of spam without calling that dealt with', async () => {
    const store = seeded();
    const { json } = await post(store, '/api/action', { key: 'k2', action: 'inbox' });
    expect(json['row']).toMatchObject({ folder: 'INBOX', inSpam: false });
    expect(store.getMail('k2')?.handledAt).toBeNull();
  });

  it('refuses a move with nowhere to go, an action nobody asks for, and an unknown one', async () => {
    const store = seeded();
    const fake = backend();
    for (const action of ['move', 'delete', 'answered', '']) {
      expect((await post(store, '/api/action', { key: 'k1', action }, {}, fake)).answer.status, action).toBe(400);
    }
    expect(fake.calls.act).toHaveLength(0);
  });

  it('says why when the mailbox refuses, and records the failure', async () => {
    const store = seeded();
    const refusing = backend({ act: async () => { throw new MailActionError('invalid_destination', 'this mailbox has no archive folder'); } });
    const refused = await post(store, '/api/action', { key: 'k1', action: 'archive' }, {}, refusing);
    expect(refused.answer.status).toBe(409);
    expect(refused.json['code']).toBe('action_invalid_destination');
    const missing = await post(store, '/api/action', { key: 'k1', action: 'star' }, {}, backend({ act: async () => undefined }));
    expect(missing.answer.status).toBe(404);
    expect(missing.json['code']).toBe('actionNotFound');
    const broken = await post(store, '/api/action', { key: 'k1', action: 'star' }, {}, backend({ act: async () => { throw new Error('socket closed'); } }));
    expect(broken.answer.status).toBe(502);
    expect(store.getMail('k1')).toMatchObject({ folder: 'INBOX' });
    expect(store.listMailActions(5).every((entry) => entry.success === false)).toBe(true);
  });

  it('turns two corrections for one sender into a rule, and says so', async () => {
    const store = seeded();
    const first = await post(store, '/api/feedback', { key: 'k1', label: 'false_positive' });
    expect(first.json).toMatchObject({ recorded: true, rule: null });
    const second = await post(store, '/api/feedback', { key: 'k3', label: 'false_positive' });
    expect(second.json).toMatchObject({ recorded: true, rule: 'never', sender: 'billing@vendor.com' });
    expect((await post(store, '/api/feedback', { key: 'k1', label: 'handled' })).answer.status).toBe(400);
  });
});

describe('reading a message as it was written', () => {
  it('reads the mailbox once and answers again from memory', async () => {
    const store = seeded();
    const fake = backend();
    const first = await call(store, '/api/message?live=true&id=k1', {}, fake);
    expect(first.answer.status).toBe(200);
    expect(first.answer.cacheControl).toBe('no-store');
    expect(first.json).toMatchObject({
      html: '<p>Hello</p>', text: 'Hello', body: 'Hello', auth: { result: 'pass', signedBy: 'vendor.com' },
      flags: { seen: false }, liveFolder: 'INBOX',
    });
    await call(store, '/api/message?live=true&id=k1', {}, fake);
    expect(fake.calls.read).toHaveLength(1);
    // A retry asks the mailbox again.
    await call(store, '/api/message?live=true&fresh=true&id=k1', {}, fake);
    expect(fake.calls.read).toHaveLength(2);
  });

  it('says a provider is not answering in words of its own, not as a fault in the message', async () => {
    const store = seeded();
    const down = backend({ read: async () => { throw new MailboxUnreachableError('the mail server did not complete the sign-in in time | ETIMEDOUT'); } });
    const read = await call(store, '/api/message?live=true&id=k1', {}, down);
    expect(read.answer.status).toBe(503);
    expect(read.json).toEqual({ error: 'the mail provider is not answering right now', code: 'mailboxUnreachable' });
    expect(read.answer.headers?.['retry-after']).toBe('15');
    // Nothing about sockets or timeouts reaches the reader.
    expect(JSON.stringify(read.json)).not.toMatch(/ETIMEDOUT|sign-in/);
    expect((await call(store, '/api/reply?key=k1', {}, down)).json['code']).toBe('mailboxUnreachable');
    // Any other failure keeps its own code and says what happened.
    const broken = backend({ read: async () => { throw new Error('Mailbox is locked'); } });
    const other = await call(store, '/api/message?live=true&fresh=true&id=k1', {}, broken);
    expect(other.answer.status).toBe(502);
    expect(other.json).toMatchObject({ code: 'readFailed', detail: expect.stringContaining('Mailbox is locked') });
  });

  it('does not queue a fresh read behind one that hung', async () => {
    const store = seeded();
    let reads = 0;
    const live: LiveMessage = { readable: readable(), folder: 'INBOX', flags: { seen: false, flagged: false, answered: false } };
    // The first read never comes back; the mailbox is fine after that.
    const fake = backend({ read: () => { reads += 1; return reads === 1 ? new Promise<LiveMessage>(() => undefined) : Promise.resolve(live); } });
    void call(store, '/api/message?live=true&id=k1', {}, fake);
    await new Promise((resolve) => setImmediate(resolve));
    expect(reads).toBe(1);
    const retried = await call(store, '/api/message?live=true&fresh=true&id=k1', {}, fake);
    expect(retried.answer.status).toBe(200);
    expect(reads).toBe(2);
    // And what the retry fetched is kept, so the reply that follows does not read again.
    expect((await call(store, '/api/reply?key=k1', {}, fake)).answer.status).toBe(200);
    expect(reads).toBe(2);
  });

  it('forgets its copy once the message has been changed', async () => {
    const store = seeded();
    const fake = backend();
    await call(store, '/api/message?live=true&id=k1', {}, fake);
    await post(store, '/api/action', { key: 'k1', action: 'star' }, {}, fake);
    await call(store, '/api/message?live=true&id=k1', {}, fake);
    expect(fake.calls.read).toHaveLength(2);
  });

  it('says so when the message is no longer where it was filed', async () => {
    const { answer, json } = await call(seeded(), '/api/message?live=true&id=k1', {}, backend({ read: async () => undefined }));
    expect(answer.status).toBe(404);
    expect(json['code']).toBe('notInMailbox');
  });

  it('serves the frame a message is shown in under a policy in which nothing runs', async () => {
    const store = seeded();
    const plain = await call(store, '/mail-frame');
    const policy = plain.answer.headers?.['content-security-policy'] ?? '';
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain('sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    expect(policy).not.toContain('allow-scripts');
    expect(policy).not.toContain('allow-forms');
    expect(policy).toContain('img-src data:;');
    expect(String(plain.answer.body)).not.toContain('<script');
    // Remote images load only in the frame the reader asked them for.
    const withImages = await call(store, '/mail-frame?images=1');
    expect(withImages.answer.headers?.['content-security-policy']).toContain('img-src data: https:;');
    expect((await call(store, '/mail-frame', { as: 'none' })).answer.status).toBe(401);
  });
});

describe('writing', () => {
  it('works out who an answer goes to from the message itself', async () => {
    const store = seeded();
    const reply = await call(store, '/api/reply?key=k1');
    expect(reply.json).toMatchObject({
      account: 'me@qq.com', to: ['billing@vendor.com'], cc: [], subject: 'Re: subject k1', canSend: true,
      inReplyTo: '<one@x>', references: ['<root@x>', '<one@x>'],
    });
    expect(String(reply.json['quoted'])).toContain('> Hello');
    const all = await call(store, '/api/reply?key=k1&mode=replyAll');
    // The owner's own address is never a recipient of their own reply.
    expect(all.json).toMatchObject({ to: ['billing@vendor.com'], cc: ['ann@vendor.com'] });
  });

  it('sends an answer from the mailbox that was written to, threaded under the original', async () => {
    const store = seeded();
    const fake = backend();
    const { answer, json } = await post(store, '/api/send', {
      account: 'someone-else@x.org', replyTo: 'k1', to: ['billing@vendor.com'], subject: 'Re: subject k1',
      text: 'Thanks', references: ['<root@x>'],
    }, {}, fake, 'sender');
    expect(answer.status).toBe(200);
    expect(json).toMatchObject({ sent: true, messageId: '<sent@x>', accepted: 1, savedCopy: true, attention: 1 });
    expect(fake.calls.sent[0]).toMatchObject({
      to: ['billing@vendor.com'], subject: 'Re: subject k1', text: 'Thanks', inReplyTo: '<one@x>', references: ['<root@x>', '<one@x>'],
    });
    // Answered is dealt with, and the mailbox is told it was answered.
    expect(store.getMail('k1')?.handledAt).toBeTruthy();
    await new Promise((resolve) => setImmediate(resolve));
    expect(fake.calls.act).toContainEqual({ messageId: '<one@x>', action: 'answered', folderHint: 'INBOX' });
    // On record: that a message left, not what it said or to whom.
    const rows = store.listMailActions(5);
    const audit = rows.find((row) => row.action === 'send');
    expect(audit).toMatchObject({ action: 'send', success: true, account: 'me@qq.com', messageId: '<sent@x>', client: 'sender' });
    expect(JSON.stringify(rows)).not.toContain('billing@vendor.com');
    // Flagging the original answered is a change to the mailbox, and is on record too.
    expect(rows.find((row) => row.action === 'answered')).toMatchObject({ success: true, messageId: '<one@x>', client: 'sender' });
  });

  it('records a send that finishes after the page stopped waiting, and never sends that letter twice', async () => {
    vi.useFakeTimers();
    try {
      const store = seeded();
      let taken: (sent: SentMail) => void = () => undefined;
      let sends = 0;
      const filed: Buffer[] = [];
      const fake = backend({
        savesSentCopy: () => false,
        appendSent: async (_account, raw) => { filed.push(raw); return 'Sent'; },
        send: () => { sends += 1; return new Promise<SentMail>((resolve) => { taken = resolve; }); },
      });
      const letter = { id: 'letter-0001', replyTo: 'k1', to: ['billing@vendor.com'], subject: 'Re: subject k1', text: 'Thanks' };
      const waiting = post(store, '/api/send', letter, {}, fake, 'slow');
      await vi.advanceTimersByTimeAsync(61_000);
      const first = await waiting;
      // The page is told the truth: not confirmed, look before trying again.
      expect(first.answer.status).toBe(504);
      expect(first.json['code']).toBe('send_timeout');
      expect(store.getMail('k1')?.handledAt).toBeNull();

      // Then the mail server takes it after all.
      taken({ messageId: '<late@x>', raw: Buffer.from('raw'), copy: Buffer.from('Bcc: kept\r\nraw'), accepted: ['billing@vendor.com'], rejected: [] });
      await vi.advanceTimersByTimeAsync(50);
      const rows = store.listMailActions(10).filter((row) => row.action === 'send');
      expect(rows.map((row) => [row.success, row.error ?? row.messageId])).toEqual([[true, '<late@x>'], [false, 'timeout']]);
      // What a send does when it succeeds was all done: the copy, with its Bcc line, and the queue.
      expect(filed.map((raw) => raw.toString())).toEqual(['Bcc: kept\r\nraw']);
      expect(store.getMail('k1')?.handledAt).toBeTruthy();

      // The reader presses send again. The same letter is not sent again; they are told it went.
      const again = await post(store, '/api/send', letter, {}, fake, 'slow');
      expect(again.answer.status).toBe(200);
      expect(again.json).toMatchObject({ sent: true, messageId: '<late@x>', savedCopy: true });
      expect(sends).toBe(1);
      // A different letter is a different send.
      const other = post(store, '/api/send', { ...letter, id: 'letter-0002', text: 'And another thing' }, {}, fake, 'slow');
      await vi.advanceTimersByTimeAsync(10);
      expect(sends).toBe(2);
      taken({ messageId: '<second@x>', raw: Buffer.from('r'), copy: Buffer.from('r'), accepted: ['billing@vendor.com'], rejected: [] });
      await vi.advanceTimersByTimeAsync(10);
      expect((await other).json).toMatchObject({ sent: true, messageId: '<second@x>' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a letter whose send ended in an error be tried again, and says when nobody knows whether it went', async () => {
    const store = seeded();
    const letter = { id: 'letter-0003', account: 'me@qq.com', to: ['a@b.co'], subject: 's', text: 't' };
    let attempt = 0;
    const flaky = backend({
      send: async (_account, mail) => {
        attempt += 1;
        if (attempt === 1) throw new SendError('connection', 'not reached');
        return { messageId: '<ok@x>', raw: Buffer.from('r'), copy: Buffer.from('r'), accepted: mail.to, rejected: [] };
      },
    });
    expect((await post(store, '/api/send', letter, {}, flaky)).answer.status).toBe(502);
    expect((await post(store, '/api/send', letter, {}, flaky)).json).toMatchObject({ sent: true, messageId: '<ok@x>' });
    expect(attempt).toBe(2);

    // The line dropped after the message was handed over. Nobody knows whether it went:
    // the page is told to look in Sent, not that the server could not be reached.
    let handed = 0;
    const dropped = backend({ send: async () => { handed += 1; throw new SendError('unknown', 'may have been sent'); } });
    const unsure = { ...letter, id: 'letter-0004' };
    const first = await post(store, '/api/send', unsure, {}, dropped);
    expect(first.answer.status).toBe(504);
    expect(first.json['code']).toBe('send_timeout');
    expect(store.listMailActions(1)[0]).toMatchObject({ action: 'send', success: false, error: 'unknown' });
    // Having looked, sending again is the reader's decision, and it is a real send.
    await post(store, '/api/send', unsure, {}, dropped);
    expect(handed).toBe(2);
    // Without a name there is nothing to recognise a letter by, and each request is its own send.
    const unnamed = { account: 'me@qq.com', to: ['a@b.co'], subject: 's', text: 't' };
    const counting = backend();
    await post(store, '/api/send', unnamed, {}, counting);
    await post(store, '/api/send', unnamed, {}, counting);
    expect(counting.calls.sent).toHaveLength(2);
  });

  it('still says the message was sent when the bookkeeping after it fails', async () => {
    const store = seeded();
    const fake = backend();
    const broken = Object.create(store, {
      setHandled: { value: () => { throw new Error('database is locked'); } },
    }) as StateStore;
    const { answer, json } = await post(broken, '/api/send', { replyTo: 'k1', to: ['a@b.co'], subject: 's', text: 't' }, {}, fake);
    expect(answer.status).toBe(200);
    expect(json).toMatchObject({ sent: true, messageId: '<sent@x>' });
    expect(fake.calls.sent).toHaveLength(1);
  });

  it('files a copy in Sent where the provider does not', async () => {
    const store = seeded();
    const fake = backend({ savesSentCopy: () => false });
    const { json } = await post(store, '/api/send', { account: 'me@qq.com', to: ['a@b.co'], subject: 's', text: 't' }, {}, fake);
    expect(fake.calls.appended).toBe(1);
    expect(json['savedCopy']).toBe(true);
    // The copy that is filed is the one that keeps the Bcc line.
    const kept: string[] = [];
    await post(store, '/api/send', { account: 'me@qq.com', to: ['a@b.co'], subject: 's', text: 't' }, {},
      backend({ savesSentCopy: () => false, appendSent: async (_account, raw) => { kept.push(raw.toString()); return 'Sent'; } }));
    expect(kept).toEqual(['Bcc: kept\r\nraw']);
    const failing = backend({ savesSentCopy: () => false, appendSent: async () => { throw new Error('quota'); } });
    const sent = await post(store, '/api/send', { account: 'me@qq.com', to: ['a@b.co'], subject: 's', text: 't' }, {}, failing);
    // The message went; only its copy did not.
    expect(sent.json).toMatchObject({ sent: true, savedCopy: false });
  });

  it('refuses what cannot be sent, and names the reason', async () => {
    const store = seeded();
    const body = { account: 'me@qq.com', to: ['a@b.co'], subject: 's', text: 't' };
    const unknown = await post(store, '/api/send', { ...body, account: 'nobody@x.org' });
    expect(unknown.answer.status).toBe(409);
    const unavailable = await post(store, '/api/send', body, {}, backend({ sending: () => ({ available: false, reason: 'oauth_scope' }) }));
    expect(unavailable.json).toMatchObject({ code: 'send_not_configured', reason: 'oauth_scope' });
    const rejected = await post(store, '/api/send', body, {}, backend({
      send: async () => { throw new SendError('rejected', 'refused', { detail: '550 no such user' }); },
    }));
    expect(rejected.answer.status).toBe(422);
    expect(rejected.json).toMatchObject({ code: 'send_rejected', detail: '550 no such user' });
    const invalid = await post(store, '/api/send', body, {}, backend({ send: async () => { throw new SendError('invalid', 'bad address'); } }));
    expect(invalid.answer.status).toBe(400);
    expect(store.listMailActions(10).filter((entry) => entry.action === 'send').every((entry) => !entry.success)).toBe(true);
    expect((await post(store, '/api/send', { ...body, replyTo: 'absent' })).answer.status).toBe(404);
  });

  it('does not let one client send without limit', async () => {
    const store = seeded();
    const fake = backend();
    const body = { account: 'me@qq.com', to: ['a@b.co'], subject: 's', text: 't' };
    for (let n = 0; n < 10; n += 1) expect((await post(store, '/api/send', body, {}, fake, 'flood')).answer.status).toBe(200);
    const refused = await post(store, '/api/send', body, {}, fake, 'flood');
    expect(refused.answer.status).toBe(429);
    expect(fake.calls.sent).toHaveLength(10);
  });

  it('asks the model for a first version of an answer, from the message as the mailbox has it', async () => {
    const store = seeded();
    const fake = backend();
    const { json } = await post(store, '/api/draft', { key: 'k1', instruction: 'say yes' }, {}, fake);
    expect(json).toEqual({ draft: 'Thanks, will do.' });
    expect(fake.calls.drafted).toEqual([{ text: 'Hello', instruction: 'say yes' }]);
    const off = await post(store, '/api/draft', { key: 'k1' }, {}, backend({ assistant: () => false }));
    expect(off.answer.status).toBe(503);
    const refused = await post(store, '/api/draft', { key: 'k1' }, {}, backend({ draft: async () => { throw new AssistantError('refused', 'no'); } }));
    expect(refused.answer.status).toBe(422);
    expect(refused.json['code']).toBe('assistant_refused');
    // A new message has nothing to answer, so it needs to be told what to say.
    expect((await post(store, '/api/draft', {}, {}, fake)).answer.status).toBe(400);
  });
});

describe('asking', () => {
  it('answers with the messages the answer drew on', async () => {
    const store = seeded();
    const fake = backend();
    const { answer, json } = await post(store, '/api/ask', { question: 'what needs me?' }, { as: 'read' }, fake);
    expect(answer.status).toBe(200);
    expect(fake.calls.asked).toEqual(['what needs me?']);
    expect(json).toMatchObject({ answer: 'One thing [1].', considered: 3 });
    expect(json['citations']).toEqual([expect.objectContaining({ n: 1, key: 'k1', row: expect.objectContaining({ subject: 'subject k1' }) })]);
    expect((await post(store, '/api/ask', { question: '   ' }, {}, fake)).answer.status).toBe(400);
    const timeout = await post(store, '/api/ask', { question: 'q' }, {}, backend({ ask: async () => { throw new AssistantError('timeout', 'slow'); } }));
    expect(timeout.answer.status).toBe(504);
    expect((await post(store, '/api/ask', { question: 'q' }, {}, backend({ assistant: () => false }))).answer.status).toBe(503);
  });

  it('stops at a daily budget shared by every session, so a read token cannot spend without limit', async () => {
    process.env.WEB_ASSISTANT_DAILY_LIMIT = '3';
    const store = seeded();
    const fake = backend();
    // Different clients each time: the per-minute window alone would never stop this.
    for (let n = 0; n < 2; n += 1) expect((await post(store, '/api/ask', { question: `q${n}` }, { as: 'read' }, fake)).answer.status).toBe(200);
    expect((await post(store, '/api/draft', { instruction: 'say hello' }, { as: 'write' }, fake)).answer.status).toBe(200);
    const spent = await post(store, '/api/ask', { question: 'one more' }, { as: 'read' }, fake);
    expect(spent.answer.status).toBe(429);
    expect(spent.json['code']).toBe('assistant_daily');
    expect((await post(store, '/api/draft', { instruction: 'again' }, { as: 'write' }, fake)).json['code']).toBe('assistant_daily');
    expect(fake.calls.asked).toHaveLength(2);
    // A request that never reaches the model takes nothing from the budget.
    resetAssistantBudget();
    process.env.WEB_ASSISTANT_DAILY_LIMIT = '1';
    expect((await post(store, '/api/ask', { question: '  ' }, {}, fake)).answer.status).toBe(400);
    expect((await post(store, '/api/ask', { question: 'real' }, {}, fake)).answer.status).toBe(200);
  });
});

describe('notifications to a device', () => {
  const keys = (): { p256dh: string; auth: string } => ({
    p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url'),
    auth: Buffer.alloc(16, 3).toString('base64url'),
  });
  const endpoint = 'https://fcm.googleapis.com/fcm/send/device-one';

  it('remembers a device and what it wants to hear', async () => {
    const store = seeded();
    const key = await call(store, '/api/push/key', { as: 'read' });
    expect(String(key.json['publicKey'])).toMatch(/^[\w-]{80,}$/);
    // The same key on the next visit: a browser subscribes against it.
    expect((await call(store, '/api/push/key')).json['publicKey']).toBe(key.json['publicKey']);

    const saved = await post(store, '/api/push/subscribe', { endpoint, keys: keys(), level: 'critical', codes: false },
      { as: 'read', headers: { origin: 'https://mail.example.org', host: 'mail.example.org' } });
    expect(saved.json).toEqual({ subscribed: true });
    expect(store.getPushSubscription(endpoint)).toMatchObject({
      level: 'critical', codes: false, lang: 'en', origin: 'https://mail.example.org', credential: credentialMark(READ),
    });
    expect((await post(store, '/api/push/state', { endpoint })).json).toEqual({ subscribed: true, level: 'critical', codes: false });
    expect((await post(store, '/api/push/test', { endpoint })).json).toEqual({ result: 'sent' });
    expect((await post(store, '/api/push/unsubscribe', { endpoint })).json).toEqual({ subscribed: false });
    expect((await post(store, '/api/push/state', { endpoint })).json).toEqual({ subscribed: false });
  });

  it('stores only an address on a push service, with keys of the right shape', async () => {
    const store = seeded();
    const elsewhere = await post(store, '/api/push/subscribe', { endpoint: 'https://internal.example/hook', keys: keys() });
    expect(elsewhere.answer.status).toBe(400);
    expect(elsewhere.json['code']).toBe('pushEndpoint');
    const malformed = await post(store, '/api/push/subscribe', { endpoint, keys: { p256dh: 'AAAA', auth: 'AAAA' } });
    expect(malformed.answer.status).toBe(400);
    expect(store.listPushSubscriptions()).toHaveLength(0);
  });

  it('ties a subscription to the token it was made under, so replacing the token ends it', async () => {
    const store = seeded();
    const other = 'https://fcm.googleapis.com/fcm/send/device-two';
    await post(store, '/api/push/subscribe', { endpoint, keys: keys() }, { as: 'read' });
    await post(store, '/api/push/subscribe', { endpoint: other, keys: keys() }, { as: 'write' });
    expect(store.getPushSubscription(other)?.credential).toBe(credentialMark(WRITE));
    // The mark is not the token, and cannot be turned back into it.
    expect(JSON.stringify(store.listPushSubscriptions())).not.toContain(READ);
    expect(credentialMark('')).toBe('');
    // Nothing changed: both stay.
    expect(store.prunePushSubscriptions([credentialMark(READ), credentialMark(WRITE)])).toBe(0);
    // The read token was replaced: the device that subscribed under it stops being told.
    expect(store.prunePushSubscriptions([credentialMark('a-new-read-token'), credentialMark(WRITE)])).toBe(1);
    expect(store.listPushSubscriptions().map((sub) => sub.endpoint)).toEqual([other]);
  });

  it('refuses a new device at the cap instead of pushing a real one out', async () => {
    const store = seeded();
    await post(store, '/api/push/subscribe', { endpoint, keys: keys() }, { as: 'write' });
    for (let n = 0; n < 49; n += 1) {
      const fake = `https://fcm.googleapis.com/fcm/send/flood-${n}`;
      expect((await post(store, '/api/push/subscribe', { endpoint: fake, keys: keys() }, { as: 'read' })).answer.status).toBe(200);
    }
    const over = await post(store, '/api/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/flood-49', keys: keys() }, { as: 'read' });
    expect(over.answer.status).toBe(409);
    expect(over.json['code']).toBe('pushFull');
    expect(store.getPushSubscription(endpoint)).toBeDefined();
    // A device already known can still change what it wants to hear.
    expect((await post(store, '/api/push/subscribe', { endpoint, keys: keys(), level: 'critical' }, { as: 'write' })).answer.status).toBe(200);
    expect(store.getPushSubscription(endpoint)?.level).toBe('critical');
  });

  it('lists the devices that are told, and lets the owner end one', async () => {
    const store = seeded();
    const other = 'https://fcm.googleapis.com/fcm/send/device-two';
    await post(store, '/api/push/subscribe', { endpoint, keys: keys(), label: 'iPhone' }, { as: 'write' });
    await post(store, '/api/push/subscribe', { endpoint: other, keys: keys(), label: 'MacIntel' }, { as: 'read' });
    const listed = await post(store, '/api/push/devices', { endpoint }, { as: 'read' });
    const devices = listed.json['devices'] as Array<Record<string, unknown>>;
    expect(devices.map((device) => [device['label'], device['current']])).toEqual([['iPhone', true], ['MacIntel', false]]);
    expect(listed.json['canRemove']).toBe(false);
    // Where pushes go and what encrypts them never leave the server.
    expect(JSON.stringify(listed.json)).not.toContain('fcm.googleapis.com');
    expect(JSON.stringify(listed.json)).not.toContain(keys().auth);

    const id = String(devices[1]!['id']);
    const refused = await post(store, '/api/push/remove', { id }, { as: 'read' });
    expect(refused.answer.status).toBe(403);
    expect(store.listPushSubscriptions()).toHaveLength(2);
    const removed = await post(store, '/api/push/remove', { id }, { as: 'write' });
    expect(removed.json).toEqual({ removed: true });
    expect(store.listPushSubscriptions().map((sub) => sub.endpoint)).toEqual([endpoint]);
    expect((await post(store, '/api/push/remove', { id }, { as: 'write' })).answer.status).toBe(404);
    expect((await post(store, '/api/push/devices', {}, { as: 'write' })).json['canRemove']).toBe(true);
  });

  it('can be switched off for the whole server', async () => {
    process.env.WEB_PUSH_ENABLED = 'false';
    const store = seeded();
    expect((await call(store, '/api/push/key')).answer.status).toBe(404);
    expect((await call(store, '/api/summary')).json['session']).toMatchObject({ push: false });
  });
});

describe('the live line', () => {
  it('answers with a stream that greets its listener', async () => {
    const { answer } = await call(seeded(), '/api/events', { as: 'read' });
    expect(answer.status).toBe(200);
    expect(answer.contentType).toContain('text/event-stream');
    expect(answer.cacheControl).toContain('no-store');
    expect(answer.headers?.['x-accel-buffering']).toBe('no');
    const written: string[] = [];
    let close: () => void = () => undefined;
    process.env.STATE_DB_PATH = ':memory:';
    answer.stream?.({ write: (chunk) => { written.push(chunk); }, onClose: (listener) => { close = listener; }, close: () => undefined });
    expect(written.join('')).toContain('event: hello');
    close();
    expect((await call(seeded(), '/api/events', { as: 'none' })).answer.status).toBe(401);
  });

  it('refuses outright when there is no room, rather than holding a silent request open', async () => {
    process.env.STATE_DB_PATH = ':memory:';
    const store = seeded();
    const closers: Array<() => void> = [];
    const open = async (client: string): Promise<WebResponse> => {
      const { answer } = await call(store, '/api/events', { as: 'read' }, backend(), client);
      answer.stream?.({ write: () => undefined, onClose: (listener) => { closers.push(listener); }, close: () => undefined });
      return answer;
    };
    try {
      // One browser may hold a dozen; the thirteenth is told no, with a status a page can act on.
      for (let n = 0; n < 12; n += 1) expect((await open('one-browser')).status).toBe(200);
      const over = await call(store, '/api/events', { as: 'read' }, backend(), 'one-browser');
      expect(over.answer.status).toBe(503);
      expect(over.answer.stream).toBeUndefined();
      expect(over.answer.headers?.['retry-after']).toBe('120');
      // Somebody else is not shut out by it.
      expect((await open('another-browser')).status).toBe(200);
    } finally {
      for (const close of closers) close();
    }
    expect(liveHub.size).toBe(0);
  });
});

describe('the page’s own protection', () => {
  it('runs only the script that carries this response’s nonce, and loads nothing from elsewhere', async () => {
    const { answer } = await call(seeded(), '/');
    const policy = answer.headers?.['content-security-policy'] ?? '';
    const nonce = /script-src 'nonce-([^']+)'/.exec(policy)?.[1];
    expect(nonce).toBeTruthy();
    const page = String(answer.body);
    // Every script tag however it is cased: one written <SCRIPT> runs just the same,
    // and has to be held to the same nonce.
    const scripts = page.match(/<script[^>]*>/gi) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toBe(`<script nonce="${nonce}">`);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).not.toContain('unsafe-eval');
    expect(answer.headers?.['x-frame-options']).toBe('DENY');
    // A different nonce every time.
    const again = await call(seeded(), '/');
    expect(again.answer.headers?.['content-security-policy']).not.toBe(policy);
  });

  it('never lets a browser guess a content type, on any response', async () => {
    const store = seeded();
    for (const path of ['/', '/api/mail', '/sw.js', '/mail-frame', '/api/nothing']) {
      expect((await call(store, path)).answer.headers?.['x-content-type-options'], path).toBe('nosniff');
    }
  });

  it('keeps mail out of every cache', async () => {
    const store = seeded();
    for (const path of ['/api/mail', '/api/summary', '/api/attention', '/api/digest', '/api/message?id=k1']) {
      expect((await call(store, path)).answer.cacheControl, path).toBe('no-store');
    }
  });

  it('puts no backtick and no interpolation mark in the page script', async () => {
    // The script is assembled from template literals; either would end one early.
    const page = String((await call(seeded(), '/')).answer.body);
    const script = page.slice(page.lastIndexOf('<script'), page.lastIndexOf('</script>'));
    expect(script).not.toContain('`');
    expect(script).not.toContain('${');
  });
});
