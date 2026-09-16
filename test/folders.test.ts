import { describe, expect, it } from 'vitest';
import './setup.js';
import type { ListResponse } from 'imapflow';
import { findSpamFolder, resolveFolders, toFolder } from '../src/imap/folders.js';

/** ImapFlow 的 path 已经是解好 mUTF-7 的 unicode 字符串 */
function entry(path: string, opts: { flags?: string[]; specialUse?: string; raw?: string } = {}): ListResponse {
  return {
    path,
    pathAsListed: opts.raw ?? path,
    name: path.split('/').pop() ?? path,
    delimiter: '/',
    flags: new Set(opts.flags ?? ['\\HasNoChildren']),
    listed: true,
    subscribed: true,
    ...(opts.specialUse ? { specialUse: opts.specialUse } : {}),
  } as unknown as ListResponse;
}

const INBOX = entry('INBOX');
const GMAIL_SPAM = entry('[Gmail]/垃圾邮件', { specialUse: '\\Junk', raw: '[Gmail]/&V4NXPpCuTvY-' });
const OUTLOOK_JUNK = entry('Junk Email', { specialUse: '\\Junk' });
// 实测 QQ 的垃圾箱叫 Junk 且不带 special-use 属性
const QQ_JUNK = entry('Junk');
const QQ_ARCHIVE = entry('其他文件夹/邮件归档');
const QQ_CONTAINER = entry('其他文件夹', { flags: ['\\HasChildren', '\\Noselect'] });
const SENT = entry('Sent Messages', { specialUse: '\\Sent' });
const TRASH = entry('Deleted Messages', { specialUse: '\\Trash' });
const GMAIL_ALL = entry('[Gmail]/All Mail', { specialUse: '\\All' });

describe('垃圾箱识别', () => {
  it('优先用 special-use 属性', () => {
    expect(findSpamFolder([INBOX, OUTLOOK_JUNK].map(toFolder))?.path).toBe('Junk Email');
  });

  it('没有 special-use 时按名字兜底', () => {
    // 这正是 QQ 的情况
    expect(findSpamFolder([INBOX, QQ_JUNK].map(toFolder))?.path).toBe('Junk');
  });

  it('已发送不会被误认成垃圾箱', () => {
    expect(toFolder(SENT).isSpam).toBe(false);
  });

  it('认不出时降级为只扫收件箱，而不是整个账号挂掉', () => {
    expect(resolveFolders([INBOX, SENT], ['INBOX', 'spam']).map((f) => f.path)).toEqual(['INBOX']);
  });
});

describe('all 展开', () => {
  it('收进归档这类被规则移走的文件夹', () => {
    // 实测某账号 INBOX 47 封、垃圾箱 7 封，而归档有 211 封从未被看过
    const paths = resolveFolders([INBOX, QQ_JUNK, QQ_ARCHIVE, QQ_CONTAINER], ['all']).map((f) => f.path);
    expect(paths).toContain('其他文件夹/邮件归档');
    expect(paths).toContain('INBOX');
    expect(paths).toContain('Junk');
  });

  it('排除已发送、草稿、回收站', () => {
    expect(resolveFolders([INBOX, SENT, TRASH], ['all']).map((f) => f.path)).toEqual(['INBOX']);
  });

  it('排除 Gmail 的 All Mail —— 它是全部邮件的视图，收进来等于每封重复一遍', () => {
    const paths = resolveFolders([INBOX, GMAIL_ALL, GMAIL_SPAM], ['all']).map((f) => f.path);
    expect(paths).not.toContain('[Gmail]/All Mail');
    expect(paths).toContain('[Gmail]/垃圾邮件');
  });

  it('跳过 Noselect 容器节点', () => {
    expect(resolveFolders([INBOX, QQ_CONTAINER], ['all']).map((f) => f.path)).toEqual(['INBOX']);
  });

  it('显式点名 Noselect 容器也会跳过', () => {
    expect(resolveFolders([INBOX, QQ_CONTAINER], ['其他文件夹'])).toHaveLength(0);
  });

  it('与显式名字混写时自动去重', () => {
    const resolved = resolveFolders([INBOX, QQ_JUNK, QQ_ARCHIVE], ['all', 'INBOX', 'spam']);
    expect(new Set(resolved.map((f) => f.path)).size).toBe(resolved.length);
    expect(resolved).toHaveLength(3);
  });
});
