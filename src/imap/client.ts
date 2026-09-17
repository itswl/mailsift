/**
 * IMAP 引擎：一套取信逻辑，三种认证方式。
 *
 * 两个从 Python 版本踩出来、必须保留的结论：
 *
 * 1. 取信一律不置 \Seen。否则等于这个工具替你把所有邮件都"读"了一遍，
 *    手机上的未读红点全没了。ImapFlow 的 fetch 默认就是 peek 语义。
 * 2. `UID n:*` 在 IMAP 里永远至少返回一条（最后一封），哪怕它的 UID 小于 n。
 *    所以服务端搜完还要在客户端再滤一次，否则每轮都会重复推送最后一封。
 */
import { ImapFlow, type FetchMessageObject, type ListResponse } from 'imapflow';
import { getAccessToken } from './auth.js';
import { resolveFolders, type Folder } from './folders.js';
import { extractBody, fallbackMessageId, normalizeDate, type MailMessage } from './message.js';
import { needsOAuth, type Account } from '../config.js';
import { getLogger } from '../logger.js';

const log = getLogger('imap');

export interface FolderCursor {
  /** UIDVALIDITY 变了意味着服务端重建过，游标作废 */
  uidValidity: string;
  lastUid: number;
}

export interface MessageBudget {
  remaining: number;
}

function intEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function imapErrorText(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const value = error as {
    message?: unknown;
    response?: unknown;
    responseText?: unknown;
    code?: unknown;
  };
  return [value.message, value.response, value.responseText, value.code]
    .filter((part) => part !== undefined && part !== null && String(part))
    .map(String)
    .filter((part, index, all) => all.indexOf(part) === index)
    .join(' | ');
}

export function selectFetchUids(found: readonly number[], floor: number, limit: number): number[] {
  return [...found]
    .filter((uid) => uid > floor)
    .sort((a, b) => a - b)
    .slice(0, Math.max(0, limit));
}

export async function connect(account: Account): Promise<ImapFlow> {
  const auth = needsOAuth(account)
    ? { user: account.username, accessToken: await getAccessToken(account.username, account.auth) }
    : { user: account.username, pass: account.password ?? '' };

  log.info(`连接 ${account.name} (${account.host}:${account.port}, auth=${account.auth})`);
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.useSsl,
    auth,
    logger: false,
    // 只观察，不改动邮箱状态
    emitLogs: false,
  });
  // ImapFlow can emit a later socket error after connect() has rejected. Node
  // treats an EventEmitter "error" without a listener as process-fatal, which
  // used to turn one provider reset into a container restart loop.
  client.on('error', (error: unknown) => {
    log.warn(`[${account.name}] IMAP 异步连接错误: ${imapErrorText(error)}`);
  });
  try {
    await client.connect();
    return client;
  } catch (error) {
    // A failed handshake can leave a half-open TLS socket behind. Close it
    // before handing the original connection failure back to the watcher.
    try {
      client.close();
    } catch {
      // Preserve the original connection error; cleanup is best effort.
    }
    throw error;
  }
}

export async function listFolders(client: ImapFlow): Promise<ListResponse[]> {
  return client.list();
}

export async function targetFolders(client: ImapFlow, account: Account): Promise<Folder[]> {
  return resolveFolders(await listFolders(client), account.folders);
}

function firstAddress(input: unknown): { name: string; address: string } {
  const list = (input ?? []) as Array<{ name?: string; address?: string }>;
  const head = list[0];
  return { name: head?.name?.trim() ?? '', address: (head?.address ?? '').toLowerCase() };
}


async function toMailMessage(
  raw: FetchMessageObject,
  account: Account,
  folder: Folder,
): Promise<MailMessage> {
  const envelope = raw.envelope;
  const from = firstAddress(envelope?.from);
  const headers = raw.headers?.toString('utf8') ?? '';
  const { body, hasAttachments } = await extractBody(raw.source);

  const messageId =
    envelope?.messageId?.trim() ||
    fallbackMessageId(account.username, {
      date: normalizeDate(envelope?.date),
      subject: envelope?.subject ?? '',
      from: from.address,
      uid: raw.uid,
    });

  return {
    account: account.username,
    accountLabel: account.name,
    provider: account.provider,
    folder: folder.path,
    inSpam: folder.isSpam,
    uid: raw.uid,
    messageId,
    subject: envelope?.subject?.trim() ?? '',
    fromAddr: from.address,
    fromName: from.name,
    toAddrs: ((envelope?.to ?? []) as Array<{ address?: string }>)
      .map((a) => (a.address ?? '').toLowerCase())
      .filter(Boolean),
    date: normalizeDate(envelope?.date),
    body,
    hasAttachments,
    listUnsubscribe: /^list-unsubscribe:/im.test(headers),
  };
}

/** 拉取该文件夹里游标之后的新邮件，返回 (邮件列表, 新游标)。 */
export async function fetchNew(
  client: ImapFlow,
  account: Account,
  folder: Folder,
  cursor: FolderCursor | undefined,
  budget?: MessageBudget,
): Promise<{ messages: MailMessage[]; cursor: FolderCursor }> {
  // readOnly：这个工具只观察，不改动邮箱状态
  const lock = await client.getMailboxLock(folder.path, { readOnly: true });
  try {
    const mailbox = client.mailbox;
    const uidValidity = typeof mailbox === 'object' ? String(mailbox.uidValidity ?? '') : '';
    const lookbackDays = intEnv('INITIAL_LOOKBACK_DAYS', 3);
    const maxPerPoll = intEnv('MAX_MESSAGES_PER_POLL', 200);

    const fresh = !cursor || cursor.uidValidity !== uidValidity;
    if (cursor && fresh) {
      log.warn(`UIDVALIDITY 变化（${cursor.uidValidity} -> ${uidValidity}），按日期重新回溯`);
    }

    const floor = fresh ? 0 : cursor.lastUid;
    const since = new Date(Date.now() - lookbackDays * 86_400_000);
    const found = await client.search(fresh ? { since } : { uid: `${floor + 1}:*` }, { uid: true });

    // `UID n:*` 的兜底语义会把最后一封带回来，这里再滤一次。取最老的
    // 一批而不是最新的一批：游标只推进到本轮真正处理的最后一封，不能把
    // 被 cap 截掉的旧邮件直接跳过去。
    const limit = Math.min(maxPerPoll, budget?.remaining ?? maxPerPoll);
    const uids = selectFetchUids(found || [], floor, limit);
    if (budget) budget.remaining -= uids.length;
    if (uids.length === 0) {
      return { messages: [], cursor: { uidValidity, lastUid: fresh ? 0 : cursor.lastUid } };
    }

    const messages: MailMessage[] = [];
    for await (const raw of client.fetch(
      uids,
      { uid: true, envelope: true, source: true, headers: ['list-unsubscribe'] },
      { uid: true },
    )) {
      try {
        messages.push(await toMailMessage(raw, account, folder));
      } catch (error) {
        // 单封解析失败不该中断整个文件夹
        log.warn(`解析 uid=${raw.uid} 失败，跳过: ${error}`);
      }
    }

    log.info(
      `[${account.name}/${folder.path}] 新邮件 ${messages.length} 封${folder.isSpam ? '（垃圾箱）' : ''}`,
    );
    return { messages, cursor: { uidValidity, lastUid: Math.max(...uids) } };
  } finally {
    lock.release();
  }
}
