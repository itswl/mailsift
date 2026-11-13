import { describe, expect, it } from 'vitest';
import './setup.js';
import { REJUDGED_KEY, StateStore } from '../src/services/state.js';
import { makeMessage, makeResult } from './helpers.js';

function store(): StateStore {
  return new StateStore(':memory:');
}

describe('deduplication', () => {
  it('makes markSeen idempotent', () => {
    const s = store();
    expect(s.markSeen('k1', 'me@qq.com', '主题')).toBe(true);
    expect(s.markSeen('k1', 'me@qq.com', '主题')).toBe(false);
  });

  it('makes isSeen read-only', () => {
    // Defer marking until after triage and delivery so a crash does not silently lose a message.
    const s = store();
    expect(s.isSeen('k1')).toBe(false);
    expect(s.isSeen('k1')).toBe(false);
  });
});

describe('cursors', () => {
  it('isolates cursors by account and folder', () => {
    const s = store();
    s.saveCursor('a@qq.com', 'INBOX', '1', 100);
    s.saveCursor('b@qq.com', 'INBOX', '1', 200);
    s.saveCursor('a@qq.com', 'Junk', '1', 5);
    expect(s.getCursor('a@qq.com', 'INBOX')).toEqual({ uidValidity: '1', lastUid: 100 });
    expect(s.getCursor('b@qq.com', 'INBOX')).toEqual({ uidValidity: '1', lastUid: 200 });
    expect(s.getCursor('a@qq.com', 'Junk')).toEqual({ uidValidity: '1', lastUid: 5 });
  });

  it('advanceCursor never rewinds within one UIDVALIDITY but follows a new one', () => {
    // A wake-up fetch and a scheduled poll may commit the same folder in either
    // order; the one that saw fewer messages must not move the cursor back.
    const s = store();
    s.advanceCursor('a@qq.com', 'INBOX', '1', 100);
    s.advanceCursor('a@qq.com', 'INBOX', '1', 90);
    expect(s.getCursor('a@qq.com', 'INBOX')).toEqual({ uidValidity: '1', lastUid: 100 });
    s.advanceCursor('a@qq.com', 'INBOX', '2', 5);
    expect(s.getCursor('a@qq.com', 'INBOX')).toEqual({ uidValidity: '2', lastUid: 5 });
  });

  it('lists every folder cursor so lag can be seen at a glance', () => {
    const s = store();
    s.saveCursor('a@qq.com', 'INBOX', '1', 100);
    s.saveCursor('a@qq.com', 'Junk', '1', 5);
    s.saveCursor('b@qq.com', 'INBOX', '2', 7);
    expect(s.listCursors().map((c) => `${c.account}/${c.folder}=${c.lastUid}`).sort())
      .toEqual(['a@qq.com/INBOX=100', 'a@qq.com/Junk=5', 'b@qq.com/INBOX=7']);
    expect(s.listCursors()[0]).toMatchObject({ uidValidity: expect.any(String), updatedAt: expect.any(String) });
  });

  it('can roll back all cursors for --recover', () => {
    const s = store();
    s.saveCursor('a@qq.com', 'INBOX', '1', 100);
    expect(s.clearCursors()).toBe(1);
    expect(s.getCursor('a@qq.com', 'INBOX')).toBeUndefined();
  });
});

describe('rich fields and queries', () => {
  function seed(s: StateStore, key: string, fields: Record<string, unknown> = {}): void {
    s.markSeen(key, String(fields['account'] ?? 'me@qq.com'), String(fields['subject'] ?? 's'));
    s.recordOutcome(key, String(fields['importance'] ?? 'info'), Boolean(fields['pushed']), fields);
  }

  it('preserves rich fields through a round trip', () => {
    const s = store();
    seed(s, 'k1', {
      importance: 'critical', pushed: true, messageId: '<a@x>', sender: 'billing@v.com',
      inSpam: true, category: '账单', summary: '域名到期', snippet: '正文',
    });
    const item = s.getMail('<a@x>');
    expect(item).toMatchObject({ sender: 'billing@v.com', inSpam: true, pushed: true, summary: '域名到期' });
    expect(item?.snippet).toBe('正文');
  });

  it('keeps an extracted verification code locally for the web view', () => {
    const s = store();
    seed(s, 'k1', { messageId: '<code@x>', verificationCode: '227857' });
    expect(s.getMail('<code@x>')?.verificationCode).toBe('227857');
    // Ordinary mail carries no code at all rather than an empty one.
    seed(s, 'k2', { messageId: '<plain@x>' });
    expect(s.getMail('<plain@x>')).not.toHaveProperty('verificationCode');
  });

  it('filters by conditions', () => {
    const s = store();
    seed(s, 'k1', { importance: 'critical', pushed: true, messageId: '<1@x>', inSpam: true, sender: 'a@bank.com' });
    seed(s, 'k2', { importance: 'info', messageId: '<2@x>', sender: 'news@site.com' });
    seed(s, 'k3', { importance: 'critical', pushed: true, messageId: '<3@x>' });
    expect(s.queryMail({ importance: 'critical' })).toHaveLength(2);
    expect(s.queryMail({ spamOnly: true })).toHaveLength(1);
    expect(s.queryMail({ pushedOnly: true })).toHaveLength(2);
    expect(s.queryMail({ search: 'bank' }).map((m) => m.messageId)).toEqual(['<1@x>']);
  });

  it('filters by category exactly rather than by substring', () => {
    const s = store();
    seed(s, 'k1', { messageId: '<1@x>', category: 'Finance' });
    seed(s, 'k2', { messageId: '<2@x>', category: 'Forwarded copy', summary: 'about Finance' });
    expect(s.queryMail({ category: 'Finance' }).map((m) => m.messageId)).toEqual(['<1@x>']);
    expect(s.queryMail({ category: 'Forwarded copy' })).toHaveLength(1);
    expect(s.queryMail({ category: 'Finan' })).toHaveLength(0);
  });

  it('searches summaries and reasons', () => {
    const s = store();
    seed(s, 'k1', { messageId: '<1@x>', summary: '域名续费到期通知', category: '账单续费' });
    expect(s.queryMail({ search: '续费' })).toHaveLength(1);
  });

  it('counts rescued spam', () => {
    const s = store();
    seed(s, 'k1', { importance: 'critical', pushed: true, inSpam: true });
    seed(s, 'k2', { importance: 'info', inSpam: true });
    seed(s, 'k3', { importance: 'warning', pushed: true });
    expect(s.summarize(24)).toMatchObject({
      total: 3, pushed: 2, fromSpamFolder: 2, rescuedFromSpam: 1,
    });
  });
});

describe('maintenance', () => {
  it('keeps oversized or malformed messages visible as dead letters', () => {
    const s = store();
    const input = {
      account: 'me@qq.com', folder: 'INBOX', uidValidity: '7', uid: 42,
      messageId: '<bad@x>', subject: '超大附件', reason: 'source too large',
    };
    s.recordDeadLetter(input);
    s.recordDeadLetter(input);
    expect(s.listDeadLetters()).toMatchObject([{ account: 'me@qq.com', uid: 42, reason: 'source too large' }]);
    expect(s.listDeadLetters()).toHaveLength(1);
  });

  it('rewinds a cursor when a dead letter is explicitly requeued', () => {
    const s = store();
    s.saveCursor('me@qq.com', 'INBOX', '7', 100);
    s.recordDeadLetter({
      account: 'me@qq.com', folder: 'INBOX', uidValidity: '7', uid: 42,
      messageId: '<bad@x>', subject: '坏信', reason: 'parse failed',
    });
    expect(s.retryDeadLetter('me@qq.com|INBOX|7|42')).toBe(true);
    expect(s.getCursor('me@qq.com', 'INBOX')).toEqual({ uidValidity: '7', lastUid: 41 });
    expect(s.listDeadLetters()).toHaveLength(0);
    expect(s.retryDeadLetter('missing')).toBe(false);
  });

  it('keeps failed notifications in the durable outbox until delivered', () => {
    const s = store();
    const message = makeMessage({ messageId: '<outbox@x>' });
    const result = makeResult();
    s.enqueueNotification('me@qq.com|<outbox@x>', message, result);
    expect(s.notificationOutboxPending()).toBe(1);
    s.markNotificationFailed('me@qq.com|<outbox@x>', 'endpoint down');
    expect(s.pendingNotifications()[0]?.attempts).toBe(1);
    expect(s.pendingNotifications()[0]?.lastError).toContain('endpoint down');
    s.markNotificationDelivered('me@qq.com|<outbox@x>');
    expect(s.notificationOutboxPending()).toBe(0);
  });

  it('records feedback and exposes it in observability', () => {
    const s = store();
    s.markSeen('k1', 'me@qq.com', '主题');
    s.recordOutcome('k1', 'warning', true, { messageId: '<feedback@x>' });
    s.recordFeedback('<feedback@x>', 'false_positive', 'newsletter');
    s.recordFeedback('<feedback@x>', 'handled');
    expect(s.feedbackSummary()).toEqual({ false_positive: 1, handled: 1 });
    expect(s.observability()).toMatchObject({ seenTotal: 1, pushedTotal: 1, feedback: { false_positive: 1, handled: 1 } });
  });

  it('infers sender rules only after repeated feedback', () => {
    const s = store();
    for (const [key, label] of [['missed-1', 'missed'], ['missed-2', 'missed'], ['false-1', 'false_positive'], ['false-2', 'false_positive']] as const) {
      s.markSeen(key, 'me@qq.com', key);
      s.recordOutcome(key, 'info', false, { messageId: `<${key}@x>`, sender: label === 'missed' ? 'important@example.com' : 'noise@example.com' });
      s.recordFeedback(`<${key}@x>`, label);
    }
    expect(s.feedbackRuleHints(2)).toEqual({
      alwaysImportant: ['important@example.com'],
      neverImportant: ['noise@example.com'],
    });
  });

  it('finds and clears interrupted records without outcomes', () => {
    const s = store();
    s.markSeen('stuck', 'me@qq.com', '被中断');
    s.markSeen('done', 'me@qq.com', '正常');
    s.recordOutcome('done', 'info', false);
    expect(s.countUndispatched()).toBe(1);
    expect(s.dropUndispatched()).toBe(1);
    expect(s.isSeen('done')).toBe(true);
  });

  it('prune deletes only old records', () => {
    const s = store();
    s.markSeen('old', 'me@qq.com', '旧');
    s.markSeen('new', 'me@qq.com', '新');
    s.recordOutcome('old', 'info', false);
    s.recordOutcome('new', 'info', false);
    // Manually move one record 200 days into the past.
    const stale = new Date(Date.now() - 200 * 86_400_000).toISOString();
    (s as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db
      .prepare('UPDATE seen SET created_at = ? WHERE dedup_key = ?')
      .run(stale, 'old');
    expect(s.prune(90)).toBe(1);
    expect(s.isSeen('old')).toBe(false);
    expect(s.isSeen('new')).toBe(true);
  });

  it('draining the digest queue empties it', () => {
    const s = store();
    s.queueDigest('k1', { subject: 'a' });
    s.queueDigest('k2', { subject: 'b' });
    s.queueDigest('k1', { subject: 'dup' });
    expect(s.digestPending()).toBe(2);
    expect(s.drainDigest()).toHaveLength(2);
    expect(s.drainDigest()).toEqual([]);
  });

  it('waits for a concurrent writer instead of failing immediately', () => {
    // Other processes (healthcheck, stdio MCP) share the file; without a busy
    // timeout a write that collides with the poller throws SQLITE_BUSY at once.
    const s = store();
    const row = (s as unknown as { db: { prepare(sql: string): { get(): Record<string, unknown> } } }).db
      .prepare('PRAGMA busy_timeout')
      .get();
    expect(Number(row['timeout'])).toBe(5000);
  });

  it('overwrites metadata values', () => {
    const s = store();
    expect(s.getMeta('x')).toBeUndefined();
    s.setMeta('x', 'a');
    s.setMeta('x', 'b');
    expect(s.getMeta('x')).toBe('b');
  });
});

describe('kept digests and feedback votes', () => {
  it('keeps what a sent digest listed, with each entry\'s key', () => {
    const s = new StateStore(':memory:');
    expect(s.lastDigestLog()).toBeUndefined();
    s.recordDigestLog('2026-11-03T01:00:00.000Z', [{ dedupKey: 'k1', payload: { subject: 'a', fromName: 'A' } }]);
    s.recordDigestLog('2026-11-04T01:00:00.000Z', [{ dedupKey: 'k2', payload: { subject: 'b', fromName: 'B' } }]);
    expect(s.lastDigestLog()).toEqual({ sentAt: '2026-11-04T01:00:00.000Z', items: [{ subject: 'b', fromName: 'B', key: 'k2' }] });
  });

  it('counts a feedback rule in messages, not labels', () => {
    const s = new StateStore(':memory:');
    s.markSeen('k1', 'me@x', 'promo');
    s.recordOutcome('k1', 'warning', true, { messageId: '<k1@x>', sender: 'promo@shop.example' });
    // The same message marked twice is one vote.
    s.recordFeedback('<k1@x>', 'false_positive');
    s.recordFeedback('<k1@x>', 'false_positive');
    expect(s.feedbackRuleHints(2).neverImportant).toEqual([]);
    s.markSeen('k2', 'me@x', 'promo 2');
    s.recordOutcome('k2', 'warning', true, { messageId: '<k2@x>', sender: 'promo@shop.example' });
    s.recordFeedback('<k2@x>', 'false_positive');
    expect(s.feedbackRuleHints(2).neverImportant).toEqual(['promo@shop.example']);
  });
});

describe('honest labels for old rows', () => {
  it('relabels code mail an older release marked fallback as judged locally, once', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { DatabaseSync } = await import('node:sqlite');
    const path = join(mkdtempSync(join(tmpdir(), 'mailsift-labels-')), 'state.db');
    const first = new StateStore(path);
    first.markSeen('code', 'me@x', '验证码邮件');
    first.recordOutcome('code', 'warning', true, { decidedBy: 'fallback', summary: '收到验证码邮件。', verificationCode: '482913' });
    first.markSeen('other', 'me@x', 'Weekly notes');
    first.recordOutcome('other', 'info', false, { decidedBy: 'fallback', summary: 'LLM unavailable' });
    first.close();
    // As an older release left it: no record of the relabelling.
    const raw = new DatabaseSync(path);
    raw.prepare("DELETE FROM meta WHERE key = 'migrated_local_labels'").run();
    raw.close();

    const store = new StateStore(path);
    expect(store.getMail('code')).toMatchObject({ decidedBy: 'local', verificationCode: '482913' });
    expect(store.getMail('other')).toMatchObject({ decidedBy: 'fallback' });
    store.close();
  });
});

/** Reach under the store for the one thing no method does: moving a row in time. */
function rawRun(s: StateStore, sql: string, ...args: unknown[]): void {
  (s as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db.prepare(sql).run(...args);
}

async function tempDb(prefix: string): Promise<string> {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return join(mkdtempSync(join(tmpdir(), prefix)), 'state.db');
}

describe('the needs-you queue', () => {
  function seed(s: StateStore, key: string, importance: string, pushed: boolean, fields: Record<string, unknown> = {}): void {
    s.markSeen(key, 'me@qq.com', key);
    s.recordOutcome(key, importance, pushed, { messageId: `<${key}@x>`, summary: `summary of ${key}`, decidedBy: 'llm', ...fields });
  }

  it('holds notified and critical mail until someone handles it', () => {
    const s = store();
    seed(s, 'notified', 'warning', true);
    seed(s, 'critical-unsent', 'critical', false);
    seed(s, 'quiet', 'info', false);
    seed(s, 'warning-unsent', 'warning', false);
    expect(s.attention().map((row) => row.dedupKey).sort()).toEqual(['critical-unsent', 'notified']);
    expect(s.attentionCount()).toBe(2);
    expect(s.attention()[0]).toMatchObject({ handledAt: null });

    const handled = s.setHandled('notified', true);
    expect(handled?.handledAt).toEqual(expect.any(String));
    expect(s.attention().map((row) => row.dedupKey)).toEqual(['critical-unsent']);
    // By message id too, which is what an MCP caller holds.
    expect(s.setHandled('<critical-unsent@x>', true)?.dedupKey).toBe('critical-unsent');
    expect(s.attentionCount()).toBe(0);
    expect(s.setHandled('<absent@x>', true)).toBeUndefined();
  });

  it('keeps the first handled time, and can put a message back', () => {
    const s = store();
    seed(s, 'k1', 'critical', true);
    const first = s.setHandled('k1', true)?.handledAt;
    rawRun(s, "UPDATE seen SET handled_at = '2026-01-01T00:00:00.000Z' WHERE dedup_key = 'k1'");
    expect(s.setHandled('k1', true)?.handledAt).toBe('2026-01-01T00:00:00.000Z');
    expect(first).toEqual(expect.any(String));
    expect(s.setHandled('k1', false)?.handledAt).toBeNull();
    expect(s.attentionCount()).toBe(1);
    expect(s.getMail('k1')).toMatchObject({ handledAt: null });
    expect(s.queryMail()[0]).toHaveProperty('handledAt', null);
  });

  it('remembers what was dealt with lately, most recently first, and whether each would return to the queue', () => {
    const s = store();
    seed(s, 'notified', 'warning', true);
    seed(s, 'critical', 'critical', false);
    seed(s, 'quiet', 'info', false);
    seed(s, 'waiting', 'critical', true);
    seed(s, 'long-ago', 'critical', true);
    expect(s.recentlyHandled()).toEqual([]);

    for (const key of ['notified', 'critical', 'quiet', 'long-ago']) s.setHandled(key, true);
    const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();
    rawRun(s, 'UPDATE seen SET handled_at = ? WHERE dedup_key = ?', hoursAgo(1), 'quiet');
    rawRun(s, 'UPDATE seen SET handled_at = ? WHERE dedup_key = ?', hoursAgo(5), 'notified');
    rawRun(s, 'UPDATE seen SET handled_at = ? WHERE dedup_key = ?', hoursAgo(50), 'critical');
    // Dealt with more than a week ago: no longer something to stumble over.
    rawRun(s, 'UPDATE seen SET handled_at = ? WHERE dedup_key = ?', hoursAgo(8 * 24), 'long-ago');

    const done = s.recentlyHandled();
    expect(done.map((entry) => entry.row.dedupKey)).toEqual(['quiet', 'notified', 'critical']);
    // Mail that was only filed away would not come back to the queue; mail that was judged to matter would.
    expect(done.map((entry) => entry.queued)).toEqual([false, true, true]);
    expect(done[0]?.row.handledAt).toEqual(expect.any(String));
    expect(s.recentlyHandled(2).map((entry) => entry.row.dedupKey)).toEqual(['quiet', 'notified']);

    // Put back, it is in the queue again and no longer among what was done.
    s.setHandled('notified', false);
    expect(s.recentlyHandled().map((entry) => entry.row.dedupKey)).toEqual(['quiet', 'critical']);
    expect(s.attention().map((row) => row.dedupKey).sort()).toEqual(['notified', 'waiting']);
  });

  it('is not a place for codes, sign-in links, health alerts or digests', () => {
    // A code is gone in minutes, and mailsift's own notices are not mail.
    const s = store();
    seed(s, 'code', 'warning', true, { summary: '收到验证码邮件。', verificationCode: '482913' });
    seed(s, 'unread-code', 'warning', true, { summary: '收到验证码邮件，但未能自动提取验证码。' });
    seed(s, 'link', 'warning', true, { summary: '收到登录链接邮件。' });
    seed(s, 'unasked-link', 'warning', true, { summary: '收到登录链接邮件（如果不是你刚刚请求的，请勿打开）。' });
    seed(s, 'health', 'critical', true, { decidedBy: 'health' });
    seed(s, 'digest', 'warning', true, { decidedBy: 'digest' });
    seed(s, 'no-source', 'critical', true, { decidedBy: undefined, summary: undefined });
    seed(s, 'real', 'critical', true);
    expect(s.attention().map((row) => row.dedupKey).sort()).toEqual(['no-source', 'real']);
  });

  it('starts when the queue did, not with the backlog an upgrade finds', () => {
    const s = store();
    seed(s, 'before', 'critical', true);
    seed(s, 'after', 'critical', true);
    rawRun(s, "UPDATE seen SET created_at = '2026-01-01T00:00:00.000Z' WHERE dedup_key = 'before'");
    expect(s.attention().map((row) => row.dedupKey)).toEqual(['after']);
    // The start is stamped once and then kept.
    const since = s.attentionSince();
    expect(Date.parse(since)).toBeLessThanOrEqual(Date.now());
    s.setMeta('attention_since', '2025-01-01T00:00:00.000Z');
    expect(s.attentionSince()).toBe('2025-01-01T00:00:00.000Z');
    // Even with an early start, a to-do nobody touched for a month is dropped.
    expect(s.attention().map((row) => row.dedupKey)).toEqual(['after']);
    rawRun(s, 'UPDATE seen SET created_at = ? WHERE dedup_key = ?', new Date(Date.now() - 5 * 86_400_000).toISOString(), 'before');
    expect(s.attention().map((row) => row.dedupKey)).toEqual(['after', 'before']);
  });

  it('stamps the start on a database an older release created', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const path = await tempDb('mailsift-attention-');
    const first = new StateStore(path);
    first.markSeen('old', 'me@x', 'old');
    first.recordOutcome('old', 'critical', true, { messageId: '<old@x>' });
    first.close();
    // As an older release left it: no start, no handled column.
    const raw = new DatabaseSync(path);
    raw.prepare("DELETE FROM meta WHERE key = 'attention_since'").run();
    raw.exec('ALTER TABLE seen DROP COLUMN handled_at');
    raw.prepare("UPDATE seen SET created_at = '2026-01-01T00:00:00.000Z'").run();
    raw.close();

    const upgraded = new StateStore(path);
    expect(upgraded.getMeta('attention_since')).toEqual(expect.any(String));
    expect(upgraded.attentionCount()).toBe(0);
    expect(upgraded.getMail('old')).toMatchObject({ handledAt: null });
    upgraded.close();
  });

  it('agrees with "handled" said through feedback', () => {
    const s = store();
    seed(s, 'k1', 'critical', true);
    s.recordFeedback('<k1@x>', 'correct');
    expect(s.attentionCount()).toBe(1);
    s.recordFeedback('<k1@x>', 'handled');
    expect(s.attentionCount()).toBe(0);
    expect(s.getMail('k1')?.handledAt).toEqual(expect.any(String));
    // Feedback about a message that is not stored still records, and marks nothing.
    s.recordFeedback('<absent@x>', 'handled');
    expect(s.feedbackSummary()).toMatchObject({ handled: 2 });
  });

  it('follows a message to the folder an action moved it to', () => {
    const s = store();
    seed(s, 'k1', 'critical', true, { folder: 'Junk', inSpam: true });
    s.updateMailLocation('k1', 'INBOX', false);
    expect(s.getMail('k1')).toMatchObject({ folder: 'INBOX', inSpam: false });
  });
});

describe('where a message is in its folder', () => {
  function seed(s: StateStore, key: string, fields: Record<string, unknown> = {}): void {
    s.markSeen(key, 'me@qq.com', key);
    s.recordOutcome(key, 'warning', true, { messageId: `<${key}@x>`, folder: 'INBOX', ...fields });
  }

  it('is kept from the poll, and is not part of the row that is sent out', () => {
    const s = store();
    seed(s, 'k1', { uid: 42, uidValidity: '1700000000' });
    seed(s, 'k2');
    expect(s.placeOf('k1')).toEqual({ uid: 42, uidValidity: '1700000000' });
    expect(s.placeOf('k2')).toBeUndefined();
    expect(s.placeOf('absent')).toBeUndefined();
    // Half a place is no place.
    seed(s, 'k3', { uid: 7 });
    expect(s.placeOf('k3')).toBeUndefined();
    const row = s.getMail('k1') as unknown as Record<string, unknown>;
    expect(row).not.toHaveProperty('uid');
    expect(row).not.toHaveProperty('uidValidity');
  });

  it('survives a second verdict, which is made from the stored row and knows no UID', () => {
    const s = store();
    seed(s, 'k1', { uid: 42, uidValidity: '9' });
    s.recordOutcome('k1', 'critical', true, { messageId: '<k1@x>', folder: 'INBOX', summary: 'judged again' });
    expect(s.placeOf('k1')).toEqual({ uid: 42, uidValidity: '9' });
    expect(s.getMail('k1')).toMatchObject({ importance: 'critical', summary: 'judged again' });
  });

  it('is learned when a message is first read, without telling the page anything changed', () => {
    const s = store();
    seed(s, 'k1');
    const before = s.changeSignature().mail;
    expect(s.rememberUid('k1', 'INBOX', 12, '9')).toBe(true);
    expect(s.placeOf('k1')).toEqual({ uid: 12, uidValidity: '9' });
    // Already known: nothing is written.
    expect(s.rememberUid('k1', 'INBOX', 12, '9')).toBe(false);
    // Found in a folder the row does not say it is in: the row is not made to disagree with itself.
    expect(s.rememberUid('k1', 'Archive', 3, '2')).toBe(false);
    expect(s.rememberUid('k1', 'INBOX', 0, '9')).toBe(false);
    expect(s.rememberUid('k1', 'INBOX', 12, '')).toBe(false);
    expect(s.placeOf('k1')).toEqual({ uid: 12, uidValidity: '9' });
    expect(s.changeSignature().mail).toBe(before);
  });

  it('moves with the message when the server said where it landed, and is forgotten when it did not', () => {
    const s = store();
    seed(s, 'k1', { uid: 42, uidValidity: '9' });
    s.updateMailLocation('k1', 'Archive', false, { uid: 5, uidValidity: '3' });
    expect(s.getMail('k1')).toMatchObject({ folder: 'Archive' });
    expect(s.placeOf('k1')).toEqual({ uid: 5, uidValidity: '3' });
    // A UID from the old folder would only mislead in the new one.
    s.updateMailLocation('k1', 'Trash', false);
    expect(s.getMail('k1')).toMatchObject({ folder: 'Trash' });
    expect(s.placeOf('k1')).toBeUndefined();
  });

  it('is added to a database an older release created, with nothing known yet', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const path = await tempDb('mailsift-place-');
    const first = new StateStore(path);
    seed(first, 'old');
    first.close();
    const raw = new DatabaseSync(path);
    raw.exec('ALTER TABLE seen DROP COLUMN uid');
    raw.exec('ALTER TABLE seen DROP COLUMN uid_validity');
    raw.close();

    const upgraded = new StateStore(path);
    expect(upgraded.getMail('old')).toMatchObject({ folder: 'INBOX' });
    expect(upgraded.placeOf('old')).toBeUndefined();
    expect(upgraded.rememberUid('old', 'INBOX', 8, '4')).toBe(true);
    expect(upgraded.placeOf('old')).toEqual({ uid: 8, uidValidity: '4' });
    upgraded.close();
  });
});

describe('change tracking', () => {
  function seed(s: StateStore, key: string, importance = 'info', pushed = false): void {
    s.markSeen(key, 'me@qq.com', key);
    s.recordOutcome(key, importance, pushed, { messageId: `<${key}@x>`, folder: 'INBOX' });
  }

  it('reports only other connections\' commits as a new data version', async () => {
    const path = await tempDb('mailsift-version-');
    const reader = new StateStore(path);
    const writer = new StateStore(path);
    const before = reader.dataVersion();
    reader.setMeta('own-write', '1');
    expect(reader.dataVersion()).toBe(before);
    writer.setMeta('other-write', '1');
    expect(reader.dataVersion()).not.toBe(before);
    reader.close();
    writer.close();
  });

  it('changes the mail signature for everything the list would draw differently', () => {
    const s = store();
    const seen = new Set<string>([s.changeSignature().mail]);
    const changed = (what: string): void => {
      const sig = s.changeSignature().mail;
      expect(seen.has(sig), what).toBe(false);
      seen.add(sig);
    };
    s.markSeen('k1', 'me@qq.com', 'k1');
    changed('a row filed');
    s.recordOutcome('k1', 'info', false, { messageId: '<k1@x>', folder: 'INBOX' });
    changed('a row judged');
    s.recordOutcome('k1', 'warning', false, { messageId: '<k1@x>', folder: 'INBOX' });
    changed('a row judged again, higher');
    s.recordOutcome('k1', 'warning', true, { messageId: '<k1@x>', folder: 'INBOX' });
    changed('a row notified');
    s.setHandled('k1', true);
    changed('a row handled');
    s.setHandled('k1', false);
    changed('a row put back');
    // Same length, same spam flag: no aggregate over the rows can tell these apart.
    s.updateMailLocation('k1', 'Trash', false);
    changed('a row moved');
    s.queueDigest('k1', { subject: 'q' });
    changed('a digest entry queued');
    s.upsertDigest('k1', { subject: 'q, rewritten' });
    changed('a digest entry rewritten');
    s.recordDigestLog(new Date().toISOString(), [{ dedupKey: 'k1', payload: {} }]);
    changed('a digest sent');
    s.clearDigest();
    changed('the digest queue emptied');
  });

  it('sees one message handled while another is put back, though the count stays the same', () => {
    const s = store();
    seed(s, 'a', 'critical', true);
    seed(s, 'b', 'critical', true);
    s.setHandled('b', true);
    const before = s.changeSignature().mail;
    s.setHandled('a', true);
    s.setHandled('b', false);
    expect(s.changeSignature().mail).not.toBe(before);
  });

  it('leaves both signatures alone for what the page does not show', () => {
    const s = store();
    seed(s, 'k1');
    const before = s.changeSignature();
    s.recordMcpAudit('web:refresh', 'reader', true);
    s.saveCursor('me@qq.com', 'INBOX', '1', 10);
    s.setMeta('idle_last_wake_at:me@qq.com|INBOX', new Date().toISOString());
    s.setHandled('k1', false);
    expect(s.changeSignature()).toEqual(before);
  });

  it('changes the poll signature with the heartbeat, a failing mailbox and the outbox', () => {
    const s = store();
    const before = s.changeSignature();
    s.setMeta('last_poll_at', '2026-11-12T08:00:00.000Z');
    const polled = s.changeSignature();
    expect(polled.poll).not.toBe(before.poll);
    expect(polled.mail).toBe(before.mail);
    s.setMeta('account_fail_count:me@gmail.com', '3');
    const failing = s.changeSignature();
    expect(failing.poll).not.toBe(polled.poll);
    s.enqueueNotification('me@qq.com|<o@x>', makeMessage(), makeResult());
    expect(s.changeSignature().poll).not.toBe(failing.poll);
  });

  it('ignores rows older than any window the page offers', () => {
    const s = store();
    // Filed long ago and only now given its first verdict: nothing the page lists changed.
    s.markSeen('ancient', 'me@qq.com', 'ancient');
    rawRun(s, "UPDATE seen SET created_at = '2020-01-01T00:00:00.000Z' WHERE dedup_key = 'ancient'");
    const before = s.changeSignature().mail;
    s.recordOutcome('ancient', 'critical', true, { messageId: '<ancient@x>' });
    expect(s.changeSignature().mail).toBe(before);
  });

  it('sees a second verdict even when every count stays the same', () => {
    const s = store();
    seed(s, 'a', 'critical', true);
    seed(s, 'b', 'warning', true);
    const before = s.changeSignature().mail;
    // The two swap levels: one critical and one warning before, and after.
    s.recordOutcome('a', 'warning', true, { messageId: '<a@x>', folder: 'INBOX' });
    s.recordOutcome('b', 'critical', true, { messageId: '<b@x>', folder: 'INBOX' });
    const swapped = s.changeSignature().mail;
    expect(swapped).not.toBe(before);
    // Same level, new words: the row reads differently, so the page should fetch it.
    s.recordOutcome('a', 'warning', true, { messageId: '<a@x>', folder: 'INBOX', summary: 'reworded' });
    expect(s.changeSignature().mail).not.toBe(swapped);
  });

  it('leaves the keys of re-judged rows for the notification dispatcher, without growing forever', () => {
    const s = store();
    seed(s, 'k', 'info');
    expect(s.getMeta(REJUDGED_KEY)).toBeUndefined();
    s.recordOutcome('k', 'critical', true, { messageId: '<k@x>' });
    expect(JSON.parse(s.getMeta(REJUDGED_KEY) ?? '[]')).toEqual(['k']);
    // The same verdict again is not news.
    s.recordOutcome('k', 'critical', true, { messageId: '<k@x>' });
    expect(JSON.parse(s.getMeta(REJUDGED_KEY) ?? '[]')).toEqual(['k']);
    // A list nobody takes (notifications off) stops at its cap, and a damaged one starts over.
    for (let n = 0; n < 260; n += 1) {
      seed(s, `r${n}`, 'info');
      s.recordOutcome(`r${n}`, 'warning', true, { messageId: `<r${n}@x>` });
    }
    expect(JSON.parse(s.getMeta(REJUDGED_KEY) ?? '[]')).toHaveLength(200);
    s.setMeta(REJUDGED_KEY, 'not json');
    s.recordOutcome('k', 'info', false, { messageId: '<k@x>' });
    expect(JSON.parse(s.getMeta(REJUDGED_KEY) ?? '[]')).toEqual(['k']);
  });
});

describe('compare-and-swap on a meta value', () => {
  it('lets exactly one caller make each change', async () => {
    const path = await tempDb('mailsift-cas-');
    const one = new StateStore(path);
    const two = new StateStore(path);
    expect(one.casMeta('k', undefined, 'a')).toBe(true);
    expect(two.casMeta('k', undefined, 'b')).toBe(false);
    expect(two.getMeta('k')).toBe('a');
    expect(one.casMeta('k', 'a', 'c')).toBe(true);
    expect(two.casMeta('k', 'a', 'd')).toBe(false);
    expect(one.getMeta('k')).toBe('c');
    // Swapping a value for itself changes nothing, so nobody wins it.
    expect(one.casMeta('k', 'c', 'c')).toBe(false);
    expect(one.casMeta('absent', 'x', 'y')).toBe(false);
    one.close();
    two.close();
  });
});

describe('judged rows after a cursor', () => {
  it('returns them oldest first, strictly after the cursor, and never an unjudged one', () => {
    const s = store();
    for (const key of ['a', 'b', 'c', 'd']) {
      s.markSeen(key, 'me@qq.com', key);
      if (key !== 'd') s.recordOutcome(key, 'info', false, { messageId: `<${key}@x>` });
    }
    // Two rows filed in the same instant are ordered by key.
    rawRun(s, "UPDATE seen SET created_at = '2026-11-12T08:00:00.000Z' WHERE dedup_key IN ('a', 'b')");
    rawRun(s, "UPDATE seen SET created_at = '2026-11-12T08:00:01.000Z' WHERE dedup_key = 'c'");
    rawRun(s, "UPDATE seen SET created_at = '2026-11-12T08:00:02.000Z' WHERE dedup_key = 'd'");
    const start = { createdAt: '2026-11-12T07:00:00.000Z', dedupKey: '' };
    expect(s.rowsAfter(start).map((row) => row.dedupKey)).toEqual(['a', 'b', 'c']);
    expect(s.rowsAfter({ createdAt: '2026-11-12T08:00:00.000Z', dedupKey: 'a' }).map((row) => row.dedupKey)).toEqual(['b', 'c']);
    expect(s.rowsAfter({ createdAt: '2026-11-12T08:00:01.000Z', dedupKey: 'c' })).toEqual([]);
    expect(s.rowsAfter(start, 2).map((row) => row.dedupKey)).toEqual(['a', 'b']);
    // The row still waiting for its outcome is picked up once it has one.
    s.recordOutcome('d', 'warning', true, { messageId: '<d@x>' });
    expect(s.rowsAfter({ createdAt: '2026-11-12T08:00:01.000Z', dedupKey: 'c' }).map((row) => row.dedupKey)).toEqual(['d']);
  });
});

describe('push subscriptions', () => {
  const sub = (n: number, over: Record<string, unknown> = {}) => ({
    endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, p256dh: 'key', auth: 'secret',
    level: 'warning' as const, codes: true, lang: 'en', ...over,
  });

  it('remembers what a browser asked for, and updates it in place', () => {
    const s = store();
    s.savePushSubscription(sub(1, { label: 'iPhone', origin: 'https://mail.example.org' }));
    const saved = s.getPushSubscription(sub(1).endpoint);
    expect(saved).toMatchObject({
      level: 'warning', codes: true, lang: 'en', label: 'iPhone', origin: 'https://mail.example.org',
      lastOkAt: null, failures: 0,
    });
    s.recordPushResult(sub(1).endpoint, false);
    rawRun(s, "UPDATE push_subscriptions SET created_at = '2026-01-01T00:00:00.000Z'");
    s.savePushSubscription(sub(1, { level: 'critical', codes: false, lang: 'zh-CN' }));
    // The same browser again: its choices change, its first day and a clean record stay.
    expect(s.listPushSubscriptions()).toHaveLength(1);
    expect(s.getPushSubscription(sub(1).endpoint)).toMatchObject({
      level: 'critical', codes: false, lang: 'zh-CN', label: null, createdAt: '2026-01-01T00:00:00.000Z', failures: 0,
    });
    expect(s.deletePushSubscription(sub(1).endpoint)).toBe(true);
    expect(s.deletePushSubscription(sub(1).endpoint)).toBe(false);
    expect(s.getPushSubscription(sub(1).endpoint)).toBeUndefined();
  });

  it('counts failures in a row and clears them on a success', () => {
    const s = store();
    s.savePushSubscription(sub(1));
    expect(s.recordPushResult(sub(1).endpoint, false)).toBe(1);
    expect(s.recordPushResult(sub(1).endpoint, false)).toBe(2);
    expect(s.recordPushResult(sub(1).endpoint, true)).toBe(0);
    expect(s.getPushSubscription(sub(1).endpoint)).toMatchObject({ failures: 0, lastOkAt: expect.any(String) });
    expect(s.recordPushResult('https://fcm.googleapis.com/fcm/send/absent', false)).toBe(0);
  });

  it('keeps at most fifty, and refuses the next rather than dropping a real device', () => {
    const s = store();
    for (let n = 1; n <= 50; n += 1) expect(s.savePushSubscription(sub(n))).toBe(true);
    expect(s.savePushSubscription(sub(51))).toBe(false);
    const kept = s.listPushSubscriptions().map((row) => row.endpoint);
    expect(kept).toHaveLength(50);
    expect(kept).toContain(sub(1).endpoint);
    expect(kept).not.toContain(sub(51).endpoint);
    // One that is already there can still be updated, and a place freed is a place to take.
    expect(s.savePushSubscription(sub(1, { level: 'critical' }))).toBe(true);
    s.deletePushSubscription(sub(2).endpoint);
    expect(s.savePushSubscription(sub(51))).toBe(true);
  });

  it('ends the subscriptions made under a credential that is no longer the server’s', () => {
    const s = store();
    s.savePushSubscription(sub(1, { credential: 'old-mark' }));
    s.savePushSubscription(sub(2, { credential: 'current-mark' }));
    s.savePushSubscription(sub(3));
    expect(s.prunePushSubscriptions(['current-mark', ''])).toBe(1);
    expect(s.listPushSubscriptions().map((row) => row.endpoint)).toEqual([sub(2).endpoint, sub(3).endpoint]);
    // A token was set where there was none: what was made without one ends too.
    expect(s.prunePushSubscriptions(['current-mark'])).toBe(1);
    expect(s.listPushSubscriptions().map((row) => row.credential)).toEqual(['current-mark']);
  });

  it('survives pruning, which is about mail and not about devices', () => {
    const s = store();
    s.savePushSubscription(sub(1));
    rawRun(s, "UPDATE push_subscriptions SET created_at = '2020-01-01T00:00:00.000Z'");
    s.prune(90);
    expect(s.listPushSubscriptions()).toHaveLength(1);
  });
});
