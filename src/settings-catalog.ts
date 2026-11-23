/**
 * Every setting the settings page offers, in one place: its type, its limits,
 * its default (the value the code uses when it is not set) and its words in
 * both languages.
 *
 * The keys are the environment names the rest of mailsift reads, so the stored
 * values reach it unchanged (see services/settings-store.ts). A key that is not
 * listed here cannot be saved.
 */
import type { Language } from './web-strings.js';

export type FieldType = 'text' | 'secret' | 'number' | 'boolean' | 'textarea' | 'select' | 'url' | 'list';

export type SectionId = 'ai' | 'notifications' | 'triage' | 'schedule' | 'privacy' | 'sending' | 'oauth' | 'access' | 'advanced';

type Words = { en: string; zh: string };

export interface SettingField {
  key: string;
  section: SectionId;
  type: FieldType;
  label: Words;
  help?: Words;
  /** What the code does when the setting is absent; shown as the placeholder. */
  defaultValue?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  options?: Array<{ value: string; label: Words }>;
  /** Shown under "More options" rather than at first sight. */
  advanced?: boolean;
  /** Free text with an upper bound on length. */
  maxLength?: number;
  /** A secret that is a URL: validated as one, but never shown back. */
  url?: boolean;
}

const w = (en: string, zh: string): Words => ({ en, zh });

const IMPORTANCE = [
  { value: 'critical', label: w('Critical only', '仅紧急') },
  { value: 'warning', label: w('Warning and above', '提醒及以上') },
  { value: 'info', label: w('Everything', '全部') },
];
const OFF_ON = [
  { value: 'auto', label: w('Automatic (HTTPS only)', '自动（仅 HTTPS）') },
  { value: 'true', label: w('Always', '总是') },
  { value: 'false', label: w('Never', '从不') },
];
const LLM_PROVIDERS = ['deepseek', 'openai', 'openrouter', 'dashscope', 'moonshot', 'glm', 'zhipu', 'minimax', 'siliconflow', 'xai'];
const LLM_PROVIDER_NAMES: Record<string, string> = {
  deepseek: 'DeepSeek', openai: 'OpenAI', openrouter: 'OpenRouter', dashscope: 'DashScope (Qwen)', moonshot: 'Moonshot (Kimi)',
  glm: 'GLM (bigmodel.cn)', zhipu: 'Zhipu', minimax: 'MiniMax', siliconflow: 'SiliconFlow', xai: 'xAI',
};

export const SETTING_FIELDS: SettingField[] = [
  // ---- AI model ----
  {
    key: 'LLM_PROVIDER', section: 'ai', type: 'select', defaultValue: 'deepseek',
    label: w('Provider', '模型服务商'),
    help: w('Choose a preset, or "Custom endpoint" and enter its address below.', '选择预设，或选“自定义接口”并在下方填写地址。'),
    options: [
      ...LLM_PROVIDERS.map((value) => ({ value, label: w(LLM_PROVIDER_NAMES[value] ?? value, LLM_PROVIDER_NAMES[value] ?? value) })),
      { value: 'custom', label: w('Custom endpoint (OpenAI-compatible)', '自定义接口（OpenAI 兼容）') },
    ],
  },
  {
    key: 'LLM_BASE_URL', section: 'ai', type: 'url', placeholder: 'https://api.example.com/v1',
    label: w('Endpoint address', '接口地址'),
    help: w('Only for a custom endpoint, or to override a preset. mailsift posts to its /chat/completions.', '仅自定义接口或覆盖预设时填写；mailsift 会请求其 /chat/completions。'),
  },
  {
    key: 'LLM_MODEL', section: 'ai', type: 'text', defaultValue: 'deepseek-flash', maxLength: 200,
    label: w('Model', '模型'),
  },
  {
    key: 'LLM_API_KEY', section: 'ai', type: 'secret',
    label: w('API key', 'API Key'),
    help: w('Without a key, mail is judged by local rules and keywords only.', '不填写时只用本地规则和关键词判断。'),
  },
  {
    key: 'LLM_OUTPUT_LANGUAGE', section: 'ai', type: 'select', defaultValue: 'en',
    label: w('Language of summaries', '摘要语言'),
    options: [
      { value: 'en', label: w('English', 'English') },
      { value: 'zh-CN', label: w('Simplified Chinese', '简体中文') },
      { value: 'zh-TW', label: w('Traditional Chinese', '繁體中文') },
      { value: 'auto', label: w('Same as each message', '跟随邮件语言') },
    ],
  },
  { key: 'LLM_BATCH_SIZE', section: 'ai', type: 'number', defaultValue: '10', min: 1, max: 50, advanced: true, label: w('Messages per request', '每次请求的邮件数') },
  { key: 'LLM_BODY_CHARS', section: 'ai', type: 'number', defaultValue: '1200', min: 200, max: 20000, advanced: true, label: w('Body characters sent per message', '每封邮件发送的正文字符数') },
  { key: 'LLM_THREAD_CONTEXT_MESSAGES', section: 'ai', type: 'number', defaultValue: '3', min: 0, max: 5, advanced: true, label: w('Earlier messages of the thread included', '附带的同会话历史邮件数') },
  { key: 'LLM_TIMEOUT_SECONDS', section: 'ai', type: 'number', defaultValue: '60', min: 5, max: 600, advanced: true, label: w('Request timeout (seconds)', '请求超时（秒）') },
  {
    key: 'LLM_JSON_MODE', section: 'ai', type: 'boolean', defaultValue: 'true', advanced: true,
    label: w('Ask for JSON output', '要求 JSON 输出'),
    help: w('Turn off only if the provider rejects response_format.', '仅在服务商不支持 response_format 时关闭。'),
  },
  { key: 'LLM_ALERT_AFTER_FAILURES', section: 'ai', type: 'number', defaultValue: '2', min: 1, max: 100, advanced: true, label: w('Alert after this many failed requests in a row', '连续失败多少次后告警') },
  {
    key: 'DECIDER_API_TOKEN', section: 'ai', type: 'secret', advanced: true,
    label: w('Two-stage decision model token', '两阶段判断模型 Token'),
    help: w('Optional. With a token, a calibrated decision model (Cloudflare Clef) decides importance and the model above only writes the summary.', '可选。填写后由校准过的判断模型（Cloudflare Clef）决定重要度，上面的模型只负责写摘要。'),
  },
  { key: 'DECIDER_BASE_URL', section: 'ai', type: 'url', advanced: true, placeholder: 'https://api.cloudflare.com/client/v4/accounts/<id>/ai/run/@cf/cloudflare', label: w('Decision model endpoint', '判断模型接口地址') },
  { key: 'DECIDER_MODEL', section: 'ai', type: 'text', defaultValue: 'clef-flash', advanced: true, maxLength: 100, label: w('Decision model', '判断模型') },
  { key: 'DECIDER_TIMEOUT_SECONDS', section: 'ai', type: 'number', defaultValue: '15', min: 1, max: 120, advanced: true, label: w('Decision timeout (seconds)', '判断超时（秒）') },
  { key: 'AI_GATEWAY_ID', section: 'ai', type: 'text', advanced: true, maxLength: 200, label: w('Cloudflare AI Gateway ID', 'Cloudflare AI Gateway ID'), help: w('Only for endpoints on Cloudflare.', '仅用于 Cloudflare 上的接口。') },

  // ---- Notifications ----
  {
    key: 'FEISHU_WEBHOOK_URL', section: 'notifications', type: 'secret', url: true,
    label: w('Feishu / Lark bot webhook', '飞书 / Lark 机器人 Webhook'),
    help: w('A custom bot in a group: Group settings → Bots → Add bot → Custom bot.', '在群设置 → 群机器人 → 添加自定义机器人中获取。'),
  },
  { key: 'FEISHU_WEBHOOK_SECRET', section: 'notifications', type: 'secret', label: w('Feishu signing secret', '飞书签名密钥'), help: w('Only if the bot has signature verification on.', '仅在机器人开启签名校验时填写。') },
  {
    key: 'FEISHU_MIN_IMPORTANCE', section: 'notifications', type: 'select',
    label: w('Feishu receives', '飞书接收'),
    options: [{ value: '', label: w('Same as real-time pushes', '与实时推送相同') }, ...IMPORTANCE],
  },
  {
    key: 'WEBHOOK_URL', section: 'notifications', type: 'secret', url: true,
    label: w('Webhook address', 'Webhook 地址'),
    help: w('Each notification is POSTed here as JSON (signal-event v1).', '每条通知以 JSON（signal-event v1）POST 到该地址。'),
  },
  { key: 'WEBHOOK_TOKEN', section: 'notifications', type: 'secret', label: w('Webhook token', 'Webhook Token'), help: w('Sent as the token header.', '作为 token 请求头发送。') },
  {
    key: 'WEB_PUSH_ENABLED', section: 'notifications', type: 'boolean', defaultValue: 'true',
    label: w('Browser notifications', '浏览器通知'),
    help: w('Each browser turns them on with the bell in the mail view. Needs HTTPS, or the page opened at localhost.', '在邮件页面点铃铛按浏览器开启；需要 HTTPS，或通过 localhost 打开页面。'),
  },
  {
    key: 'HEARTBEAT_PING_URL', section: 'notifications', type: 'secret', url: true,
    label: w('Heartbeat URL', '心跳地址'),
    help: w('Optional. Requested after every poll, so an outside monitor (e.g. healthchecks.io) notices when mailsift stops.', '可选。每次轮询后请求一次，让外部监控（如 healthchecks.io）发现服务停止。'),
  },
  { key: 'WEB_PUSH_SUBJECT', section: 'notifications', type: 'text', advanced: true, placeholder: 'mailto:you@example.com', maxLength: 300, label: w('Contact for push services', '推送服务联系地址') },
  { key: 'WEB_PUSH_ALLOWED_HOSTS', section: 'notifications', type: 'list', advanced: true, label: w('Additional push service hosts', '额外的推送服务域名') },
  { key: 'SINK_RETRY_ATTEMPTS', section: 'notifications', type: 'number', defaultValue: '3', min: 1, max: 10, advanced: true, label: w('Delivery attempts', '投递尝试次数') },
  {
    key: 'DRY_RUN', section: 'notifications', type: 'boolean', defaultValue: 'false', advanced: true,
    label: w('Dry run', '演练模式'),
    help: w('Log notifications instead of sending them, and send no mail.', '只记录通知、不实际发送，也不发信。'),
  },

  // ---- Triage ----
  {
    key: 'MAIL_CONTEXT', section: 'triage', type: 'textarea', maxLength: 4000,
    label: w('About you', '关于你'),
    help: w('Who you are and what matters to you; the model reads this with every batch. Leave out secrets.', '你是谁、在意什么，模型每次判断都会读到。不要写入机密。'),
    placeholder: 'Freelance developer. Client invoices and production alerts matter; newsletters do not.',
  },
  { key: 'MAIL_ALWAYS_IMPORTANT', section: 'triage', type: 'list', label: w('Always important senders', '总是重要的发件人'), help: w('Addresses or @domain.com, separated by commas.', '地址或 @domain.com，用逗号分隔。') },
  { key: 'MAIL_NEVER_IMPORTANT', section: 'triage', type: 'list', label: w('Never important senders', '从不重要的发件人'), help: w('Addresses or @domain.com, separated by commas.', '地址或 @domain.com，用逗号分隔。') },
  {
    key: 'PUSH_MIN_IMPORTANCE', section: 'triage', type: 'select', defaultValue: 'warning', options: IMPORTANCE,
    label: w('Push in real time', '实时推送'),
    help: w('The rest waits for the daily digest.', '其余邮件进入每日摘要。'),
  },
  {
    key: 'MAIL_KEYWORDS', section: 'triage', type: 'list', advanced: true,
    label: w('Fallback keywords', '兜底关键词'),
    help: w('Used when no model is configured or it fails.', '未配置模型或模型失败时使用。'),
    placeholder: 'verification code, invoice, past due',
  },
  { key: 'SUPPRESS_SELF_FORWARDS', section: 'triage', type: 'boolean', defaultValue: 'true', advanced: true, label: w('Ignore copies forwarded between your own mailboxes', '忽略自己邮箱之间转发的副本') },
  {
    key: 'SPAM_RANK_BONUS', section: 'triage', type: 'number', defaultValue: '0', min: 0, max: 2, advanced: true,
    label: w('Importance boost for mail in spam', '垃圾箱邮件重要度加成'),
    help: w('0 judges spam like any other mail.', '0 表示与普通邮件同样判断。'),
  },

  // ---- Polling and digest ----
  {
    key: 'POLL_INTERVAL_SECONDS', section: 'schedule', type: 'number', defaultValue: '300', min: 30, max: 86400,
    label: w('Check every (seconds)', '检查间隔（秒）'),
    help: w('With real-time wake-ups on, 900–1800 is enough.', '开启实时唤醒后，900–1800 即可。'),
  },
  {
    key: 'IMAP_IDLE_ENABLED', section: 'schedule', type: 'boolean', defaultValue: 'false',
    label: w('Real-time wake-ups (IMAP IDLE)', '实时唤醒（IMAP IDLE）'),
    help: w('Keep a connection open per folder below and react within seconds.', '为下列文件夹保持连接，几秒内响应新邮件。'),
  },
  { key: 'IMAP_IDLE_FOLDERS', section: 'schedule', type: 'list', defaultValue: 'INBOX', label: w('Folders to listen on', '监听的文件夹'), help: w('INBOX, spam, or folder names; "all" is not accepted.', 'INBOX、spam 或文件夹名；不接受 all。') },
  { key: 'DIGEST_ENABLED', section: 'schedule', type: 'boolean', defaultValue: 'true', label: w('Daily digest', '每日摘要') },
  { key: 'DIGEST_HOUR', section: 'schedule', type: 'number', defaultValue: '9', min: 0, max: 23, label: w('Digest hour (0–23)', '摘要发送时间（0–23 点）') },
  { key: 'DIGEST_MIN_IMPORTANCE', section: 'schedule', type: 'select', defaultValue: 'info', options: IMPORTANCE, label: w('The digest includes', '摘要包含') },
  { key: 'TZ', section: 'schedule', type: 'text', maxLength: 64, label: w('Time zone', '时区'), help: w('An IANA name such as Asia/Shanghai or Europe/Berlin.', 'IANA 名称，如 Asia/Shanghai、Europe/Berlin。') },
  { key: 'IMAP_IDLE_CHECK_SECONDS', section: 'schedule', type: 'number', min: 0, max: 3600, advanced: true, label: w('Listener safety check (seconds)', '监听连接的兜底检查（秒）'), help: w('Empty: 60 for providers known to miss notifications, 300 otherwise. 0 turns it off.', '留空：已知会漏通知的服务商 60 秒，其余 300 秒；0 关闭。') },
  { key: 'INITIAL_LOOKBACK_DAYS', section: 'schedule', type: 'number', defaultValue: '3', min: 0, max: 365, advanced: true, label: w('Days looked back for a new mailbox', '新邮箱首次回溯天数') },
  { key: 'MAX_MESSAGES_PER_LOOKBACK', section: 'schedule', type: 'number', defaultValue: '500', min: 1, max: 100000, advanced: true, label: w('Backfill batch size', '回溯批次上限') },
  { key: 'MAX_MESSAGES_PER_POLL', section: 'schedule', type: 'number', defaultValue: '200', min: 1, max: 100000, advanced: true, label: w('Messages per folder per check', '每个文件夹每次最多处理') },
  { key: 'MAX_MESSAGES_PER_POLL_TOTAL', section: 'schedule', type: 'number', defaultValue: '500', min: 1, max: 100000, advanced: true, label: w('Messages per check in total', '每次检查总共最多处理') },
  { key: 'MAX_CONCURRENT_ACCOUNTS', section: 'schedule', type: 'number', defaultValue: '5', min: 1, max: 50, advanced: true, label: w('Mailboxes checked at once', '同时检查的邮箱数') },
  { key: 'ACCOUNT_ALERT_AFTER_FAILURES', section: 'schedule', type: 'number', defaultValue: '2', min: 1, max: 100, advanced: true, label: w('Alert after failed checks in a row', '连续失败多少次后告警') },
  { key: 'ACCOUNT_ALERT_COOLDOWN_SECONDS', section: 'schedule', type: 'number', defaultValue: '21600', min: 60, max: 604800, advanced: true, label: w('Repeat a mailbox alert after (seconds)', '同一故障重复告警间隔（秒）') },

  // ---- Privacy and retention ----
  { key: 'LLM_SKIP_SENSITIVE', section: 'privacy', type: 'boolean', defaultValue: 'true', label: w('Judge codes and sign-in links locally', '验证码和登录链接只在本地判断'), help: w('Such mail never reaches the model.', '这类邮件不会发给模型。') },
  { key: 'SENSITIVE_SECRET_MAIL', section: 'privacy', type: 'boolean', defaultValue: 'true', label: w('Treat mail carrying keys or tokens as sensitive', '含密钥或令牌的邮件视为敏感') },
  { key: 'LLM_REDACT_PII', section: 'privacy', type: 'boolean', defaultValue: 'true', label: w('Redact identifiers before the model sees them', '发给模型前遮盖身份信息'), help: w('Addresses, phone, card and ID numbers.', '邮箱、电话、卡号、证件号等。') },
  { key: 'LLM_SCAN_OUTPUT', section: 'privacy', type: 'boolean', defaultValue: 'false', advanced: true, label: w('Warn when a summary repeats an identifier', '摘要中出现身份信息时记录警告') },
  { key: 'STATE_RETENTION_DAYS', section: 'privacy', type: 'number', defaultValue: '90', min: 7, max: 3650, label: w('Keep triage records for (days)', '分诊记录保留天数'), help: w('Only mailsift\'s own records; mail on the server is never deleted by this.', '只影响 mailsift 自己的记录，不会删除邮箱里的邮件。') },
  { key: 'DONE_LIST_DAYS', section: 'privacy', type: 'number', defaultValue: '7', min: 1, max: 365, label: w('Show handled mail from the last (days)', '“已处理”列表显示天数') },
  { key: 'SENT_MAIL_ENABLED', section: 'privacy', type: 'boolean', defaultValue: 'true', label: w('Read Sent folders into conversations', '读取已发送邮件补全会话'), help: w('Stored locally for conversations only; never judged or sent to the model.', '仅在本地用于显示会话，不判断、不发给模型。') },
  { key: 'SENT_LOOKBACK_DAYS', section: 'privacy', type: 'number', defaultValue: '30', min: 1, max: 365, advanced: true, label: w('First look back into Sent (days)', '已发送邮件首次回溯天数') },

  // ---- Web mail ----
  { key: 'SMTP_ENABLED', section: 'sending', type: 'boolean', defaultValue: 'true', label: w('Allow sending from the web view and MCP', '允许从网页和 MCP 发信') },
  { key: 'SMTP_ATTACHMENT_MAX_BYTES', section: 'sending', type: 'number', defaultValue: '20971520', min: 1, max: 104857600, advanced: true, label: w('Attachment limit per letter (bytes)', '每封邮件附件上限（字节）') },
  { key: 'WEB_ASSISTANT_DAILY_LIMIT', section: 'sending', type: 'number', defaultValue: '300', min: 0, max: 100000, label: w('Assistant questions per day', '助手每日提问上限') },

  // ---- OAuth apps ----
  {
    key: 'GMAIL_CLIENT_ID', section: 'oauth', type: 'text', maxLength: 300,
    label: w('Google client ID', 'Google Client ID'),
    help: w('Google Cloud Console → APIs & Services → Credentials → OAuth client ID, type "Desktop app".', 'Google Cloud Console → API 和服务 → 凭据 → OAuth 客户端 ID，类型选“桌面应用”。'),
  },
  { key: 'GMAIL_CLIENT_SECRET', section: 'oauth', type: 'secret', label: w('Google client secret', 'Google Client Secret'), help: w('Desktop clients come with one; enter it.', '桌面应用客户端会附带，请填写。') },
  {
    key: 'OUTLOOK_CLIENT_ID', section: 'oauth', type: 'text', maxLength: 300,
    label: w('Microsoft application (client) ID', 'Microsoft 应用（客户端）ID'),
    help: w('Microsoft Entra → App registrations. Platform "Mobile and desktop applications" with redirect URI http://localhost, and public client flows allowed.', 'Microsoft Entra → 应用注册。平台选“移动和桌面应用程序”，重定向 URI 填 http://localhost，并允许公共客户端流。'),
  },
  { key: 'OUTLOOK_CLIENT_SECRET', section: 'oauth', type: 'secret', label: w('Microsoft client secret', 'Microsoft Client Secret'), help: w('Leave empty for a public client.', '公共客户端留空。') },
  { key: 'OUTLOOK_TENANT', section: 'oauth', type: 'text', defaultValue: 'common', maxLength: 100, label: w('Microsoft tenant', 'Microsoft 租户'), help: w('common for personal accounts, or your organisation\'s tenant ID.', '个人账户填 common，组织账户可填租户 ID。') },

  // ---- Access ----
  { key: 'MCP_RATE_LIMIT_PER_MINUTE', section: 'access', type: 'number', defaultValue: '120', min: 1, max: 10000, advanced: true, label: w('MCP requests per client per minute', '每个 MCP 客户端每分钟请求上限') },
  {
    key: 'TRUSTED_PROXY', section: 'access', type: 'boolean', defaultValue: 'false', advanced: true,
    label: w('Trust the proxy\'s client address', '信任反向代理传来的客户端地址'),
    help: w('Turn on when mailsift is reached only through your reverse proxy, so rate limits apply per visitor.', '仅在 mailsift 只能经由你的反向代理访问时开启，使限流按访客计算。'),
  },
  { key: 'WEB_COOKIE_SECURE', section: 'access', type: 'select', defaultValue: 'auto', options: OFF_ON, advanced: true, label: w('Secure cookies', 'Secure Cookie') },

  // ---- Advanced ----
  { key: 'LOG_LEVEL', section: 'advanced', type: 'select', defaultValue: 'info', options: ['error', 'warn', 'info', 'debug'].map((v) => ({ value: v, label: w(v, v) })), label: w('Log level', '日志级别') },
  { key: 'MAX_MESSAGE_SOURCE_BYTES', section: 'advanced', type: 'number', defaultValue: '5242880', min: 65536, max: 104857600, label: w('Largest message read whole (bytes)', '完整读取的单封邮件上限（字节）') },
  { key: 'MCP_LIVE_BODY_CHARS', section: 'advanced', type: 'number', defaultValue: '20000', min: 500, max: 1000000, label: w('MCP: body characters returned', 'MCP：返回的正文字符上限') },
  { key: 'MCP_LIVE_SOURCE_BYTES', section: 'advanced', type: 'number', defaultValue: '5242880', min: 65536, max: 104857600, label: w('MCP: largest message fetched (bytes)', 'MCP：实时读取的邮件上限（字节）') },
  { key: 'MCP_LIVE_LOOKBACK_DAYS', section: 'advanced', type: 'number', defaultValue: '90', min: 1, max: 3650, label: w('MCP: live search reaches back (days)', 'MCP：实时搜索回溯天数') },
  { key: 'MCP_LIVE_SEARCH_MAX_MESSAGES', section: 'advanced', type: 'number', defaultValue: '500', min: 1, max: 100000, label: w('MCP: messages a live search may scan', 'MCP：实时搜索最多扫描') },
  { key: 'MCP_ATTACHMENT_MAX_BYTES', section: 'advanced', type: 'number', defaultValue: '10485760', min: 1, max: 104857600, label: w('MCP: largest attachment returned (bytes)', 'MCP：附件读取上限（字节）') },
  { key: 'MCP_ATTACHMENT_SCAN_BYTES', section: 'advanced', type: 'number', defaultValue: '1048576', min: 1, max: 4194304, label: w('Attachment check reads (bytes)', '附件检查读取字节数') },
  { key: 'MCP_SAFETY_BODY_BYTES', section: 'advanced', type: 'number', defaultValue: '262144', min: 1, max: 1048576, label: w('Link check reads (bytes)', '链接检查读取字节数') },
  { key: 'OTEL_EXPORTER_OTLP_ENDPOINT', section: 'advanced', type: 'url', label: w('OpenTelemetry collector', 'OpenTelemetry Collector 地址'), help: w('Metrics are exported over OTLP when this is set.', '设置后通过 OTLP 导出指标。') },
  { key: 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', section: 'advanced', type: 'url', label: w('OTLP metrics endpoint', 'OTLP 指标专用地址') },
  { key: 'OTEL_METRIC_EXPORT_INTERVAL_MS', section: 'advanced', type: 'number', defaultValue: '60000', min: 1000, max: 3600000, label: w('Metric export interval (ms)', '指标导出间隔（毫秒）') },
];

export const SECTION_TITLES: Record<SectionId, Words> = {
  ai: w('AI model', 'AI 模型'),
  notifications: w('Notifications', '通知'),
  triage: w('Triage rules', '分诊规则'),
  schedule: w('Checking and digest', '检查与摘要'),
  privacy: w('Privacy and retention', '隐私与保留'),
  sending: w('Web mail', '网页邮件'),
  oauth: w('Gmail and Outlook sign-in', 'Gmail 与 Outlook 登录'),
  access: w('Access', '访问与凭证'),
  advanced: w('Advanced', '高级'),
};

export const FIELD_BY_KEY = new Map(SETTING_FIELDS.map((field) => [field.key, field]));

/** Settings whose values are never sent back to the page. */
export const SECRET_KEYS = new Set(SETTING_FIELDS.filter((field) => field.type === 'secret').map((field) => field.key));

/** The API credentials; managed with their own controls, never through the field list. */
export const ACCESS_TOKEN_KEYS = ['MCP_TOKEN', 'MCP_WRITE_TOKEN'] as const;

export function words(value: Words | undefined, lang: Language): string {
  if (!value) return '';
  return lang === 'zh-CN' ? value.zh : value.en;
}

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export type FieldProblem = { key: string; message: Words };

/**
 * Check one value against its field. Returns the normalized value to store,
 * or a problem worded for the page. An empty value means "use the default".
 */
export function checkField(field: SettingField, raw: string): { value: string } | { problem: Words } {
  const value = field.type === 'textarea' ? raw.replace(/\r\n/g, '\n').trim() : raw.trim();
  if (value === '') return { value: '' };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    return { problem: w('Contains control characters.', '包含控制字符。') };
  }
  const limit = field.maxLength ?? (field.type === 'textarea' || field.type === 'list' ? 4000 : 2000);
  if (value.length > limit) return { problem: w(`At most ${limit} characters.`, `最多 ${limit} 个字符。`) };
  switch (field.type) {
    case 'number': {
      if (!/^\d+$/.test(value)) return { problem: w('Enter a whole number.', '请输入整数。') };
      const n = Number(value);
      if ((field.min !== undefined && n < field.min) || (field.max !== undefined && n > field.max)) {
        return { problem: w(`Between ${field.min} and ${field.max}.`, `范围 ${field.min}–${field.max}。`) };
      }
      return { value: String(n) };
    }
    case 'boolean':
      return value === 'true' || value === 'false' ? { value } : { problem: w('Choose on or off.', '请选择开或关。') };
    case 'select':
      return field.options?.some((option) => option.value === value)
        ? { value }
        : { problem: w('Choose one of the options.', '请从选项中选择。') };
    case 'url':
      return validUrl(value) ? { value } : { problem: w('Enter a complete http(s):// address.', '请输入完整的 http(s):// 地址。') };
    case 'list':
      return { value: value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean).join(',') };
    case 'secret':
      if (field.url && !validUrl(value)) return { problem: w('Enter a complete http(s):// address.', '请输入完整的 http(s):// 地址。') };
      return { value };
    default:
      if (field.key === 'TZ' && !validTimeZone(value)) return { problem: w('Not a time zone this server knows.', '服务器不认识这个时区。') };
      if (field.key === 'WEB_PUSH_SUBJECT' && !/^(mailto:|https:\/\/)/.test(value)) {
        return { problem: w('Start with mailto: or https://.', '请以 mailto: 或 https:// 开头。') };
      }
      return { value };
  }
}

/** Checks that span fields, run on the would-be result of a save. */
export function crossFieldProblems(values: Record<string, string>): FieldProblem[] {
  const problems: FieldProblem[] = [];
  if (values['LLM_PROVIDER'] === 'custom' && !values['LLM_BASE_URL']) {
    problems.push({ key: 'LLM_BASE_URL', message: w('A custom endpoint needs its address.', '自定义接口需要填写地址。') });
  }
  if (values['DECIDER_API_TOKEN'] && !values['DECIDER_BASE_URL']) {
    problems.push({ key: 'DECIDER_BASE_URL', message: w('The decision model needs its endpoint.', '判断模型需要接口地址。') });
  }
  if ((values['IMAP_IDLE_FOLDERS'] ?? '').split(',').some((folder) => folder.trim().toLowerCase() === 'all')) {
    problems.push({ key: 'IMAP_IDLE_FOLDERS', message: w('List folders by name; "all" is not accepted here.', '请写出文件夹名；这里不接受 all。') });
  }
  if (values['FEISHU_WEBHOOK_SECRET'] && !values['FEISHU_WEBHOOK_URL']) {
    problems.push({ key: 'FEISHU_WEBHOOK_URL', message: w('The signing secret belongs to a webhook; add it.', '签名密钥需要配合 Webhook 地址。') });
  }
  return problems;
}
