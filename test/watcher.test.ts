import { describe, expect, it, vi } from 'vitest';
import './setup.js';
import { makeMessage, makeResult, RecordingSink } from './helpers.js';
import { StateStore } from '../src/services/state.js';
import { Watcher } from '../src/services/watcher.js';
import type { WatchConfig } from '../src/config.js';
import * as triageModule from '../src/services/triage.js';
import type { MailMessage } from '../src/imap/message.js';
import type { TriageResult } from '../src/services/triage.js';

const CONFIG: WatchConfig = {
  accounts: [],
  rules: { alwaysImportant: [], neverImportant: [], keywords: [], context: '' },
};

function watcher(sink = new RecordingSink()): { w: Watcher; sink: RecordingSink; state: StateStore } {
  const state = new StateStore(':memory:');
  return { w: new Watcher(CONFIG, state, sink), sink, state };
}

function stubTriage(mapping: Record<string, TriageResult>): void {
  vi.spyOn(triageModule, 'triage').mockImplementation(
    async (messages: MailMessage[]) => messages.map((m) => [m, mapping[m.messageId]!] as [MailMessage, TriageResult]),
  );
}

const stats = () => ({
  accountsOk: 0, accountsFailed: 0, fetched: 0, fresh: 0,
  pushed: 0, queued: 0, spamRescued: 0, failures: [] as string[],
});

describe('推送阈值', () => {
  it('达到阈值才实时推', async () => {
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    const { w, sink } = watcher();
    stubTriage({
      '<c@x>': makeResult({ importance: 'critical' }),
      '<w@x>': makeResult({ importance: 'warning' }),
      '<i@x>': makeResult({ importance: 'info' }),
    });
    const s = stats();
    await w.dispatch(
      [makeMessage({ messageId: '<c@x>' }), makeMessage({ messageId: '<w@x>' }), makeMessage({ messageId: '<i@x>' })],
      s,
    );
    expect(s.pushed).toBe(2);
    expect(sink.pushed.map(([m]) => m.messageId)).toEqual(['<c@x>', '<w@x>']);
  });

  it('低于阈值进简报', async () => {
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    const { w, state } = watcher();
    stubTriage({ '<i@x>': makeResult({ importance: 'info' }) });
    const s = stats();
    await w.dispatch([makeMessage({ messageId: '<i@x>' })], s);
    expect(s.pushed).toBe(0);
    expect(state.digestPending()).toBe(1);
  });
});

describe('垃圾箱策略', () => {
  it('默认不加档——全推等于把垃圾箱噪音搬到 IM 上', async () => {
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    const { w, state } = watcher();
    stubTriage({ '<s@x>': makeResult({ importance: 'info' }) });
    const s = stats();
    await w.dispatch([makeMessage({ messageId: '<s@x>', inSpam: true })], s);
    expect(s.pushed).toBe(0);
    expect(state.digestPending()).toBe(1);
  });

  it('垃圾箱必进简报，不受简报阈值限制', async () => {
    // 这是"垃圾箱不再是黑洞"的兜底
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    process.env.DIGEST_MIN_IMPORTANCE = 'critical';
    const { w, state } = watcher();
    stubTriage({
      '<s@x>': makeResult({ importance: 'info' }),
      '<i@x>': makeResult({ importance: 'info' }),
    });
    await w.dispatch([makeMessage({ messageId: '<s@x>', inSpam: true }), makeMessage({ messageId: '<i@x>' })], stats());
    expect(state.digestPending()).toBe(1);
  });

  it('加档是可选的', async () => {
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    process.env.SPAM_RANK_BONUS = '1';
    const { w } = watcher();
    stubTriage({ '<s@x>': makeResult({ importance: 'info' }) });
    const s = stats();
    await w.dispatch([makeMessage({ messageId: '<s@x>', inSpam: true })], s);
    expect(s.pushed).toBe(1);
  });

  it('捞回计数单独统计', async () => {
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    const { w } = watcher();
    stubTriage({
      '<s@x>': makeResult({ importance: 'critical' }),
      '<n@x>': makeResult({ importance: 'critical' }),
    });
    const s = stats();
    await w.dispatch([makeMessage({ messageId: '<s@x>', inSpam: true }), makeMessage({ messageId: '<n@x>' })], s);
    expect(s.pushed).toBe(2);
    expect(s.spamRescued).toBe(1);
  });
});

describe('去重', () => {
  it('批内去重（同一封信可能在两个文件夹里）', () => {
    const { w } = watcher();
    const fresh = w.filterFresh([
      makeMessage({ messageId: '<a@x>' }),
      makeMessage({ messageId: '<a@x>' }),
      makeMessage({ messageId: '<b@x>' }),
    ]);
    expect(fresh).toHaveLength(2);
  });

  it('filterFresh 只查不写', () => {
    // 标记推迟到 dispatch，否则崩溃会让邮件静默消失
    const { w, state } = watcher();
    const messages = [makeMessage({ messageId: '<a@x>' })];
    expect(w.filterFresh(messages)).toHaveLength(1);
    expect(w.filterFresh(messages)).toHaveLength(1);
    expect(state.isSeen('me@qq.com|<a@x>')).toBe(false);
  });

  it('同一封信发到两个邮箱各算一条', () => {
    const { w } = watcher();
    const fresh = w.filterFresh([
      makeMessage({ messageId: '<a@x>', account: 'me@qq.com' }),
      makeMessage({ messageId: '<a@x>', account: 'me@gmail.com' }),
    ]);
    expect(fresh).toHaveLength(2);
  });

  it('处理过的下轮不再进', async () => {
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    const { w } = watcher();
    stubTriage({ '<a@x>': makeResult({ importance: 'critical' }) });
    await w.dispatch(w.filterFresh([makeMessage({ messageId: '<a@x>' })]), stats());
    expect(w.filterFresh([makeMessage({ messageId: '<a@x>' })])).toHaveLength(0);
  });
});

describe('投递失败的处理', () => {
  it('不计入推送数', async () => {
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    const { w } = watcher(new RecordingSink(false));
    stubTriage({ '<c@x>': makeResult({ importance: 'critical' }) });
    const s = stats();
    await w.dispatch([makeMessage({ messageId: '<c@x>' })], s);
    expect(s.pushed).toBe(0);
  });

  it('状态库如实记录未送达', async () => {
    // 谎报成功的话事后根本查不出漏了哪封
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    const { w, state } = watcher(new RecordingSink(false));
    stubTriage({ '<c@x>': makeResult({ importance: 'critical' }) });
    await w.dispatch(w.filterFresh([makeMessage({ messageId: '<c@x>' })]), stats());
    expect(state.queryMail({ pushedOnly: true })).toHaveLength(0);
  });

  it('兜进简报，不让它凭空消失', async () => {
    // 邮件已被标记 seen，下轮不会重拉；投递失败必须有个去处
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    const { w, state } = watcher(new RecordingSink(false));
    stubTriage({ '<c@x>': makeResult({ importance: 'critical' }) });
    const s = stats();
    await w.dispatch([makeMessage({ messageId: '<c@x>' })], s);
    expect(s.queued).toBe(1);
    expect(state.digestPending()).toBe(1);
  });
});

describe('崩溃安全', () => {
  it('分诊失败时游标不推进', async () => {
    // 否则这批信再也拉不到，且完全静默
    const { w, state } = watcher();
    vi.spyOn(w, 'collectAll').mockResolvedValue({
      messages: [makeMessage({ messageId: '<a@x>' })],
      cursors: [['me@qq.com', 'INBOX', '1', 99]],
    });
    vi.spyOn(triageModule, 'triage').mockRejectedValue(new Error('崩了'));

    await expect(w.pollOnce()).rejects.toThrow('崩了');
    expect(state.getCursor('me@qq.com', 'INBOX')).toBeUndefined();
    expect(state.isSeen('me@qq.com|<a@x>')).toBe(false);
  });

  it('成功后才推进游标', async () => {
    process.env.PUSH_MIN_IMPORTANCE = 'warning';
    const { w, state } = watcher();
    vi.spyOn(w, 'collectAll').mockResolvedValue({
      messages: [makeMessage({ messageId: '<a@x>' })],
      cursors: [['me@qq.com', 'INBOX', '1', 99]],
    });
    stubTriage({ '<a@x>': makeResult({ importance: 'critical' }) });

    await w.pollOnce();
    expect(state.getCursor('me@qq.com', 'INBOX')).toEqual({ uidValidity: '1', lastUid: 99 });
    expect(state.isSeen('me@qq.com|<a@x>')).toBe(true);
  });

  it('写心跳供健康检查用', async () => {
    const { w, state } = watcher();
    vi.spyOn(w, 'collectAll').mockResolvedValue({ messages: [], cursors: [] });
    expect(state.getMeta('last_poll_at')).toBeUndefined();
    await w.pollOnce();
    expect(state.getMeta('last_poll_at')).toBeTruthy();
  });

  it('每天清理一次状态库', async () => {
    const { w, state } = watcher();
    vi.spyOn(w, 'collectAll').mockResolvedValue({ messages: [], cursors: [] });
    const spy = vi.spyOn(state, 'prune').mockReturnValue(0);
    await w.pollOnce();
    await w.pollOnce();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(90);
  });

  it('清理可关闭', async () => {
    process.env.STATE_RETENTION_DAYS = '0';
    const { w, state } = watcher();
    vi.spyOn(w, 'collectAll').mockResolvedValue({ messages: [], cursors: [] });
    const spy = vi.spyOn(state, 'prune');
    await w.pollOnce();
    expect(spy).not.toHaveBeenCalled();
  });
});
