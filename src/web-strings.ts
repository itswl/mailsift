/**
 * What the browser view says, in each language it speaks.
 *
 * Every word a reader sees in the page chrome lives here once per language,
 * so a page is rendered from one table and a third language would be one more
 * column. Message content is never translated: subjects, summaries and reasons
 * are shown as stored, in the language the model was told to write
 * (LLM_OUTPUT_LANGUAGE). Categories, levels and the deciding source are a
 * fixed vocabulary, so those are worded here while the API keeps the English
 * values that the filters and MCP callers search on.
 */

export const LANGUAGES = ['en', 'zh-CN'] as const;
export type Language = (typeof LANGUAGES)[number];

export function isLanguage(value: string): value is Language {
  return (LANGUAGES as readonly string[]).includes(value);
}

const en = {
  'login.title': 'Sign in',
  'login.intro': 'Enter the access token for this instance. Your browser can remember it.',
  'login.account': 'Account',
  'login.token': 'token',
  'login.open': 'Open',
  'login.tooMany': 'Too many attempts. Wait a minute and try again.',
  'login.tooLarge': 'That request was too large.',
  'login.rejected': 'That token was not accepted.',

  // The face names the language the button switches to, not the current one.
  'lang.face': '中文',
  'lang.label': 'Switch to Chinese',
  'theme.title': 'Colour theme',
  'theme.label': 'Colour theme: {name}',
  'theme.auto': 'Follow the system',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'totals': '{total} messages · {pushed} notified · {spam} from spam',

  'window.24h': '24h',
  'window.3d': '3d',
  'window.7d': '7d',
  'window.30d': '30d',
  'filter.anyLevel': 'any level',
  'filter.anyCategory': 'any category',
  'filter.allMailboxes': 'all mailboxes',
  'search': 'search subject, sender, summary',
  'spam': 'spam',
  'notified': 'notified',

  'empty': 'Nothing matches these filters.',
  'unknownSender': 'unknown',
  'noSubject': '(no subject)',
  'digest.title': 'Waiting for the next digest',

  'detail.from': 'From',
  'detail.mailbox': 'Mailbox',
  'detail.judged': 'Judged',
  'detail.judgedAs': '{level} by {by}',
  'detail.why': 'Why',
  'detail.deadline': 'Deadline',
  'detail.load': 'Load full message',
  'detail.loading': 'Reading the mailbox…',
  'detail.noBody': '(this message has no text body)',
  'detail.failed': 'failed',
  // Worded from the code the API sends with a live-read failure.
  'error.unconfigured': 'This mailbox is no longer configured.',
  'error.timeout': 'The mailbox did not return this message in time.',
  'error.readFailed': 'Mailbox read failed: {detail}',

  'level.critical': 'critical',
  'level.warning': 'warning',
  'level.info': 'info',

  'by.rule': 'rule',
  'by.llm': 'llm',
  'by.fallback': 'fallback',
  'by.health': 'health',
  'by.digest': 'digest',

  // Composed in the browser; in English the result must match links.ts exactly.
  'link.openIn': 'Open in {name}',
  'link.open': 'Open {name}',
  'provider.gmail': 'Gmail',
  'provider.gmail_pw': 'Gmail',
  'provider.outlook': 'Outlook Mail',
  'provider.qq': 'QQ Mail',
  'provider.qq_biz': 'Tencent Exmail',
  'provider.163': '163 Mail',
  'provider.126': '126 Mail',
  'provider.icloud': 'iCloud Mail',

  'category.Security': 'Security',
  'category.Finance': 'Finance',
  'category.Delivery': 'Delivery',
  'category.Travel': 'Travel',
  'category.Health': 'Health',
  'category.Legal': 'Legal',
  'category.Work': 'Work',
  'category.Personal': 'Personal',
  'category.Social': 'Social',
  'category.Marketing': 'Marketing',
  'category.System': 'System',
  'category.Other': 'Other',
  'category.Always important': 'Always important',
  'category.Never important': 'Never important',
  'category.Feedback rule': 'Feedback rule',
  'category.Forwarded copy': 'Forwarded copy',
  'category.Service failure': 'Service failure',
};

/** Every key the English table has; the other languages must carry the same ones. */
export type StringKey = keyof typeof en;

const zhCN: Record<StringKey, string> = {
  'login.title': '登录',
  'login.intro': '输入这个实例的访问令牌，浏览器可以替你记住。',
  'login.account': '账号',
  'login.token': '令牌',
  'login.open': '进入',
  'login.tooMany': '尝试次数过多，请等一分钟再试。',
  'login.tooLarge': '请求过大。',
  'login.rejected': '令牌不正确。',

  'lang.face': 'EN',
  'lang.label': '切换为英文',
  'theme.title': '配色主题',
  'theme.label': '配色主题：{name}',
  'theme.auto': '跟随系统',
  'theme.light': '浅色',
  'theme.dark': '深色',
  'totals': '{total} 封邮件 · {pushed} 封已推送 · {spam} 封来自垃圾箱',

  'window.24h': '24 小时',
  'window.3d': '3 天',
  'window.7d': '7 天',
  'window.30d': '30 天',
  'filter.anyLevel': '所有级别',
  'filter.anyCategory': '所有分类',
  'filter.allMailboxes': '所有邮箱',
  'search': '搜索主题、发件人、摘要',
  'spam': '垃圾箱',
  'notified': '已推送',

  'empty': '没有符合这些筛选条件的邮件。',
  'unknownSender': '未知发件人',
  'noSubject': '（无主题）',
  'digest.title': '下一期摘要预览',

  'detail.from': '发件人',
  'detail.mailbox': '邮箱',
  'detail.judged': '判定',
  'detail.judgedAs': '{level} · {by}判定',
  'detail.why': '原因',
  'detail.deadline': '截止',
  'detail.load': '加载完整邮件',
  'detail.loading': '正在读取邮箱…',
  'detail.noBody': '（这封邮件没有文本正文）',
  'detail.failed': '读取失败',
  'error.unconfigured': '这个邮箱已不在配置中。',
  'error.timeout': '邮箱没有及时返回这封邮件。',
  'error.readFailed': '读取邮箱失败：{detail}',

  'level.critical': '紧急',
  'level.warning': '警告',
  'level.info': '一般',

  'by.rule': '规则',
  'by.llm': '模型',
  'by.fallback': '兜底规则',
  'by.health': '健康检查',
  'by.digest': '摘要',

  'link.openIn': '在 {name} 中打开',
  'link.open': '打开 {name}',
  'provider.gmail': 'Gmail',
  'provider.gmail_pw': 'Gmail',
  'provider.outlook': 'Outlook 邮箱',
  'provider.qq': 'QQ 邮箱',
  'provider.qq_biz': '腾讯企业邮箱',
  'provider.163': '163 邮箱',
  'provider.126': '126 邮箱',
  'provider.icloud': 'iCloud 邮箱',

  'category.Security': '安全',
  'category.Finance': '财务',
  'category.Delivery': '快递',
  'category.Travel': '出行',
  'category.Health': '健康',
  'category.Legal': '法律',
  'category.Work': '工作',
  'category.Personal': '个人',
  'category.Social': '社交',
  'category.Marketing': '营销',
  'category.System': '系统',
  'category.Other': '其他',
  'category.Always important': '始终重要',
  'category.Never important': '从不重要',
  'category.Feedback rule': '反馈规则',
  'category.Forwarded copy': '转发副本',
  'category.Service failure': '服务故障',
};

export const STRINGS: Record<Language, Record<StringKey, string>> = { en, 'zh-CN': zhCN };

export function t(lang: Language, key: StringKey): string {
  return STRINGS[lang][key];
}
