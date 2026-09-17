import { afterEach, beforeEach } from 'vitest';

const MANAGED = [
  'MAIL_ALWAYS_IMPORTANT', 'MAIL_NEVER_IMPORTANT', 'MAIL_KEYWORDS', 'MAIL_CONTEXT',
  'STATE_DB_PATH', 'TOKEN_STORE_PATH', 'DRY_RUN', 'LOG_LEVEL',
  'FEISHU_WEBHOOK_URL', 'FEISHU_WEBHOOK_SECRET', 'FEISHU_MIN_IMPORTANCE',
  'WEBHOOKWISE_URL', 'WEBHOOKWISE_TOKEN', 'WEBHOOKWISE_SOURCE',
  'LLM_API_KEY', 'LLM_MODEL', 'LLM_BASE_URL', 'LLM_PROVIDER', 'LLM_JSON_MODE',
  'LLM_BATCH_SIZE', 'LLM_ALERT_AFTER_FAILURES',
  'PUSH_MIN_IMPORTANCE', 'DIGEST_MIN_IMPORTANCE', 'SPAM_RANK_BONUS',
  'DIGEST_ENABLED', 'DIGEST_HOUR', 'INITIAL_LOOKBACK_DAYS', 'MAX_MESSAGES_PER_LOOKBACK',
  'MAX_MESSAGES_PER_POLL',
  'MAX_MESSAGES_PER_POLL_TOTAL',
  'POLL_INTERVAL_SECONDS', 'STATE_RETENTION_DAYS',
  'ACCOUNT_ALERT_AFTER_FAILURES', 'ACCOUNT_ALERT_COOLDOWN_SECONDS',
];

/** Start every test with a clean environment to avoid cross-test contamination. */
function clean(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('MAIL_ACCOUNT_') || MANAGED.includes(key)) delete process.env[key];
  }
  process.env.LOG_LEVEL = 'error';
}

beforeEach(clean);
afterEach(clean);
