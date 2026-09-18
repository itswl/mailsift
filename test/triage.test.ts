import { afterEach, describe, expect, it, vi } from 'vitest';
import './setup.js';
import { makeMessage } from './helpers.js';
import type { Rules } from '../src/config.js';
import {
  applyRules, FALLBACK_KEYWORDS, headline, keywordFallback, redactForLlm, resolveLlmBaseUrl, triage,
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

describe('rule layer', () => {
  it('classifies allowlisted senders as critical without spending tokens', () => {
    const result = applyRules(makeMessage({ fromAddr: 'billing@vendor.com' }), RULES);
    expect(result).toMatchObject({ importance: 'critical', decidedBy: 'rule' });
  });

  it('classifies blocklisted senders as info', () => {
    expect(applyRules(makeMessage({ fromAddr: 'newsletter@site.com' }), RULES)?.importance).toBe('info');
  });

  it('gives the allowlist priority over the blocklist', () => {
    const message = makeMessage({ fromAddr: 'billing@x.com', fromName: 'newsletter@x' });
    expect(applyRules(message, RULES)?.importance).toBe('critical');
  });

  it('also matches display names', () => {
    const message = makeMessage({ fromAddr: 'x@y.com', fromName: 'Acme billing@dept' });
    expect(applyRules(message, RULES)?.importance).toBe('critical');
  });

  it('passes unmatched messages to the next layer', () => {
    expect(applyRules(makeMessage({ fromAddr: 'random@x.com' }), RULES)).toBeUndefined();
  });

  it('keeps explicit sender rules ahead of feedback rules', () => {
    const message = makeMessage({ fromAddr: 'explicit@example.com' });
    const result = applyRules(message, {
      ...RULES,
      neverImportant: ['explicit@example.com'],
      feedbackAlwaysImportant: ['explicit@example.com'],
    });
    expect(result?.importance).toBe('info');
  });
});

describe('keyword fallback', () => {
  it('catches high-risk signals such as verification codes', () => {
    const result = keywordFallback(makeMessage({ subject: '您的验证码是 123456' }), RULES);
    expect(result).toMatchObject({ importance: 'warning', decidedBy: 'fallback' });
  });

  it('covers Traditional Chinese variants', () => {
    // Mail from Taiwan and Hong Kong must not be missed due to character variants.
    for (const kw of ['驗證碼', '帳單', '續費', '快遞', '簽證']) {
      expect(FALLBACK_KEYWORDS as readonly string[]).toContain(kw);
    }
    expect(keywordFallback(makeMessage({ subject: '您的驗證碼為 123456' }), RULES).importance).toBe('warning');
  });

  it('archives uncertain messages instead of interrupting the user', () => {
    // Fallback classification is weak; over-alerting would flood the channel and make real messages easier to miss.
    const result = keywordFallback(makeMessage({ subject: '关于下周的安排' }), RULES);
    expect(result.importance).toBe('info');
    expect(result.score).toBeGreaterThan(keywordFallback(makeMessage({ subject: '本周精选', listUnsubscribe: true }), RULES).score);
  });

  it('still provides a summary when the model is unavailable', () => {
    const result = keywordFallback(makeMessage({ subject: '帳單通知', body: '本期應繳 500 元' }), RULES);
    expect(result.summary).toContain('本期應繳');
  });
});

describe('LLM layer', () => {
  it('parses summary and deadline', async () => {
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

  it('degrades invalid data instead of throwing', async () => {
    // Invalid importance or out-of-range scores from the model fall back to safe values.
    mockLlm([{ index: 0, importance: 'VERY URGENT!!', score: 999, reason: 'x' }]);
    process.env.LLM_API_KEY = 'k';
    const [[, result]] = await triage([makeMessage({ fromAddr: 'u@x.com' })], RULES);
    expect(result!.importance).toBe('warning');
    expect(result!.score).toBe(100);
  });

  it('uses fallback for a message omitted by the model', async () => {
    mockLlm([{ index: 0, importance: 'info', score: 1, reason: 'ad' }]);
    process.env.LLM_API_KEY = 'k';
    const results = await triage(
      [makeMessage({ fromAddr: 'a@x.com', messageId: '<1@x>' }), makeMessage({ fromAddr: 'b@x.com', messageId: '<2@x>' })],
      RULES,
    );
    expect(results).toHaveLength(2);
    expect(results[1]![1].decidedBy).toBe('fallback');
  });

  it('falls back for a batch with duplicate model indices', async () => {
    mockLlm([
      { index: 0, importance: 'critical', score: 90, reason: 'first' },
      { index: 0, importance: 'info', score: 1, reason: 'duplicate' },
    ]);
    process.env.LLM_API_KEY = 'k';
    const results = await triage(
      [makeMessage({ subject: '验证码', messageId: '<1@x>' }), makeMessage({ messageId: '<2@x>' })],
      RULES,
    );
    expect(results.every(([, result]) => result.decidedBy === 'fallback')).toBe(true);
  });

  it('uses fallback for the batch and invokes the callback on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    process.env.LLM_API_KEY = 'k';
    process.env.LLM_SKIP_SENSITIVE = 'false';
    const seen: unknown[] = [];
    const [[, result]] = await triage([makeMessage({ subject: '您的验证码 9999', fromAddr: 'u@x.com' })], RULES, (e) => seen.push(e));
    expect(result!.decidedBy).toBe('fallback');
    expect(result!.importance).toBe('warning');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeTruthy();
  });

  it('passes null to the callback on success', async () => {
    mockLlm([{ index: 0, importance: 'info', score: 1, reason: 'x' }]);
    process.env.LLM_API_KEY = 'k';
    const seen: unknown[] = [];
    await triage([makeMessage({ fromAddr: 'u@x.com' })], RULES, (e) => seen.push(e));
    expect(seen).toEqual([null]);
  });

  it('does not send rule matches to the model', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    process.env.LLM_API_KEY = 'k';
    await triage([makeMessage({ fromAddr: 'billing@v.com' })], RULES);
    expect(spy).not.toHaveBeenCalled();
  });

  it('preserves input order when rules and model results are mixed', async () => {
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

  it('uses fallback throughout without an API key', async () => {
    const [[, result]] = await triage([makeMessage({ fromAddr: 'u@x.com' })], RULES);
    expect(result!.decidedBy).toBe('fallback');
  });

  it('keeps verification-code messages out of the LLM', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    process.env.LLM_API_KEY = 'k';
    const [[, result]] = await triage([makeMessage({ subject: 'Your verification code is 123456' })], RULES);
    expect(spy).not.toHaveBeenCalled();
    expect(result!.decidedBy).toBe('fallback');
    expect(result!.reason).toContain('LLM skipped');
  });

  it('redacts direct identifiers before LLM use', () => {
    expect(redactForLlm('Contact a@example.com or +86 138-1234-5678; card 4111 1111 1111 1111.'))
      .toBe('Contact [EMAIL] or [PHONE]; card [CARD].');
  });
});

describe('provider presets', () => {
  it('defaults to DeepSeek', () => {
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

  it('explicit base_url overrides the preset for a self-hosted gateway', () => {
    process.env.LLM_PROVIDER = 'xai';
    process.env.LLM_BASE_URL = 'https://gateway.internal/v1';
    expect(resolveLlmBaseUrl()).toBe('https://gateway.internal/v1');
  });

  it('errors on an unknown provider instead of silently using the default', () => {
    process.env.LLM_PROVIDER = 'nope';
    expect(() => resolveLlmBaseUrl()).toThrow(/Unknown LLM_PROVIDER/);
  });
});
