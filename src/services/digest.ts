/**
 * 每日简报：把不值得实时打扰的邮件攒起来，每天一次性给出。
 *
 * 简报是回看收件箱的主界面（手机上没有邮件客户端），所以每行展示的是
 * 摘要而不是标题——标题常常什么都没说，摘要才是要的信息。
 */
import type { MailMessage } from '../imap/message.js';
import { headline, type TriageResult } from './triage.js';
import type { Sink } from './sink.js';
import type { StateStore } from './state.js';
import { getLogger } from '../logger.js';

const log = getLogger('digest');

export const DIGEST_SENT_KEY = 'digest_last_sent_date';
const MAX_SPAM_LINES = 15;
const MAX_INBOX_LINES = 35;

export interface DigestItem {
  accountLabel: string;
  folder: string;
  inSpam: boolean;
  subject: string;
  from: string;
  fromName: string;
  importance: string;
  category: string;
  summary: string;
  deadline: string;
  date: string;
}

export function toDigestItem(message: MailMessage, result: TriageResult): DigestItem {
  return {
    accountLabel: message.accountLabel,
    folder: message.folder,
    inSpam: message.inSpam,
    subject: message.subject || '(无主题)',
    from: message.fromAddr,
    fromName: message.fromName,
    importance: result.importance,
    category: result.category,
    summary: headline(result),
    deadline: result.deadline,
    date: message.date,
  };
}

function line(item: DigestItem): string {
  const sender = item.fromName || item.from || '未知发件人';
  const gist = (item.summary || '').trim();
  const shown = gist.length > 90 ? `${gist.slice(0, 90)}…` : gist;
  return `- **${sender}**：${shown}${item.deadline ? `　⏰${item.deadline}` : ''}`;
}

export function renderDigest(items: DigestItem[]): string {
  if (items.length === 0) return '过去一天没有需要回顾的邮件。';

  const spam = items.filter((i) => i.inSpam);
  const inbox = items.filter((i) => !i.inSpam);

  const counts = new Map<string, number>();
  for (const item of items) {
    const key = item.category || '未分类';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const lines = [
    `**共 ${items.length} 封**　收件箱 ${inbox.length} · 垃圾箱 ${spam.length}`,
    ordered.slice(0, 8).map(([name, n]) => `${name} ${n}`).join('　'),
  ];

  // 垃圾箱排最前——那是最容易漏的一类，也是简报存在的主要理由
  if (spam.length) {
    lines.push('', `**⚠️ 垃圾箱 ${spam.length} 封（服务商判为垃圾，供你复核）**`);
    for (const item of spam.slice(0, MAX_SPAM_LINES)) lines.push(line(item));
    if (spam.length > MAX_SPAM_LINES) lines.push(`- …另有 ${spam.length - MAX_SPAM_LINES} 封`);
  }

  if (inbox.length) {
    const grouped = new Map<string, DigestItem[]>();
    for (const item of inbox) {
      const key = item.category || '未分类';
      (grouped.get(key) ?? grouped.set(key, []).get(key)!).push(item);
    }
    const groups = [...grouped.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

    let remaining = MAX_INBOX_LINES;
    let droppedCategories = 0;
    for (const [category, group] of groups) {
      if (remaining <= 0) {
        droppedCategories += 1;
        continue;
      }
      lines.push('', `**${category}（${group.length}）**`);
      const shown = Math.min(group.length, remaining);
      for (const item of group.slice(0, shown)) lines.push(line(item));
      remaining -= shown;
      if (group.length > shown) lines.push(`- …本类另有 ${group.length - shown} 封`);
    }
    if (droppedCategories) {
      lines.push('', `_另有 ${droppedCategories} 个分类因篇幅未展开，可用 MCP 的 list_mail 查全部_`);
    }
  }

  return lines.join('\n');
}

export function shouldSend(state: StateStore, at: Date = new Date()): boolean {
  if ((process.env.DIGEST_ENABLED ?? 'true').toLowerCase() === 'false') return false;
  if (at.getHours() < Number(process.env.DIGEST_HOUR ?? 9)) return false;
  return state.getMeta(DIGEST_SENT_KEY) !== at.toISOString().slice(0, 10);
}

/** 发送简报并记录日期。队列为空时也记日期，避免整天反复检查。 */
export async function sendDigest(state: StateStore, sink: Sink, at: Date = new Date()): Promise<boolean> {
  const today = at.toISOString().slice(0, 10);
  const items = state.drainDigest() as DigestItem[];

  if (items.length === 0) {
    log.info('简报队列为空，跳过');
    state.setMeta(DIGEST_SENT_KEY, today);
    return false;
  }

  const spamCount = items.filter((i) => i.inSpam).length;
  const message: MailMessage = {
    account: 'mailsift',
    accountLabel: '每日简报',
    provider: '',
    folder: 'digest',
    inSpam: false,
    uid: 0,
    messageId: `<digest-${today}@mailsift>`,
    subject: `每日邮件简报 · ${items.length} 封（垃圾箱 ${spamCount}）`,
    fromAddr: 'digest@mailsift',
    fromName: 'mailsift',
    toAddrs: [],
    date: at.toISOString(),
    body: renderDigest(items),
    hasAttachments: false,
    listUnsubscribe: false,
    extra: { digest: true },
  };
  const result: TriageResult = {
    importance: 'info',
    score: 0,
    summary: '',
    reason: `${today} 每日简报，共 ${items.length} 封（其中垃圾箱 ${spamCount} 封）`,
    deadline: '',
    category: '每日简报',
    actionRequired: false,
    decidedBy: 'digest',
  };

  const sent = await sink.push(message, result);
  state.setMeta(DIGEST_SENT_KEY, today);
  log.info(`简报已发送: ${items.length} 封 (成功=${sent})`);
  return sent;
}
