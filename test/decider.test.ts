import { afterEach, describe, expect, it, vi } from 'vitest';
import './setup.js';
import { makeMessage } from './helpers.js';
import type { Rules } from '../src/config.js';
import { aiGatewayHeaders, deciderConfigured, decideMessages, mapDeciderAnswers } from '../src/services/decider.js';
import { triage } from '../src/services/triage.js';

const RULES: Rules = {
  alwaysImportant: [],
  neverImportant: [],
  keywords: [],
  context: '独立开发者',
};

function enableDecider(): void {
  process.env.LLM_API_KEY = 'llm-key';
  process.env.DECIDER_BASE_URL = 'https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/cloudflare';
  process.env.DECIDER_API_TOKEN = 'decider-token';
  process.env.DECIDER_MODEL = 'clef-flash';
}

function clefResponse(answers: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ success: true, result: { answers, usage: { input_tokens: 120 } } }), {
    status: 200,
  });
}

function llmResponse(results: unknown[]): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }], usage: {} }),
    { status: 200 },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('mapDeciderAnswers', () => {
  it('maps a full answer set onto a decision', () => {
    const decision = mapDeciderAnswers({
      importance: { type: 'choice', choice: 'warning', confidence: 0.8, probabilities: { warning: 0.8 } },
      category: { type: 'choice', choice: 'Finance', confidence: 0.9 },
      action_required: { type: 'noul', noul: 0.61 },
    });
    expect(decision).toEqual({ importance: 'warning', score: 73, category: 'Finance', actionRequired: true, confidence: 0.8 });
  });

  it('keeps each level inside its score band', () => {
    const critical = mapDeciderAnswers({
      importance: { choice: 'critical', confidence: 1 },
      category: { choice: 'Security' },
      action_required: { noul: 1 },
    });
    const info = mapDeciderAnswers({
      importance: { choice: 'info', confidence: 1 },
      category: { choice: 'Marketing' },
      action_required: { noul: 0 },
    });
    expect(critical!.score).toBe(100);
    expect(critical!.actionRequired).toBe(true);
    expect(info!.score).toBe(0);
    expect(info!.importance).toBe('info');
  });

  it('defaults confidence when the answer omits it', () => {
    const decision = mapDeciderAnswers({
      importance: { choice: 'info' },
      category: { choice: 'Other' },
      action_required: { noul: 0.2 },
    });
    // confidence 0.75 → info scores 49 * 0.25 ≈ 12
    expect(decision!.score).toBe(12);
  });

  it('canonicalizes unknown categories and rejects unusable answers', () => {
    const odd = mapDeciderAnswers({
      importance: { choice: 'critical' },
      category: { choice: '金融账单' },
      action_required: { noul: 0.9 },
    });
    expect(odd!.category).toBe('Other');
    expect(mapDeciderAnswers(null)).toBeNull();
    expect(mapDeciderAnswers({ importance: { choice: 'urgent!!' } })).toBeNull();
    expect(mapDeciderAnswers({})).toBeNull();
  });
});

describe('deciderConfigured', () => {
  it('is off by default and on when fully configured', () => {
    expect(deciderConfigured()).toBe(false);
    enableDecider();
    expect(deciderConfigured()).toBe(true);
  });

  it('stays off without a token even when a URL is set', () => {
    process.env.DECIDER_BASE_URL = 'https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/cloudflare';
    expect(deciderConfigured()).toBe(false);
  });
});

describe('aiGatewayHeaders', () => {
  it('is empty unless AI_GATEWAY_ID is set', () => {
    expect(aiGatewayHeaders()).toEqual({});
    process.env.AI_GATEWAY_ID = 'default';
    expect(aiGatewayHeaders()).toEqual({ 'cf-aig-gateway-id': 'default' });
    process.env.AI_GATEWAY_ID = '  spaced  ';
    expect(aiGatewayHeaders()).toEqual({ 'cf-aig-gateway-id': 'spaced' });
  });

  it('attaches the gateway header to both stages when configured', async () => {
    enableDecider();
    process.env.AI_GATEWAY_ID = 'default';
    const seenHeaders: Array<Record<string, string>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        seenHeaders.push(init?.headers as Record<string, string>);
        if (String(input).includes('/ai/run/')) {
          return clefResponse({
            importance: { choice: 'info' },
            category: { choice: 'Marketing' },
            action_required: { noul: 0.1 },
          });
        }
        return llmResponse([{ index: 0, summary: 's', reason: 'r' }]);
      }),
    );

    await triage([makeMessage({ fromAddr: 'u@x.com' })], RULES);
    expect(seenHeaders).toHaveLength(2);
    for (const headers of seenHeaders) {
      expect(headers['cf-aig-gateway-id']).toBe('default');
    }
  });

  it('omits the gateway header when not configured', async () => {
    enableDecider();
    const seenHeaders: Array<Record<string, string>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        seenHeaders.push(init?.headers as Record<string, string>);
        return String(input).includes('/ai/run/')
          ? clefResponse({ importance: { choice: 'info' }, category: { choice: 'Marketing' }, action_required: { noul: 0.1 } })
          : llmResponse([{ index: 0, summary: 's', reason: 'r' }]);
      }),
    );

    await triage([makeMessage({ fromAddr: 'u@x.com' })], RULES);
    for (const headers of seenHeaders) {
      expect(headers['cf-aig-gateway-id']).toBeUndefined();
    }
  });
});

describe('decideMessages', () => {
  it('posts one typed-question request per message and returns decisions', async () => {
    enableDecider();
    const spy = vi.fn(async (input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(String(input)).toContain('/ai/run/@cf/cloudflare/clef-flash');
      expect(body.model).toBe('clef-flash');
      expect(body.state.subject).toBe('测试主题');
      expect(body.state.user_context).toBe('独立开发者');
      expect(Object.keys(body.questions)).toEqual(['importance', 'category', 'action_required']);
      return clefResponse({
        importance: { choice: 'critical', confidence: 0.9 },
        category: { choice: 'Security' },
        action_required: { noul: 0.95 },
      });
    });
    vi.stubGlobal('fetch', spy);

    const decisions = await decideMessages([makeMessage()], RULES);
    expect(decisions).toEqual([{ importance: 'critical', score: 98, category: 'Security', actionRequired: true, confidence: 0.9 }]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('returns null when any request fails, so the batch falls back', async () => {
    enableDecider();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('quota exceeded', { status: 429 })));
    expect(await decideMessages([makeMessage()], RULES)).toBeNull();
  });

  it('hides verification-mail bodies from the decision stage too', async () => {
    enableDecider();
    const spy = vi.fn(async () =>
      clefResponse({
        importance: { choice: 'warning' },
        category: { choice: 'Security' },
        action_required: { noul: 0.7 },
      }),
    );
    vi.stubGlobal('fetch', spy);
    await decideMessages([makeMessage({ subject: '验证码 889900', body: '您的验证码是 889900' })], RULES);
    const body = JSON.parse(String(spy.mock.calls[0]![1]?.body));
    expect(body.state.body).toBe('验证码邮件（内容已隐藏）');
  });
});

describe('two-stage triage', () => {
  it('merges decider classifications with LLM summaries', async () => {
    enableDecider();
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        if (String(input).includes('/ai/run/')) {
          return clefResponse({
            importance: { choice: 'warning', confidence: 0.8 },
            category: { choice: 'Finance' },
            action_required: { noul: 0.9 },
          });
        }
        return llmResponse([{ index: 0, summary: '九月工资已发放，11月5日前有疑问联系财务', reason: '有确认截止日', deadline: '11月5日' }]);
      }),
    );

    const [[, result]] = await triage([makeMessage({ fromAddr: 'hr@company.cn' })], RULES);
    expect(calls).toHaveLength(2);
    // Stage 2 receives the decisions and is told not to re-judge them.
    const summaryBody = calls[1]!.body as { model: string; messages: Array<{ content: string }> };
    expect(summaryBody.messages[0]!.content).toContain('already been decided');
    const userPayload = JSON.parse(summaryBody.messages[1]!.content as string);
    expect(userPayload.decisions).toEqual([{ index: 0, importance: 'warning', category: 'Finance', action_required: true }]);

    expect(result).toMatchObject({
      importance: 'warning',
      score: 73,
      category: 'Finance',
      actionRequired: true,
      summary: '九月工资已发放，11月5日前有疑问联系财务',
      deadline: '11月5日',
      decidedBy: 'llm',
    });
  });

  it('falls back to the single-stage pipeline when the decider fails', async () => {
    enableDecider();
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        calls.push(String(input));
        if (String(input).includes('/ai/run/')) return new Response('boom', { status: 500 });
        return llmResponse([{ index: 0, importance: 'critical', score: 90, category: 'Security', action_required: true, summary: 's', reason: 'r' }]);
      }),
    );

    const [[, result]] = await triage([makeMessage({ fromAddr: 'u@x.com' })], RULES);
    expect(calls).toHaveLength(2); // one decider attempt, then the full single-stage call
    expect(result!.importance).toBe('critical'); // from the LLM, not a decider
  });

  it('keeps decisions when the summary stage fails', async () => {
    enableDecider();
    const seen: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) =>
        String(input).includes('/ai/run/')
          ? clefResponse({
              importance: { choice: 'critical', confidence: 0.9 },
              category: { choice: 'Security' },
              action_required: { noul: 1 },
            })
          : new Response('boom', { status: 500 }),
      ),
    );

    const [[, result]] = await triage([makeMessage({ fromAddr: 'u@x.com' })], RULES, (e) => seen.push(e));
    expect(result!.importance).toBe('critical');
    expect(result!.score).toBe(98);
    expect(result!.reason).toContain('confidence 90%');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeTruthy();
  });

  it('never calls the decider when it is not configured', async () => {
    process.env.LLM_API_KEY = 'k';
    const spy = vi.fn(async () => llmResponse([{ index: 0, importance: 'info', score: 5, reason: 'x' }]));
    vi.stubGlobal('fetch', spy);
    await triage([makeMessage({ fromAddr: 'u@x.com' })], RULES);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]![0])).not.toContain('/ai/run/');
  });
});
