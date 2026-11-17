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

  it('takes the copy in Sent for the letter stored as it left, under the Message-ID the provider gave it', () => {
    // Outlook and QQ give a letter sent through them a Message-ID of their own: the copy in Sent carries it,
    // and so does every answer to it. The letter is stored once, under that id.
    const state = new StateStore(':memory:');
    const left = state.recordSent(sent({
      messageId: '<ours@mailsift>', threadKey: `${ME}|<ours@mailsift>`, inReplyTo: undefined, answers: undefined,
      subject: 'Plans', date: iso(-10 * MIN), folder: undefined, uid: undefined, uidValidity: undefined, source: 'page',
    }));
    const copy = state.recordSent(sent({
      messageId: '<tencent_ABC@qq.com>', threadKey: `${ME}|<tencent_abc@qq.com>`, inReplyTo: undefined, answers: undefined,
      subject: 'Plans', date: iso(-10 * MIN + 2000), source: 'poll',
    }));
    expect(copy).toEqual({ id: left.id, inserted: false });
    expect(state.sentCount()).toBe(1);
    expect(state.getSent(left.id)).toMatchObject({ messageId: '<tencent_ABC@qq.com>', threadKey: `${ME}|<tencent_abc@qq.com>`, folder: 'Sent', source: 'page' });
    // Another letter, to someone else or about something else, is not it.
    state.recordSent(sent({ messageId: '<other@mailsift>', subject: 'Plans', to: [{ name: '', address: 'bob@example.org' }], date: iso(-5 * MIN), folder: undefined, uid: undefined, uidValidity: undefined, source: 'page' }));
    expect(state.recordSent(sent({ messageId: '<tencent_DEF@qq.com>', subject: 'Other plans', date: iso(-5 * MIN), uid: 6 })).inserted).toBe(true);
    expect(state.sentCount()).toBe(3);
  });

  it('pairs two like letters sent minutes apart each with its own copy, and makes one of letters stored twice before', () => {
    const state = new StateStore(':memory:');
    const page = (id: string, at: number) => state.recordSent(sent({
      messageId: id, threadKey: `${ME}|${id}`, subject: 'Ping', date: iso(at), folder: undefined, uid: undefined, uidValidity: undefined, source: 'page',
    }));
    const a = page('<a@mailsift>', -20 * MIN);
    const b = page('<b@mailsift>', -12 * MIN);
    expect(state.recordSent(sent({ messageId: '<B@outlook>', subject: 'Ping', date: iso(-12 * MIN + 1000), uid: 8 })).id).toBe(b.id);
    expect(state.recordSent(sent({ messageId: '<A@outlook>', subject: 'Ping', date: iso(-20 * MIN + 1000), uid: 7 })).id).toBe(a.id);
    expect(state.getSent(a.id)?.messageId).toBe('<A@outlook>');
    expect(state.getSent(b.id)?.messageId).toBe('<B@outlook>');

    // A database where an earlier release stored a letter twice: once as it left, once from Sent.
    const dir = mkdtempSync(join(tmpdir(), 'mailsift-twins-'));
    try {
      const path = join(dir, 'state.db');
      const before = new StateStore(path);
      const left = before.recordSent(sent({ messageId: '<ours@mailsift>', subject: 'Twice', date: iso(-30 * MIN), folder: undefined, uid: undefined, uidValidity: undefined, source: 'page' }));
      db(before).prepare("UPDATE sent_mail SET answered_key = 'k1' WHERE id = ?").run(left.id);
      db(before).prepare("INSERT INTO sent_mail (account, message_id, thread_key, subject, from_addr, recipients, mail_date, body, attachment_count, attachment_names, folder, uid, uid_validity, source, created_at) SELECT account, '<theirs@outlook>', thread_key, subject, from_addr, recipients, ?, body, 0, '[]', 'Sent', 9, '1', 'poll', created_at FROM sent_mail WHERE id = ?").run(iso(-30 * MIN + 3000), left.id);
      db(before).prepare("DELETE FROM meta WHERE key = 'merged_sent_twins'").run();
      expect(before.sentCount()).toBe(2);
      before.close();
      const after = new StateStore(path);
      expect(after.sentCount()).toBe(1);
      const kept = db(after).prepare('SELECT message_id, folder, answered_key, checked_at FROM sent_mail').get() as Record<string, unknown>;
      expect(kept).toMatchObject({ message_id: '<theirs@outlook>', folder: 'Sent', answered_key: 'k1' });
      expect(kept['checked_at']).toEqual(expect.any(String));
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe('a long conversation', () => {
  it('shows the newest of it, and says truly how many are left out', () => {
    const state = new StateStore(':memory:');
    const thread = `${ME}|<busy@example.org>`;
    for (let n = 0; n < 260; n += 1) {
      received(state, `k${n}`, { messageId: `<m${n}@example.org>`, threadKey: thread, mailDate: iso(-(260 - n) * 60 * MIN) });
    }
    state.recordSent(sent({ messageId: '<r@qq.com>', threadKey: thread, answers: '<m258@example.org>', date: iso(-90 * MIN) }));
    const { entries, omitted } = state.conversation(state.getMail('k259')!);
    const names = entries.map((e) => (e.direction === 'in' ? e.row.dedupKey : 'SENT'));
    expect(names).toHaveLength(50);
    expect(names.slice(-4)).toEqual(['k257', 'k258', 'SENT', 'k259']);
    expect(names[0]).toBe('k211');
    expect(omitted).toBe(261 - 50);
    // An old message opened: itself, and the newest of the rest.
    const old = state.conversation(state.getMail('k10')!);
    expect(old.entries[0]).toMatchObject({ direction: 'in', row: { dedupKey: 'k10' } });
    expect(old.entries.at(-1)).toMatchObject({ direction: 'in', row: { dedupKey: 'k259' } });
    expect(old.omitted).toBe(261 - 50);
  });
});

describe('an older message opened in a long conversation', () => {
  it('says how many messages lie between it and the newest shown', () => {
    const state = new StateStore(':memory:');
    const thread = `${ME}|<ci@example.org>`;
    for (let n = 0; n < 60; n += 1) {
      received(state, `k${n}`, { messageId: `<m${n}@example.org>`, threadKey: thread, mailDate: iso(-(60 - n) * 60 * MIN) });
    }
    // The owner's reply to k5, which the newest 49 leave out.
    state.recordSent(sent({ messageId: '<r@qq.com>', threadKey: thread, answers: '<m5@example.org>', date: iso(-(54.5 * 60) * MIN) }));
    const { entries, omitted, between } = state.conversation(state.getMail('k5')!);
    expect(entries).toHaveLength(50);
    expect(entries[0]).toMatchObject({ direction: 'in', row: { dedupKey: 'k5' } });
    expect(entries[1]).toMatchObject({ direction: 'in', row: { dedupKey: 'k11' } });
    expect(omitted).toBe(61 - 50);
    // k6..k10 and the reply lie between k5 and k11; k0..k4 are older.
    expect(between).toBe(6);
    // The newest opened: nothing between.
    expect(state.conversation(state.getMail('k59')!).between).toBe(0);
  });
});

describe('a copy of the owner\'s own message that came back', () => {
  it('is the owner\'s message: shown once, counted once, and the latest word is still theirs', () => {
    const state = new StateStore(':memory:');
    const thread = `${ME}|<root@list.example>`;
    received(state, 'ann', { messageId: '<root@list.example>', threadKey: thread, mailDate: iso(-60 * MIN), sender: 'ann@example.org' });
    state.recordSent(sent({ messageId: '<reply@qq.com>', threadKey: thread, answers: '<root@list.example>', date: iso(-30 * MIN) }));
    // The list sends the post back to its poster: the same Message-ID, in the inbox.
    received(state, 'echo', { messageId: '<reply@qq.com>', threadKey: thread, mailDate: iso(-29 * MIN), sender: ME, importance: 'info', pushed: false });

    const shown = state.conversation(state.getMail('ann')!).entries
      .map((e) => (e.direction === 'in' ? `in ${e.row.messageId}` : `out ${e.sent.messageId}`));
    expect(shown).toEqual(['in <root@list.example>', 'out <reply@qq.com>']);
    expect(state.conversation(state.getMail('ann')!).omitted).toBe(0);
    // Opened from the list, the copy is the message being read, and the sent one is not shown beside it.
    const fromCopy = state.conversation(state.getMail('echo')!).entries
      .map((e) => (e.direction === 'in' ? `in ${e.row.dedupKey}` : `out ${e.sent.messageId}`));
    expect(fromCopy).toEqual(['in ann', 'in echo']);

    expect(state.queryThreads({ sinceHours: 24 })).toMatchObject([{ threadKey: thread, messageCount: 1, sentCount: 1, lastWordYours: true }]);
    expect(state.threadWindow(thread).entries).toHaveLength(2);
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

  it('count the owner\'s messages in the same window as the received ones', () => {
    const state = new StateStore(':memory:');
    const thread = `${ME}|<a@example.org>`;
    received(state, 'a', { messageId: '<a@example.org>', threadKey: thread, mailDate: iso(-3 * DAY) });
    db(state).prepare('UPDATE seen SET created_at = ? WHERE dedup_key = ?').run(iso(-3 * DAY), 'a');
    received(state, 'b', { messageId: '<b@example.org>', threadKey: thread, mailDate: iso(-2 * 60 * MIN) });
    state.recordSent(sent({ messageId: '<old@qq.com>', threadKey: thread, date: iso(-2 * DAY) }));
    state.recordSent(sent({ messageId: '<new@qq.com>', threadKey: thread, date: iso(-60 * MIN) }));
    expect(state.queryThreads({ sinceHours: 24 })).toMatchObject([{ messageCount: 1, sentCount: 1, lastWordYours: true }]);
    expect(state.queryThreads({ sinceHours: 24 * 7 })).toMatchObject([{ messageCount: 2, sentCount: 2, lastWordYours: true }]);
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
      expect(columns).toContain('kept_at');
      expect(columns).toContain('withheld');
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

describe('the owner\'s decisions from before this release', () => {
  it('are read from the audit once, so the first look back never undoes a put-back or a reminder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mailsift-kept-'));
    const path = join(dir, 'state.db');
    try {
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE seen (
        dedup_key TEXT PRIMARY KEY, account TEXT NOT NULL, account_label TEXT,
        message_id TEXT, thread_key TEXT, subject TEXT, sender TEXT, sender_name TEXT,
        folder TEXT, in_spam INTEGER NOT NULL DEFAULT 0,
        importance TEXT, category TEXT, summary TEXT, reason TEXT, deadline TEXT,
        decided_by TEXT, pushed INTEGER NOT NULL DEFAULT 0,
        mail_date TEXT, snippet TEXT, attachments_json TEXT, verification_code TEXT, handled_at TEXT,
        uid INTEGER, uid_validity TEXT, snoozed_until TEXT, created_at TEXT NOT NULL)`);
      old.exec(`CREATE TABLE mcp_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, client TEXT, target TEXT,
        success INTEGER NOT NULL, created_at TEXT NOT NULL)`);
      old.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      old.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('attention_since', iso(-30 * DAY));
      const row = old.prepare(`INSERT INTO seen (dedup_key, account, message_id, importance, pushed, folder, mail_date, snoozed_until, created_at)
        VALUES (?, ?, ?, 'critical', 1, 'INBOX', ?, ?, ?)`);
      // Put back in the page; marked done and back through MCP (by Message-ID); put off in the page.
      row.run(`${ME}|<a@x>`, ME, '<a@x>', iso(-3 * DAY), null, iso(-3 * DAY));
      row.run(`${ME}|<b@x>`, ME, '<b@x>', iso(-3 * DAY), null, iso(-3 * DAY));
      row.run(`${ME}|<c@x>`, ME, '<c@x>', iso(-3 * DAY), iso(2 * DAY), iso(-3 * DAY));
      const audit = old.prepare('INSERT INTO mcp_audit (action, client, target, success, created_at) VALUES (?, ?, ?, 1, ?)');
      audit.run('web:handled', 'page', `${ME}|<a@x>`, iso(-2 * DAY));
      audit.run('web:unhandled', 'page', `${ME}|<a@x>`, iso(-1 * DAY));
      audit.run('mark_handled', 'agent', JSON.stringify({ messageId: '<b@x>', account: ME }), iso(-1 * DAY));
      audit.run('web:snooze', 'page', `${ME}|<c@x>`, iso(-1 * DAY));
      // Rows that are not JSON, which the backfill must read past.
      audit.run('snooze', 'agent', 'not json at all', iso(-1 * DAY));
      audit.run('web:feedback', 'page', `${ME}|<a@x>`, iso(-1 * DAY));
      old.close();

      const state = new StateStore(path);
      // Replies from the phone two days ago, read only now by the first look back.
      for (const id of ['a', 'b', 'c']) {
        state.recordSent(sent({ messageId: `<r${id}@qq.com>`, answers: `<${id}@x>`, threadKey: `${ME}|<${id}@x>`, date: iso(-2 * DAY) }));
      }
      expect(state.answerFromSent(OWN)).toEqual([]);
      expect(state.attentionCount()).toBe(2);
      expect(state.snoozedCount()).toBe(1);
      // A reply written since does count.
      state.recordSent(sent({ messageId: '<ra2@qq.com>', answers: '<a@x>', threadKey: `${ME}|<a@x>`, date: iso(-1 * MIN) }));
      expect(state.answerFromSent(OWN)).toEqual([`${ME}|<a@x>`]);
      state.close();
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

  it('takes off a message that was put off by a reply written after that, as answering it in the page would', () => {
    const state = new StateStore(':memory:');
    received(state, 'k1', { messageId: '<q@example.org>' });
    state.setSnoozed('k1', iso(2 * DAY));
    state.recordSent(sent({ date: iso(1 * MIN) }));
    expect(state.answerFromSent(OWN)).toEqual(['k1']);
    expect(state.snoozed()).toEqual([]);
  });

  it('never lets a reply written before the owner put a message off, or changed its reminder, cancel that', () => {
    for (const decide of [
      (state: StateStore) => state.setSnoozed('k1', iso(3 * DAY)),
      (state: StateStore) => { state.setSnoozed('k1', iso(3 * DAY)); state.setSnoozed('k1', iso(5 * DAY)); },
      (state: StateStore) => { state.setSnoozed('k1', iso(3 * DAY)); state.wakeNow('k1'); },
    ]) {
      const state = new StateStore(':memory:');
      received(state, 'k1', { messageId: '<q@example.org>', mailDate: iso(-2 * 60 * MIN) });
      decide(state);
      // Replied from the phone half an hour ago; the poll reads it only now.
      state.recordSent(sent({ date: iso(-30 * MIN) }));
      expect(state.answerFromSent(OWN)).toEqual([]);
      expect(state.getMail('k1')!.handledAt).toBeNull();
    }
    // A reminder taken away is a decision too: the message stays as the owner left it.
    const state = new StateStore(':memory:');
    received(state, 'k1', { messageId: '<q@example.org>' });
    state.setSnoozed('k1', iso(3 * DAY));
    state.setSnoozed('k1', null);
    state.recordSent(sent({ date: iso(-5 * MIN) }));
    expect(state.answerFromSent(OWN)).toEqual([]);
    expect(state.inAttention('k1')).toBe(true);
  });

  it('leaves alone what the reply does not answer, or answers only the owner', () => {
    const cases: Array<[string, (state: StateStore) => void]> = [
      ['another mailbox\'s copy', (state) => state.recordSent(sent({ account: 'me@gmail.com' }))],
      ['a reply to the owner\'s own addresses only', (state) => state.recordSent(sent({
        to: [{ name: '', address: 'me@gmail.com' }], bcc: [{ name: '', address: ME }],
      }))],
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

  it('believes a reply to the message whatever the sender\'s clock says', () => {
    const state = new StateStore(':memory:');
    // The sender's clock runs seven minutes ahead; the owner answered a minute ago.
    received(state, 'k1', { messageId: '<q@example.org>', mailDate: iso(7 * MIN) });
    state.recordSent(sent({ date: iso(-1 * MIN) }));
    expect(state.answerFromSent(OWN)).toEqual(['k1']);

    const arriving = new StateStore(':memory:');
    arriving.recordSent(sent({ date: undefined }));
    arriving.markSeen('k1', ME, 'q');
    expect(arriving.answerStored('k1', OWN, true, '<q@example.org>')).toBe(true);
  });

  it('takes off a message whose notification is still owed, before any digest lists it', () => {
    const state = new StateStore(':memory:');
    received(state, 'k1', { messageId: '<q@example.org>', importance: 'warning', pushed: false });
    state.enqueueNotification('k1', { account: ME, messageId: '<q@example.org>' } as never, { importance: 'warning' } as never);
    state.queueDigest('k1', { subject: 'q' });
    expect(state.inAttention('k1')).toBe(false);
    state.recordSent(sent());
    expect(state.answerFromSent(OWN)).toEqual(['k1']);
    expect(state.digestPending()).toBe(0);
    expect(state.notificationOutboxPending()).toBe(0);
    expect(state.getMail('k1')).toMatchObject({ withheld: true, handledAt: expect.any(String) });
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

  it('carries withheld on the stored record, and the record page says why it was not notified', async () => {
    const { mailRecordToMarkdown } = await import('../src/mcp-markdown.js');
    const state = new StateStore(':memory:');
    state.recordSent(sent());
    state.markSeen('k1', ME, 'q');
    state.answerStored('k1', OWN, true, '<q@example.org>');
    state.recordOutcome('k1', 'warning', false, { messageId: '<q@example.org>', folder: 'INBOX' });
    const row = state.getMail('k1')!;
    expect(row).toMatchObject({ pushed: false, withheld: true });
    expect(state.queryMail({ sinceHours: 1 })[0]).toMatchObject({ withheld: true });
    const page = mailRecordToMarkdown(row);
    expect(page).toContain('withheld because the owner had already answered it');
    expect(page).not.toContain('carried by the daily digest');
  });

  it('stores a message as dealt with when an answer to it is stored already, and keeps it ready to put back', () => {
    const state = new StateStore(':memory:');
    state.recordSent(sent({ date: iso(-5 * MIN) }));
    state.markSeen('k1', ME, 'q');
    expect(state.answerStored('k1', OWN, true, '<q@example.org>')).toBe(true);
    // Judged warning and owed a notification it was not sent.
    state.recordOutcome('k1', 'warning', false, { messageId: '<q@example.org>', folder: 'INBOX' });
    expect(state.getMail('k1')!.handledAt).not.toBeNull();
    expect(state.listMailActions()[0]).toMatchObject({ action: 'handled', client: SENT_FOLDER_CLIENT });
    expect(state.recentlyHandled()).toMatchObject([{ row: { dedupKey: 'k1' }, queued: true }]);
    state.setHandled('k1', false);
    expect(state.inAttention('k1')).toBe(true);

    const own = new StateStore(':memory:');
    own.recordSent(sent({ to: [{ name: '', address: 'me@gmail.com' }] }));
    own.markSeen('k1', ME, 'q');
    expect(own.answerStored('k1', OWN, true, '<q@example.org>')).toBe(false);
  });

  it('says nothing more about a message it takes off: a notification still owed and its digest line go', () => {
    const state = new StateStore(':memory:');
    received(state, 'k1', { messageId: '<q@example.org>', importance: 'warning', pushed: false });
    state.enqueueNotification('k1', { account: ME, messageId: '<q@example.org>' } as never, { importance: 'warning' } as never);
    state.queueDigest('k1', { subject: 'q' });
    state.recordSent(sent());
    expect(state.answerStored('k1', OWN)).toBe(true);
    expect(state.notificationOutboxPending()).toBe(0);
    expect(state.digestPending()).toBe(0);
    // It was owed a notification, so putting it back puts it in the queue.
    state.setHandled('k1', false);
    expect(state.inAttention('k1')).toBe(true);
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

  it('lets no spam or bulk mail from an address the owner writes to rename it', () => {
    const state = new StateStore(':memory:');
    state.recordSent(sent({ messageId: '<1@qq.com>', to: to('ann@acme.example', 'Ann Lee'), date: iso(-2 * DAY) }));
    received(state, 'spoof', { messageId: '<s@x>', sender: 'ann@acme.example', senderName: 'Ann Lee (CEO) urgent wire', inSpam: true, mailDate: iso(-1 * MIN) });
    received(state, 'news', { messageId: '<n@x>', sender: 'ann@acme.example', senderName: 'Acme Weekly', category: 'Marketing', mailDate: iso(-1 * MIN) });
    expect(state.contacts('ann', 8, OWN)).toMatchObject([{ address: 'ann@acme.example', name: 'Ann Lee', received: 0 }]);
  });

  it('finds a name however its characters were written', () => {
    const state = new StateStore(':memory:');
    received(state, 'fw', { messageId: '<fw@x>', sender: 'bob@lee.example', senderName: 'Ｂｏｂ Ｌｅｅ' });
    received(state, 'hw', { messageId: '<hw@x>', sender: 't@tanaka.example', senderName: 'ﾀﾅｶ' });
    received(state, 'nfd', { messageId: '<nfd@x>', sender: 'em@martin.example', senderName: 'E\u0301lise Martin' });
    state.recordSent(sent({ messageId: '<z@qq.com>', to: to('zoe@studio.example', 'Ｚｏｅ Ｗｏｏ') }));
    expect(state.contacts('bob', 8, OWN).map((c) => c.address)).toEqual(['bob@lee.example']);
    expect(state.contacts('lee', 8, OWN).map((c) => c.address)).toEqual(['bob@lee.example']);
    expect(state.contacts('タナカ', 8, OWN).map((c) => c.address)).toEqual(['t@tanaka.example']);
    expect(state.contacts('élise', 8, OWN).map((c) => c.address)).toEqual(['em@martin.example']);
    expect(state.contacts('woo', 8, OWN)).toMatchObject([{ address: 'zoe@studio.example', name: 'Zoe Woo' }]);
  });

  it('never gives more than asked, nor more than twenty', () => {
    const state = new StateStore(':memory:');
    for (let n = 0; n < 30; n += 1) state.recordSent(sent({ messageId: `<${n}@qq.com>`, to: to(`team${n}@acme.example`) }));
    expect(state.contacts('team', 3, OWN)).toHaveLength(3);
    expect(state.contacts('team', 500, OWN)).toHaveLength(20);
  });
});
