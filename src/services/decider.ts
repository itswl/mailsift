/**
 * Decision stage for two-stage triage: a calibrated decision model (Cloudflare
 * Clef on Workers AI) judges importance, category, and the action flag first;
 * the text LLM stage then only explains each message. The single-LLm pipeline
 * stays the default — two-stage runs only when the DECIDER_* variables are set.
 *
 * Clef answers typed questions instead of generating text, so the classification
 * cannot hallucinate a label outside the vocabulary and every answer carries a
 * confidence. It also costs ~2 neurons per message, roughly a quarter of the
 * cheapest text model, so screening bulk mail through it keeps the summary
 * stage small.
 *
 * Environment:
 *   DECIDER_BASE_URL          e.g. https://api.cloudflare.com/client/v4/accounts/<id>/ai/run/@cf/cloudflare
 *   DECIDER_MODEL             clef | clef-flash | clef-omni (default clef-flash)
 *   DECIDER_API_TOKEN         bearer token with Workers AI access
 *   DECIDER_TIMEOUT_SECONDS   per-request timeout (default 15)
 */
import type { Rules } from '../config.js';
import type { MailMessage } from '../imap/message.js';
import { getLogger } from '../logger.js';
import { canonicalCategory, containsSensitiveContent, redactForLlm, type Category } from './triage.js';
import type { Importance } from '../config.js';

const log = getLogger('decider');

/** The three typed questions asked for every message. */
const importanceQuestion = {
  type: 'choice' as const,
  instructions:
    'Judge whether ignoring this message could cause real harm; work and personal matters are equally ' +
    'important. Marketing stays the lowest level even when it says "last day" or "urgent". ' +
    'Judge automated notices by consequences, not by whether the sender is a bot.',
  criteria: {
    critical:
      'Delay could cause financial loss or an irreversible consequence: login anomalies, failed payments, ' +
      'overdue bills, expiring services or documents, medical results, legal notices, deadlines within 72 hours, ' +
      'bank activity, or urgent school notices.',
    warning:
      'The user needs to act, but it is not urgent: a human message, a reply request, a renewal due within a week, ' +
      'delivery issues, travel changes, interviews, invoices, or appointments.',
    info:
      'Awareness only; ignoring it causes no loss: marketing, newsletters, social notifications, routine reports, ' +
      'system logs, ordinary platform updates, ads, and completed confirmations.',
  },
};

const categoryQuestion = {
  type: 'choice' as const,
  instructions: 'Pick by what the message is about, not by who sent it.',
  criteria: {
    Security: 'Sign-in alerts, verification codes, and account safety',
    Finance: 'Bills, invoices, payments, refunds, payroll, and bank activity',
    Delivery: 'Shipping, pickup, and logistics',
    Travel: 'Flights, hotels, and bookings',
    Health: 'Appointments and medical results',
    Legal: 'Contracts, official and government notices',
    Work: 'Code review, builds, tickets, and colleagues',
    Personal: 'A real person writing to you outside work',
    Social: 'Platform and community notifications',
    Marketing: 'Ads, promotions, and newsletters',
    System: 'Automated reports, status, and platform updates',
    Other: 'None of the above fits',
  },
};

const actionQuestion = {
  type: 'noul' as const,
  instructions: 'Does this message ask the user to do something?',
  criteria: {
    true: 'The user must reply, confirm, pay, renew, pick up, attend, or otherwise act',
    false: 'Purely informational; no action is needed',
  },
};

const QUESTIONS = {
  importance: importanceQuestion,
  category: categoryQuestion,
  action_required: actionQuestion,
};

export interface DeciderDecision {
  importance: Importance;
  /** 0-100, derived from the importance level scaled by the answer's confidence. */
  score: number;
  category: Category;
  actionRequired: boolean;
  /** Confidence of the importance answer, 0-1. */
  confidence: number;
}

/** Two-stage triage runs only when the decision stage is fully configured. */
export function deciderConfigured(): boolean {
  return Boolean(process.env.DECIDER_API_TOKEN?.trim() && deciderEndpoint());
}

/**
 * Extra request headers that route a call through a Cloudflare AI Gateway, so
 * its analytics and logs show every decision and summary. Set AI_GATEWAY_ID to
 * the gateway name (e.g. "default") to enable; leave it unset when the triage
 * endpoints are not Cloudflare, since the header is meaningless elsewhere.
 */
export function aiGatewayHeaders(): Record<string, string> {
  const gateway = process.env.AI_GATEWAY_ID?.trim();
  return gateway ? { 'cf-aig-gateway-id': gateway } : {};
}

function deciderEndpoint(): string {
  const base = process.env.DECIDER_BASE_URL?.trim().replace(/\/+$/, '');
  if (!base) return '';
  return `${base}/${(process.env.DECIDER_MODEL ?? 'clef-flash').trim()}`;
}

interface ClefChoice {
  type?: string;
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}
interface ClefNoul {
  type?: string;
  noul?: number;
}
interface ClefResponse {
  result?: { answers?: Record<string, ClefChoice & ClefNoul>; usage?: { input_tokens?: number } };
  success?: boolean;
  errors?: Array<{ message?: string }>;
}

/**
 * Map one Clef answer set onto a decision. Returns null when the answers are
 * missing or malformed; callers then fall back to the single-stage pipeline.
 */
export function mapDeciderAnswers(answers: unknown): DeciderDecision | null {
  if (typeof answers !== 'object' || answers === null) return null;
  const record = answers as Record<string, unknown>;
  const importanceAnswer = record['importance'] as ClefChoice | undefined;
  const categoryAnswer = record['category'] as ClefChoice | undefined;
  const actionAnswer = record['action_required'] as ClefNoul | undefined;
  if (!importanceAnswer || typeof importanceAnswer.choice !== 'string') return null;

  const importance = importanceAnswer.choice as Importance;
  if (!['info', 'warning', 'critical'].includes(importance)) return null;
  const confidence = clamp01(
    importanceAnswer.confidence ??
      importanceAnswer.probabilities?.[importanceAnswer.choice] ??
      0.75,
  );

  return {
    importance,
    score: scoreFor(importance, confidence),
    category: canonicalCategory(categoryAnswer?.choice),
    actionRequired: (actionAnswer?.noul ?? 0) >= 0.5,
    confidence,
  };
}

/** Keep each level's scores inside its band; higher confidence moves to the band's edge. */
function scoreFor(importance: Importance, confidence: number): number {
  if (importance === 'critical') return 80 + Math.round(20 * confidence);
  if (importance === 'warning') return 50 + Math.round(29 * confidence);
  // A confidently-unimportant message scores near zero; an uncertain one stays mid-band.
  return Math.round(49 * (1 - confidence));
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.75;
}

/** Build the per-message state, mirroring the payload the summary stage sends. */
function decisionState(message: MailMessage, rules: Rules): Record<string, unknown> {
  const bodyChars = Number(process.env.LLM_BODY_CHARS ?? 1200);
  const redact = (process.env.LLM_REDACT_PII ?? 'true').toLowerCase() !== 'false';
  const safe = (value: string): string => (redact ? redactForLlm(value) : value);
  const sensitiveVerification = containsSensitiveContent(message);
  return {
    user_context: safe(rules.context) || '(no additional user context)',
    subject: sensitiveVerification ? '验证码邮件（内容已隐藏）' : safe(message.subject) || '(no subject)',
    from: safe(`${message.fromName} <${message.fromAddr}>`).trim(),
    in_spam: message.inSpam,
    is_bulk: message.listUnsubscribe,
    to_account: safe(message.account),
    body: sensitiveVerification ? '验证码邮件（内容已隐藏）' : safe(message.body.slice(0, bodyChars)),
  };
}

/**
 * Ask the decision model about every message in the batch, in parallel. All or
 * nothing: one failed request loses the whole batch to the single-stage path,
 * which mirrors how the existing LLM batch degrades.
 */
export async function decideMessages(
  messages: MailMessage[],
  rules: Rules,
): Promise<DeciderDecision[] | null> {
  if (messages.length === 0) return [];
  const endpoint = deciderEndpoint();
  const model = (process.env.DECIDER_MODEL ?? 'clef-flash').trim();
  const timeout = Number(process.env.DECIDER_TIMEOUT_SECONDS ?? 15) * 1000;

  try {
    const responses = await Promise.all(
      messages.map(async (message) => {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.DECIDER_API_TOKEN ?? ''}`,
            'Content-Type': 'application/json',
            ...aiGatewayHeaders(),
          },
          body: JSON.stringify({ model, state: decisionState(message, rules), questions: QUESTIONS }),
          signal: AbortSignal.timeout(timeout),
        });
        if (!response.ok) {
          throw new Error(`decider HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
        }
        return (await response.json()) as ClefResponse;
      }),
    );

    const decisions = responses.map((response, index) => {
      if (!response.success || !response.result?.answers) {
        throw new Error(`decider rejected message ${index}: ${JSON.stringify(response.errors ?? [])}`);
      }
      const decision = mapDeciderAnswers(response.result.answers);
      if (!decision) throw new Error(`decider returned unusable answers for message ${index}`);
      return decision;
    });

    const inputTokens = responses.reduce((sum, r) => sum + (r.result?.usage?.input_tokens ?? 0), 0);
    log.info(
      `Decider usage | ${messages.length} messages | ${inputTokens} input tokens | ` +
        decisions.map((d) => `${d.importance}(conf ${d.confidence.toFixed(2)})`).join(', '),
    );
    return decisions;
  } catch (error) {
    log.warn(`Decider stage failed; falling back to single-stage triage: ${error}`);
    return null;
  }
}
