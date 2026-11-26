/**
 * The settings pages: claiming a new server, the first-run setup steps, and
 * Settings afterwards.
 *
 * Rendered as a shell with the field catalog and the words for the chosen
 * language embedded as JSON; the script fetches the current values from
 * /api/admin/state and draws the forms. It uses the mail view's stylesheet
 * and tokens, so the two read as one product in either theme.
 */
import { escapeHtml } from './html.js';
import { PROVIDER_PRESETS } from './config.js';
import { SECTION_TITLES, SETTING_FIELDS, words, type SectionId } from './settings-catalog.js';
import { ADMIN_PASSWORD_MIN } from './services/settings-store.js';
import { storeLanguageScript } from './web-client.js';
import { styles } from './web-styles.js';
import type { Language } from './web-strings.js';

type Dict = Record<string, string>;

const EN: Dict = {
  'claim.title': 'Set up mailsift',
  'claim.intro': 'Enter the one-time setup code from the service log, and choose the administrator password you will sign in with.',
  'claim.code': 'Setup code',
  'claim.password': 'Administrator password',
  'claim.confirm': 'Repeat the password',
  'claim.submit': 'Continue',
  'claim.mismatch': 'The two passwords differ.',
  'claim.short': 'Use at least {n} characters.',
  'claim.where': 'Where is the code?',
  'claim.whereBody': 'mailsift prints it when it starts. With Docker Compose: docker compose logs mailsift. Restarting prints a new one: docker compose restart mailsift.',
  'nav.settings': 'Settings',
  'nav.setup': 'Setup',
  'nav.back': 'Back to mail',
  'nav.signout': 'Sign out',
  'lang.face': '中文',
  'common.save': 'Save',
  'common.saving': 'Saving…',
  'common.saved': 'Saved',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.delete': 'Delete',
  'common.test': 'Test',
  'common.testing': 'Testing…',
  'common.more': 'More options',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.set': 'Set',
  'common.notSet': 'Not set',
  'common.remove': 'Remove',
  'common.removed': 'Will be removed',
  'common.undo': 'Undo',
  'common.default': 'Default: {v}',
  'common.on': 'On',
  'common.off': 'Off',
  'common.error': 'Something went wrong.',
  'common.unsaved': 'You have unsaved changes.',
  'common.switchLose': 'Changes not saved yet on this page will be lost. Switch the language anyway?',
  'secret.keep': 'Saved — type to replace',
  'banner.restarting': 'Applying changes — mailsift is restarting…',
  'banner.slow': 'mailsift has not come back yet. Check the service log.',
  'banner.manual': 'Saved. mailsift was started without its supervisor, so restart it to apply the changes.',
  'banner.applied': 'Changes applied.',
  'banner.idle': 'No mailbox is being checked. Add one, or sign in to the ones waiting for it.',
  'banner.offline': 'mailsift is not answering. It may be restarting.',
  'mb.title': 'Mailboxes',
  'mb.lede': 'mailsift signs in to these over IMAP. Passwords stay on this server and are never shown again.',
  'mb.add': 'Add mailbox',
  'mb.none': 'No mailbox yet.',
  'mb.ready': 'Ready',
  'mb.disabled': 'Off',
  'mb.needsAuth': 'Needs sign-in',
  'mb.needsPassword': 'Needs password',
  'mb.invalid': 'Check settings',
  'mb.readOnly': 'Signed in for reading only — sign in again to send',
  'mb.signin': 'Sign in',
  'mb.signinAgain': 'Sign in again',
  'mb.edit': 'Edit',
  'mb.test': 'Test',
  'mb.dialogNew': 'Add a mailbox',
  'mb.dialogEdit': 'Edit mailbox',
  'mb.provider': 'Provider',
  'mb.address': 'Email address',
  'mb.password': 'App password',
  'mb.passwordHelp': 'Most providers want an app password (or authorization code) created in their settings, with IMAP turned on — not your normal login password.',
  'mb.passwordKeep': 'Saved — leave empty to keep',
  'mb.oauthNote': 'This mailbox signs in with {p}. After saving, you will be sent to {p} to allow access.',
  'mb.oauthApp': 'mailsift needs an OAuth app of your own for {p}. Enter it once; it is used for every {p} mailbox.',
  'mb.name': 'Display name',
  'mb.namePlaceholder': 'Work, Personal…',
  'mb.folders': 'Folders to check',
  'mb.foldersDefault': 'Inbox and spam',
  'mb.foldersAll': 'All folders except Sent, Drafts and Trash',
  'mb.foldersCustom': 'Choose folders',
  'mb.foldersHint': 'Test the connection to list this mailbox\'s folders.',
  'mb.testConn': 'Test connection',
  'mb.testOk': 'Connected. {n} folders found.',
  'mb.testFirst': 'Sign in first, then test.',
  'mb.server': 'Server and sending',
  'mb.host': 'IMAP server',
  'mb.port': 'IMAP port',
  'mb.ssl': 'Use SSL/TLS',
  'mb.smtpHost': 'SMTP server',
  'mb.smtpHostHelp': 'For sending from the web view. Known providers need nothing here.',
  'mb.smtpPort': 'SMTP port',
  'mb.fromName': 'Send as (name)',
  'mb.authserv': 'Authentication-Results server ID',
  'mb.authservHelp': 'What this mailbox\'s receiving server calls itself (e.g. mx.example.com), to show whether a sender was verified. Known for major providers; "none" turns it off.',
  'mb.enabled': 'Check this mailbox',
  'mb.saveSignin': 'Save and sign in',
  'mb.deleteConfirm': 'Delete {a}? mailsift stops checking it and forgets its password or sign-in. Mail on the server is not touched.',
  'mb.deleted': 'Mailbox deleted.',
  'mb.providerDefault': 'Provider default',
  'oauth.pasteTitle': 'Finish signing in',
  'oauth.pasteBody': 'A new tab opened at {p}. After you allow access it ends on a page that does not load (http://localhost:8765/…). Copy that page\'s full address from the address bar and paste it here.',
  'oauth.pastePlaceholder': 'http://localhost:8765/?code=…',
  'oauth.finish': 'Finish',
  'oauth.ok': 'Signed in. Testing the connection…',
  'oauth.denied': 'The sign-in was declined or cancelled.',
  'oauth.failed': 'The sign-in did not complete. Try again.',
  'oauth.expired': 'That sign-in had expired. Start it again.',
  'oauth.reopen': 'Open the sign-in page again',
  'ai.lede': 'Without a model, mailsift judges mail with local rules and keywords. With one, parts of each message (redacted, see Privacy) go to the provider you choose.',
  'notifications.lede': 'Where important mail is pushed. The web view and browser notifications work without any of these.',
  'notifications.test': 'Send a test',
  'triage.lede': 'What counts as important to you.',
  'schedule.lede': 'How often mailboxes are checked, and the daily digest of what was not pushed.',
  'privacy.lede': 'What reaches the model, and how long mailsift keeps its own records.',
  'sending.lede': 'Replying and sending from the web view (and MCP clients holding the write token or the admin token).',
  'oauth.lede': 'Gmail and Outlook usually refuse app passwords. Register an OAuth app once and every such mailbox signs in through it.',
  'advanced.lede': 'Limits and diagnostics. The defaults suit almost everyone.',
  'access.lede': 'How you, and the AI clients you connect, reach this server.',
  'access.password': 'Administrator password',
  'access.passwordBody': 'Signs in to the web view and these settings.',
  'access.change': 'Change password',
  'access.current': 'Current password',
  'access.new': 'New password',
  'access.changed': 'Password changed. Other browsers were signed out.',
  'access.endOthers': 'Sign out other browsers',
  'access.ended': 'Signed out {n} other session(s).',
  'access.forgot': 'Forgot it? On the server run: docker compose exec mailsift node dist/src/main.js --reset-admin',
  'access.mcp': 'MCP',
  'access.mcpBody': 'AI clients connect to this address with a token as the Bearer credential.',
  'access.endpoint': 'Endpoint',
  'access.read': 'Read token',
  'access.readBody': 'Reads triage results and mail.',
  'access.write': 'Write token',
  'access.writeBody': 'Everything the read token does, plus acting on mail and sending it.',
  'access.admin': 'Admin token',
  'access.adminBody': 'Everything the write token does, plus the settings: mailboxes, notifications, the model, the other tokens and the administrator password (with the current one). It is not made until you ask for it here.',
  'access.generate': 'Generate new',
  'access.generateFirst': 'Generate',
  'access.generateConfirm': 'Generate a new {k}? The current one stops working.',
  'access.adminFirst': 'Generate an admin token? Whoever holds it can change every setting and every mailbox, replace the other tokens, and change the administrator password (the current one is still asked for). Give it only to a client you would trust with this settings page.',
  'access.adminConfirm': 'Generate a new admin token? The current one stops working.',
  'access.tokenTitle': 'Your new {k}',
  'access.tokenBody': 'Copy it now: it is not shown again. Clients using the old one need this one.',
  'access.tokenRestart': 'mailsift restarts to start using it.',
  'access.https': 'Reached over HTTPS.',
  'access.loopback': 'Reached at a local address (this machine or an SSH tunnel). For access from elsewhere, put an HTTPS reverse proxy in front.',
  'setup.step1': 'Mailboxes',
  'setup.step2': 'AI model',
  'setup.step3': 'Notifications',
  'setup.step4': 'Start',
  'setup.intro1': 'Add the mailboxes mailsift should watch. One is enough to start; you can add more later in Settings.',
  'setup.intro2': 'Optional. A model writes summaries and judges importance far better than keywords.',
  'setup.intro3': 'Optional. The web view and browser notifications work without these.',
  'setup.intro4': 'Everything else — rules, schedule, privacy, MCP — is in Settings whenever you want it.',
  'setup.next': 'Continue',
  'setup.back': 'Back',
  'setup.skip': 'Skip for now',
  'setup.saveNext': 'Save and continue',
  'setup.needMailbox': 'Add a mailbox that is ready (tested, or signed in) to continue.',
  'setup.start': 'Start mailsift',
  'setup.starting': 'Starting… the first check of your mailboxes begins now.',
  'setup.sumMailboxes': 'Mailboxes',
  'setup.sumModel': 'AI model',
  'setup.sumNotify': 'Notifications',
  'setup.sumTz': 'Time zone',
  'setup.modelNone': 'None — local rules and keywords',
  'setup.notifyNone': 'Web view and browser notifications only',
  'setup.ready': '{n} ready',
  'setup.waiting': '{n} waiting for sign-in',
};

const ZH: Dict = {
  'claim.title': '设置 mailsift',
  'claim.intro': '输入服务日志里的一次性设置码，并设置以后登录用的管理员密码。',
  'claim.code': '设置码',
  'claim.password': '管理员密码',
  'claim.confirm': '再次输入密码',
  'claim.submit': '继续',
  'claim.mismatch': '两次输入的密码不一致。',
  'claim.short': '至少 {n} 个字符。',
  'claim.where': '设置码在哪里？',
  'claim.whereBody': 'mailsift 启动时会打印在日志里。使用 Docker Compose 时运行：docker compose logs mailsift。重启会生成新的设置码：docker compose restart mailsift。',
  'nav.settings': '设置',
  'nav.setup': '初始设置',
  'nav.back': '返回邮件',
  'nav.signout': '退出登录',
  'lang.face': 'EN',
  'common.save': '保存',
  'common.saving': '正在保存…',
  'common.saved': '已保存',
  'common.cancel': '取消',
  'common.close': '关闭',
  'common.delete': '删除',
  'common.test': '测试',
  'common.testing': '正在测试…',
  'common.more': '更多选项',
  'common.copy': '复制',
  'common.copied': '已复制',
  'common.set': '已设置',
  'common.notSet': '未设置',
  'common.remove': '移除',
  'common.removed': '保存后移除',
  'common.undo': '撤销',
  'common.default': '默认：{v}',
  'common.on': '开',
  'common.off': '关',
  'common.error': '出了点问题。',
  'common.unsaved': '有未保存的修改。',
  'common.switchLose': '本页还没保存的修改会丢失，仍要切换语言吗？',
  'secret.keep': '已保存，输入新值以替换',
  'banner.restarting': '正在应用修改，mailsift 正在重启…',
  'banner.slow': 'mailsift 还没有恢复，请查看服务日志。',
  'banner.manual': '已保存。mailsift 没有通过监督进程启动，请手动重启以应用修改。',
  'banner.applied': '修改已生效。',
  'banner.idle': '目前没有在检查任何邮箱。请添加邮箱，或为等待中的邮箱完成登录授权。',
  'banner.offline': 'mailsift 没有响应，可能正在重启。',
  'mb.title': '邮箱',
  'mb.lede': 'mailsift 通过 IMAP 登录这些邮箱。密码只保存在这台服务器上，保存后不会再显示。',
  'mb.add': '添加邮箱',
  'mb.none': '还没有邮箱。',
  'mb.ready': '就绪',
  'mb.disabled': '已停用',
  'mb.needsAuth': '需要登录授权',
  'mb.needsPassword': '需要密码',
  'mb.invalid': '设置有误',
  'mb.readOnly': '当前授权只能读取，重新登录授权后才能发信',
  'mb.signin': '登录授权',
  'mb.signinAgain': '重新授权',
  'mb.edit': '编辑',
  'mb.test': '测试',
  'mb.dialogNew': '添加邮箱',
  'mb.dialogEdit': '编辑邮箱',
  'mb.provider': '邮件服务商',
  'mb.address': '邮箱地址',
  'mb.password': '应用专用密码',
  'mb.passwordHelp': '大多数服务商需要在邮箱设置里开启 IMAP 并生成应用专用密码（授权码），不是平时的登录密码。',
  'mb.passwordKeep': '已保存，留空则保持不变',
  'mb.oauthNote': '这个邮箱通过 {p} 登录授权。保存后会跳转到 {p} 页面确认授权。',
  'mb.oauthApp': 'mailsift 需要你自己的 {p} OAuth 应用。只需填写一次，所有 {p} 邮箱共用。',
  'mb.name': '显示名称',
  'mb.namePlaceholder': '工作、个人…',
  'mb.folders': '检查的文件夹',
  'mb.foldersDefault': '收件箱和垃圾邮件',
  'mb.foldersAll': '除已发送、草稿和已删除外的全部文件夹',
  'mb.foldersCustom': '自选文件夹',
  'mb.foldersHint': '测试连接后会列出这个邮箱的文件夹。',
  'mb.testConn': '测试连接',
  'mb.testOk': '连接成功，找到 {n} 个文件夹。',
  'mb.testFirst': '请先登录授权，再测试。',
  'mb.server': '服务器与发信',
  'mb.host': 'IMAP 服务器',
  'mb.port': 'IMAP 端口',
  'mb.ssl': '使用 SSL/TLS',
  'mb.smtpHost': 'SMTP 服务器',
  'mb.smtpHostHelp': '用于从网页发信。已知服务商无需填写。',
  'mb.smtpPort': 'SMTP 端口',
  'mb.fromName': '发件人名称',
  'mb.authserv': 'Authentication-Results 服务器标识',
  'mb.authservHelp': '这个邮箱的收信服务器在 Authentication-Results 中的名称（如 mx.example.com），用于显示发件人是否通过验证。主流服务商已内置；填 none 关闭。',
  'mb.enabled': '检查这个邮箱',
  'mb.saveSignin': '保存并登录授权',
  'mb.deleteConfirm': '删除 {a}？mailsift 将停止检查它，并删除保存的密码或授权。邮箱里的邮件不受影响。',
  'mb.deleted': '已删除邮箱。',
  'mb.providerDefault': '服务商默认',
  'oauth.pasteTitle': '完成登录授权',
  'oauth.pasteBody': '已在新标签页打开 {p}。允许访问后，页面会跳到一个打不开的地址（http://localhost:8765/…）。请从地址栏复制完整地址，粘贴到这里。',
  'oauth.pastePlaceholder': 'http://localhost:8765/?code=…',
  'oauth.finish': '完成',
  'oauth.ok': '授权成功，正在测试连接…',
  'oauth.denied': '授权被拒绝或已取消。',
  'oauth.failed': '授权没有完成，请重试。',
  'oauth.expired': '这次授权已过期，请重新开始。',
  'oauth.reopen': '重新打开授权页面',
  'ai.lede': '不配置模型时，mailsift 用本地规则和关键词判断。配置后，每封邮件的部分内容（已脱敏，见“隐私”）会发送给你选择的服务商。',
  'notifications.lede': '重要邮件推送到哪里。不配置这些，网页和浏览器通知也能正常使用。',
  'notifications.test': '发送测试',
  'triage.lede': '对你来说什么算重要。',
  'schedule.lede': '多久检查一次邮箱，以及未实时推送邮件的每日摘要。',
  'privacy.lede': '哪些内容会发给模型，以及 mailsift 自己的记录保留多久。',
  'sending.lede': '从网页（以及持有写令牌或管理令牌的 MCP 客户端）回复和发信。',
  'oauth.lede': 'Gmail 和 Outlook 通常不接受应用专用密码。注册一次 OAuth 应用，所有这类邮箱都通过它登录。',
  'advanced.lede': '各类上限与诊断选项。默认值适合绝大多数情况。',
  'access.lede': '你和你连接的 AI 客户端如何访问这台服务器。',
  'access.password': '管理员密码',
  'access.passwordBody': '用于登录网页和这些设置。',
  'access.change': '修改密码',
  'access.current': '当前密码',
  'access.new': '新密码',
  'access.changed': '密码已修改，其他浏览器已退出登录。',
  'access.endOthers': '让其他浏览器退出登录',
  'access.ended': '已结束 {n} 个其他会话。',
  'access.forgot': '忘记密码？在服务器上运行：docker compose exec mailsift node dist/src/main.js --reset-admin',
  'access.mcp': 'MCP',
  'access.mcpBody': 'AI 客户端连接这个地址，并把令牌作为 Bearer 凭证。',
  'access.endpoint': '地址',
  'access.read': '只读令牌',
  'access.readBody': '读取分诊结果和邮件。',
  'access.write': '写令牌',
  'access.writeBody': '包含只读令牌的全部权限，并且可以处理邮件和发信。',
  'access.admin': '管理令牌',
  'access.adminBody': '包含写令牌的全部权限，并且可以修改设置：邮箱、通知、模型、其他令牌和管理员密码（仍需当前密码）。只有你在这里生成它才会存在。',
  'access.generate': '生成新令牌',
  'access.generateFirst': '生成',
  'access.generateConfirm': '生成新的{k}？当前的令牌将失效。',
  'access.adminFirst': '生成管理令牌？持有者可以修改所有设置和邮箱、更换其他令牌，以及修改管理员密码（仍需当前密码）。只交给你放心把设置页交给它的客户端。',
  'access.adminConfirm': '生成新的管理令牌？当前的管理令牌将失效。',
  'access.tokenTitle': '新的{k}',
  'access.tokenBody': '请立即复制，之后不会再显示。使用旧令牌的客户端需要换成这个。',
  'access.tokenRestart': 'mailsift 会重启以启用它。',
  'access.https': '当前通过 HTTPS 访问。',
  'access.loopback': '当前通过本机地址访问（本机或 SSH 隧道）。如需从其他地方访问，请在前面配置 HTTPS 反向代理。',
  'setup.step1': '邮箱',
  'setup.step2': 'AI 模型',
  'setup.step3': '通知',
  'setup.step4': '开始',
  'setup.intro1': '添加 mailsift 要监控的邮箱。一个就可以开始，之后可以在设置里继续添加。',
  'setup.intro2': '可选。模型写摘要、判断重要度都远好于关键词。',
  'setup.intro3': '可选。不配置这些，网页和浏览器通知也能正常使用。',
  'setup.intro4': '其他设置（规则、检查频率、隐私、MCP）随时可以在“设置”里修改。',
  'setup.next': '继续',
  'setup.back': '上一步',
  'setup.skip': '暂时跳过',
  'setup.saveNext': '保存并继续',
  'setup.needMailbox': '需要至少一个就绪的邮箱（测试通过或已登录授权）才能继续。',
  'setup.start': '启动 mailsift',
  'setup.starting': '正在启动…马上开始第一次检查邮箱。',
  'setup.sumMailboxes': '邮箱',
  'setup.sumModel': 'AI 模型',
  'setup.sumNotify': '通知',
  'setup.sumTz': '时区',
  'setup.modelNone': '无，使用本地规则和关键词',
  'setup.notifyNone': '仅网页和浏览器通知',
  'setup.ready': '{n} 个就绪',
  'setup.waiting': '{n} 个等待登录授权',
};

const PROVIDER_LABELS: Record<string, [string, string]> = {
  gmail: ['Gmail (Google sign-in)', 'Gmail（Google 登录授权）'],
  gmail_pw: ['Gmail (app password)', 'Gmail（应用专用密码）'],
  outlook: ['Outlook / Microsoft 365', 'Outlook / Microsoft 365'],
  qq: ['QQ Mail', 'QQ 邮箱'],
  qq_biz: ['Tencent Exmail', '腾讯企业邮箱'],
  '163': ['NetEase 163', '网易 163 邮箱'],
  '126': ['NetEase 126', '网易 126 邮箱'],
  sina: ['Sina Mail', '新浪邮箱'],
  aliyun: ['Alibaba Mail', '阿里邮箱'],
  feishu: ['Feishu Mail', '飞书邮箱'],
  lark: ['Lark Mail', 'Lark 邮箱'],
  icloud: ['iCloud Mail', 'iCloud 邮箱'],
  fastmail: ['Fastmail', 'Fastmail'],
  yahoo: ['Yahoo Mail', 'Yahoo 邮箱'],
  zoho: ['Zoho Mail', 'Zoho 邮箱'],
  yandex: ['Yandex Mail', 'Yandex 邮箱'],
  gmx: ['GMX', 'GMX'],
  imap: ['Other IMAP server', '其他 IMAP 服务器'],
};

const EN_PROVIDER_ORDER = ['gmail', 'outlook', 'icloud', 'fastmail', 'yahoo', 'zoho', 'yandex', 'gmx', 'gmail_pw',
  'qq', 'qq_biz', '163', '126', 'sina', 'aliyun', 'feishu', 'lark', 'imap'];
const ZH_PROVIDER_ORDER = ['qq', 'qq_biz', '163', '126', 'feishu', 'lark', 'aliyun', 'sina', 'gmail', 'gmail_pw', 'outlook',
  'icloud', 'fastmail', 'yahoo', 'zoho', 'yandex', 'gmx', 'imap'];

const SETTINGS_SECTIONS: SectionId[] = ['ai', 'notifications', 'triage', 'schedule', 'privacy', 'sending', 'access', 'advanced'];

function dict(lang: Language): Dict {
  return lang === 'zh-CN' ? ZH : EN;
}

/** The theme the mail view stored, applied before first paint. */
const THEME_BOOT = "(function(){try{var c=localStorage.getItem('theme');document.documentElement.dataset.theme=c==='dark'?'dark':'light';}catch(e){}})();";

function shell(lang: Language, title: string, body: string, nonce: string): string {
  return '<!doctype html><html lang="' + lang + '"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    + '<meta name="referrer" content="no-referrer">'
    + '<link rel="icon" type="image/png" href="/favicon.ico?v=3">'
    + '<title>' + escapeHtml(title) + ' · mailsift</title>'
    + '<style>' + styles() + SETTINGS_CSS + '</style>'
    + '<script nonce="' + nonce + '">' + THEME_BOOT + '</script>'
    + '</head><body>' + body + '</body></html>';
}

/** JSON inside a script element, safe against a closing tag in any string. */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

export function renderClaimPage(lang: Language, nonce: string, version: string): string {
  const d = dict(lang);
  const s = (key: string): string => escapeHtml(d[key] ?? key);
  const next = lang === 'zh-CN' ? 'en' : 'zh-CN';
  return shell(lang, d['claim.title']!, `
    <form class="login st-claim" id="claim" novalidate>
      <img class="brand-mark" src="/icon-192.png?v=3" alt="" aria-hidden="true">
      <h1>${s('claim.title')}</h1>
      <p class="muted">${s('claim.intro')}</p>
      <label class="st-claim-label" for="code">${s('claim.code')}</label>
      <input id="code" name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX" required autofocus>
      <input type="text" name="username" value="mailsift" autocomplete="username" hidden>
      <label class="st-claim-label" for="password">${s('claim.password')}</label>
      <input id="password" type="password" autocomplete="new-password" minlength="${ADMIN_PASSWORD_MIN}" required>
      <label class="st-claim-label" for="confirm">${s('claim.confirm')}</label>
      <input id="confirm" type="password" autocomplete="new-password" required>
      <button type="submit" class="primary-action">${s('claim.submit')}</button>
      <p class="error" role="alert" id="claim-error" hidden></p>
      <details class="st-where"><summary>${s('claim.where')}</summary><p>${s('claim.whereBody')}</p></details>
      <button type="button" id="lang" class="lang">${s('lang.face')}</button>
      <p class="version">${escapeHtml(version)}</p>
    </form>
    <script nonce="${nonce}">${storeLanguageScript()}
    (function () {
      var d = ${embedJson({ mismatch: d['claim.mismatch'], short: (d['claim.short'] ?? '').replace('{n}', String(ADMIN_PASSWORD_MIN)), error: d['common.error'] })};
      var form = document.getElementById('claim');
      var error = document.getElementById('claim-error');
      document.getElementById('lang').onclick = function () { storeLanguage('${next}'); location.reload(); };
      form.onsubmit = async function (event) {
        event.preventDefault();
        error.hidden = true;
        var password = document.getElementById('password').value;
        if (Array.from(password).length < ${ADMIN_PASSWORD_MIN}) { error.textContent = d.short; error.hidden = false; return; }
        if (password !== document.getElementById('confirm').value) { error.textContent = d.mismatch; error.hidden = false; return; }
        var button = form.querySelector('button[type=submit]');
        button.disabled = true;
        try {
          var response = await fetch('/api/admin/claim', {
            method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
            body: JSON.stringify({ code: document.getElementById('code').value, password: password }),
          });
          var data = await response.json().catch(function () { return {}; });
          if (response.ok) { location.replace('/setup'); return; }
          error.textContent = data.error || d.error;
          error.hidden = false;
        } catch (e) {
          error.textContent = d.error;
          error.hidden = false;
        }
        button.disabled = false;
      };
    })();</script>`, nonce);
}

/** Everything on the page that depends on the language, for one language. */
function locale(lang: Language): Record<string, unknown> {
  const d = dict(lang);
  const zh = lang === 'zh-CN';
  return {
    strings: d,
    sections: SETTINGS_SECTIONS.map((id) => ({ id, title: words(SECTION_TITLES[id], lang) })),
    oauthTitle: words(SECTION_TITLES.oauth, lang),
    fields: SETTING_FIELDS.map((field) => ({
      key: field.key,
      section: field.section,
      type: field.type,
      label: words(field.label, lang),
      help: words(field.help, lang),
      defaultValue: field.defaultValue ?? '',
      placeholder: field.placeholder ?? '',
      advanced: Boolean(field.advanced),
      ...(field.min !== undefined ? { min: field.min } : {}),
      ...(field.max !== undefined ? { max: field.max } : {}),
      ...(field.options ? { options: field.options.map((option) => ({ value: option.value, label: words(option.label, lang) })) } : {}),
    })),
    // Object order would put "163" and "126" first; list the likely ones first for each language.
    providers: (zh ? ZH_PROVIDER_ORDER : EN_PROVIDER_ORDER)
      .map((id) => [id, (PROVIDER_PRESETS as Record<string, { host?: string; port: number; auth: string }>)[id]!] as const)
      .map(([id, preset]) => ({
        id,
        label: (PROVIDER_LABELS[id] ?? [id, id])[zh ? 1 : 0],
        oauth: preset.auth !== 'password',
        host: preset.host ?? '',
        port: preset.port,
      })),
  };
}

/**
 * The settings page, with the current state and both languages in it: the
 * page draws at once, without a round trip for its data, and the language
 * switch rewords it in place. Over a slow link every request saved is felt.
 */
export function renderSettingsPage(
  lang: Language, nonce: string, version: string, mode: 'setup' | 'settings', state: unknown, boot: string,
): string {
  const d = dict(lang);
  const bootData = {
    mode,
    lang,
    version,
    minPassword: ADMIN_PASSWORD_MIN,
    state,
    boot,
    locales: { en: locale('en'), 'zh-CN': locale('zh-CN') },
  };
  const title = mode === 'setup' ? d['nav.setup']! : d['nav.settings']!;
  return shell(lang, title, `
    <header class="st-header">
      <div class="st-header-inner">
        <a class="brand" href="${mode === 'setup' ? '/setup' : '/'}"><img class="brand-mark" src="/icon-192.png?v=3" alt="" aria-hidden="true"><strong>mailsift</strong></a>
        <span class="st-crumb" id="crumb">${escapeHtml(title)}</span>
        <div class="st-header-actions">
          ${mode === 'settings' ? `<a class="word-btn" href="/" id="back">${escapeHtml(d['nav.back']!)}</a>` : ''}
          <button type="button" class="word-btn" id="lang">${escapeHtml(d['lang.face']!)}</button>
          <form method="post" action="/auth/signout" class="st-signout"><button type="submit" class="word-btn" id="signout">${escapeHtml(d['nav.signout']!)}</button></form>
        </div>
      </div>
    </header>
    <div class="st-banner" id="banner" role="status" hidden></div>
    <div class="st-layout ${mode === 'setup' ? 'st-setup' : ''}" id="app" aria-busy="true"></div>
    <p class="version st-version">mailsift ${escapeHtml(version)}</p>
    <div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
    <dialog class="st-dialog" id="dialog"></dialog>
    <script type="application/json" id="boot">${embedJson(bootData)}</script>
    <script nonce="${nonce}">${storeLanguageScript()}\n${SETTINGS_SCRIPT}</script>`, nonce);
}

const SETTINGS_CSS = `
body{min-height:100vh}
.st-header{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding:env(safe-area-inset-top) 12px 0 16px}
.st-header-inner{display:flex;align-items:center;gap:12px;width:min(1080px,100%);min-height:52px;margin:0 auto}
.st-header .brand{text-decoration:none;color:var(--text)}
.st-crumb{color:var(--muted);font-size:14px;padding-left:12px;border-left:1px solid var(--line)}
.st-header-actions{margin-left:auto;display:flex;align-items:center;gap:2px}
.st-header-actions .word-btn{text-decoration:none;display:inline-grid}
.st-signout{margin:0;display:contents}
.st-banner{width:min(1080px,calc(100% - 32px));margin:12px auto 0;padding:10px 14px;border-radius:10px;background:var(--accent-tint);color:var(--text);font-size:14px}
.st-banner.warn{background:color-mix(in srgb,var(--warning) 16%,var(--surface))}
.st-banner.ok{background:var(--ok-tint)}
.st-layout{display:grid;grid-template-columns:200px minmax(0,1fr);gap:40px;width:min(1080px,100%);margin:0 auto;padding:24px 16px 48px}
.st-layout.st-setup{grid-template-columns:minmax(0,680px);justify-content:center}
.st-nav{position:sticky;top:76px;align-self:start;display:flex;flex-direction:column;gap:2px}
.st-nav a{display:block;padding:7px 10px;border-radius:8px;color:var(--text-2);text-decoration:none;font-size:14px}
.st-nav a:hover{background:var(--fill);color:var(--text)}
.st-nav a.on{background:var(--fill);color:var(--text);font-weight:600}
.st-main{min-width:0;max-width:720px}
.st-section{padding:8px 0 36px;margin-bottom:28px;border-bottom:1px solid var(--line);scroll-margin-top:72px}
.st-section:last-child{border-bottom:0}
.st-section h2{margin:0 0 4px;font-size:20px;font-weight:600;letter-spacing:-.01em}
.st-section h3{margin:0 0 2px;font-size:15px;font-weight:600}
.st-lede{margin:0 0 20px;color:var(--muted);font-size:14px;max-width:62ch}
.st-form{display:flex;flex-direction:column;gap:18px}
.st-field{display:flex;flex-direction:column;gap:6px}
.st-field>label,.st-label{font-size:14px;font-weight:600;color:var(--text)}
.st-help{margin:0;color:var(--muted);font-size:12.5px;line-height:1.5;max-width:62ch}
.st-error{margin:0;color:var(--critical-text);font-size:12.5px}
.st-input,.st-field input[type=text],.st-field input[type=password],.st-field input[type=url],.st-field input[type=email],.st-field input[type=number],.st-field select,.st-field textarea{
  width:100%;min-height:40px;padding:8px 11px;border:1px solid var(--line-strong);border-radius:8px;background:var(--surface);color:var(--text);font:inherit;font-size:14px}
.st-field textarea{min-height:76px;resize:vertical;line-height:1.5}
.st-field input:focus,.st-field select:focus,.st-field textarea:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:var(--accent)}
.st-field.bad input,.st-field.bad select,.st-field.bad textarea{border-color:var(--critical)}
.st-field input::placeholder,.st-field textarea::placeholder{color:var(--muted);opacity:.75}
.st-row2{display:grid;grid-template-columns:minmax(0,1fr) 120px;gap:12px}
.st-toggle{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;cursor:pointer}
.st-toggle .st-toggle-text{display:flex;flex-direction:column;gap:4px}
.st-toggle input{appearance:none;-webkit-appearance:none;position:relative;flex:none;width:36px;height:20px;margin:2px 0 0;border-radius:10px;background:var(--switch-off);cursor:pointer;transition:background .12s}
.st-toggle input::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .2s cubic-bezier(.2,.7,.2,1)}
.st-toggle input:checked{background:var(--accent)}.st-toggle input:checked::after{transform:translateX(16px)}
.st-secret{display:flex;align-items:center;gap:8px}
.st-secret input{flex:1}
.st-pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11.5px;font-weight:600;background:var(--fill);color:var(--muted);white-space:nowrap}
.st-pill.set{background:var(--ok-tint);color:var(--ok)}
.st-pill.warn{background:color-mix(in srgb,var(--warning) 18%,var(--surface));color:var(--warning-text)}
.st-pill.off{background:var(--fill);color:var(--muted)}
.st-link{border:0;background:none;padding:4px 2px;color:var(--accent);font:inherit;font-size:13px;cursor:pointer}
.st-link:hover{text-decoration:underline}
.st-link.danger{color:var(--critical-text)}
.st-more{border-top:1px solid var(--line);padding-top:12px}
.st-more>summary{cursor:pointer;color:var(--text-2);font-size:14px;font-weight:600;list-style:none;display:flex;align-items:center;gap:6px}
.st-more>summary::-webkit-details-marker{display:none}
.st-more>summary::before{content:"";width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .15s}
.st-more[open]>summary::before{transform:rotate(45deg)}
.st-more>.st-form{margin-top:18px}
.st-foot{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap;padding-top:4px}
.st-result{margin-right:auto;font-size:13px;color:var(--muted)}
.st-foot .st-btn+.st-result{margin-left:4px}
.st-result.ok{color:var(--ok)}.st-result.bad{color:var(--critical-text)}
.st-btn{min-height:38px;padding:7px 14px;border:1px solid var(--line-strong);border-radius:9px;background:var(--surface);color:var(--text);font:inherit;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap}
.st-btn:hover:not(:disabled){background:var(--fill)}
.st-btn.primary{border-color:var(--accent);background:var(--accent);color:var(--on-accent)}
.st-btn.primary:hover:not(:disabled){filter:brightness(1.07);background:var(--accent)}
.st-btn.danger{color:var(--critical-text)}
.st-btn:disabled{opacity:.5;cursor:default}
.st-mailboxes{list-style:none;margin:0 0 16px;padding:0;border-top:1px solid var(--line)}
.st-mb{display:grid;grid-template-columns:10px minmax(0,1fr) auto;align-items:center;gap:12px;padding:14px 2px;border-bottom:1px solid var(--line)}
.st-dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}
.st-dot.ready{background:var(--ok)}.st-dot.warn{background:var(--warning)}.st-dot.off{background:var(--line-strong)}
.st-mb-name{font-weight:600;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.st-mb-meta{color:var(--muted);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.st-mb-note{font-size:12.5px;margin-top:3px}
.st-mb-note.ok{color:var(--ok)}.st-mb-note.bad{color:var(--critical-text)}
.st-mb-actions{display:flex;align-items:center;gap:6px}
.st-empty{color:var(--muted);font-size:14px;padding:16px 2px;border-bottom:1px solid var(--line);margin:0}
.st-block{display:flex;flex-direction:column;gap:10px;padding:16px 0;border-top:1px solid var(--line)}
.st-block:first-of-type{border-top:0;padding-top:0}
.st-token{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;padding:10px 0}
.st-code{display:block;padding:9px 11px;border-radius:8px;background:var(--fill);font:13px/1.5 ui-monospace,"SF Mono",Menlo,monospace;word-break:break-all;user-select:all}
.st-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.st-steps{display:flex;gap:6px;list-style:none;margin:0 0 28px;padding:0;counter-reset:step}
.st-steps li{flex:1;display:flex;flex-direction:column;gap:6px;color:var(--muted);font-size:13px;font-weight:600}
.st-steps li::before{content:"";height:3px;border-radius:2px;background:var(--line)}
.st-steps li.done::before,.st-steps li.on::before{background:var(--accent)}
.st-steps li.on{color:var(--text)}
.st-summary{list-style:none;margin:0 0 24px;padding:0;border-top:1px solid var(--line)}
.st-summary li{display:grid;grid-template-columns:140px minmax(0,1fr);gap:12px;padding:12px 2px;border-bottom:1px solid var(--line);font-size:14px}
.st-summary li span:first-child{color:var(--muted)}
.st-folders{display:flex;flex-direction:column;gap:2px;max-height:240px;overflow:auto;padding:6px 8px;border:1px solid var(--line);border-radius:8px}
.st-folders label{display:flex;align-items:center;gap:8px;padding:4px 2px;font-size:14px;cursor:pointer}
.st-folders small{color:var(--muted);font-size:11.5px}
.st-radio{display:flex;flex-direction:column;gap:6px}
.st-radio label{display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer}
.st-dialog{width:min(560px,calc(100vw - 24px));max-height:calc(100vh - 48px);padding:0;border:1px solid var(--line);border-radius:14px;background:var(--surface);color:var(--text);box-shadow:var(--shadow-pop)}
.st-dialog::backdrop{background:var(--backdrop)}
.st-dialog form{display:flex;flex-direction:column;max-height:calc(100vh - 50px)}
.st-dialog-head{padding:18px 20px 6px}
.st-dialog-head h2{margin:0;font-size:18px;font-weight:600}
.st-dialog-body{padding:12px 20px 18px;overflow:auto;display:flex;flex-direction:column;gap:16px}
.st-dialog-foot{display:flex;align-items:center;gap:10px;padding:14px 20px;border-top:1px solid var(--line)}
.st-dialog-foot .st-spacer{flex:1}
.st-note{margin:0;padding:10px 12px;border-radius:8px;background:var(--fill);color:var(--text-2);font-size:13px;line-height:1.5}
.st-version{text-align:center;padding:0 0 24px}
.st-claim{max-width:360px;align-items:stretch;text-align:left;margin-top:10vh}
.st-claim .brand-mark,.st-claim h1,.st-claim .muted{align-self:center;text-align:center}
.st-claim-label{font-size:13px;font-weight:600;margin:10px 0 6px;color:var(--text-2)}
.st-claim input{min-height:46px;border:0;border-radius:10px;background:var(--fill);color:var(--text);padding:10px 14px;font:inherit;font-size:16px}
.st-claim #code{font-family:ui-monospace,"SF Mono",Menlo,monospace;letter-spacing:.06em;text-transform:uppercase}
.st-claim .primary-action{margin-top:18px}
.st-claim .error{color:var(--critical-text);font-size:13px;margin:10px 0 0}
.st-where{margin-top:18px;font-size:13px;color:var(--muted)}
.st-where summary{cursor:pointer}
.st-claim .lang{align-self:center;margin-top:14px;border:0;background:none;color:var(--muted);font:inherit;font-size:13px;cursor:pointer}
@media (max-width:820px){
  .st-layout{grid-template-columns:minmax(0,1fr);gap:8px;padding-top:8px}
  .st-nav{position:static;flex-direction:row;overflow-x:auto;gap:4px;padding-bottom:8px;border-bottom:1px solid var(--line);margin-bottom:12px}
  .st-nav a{white-space:nowrap}
  .st-crumb{display:none}
  .st-mb{grid-template-columns:10px minmax(0,1fr);}
  .st-mb-actions{grid-column:2}
  .st-summary li{grid-template-columns:110px minmax(0,1fr)}
}
`;

/**
 * The page's script. Plain ES2020 in a string: it runs in the browser and is
 * never compiled. Built with DOM calls only, so no value from the server is
 * ever parsed as markup.
 */
const SETTINGS_SCRIPT = String.raw`
(function () {
'use strict';
var BOOT = JSON.parse(document.getElementById('boot').textContent);
var app = document.getElementById('app');
var lang = BOOT.lang;
var S = null;
var state = BOOT.state;
var bootId = BOOT.boot;
var forms = {};
// Opened from the mail view's gear: going back returns to it as it was left.
var cameFromMail = new URLSearchParams(location.search).has('back');

/** Use one language's words; both are in the page, so switching needs no reload. */
function applyLocale(next) {
  lang = next;
  var loc = BOOT.locales[lang];
  S = loc.strings;
  BOOT.fields = loc.fields;
  BOOT.sections = loc.sections;
  BOOT.providers = loc.providers;
  BOOT.oauthTitle = loc.oauthTitle;
  BOOT.nextLang = lang === 'zh-CN' ? 'en' : 'zh-CN';
}
applyLocale(lang);

function t(key, vars) {
  var text = S[key] || key;
  if (vars) Object.keys(vars).forEach(function (name) { text = text.split('{' + name + '}').join(String(vars[name])); });
  return text;
}
function el(tag, attrs) {
  var node = document.createElement(tag);
  if (attrs) Object.keys(attrs).forEach(function (key) {
    var value = attrs[key];
    if (value === undefined || value === null || value === false) return;
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  });
  for (var i = 2; i < arguments.length; i++) {
    var child = arguments[i];
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    else node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}
function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

async function api(path, body) {
  var response;
  try {
    response = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (e) {
    var offline = new Error(t('banner.offline'));
    throw offline;
  }
  var data = {};
  try { data = await response.json(); } catch (e) { data = {}; }
  if (response.status === 401 && data.code === 'admin_required') {
    location.href = '/signin?next=' + encodeURIComponent(location.pathname + location.search);
    throw new Error(data.error || 'signed out');
  }
  if (!response.ok) {
    var error = new Error(data.error || t('common.error'));
    error.data = data;
    throw error;
  }
  return data;
}

var toastTimer;
function toast(message, bad) {
  var node = document.getElementById('toast');
  node.textContent = message;
  node.className = 'toast' + (bad ? ' failed' : '');
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { node.hidden = true; }, bad ? 7000 : 3500);
}

function banner(message, kind) {
  var node = document.getElementById('banner');
  if (!message) { node.hidden = true; return; }
  node.textContent = message;
  node.className = 'st-banner' + (kind ? ' ' + kind : '');
  node.hidden = false;
}

async function health() {
  try {
    var response = await fetch('/healthz', { cache: 'no-store' });
    return await response.json();
  } catch (e) {
    return null;
  }
}

var waiting = false;
var afterRestart = [];
/** Run now, or once the restart under way has finished: a test would only hit the old process. */
function whenSettled(task) {
  if (waiting || (state && state.restart && state.restart.pending)) afterRestart.push(task);
  else task();
}
async function waitForRestart(after, message) {
  if (waiting) return;
  waiting = true;
  if (!bootId) { var first = await health(); bootId = first && first.boot; }
  banner(message || t('banner.restarting'));
  var started = Date.now();
  await sleep(1200);
  for (;;) {
    var report = await health();
    if (report && report.boot && report.boot !== bootId) {
      bootId = report.boot;
      waiting = false;
      if (after) { after(); return; }
      banner(t('banner.applied'), 'ok');
      setTimeout(function () { banner(''); updateIdleBanner(); }, 3000);
      await load();
      afterRestart.splice(0).forEach(function (task) { task(); });
      return;
    }
    if (Date.now() - started > 120000) { banner(t('banner.slow'), 'warn'); waiting = false; return; }
    await sleep(1000);
  }
}

function applied(outcome) {
  if (outcome === 'scheduled') waitForRestart();
  else if (outcome === 'manual') banner(t('banner.manual'), 'warn');
}

function updateIdleBanner() {
  if (!state || waiting) return;
  if (state.restart && state.restart.manual) banner(t('banner.manual'), 'warn');
  else if (state.restart && state.restart.pending) waitForRestart();
  else if (BOOT.mode === 'settings' && state.mode === 'idle') banner(t('banner.idle'), 'warn');
  else banner('');
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

function fieldsOf(section, advanced) {
  return BOOT.fields.filter(function (f) { return f.section === section && (advanced === undefined || f.advanced === advanced); });
}
function storedValue(key) { return state.values[key] !== undefined ? state.values[key] : ''; }

/** One form over a set of fields: tracks what changed, saves only that. */
function makeForm(id, fields, options) {
  options = options || {};
  var form = { id: id, fields: fields, controls: {}, clear: {}, node: null, result: null, saveButton: null };
  var root = el('div', { class: 'st-form' });
  var basic = fields.filter(function (f) { return !f.advanced; });
  var more = fields.filter(function (f) { return f.advanced; });
  basic.forEach(function (f) { root.appendChild(renderField(form, f)); });
  if (more.length) {
    var inner = el('div', { class: 'st-form' });
    more.forEach(function (f) { inner.appendChild(renderField(form, f)); });
    root.appendChild(el('details', { class: 'st-more' }, el('summary', { text: t('common.more') }), inner));
  }
  form.result = el('span', { class: 'st-result', 'aria-live': 'polite' });
  form.saveButton = el('button', { type: 'button', class: 'st-btn primary', disabled: true, text: options.saveLabel || t('common.save'), onclick: function () { save(form, options); } });
  var foot = el('div', { class: 'st-foot' }, form.result);
  if (options.test) foot.appendChild(el('button', { type: 'button', class: 'st-btn', text: options.testLabel || t('common.test'), onclick: function (event) { runTest(form, options.test, event.target); } }));
  if (!options.noSave) foot.appendChild(form.saveButton);
  root.appendChild(foot);
  form.node = root;
  if (form.controls.LLM_PROVIDER && form.controls.LLM_BASE_URL) {
    // The endpoint matters for a custom provider; for a preset it is an override few need.
    var endpoint = root.querySelector('[data-key="LLM_BASE_URL"]');
    var showEndpoint = function () {
      endpoint.hidden = form.controls.LLM_PROVIDER.read() !== 'custom' && !form.controls.LLM_BASE_URL.read();
    };
    form.controls.LLM_PROVIDER.input.addEventListener('change', showEndpoint);
    showEndpoint();
  }
  form.onChange = function () {
    form.saveButton.disabled = Object.keys(changes(form)).length === 0;
    if (options.onChange) options.onChange(form);
  };
  forms[id] = form;
  return form;
}

function renderField(form, f) {
  var id = 'f-' + form.id + '-' + f.key;
  var wrap = el('div', { class: 'st-field', 'data-key': f.key });
  var control;
  var stored = storedValue(f.key);
  var help = f.help;
  if (f.type === 'boolean') {
    control = el('input', { type: 'checkbox', role: 'switch', id: id });
    control.checked = (stored || f.defaultValue || 'false') === 'true';
    control.addEventListener('change', function () { form.onChange(); });
    var text = el('span', { class: 'st-toggle-text' }, el('span', { class: 'st-label', text: f.label }), help ? el('p', { class: 'st-help', text: help }) : null);
    wrap.appendChild(el('label', { class: 'st-toggle', for: id }, text, control));
    form.controls[f.key] = { field: f, input: control, read: function () { return control.checked ? 'true' : 'false'; }, initial: control.checked ? 'true' : 'false', stored: stored };
    wrap.appendChild(el('p', { class: 'st-error', hidden: true }));
    return wrap;
  }
  wrap.appendChild(el('label', { for: id, text: f.label }));
  if (f.type === 'select') {
    control = el('select', { id: id });
    (f.options || []).forEach(function (o) { control.appendChild(el('option', { value: o.value, text: o.label })); });
    control.value = stored || f.defaultValue || '';
    if (control.value !== (stored || f.defaultValue || '')) control.value = '';
  } else if (f.type === 'textarea' || (f.type === 'list' && f.section === 'triage')) {
    control = el('textarea', { id: id, rows: f.type === 'textarea' ? 4 : 2, placeholder: f.placeholder || f.defaultValue || '' });
    control.value = f.type === 'list' ? stored.split(',').filter(Boolean).join(', ') : stored;
  } else if (f.type === 'secret') {
    var isSet = Boolean(state.secrets[f.key]);
    control = el('input', { type: 'password', id: id, autocomplete: 'new-password', spellcheck: 'false', placeholder: isSet ? t('secret.keep') : (f.placeholder || '') });
    var pill = el('span', { class: 'st-pill' + (isSet ? ' set' : ''), text: isSet ? t('common.set') : t('common.notSet') });
    var row = el('div', { class: 'st-secret' }, control, pill);
    if (isSet) {
      var clear = el('button', { type: 'button', class: 'st-link danger', text: t('common.remove') });
      clear.onclick = function () {
        form.clear[f.key] = !form.clear[f.key];
        clear.textContent = form.clear[f.key] ? t('common.undo') : t('common.remove');
        pill.textContent = form.clear[f.key] ? t('common.removed') : t('common.set');
        pill.className = 'st-pill' + (form.clear[f.key] ? ' warn' : ' set');
        control.disabled = Boolean(form.clear[f.key]);
        form.onChange();
      };
      row.appendChild(clear);
    }
    wrap.appendChild(row);
  } else {
    var type = f.type === 'number' ? 'text' : (f.type === 'url' ? 'url' : 'text');
    control = el('input', { type: type, id: id, inputmode: f.type === 'number' ? 'numeric' : null, spellcheck: 'false', autocomplete: 'off',
      placeholder: f.placeholder || (f.key === 'TZ' ? state.timeZone : f.defaultValue) || '' });
    control.value = f.type === 'list' ? stored.split(',').filter(Boolean).join(', ') : stored;
  }
  if (f.type !== 'secret') wrap.appendChild(control);
  control.addEventListener('input', function () { form.onChange(); });
  control.addEventListener('change', function () { form.onChange(); });
  var hint = help;
  if (f.type === 'number' && f.defaultValue && f.type !== 'select') hint = (help ? help + ' ' : '') + t('common.default', { v: f.defaultValue });
  if (hint) wrap.appendChild(el('p', { class: 'st-help', text: hint }));
  wrap.appendChild(el('p', { class: 'st-error', hidden: true }));
  form.controls[f.key] = {
    field: f, input: control, stored: stored,
    read: function () { return control.value; },
    initial: f.type === 'secret' ? '' : control.value,
  };
  return wrap;
}

/** What the form would change: a value per edited field, null for a secret to remove. */
function changes(form) {
  var out = {};
  Object.keys(form.controls).forEach(function (key) {
    var c = form.controls[key];
    if (c.field.type === 'secret') {
      if (form.clear[key]) out[key] = null;
      else if (c.read().trim()) out[key] = c.read();
      return;
    }
    var value = c.read();
    if (value !== c.initial) out[key] = value;
  });
  return out;
}

function showErrors(form, errors) {
  var first = null;
  Object.keys(form.controls).forEach(function (key) {
    var wrap = form.node.querySelector('[data-key="' + key + '"]');
    if (!wrap) return;
    var message = errors && errors[key];
    wrap.classList.toggle('bad', Boolean(message));
    var line = wrap.querySelector('.st-error');
    line.hidden = !message;
    line.textContent = message || '';
    if (message && !first) first = form.controls[key].input;
  });
  if (first) {
    var details = first.closest('details');
    if (details) details.open = true;
    first.focus();
  }
}

function setResult(form, message, kind) {
  form.result.textContent = message || '';
  form.result.className = 'st-result' + (kind ? ' ' + kind : '');
}

async function save(form, options) {
  var values = changes(form);
  if (!Object.keys(values).length) { if (options.after) options.after(); return; }
  form.saveButton.disabled = true;
  setResult(form, t('common.saving'));
  showErrors(form, null);
  try {
    var data = await api('/api/admin/settings', { values: values });
    state = data.state;
    setResult(form, t('common.saved'), 'ok');
    resetForm(form);
    applied(data.applied);
    if (options.after) options.after();
    else if (options.rerender) options.rerender();
  } catch (error) {
    setResult(form, error.message, 'bad');
    if (error.data && error.data.errors) showErrors(form, error.data.errors);
    form.saveButton.disabled = false;
  }
}

function resetForm(form) {
  Object.keys(form.controls).forEach(function (key) {
    var c = form.controls[key];
    if (c.field.type === 'secret') {
      c.input.value = '';
      var isSet = Boolean(state.secrets[key]);
      c.input.placeholder = isSet ? t('secret.keep') : (c.field.placeholder || '');
      c.input.disabled = false;
      var pill = c.input.parentNode.querySelector('.st-pill');
      if (pill) { pill.textContent = isSet ? t('common.set') : t('common.notSet'); pill.className = 'st-pill' + (isSet ? ' set' : ''); }
      var clear = c.input.parentNode.querySelector('.st-link');
      if (clear && !isSet) clear.remove();
      form.clear[key] = false;
    } else {
      c.initial = c.read();
    }
  });
  form.onChange();
}

async function runTest(form, path, button) {
  var label = button.textContent;
  button.disabled = true;
  button.textContent = t('common.testing');
  setResult(form, '');
  showErrors(form, null);
  try {
    var data = await api(path, { values: changes(form) });
    setResult(form, data.message, 'ok');
  } catch (error) {
    setResult(form, error.message, 'bad');
    if (error.data && error.data.errors) showErrors(form, error.data.errors);
  }
  button.disabled = false;
  button.textContent = label;
}

// ---------------------------------------------------------------------------
// Mailboxes
// ---------------------------------------------------------------------------

function provider(id) { return BOOT.providers.find(function (p) { return p.id === id; }) || { id: id, label: id, oauth: false, host: '', port: 993 }; }
function oauthName(id) { return id === 'gmail' ? 'Google' : 'Microsoft'; }
function folderSummary(m) {
  if (!m.folders || !m.folders.length) return t('mb.foldersDefault');
  if (m.folders.length === 1 && m.folders[0].toLowerCase() === 'all') return t('mb.foldersAll');
  return m.folders.join(', ');
}
var mailboxNotes = {};

function readinessView(m) {
  switch (m.readiness) {
    case 'ready': return { dot: 'ready', text: t('mb.ready'), pill: 'set' };
    case 'disabled': return { dot: 'off', text: t('mb.disabled'), pill: 'off' };
    case 'needs-authorization': return { dot: 'warn', text: t('mb.needsAuth'), pill: 'warn' };
    case 'needs-password': return { dot: 'warn', text: t('mb.needsPassword'), pill: 'warn' };
    default: return { dot: 'warn', text: t('mb.invalid'), pill: 'warn' };
  }
}

function renderMailboxes(container) {
  container.textContent = '';
  var list = el('ul', { class: 'st-mailboxes' });
  if (!state.mailboxes.length) container.appendChild(el('p', { class: 'st-empty', text: t('mb.none') }));
  state.mailboxes.forEach(function (m) {
    var view = readinessView(m);
    var note = mailboxNotes[m.id];
    var actions = el('div', { class: 'st-mb-actions' });
    actions.appendChild(el('span', { class: 'st-pill ' + view.pill, text: view.text }));
    if (m.oauth) {
      actions.appendChild(el('button', { type: 'button', class: 'st-btn', text: m.readiness === 'needs-authorization' ? t('mb.signin') : t('mb.signinAgain'), onclick: function () { signIn(m.id); } }));
    }
    if (m.readiness === 'ready') actions.appendChild(el('button', { type: 'button', class: 'st-btn', text: t('mb.test'), onclick: function (e) { testSaved(m, e.target); } }));
    actions.appendChild(el('button', { type: 'button', class: 'st-btn', text: t('mb.edit'), onclick: function () { openMailbox(m); } }));
    list.appendChild(el('li', { class: 'st-mb' },
      el('span', { class: 'st-dot ' + view.dot, 'aria-hidden': 'true' }),
      el('div', null,
        el('div', { class: 'st-mb-name', text: m.name || m.username }),
        el('div', { class: 'st-mb-meta', text: (m.name ? m.username + ' · ' : '') + provider(m.provider).label + ' · ' + folderSummary(m) }),
        m.canSend === false ? el('div', { class: 'st-mb-note bad', text: t('mb.readOnly') }) : null,
        note ? el('div', { class: 'st-mb-note ' + (note.ok ? 'ok' : 'bad'), text: note.text }) : null),
      actions));
  });
  if (state.mailboxes.length) container.appendChild(list);
  container.appendChild(el('button', { type: 'button', class: 'st-btn', text: '+ ' + t('mb.add'), onclick: function () { openMailbox(null); } }));
}

async function testSaved(m, button) {
  if (button) { button.disabled = true; button.textContent = t('common.testing'); }
  try {
    var data = await api('/api/admin/mailboxes/test', { id: m.id });
    mailboxNotes[m.id] = { ok: true, text: t('mb.testOk', { n: data.folders.length }) };
  } catch (error) {
    mailboxNotes[m.id] = { ok: false, text: error.message };
  }
  refreshMailboxes();
}

function refreshMailboxes() {
  document.querySelectorAll('[data-mailboxes]').forEach(function (node) { renderMailboxes(node); });
  if (BOOT.mode === 'setup') updateSetupNav();
}

async function signIn(id) {
  try {
    var data = await api('/api/admin/oauth/start', { id: id });
    if (data.mode === 'direct') { location.href = data.url; return; }
    window.open(data.url, '_blank', 'noopener');
    openPaste(id, data);
  } catch (error) {
    toast(error.message, true);
  }
}

function openPaste(id, start) {
  var m = state.mailboxes.find(function (x) { return x.id === id; });
  var dialog = document.getElementById('dialog');
  var input = el('input', { type: 'url', class: 'st-input', placeholder: t('oauth.pastePlaceholder'), spellcheck: 'false', autocomplete: 'off' });
  var result = el('span', { class: 'st-result', 'aria-live': 'polite' });
  var finish = el('button', { type: 'submit', class: 'st-btn primary', text: t('oauth.finish') });
  var form = el('form', { method: 'dialog' },
    el('div', { class: 'st-dialog-head' }, el('h2', { text: t('oauth.pasteTitle') })),
    el('div', { class: 'st-dialog-body' },
      el('p', { class: 'st-help', text: t('oauth.pasteBody', { p: oauthName(m ? m.provider : 'gmail') }) }),
      el('div', { class: 'st-field' }, input),
      el('div', null, el('a', { href: start.url, target: '_blank', rel: 'noopener', class: 'st-link', text: t('oauth.reopen') }))),
    el('div', { class: 'st-dialog-foot' }, result, el('span', { class: 'st-spacer' }),
      el('button', { type: 'button', class: 'st-btn', text: t('common.cancel'), onclick: function () { dialog.close(); } }), finish));
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    finish.disabled = true;
    result.textContent = '';
    try {
      var data = await api('/api/admin/oauth/finish', { url: input.value, state: start.state });
      state = data.state;
      dialog.close();
      toast(t('oauth.ok'));
      applied(data.applied);
      refreshMailboxes();
      var saved = state.mailboxes.find(function (x) { return x.id === id; });
      if (saved && saved.readiness === 'ready') whenSettled(function () { testSaved(saved); });
    } catch (error) {
      result.textContent = error.message;
      result.className = 'st-result bad';
      finish.disabled = false;
    }
  });
  dialog.textContent = '';
  dialog.appendChild(form);
  dialog.showModal();
  input.focus();
}

function field(label, control, help, id) {
  return el('div', { class: 'st-field' }, el('label', { for: id, text: label }), control, help ? el('p', { class: 'st-help', text: help }) : null);
}

function openMailbox(m) {
  var editing = Boolean(m);
  m = m || { provider: BOOT.providers[0].id, username: '', name: '', host: '', port: null, ssl: true, folders: [], smtpHost: '', smtpPort: null, fromName: '', authservId: '', enabled: true, oauth: false, hasPassword: false, readiness: 'needs-password' };
  var dialog = document.getElementById('dialog');
  var discovered = null;
  var selected = (m.folders || []).slice();

  var providerSelect = el('select', { id: 'mb-provider' });
  BOOT.providers.forEach(function (p) { providerSelect.appendChild(el('option', { value: p.id, text: p.label })); });
  providerSelect.value = m.provider;
  var address = el('input', { type: 'email', id: 'mb-address', autocomplete: 'off', spellcheck: 'false', required: true, placeholder: 'you@example.com' });
  address.value = m.username;
  var password = el('input', { type: 'password', id: 'mb-password', autocomplete: 'new-password', placeholder: m.hasPassword ? t('mb.passwordKeep') : '' });
  var name = el('input', { type: 'text', id: 'mb-name', placeholder: t('mb.namePlaceholder') });
  name.value = m.name || '';
  var passwordField = field(t('mb.password'), password, t('mb.passwordHelp'), 'mb-password');
  var oauthBox = el('div', { class: 'st-form' });

  var foldersMode = !m.folders.length ? 'default' : (m.folders.length === 1 && m.folders[0].toLowerCase() === 'all' ? 'all' : 'custom');
  var radios = el('div', { class: 'st-radio', role: 'radiogroup' });
  var folderList = el('div', { class: 'st-folders', hidden: true });
  var folderHint = el('p', { class: 'st-help', text: t('mb.foldersHint') });
  [['default', t('mb.foldersDefault')], ['all', t('mb.foldersAll')], ['custom', t('mb.foldersCustom')]].forEach(function (pair) {
    var radio = el('input', { type: 'radio', name: 'mb-folders', value: pair[0] });
    radio.checked = foldersMode === pair[0];
    radio.addEventListener('change', function () { foldersMode = pair[0]; drawFolders(); });
    radios.appendChild(el('label', null, radio, pair[1]));
  });
  function drawFolders() {
    folderList.textContent = '';
    folderList.hidden = foldersMode !== 'custom';
    folderHint.hidden = foldersMode !== 'custom' || Boolean(discovered);
    if (foldersMode !== 'custom') return;
    var items = discovered ? discovered.slice() : [];
    selected.forEach(function (path) { if (!items.some(function (f) { return f.path === path; })) items.push({ path: path, specialUse: null }); });
    if (!selected.length && discovered) {
      discovered.forEach(function (f) { if (f.path.toUpperCase() === 'INBOX' || f.specialUse === '\\Junk') selected.push(f.path); });
    }
    if (!items.length) { folderList.hidden = true; return; }
    items.forEach(function (f) {
      var box = el('input', { type: 'checkbox', value: f.path });
      box.checked = selected.indexOf(f.path) >= 0;
      box.addEventListener('change', function () {
        if (box.checked) { if (selected.indexOf(f.path) < 0) selected.push(f.path); }
        else selected = selected.filter(function (p) { return p !== f.path; });
      });
      folderList.appendChild(el('label', null, box, f.path, f.specialUse ? el('small', { text: f.specialUse.replace('\\', '') }) : null));
    });
  }

  var host = el('input', { type: 'text', id: 'mb-host', spellcheck: 'false', autocomplete: 'off' });
  host.value = m.host || '';
  var port = el('input', { type: 'text', id: 'mb-port', inputmode: 'numeric' });
  port.value = m.port || '';
  var ssl = el('input', { type: 'checkbox', role: 'switch', id: 'mb-ssl' });
  ssl.checked = m.ssl !== false;
  var smtpHost = el('input', { type: 'text', id: 'mb-smtp-host', spellcheck: 'false', autocomplete: 'off', placeholder: t('mb.providerDefault') });
  smtpHost.value = m.smtpHost || '';
  var smtpPort = el('input', { type: 'text', id: 'mb-smtp-port', inputmode: 'numeric', placeholder: t('mb.providerDefault') });
  smtpPort.value = m.smtpPort || '';
  var fromName = el('input', { type: 'text', id: 'mb-from' });
  fromName.value = m.fromName || '';
  var authserv = el('input', { type: 'text', id: 'mb-authserv', spellcheck: 'false', autocomplete: 'off' });
  authserv.value = m.authservId || '';
  var enabled = el('input', { type: 'checkbox', role: 'switch', id: 'mb-enabled' });
  enabled.checked = m.enabled !== false;
  var server = el('details', { class: 'st-more' }, el('summary', { text: t('mb.server') }), el('div', { class: 'st-form' },
    el('div', { class: 'st-row2' }, field(t('mb.host'), host, null, 'mb-host'), field(t('mb.port'), port, null, 'mb-port')),
    el('label', { class: 'st-toggle', for: 'mb-ssl' }, el('span', { class: 'st-label', text: t('mb.ssl') }), ssl),
    el('div', { class: 'st-row2' }, field(t('mb.smtpHost'), smtpHost, t('mb.smtpHostHelp'), 'mb-smtp-host'), field(t('mb.smtpPort'), smtpPort, null, 'mb-smtp-port')),
    field(t('mb.fromName'), fromName, null, 'mb-from'),
    field(t('mb.authserv'), authserv, t('mb.authservHelp'), 'mb-authserv')));

  var testResult = el('span', { class: 'st-result', 'aria-live': 'polite' });
  var testButton = el('button', { type: 'button', class: 'st-btn', text: t('mb.testConn') });
  var error = el('p', { class: 'st-error', hidden: true });
  var saveButton = el('button', { type: 'submit', class: 'st-btn primary', text: t('common.save') });
  var oauthForm = null;

  function current() {
    var p = provider(providerSelect.value);
    return {
      provider: p.id, username: address.value.trim(), password: p.oauth ? '' : password.value, name: name.value.trim(),
      host: host.value.trim(), port: port.value.trim() || null, ssl: ssl.checked,
      folders: foldersMode === 'default' ? [] : (foldersMode === 'all' ? ['all'] : selected.slice()),
      smtpHost: smtpHost.value.trim(), smtpPort: smtpPort.value.trim() || null, fromName: fromName.value.trim(),
      authservId: authserv.value.trim(), enabled: enabled.checked,
    };
  }
  function authorizedNow() { return editing && m.provider === providerSelect.value && m.username === address.value.trim().toLowerCase() && m.readiness !== 'needs-authorization'; }
  function drawProvider() {
    var p = provider(providerSelect.value);
    passwordField.hidden = p.oauth;
    host.placeholder = p.host || 'imap.example.com';
    port.placeholder = String(p.port);
    if (p.id === 'imap' && !server.open) server.open = true;
    oauthBox.textContent = '';
    oauthForm = null;
    oauthBox.hidden = !p.oauth;
    if (p.oauth) {
      var configured = state.oauthApps[p.id === 'gmail' ? 'gmail' : 'outlook'];
      oauthBox.appendChild(el('p', { class: 'st-note', text: t('mb.oauthNote', { p: oauthName(p.id) }) }));
      if (!configured) {
        oauthBox.appendChild(el('p', { class: 'st-help', text: t('mb.oauthApp', { p: oauthName(p.id) }) }));
        var keys = p.id === 'gmail' ? ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET'] : ['OUTLOOK_CLIENT_ID', 'OUTLOOK_CLIENT_SECRET', 'OUTLOOK_TENANT'];
        var fs = BOOT.fields.filter(function (f) { return keys.indexOf(f.key) >= 0; }).map(function (f) { return Object.assign({}, f, { advanced: f.key === 'OUTLOOK_TENANT' || f.key === 'OUTLOOK_CLIENT_SECRET' }); });
        oauthForm = makeForm('mb-oauth', fs, { noSave: true });
        oauthBox.appendChild(oauthForm.node);
      }
    }
    var needsSignIn = p.oauth && !authorizedNow();
    saveButton.textContent = needsSignIn ? t('mb.saveSignin') : t('common.save');
    testButton.disabled = p.oauth && !authorizedNow();
    testResult.textContent = testButton.disabled ? t('mb.testFirst') : '';
    testResult.className = 'st-result';
  }
  providerSelect.addEventListener('change', drawProvider);
  address.addEventListener('input', drawProvider);

  testButton.onclick = async function () {
    testButton.disabled = true;
    testResult.textContent = t('common.testing');
    testResult.className = 'st-result';
    try {
      var data = await api('/api/admin/mailboxes/test', { id: editing ? m.id : undefined, mailbox: current() });
      discovered = data.folders;
      testResult.textContent = t('mb.testOk', { n: data.folders.length });
      testResult.className = 'st-result ok';
      drawFolders();
    } catch (e) {
      testResult.textContent = e.message;
      testResult.className = 'st-result bad';
    }
    testButton.disabled = false;
  };

  var form = el('form', { method: 'dialog', novalidate: true },
    el('div', { class: 'st-dialog-head' }, el('h2', { text: editing ? t('mb.dialogEdit') : t('mb.dialogNew') })),
    el('div', { class: 'st-dialog-body' },
      field(t('mb.provider'), providerSelect, null, 'mb-provider'),
      field(t('mb.address'), address, null, 'mb-address'),
      passwordField,
      oauthBox,
      field(t('mb.name'), name, null, 'mb-name'),
      el('div', { class: 'st-field' }, el('span', { class: 'st-label', text: t('mb.folders') }), radios, folderHint, folderList),
      el('div', { class: 'st-inline' }, testButton, testResult),
      server,
      editing ? el('label', { class: 'st-toggle', for: 'mb-enabled' }, el('span', { class: 'st-label', text: t('mb.enabled') }), enabled) : null,
      error),
    el('div', { class: 'st-dialog-foot' },
      editing ? el('button', { type: 'button', class: 'st-btn danger', text: t('common.delete'), onclick: remove }) : null,
      el('span', { class: 'st-spacer' }),
      el('button', { type: 'button', class: 'st-btn', text: t('common.cancel'), onclick: function () { dialog.close(); } }),
      saveButton));

  async function remove() {
    if (!confirm(t('mb.deleteConfirm', { a: m.username }))) return;
    try {
      var data = await api('/api/admin/mailboxes/delete', { id: m.id });
      state = data.state;
      dialog.close();
      toast(t('mb.deleted'));
      applied(data.applied);
      refreshMailboxes();
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
    }
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    error.hidden = true;
    saveButton.disabled = true;
    try {
      var p = provider(providerSelect.value);
      var needsSignIn = p.oauth && !authorizedNow();
      if (oauthForm) {
        var appValues = changes(oauthForm);
        if (Object.keys(appValues).length) {
          var savedApp = await api('/api/admin/settings', { values: appValues });
          state = savedApp.state;
          applied(savedApp.applied);
        }
      }
      var data = await api('/api/admin/mailboxes/save', { id: editing ? m.id : undefined, mailbox: current() });
      state = data.state;
      if (!needsSignIn) applied(data.applied);
      dialog.close();
      refreshMailboxes();
      if (needsSignIn) { await signIn(data.mailbox.id); return; }
      toast(t('common.saved'));
      if (data.mailbox.readiness === 'ready' && !editing) {
        var fresh = data.mailbox;
        whenSettled(function () { testSaved(fresh); });
      }
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
      if (e.data && e.data.errors && oauthForm) showErrors(oauthForm, e.data.errors);
    }
    saveButton.disabled = false;
  });

  dialog.textContent = '';
  dialog.appendChild(form);
  drawProvider();
  drawFolders();
  dialog.showModal();
  (editing ? name : address).focus();
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

function renderAccess(section) {
  var origin = location.origin;
  var endpoint = origin + '/mcp';
  var passwordBlock = el('div', { class: 'st-block' },
    el('h3', { text: t('access.password') }), el('p', { class: 'st-help', text: t('access.passwordBody') }));
  var changeArea = el('div', { class: 'st-form', hidden: true });
  var current = el('input', { type: 'password', id: 'pw-current', autocomplete: 'current-password' });
  var next = el('input', { type: 'password', id: 'pw-next', autocomplete: 'new-password', minlength: String(BOOT.minPassword) });
  var result = el('span', { class: 'st-result', 'aria-live': 'polite' });
  changeArea.appendChild(field(t('access.current'), current, null, 'pw-current'));
  changeArea.appendChild(field(t('access.new'), next, t('claim.short', { n: BOOT.minPassword }), 'pw-next'));
  changeArea.appendChild(el('div', { class: 'st-foot' }, result, el('button', { type: 'button', class: 'st-btn primary', text: t('common.save'), onclick: async function (e) {
    e.target.disabled = true;
    try {
      await api('/api/admin/password', { current: current.value, next: next.value });
      current.value = ''; next.value = '';
      changeArea.hidden = true;
      toast(t('access.changed'));
    } catch (error) { result.textContent = error.message; result.className = 'st-result bad'; }
    e.target.disabled = false;
  } })));
  passwordBlock.appendChild(el('div', { class: 'st-inline' },
    el('button', { type: 'button', class: 'st-btn', text: t('access.change'), onclick: function () { changeArea.hidden = !changeArea.hidden; if (!changeArea.hidden) current.focus(); } }),
    el('button', { type: 'button', class: 'st-btn', text: t('access.endOthers'), onclick: async function () {
      try { var data = await api('/api/admin/sessions/end-others', {}); toast(t('access.ended', { n: data.ended })); } catch (error) { toast(error.message, true); }
    } })));
  passwordBlock.appendChild(changeArea);
  passwordBlock.appendChild(el('p', { class: 'st-help', text: t('access.forgot') }));
  section.appendChild(passwordBlock);

  var mcp = el('div', { class: 'st-block' }, el('h3', { text: t('access.mcp') }), el('p', { class: 'st-help', text: t('access.mcpBody') }),
    el('div', { class: 'st-field' }, el('span', { class: 'st-label', text: t('access.endpoint') }),
      el('div', { class: 'st-inline' }, el('code', { class: 'st-code', text: endpoint }), copyButton(endpoint))));
  // The admin token is the one token never made by itself: it exists only once the administrator asks for it here.
  [['read', t('access.read'), t('access.readBody')], ['write', t('access.write'), t('access.writeBody')], ['admin', t('access.admin'), t('access.adminBody')]].forEach(function (row) {
    var set = Boolean(state.tokens && state.tokens[row[0]]);
    mcp.appendChild(el('div', { class: 'st-token' },
      el('div', null, el('div', { class: 'st-label', text: row[1] }), el('p', { class: 'st-help', text: row[2] })),
      el('div', { class: 'st-inline' }, el('span', { class: 'st-pill' + (set ? ' set' : ''), text: set ? t('common.set') : t('common.notSet') }),
        el('button', { type: 'button', class: 'st-btn', text: set ? t('access.generate') : t('access.generateFirst'), onclick: function () { rotate(row[0], row[1]); } }))));
  });
  mcp.appendChild(el('p', { class: 'st-help', text: state.channel === 'https' ? t('access.https') : t('access.loopback') }));
  section.appendChild(mcp);
}

function copyButton(value) {
  var button = el('button', { type: 'button', class: 'st-btn', text: t('common.copy') });
  button.onclick = async function () {
    try { await navigator.clipboard.writeText(value); button.textContent = t('common.copied'); setTimeout(function () { button.textContent = t('common.copy'); }, 1500); }
    catch (e) { toast(t('common.error'), true); }
  };
  return button;
}

async function rotate(kind, label) {
  // An admin token is asked for in words that say what it is: nothing makes it until this does.
  var asked = kind !== 'admin' ? 'access.generateConfirm' : state.tokens && state.tokens.admin ? 'access.adminConfirm' : 'access.adminFirst';
  if (!confirm(t(asked, { k: label }))) return;
  try {
    var data = await api('/api/admin/tokens/rotate', { kind: kind });
    state = data.state;
    var dialog = document.getElementById('dialog');
    var form = el('form', { method: 'dialog' },
      el('div', { class: 'st-dialog-head' }, el('h2', { text: t('access.tokenTitle', { k: label }) })),
      el('div', { class: 'st-dialog-body' }, el('p', { class: 'st-help', text: t('access.tokenBody') }), el('code', { class: 'st-code', text: data.token }),
        data.applied === 'scheduled' ? el('p', { class: 'st-help', text: t('access.tokenRestart') }) : null),
      el('div', { class: 'st-dialog-foot' }, el('span', { class: 'st-spacer' }), copyButton(data.token), el('button', { type: 'submit', class: 'st-btn primary', text: t('common.close') })));
    dialog.textContent = '';
    dialog.appendChild(form);
    dialog.addEventListener('close', function once() { dialog.removeEventListener('close', once); applied(data.applied); }, { once: true });
    dialog.showModal();
  } catch (error) {
    toast(error.message, true);
  }
}

// ---------------------------------------------------------------------------
// Settings page
// ---------------------------------------------------------------------------

function section(id, title, lede) {
  return el('section', { class: 'st-section', id: id, 'aria-labelledby': id + '-title' },
    el('h2', { id: id + '-title', text: title }), lede ? el('p', { class: 'st-lede', text: lede }) : null);
}

function renderSettings() {
  app.textContent = '';
  forms = {};
  var nav = el('nav', { class: 'st-nav', 'aria-label': t('nav.settings') });
  var main = el('main', { class: 'st-main' });
  var all = [{ id: 'mailboxes', title: t('mb.title') }].concat(BOOT.sections);
  all.forEach(function (s) { nav.appendChild(el('a', { href: '#' + s.id, text: s.title })); });

  var mb = section('mailboxes', t('mb.title'), t('mb.lede'));
  var mbList = el('div', { 'data-mailboxes': '' });
  mb.appendChild(mbList);
  renderMailboxes(mbList);
  var oauthSection = el('details', { class: 'st-more', id: 'oauth' }, el('summary', { text: BOOT.oauthTitle }),
    el('p', { class: 'st-lede', text: t('oauth.lede') }), makeForm('oauth', fieldsOf('oauth'), {}).node);
  oauthSection.style.marginTop = '24px';
  mb.appendChild(oauthSection);
  main.appendChild(mb);

  BOOT.sections.forEach(function (s) {
    var node = section(s.id, s.title, S[s.id + '.lede']);
    if (s.id === 'access') renderAccess(node);
    var fields = fieldsOf(s.id);
    if (fields.length) {
      var options = {};
      if (s.id === 'ai') options.test = '/api/admin/test/model';
      if (s.id === 'notifications') { options.test = '/api/admin/test/notifications'; options.testLabel = t('notifications.test'); }
      node.appendChild(makeForm(s.id, fields, options).node);
    }
    main.appendChild(node);
  });
  app.appendChild(nav);
  app.appendChild(main);
  watchNav(nav);
  if (location.hash) { var target = document.getElementById(location.hash.slice(1)); if (target) target.scrollIntoView(); }
}

function watchNav(nav) {
  var links = Array.prototype.slice.call(nav.querySelectorAll('a'));
  // Jumping between sections replaces the address rather than adding to history, so "Back to mail" is one step.
  links.forEach(function (link) {
    link.addEventListener('click', function (event) {
      var target = document.getElementById(link.getAttribute('href').slice(1));
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView();
      history.replaceState(null, '', link.getAttribute('href'));
    });
  });
  function mark() {
    var current = links[0];
    links.forEach(function (link) {
      var target = document.getElementById(link.getAttribute('href').slice(1));
      if (target && target.getBoundingClientRect().top < 120) current = link;
    });
    links.forEach(function (link) { link.classList.toggle('on', link === current); });
  }
  window.addEventListener('scroll', mark, { passive: true });
  mark();
}

// ---------------------------------------------------------------------------
// Setup steps
// ---------------------------------------------------------------------------

var step = 1;
var setupNext = null;

function readyCount() { return state.mailboxes.filter(function (m) { return m.readiness === 'ready'; }).length; }
function updateSetupNav() {
  if (setupNext && step === 1) setupNext.disabled = readyCount() === 0;
  var hint = document.getElementById('setup-hint');
  if (hint) hint.hidden = readyCount() > 0;
}

function goto(next) {
  step = next;
  history.replaceState(null, '', '#step-' + step);
  renderSetup();
  window.scrollTo(0, 0);
}

function renderSetup() {
  app.textContent = '';
  forms = {};
  var main = el('main', { class: 'st-main' });
  var steps = el('ol', { class: 'st-steps' });
  [1, 2, 3, 4].forEach(function (n) { steps.appendChild(el('li', { class: n < step ? 'done' : (n === step ? 'on' : ''), 'aria-current': n === step ? 'step' : null, text: t('setup.step' + n) })); });
  main.appendChild(steps);
  var node = section('step', t('setup.step' + step), t('setup.intro' + step));
  var foot = el('div', { class: 'st-foot' });
  setupNext = null;
  if (step === 1) {
    var list = el('div', { 'data-mailboxes': '' });
    node.appendChild(list);
    renderMailboxes(list);
    node.appendChild(el('p', { class: 'st-help', id: 'setup-hint', text: t('setup.needMailbox'), style: 'margin-top:16px' }));
    setupNext = el('button', { type: 'button', class: 'st-btn primary', text: t('setup.next'), onclick: function () { goto(2); } });
    foot.appendChild(setupNext);
  } else if (step === 2 || step === 3) {
    var id = step === 2 ? 'ai' : 'notifications';
    var fields = fieldsOf(id, false);
    var form = makeForm(id, fields, {
      test: step === 2 ? '/api/admin/test/model' : '/api/admin/test/notifications',
      testLabel: step === 3 ? t('notifications.test') : undefined,
      saveLabel: t('setup.saveNext'),
      after: function () { goto(step + 1); },
    });
    node.appendChild(form.node);
    var formFoot = form.node.querySelector('.st-foot');
    formFoot.insertBefore(el('button', { type: 'button', class: 'st-btn', text: t('setup.back'), onclick: function () { goto(step - 1); } }), formFoot.firstChild);
    formFoot.insertBefore(el('button', { type: 'button', class: 'st-btn', text: t('setup.skip'), onclick: function () { goto(step + 1); } }), formFoot.children[2]);
    form.saveButton.disabled = false;
    form.onChange = function () {};
    foot = null;
  } else {
    var ready = readyCount();
    var waitingAuth = state.mailboxes.filter(function (m) { return m.readiness === 'needs-authorization'; }).length;
    var notify = [];
    if (state.secrets.FEISHU_WEBHOOK_URL) notify.push('Feishu');
    if (state.secrets.WEBHOOK_URL) notify.push('Webhook');
    var summary = el('ul', { class: 'st-summary' },
      el('li', null, el('span', { text: t('setup.sumMailboxes') }), el('span', { text: t('setup.ready', { n: ready }) + (waitingAuth ? ' · ' + t('setup.waiting', { n: waitingAuth }) : '') })),
      el('li', null, el('span', { text: t('setup.sumModel') }), el('span', { text: state.secrets.LLM_API_KEY ? ((state.values.LLM_PROVIDER || state.values.LLM_BASE_URL || 'deepseek') + ' · ' + (state.values.LLM_MODEL || 'deepseek-flash')) : t('setup.modelNone') })),
      el('li', null, el('span', { text: t('setup.sumNotify') }), el('span', { text: notify.length ? notify.join(', ') : t('setup.notifyNone') })),
      el('li', null, el('span', { text: t('setup.sumTz') }), el('span', { text: state.values.TZ || state.timeZone })));
    node.appendChild(summary);
    var start = el('button', { type: 'button', class: 'st-btn primary', text: t('setup.start') });
    start.disabled = ready === 0;
    start.onclick = async function () {
      start.disabled = true;
      try {
        var data = await api('/api/admin/setup/finish', {});
        state = data.state;
        if (data.applied === 'manual') { banner(t('banner.manual'), 'warn'); return; }
        waitForRestart(function () { location.replace('/'); }, t('setup.starting'));
      } catch (error) {
        toast(error.message, true);
        start.disabled = false;
      }
    };
    foot.appendChild(el('button', { type: 'button', class: 'st-btn', text: t('setup.back'), onclick: function () { goto(3); } }));
    foot.appendChild(start);
  }
  if (foot) node.appendChild(foot);
  main.appendChild(node);
  app.appendChild(main);
  updateSetupNav();
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

function render() {
  if (BOOT.mode === 'setup') renderSetup(); else renderSettings();
  app.setAttribute('aria-busy', 'false');
}

async function load() {
  state = await api('/api/admin/state');
  render();
  updateIdleBanner();
}

function dirtyForms() {
  return Object.keys(forms).some(function (id) { return id !== 'mb-oauth' && Object.keys(changes(forms[id])).length > 0; });
}

function relabelHeader() {
  var title = t(BOOT.mode === 'setup' ? 'nav.setup' : 'nav.settings');
  document.documentElement.lang = lang;
  document.title = title + ' · mailsift';
  document.getElementById('crumb').textContent = title;
  var back = document.getElementById('back');
  if (back) back.textContent = t('nav.back');
  document.getElementById('lang').textContent = t('lang.face');
  document.getElementById('signout').textContent = t('nav.signout');
}

function handleReturn() {
  var params = new URLSearchParams(location.search);
  var outcome = params.get('oauth');
  if (!outcome) return;
  var id = params.get('mailbox');
  history.replaceState(null, '', location.pathname + location.hash);
  if (outcome === 'ok') {
    toast(t('oauth.ok'));
    var m = state.mailboxes.find(function (x) { return x.id === id; });
    if (m && m.readiness === 'ready') whenSettled(function () { testSaved(m); });
  } else {
    toast(t('oauth.' + (outcome === 'denied' ? 'denied' : outcome === 'expired' ? 'expired' : 'failed')), true);
  }
}

document.getElementById('lang').onclick = function () {
  if (dirtyForms() && !confirm(t('common.switchLose'))) return;
  var dialog = document.getElementById('dialog');
  if (dialog.open) dialog.close();
  storeLanguage(BOOT.nextLang);
  applyLocale(BOOT.nextLang);
  relabelHeader();
  render();
  if (!waiting) updateIdleBanner();
};
var backLink = document.getElementById('back');
if (backLink) backLink.onclick = function (event) {
  if (cameFromMail && history.length > 1) { event.preventDefault(); history.back(); }
};
window.addEventListener('beforeunload', function (event) {
  if (dirtyForms()) { event.preventDefault(); event.returnValue = ''; }
});

if (BOOT.mode === 'setup') {
  var match = /^#step-([1-4])$/.exec(location.hash);
  if (match) step = Number(match[1]);
}
render();
updateIdleBanner();
handleReturn();
if (cameFromMail && !location.search.includes('oauth=')) history.replaceState(null, '', location.pathname + location.hash);
})();
`;
