/**
 * 健康告警：账号失联、模型不可用、服务起不来。
 *
 * 一个防漏信的工具自己停了却不出声，是最糟的失败模式。三类故障都会推
 * critical 告警并在恢复后补一条通知。
 */
import type { Account } from '../config.js';
import type { MailMessage } from '../imap/message.js';
import type { TriageResult } from './triage.js';
import type { Sink } from './sink.js';
import { StateStore } from './state.js';
import { getLogger } from '../logger.js';

const log = getLogger('health');

export const FAIL_COUNT_KEY = 'account_fail_count:';
export const ALERTED_AT_KEY = 'account_alerted_at:';
export const LLM_FAIL_COUNT_KEY = 'llm_fail_count';
export const LLM_ALERTED_AT_KEY = 'llm_alerted_at';
export const STARTUP_ALERTED_AT_KEY = 'startup_alerted_at';

function cooldownSeconds(): number {
  return Number(process.env.ACCOUNT_ALERT_COOLDOWN_SECONDS ?? 21_600);
}

function withinCooldown(state: StateStore, key: string): boolean {
  const last = state.getMeta(key);
  if (!last) return false;
  const age = (Date.now() - new Date(last).valueOf()) / 1000;
  return Number.isFinite(age) && age < cooldownSeconds();
}

/** 认证类失败：凭据本身的问题，重试多少次都不会好 */
function isAuthFailure(error: unknown): boolean {
  const text = String(error).toLowerCase();
  return [
    'authentication failed', 'invalid credentials', 'login failed',
    'invalid_grant', 'authenticationfailed', 'auth error', 'authenticate failed',
  ].some((marker) => text.includes(marker));
}

function healthMessage(subject: string, body: string, key: string, stamp: string): MailMessage {
  return {
    account: 'mailsift',
    accountLabel: 'mailsift 自身',
    provider: '',
    folder: 'health',
    inSpam: false,
    uid: 0,
    messageId: `<health-${key}-${stamp}@mailsift>`,
    subject,
    fromAddr: 'health@mailsift',
    fromName: 'mailsift',
    toAddrs: [],
    date: new Date().toISOString(),
    body,
    hasAttachments: false,
    listUnsubscribe: false,
    // 按整块正文渲染，而不是截断成摘要
    extra: { digest: true },
  };
}

function critical(reason: string): TriageResult {
  return {
    importance: 'critical', score: 100, summary: '', reason, deadline: '',
    category: '服务自身故障', actionRequired: true, decidedBy: 'health',
  };
}

function info(reason: string): TriageResult {
  return {
    importance: 'info', score: 0, summary: '', reason, deadline: '',
    category: '服务自身故障', actionRequired: false, decidedBy: 'health',
  };
}

function remedy(account: Account, authFailure: boolean): string {
  if (!authFailure) return '若持续失败，检查服务器到该邮件服务商的网络连通性。';
  if (account.auth === 'gmail_oauth') {
    return (
      '重新授权：`npm run oauth -- --manual --force`。\n' +
      '若这是每 7 天必现一次，说明 Google OAuth 应用还停在「测试」状态——' +
      '去 Google Cloud Console 把同意屏幕改成「已发布」，个人自用无需提交审核。\n' +
      '（个人 Gmail 也可以改用 gmail_pw + 应用专用密码，不必注册应用。）'
    );
  }
  if (account.auth === 'outlook_oauth') {
    return (
      '按可能性排查：\n' +
      '1) Outlook.com 的 IMAP 被关了——设置 → 邮件 → 转发和 IMAP → ' +
      '打开「允许设备和应用使用 IMAP」（默认是关的）；\n' +
      '2) 授权过期——`npm run oauth -- --manual --force`。'
    );
  }
  return (
    '报错通常不区分原因，按可能性排查：\n' +
    '1) IMAP 被关了——网页版「设置 → 账户 / 邮件 / 安全」里确认 IMAP 处于开启状态；\n' +
    '2) 授权码失效（改过密码会导致）——重新生成后更新 .env 并重启；\n' +
    '3) 登录频率受限——调大 POLL_INTERVAL_SECONDS 后观察是否自行恢复。'
  );
}

function hourStamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 10);
}

export async function recordAccountFailure(
  state: StateStore, sink: Sink, account: Account, error: unknown,
): Promise<boolean> {
  const authFailure = isAuthFailure(error);
  const failures = Number(state.getMeta(FAIL_COUNT_KEY + account.username) ?? 0) + 1;
  state.setMeta(FAIL_COUNT_KEY + account.username, String(failures));

  const threshold = Number(process.env.ACCOUNT_ALERT_AFTER_FAILURES ?? 2);
  if (!authFailure && failures < threshold) {
    log.warn(`[${account.name}] 第 ${failures} 次失败，未达告警阈值: ${error}`);
    return false;
  }
  if (withinCooldown(state, ALERTED_AT_KEY + account.username)) {
    log.warn(`[${account.name}] 仍在故障中（${failures} 次），告警冷却中`);
    return false;
  }

  const body = [
    `**${account.name}（${account.username}）已停止监控**`,
    '',
    `**故障类型**　${authFailure ? '认证失败' : '连接失败'}`,
    `**连续失败**　${failures} 次`,
    `**错误信息**　${String(error).slice(0, 300)}`,
    '',
    '---',
    remedy(account, authFailure),
    '',
    '⚠️ 在恢复之前，这个邮箱的新邮件（含垃圾箱）不会被检查。',
  ].join('\n');

  const sent = await sink.push(
    healthMessage(`⚠️ 邮箱失联：${account.name}`, body, account.username, hourStamp()),
    critical(`${account.name} ${authFailure ? '认证失败' : '连接失败'}，该邮箱已失去监控覆盖`),
  );
  state.setMeta(ALERTED_AT_KEY + account.username, new Date().toISOString());
  log.error(`[${account.name}] 已发出失联告警（送达=${sent}）: ${error}`);
  return true;
}

export async function recordAccountSuccess(
  state: StateStore, sink: Sink, account: Account,
): Promise<boolean> {
  if (!state.getMeta(FAIL_COUNT_KEY + account.username)) return false;
  const hadAlerted = Boolean(state.getMeta(ALERTED_AT_KEY + account.username));
  state.setMeta(FAIL_COUNT_KEY + account.username, '');
  state.setMeta(ALERTED_AT_KEY + account.username, '');

  if (!hadAlerted) {
    log.info(`[${account.name}] 已恢复（此前未告警）`);
    return false;
  }
  const sent = await sink.push(
    healthMessage(
      `✅ 邮箱已恢复：${account.name}`,
      `**${account.name}（${account.username}）已恢复监控。**\n\n` +
        '故障期间到达的邮件会在下一轮按 UID 游标补齐，不会漏。',
      `ok-${account.username}`,
      String(Date.now()),
    ),
    info(`${account.name} 已恢复连接`),
  );
  log.info(`[${account.name}] 已发出恢复通知（送达=${sent}）`);
  return sent;
}

/**
 * 模型调用失败。系统不会因此停摆——关键词兜底仍在跑——但判别力大幅下降，
 * 这是静默的覆盖面缩水，必须出声。
 */
export async function recordLlmFailure(state: StateStore, sink: Sink, error: unknown): Promise<boolean> {
  const failures = Number(state.getMeta(LLM_FAIL_COUNT_KEY) ?? 0) + 1;
  state.setMeta(LLM_FAIL_COUNT_KEY, String(failures));

  if (failures < Number(process.env.LLM_ALERT_AFTER_FAILURES ?? 2)) {
    log.warn(`模型调用第 ${failures} 次失败，未达告警阈值: ${error}`);
    return false;
  }
  if (withinCooldown(state, LLM_ALERTED_AT_KEY)) {
    log.warn(`模型仍不可用（${failures} 次），告警冷却中`);
    return false;
  }

  const body = [
    `**模型不可用，分诊已降级为关键词兜底**（连续失败 ${failures} 次）`,
    '',
    `**模型**　　　${process.env.LLM_MODEL ?? '(未设置)'}`,
    `**接入地址**　${process.env.LLM_BASE_URL ?? process.env.LLM_PROVIDER ?? '(默认)'}`,
    `**错误信息**　${String(error).slice(0, 300)}`,
    '',
    '---',
    '常见原因：API Key 失效或欠费、模型名写错、上游限流、服务器出网受限。',
    '',
    '⚠️ 降级期间仍能识别验证码、欠费、到期这类硬关键词并实时推送，',
    '但其余邮件（真人来信、客户问询等）会被归入每日简报而不是实时告警。',
  ].join('\n');

  const sent = await sink.push(
    healthMessage('⚠️ 模型不可用：分诊已降级', body, 'llm', hourStamp()),
    critical(`${process.env.LLM_MODEL ?? '模型'} 连续 ${failures} 次调用失败，分诊降级为关键词兜底`),
  );
  state.setMeta(LLM_ALERTED_AT_KEY, new Date().toISOString());
  log.error(`已发出模型不可用告警（送达=${sent}）: ${error}`);
  return true;
}

export async function recordLlmSuccess(state: StateStore, sink: Sink): Promise<boolean> {
  if (!state.getMeta(LLM_FAIL_COUNT_KEY)) return false;
  const hadAlerted = Boolean(state.getMeta(LLM_ALERTED_AT_KEY));
  state.setMeta(LLM_FAIL_COUNT_KEY, '');
  state.setMeta(LLM_ALERTED_AT_KEY, '');
  if (!hadAlerted) {
    log.info('模型已恢复（此前未告警）');
    return false;
  }
  const sent = await sink.push(
    healthMessage(
      '✅ 模型已恢复',
      '**分诊已恢复正常。**\n\n降级期间归入简报的邮件不会重新分诊——' +
        '如果那段时间有要紧的信，请在当天的简报里确认一遍。',
      'llm-ok',
      String(Date.now()),
    ),
    info('模型调用已恢复'),
  );
  log.info(`已发出模型恢复通知（送达=${sent}）`);
  return sent;
}

/**
 * 服务起不来时告警。
 *
 * 这是最危险的一类：进程起不来就什么都不会发生，而容器的 restart 策略
 * 会让它安静地反复重启。用户如果把这个服务当成唯一的邮件入口，
 * "彻底静默"和"一切正常"在他那边看起来一模一样。
 *
 * 出口只依赖环境变量，所以账号配置写错时这条路仍然通。
 */
export async function recordStartupFailure(error: unknown, sink: Sink): Promise<boolean> {
  let state: StateStore | undefined;
  try {
    state = new StateStore();
  } catch {
    state = undefined;
  }
  if (state && withinCooldown(state, STARTUP_ALERTED_AT_KEY)) {
    log.error(`启动失败（告警冷却中）: ${error}`);
    return false;
  }
  if (!sink.configured) {
    log.error(`启动失败且没有可用出口，无法告警: ${error}`);
    return false;
  }

  const body = [
    '**mailsift 起不来，当前完全没有在监控你的邮箱。**',
    '',
    `**错误**　${String(error).slice(0, 400)}`,
    '',
    '---',
    '多半是 .env 改坏了。在服务器上执行：',
    '```',
    'docker compose run --rm mailsift node dist/src/main.js --check',
    '```',
    '',
    '⚠️ 修好之前，所有邮箱（含垃圾箱）都不会被检查，也不会有任何通知。',
  ].join('\n');

  const sent = await sink.push(
    healthMessage('🛑 mailsift 启动失败', body, 'startup', hourStamp()),
    critical('服务启动失败，邮箱监控已完全停止'),
  );
  state?.setMeta(STARTUP_ALERTED_AT_KEY, new Date().toISOString());
  log.error(`已发出启动失败告警（送达=${sent}）: ${error}`);
  return true;
}
