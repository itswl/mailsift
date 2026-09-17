/**
 * Folder selection: detect spam and expand the `all` token.
 *
 * ImapFlow handles mUTF-7 decoding and SPECIAL-USE parsing; this module only
 * decides which folders should be monitored.
 */
import type { ListResponse } from 'imapflow';
import { getLogger } from '../logger.js';

const log = getLogger('folders');

export const SPAM_TOKEN = 'spam';
export const ALL_TOKEN = 'all';

/**
 * Fallback names for servers that omit special-use flags.
 *
 * Some QQ accounts call spam `Junk` without a \Junk flag, and providers use
 * localized names.
 */
const KNOWN_SPAM_NAMES = new Set([
  'spam', 'junk', 'junk email', 'junk e-mail', 'bulk mail', 'bulk',
  '[gmail]/spam', '[google mail]/spam',
  '垃圾箱', '垃圾邮件', '廣告郵件', '广告邮件',
]);

/**
 * Folders excluded by `all`. Prefer RFC 6154 special-use flags, then names.
 *
 * Sent and drafts are user-authored; trash is intentionally deleted; All Mail,
 * Important, and Starred are views rather than independent storage.
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
   * Folder path. ImapFlow's `path` is already decoded Unicode and can be passed
   * directly to SELECT. The original server value is kept in `rawPath` for debugging.
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
  // Prefer special-use flags, then names.
  return folders.find((f) => f.flags.has('\\junk')) ?? folders.find((f) => f.isSpam);
}

/** Whether `all` skips this folder; probe uses this to distinguish intentional exclusions. */
export function excludedFromAll(folder: Folder, specialUse?: string): boolean {
  if (specialUse && EXCLUDED_FLAGS.has(lower(specialUse))) return true;
  for (const flag of folder.flags) if (EXCLUDED_FLAGS.has(flag)) return true;
  const name = lower(folder.path);
  if (EXCLUDED_NAMES.has(name)) return true;
  // Also handle sent/draft subfolders such as QQ's "Other folders/Sent Items".
  return EXCLUDED_NAMES.has(name.split('/').pop() ?? '');
}

/**
 * Resolve configured folder names to real Folder objects.
 *
 * `spam` and `all` are logical names; other values match display or server paths.
 * Missing folders produce a warning and do not stop other folders.
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
      log.warn(`Folder is not selectable (container node); skipping: ${folder.path}`);
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
          'No spam folder found; this account will scan only the inbox. ' +
            'Run npm run probe and add the real folder to MAIL_ACCOUNT_N_FOLDERS.',
        );
        continue;
      }
      push(spam);
      continue;
    }

    const found = byName.get(key);
    if (!found) {
      log.warn(`Folder does not exist; skipping: ${item}`);
      continue;
    }
    push(found);
  }

  return resolved;
}
