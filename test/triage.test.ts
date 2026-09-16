import { afterEach, describe, expect, it, vi } from 'vitest';
import './setup.js';
import { makeMessage } from './helpers.js';
import type { Rules } from '../src/config.js';
import {
  applyRules, FALLBACK_KEYWORDS, headline, keywordFallback, resolveLlmBaseUrl, triage,
} from '../src/services/triage.js';

const RULES: Rules = {
  alwaysImportant: ['billing@', '@bank.com'],
  neverImportant: ['newsletter@'],
  keywords: ['域名到期'],
  context: '独立开发者',
};

function mockLlm(results: unknown[], usage?: Record<string, unknown>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ results }) } }],
          ...(usage ? { usage } : {}),
        }),
        { status: 200 },
      ),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('规则层', () => {
  it('白名单直接判 critical，不花 token', () => {
    const result = applyRules(makeMessage({ fromAddr: 'billing@vendor.com' }), RULES);
    expect(result).toMatchObject({ importance: 'critical', decidedBy: 'rule' });
  });

  it('黑名单直接判 info', () => {
    expect(applyRules(makeMessage({ fromAddr: 'newsletter@site.com' }), RULES)?.importance).toBe('info');
  });

  it('白名单优先于黑名单', () => {
    const message = makeMessage({ fromAddr: 'billing@x.com', fromName: 'newsletter@x' });
    expect(applyRules(message, RULES)?.importance).toBe('critical');
  });

  it('也匹配显示名', () => {
    const message = makeMessage({ fromAddr: 'x@y.com', fromName: 'Acme billing@dept' });
    expect(applyRules(message, RULES)?.importance).toBe('critical');
  });

  it('未命中时交给下一层', () => {
    expect(applyRules(makeMessage({ fromAddr: 'random@x.com' }), RULES)).toBeUndefined();
  });
});

describe('关键词兜底', () => {
  it('抓住验证码这类高危信号', () => {
    const result = keywordFallback(makeMessage({ subject: '您的验证码是 123456' }), RULES);
    expect(result).toMatchObject({ importance: 'warning', decidedBy: 'fallback' });
  });

  it('覆盖繁体字形', () => {
    // 台港来信不能因为字形不同就漏掉
    for (const kw of ['驗證碼', '帳單', '續費', '快遞', '簽證']) {
      expect(FALLBACK_KEYWORDS as readonly string[]).toContain(kw);
    }
    expect(keywordFallback(makeMessage({ subject: '您的驗證碼為 123456' }), RULES).importance).toBe('warning');
  });

  it('不确定时归档而不是打扰', () => {
    // 兜底判别力差，"宁可多报"会把通知渠道淹掉，而渠道没了信噪比反而更容易漏
    const result = keywordFallback(makeMessage({ subject: '关于下周的安排' }), RULES);
    expect(result.importance).toBe('info');
    expect(result.score).toBeGreaterThan(keywordFallback(makeMessage({ subject: '本周精选', listUnsubscribe: true }), RULES).score);
  });

  it('模型不可用时也给出摘要，不让卡片一片空白', () => {
    const result = keywordFallback(makeMessage({ subject: '帳單通知', body: '本期應繳 500 元' }), RULES);
    expect(result.summary).toContain('本期應繳');
  });
});

describe('LLM 层', () => {
  it('解析 summary 与 deadline', async () => {
    mockLlm([{
      index: 0, importance: 'critical', score: 95, category: '医疗健康',
      action_required: true, reason: '检查结果异常需复诊',
      summary: '体检中心通知你的血糖指标偏高，建议两周内到内分泌科复诊', deadline: '两周内',
    }]);
    process.env.LLM_API_KEY = 'k';
    const [[, result]] = await triage([makeMessage({ fromAddr: 'u@x.com' })], RULES);
    expect(result!.summary).toContain('体检中心');
    expect(result!.deadline).toBe('两周内');
    expect(headline(result!)).toBe(result!.summary);
  });

  it('zod 把脏数据降级而不是抛异常', async () => {
    // 模型返回非法 importance / 超范围 score 时自动落回安全值
    mockLlm([{ index: 0, importance: 'VERY URGENT!!', score: 999, reason: 'x' }]);
    process.env.LLM_API_KEY = 'k';
    const [[, result]] = await triage([makeMessage({ fromAddr: 'u@x.com' })], RULES);
    expect(result!.importance).toBe('warning');
    expect(result!.score).toBe(100);
  });

  it('模型漏返回某一条时该封走兜底', async () => {
    mockLlm([{ index: 0, importance: 'info', score: 1, reason: 'ad' }]);
    process.env.LLM_API_KEY = 'k';
    const results = await triage(
      [makeMessage({ fromAddr: 'a@x.com', messageId: '<1@x>' }), makeMessage({ fromAddr: 'b@x.com', messageId: '<2@x>' })],
      RULES,
    );
    expect(results).toHaveLength(2);
    expect(results[1]![1].decidedBy).toBe('fallback');
  });

  it('调用失败时整批兜底并回调', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    process.env.LLM_API_KEY = 'k';
    const seen: unknown[] = [];
    const [[, result]] = await triage([makeMessage({ subject: '您的验证码 9999', fromAddr: 'u@x.com' })], RULES, (e) => seen.push(e));
    expect(result!.decidedBy).toBe('fallback');
    expect(result!.importance).toBe('warning');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeTruthy();
  });

  it('成功时回调收到 null', async () => {
    mockLlm([{ index: 0, importance: 'info', score: 1, reason: 'x' }]);
    process.env.LLM_API_KEY = 'k';
    const seen: unknown[] = [];
    await triage([makeMessage({ fromAddr: 'u@x.com' })], RULES, (e) => seen.push(e));
    expect(seen).toEqual([null]);
  });

  it('规则命中的不送模型', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    process.env.LLM_API_KEY = 'k';
    await triage([makeMessage({ fromAddr: 'billing@v.com' })], RULES);
    expect(spy).not.toHaveBeenCalled();
  });

  it('保持输入顺序（规则与模型混在一批时）', async () => {
    mockLlm([{ index: 0, importance: 'info', score: 1, reason: 'ad' }]);
    process.env.LLM_API_KEY = 'k';
    const results = await triage(
      [makeMessage({ fromAddr: 'billing@v.com', messageId: '<rule@x>' }), makeMessage({ fromAddr: 'unknown@x.com', messageId: '<llm@x>' })],
      RULES,
    );
    expect(results.map(([m]) => m.messageId)).toEqual(['<rule@x>', '<llm@x>']);
    expect(results[0]![1].decidedBy).toBe('rule');
    expect(results[1]![1].decidedBy).toBe('llm');
  });

  it('没有 API key 时全程兜底', async () => {
    const [[, result]] = await triage([makeMessage({ fromAddr: 'u@x.com' })], RULES);
    expect(result!.decidedBy).toBe('fallback');
  });
});

describe('厂商预设', () => {
  it('默认 deepseek', () => {
    expect(resolveLlmBaseUrl()).toBe('https://api.deepseek.com');
  });

  it.each([
    ['xai', 'https://api.x.ai/v1'],
    ['openrouter', 'https://openrouter.ai/api/v1'],
    ['glm', 'https://open.bigmodel.cn/api/paas/v4'],
  ])('%s -> %s', (provider, url) => {
    process.env.LLM_PROVIDER = provider;
    expect(resolveLlmBaseUrl()).toBe(url);
  });

  it('显式 base_url 压过预设（自建网关场景）', () => {
    process.env.LLM_PROVIDER = 'xai';
    process.env.LLM_BASE_URL = 'https://gateway.internal/v1';
    expect(resolveLlmBaseUrl()).toBe('https://gateway.internal/v1');
  });

  it('未知厂商报错而不是静默走默认', () => {
    process.env.LLM_PROVIDER = 'nope';
    expect(() => resolveLlmBaseUrl()).toThrow(/未知 LLM_PROVIDER/);
  });
});
