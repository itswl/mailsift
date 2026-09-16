/**
 * 文件夹选择——重点是把垃圾箱找出来，以及 `all` 的展开。
 *
 * mUTF-7 解码和 SPECIAL-USE 解析都由 ImapFlow 处理（Python 版本这两块是
 * 手写的），这里只负责"哪些文件夹该扫"这个业务判断。
 */
import type { ListResponse } from 'imapflow';
import { getLogger } from '../logger.js';

const log = getLogger('folders');

export const SPAM_TOKEN = 'spam';
export const ALL_TOKEN = 'all';

/**
 * special-use 属性缺失时的兜底名单。
 *
 * 实测 QQ 的垃圾箱叫 `Junk` 且**不带** \Junk 属性，只能按名字认；
 * 不同服务商的本地化名称也不一样。
 */
const KNOWN_SPAM_NAMES = new Set([
  'spam', 'junk', 'junk email', 'junk e-mail', 'bulk mail', 'bulk',
  '[gmail]/spam', '[google mail]/spam',
  '垃圾箱', '垃圾邮件', '廣告郵件', '广告邮件',
]);

/**
 * `all` 要排除的。判定优先用 RFC 6154 的 special-use 属性，再按名字兜底。
 *
 * 为什么排除：已发送/草稿是自己写的；回收站是主动删的；
 * All Mail / Important / Starred 是视图而非独立存储，收进来等于每封重复一遍。
 */
const EXCLUDED_FLAGS = new Set(['\\sent', '\\drafts', '\\trash', '\\all', '\\important', '\\flagged']);
const EXCLUDED_NAMES = new Set([
  'sent', 'sent messages', 'sent items', 'drafts', 'draft',
  'trash', 'deleted', 'deleted messages', 'deleted items',
  '[gmail]/all mail', '[google mail]/all mail', '[gmail]/sent mail',
  '[gmail]/drafts', '[gmail]/trash', '[gmail]/important', '[gmail]/starred',
  '已发送', '已寄郵件', '草稿箱', '草稿', '已删除', '已刪除', '回收站', '廢紙簍',
]);

export interface Folder {
  /**
   * 文件夹路径。ImapFlow 的 `path` 已经是解好 mUTF-7 的 unicode 字符串，
   * 而且 SELECT 时直接传它即可——Python 版本里那套 mUTF-7 编解码在这里
   * 完全不需要。线上原文保存在 `rawPath`，只在排错时有用。
   */
  path: string;
  rawPath: string;
  flags: Set<string>;
  isSpam: boolean;
  selectable: boolean;
}

function lower(value: string): string {
  return value.trim().toLowerCase();
}

export function toFolder(entry: ListResponse): Folder {
  const flags = new Set([...(entry.flags ?? [])].map((f) => lower(String(f))));
  const specialUse = lower(entry.specialUse ?? '');

  return {
    path: entry.path,
    rawPath: entry.pathAsListed ?? entry.path,
    flags,
    isSpam:
      specialUse === '\\junk' || flags.has('\\junk') || KNOWN_SPAM_NAMES.has(lower(entry.path)),
    selectable: !flags.has('\\noselect'),
  };
}

export function findSpamFolder(folders: Folder[]): Folder | undefined {
  // special-use 属性优先，名字兜底
  return folders.find((f) => f.flags.has('\\junk')) ?? folders.find((f) => f.isSpam);
}

/** `all` 是否会跳过它。probe 用它判断"未监控"是盲区还是本来就该跳过。 */
export function excludedFromAll(folder: Folder, specialUse?: string): boolean {
  if (specialUse && EXCLUDED_FLAGS.has(lower(specialUse))) return true;
  for (const flag of folder.flags) if (EXCLUDED_FLAGS.has(flag)) return true;
  const name = lower(folder.path);
  if (EXCLUDED_NAMES.has(name)) return true;
  // 子目录形式的已发送/草稿，如 QQ 的「其他文件夹/Sent Items」
  return EXCLUDED_NAMES.has(name.split('/').pop() ?? '');
}

/**
 * 把配置里的文件夹名解析成真实 Folder。
 *
 * `spam` 与 `all` 是逻辑名；其余按可读名或线上路径精确匹配（忽略大小写）。
 * 找不到的记一条 warning 并跳过，不影响其它文件夹照常扫描。
 */
export function resolveFolders(
  entries: ListResponse[],
  requested: readonly string[],
): Folder[] {
  const folders = entries.map(toFolder);
  const specialUseByPath = new Map(entries.map((e) => [e.path, e.specialUse ?? '']));
  const byName = new Map<string, Folder>();
  for (const folder of folders) {
    byName.set(lower(folder.path), folder);
    if (!byName.has(lower(folder.rawPath))) byName.set(lower(folder.rawPath), folder);
  }

  const resolved: Folder[] = [];
  const seen = new Set<string>();
  const push = (folder: Folder): void => {
    if (seen.has(folder.path)) return;
    if (!folder.selectable) {
      log.warn(`文件夹不可选（是容器节点），跳过: ${folder.path}`);
      return;
    }
    seen.add(folder.path);
    resolved.push(folder);
  };

  for (const item of requested) {
    const key = lower(item);

    if (key === ALL_TOKEN) {
      for (const folder of folders) {
        if (!folder.selectable) continue;
        if (excludedFromAll(folder, specialUseByPath.get(folder.path))) continue;
        push(folder);
      }
      continue;
    }

    if (key === SPAM_TOKEN) {
      const spam = findSpamFolder(folders);
      if (!spam) {
        log.warn(
          '未发现垃圾箱文件夹，该账号只扫收件箱；' +
            '可用 npm run probe 打印实际文件夹列表后写进 MAIL_ACCOUNT_N_FOLDERS',
        );
        continue;
      }
      push(spam);
      continue;
    }

    const found = byName.get(key);
    if (!found) {
      log.warn(`文件夹不存在，跳过: ${item}`);
      continue;
    }
    push(found);
  }

  return resolved;
}
