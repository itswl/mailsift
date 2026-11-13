import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import './setup.js';
import { simpleParser } from 'mailparser';
import { createTransport } from 'nodemailer';
import { ConfigError, loadConfig, type Account } from '../src/config.js';
import { findQuoteStart } from '../src/imap/body.js';
import {
  addressed, attachmentCharset, attachmentContentType, attachmentFilename, attachmentLimitBytes, describeBytes, forwardEnvelope,
  isSendableAddress, replyEnvelope, savesSentCopy, scopeAllowsSending, SendError, sendingStatus, sendMail,
  smtpTransportOptions, transferAllowanceMs, type ForwardOriginal, type OutgoingMail, type ReplyOriginal,
} from '../src/smtp.js';

/** One conversation with the pretend server: who signed in, the envelope, and the message as received. */
interface Session {
  auth?: { user: string; pass: string };
  from?: string;
  to: string[];
  data?: Buffer;
}

interface ServerOptions {
  /** The only password accepted. */
  password?: string;
  /** Recipients answered with 550. */
  reject?: string[];
  /** Take the message and then refuse it, as a content filter does. */
  refuseData?: boolean;
  /** Take the message and hang up without a word, as a server that crashed after queueing it does. */
  dropAfterData?: boolean;
  /** Hang up when the envelope begins, before any message is offered. */
  dropAtMail?: boolean;
}

/**
 * A submission server small enough to read: EHLO, AUTH PLAIN and LOGIN, MAIL
 * FROM, RCPT TO, DATA, QUIT, over plain TCP on loopback. It keeps what it was
 * told so a test can compare that with what sendMail says it sent.
 */
async function startServer(options: ServerOptions = {}): Promise<{ port: number; sessions: Session[]; close: () => Promise<void> }> {
  const sessions: Session[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    const session: Session = { to: [] };
    sessions.push(session);
    let buffer: Buffer = Buffer.alloc(0);
    let mode: 'command' | 'data' | 'plain' | 'login-user' | 'login-pass' = 'command';
    let loginUser = '';
    const signIn = (user: string, pass: string): void => {
      session.auth = { user, pass };
      socket.write(pass === (options.password ?? 'app-pw') ? '235 2.7.0 accepted\r\n' : '535 5.7.8 bad credentials\r\n');
    };
    const plain = (encoded: string): void => {
      const [, user = '', pass = ''] = Buffer.from(encoded, 'base64').toString('utf8').split('\0');
      signIn(user, pass);
    };
    socket.write('220 localhost ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      for (;;) {
        if (mode === 'data') {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          // The line end before the lone dot closes the message's last line and
          // belongs to it; a doubled leading dot is the sender's escaping.
          session.data = Buffer.from(
            buffer.subarray(0, end + 2).toString('latin1').replace(/(^|\r\n)\.\./g, '$1.'), 'latin1',
          );
          buffer = buffer.subarray(end + 5);
          mode = 'command';
          if (options.dropAfterData) { socket.destroy(); return; }
          socket.write(options.refuseData ? '554 5.7.1 message refused\r\n' : '250 2.0.0 queued\r\n');
          continue;
        }
        const lineEnd = buffer.indexOf('\r\n');
        if (lineEnd === -1) return;
        const line = buffer.subarray(0, lineEnd).toString('utf8');
        buffer = buffer.subarray(lineEnd + 2);
        if (mode === 'plain') { mode = 'command'; plain(line); continue; }
        if (mode === 'login-user') {
          loginUser = Buffer.from(line, 'base64').toString('utf8');
          mode = 'login-pass';
          socket.write('334 UGFzc3dvcmQ6\r\n');
          continue;
        }
        if (mode === 'login-pass') { mode = 'command'; signIn(loginUser, Buffer.from(line, 'base64').toString('utf8')); continue; }
        const verb = line.toUpperCase();
        if (verb.startsWith('EHLO')) socket.write('250-localhost\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        else if (verb.startsWith('AUTH PLAIN')) {
          const inline = line.slice('AUTH PLAIN'.length).trim();
          if (inline) plain(inline);
          else { mode = 'plain'; socket.write('334 \r\n'); }
        } else if (verb.startsWith('AUTH LOGIN')) { mode = 'login-user'; socket.write('334 VXNlcm5hbWU6\r\n'); }
        else if (verb.startsWith('MAIL FROM:') && options.dropAtMail) { socket.destroy(); return; }
        else if (verb.startsWith('MAIL FROM:')) { session.from = /<([^>]*)>/.exec(line)?.[1] ?? ''; socket.write('250 2.1.0 ok\r\n'); }
        else if (verb.startsWith('RCPT TO:')) {
          const address = /<([^>]*)>/.exec(line)?.[1] ?? '';
          if ((options.reject ?? []).includes(address)) socket.write('550 5.1.1 no such user\r\n');
          else { session.to.push(address); socket.write('250 2.1.5 ok\r\n'); }
        } else if (verb === 'DATA') { mode = 'data'; socket.write('354 end with a dot\r\n'); }
        else if (verb === 'QUIT') { socket.write('221 2.0.0 bye\r\n'); socket.end(); }
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    sessions,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

const servers: Array<{ close: () => Promise<void> }> = [];
async function serving(options: ServerOptions = {}): Promise<{ port: number; sessions: Session[] }> {
  const server = await startServer(options);
  servers.push(server);
  return server;
}

// test/setup.ts clears the mailbox variables and DRY_RUN; these are this file's own.
const OWN_ENV = ['SMTP_ENABLED', 'GMAIL_CLIENT_ID', 'OUTLOOK_CLIENT_ID'];
afterEach(async () => {
  for (const key of OWN_ENV) delete process.env[key];
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const addressesOf = (field: unknown): string[] =>
  (Array.isArray(field) ? field : field ? [field] : [])
    .flatMap((entry) => (entry as { value?: Array<{ address?: string }> }).value ?? [])
    .map((box) => box.address ?? '');

/** A nodemailer transport pointed at the pretend server: loopback, so no TLS to negotiate. */
const transportTo = (port: number, pass = 'app-pw'): unknown => createTransport({
  host: '127.0.0.1', port, secure: false, ignoreTLS: true,
  auth: { user: 'me@example.com', pass }, connectionTimeout: 3_000, socketTimeout: 3_000,
});
/** The same, made the way sendMail makes its own: given the watch that tells it when the message has gone. */
const watchedTransportTo = (port: number): unknown => (watch: { logger: unknown }) => createTransport({
  host: '127.0.0.1', port, secure: false, ignoreTLS: true, logger: watch.logger,
  auth: { user: 'me@example.com', pass: 'app-pw' }, connectionTimeout: 3_000, socketTimeout: 3_000,
} as Parameters<typeof createTransport>[0]);

const mailbox = (overrides: Partial<Account> = {}): Account => ({
  name: 'personal', provider: 'imap', username: 'me@example.com', host: '127.0.0.1', port: 993,
  auth: 'password', password: 'app-pw', folders: ['INBOX'], useSsl: true, ...overrides,
});

const letter = (overrides: Partial<OutgoingMail> = {}): OutgoingMail => ({
  to: ['mia@example.org'], subject: 'Hello', text: 'See you there.', ...overrides,
});

async function failure(attempt: Promise<unknown>): Promise<SendError> {
  try {
    await attempt;
  } catch (error) {
    expect(error).toBeInstanceOf(SendError);
    return error as SendError;
  }
  throw new Error('expected the send to fail');
}

const firstAccount = (): Account => loadConfig().accounts[0]!;

describe('sending', () => {
  it('hands the server exactly the message it returns, from the mailbox itself', async () => {
    const { port, sessions } = await serving();
    const text = '好的，我会参加。\n\n.a line that starts with a dot\nSee you on Saturday.';
    const sent = await sendMail(mailbox({ fromName: '小林' }), {
      to: ['mia@example.org'], cc: ['sam@example.org'], bcc: ['hidden@example.org'],
      subject: '回复：周六聚餐',
      text,
      inReplyTo: '<original@example.org>',
      references: ['<first@example.org>', '<original@example.org>'],
    }, { transport: transportTo(port) });

    const session = sessions[0]!;
    expect(session.auth).toEqual({ user: 'me@example.com', pass: 'app-pw' });
    expect(session.from).toBe('me@example.com');
    // Bcc is in the envelope, which is how it is delivered...
    expect(session.to).toEqual(['mia@example.org', 'sam@example.org', 'hidden@example.org']);
    expect(sent.accepted).toEqual(['mia@example.org', 'sam@example.org', 'hidden@example.org']);
    expect(sent.rejected).toEqual([]);

    // The bytes returned for the Sent copy are the bytes the server received.
    expect(session.data).toBeDefined();
    expect(sent.raw.equals(session.data!)).toBe(true);
    const wire = sent.raw.toString('latin1');
    expect(/(?<!\r)\n/.test(wire)).toBe(false);
    // ...and nowhere in what the other recipients receive.
    expect(wire).not.toMatch(/^Bcc:/im);
    expect(wire).not.toContain('hidden@example.org');
    // A Chinese subject and name travel as encoded words, not raw bytes.
    expect(wire).toMatch(/^Subject: =\?UTF-8\?/m);
    expect(wire).toMatch(/^From: =\?UTF-8\?[BQ]\?[^?]+\?= <me@example\.com>/m);

    const parsed = await simpleParser(session.data!);
    expect(parsed.from?.value[0]).toMatchObject({ address: 'me@example.com', name: '小林' });
    expect(parsed.subject).toBe('回复：周六聚餐');
    expect(parsed.inReplyTo).toBe('<original@example.org>');
    expect(parsed.references).toEqual(['<first@example.org>', '<original@example.org>']);
    expect(parsed.text?.trim()).toBe(text);
    expect(parsed.messageId).toBe(sent.messageId);
    expect(sent.messageId).toMatch(/^<[^\s<>]+@example\.com>$/);
  });

  it('sends as the mailbox whatever the caller would like the mail to say', async () => {
    const { port, sessions } = await serving();
    const forged = { ...letter(), from: 'ceo@example.org', sender: 'ceo@example.org' } as OutgoingMail;
    const sent = await sendMail(mailbox(), forged, { transport: transportTo(port) });
    expect(sessions[0]!.from).toBe('me@example.com');
    const parsed = await simpleParser(sent.raw);
    expect(parsed.from?.value).toEqual([expect.objectContaining({ address: 'me@example.com' })]);
    expect(sent.raw.toString('latin1')).not.toContain('ceo@example.org');
  });

  it('delivers once to an address named twice', async () => {
    const { port, sessions } = await serving();
    await sendMail(mailbox(), letter({
      to: ['mia@example.org', 'MIA@example.org'], cc: ['mia@example.org', 'sam@example.org'], bcc: ['sam@example.org'],
    }), { transport: transportTo(port) });
    expect(sessions[0]!.to).toEqual(['mia@example.org', 'sam@example.org']);
  });

  it('lists the recipients a server refused, and fails when it refuses them all', async () => {
    const { port } = await serving({ reject: ['gone@example.org'] });
    const partial = await sendMail(
      mailbox(), letter({ to: ['mia@example.org', 'gone@example.org'] }), { transport: transportTo(port) },
    );
    expect(partial.accepted).toEqual(['mia@example.org']);
    expect(partial.rejected).toEqual(['gone@example.org']);

    const refused = await failure(sendMail(mailbox(), letter({ to: ['gone@example.org'] }), { transport: transportTo(port) }));
    expect(refused.code).toBe('rejected');
    expect(refused.responseCode).toBe(550);
    expect(refused.detail).toContain('no such user');
  });

  it('tells a refused sign-in from a refused message from a server that is not there', async () => {
    const { port, sessions } = await serving();
    const signIn = await failure(sendMail(mailbox(), letter(), { transport: transportTo(port, 'wrong') }));
    expect(signIn.code).toBe('auth');
    expect(signIn.responseCode).toBe(535);
    // Nothing was offered to a server that did not let us in.
    expect(sessions[0]!.from).toBeUndefined();

    const filtering = await serving({ refuseData: true });
    const content = await failure(sendMail(mailbox(), letter(), { transport: transportTo(filtering.port) }));
    expect(content.code).toBe('rejected');
    expect(content.responseCode).toBe(554);

    const closed = await startServer();
    await closed.close();
    // The line went dead before any message was offered: certainly not sent.
    const early = await serving({ dropAtMail: true });
    expect((await failure(sendMail(mailbox(), letter(), { transport: watchedTransportTo(early.port) }))).code).toBe('connection');
    // The line went dead after the server had the whole message: it may well have been sent,
    // and saying "could not be reached" would invite sending it twice.
    const late = await serving({ dropAfterData: true });
    const unsure = await failure(sendMail(mailbox(), letter(), { transport: watchedTransportTo(late.port) }));
    expect(unsure.code).toBe('unknown');
    expect(late.sessions[0]!.data).toBeDefined();
    // A refusal after the message is still a refusal: the server said no.
    const filtered = await serving({ refuseData: true });
    expect((await failure(sendMail(mailbox(), letter(), { transport: watchedTransportTo(filtered.port) }))).code).toBe('rejected');
    // And a message that went through is simply sent, with the copy for Sent keeping its Bcc line.
    const fine = await serving();
    const sent = await sendMail(mailbox(), letter({ bcc: ['quiet@example.org', 'also@example.org'] }), { transport: watchedTransportTo(fine.port) });
    expect(sent.raw.equals(fine.sessions[0]!.data!)).toBe(true);
    expect(sent.raw.toString('latin1')).not.toMatch(/^Bcc:/im);
    expect(fine.sessions[0]!.to).toEqual(expect.arrayContaining(['quiet@example.org', 'also@example.org']));
    const copy = await simpleParser(sent.copy);
    expect(addressesOf(copy.bcc)).toEqual(['quiet@example.org', 'also@example.org']);
    expect(copy.messageId).toBe(sent.messageId);
    expect(sent.copy.subarray(sent.copy.length - sent.raw.length).equals(sent.raw)).toBe(true);
    // No Bcc, no difference.
    const plain = await sendMail(mailbox(), letter(), { transport: watchedTransportTo(fine.port) });
    expect(plain.copy.equals(plain.raw)).toBe(true);

    const unreachable = await failure(sendMail(mailbox(), letter(), { transport: transportTo(closed.port) }));
    expect(unreachable.code).toBe('connection');
  });
});

describe('what may be sent', () => {
  it('refuses a recipient that is anything but one plain address, before connecting', async () => {
    const { port, sessions } = await serving();
    const transport = transportTo(port);
    for (const bad of [
      'mia@example.org\r\nBcc: evil@example.org',
      'mia@example.org\nX-Injected: 1',
      'mia@example.org, sam@example.org',
      'mia@example.org;sam@example.org',
      'Mia <mia@example.org>',
      '<mia@example.org>',
      'mia @example.org',
      'mia@example',
      'mia',
      '',
      `${'a'.repeat(250)}@example.org`,
    ]) {
      const refused = await failure(sendMail(mailbox(), letter({ to: [bad] }), { transport }));
      expect(refused.code, JSON.stringify(bad)).toBe('invalid');
      const copied = await failure(sendMail(mailbox(), letter({ cc: [bad] }), { transport }));
      expect(copied.code, JSON.stringify(bad)).toBe('invalid');
    }
    expect(sessions).toHaveLength(0);
    expect(isSendableAddress("o'brien+notes@mail.example.org")).toBe(true);
    expect(isSendableAddress('用户@例子.中国')).toBe(true);
  });

  it('wants someone to send to, and not a crowd', async () => {
    const { port, sessions } = await serving();
    const transport = transportTo(port);
    expect((await failure(sendMail(mailbox(), letter({ to: [] }), { transport }))).code).toBe('invalid');
    const crowd = Array.from({ length: 51 }, (_, n) => `person${n}@example.org`);
    expect((await failure(sendMail(mailbox(), letter({ to: crowd }), { transport }))).code).toBe('invalid');
    expect((await failure(sendMail(mailbox(), letter({ to: crowd.slice(0, 30), bcc: crowd.slice(30) }), { transport }))).code)
      .toBe('invalid');
    expect(sessions).toHaveLength(0);
    await sendMail(mailbox(), letter({ to: crowd.slice(0, 50) }), { transport });
    expect(sessions[0]!.to).toHaveLength(50);
  });

  it('keeps a subject on one line, so it cannot bring a header of its own', async () => {
    const { port, sessions } = await serving();
    const sent = await sendMail(
      mailbox(), letter({ subject: 'Hello\r\nBcc: evil@example.org\r\n\r\nand a body' }), { transport: transportTo(port) },
    );
    expect(sessions[0]!.to).toEqual(['mia@example.org']);
    const parsed = await simpleParser(sent.raw);
    expect(parsed.subject).toBe('Hello Bcc: evil@example.org and a body');
    expect(parsed.bcc).toBeUndefined();
    expect(parsed.text?.trim()).toBe('See you there.');
  });

  it('drops a reference that is not a message id instead of writing it', async () => {
    const { port } = await serving();
    const sent = await sendMail(mailbox(), letter({
      inReplyTo: '<a@example.org>\r\nBcc: evil@example.org',
      references: ['<ok@example.org>', 'two words', '<x@example.org>\nX-Injected: 1', 'bare@example.org'],
    }), { transport: transportTo(port) });
    const wire = sent.raw.toString('latin1');
    expect(wire).not.toMatch(/^In-Reply-To:/im);
    expect(wire).not.toContain('evil@example.org');
    expect(wire).not.toContain('X-Injected');
    expect((await simpleParser(sent.raw)).references).toEqual(['<ok@example.org>', '<bare@example.org>']);
  });

  it('bounds the subject and the text', async () => {
    const { port, sessions } = await serving();
    const transport = transportTo(port);
    expect((await failure(sendMail(mailbox(), letter({ subject: 'x'.repeat(999) }), { transport }))).code).toBe('invalid');
    expect((await failure(sendMail(mailbox(), letter({ text: 'x'.repeat(500_001) }), { transport }))).code).toBe('invalid');
    expect(sessions).toHaveLength(0);
  });
});

describe('whether a mailbox can send', () => {
  it('knows each provider\'s submission server', () => {
    const expected: Array<[line: string, host: string, port: number]> = [
      ['gmail_pw|me@gmail.com|pw', 'smtp.gmail.com', 465],
      ['qq|me@qq.com|pw', 'smtp.qq.com', 465],
      ['qq_biz|me@corp.example|pw', 'smtp.exmail.qq.com', 465],
      ['163|me@163.com|pw', 'smtp.163.com', 465],
      ['126|me@126.com|pw', 'smtp.126.com', 465],
      ['icloud|me@icloud.com|pw', 'smtp.mail.me.com', 587],
    ];
    for (const [line, host, port] of expected) {
      process.env.MAIL_ACCOUNT_1 = line;
      expect(sendingStatus(firstAccount()), line).toEqual({ available: true, host, port });
    }
  });

  it('sends for Gmail over its OAuth authorization, which covers SMTP', () => {
    process.env.MAIL_ACCOUNT_1 = 'gmail|me@gmail.com';
    // Decided from the scope alone, so it does not wait for the client id.
    expect(sendingStatus(firstAccount())).toEqual({ available: true, host: 'smtp.gmail.com', port: 465 });
    process.env.GMAIL_CLIENT_ID = 'client-id';
    expect(sendingStatus(firstAccount())).toEqual({ available: true, host: 'smtp.gmail.com', port: 465 });
    expect(smtpTransportOptions(firstAccount(), 'ya29.token').auth)
      .toEqual({ type: 'OAuth2', user: 'me@gmail.com', accessToken: 'ya29.token' });
  });

  it('says an Outlook authorization does not cover sending, rather than failing at sign-in', async () => {
    process.env.MAIL_ACCOUNT_1 = 'outlook|me@outlook.com';
    const unavailable = { available: false, reason: 'oauth_scope', host: 'smtp-mail.outlook.com', port: 587 };
    expect(sendingStatus(firstAccount())).toEqual(unavailable);
    process.env.OUTLOOK_CLIENT_ID = 'client-id';
    expect(sendingStatus(firstAccount())).toEqual(unavailable);
    const refused = await failure(sendMail(firstAccount(), letter()));
    expect(refused.code).toBe('not_configured');
    expect(refused.message).toContain('SMTP');

    // Authorized again with `npm run oauth -- --send`: the token file now says so.
    const dir = mkdtempSync(join(tmpdir(), 'mailsift-smtp-scope-'));
    process.env.TOKEN_STORE_PATH = join(dir, 'tokens.json');
    try {
      const record = { refreshToken: 'r', accessToken: 'a', expiresAt: 1 };
      writeFileSync(process.env.TOKEN_STORE_PATH, JSON.stringify({ 'me@outlook.com': record }));
      expect(sendingStatus(firstAccount())).toEqual(unavailable);
      writeFileSync(process.env.TOKEN_STORE_PATH, JSON.stringify({
        'me@outlook.com': { ...record, scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access' },
      }));
      // A changed file is read again; the cache is keyed on its modification time.
      utimesSync(process.env.TOKEN_STORE_PATH, new Date(), new Date(Date.now() + 5_000));
      expect(sendingStatus(firstAccount())).toEqual({ available: true, host: 'smtp-mail.outlook.com', port: 587 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // The decision is the scope: IMAP alone is not enough for Microsoft.
    expect(scopeAllowsSending('outlook_oauth', 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access')).toBe(false);
    expect(scopeAllowsSending(
      'outlook_oauth', 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access',
    )).toBe(true);
    expect(scopeAllowsSending('gmail_oauth', 'https://mail.google.com/')).toBe(true);
    expect(scopeAllowsSending('gmail_oauth', 'https://www.googleapis.com/auth/gmail.readonly')).toBe(false);
  });

  it('needs to be told the server of a mailbox on a host of its own', async () => {
    process.env.MAIL_ACCOUNT_1 = 'imap|me@corp.example|pw|mail.corp.example';
    expect(sendingStatus(firstAccount())).toEqual({ available: false, reason: 'no_smtp' });
    expect((await failure(sendMail(firstAccount(), letter()))).code).toBe('not_configured');
    expect(() => smtpTransportOptions(firstAccount())).toThrow(SendError);

    process.env.MAIL_ACCOUNT_1_SMTP_HOST = 'smtp.corp.example';
    expect(sendingStatus(firstAccount())).toEqual({ available: true, host: 'smtp.corp.example', port: 465 });
    process.env.MAIL_ACCOUNT_1_SMTP_PORT = '587';
    expect(sendingStatus(firstAccount())).toEqual({ available: true, host: 'smtp.corp.example', port: 587 });
    process.env.MAIL_ACCOUNT_1_SMTP_PORT = 'submission';
    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/SMTP_PORT/);
  });

  it('does not offer a password to a provider the mailbox is not on', () => {
    // A familiar preset pointed at another IMAP host: a self-hosted server, or
    // the preview's fixtures on a closed local port.
    process.env.MAIL_ACCOUNT_1 = 'qq|me@qq.com|fixture|127.0.0.1';
    expect(sendingStatus(firstAccount())).toEqual({ available: false, reason: 'no_smtp' });
    process.env.MAIL_ACCOUNT_1_SMTP_HOST = 'smtp.qq.com';
    expect(sendingStatus(firstAccount())).toMatchObject({ available: true, host: 'smtp.qq.com' });
  });

  it('has nothing to send from when the login is not an address', async () => {
    process.env.MAIL_ACCOUNT_1 = 'imap|john|pw|mail.corp.example';
    process.env.MAIL_ACCOUNT_1_SMTP_HOST = 'smtp.corp.example';
    expect(sendingStatus(firstAccount())).toEqual({ available: false, reason: 'no_smtp' });
    const { port, sessions } = await serving();
    const refused = await failure(sendMail(firstAccount(), letter(), { transport: transportTo(port) }));
    expect(refused.code).toBe('not_configured');
    expect(sessions).toHaveLength(0);
  });

  it('can be switched off for every mailbox at once', async () => {
    const { port, sessions } = await serving();
    process.env.MAIL_ACCOUNT_1 = 'qq|me@qq.com|pw';
    expect(sendingStatus(firstAccount()).available).toBe(true);
    for (const [key, value] of [['SMTP_ENABLED', 'false'], ['SMTP_ENABLED', '0'], ['DRY_RUN', 'true']] as const) {
      process.env[key] = value;
      // Its own reason: what to do about it is not what to do about a server nobody named.
      expect(sendingStatus(firstAccount()), `${key}=${value}`).toEqual({ available: false, reason: 'disabled' });
      // Even a connection handed in is not used.
      const refused = await failure(sendMail(mailbox(), letter(), { transport: transportTo(port) }));
      expect(refused.code).toBe('not_configured');
      delete process.env[key];
    }
    expect(sessions).toHaveLength(0);
  });

  it('never talks to a server without TLS, and gives up on one that does not answer', () => {
    process.env.MAIL_ACCOUNT_1 = 'gmail_pw|me@gmail.com|app-password';
    expect(smtpTransportOptions(firstAccount())).toMatchObject({
      host: 'smtp.gmail.com', port: 465, secure: true, requireTLS: false,
      auth: { user: 'me@gmail.com', pass: 'app-password' },
      connectionTimeout: 15_000, socketTimeout: 30_000,
    });
    process.env.MAIL_ACCOUNT_1 = 'icloud|me@icloud.com|app-password';
    expect(smtpTransportOptions(firstAccount())).toMatchObject({
      host: 'smtp.mail.me.com', port: 587, secure: false, requireTLS: true,
    });
    // This machine's name stays out of the greeting, and so out of the message's trail.
    expect(smtpTransportOptions(firstAccount()).name).toBe('[127.0.0.1]');
  });

  it('knows which providers keep their own copy in Sent', () => {
    const saves = (line: string): boolean => {
      process.env.MAIL_ACCOUNT_1 = line;
      return savesSentCopy(firstAccount());
    };
    expect(saves('gmail_pw|me@gmail.com|pw')).toBe(true);
    expect(saves('gmail|me@gmail.com')).toBe(true);
    expect(saves('outlook|me@outlook.com')).toBe(true);
    expect(saves('qq|me@qq.com|pw')).toBe(true);
    expect(saves('icloud|me@icloud.com|pw')).toBe(false);
    expect(saves('163|me@163.com|pw')).toBe(false);
    expect(saves('imap|me@corp.example|pw|mail.corp.example')).toBe(false);
    // Through another server, the provider never sees the message to file it.
    process.env.MAIL_ACCOUNT_1_SMTP_HOST = 'relay.corp.example';
    expect(saves('qq|me@qq.com|pw')).toBe(false);
  });
});

describe('replying', () => {
  const original = (overrides: Partial<ReplyOriginal> = {}): ReplyOriginal => ({
    from: { name: 'Mia Chen', address: 'mia@example.org' },
    to: [{ name: 'Me', address: 'me@example.com' }, { name: 'Sam', address: 'sam@example.org' }],
    cc: [{ name: '', address: 'lee@example.org' }, { name: 'Other me', address: 'Me@Work.example' }],
    replyTo: [],
    subject: 'Dinner on Saturday?',
    date: '2026-11-03T10:00:00.000Z',
    messageId: '<original@example.org>',
    references: ['<first@example.org>'],
    text: 'Are you coming?\n\nMia',
    ...overrides,
  });
  const self = ['me@example.com', 'me@work.example'];

  it('answers the sender, under one Re:, quoting what they wrote', () => {
    const reply = replyEnvelope(original(), self, 'reply');
    expect(reply.to).toEqual(['mia@example.org']);
    expect(reply.cc).toEqual([]);
    expect(reply.subject).toBe('Re: Dinner on Saturday?');
    expect(reply.inReplyTo).toBe('<original@example.org>');
    expect(reply.references).toEqual(['<first@example.org>', '<original@example.org>']);
    const lines = reply.quoted.split('\n');
    expect(lines[0]).toMatch(/^On .*2026.*, Mia Chen <mia@example\.org> wrote:$/);
    expect(lines.slice(1)).toEqual(['> Are you coming?', '>', '> Mia']);
  });

  it('goes where the sender asked for answers', () => {
    const reply = replyEnvelope(
      original({ replyTo: [{ name: 'Desk', address: 'desk@example.org' }] }), self, 'reply',
    );
    expect(reply.to).toEqual(['desk@example.org']);
  });

  it('copies everyone else on a reply to all, and none of the owner\'s own mailboxes', () => {
    const reply = replyEnvelope(original(), self, 'replyAll');
    expect(reply.to).toEqual(['mia@example.org']);
    expect(reply.cc).toEqual(['sam@example.org', 'lee@example.org']);
    // Someone on both lines, or already being answered, is addressed once.
    const repeated = replyEnvelope(original({
      to: [{ name: '', address: 'MIA@example.org' }, { name: '', address: 'sam@example.org' }],
      cc: [{ name: '', address: 'Sam@Example.org' }],
    }), self, 'replyAll');
    expect(repeated.cc).toEqual(['sam@example.org']);
  });

  it('continues a message the owner sent to the people it went to', () => {
    const own = replyEnvelope(original({ from: { name: 'Me', address: 'me@example.com' } }), self, 'reply');
    expect(own.to).toEqual(['sam@example.org']);
    expect(own.addressedTo).toBe('ownRecipients');
    expect(replyEnvelope(original(), self, 'reply').addressedTo).toBe('sender');
    expect(replyEnvelope(original({ replyTo: [{ name: '', address: 'desk@example.org' }] }), self, 'reply').addressedTo).toBe('replyTo');
  });

  it('answers the sender when the message asks for answers only at the owner\'s own address', () => {
    // From the boss, to the owner and to everyone, answers asked for at the owner's address: a
    // private answer goes to the boss, not to the whole list.
    const message = original({
      from: { name: 'Boss', address: 'boss@corp.example' },
      to: [{ name: 'Me', address: 'me@example.com' }, { name: 'All', address: 'all-staff@corp.example' }],
      cc: [],
      replyTo: [{ name: 'Me', address: 'ME@example.com' }],
    });
    expect(replyEnvelope(message, self, 'reply')).toMatchObject({ to: ['boss@corp.example'], cc: [], addressedTo: 'sender' });
    // A reply to all still copies the others, and still never the owner.
    expect(replyEnvelope(message, self, 'replyAll')).toMatchObject({ to: ['boss@corp.example'], cc: ['all-staff@corp.example'] });
    // The owner not named among the recipients changes nothing: a message that reached them
    // through a list, an alias or a Bcc is still answered to its sender, never to the list.
    const throughList = original({
      from: { name: 'Boss', address: 'boss@corp.example' },
      to: [{ name: '', address: 'all-staff@corp.example' }], cc: [],
      replyTo: [{ name: 'Me', address: 'me@example.com' }],
    });
    expect(replyEnvelope(throughList, self, 'reply')).toMatchObject({ to: ['boss@corp.example'], cc: [], addressedTo: 'sender' });
    expect(replyEnvelope(throughList, self, 'replyAll')).toMatchObject({ to: ['boss@corp.example'], cc: ['all-staff@corp.example'] });
    // A Reply-To that names nothing usable is no instruction either.
    expect(replyEnvelope(original({ replyTo: [{ name: '', address: 'undisclosed-recipients:;' }] }), self, 'reply').to).toEqual(['mia@example.org']);
  });

  it('leaves a subject that is already a reply alone', () => {
    for (const subject of ['Re: Dinner', 'RE: Dinner', 're:Dinner', '回复：周六聚餐', '回复: 周六聚餐', '答复: 周六聚餐']) {
      expect(replyEnvelope(original({ subject }), self, 'reply').subject, subject).toBe(subject);
    }
    expect(replyEnvelope(original({ subject: 'Regarding dinner' }), self, 'reply').subject).toBe('Re: Regarding dinner');
    expect(replyEnvelope(original({ subject: '' }), self, 'reply').subject).toBe('Re:');
    expect(replyEnvelope(original({ subject: 'Hi\r\nBcc: evil@example.org' }), self, 'reply').subject)
      .toBe('Re: Hi Bcc: evil@example.org');
  });

  it('words the attribution in the reader\'s language, in the forms mailsift itself strips', () => {
    const english = replyEnvelope(original(), self, 'reply', 'en').quoted.split('\n');
    const chinese = replyEnvelope(original(), self, 'reply', 'zh-CN').quoted.split('\n');
    expect(chinese[0]).toMatch(/^在 .*2026.*，Mia Chen <mia@example\.org> 写道：$/);
    // When this reply is answered in turn, the quote is recognised and left out of triage.
    expect(findQuoteStart(['Sounds good.', '', ...english])).toBe(2);
    expect(findQuoteStart(['好的。', '', ...chinese])).toBe(2);
    const undated = replyEnvelope(original({ date: null }), self, 'reply', 'zh-CN').quoted.split('\n')[0];
    expect(undated).toBe('Mia Chen <mia@example.org> 写道：');
    const nameless = replyEnvelope(original({ from: null, date: 'not a date' }), self, 'reply').quoted.split('\n')[0];
    expect(nameless).toBe('the sender wrote:');
  });

  it('addresses nothing the original\'s headers made up', () => {
    const reply = replyEnvelope(original({
      from: { name: 'Mia', address: 'mia@example.org\r\nBcc: evil@example.org' },
      to: [{ name: '', address: 'sam@example.org, evil@example.org' }, { name: '', address: 'lee@example.org' }],
      cc: [{ name: '', address: 'undisclosed-recipients:;' }],
      messageId: '<original@example.org>\r\nX-Injected: 1',
      references: ['<first@example.org>', 'two words'],
    }), self, 'replyAll');
    // No usable sender: reply all falls to the people the message went to, and says so...
    expect(reply.to).toEqual(['lee@example.org']);
    expect(reply.addressedTo).toBe('recipients');
    // ...and a plain reply is left for the person to address.
    expect(replyEnvelope(original({ from: { name: '', address: 'not an address' }, replyTo: [] }), self, 'reply'))
      .toMatchObject({ to: [], addressedTo: 'recipients' });
    expect(reply.cc).toEqual([]);
    expect(reply.inReplyTo).toBeUndefined();
    expect(reply.references).toEqual(['<first@example.org>']);
  });

  it('keeps the thread chain and the quote to a size worth sending', () => {
    const chain = Array.from({ length: 40 }, (_, n) => `<m${n}@example.org>`);
    const reply = replyEnvelope(original({ references: chain, text: 'x'.repeat(60_000) }), self, 'reply');
    expect(reply.references).toHaveLength(20);
    expect(reply.references.at(-1)).toBe('<original@example.org>');
    expect(reply.references[0]).toBe('<m21@example.org>');
    const lines = reply.quoted.split('\n');
    expect(lines.at(-1)).toBe('> […]');
    expect(reply.quoted.length).toBeLessThan(51_000);
  });

  it('threads onto the original when the reply is sent', async () => {
    const { port, sessions } = await serving();
    const reply = replyEnvelope(original(), self, 'replyAll', 'zh-CN');
    const sent = await sendMail(mailbox(), {
      to: reply.to, cc: reply.cc, subject: reply.subject,
      text: `我会来。\n\n${reply.quoted}`,
      ...(reply.inReplyTo ? { inReplyTo: reply.inReplyTo } : {}),
      references: reply.references,
    }, { transport: transportTo(port) });
    expect(sessions[0]!.to).toEqual(['mia@example.org', 'sam@example.org', 'lee@example.org']);
    const parsed = await simpleParser(sent.raw);
    expect(parsed.inReplyTo).toBe('<original@example.org>');
    expect(parsed.references).toEqual(['<first@example.org>', '<original@example.org>']);
    expect(parsed.subject).toBe('Re: Dinner on Saturday?');
    expect(parsed.text).toContain('> Are you coming?');
  });
});

describe('carrying files', () => {
  it('sends each file byte for byte, in what the server receives and in the copy for Sent', async () => {
    const { port, sessions } = await serving();
    // Bytes a line-end rewrite would ruin, and a text file with bare line ends of its own.
    const binary = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x0d, 0x0a, 0x00, 0x0a, 0x0d, 0xff, 0xfe]);
    const notes = Buffer.from('first line\nsecond line\n.a dot\n', 'utf8');
    const sent = await sendMail(mailbox(), letter({
      bcc: ['quiet@example.org'],
      attachments: [
        { filename: '季度报告.pdf', content: binary, contentType: 'application/pdf' },
        { filename: 'notes.txt', content: notes, contentType: 'text/plain' },
      ],
    }), { transport: transportTo(port) });

    expect(sent.raw.equals(sessions[0]!.data!)).toBe(true);
    for (const raw of [sent.raw, sent.copy]) {
      const parsed = await simpleParser(raw);
      expect(parsed.text?.trim()).toBe('See you there.');
      expect(parsed.attachments.map((file) => [file.filename, file.contentType, file.contentDisposition])).toEqual([
        ['季度报告.pdf', 'application/pdf', 'attachment'],
        ['notes.txt', 'text/plain', 'attachment'],
      ]);
      expect(parsed.attachments[0]!.content.equals(binary)).toBe(true);
      expect(parsed.attachments[1]!.content.equals(notes)).toBe(true);
    }
    // The copy is the same message with its Bcc line, files and all.
    expect(addressesOf((await simpleParser(sent.copy)).bcc)).toEqual(['quiet@example.org']);
    expect(sent.copy.subarray(sent.copy.length - sent.raw.length).equals(sent.raw)).toBe(true);
  });

  it('sends a file under a plain name and a real type, whatever it was given', async () => {
    const { port } = await serving();
    const sent = await sendMail(mailbox(), letter({
      attachments: [
        { filename: 'x\r\nBcc: evil@example.org\r\n.pdf', content: Buffer.from('a'), contentType: 'text/html\r\nX-Injected: 1' },
        { filename: '../../etc/passwd', content: Buffer.from('b'), contentType: 'Image/PNG' },
      ],
    }), { transport: transportTo(port) });
    const wire = sent.raw.toString('latin1');
    expect(wire).not.toMatch(/^Bcc:/im);
    expect(wire).not.toMatch(/^X-Injected/im);
    const parsed = await simpleParser(sent.raw);
    expect(parsed.bcc).toBeUndefined();
    expect(parsed.attachments.map((file) => file.filename)).toEqual(['xBcc: evil@example.org.pdf', 'passwd']);
    // As written: a reader guesses a type from the name when told only that it is bytes.
    expect(wire.match(/^Content-Type: (?!multipart|text\/plain)[^;\r\n]+/gim)).toEqual([
      'Content-Type: application/octet-stream', 'Content-Type: image/png',
    ]);
  });

  it('cleans a file name down to a name, and shortens a long one before its extension', () => {
    expect(attachmentFilename('C:\\Users\\me\\Q3 report.pdf')).toBe('Q3 report.pdf');
    expect(attachmentFilename('../../etc/passwd')).toBe('passwd');
    expect(attachmentFilename('a\u0000b\r\n\t.txt')).toBe('ab.txt');
    // Text turned around to make a program look like a document.
    expect(attachmentFilename('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
    expect(attachmentFilename('e\u0301te\u0301.txt')).toBe('\u00e9t\u00e9.txt');
    for (const nothing of ['', '   ', '.', '..', 'folder/', undefined, null, 42]) {
      expect(attachmentFilename(nothing), String(nothing)).toBe('attachment');
    }
    const long = attachmentFilename(`${'x'.repeat(300)}.pdf`);
    expect(Array.from(long)).toHaveLength(180);
    expect(long.endsWith('x.pdf')).toBe(true);
    expect(attachmentFilename('y'.repeat(300))).toBe('y'.repeat(180));
    // Characters, not halves of them.
    const wide = attachmentFilename(`${'\u{1F600}'.repeat(200)}.png`);
    expect(Array.from(wide)).toHaveLength(180);
    expect(wide.isWellFormed()).toBe(true);
    expect(wide.endsWith('.png')).toBe(true);
  });

  it('keeps a type only when it is one type and nothing else', () => {
    expect(attachmentContentType('application/PDF')).toBe('application/pdf');
    expect(attachmentContentType(' image/svg+xml ')).toBe('image/svg+xml');
    expect(attachmentContentType('application/vnd.openxmlformats-officedocument.wordprocessingml.document'))
      .toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    for (const odd of ['', 'pdf', 'text/plain; charset=utf-8', 'text/html\r\nX: 1', '/x', 'a/', '-a/b', 'a b/c', undefined, 7]) {
      expect(attachmentContentType(odd), String(odd)).toBe('application/octet-stream');
    }
    // A type that makes the file a container, or a piece of a message, is bytes; a whole message is one.
    for (const container of ['multipart/related', 'Multipart/Mixed', 'multipart/appledouble', 'message/partial', 'message/external-body']) {
      expect(attachmentContentType(container), container).toBe('application/octet-stream');
    }
    expect(attachmentContentType('message/rfc822')).toBe('message/rfc822');
  });

  it('sends a file whose type says it is a container as the file it is, not as an empty part', async () => {
    const { port, sessions } = await serving();
    // A page saved by Chrome as one file: the browser calls it multipart/related.
    const page = Buffer.from('From: <Saved by Blink>\r\nContent-Type: multipart/related; boundary="x"\r\n\r\n--x\r\n\r\n<p>hi</p>\r\n--x--\r\n');
    const pieces = Buffer.from([0x00, 0x05, 0x16, 0x07, 0xff]);
    const sent = await sendMail(mailbox(), letter({
      attachments: [
        { filename: 'Saved page.mhtml', content: page, contentType: 'multipart/related' },
        { filename: 'Report.pages', content: pieces, contentType: 'multipart/appledouble' },
      ],
    }), { transport: transportTo(port) });
    // Labelled as bytes; a reader then goes by the name, as it does for any such file.
    expect(sent.raw.toString('latin1').match(/^Content-Type: (?!multipart\/mixed|text\/plain)[^;\r\n]+/gim)).toEqual([
      'Content-Type: application/octet-stream', 'Content-Type: application/octet-stream',
    ]);
    for (const raw of [sessions[0]!.data!, sent.copy]) {
      const parsed = await simpleParser(raw);
      expect(parsed.attachments.map((file) => [file.filename, file.contentDisposition])).toEqual([
        ['Saved page.mhtml', 'attachment'], ['Report.pages', 'attachment'],
      ]);
      expect(parsed.attachments[0]!.content.equals(page)).toBe(true);
      expect(parsed.attachments[1]!.content.equals(pieces)).toBe(true);
    }
  });

  it('labels a text file passed on in its own character set with it, and with nothing that is not one', async () => {
    const { port } = await serving();
    // "你好" in GB18030, with a line end of its own: the bytes a forward reads from the original.
    const gb = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a]);
    const sent = await sendMail(mailbox(), letter({
      attachments: [
        { filename: 'notes.txt', content: gb, contentType: 'text/plain', charset: 'GB18030' },
        { filename: 'odd.txt', content: Buffer.from('a'), contentType: 'text/plain', charset: 'utf-8\r\nX-Injected: 1' },
        { filename: 'scan.pdf', content: Buffer.from('b'), contentType: 'application/pdf', charset: 'utf-8' },
      ],
    }), { transport: transportTo(port) });
    const wire = sent.raw.toString('latin1');
    expect(wire).not.toMatch(/^X-Injected/im);
    expect(wire).toMatch(/^Content-Type: text\/plain; charset=gb18030; name=notes\.txt/im);
    expect(wire).toMatch(/^Content-Type: text\/plain; name=odd\.txt/im);
    expect(wire).toMatch(/^Content-Type: application\/pdf; name=scan\.pdf/im);
    const parsed = await simpleParser(sent.raw);
    // Byte for byte as it was: nothing converted, no line end changed.
    expect(parsed.attachments[0]!.content.equals(gb)).toBe(true);
    expect(attachmentCharset(' Shift_JIS ')).toBe('shift_jis');
    for (const odd of ['', 'a b', 'x'.repeat(41), '"utf-8"', 'utf-8;x=1', undefined, 8]) {
      expect(attachmentCharset(odd), String(odd)).toBeUndefined();
    }
  });

  it('gives a message with files the time they take to travel, and one without, none', () => {
    expect(transferAllowanceMs(0)).toBe(0);
    expect(transferAllowanceMs(-1)).toBe(0);
    expect(transferAllowanceMs(Number.NaN)).toBe(0);
    expect(transferAllowanceMs(1)).toBe(1000);
    expect(transferAllowanceMs(256 * 1024)).toBe(1000);
    expect(transferAllowanceMs(20 * 1024 * 1024)).toBe(80_000);
  });

  it('checks whom a message is for by itself, as sending does, so a caller can ask before doing anything slow', () => {
    expect(addressed({ to: ['a@example.org', 'A@example.org'], cc: ['b@example.org'], bcc: ['a@EXAMPLE.org', 'c@example.org'] }))
      .toEqual({ to: ['a@example.org'], cc: ['b@example.org'], bcc: ['c@example.org'] });
    for (const mail of [
      { to: ['bob@example'] }, { to: [] }, {}, { to: ['a@example.org'], cc: ['Ann <ann@example.org>'] },
      { to: Array.from({ length: 51 }, (_, n) => `p${n}@example.org`) }, { to: 'a@example.org' },
    ]) {
      expect(() => addressed(mail as never), JSON.stringify(mail)).toThrow(SendError);
    }
  });

  it('holds a message to a number of files and a size, before connecting', async () => {
    const { port, sessions } = await serving();
    const transport = transportTo(port);
    const file = (bytes: number) => ({ filename: 'f.bin', content: Buffer.alloc(bytes), contentType: 'application/octet-stream' });
    expect((await failure(sendMail(mailbox(), letter({ attachments: Array.from({ length: 21 }, () => file(1)) }), { transport }))).code)
      .toBe('invalid');
    process.env.SMTP_ATTACHMENT_MAX_BYTES = '10';
    const over = await failure(sendMail(mailbox(), letter({ attachments: [file(6), file(5)] }), { transport }));
    expect(over.code).toBe('invalid');
    expect(over.message).toContain('10 bytes');
    expect((await failure(sendMail(mailbox(), letter({ attachments: [{ filename: 'x', contentType: 'a/b' }] as never }), { transport }))).code)
      .toBe('invalid');
    expect(sessions).toHaveLength(0);
    await sendMail(mailbox(), letter({ attachments: [file(5), file(5)] }), { transport });
    expect(sessions).toHaveLength(1);
  });

  it('reads its limit from the setting, within a ceiling no provider would pass', () => {
    expect(attachmentLimitBytes()).toBe(20 * 1024 * 1024);
    for (const [value, expected] of [
      ['1000', 1000], ['', 20 * 1024 * 1024], ['abc', 20 * 1024 * 1024], ['0', 20 * 1024 * 1024], ['-5', 20 * 1024 * 1024],
      ['99999999999', 35 * 1024 * 1024],
    ] as const) {
      process.env.SMTP_ATTACHMENT_MAX_BYTES = value;
      expect(attachmentLimitBytes(), value).toBe(expected);
    }
    expect(describeBytes(20 * 1024 * 1024)).toBe('20 MB');
    expect(describeBytes(1536)).toBe('2 KB');
    expect(describeBytes(10)).toBe('10 bytes');
  });
});

describe('forwarding', () => {
  const original = (overrides: Partial<ForwardOriginal> = {}): ForwardOriginal => ({
    from: { name: 'Mia Chen', address: 'mia@example.org' },
    to: [{ name: 'Me', address: 'me@example.com' }, { name: '', address: 'sam@example.org' }],
    cc: [{ name: 'Lee', address: 'lee@example.org' }],
    subject: 'Dinner on Saturday?',
    date: '2026-11-03T10:00:00.000Z',
    text: 'Are you coming?\n\nMia',
    quoted: '',
    ...overrides,
  });

  it('forwards under one Fwd:, saying who it was from, when and to whom, above its text as written', () => {
    const forward = forwardEnvelope(original());
    expect(forward.subject).toBe('Fwd: Dinner on Saturday?');
    const lines = forward.forwarded.split('\n');
    expect(lines).toEqual([
      '---------- Forwarded message ----------',
      'From: Mia Chen <mia@example.org>',
      expect.stringMatching(/^Date: .*2026/),
      'Subject: Dinner on Saturday?',
      'To: Me <me@example.com>, sam@example.org',
      'Cc: Lee <lee@example.org>',
      '',
      'Are you coming?',
      '',
      'Mia',
    ]);
    // Nobody in copy, no Cc line; the history under the text comes along too.
    const plain = forwardEnvelope(original({ cc: [], quoted: '> earlier words' })).forwarded;
    expect(plain).not.toMatch(/^Cc:/m);
    expect(plain.endsWith('Mia\n\n> earlier words')).toBe(true);
  });

  it('leaves a subject that is already a forward alone', () => {
    for (const subject of ['Fwd: Dinner', 'FW: Dinner', 'fw:Dinner', 'FWD：Dinner', '转发：周六聚餐', '轉發: 周六聚餐']) {
      expect(forwardEnvelope(original({ subject })).subject, subject).toBe(subject);
    }
    expect(forwardEnvelope(original({ subject: 'Re: Dinner' })).subject).toBe('Fwd: Re: Dinner');
    expect(forwardEnvelope(original({ subject: '' })).subject).toBe('Fwd:');
  });

  it('words the header in the reader\'s language, in forms mailsift reads as a forward rather than a quote', () => {
    const chinese = forwardEnvelope(original(), 'zh-CN').forwarded.split('\n');
    expect(chinese.slice(0, 2)).toEqual(['---------- 转发的邮件 ----------', '发件人：Mia Chen <mia@example.org>']);
    expect(chinese).toContain('收件人：Me <me@example.com>, sam@example.org');
    expect(chinese).toContain('抄送：Lee <lee@example.org>');
    const english = forwardEnvelope(original()).forwarded.split('\n');
    // Under a note of the forwarder's own, the forwarded message is the point, not history to strip.
    expect(findQuoteStart(['See below.', '', ...english])).toBe(-1);
    expect(findQuoteStart(['请看下面。', '', ...chinese])).toBe(-1);
  });

  it('puts every name on one line of its own text, and leaves out what is not known', () => {
    const forward = forwardEnvelope(original({
      from: { name: 'Mia\r\nBcc: evil@example.org', address: 'mia@example.org' },
      to: [], cc: [], date: 'not a date', subject: 'Hi\r\nX-Injected: 1',
    })).forwarded.split('\n');
    expect(forward.slice(0, 4)).toEqual([
      '---------- Forwarded message ----------',
      'From: Mia Bcc: evil@example.org <mia@example.org>',
      'Subject: Hi X-Injected: 1',
      '',
    ]);
    const crowd = Array.from({ length: 60 }, (_, n) => ({ name: '', address: `p${n}@example.org` }));
    const to = forwardEnvelope(original({ to: crowd })).forwarded.split('\n').find((line) => line.startsWith('To: '))!;
    expect(to.split(', ')).toHaveLength(51);
    expect(to.endsWith(', …')).toBe(true);
  });

  it('says a list was longer than the reader kept, where the reader cut it', () => {
    // The reader keeps fifty of each; it says when there were more, and so does the forward.
    const fifty = Array.from({ length: 50 }, (_, n) => ({ name: '', address: `p${n}@example.org` }));
    const lines = forwardEnvelope(original({ to: fifty, toCut: true, cc: fifty.slice(0, 2), ccCut: true })).forwarded.split('\n');
    const to = lines.find((line) => line.startsWith('To: '))!;
    expect(to.split(', ')).toHaveLength(51);
    expect(to.endsWith('p49@example.org, …')).toBe(true);
    expect(lines.find((line) => line.startsWith('Cc: '))).toBe('Cc: p0@example.org, p1@example.org, …');
    // Exactly fifty, and nobody cut: everyone, as it was.
    expect(forwardEnvelope(original({ to: fifty })).forwarded).not.toContain('…');
  });

  it('carries the original to a size worth sending, and says where it stopped', () => {
    const forward = forwardEnvelope(original({ text: 'x'.repeat(60_000) })).forwarded;
    expect(forward.split('\n').at(-1)).toBe('[…]');
    expect(forward.length).toBeLessThan(51_000);
  });
});
