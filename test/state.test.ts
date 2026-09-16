import { describe, expect, it } from 'vitest';
import './setup.js';
import { StateStore } from '../src/services/state.js';

function store(): StateStore {
  return new StateStore(':memory:');
}

describe('去重', () => {
  it('markSeen 幂等', () => {
    const s = store();
    expect(s.markSeen('k1', 'me@qq.com', '主题')).toBe(true);
    expect(s.markSeen('k1', 'me@qq.com', '主题')).toBe(false);
  });

  it('isSeen 只查不写', () => {
    // 标记要推迟到分诊投递之后，否则崩溃会让邮件静默消失
    const s = store();
    expect(s.isSeen('k1')).toBe(false);
    expect(s.isSeen('k1')).toBe(false);
  });
});

describe('游标', () => {
  it('按 (账号, 文件夹) 隔离', () => {
    const s = store();
    s.saveCursor('a@qq.com', 'INBOX', '1', 100);
    s.saveCursor('b@qq.com', 'INBOX', '1', 200);
    s.saveCursor('a@qq.com', 'Junk', '1', 5);
    expect(s.getCursor('a@qq.com', 'INBOX')).toEqual({ uidValidity: '1', lastUid: 100 });
    expect(s.getCursor('b@qq.com', 'INBOX')).toEqual({ uidValidity: '1', lastUid: 200 });
    expect(s.getCursor('a@qq.com', 'Junk')).toEqual({ uidValidity: '1', lastUid: 5 });
  });

  it('可整体回滚（--recover 用）', () => {
    const s = store();
    s.saveCursor('a@qq.com', 'INBOX', '1', 100);
    expect(s.clearCursors()).toBe(1);
    expect(s.getCursor('a@qq.com', 'INBOX')).toBeUndefined();
  });
});

describe('富字段与查询', () => {
  function seed(s: StateStore, key: string, fields: Record<string, unknown> = {}): void {
    s.markSeen(key, String(fields['account'] ?? 'me@qq.com'), String(fields['subject'] ?? 's'));
    s.recordOutcome(key, String(fields['importance'] ?? 'info'), Boolean(fields['pushed']), fields);
  }

  it('往返保真', () => {
    const s = store();
    seed(s, 'k1', {
      importance: 'critical', pushed: true, messageId: '<a@x>', sender: 'billing@v.com',
      inSpam: true, category: '账单', summary: '域名到期', snippet: '正文',
    });
    const item = s.getMail('<a@x>');
    expect(item).toMatchObject({ sender: 'billing@v.com', inSpam: true, pushed: true, summary: '域名到期' });
    expect(item?.snippet).toBe('正文');
  });

  it('按条件筛选', () => {
    const s = store();
    seed(s, 'k1', { importance: 'critical', pushed: true, messageId: '<1@x>', inSpam: true, sender: 'a@bank.com' });
    seed(s, 'k2', { importance: 'info', messageId: '<2@x>', sender: 'news@site.com' });
    seed(s, 'k3', { importance: 'critical', pushed: true, messageId: '<3@x>' });
    expect(s.queryMail({ importance: 'critical' })).toHaveLength(2);
    expect(s.queryMail({ spamOnly: true })).toHaveLength(1);
    expect(s.queryMail({ pushedOnly: true })).toHaveLength(2);
    expect(s.queryMail({ search: 'bank' }).map((m) => m.messageId)).toEqual(['<1@x>']);
  });

  it('搜索覆盖摘要与理由', () => {
    const s = store();
    seed(s, 'k1', { messageId: '<1@x>', summary: '域名续费到期通知', category: '账单续费' });
    expect(s.queryMail({ search: '续费' })).toHaveLength(1);
  });

  it('统计垃圾箱捞回', () => {
    const s = store();
    seed(s, 'k1', { importance: 'critical', pushed: true, inSpam: true });
    seed(s, 'k2', { importance: 'info', inSpam: true });
    seed(s, 'k3', { importance: 'warning', pushed: true });
    expect(s.summarize(24)).toMatchObject({
      total: 3, pushed: 2, fromSpamFolder: 2, rescuedFromSpam: 1,
    });
  });
});

describe('维护', () => {
  it('查得出被中断留下的无结论记录并能清掉', () => {
    const s = store();
    s.markSeen('stuck', 'me@qq.com', '被中断');
    s.markSeen('done', 'me@qq.com', '正常');
    s.recordOutcome('done', 'info', false);
    expect(s.countUndispatched()).toBe(1);
    expect(s.dropUndispatched()).toBe(1);
    expect(s.isSeen('done')).toBe(true);
  });

  it('prune 只删旧的', () => {
    const s = store();
    s.markSeen('old', 'me@qq.com', '旧');
    s.markSeen('new', 'me@qq.com', '新');
    s.recordOutcome('old', 'info', false);
    s.recordOutcome('new', 'info', false);
    // 手工把一条改成 200 天前
    const stale = new Date(Date.now() - 200 * 86_400_000).toISOString();
    (s as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db
      .prepare('UPDATE seen SET created_at = ? WHERE dedup_key = ?')
      .run(stale, 'old');
    expect(s.prune(90)).toBe(1);
    expect(s.isSeen('old')).toBe(false);
    expect(s.isSeen('new')).toBe(true);
  });

  it('简报队列排空一次就没了', () => {
    const s = store();
    s.queueDigest('k1', { subject: 'a' });
    s.queueDigest('k2', { subject: 'b' });
    s.queueDigest('k1', { subject: 'dup' });
    expect(s.digestPending()).toBe(2);
    expect(s.drainDigest()).toHaveLength(2);
    expect(s.drainDigest()).toEqual([]);
  });

  it('meta 覆盖写', () => {
    const s = store();
    expect(s.getMeta('x')).toBeUndefined();
    s.setMeta('x', 'a');
    s.setMeta('x', 'b');
    expect(s.getMeta('x')).toBe('b');
  });
});
