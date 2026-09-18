import { describe, expect, it } from 'vitest';
import './setup.js';
import { StateStore } from '../src/services/state.js';
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

  it('overwrites metadata values', () => {
    const s = store();
    expect(s.getMeta('x')).toBeUndefined();
    s.setMeta('x', 'a');
    s.setMeta('x', 'b');
    expect(s.getMeta('x')).toBe('b');
  });
});
