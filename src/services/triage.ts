/**
 * 重要性判定：规则先行，LLM 兜住剩下的。
 *
 * 分三层，越靠前越确定、越便宜：
 * 1. 白/黑名单——发件人明确的直接定级，不花 token 也不会被模型改判
 * 2. LLM 批量打分——真正的"这封要紧吗"，一次一批控制成本
 * 3. 关键词兜底——模型不可用时仍能保住验证码/欠费/到期这类高危信号
 */
import { z } from 'zod';
import { IMPORTANCE, IMPORTANCE_RANK, type Importance, type Rules } from '../config.js';
import { snippet, type MailMessage } from '../imap/message.js';
import { getLogger } from '../logger.js';

const log = getLogger('triage');

/** 模型不可用时的兜底信号，宁可多报不可漏报。简繁英三套。 */
export const FALLBACK_KEYWORDS = [
  '验证码', '动态密码', '一次性密码', '身份验证', '异常登录', '安全警告', '账号异常', '冻结', '实名认证', '密码重置',
  '驗證碼', '動態密碼', '一次性密碼', '身分驗證', '異常登入', '帳號異常', '凍結', '實名認證', '密碼重設',
  '欠费', '余额不足', '即将到期', '已到期', '续费', '逾期', '停机', '暂停服务', '发票', '扣款失败', '支付失败', '缴费', '账单', '退款',
  '欠費', '餘額不足', '即將到期', '續費', '停機', '暫停服務', '發票', '扣款失敗', '支付失敗', '繳費', '帳單',
  '快递', '快遞', '取件', '派送', '签收', '簽收', '物流异常', '物流異常',
  '预约', '預約', '体检', '體檢', '检查结果', '檢查結果', '就诊', '就診',
  '签证', '簽證', '护照', '護照', '证件', '證件', '到期提醒',
  '面试', '面試', '录用', '錄用', '合同', '合約', '仲裁', '法务', '法務',
  '开庭', '開庭', '传票', '傳票', '罚单', '罰單', '违章', '違章',
  '航班', '改签', '改簽', '退票', '入住', '退房',
  'verification code', 'one-time', 'otp', 'password reset', 'payment failed',
  'past due', 'overdue', 'suspended', 'expiring', 'expires', 'invoice',
  'security alert', 'unusual sign', 'unauthorized', 'action required',
  'final notice', 'terminated', 'delivery failed', 'out for delivery',
  'appointment', 'boarding pass', 'flight change', 'refund', 'chargeback',
] as const;

export interface TriageResult {
  importance: Importance;
  score: number;
  /** 邮件说了什么 + 要你做什么。用户手机上没有邮件客户端，这往往是他能看到的全部 */
  summary: string;
  reason: string;
  /** 邮件里写明的截止/生效时间，没有则为空 */
  deadline: string;
  category: string;
  actionRequired: boolean;
  decidedBy: 'rule' | 'llm' | 'fallback' | 'health' | 'digest';
}

export function rank(result: TriageResult): number {
  return IMPORTANCE_RANK[result.importance];
}

/** 卡片和简报里优先展示的一句话 */
export function headline(result: TriageResult): string {
  return result.summary || result.reason;
}

/**
 * 模型输出的 schema。用 zod 而不是手工 coerce：
 * 一份定义同时做校验、类型推导和默认值兜底，模型返回脏数据也不会炸。
 */
const LlmResult = z.object({
  index: z.coerce.number().int().nonnegative(),
  importance: z.enum(IMPORTANCE).catch('warning'),
  // 越界时夹取而不是回落：模型给 999 的意思是"极高"，
  // 落回 50 反而把它的判断丢掉了
  score: z.coerce
    .number()
    .catch(50)
    .transform((n) => Math.max(0, Math.min(100, Math.round(n)))),
  category: z.string().trim().max(60).catch('未分类'),
  action_required: z.coerce.boolean().catch(false),
  summary: z.string().trim().max(800).catch(''),
  reason: z.string().trim().max(500).catch(''),
  deadline: z.string().trim().max(60).catch(''),
});
const LlmResponse = z.object({ results: z.array(LlmResult).default([]) });

const SYSTEM_PROMPT = `你是一个邮件分诊助手。用户的工作和生活都在这几个邮箱里，
而且他手机上没装邮件客户端——你的输出就是他唯一能看到的东西。他不会去翻原文，
所以你必须把邮件说清楚，而不只是判个级别。

# 语言
邮件正文可能是简体中文、繁体中文或英文，三种都要正确理解。
**你的输出一律用简体中文**，即使原文是繁体或英文也要转成简体中文表达。
专有名词（公司名、产品名、订单号、金额、网址）保留原文，不要翻译。

# 评级标准
判断依据是"不看会不会有实际损失"，工作和生活同等重要。

- critical：不及时处理会造成实际损失或不可逆后果。
  例如：验证码与登录异常、支付/扣款失败、账单逾期、服务即将停机、
  证件或签证到期、医疗检查结果与预约变更、法律与合规通知、
  明确截止期限在 72 小时内的事项、银行与资金异动、孩子学校的紧急通知。

- warning：需要本人处理但不紧急。
  例如：真人写来的信（同事、客户、朋友、家人）、需要回复的邮件、
  一周内到期的续费或缴费、快递与物流的异常或待取件、
  行程与订票确认或变更、面试与录用、报销与发票、预约提醒。

- info：知会即可，不看也没有损失。
  例如：营销推广、新闻订阅、社交网络通知、自动化报表、系统日志、
  平台的例行动态、纯广告、已完成且无需动作的确认信。

# 注意事项
- 邮件若来自垃圾箱（in_spam=true），说明服务商判过它是垃圾。多数确实是，
  但误判的代价很高：如果它看起来是真实的账单、验证码、快递、机构或真人来信，
  照常给出应有的级别，并在 reason 里点明"疑似误判进垃圾箱"。
- 营销邮件即使写着"最后一天""仅剩 1 小时""紧急"也是 info。
  以真实后果判断，不要被措辞带节奏。
- 自动化通知里也可能混着要紧事（如扣款失败、容量告警），按后果判断而不是按发件人是否为机器人。
- 真人写来的信优先级天然高于任何自动化邮件。
- 代码托管平台（GitHub/GitLab 等）的通知要单独看：PR/Issue 的讨论虽然是真人写的，
  但抄送给你的那部分属于例行动态，是 info。只有明确 @ 你、指派给你、请你 review、
  安全公告，或你自己仓库的发布/主干构建失败，才算 warning 及以上。

# 输出字段
- summary：**最重要的字段**。用 1-2 句简体中文说清两件事：这封邮件说了什么、
  需要你做什么。用户看不到原文，只能看到这句话。
  含金额、单号、时间、地点、截止日等关键信息时必须写进来。
  不要复述标题，不要写"这是一封关于……的邮件"这种空话。
- reason：一句话说明为什么给这个级别。
- deadline：邮件里有明确的截止或生效时间就填（如"2026-09-20"或"3 天内"），没有就填空字符串。
- category：2-6 个字的简体中文分类。

只输出 JSON，格式：
{"results": [{"index": 0, "importance": "critical", "score": 0-100, "category": "分类",
"action_required": true, "summary": "说了什么+要做什么", "reason": "为什么这个级别", "deadline": ""}]}
必须为每一封邮件返回一条，index 与输入一一对应。`;

function matches(message: MailMessage, patterns: string[]): string | undefined {
  const haystack = `${message.fromAddr} ${message.fromName}`.toLowerCase();
  return patterns.find((p) => p && haystack.includes(p));
}

/** 命中白/黑名单时直接定级，返回 undefined 表示交给下一层。 */
export function applyRules(message: MailMessage, rules: Rules): TriageResult | undefined {
  const allow = matches(message, rules.alwaysImportant);
  if (allow) {
    return {
      importance: 'critical', score: 100, category: '白名单', actionRequired: true,
      decidedBy: 'rule', summary: '', reason: `发件人命中白名单规则「${allow}」`, deadline: '',
    };
  }
  const deny = matches(message, rules.neverImportant);
  if (deny) {
    return {
      importance: 'info', score: 0, category: '黑名单', actionRequired: false,
      decidedBy: 'rule', summary: '', reason: `发件人命中忽略规则「${deny}」`, deadline: '',
    };
  }
  return undefined;
}

/** LLM 不可用时的保底判定。 */
export function keywordFallback(message: MailMessage, rules: Rules): TriageResult {
  const haystack = `${message.subject}\n${snippet(message)}`.toLowerCase();
  const hits = [...rules.keywords, ...FALLBACK_KEYWORDS].filter(
    (kw) => kw && haystack.includes(kw.toLowerCase()),
  );
  const preview = `（模型不可用，以下为正文开头）${snippet(message).slice(0, 200)}`;

  if (hits.length) {
    return {
      importance: 'warning', score: 60, category: '关键词命中', actionRequired: true,
      decidedBy: 'fallback', summary: preview,
      reason: `模型不可用，关键词兜底命中: ${hits.slice(0, 3).join(', ')}`, deadline: '',
    };
  }
  // 没命中关键词时归档而不是打扰。兜底判别力比模型差得多，此时"宁可多报"
  // 会把整个通知渠道淹掉，而渠道一旦没了信噪比，漏信的概率反而更高。
  return {
    importance: 'info', score: message.listUnsubscribe ? 5 : 20,
    category: '未分类', actionRequired: false, decidedBy: 'fallback',
    summary: preview, reason: '模型不可用且无高危关键词，暂归入简报待复核', deadline: '',
  };
}

export function resolveLlmBaseUrl(): string {
  const explicit = process.env.LLM_BASE_URL?.trim();
  const provider = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (!provider) return explicit || 'https://api.deepseek.com';

  const presets: Record<string, string> = {
    deepseek: 'https://api.deepseek.com',
    xai: 'https://api.x.ai/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    glm: 'https://open.bigmodel.cn/api/paas/v4',
    zhipu: 'https://open.bigmodel.cn/api/paas/v4',
    minimax: 'https://api.minimaxi.com/v1',
    moonshot: 'https://api.moonshot.cn/v1',
    dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    siliconflow: 'https://api.siliconflow.cn/v1',
    openai: 'https://api.openai.com/v1',
  };
  const preset = presets[provider];
  if (!preset) {
    throw new Error(
      `未知 LLM_PROVIDER "${provider}"，可选 ${Object.keys(presets).sort().join(' / ')}；` +
        '要接预设之外的厂商请留空 LLM_PROVIDER 并直接写 LLM_BASE_URL',
    );
  }
  return explicit || preset;
}

/** 记一条 token 用量。分诊是这个服务唯一的付费调用，出账异常时要能回溯。 */
function logUsage(payload: unknown, batchSize: number): void {
  const usage = (payload as { usage?: Record<string, unknown> }).usage;
  if (!usage) return;
  const total = Number(usage['total_tokens'] ?? 0);
  const reasoning = Number(
    (usage['completion_tokens_details'] as Record<string, unknown> | undefined)?.['reasoning_tokens'] ?? 0,
  );
  // 缓存命中的字段名各家不同：DeepSeek 用顶层 prompt_cache_hit_tokens，
  // xAI / OpenAI 放在 prompt_tokens_details.cached_tokens
  const cached =
    Number(usage['prompt_cache_hit_tokens'] ?? 0) ||
    Number((usage['prompt_tokens_details'] as Record<string, unknown> | undefined)?.['cached_tokens'] ?? 0);
  // xAI 直接回报实际计费金额。官方口径 1 USD = 1e10 ticks
  const ticks = Number(usage['cost_in_usd_ticks'] ?? 0);
  const cost = ticks ? `，本批实际计费 $${(ticks / 1e10).toFixed(6)}` : '';

  log.info(
    `LLM 用量 | ${batchSize} 封 | prompt ${usage['prompt_tokens'] ?? 0} (缓存命中 ${cached}) + ` +
      `completion ${usage['completion_tokens'] ?? 0} (推理 ${reasoning}) = ${total}，` +
      `每封约 ${Math.round(total / Math.max(batchSize, 1))} token${cost}`,
  );
}

function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = /```(?:json)?\s*([\s\S]+?)```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error('模型输出里找不到合法 JSON');
  }
}

async function callLlm(body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${resolveLlmBaseUrl().replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.LLM_API_KEY ?? ''}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_SECONDS ?? 60) * 1000),
  });
  if (!response.ok) {
    throw new Error(`LLM HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return response.json();
}

function requestBody(messages: MailMessage[], rules: Rules, jsonMode: boolean): Record<string, unknown> {
  const bodyChars = Number(process.env.LLM_BODY_CHARS ?? 1200);
  const payload = {
    user_context: rules.context || '（用户未提供额外背景）',
    emails: messages.map((m, index) => ({
      index,
      subject: m.subject || '(无主题)',
      from: `${m.fromName} <${m.fromAddr}>`.trim(),
      in_spam: m.inSpam,
      is_bulk: m.listUnsubscribe,
      to_account: m.account,
      body: m.body.slice(0, bodyChars),
    })),
  };
  return {
    model: process.env.LLM_MODEL ?? 'deepseek-flash',
    temperature: 0,
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(payload) },
    ],
  };
}

function looksLikeJsonModeRejection(error: unknown): boolean {
  const text = String(error).toLowerCase();
  return (
    text.includes('response_format') ||
    (text.includes('json') && /not support|unsupported|invalid/.test(text))
  );
}

export type LlmResultCallback = (error: unknown | null) => void;

async function classifyBatch(
  messages: MailMessage[],
  rules: Rules,
  onLlmResult?: LlmResultCallback,
): Promise<TriageResult[]> {
  if (messages.length === 0) return [];
  if (!process.env.LLM_API_KEY?.trim()) {
    log.warn('未配置 LLM_API_KEY，全部走关键词兜底');
    return messages.map((m) => keywordFallback(m, rules));
  }

  const jsonMode = (process.env.LLM_JSON_MODE ?? 'true').toLowerCase() !== 'false';
  let parsed: z.infer<typeof LlmResponse>;
  try {
    let raw: unknown;
    try {
      raw = await callLlm(requestBody(messages, rules, jsonMode));
    } catch (error) {
      // 有的厂商不支持 json_object，去掉再试一次而不是直接判死
      if (!jsonMode || !looksLikeJsonModeRejection(error)) throw error;
      log.warn('该厂商似乎不支持 response_format，去掉后重试（可设 LLM_JSON_MODE=false 固化）');
      raw = await callLlm(requestBody(messages, rules, false));
    }
    logUsage(raw, messages.length);
    const content = (raw as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message
      ?.content;
    parsed = LlmResponse.parse(extractJson(content ?? ''));
  } catch (error) {
    log.error(`LLM 分诊失败，整批走关键词兜底: ${error}`);
    onLlmResult?.(error);
    return messages.map((m) => keywordFallback(m, rules));
  }

  onLlmResult?.(null);

  const byIndex = new Map(parsed.results.map((r) => [r.index, r]));
  return messages.map((message, index) => {
    const item = byIndex.get(index);
    if (!item) {
      log.warn(`模型漏返回 index=${index}，该封走关键词兜底`);
      return keywordFallback(message, rules);
    }
    return {
      importance: item.importance,
      score: item.score,
      summary: item.summary,
      reason: item.reason || '模型未给出理由',
      deadline: item.deadline,
      category: item.category || '未分类',
      actionRequired: item.action_required,
      decidedBy: 'llm',
    };
  });
}

/** 对一批邮件分诊，返回与输入等长、顺序一致的 (邮件, 结论)。 */
export async function triage(
  messages: MailMessage[],
  rules: Rules,
  onLlmResult?: LlmResultCallback,
): Promise<Array<[MailMessage, TriageResult]>> {
  const decided = new Map<number, TriageResult>();
  const pending: Array<[number, MailMessage]> = [];

  messages.forEach((message, index) => {
    const ruled = applyRules(message, rules);
    if (ruled) decided.set(index, ruled);
    else pending.push([index, message]);
  });

  const batchSize = Number(process.env.LLM_BATCH_SIZE ?? 10);
  for (let start = 0; start < pending.length; start += batchSize) {
    const chunk = pending.slice(start, start + batchSize);
    const outcomes = await classifyBatch(chunk.map(([, m]) => m), rules, onLlmResult);
    chunk.forEach(([index], position) => {
      const outcome = outcomes[position];
      if (outcome) decided.set(index, outcome);
    });
  }

  return messages.map((message, index) => [message, decided.get(index)!]);
}
