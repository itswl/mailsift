import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import './setup.js';
import { SENT_FOLDER_CLIENT, StateStore, contactMatches, type SentRecord } from '../src/services/state.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const ME = 'me@qq.com';
const OWN = [ME, 'me@gmail.com'];
const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
const MIN = 60_000;
const DAY = 86_400_000;

/** A received message, judged and stored as the poll stores one. */
function received(state: StateStore, key: string, fields: {
  messageId: string; account?: string; importance?: string; pushed?: boolean; mailDate?: string; threadKey?: string;
  category?: string; sender?: string; senderName?: string; inSpam?: boolean; verificationCode?: string; decidedBy?: string;
}): void {
  state.markSeen(key, fields.account ?? ME, `subject ${key}`);
  state.recordOutcome(key, fields.importance ?? 'critical', fields.pushed ?? true, {
    messageId: fields.messageId, threadKey: fields.threadKey ?? `${fields.account ?? ME}|${fields.messageId.toLowerCase()}`,
    mailDate: fields.mailDate ?? iso(-60 * MIN), folder: 'INBOX', sender: fields.sender ?? 'ann@example.org',
    senderName: fields.senderName ?? 'Ann', category: fields.category ?? 'Personal', inSpam: fields.inSpam ?? false,
    ...(fields.verificationCode ? { verificationCode: fields.verificationCode } : {}),
    ...(fields.decidedBy ? { decidedBy: fields.decidedBy } : {}),
  });
}

/** A sent message as the poll read it from Sent, unless said otherwise. */
function sent(overrides: Partial<SentRecord> = {}): SentRecord {
  return {
    account: ME, accountLabel: 'personal', messageId: '<out@qq.com>', threadKey: `${ME}|<q@example.org>`,
    inReplyTo: '<q@example.org>', answers: '<q@example.org>', subject: 'Re: q', fromAddr: ME,
    to: [{ name: 'Ann', address: 'ann@example.org' }], cc: [], bcc: [], date: iso(-10 * MIN), text: 'Sounds good.',
    attachmentCount: 0, attachmentNames: [], folder: 'Sent', uid: 5, uidValidity: '1', source: 'poll',
    ...overrides,
  };
}

const db = (state: StateStore) => (state as unknown as { db: import('node:sqlite').DatabaseSync }).db;

describe('storing the owner\'s sent mail', () => {
  it('keeps it apart from received mail, once per mailbox and Message-ID', () => {
    const state = new StateStore(':memory:');
    const first = state.recordSent(sent());
    expect(first.inserted).toBe(true);
    expect(state.recordSent(sent({ uid: 9 })).inserted).toBe(false);
    expect(state.sentCount()).toBe(1);
    // Never a row of the received mail: not listed, not searched, not in the queue.
    expect(state.queryMail({ search: 'Sounds' })).toEqual([]);
    expect(state.getMail('<out@qq.com>')).toBeUndefined();
    expect(state.attentionCount()).toBe(0);
    expect(state.getSent(first.id)).toMatchObject({ messageId: '<out@qq.com>', text: 'Sounds good.', source: 'poll' });
  });

  it('keeps the page\'s exact record when the poll finds the same letter in Sent, and fills in where it is', () => {
    const state = new StateStore(':memory:');
    const page = sent({
      source: 'page', folder: undefined, uid: undefined, uidValidity: undefined,
      bcc: [{ name: '', address: 'boss@qq.com' }], text: 'Exactly what was written.',
    });
    const { id } = state.recordSent(page);
    // The copy in Sent, as its headers have it: no Bcc line, its own reading of the text.
    expect(state.recordSent(sent({ bcc: [], text: 'What the bite parsed.', folder: 'Sent Messages', uid: 41 })).inserted).toBe(false);
    const row = state.getSent(id)!;
    expect(row).toMatchObject({ source: 'page', text: 'Exactly what was written.', folder: 'Sent Messages', bcc: [{ name: '', address: 'boss@qq.com' }] });
    expect(state.sentCount()).toBe(1);
  });

  it('completes a row the poll stored first with the page\'s recipients, and never holds that one against the queue', () => {
    const state = new StateStore(':memory:');
    received(state, 'k1', { messageId: '<q@example.org>' });
    state.recordSent(sent({ bcc: [] }));
    state.recordSent(sent({ source: 'page', bcc: [{ name: '', address: 'boss@qq.com' }] }));
    expect(state.answerFromSent(OWN)).toEqual([]);
    expect(state.getMail('k1')!.handledAt).toBeNull();
  });

  it('tells open pages when a new one is stored', () => {
    const state = new StateStore(':memory:');
    const before = state.changeSignature().mail;
    state.recordSent(sent());
    expect(state.changeSignature().mail).not.toBe(before);
  });
});

describe('a conversation', () => {
  it('is the thread\'s received messages and the owner\'s own, oldest first', () => {
    const state = new StateStore(':memory:');
    const thread = `${ME}|<root@example.org>`;
    received(state, 'k1', { messageId: '<root@example.org>', threadKey: thread, mailDate: iso(-3 * DAY) });
    received(state, 'k2', { messageId: '<two@example.org>', threadKey: thread, mailDate: iso(-1 * DAY) });
    state.recordSent(sent({ messageId: '<a@qq.com>', threadKey: thread, date: iso(-2 * DAY) }));
    state.recordSent(sent({ messageId: '<b@qq.com>', threadKey: thread, date: iso(-1 * MIN) }));
    state.recordSent(sent({ messageId: '<elsewhere@qq.com>', threadKey: `${ME}|<other@x>`, date: iso(-1 * MIN) }));
    const { entries, omitted } = state.conversation(state.getMail('k2')!);
    expect(omitted).toBe(0);
    expect(entries.map((e) => (e.direction === 'in' ? e.row.dedupKey : e.sent.messageId)))
      .toEqual(['k1', '<a@qq.com>', 'k2', '<b@qq.com>']);
  });

  it('is only the message itself when nothing else in its thread is stored', () => {
    const state = new StateStore(':memory:');
    received(state, 'k1', { messageId: '<alone@example.org>' });
    expect(state.conversation(state.getMail('k1')!).entries).toHaveLength(1);
  });

  it('holds at most fifty: the message itself and the newest of the rest, saying how many were left out', () => {
    const state = new StateStore(':memory:');
    const thread = `${ME}|<root@example.org>`;
    received(state, 'old', { messageId: '<root@example.org>', threadKey: thread, mailDate: iso(-90 * DAY) });
    for (let n = 0; n < 60; n += 1) {
      state.recordSent(sent({ messageId: `<s${n}@qq.com>`, threadKey: thread, date: iso(-(60 - n) * MIN) }));
    }
    const { entries, omitted } = state.conversation(state.getMail('old')!);
    expect(entries).toHaveLength(50);
    expect(omitted).toBe(11);
    expect(entries[0]).toMatchObject({ direction: 'in' });
    expect(entries.at(-1)).toMatchObject({ direction: 'out', sent: { messageId: '<s59@qq.com>' } });
  });
});

describe('threads', () => {
  it('count the owner\'s messages and say when the latest word is theirs, while the list stays the received mail', () => {
    const state = new StateStore(':memory:');
    const answered = `${ME}|<a@example.org>`;
    const waiting = `${ME}|<b@example.org>`;
    received(state, 'a', { messageId: '<a@example.org>', threadKey: answered, mailDate: iso(-2 * DAY) });
    received(state, 'b', { messageId: '<b@example.org>', threadKey: waiting, mailDate: iso(-1 * MIN) });
    state.recordSent(sent({ messageId: '<r1@qq.com>', threadKey: answered, date: iso(-1 * DAY) }));
    state.recordSent(sent({ messageId: '<r2@qq.com>', threadKey: waiting, date: iso(-1 * DAY) }));
    state.recordSent(sent({ messageId: '<only-mine@qq.com>', threadKey: `${ME}|<only-mine@qq.com>`, date: iso(-1 * MIN) }));
    const threads = state.queryThreads({ sinceHours: 72 });
    expect(threads.map((t) => t.threadKey).sort()).toEqual([answered, waiting]);
    expect(threads.find((t) => t.threadKey === answered)).toMatchObject({ messageCount: 1, sentCount: 1, lastWordYours: true });
    // Answered once, and written to again since: the latest word is theirs.
    expect(threads.find((t) => t.threadKey === waiting)).toMatchObject({ sentCount: 1, lastWordYours: false });
  });
});

describe('retention', () => {
  it('prunes sent mail with the received mail, counted from the day it was sent', () => {
    const state = new StateStore(':memory:');
    state.recordSent(sent({ messageId: '<old@qq.com>', date: iso(-100 * DAY) }));
    state.recordSent(sent({ messageId: '<recent@qq.com>', date: iso(-10 * DAY) }));
    const future = state.recordSent(sent({ messageId: '<future@qq.com>', date: iso(400 * DAY) }));
    // Dated ahead of its time, and stored long ago: it goes with what was stored then.
    db(state).prepare('UPDATE sent_mail SET created_at = ? WHERE id = ?').run(iso(-100 * DAY), future.id);
    expect(state.prune(90)).toBe(2);
    expect(state.sentInThread(`${ME}|<q@example.org>`).map((s) => s.messageId)).toEqual(['<recent@qq.com>']);
  });
});

describe('an existing database', () => {
  it('gains the new tables, indexes and column quickly, and keeps its rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mailsift-migrate-'));
    const path = join(dir, 'state.db');
    try {
      // The received-mail table as the previous release left it, with a few thousand rows.
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE seen (
        dedup_key TEXT PRIMARY KEY, account TEXT NOT NULL, account_label TEXT,
        message_id TEXT, thread_key TEXT, subject TEXT, sender TEXT, sender_name TEXT,
        folder TEXT, in_spam INTEGER NOT NULL DEFAULT 0,
        importance TEXT, category TEXT, summary TEXT, reason TEXT, deadline TEXT,
        decided_by TEXT, pushed INTEGER NOT NULL DEFAULT 0,
        mail_date TEXT, snippet TEXT, attachments_json TEXT, verification_code TEXT, handled_at TEXT,
        uid INTEGER, uid_validity TEXT, snoozed_until TEXT, created_at TEXT NOT NULL)`);
      const insert = old.prepare('INSERT INTO seen (dedup_key, account, message_id, sender, importance, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      old.exec('BEGIN');
      for (let n = 0; n < 5000; n += 1) insert.run(`${ME}|<m${n}@x>`, ME, `<m${n}@x>`, `p${n % 50}@example.org`, 'info', iso(-n * MIN));
      old.exec('COMMIT');
      old.close();

      const started = performance.now();
      const state = new StateStore(path);
      expect(performance.now() - started).toBeLessThan(3000);
      const columns = (db(state).prepare('PRAGMA table_info(seen)').all() as Array<{ name: string }>).map((c) => c.name);
      expect(columns).toContain('put_back_at');
      const names = (db(state).prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')").all() as Array<{ name: string }>)
        .map((r) => r.name);
      for (const name of ['sent_mail', 'sent_cursors', 'idx_sent_thread', 'idx_sent_answers', 'idx_seen_message_id']) {
        expect(names, name).toContain(name);
      }
      expect(state.queryMail({ limit: 200 })).toHaveLength(200);
      state.close();
      // Opened again, as every web request and the MCP process do: nothing to do twice.
      new StateStore(path).close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('answered from another client', () => {
  it('takes a message off the queue when a reply in Sent answers it, on record as that, and lists it as dealt with', () => {
    const state = new StateStore(':memory:');
    received(state, 'k1', { messageId: '<q@example.org>' });
    expect(state.attentionCount()).toBe(1);
    expect(state.answerFromSent(OWN)).toEqual([]);
    const { id } = state.recordSent(sent());
    expect(state.answerFromSent(OWN)).toEqual(['k1']);
    expect(state.getMail('k1')!.handledAt).not.toBeNull();
    expect(state.attentionCount()).toBe(0);
    expect(state.getSent(id)!.answeredKey).toBe('k1');
    expect(state.recentlyHandled().map(({ row }) => row.dedupKey)).toEqual(['k1']);
    expect(state.listMailActions()).toMatchObject([
      { account: ME, messageId: '<q@example.org>', action: 'handled', client: SENT_FOLDER_CLIENT, success: true, sourceFolder: 'INBOX' },
    ]);
    // Looked at once: nothing is handled, or written down, twice.
    expect(state.answerFromSent(OWN)).toEqual([]);
    expect(state.listMailActions()).toHaveLength(1);
  });

  it('takes off a message that was put off, as answering it in the page would', () => {
    const state = new StateStore(':memory:');
    received(state, 'k1', { messageId: '<q@example.org>' });
    state.setSnoozed('k1', iso(2 * DAY));
    state.recordSent(sent());
    expect(state.answerFromSent(OWN)).toEqual(['k1']);
    expect(state.snoozed()).toEqual([]);
  });

  it('leaves alone what the reply does not answer, or answers only the owner', () => {
    const cases: Array<[string, (state: StateStore) => void]> = [
      ['another mailbox\'s copy', (state) => state.recordSent(sent({ account: 'me@gmail.com' }))],
      ['a reply to the owner\'s own addresses only', (state) => state.recordSent(sent({
        to: [{ name: '', address: 'me@gmail.com' }], bcc: [{ name: '', address: ME }],
      }))],
      ['a reply written before the message came', (state) => state.recordSent(sent({ date: iso(-2 * DAY) }))],
      ['a reply with no date', (state) => state.recordSent(sent({ date: undefined }))],
      ['a reply to another message', (state) => state.recordSent(sent({ answers: '<other@example.org>' }))],
    ];
    for (const [what, write] of cases) {
      const state = new StateStore(':memory:');
      received(state, 'k1', { messageId: '<q@example.org>' });
      write(state);
      expect(state.answerFromSent(OWN), what).toEqual([]);
      expect(state.getMail('k1')!.handledAt, what).toBeNull();
      expect(state.listMailActions(), what).toEqual([]);
    }
  });

  it('touches nothing that is not waiting on the owner', () => {
    const state = new StateStore(':memory:');
    received(state, 'quiet', { messageId: '<quiet@example.org>', importance: 'info', pushed: false });
    received(state, 'done', { messageId: '<done@example.org>' });
    state.setHandled('done', true);
    const handledAt = state.getMail('done')!.handledAt;
    state.recordSent(sent({ messageId: '<r1@qq.com>', answers: '<quiet@example.org>' }));
    state.recordSent(sent({ messageId: '<r2@qq.com>', answers: '<done@example.org>' }));
    expect(state.answerFromSent(OWN)).toEqual([]);
    expect(state.getMail('quiet')!.handledAt).toBeNull();
    expect(state.getMail('done')!.handledAt).toBe(handledAt);
  });

  it('never takes off again a message the owner put back, unless a newer reply comes', () => {
    const state = new StateStore(':memory:');
    received(state, 'k1', { messageId: '<q@example.org>' });
    state.recordSent(sent());
    expect(state.answerFromSent(OWN)).toEqual(['k1']);
    state.setHandled('k1', false);
    expect(state.answerFromSent(OWN)).toEqual([]);
    // Read again after the put back (a folder rebuilt, the first look back): still put back.
    db(state).prepare('UPDATE sent_mail SET checked_at = NULL').run();
    expect(state.answerFromSent(OWN)).toEqual([]);
    expect(state.inAttention('k1')).toBe(true);
    // Answered again since: that answer counts.
    state.recordSent(sent({ messageId: '<again@qq.com>', date: iso(1 * MIN) }));
    expect(state.answerFromSent(OWN)).toEqual(['k1']);
  });

  it('stores a message as dealt with when an answer to it is stored already', () => {
    const state = new StateStore(':memory:');
    state.recordSent(sent({ date: iso(-5 * MIN) }));
    state.markSeen('k1', ME, 'q');
    expect(state.answerOnArrival('k1', ME, '<q@example.org>', iso(-60 * MIN), OWN)).toBe(true);
    expect(state.getMail('k1')!.handledAt).not.toBeNull();
    expect(state.listMailActions()[0]).toMatchObject({ action: 'handled', client: SENT_FOLDER_CLIENT });

    const own = new StateStore(':memory:');
    own.recordSent(sent({ to: [{ name: '', address: 'me@gmail.com' }] }));
    own.markSeen('k1', ME, 'q');
    expect(own.answerOnArrival('k1', ME, '<q@example.org>', iso(-60 * MIN), OWN)).toBe(false);

    const later = new StateStore(':memory:');
    later.recordSent(sent({ date: iso(-2 * DAY) }));
    later.markSeen('k1', ME, 'q');
    expect(later.answerOnArrival('k1', ME, '<q@example.org>', iso(-60 * MIN), OWN)).toBe(false);
    expect(later.getMail('k1')!.handledAt).toBeNull();
  });
});

describe('whom to write to', () => {
  const to = (address: string, name = ''): Array<{ name: string; address: string }> => [{ name, address }];

  it('ranks those written to by how often and how lately, then people who wrote', () => {
    const state = new StateStore(':memory:');
    for (let n = 0; n < 3; n += 1) state.recordSent(sent({ messageId: `<ann${n}@qq.com>`, to: to('ann@acme.example', 'Ann Lee'), date: iso(-n * DAY) }));
    state.recordSent(sent({ messageId: '<anand@qq.com>', to: to('anand@acme.example', 'Anand Rao'), date: iso(-1 * DAY) }));
    for (let n = 0; n < 5; n += 1) state.recordSent(sent({ messageId: `<andy${n}@qq.com>`, to: to('andy@acme.example', 'Andy'), date: iso(-(200 + n) * DAY) }));
    for (let n = 0; n < 6; n += 1) {
      received(state, `anna${n}`, { messageId: `<anna${n}@x>`, sender: 'anna@studio.example', senderName: 'Anna Berg', category: 'Personal', importance: 'info', pushed: false });
    }
    const found = state.contacts('an', 8, OWN);
    expect(found.map((c) => c.address)).toEqual(['ann@acme.example', 'anand@acme.example', 'andy@acme.example', 'anna@studio.example']);
    expect(found[0]).toMatchObject({ name: 'Ann Lee', sent: 3, source: 'sent' });
    expect(found[3]).toMatchObject({ name: 'Anna Berg', sent: 0, received: 6, source: 'received' });
  });

  it('matches the start of a word of the name, the local part or the domain, and a CJK name anywhere', () => {
    expect(contactMatches('lee', 'Ann Lee', 'ann@acme.example')).toBe(true);
    expect(contactMatches('lee ann', 'Ann Lee', 'ann@acme.example')).toBe(true);
    expect(contactMatches('smith', '', 'j.smith@acme.example')).toBe(true);
    expect(contactMatches('acme', '', 'j.smith@mail.acme.example')).toBe(true);
    expect(contactMatches('j.smith@ma', '', 'j.smith@mail.acme.example')).toBe(true);
    expect(contactMatches('mith', 'John Smith', 'js@acme.example')).toBe(false);
    expect(contactMatches('小明', '王小明', 'xm@example.cn')).toBe(true);
    expect(contactMatches('élise', 'Élise Martin', 'em@example.fr')).toBe(true);

    const state = new StateStore(':memory:');
    state.recordSent(sent({ messageId: '<1@qq.com>', to: to('xm@example.cn', '王小明') }));
    state.recordSent(sent({ messageId: '<2@qq.com>', to: to('em@example.fr', 'Élise Martin') }));
    state.recordSent(sent({ messageId: '<3@qq.com>', to: to('ANN@Acme.Example', 'Ann') }));
    expect(state.contacts('小明', 8, OWN).map((c) => c.address)).toEqual(['xm@example.cn']);
    expect(state.contacts('ÉLISE', 8, OWN).map((c) => c.address)).toEqual(['em@example.fr']);
    expect(state.contacts('ACME', 8, OWN).map((c) => c.address)).toEqual(['ann@acme.example']);
    expect(state.contacts('   ', 8, OWN)).toEqual([]);
  });

  it('suggests only people among those who wrote: not spam, bulk, codes, machines or the owner', () => {
    const state = new StateStore(':memory:');
    received(state, 'p', { messageId: '<p@x>', sender: 'pat@example.org', senderName: 'Pat', category: 'Work' });
    received(state, 's', { messageId: '<s@x>', sender: 'pam@spam.example', senderName: 'Pam', inSpam: true });
    received(state, 'm', { messageId: '<m@x>', sender: 'paul@shop.example', senderName: 'Paul', category: 'Marketing' });
    received(state, 'c', { messageId: '<c@x>', sender: 'pass@login.example', senderName: 'Passwords', verificationCode: '123456' });
    received(state, 'n', { messageId: '<n@x>', sender: 'no-reply@pay.example', senderName: 'Payments', category: 'Personal' });
    received(state, 'o', { messageId: '<o@x>', sender: 'me@gmail.com', senderName: 'Pa (me)', category: 'Personal' });
    received(state, 'f', { messageId: '<f@x>', sender: 'pay@bank.example', senderName: 'Pay', category: 'Finance' });
    // Mostly bulk, judged personal once: still bulk.
    for (const [n, category] of ['Marketing', 'Marketing', 'Personal'].entries()) {
      received(state, `b${n}`, { messageId: `<b${n}@x>`, sender: 'pablo@news.example', senderName: 'Pablo', category });
    }
    expect(state.contacts('pa', 8, OWN).map((c) => c.address)).toEqual(['pat@example.org']);
  });

  it('gives each address one name, the latest it went by, and keeps a copy to the sending mailbox out', () => {
    const state = new StateStore(':memory:');
    state.recordSent(sent({ messageId: '<1@qq.com>', to: to('ann@acme.example', 'Annie'), date: iso(-3 * DAY) }));
    state.recordSent(sent({ messageId: '<2@qq.com>', to: to('ann@acme.example', ''), bcc: to(ME), date: iso(-2 * DAY) }));
    received(state, 'k', { messageId: '<k@x>', sender: 'ann@acme.example', senderName: 'Ann Lee', mailDate: iso(-1 * DAY) });
    const found = state.contacts('ann', 8, OWN);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ address: 'ann@acme.example', name: 'Ann Lee', sent: 2, received: 1 });
    expect(state.contacts('me', 8, OWN)).toEqual([]);
  });

  it('never gives more than asked, nor more than twenty', () => {
    const state = new StateStore(':memory:');
    for (let n = 0; n < 30; n += 1) state.recordSent(sent({ messageId: `<${n}@qq.com>`, to: to(`team${n}@acme.example`) }));
    expect(state.contacts('team', 3, OWN)).toHaveLength(3);
    expect(state.contacts('team', 500, OWN)).toHaveLength(20);
  });
});
