import { describe, expect, it } from 'vitest';
import './setup.js';
import type { ListResponse } from 'imapflow';
import { findSpamFolder, resolveFolders, toFolder } from '../src/imap/folders.js';

/** ImapFlow paths are already decoded mUTF-7 Unicode strings. */
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
// In practice, QQ calls its spam folder Junk and provides no special-use attribute.
const QQ_JUNK = entry('Junk');
const QQ_ARCHIVE = entry('其他文件夹/邮件归档');
const QQ_CONTAINER = entry('其他文件夹', { flags: ['\\HasChildren', '\\Noselect'] });
const SENT = entry('Sent Messages', { specialUse: '\\Sent' });
const TRASH = entry('Deleted Messages', { specialUse: '\\Trash' });
const GMAIL_ALL = entry('[Gmail]/All Mail', { specialUse: '\\All' });

describe('spam-folder detection', () => {
  it('prefers the special-use attribute', () => {
    expect(findSpamFolder([INBOX, OUTLOOK_JUNK].map(toFolder))?.path).toBe('Junk Email');
  });

  it('falls back to the name without a special-use attribute', () => {
    // This is the case for QQ.
    expect(findSpamFolder([INBOX, QQ_JUNK].map(toFolder))?.path).toBe('Junk');
  });

  it('does not mistake Sent for spam', () => {
    expect(toFolder(SENT).isSpam).toBe(false);
  });

  it('falls back to scanning only the inbox when detection fails', () => {
    expect(resolveFolders([INBOX, SENT], ['INBOX', 'spam']).map((f) => f.path)).toEqual(['INBOX']);
  });
});

describe('all-folder expansion', () => {
  it('includes folders such as rule-based archives', () => {
    // In practice, one account had 47 inbox messages and 7 spam messages, while 211 archived messages were never seen.
    const paths = resolveFolders([INBOX, QQ_JUNK, QQ_ARCHIVE, QQ_CONTAINER], ['all']).map((f) => f.path);
    expect(paths).toContain('其他文件夹/邮件归档');
    expect(paths).toContain('INBOX');
    expect(paths).toContain('Junk');
  });

  it('excludes sent, drafts, and trash', () => {
    expect(resolveFolders([INBOX, SENT, TRASH], ['all']).map((f) => f.path)).toEqual(['INBOX']);
  });

  it('excludes Gmail All Mail because it duplicates every message', () => {
    const paths = resolveFolders([INBOX, GMAIL_ALL, GMAIL_SPAM], ['all']).map((f) => f.path);
    expect(paths).not.toContain('[Gmail]/All Mail');
    expect(paths).toContain('[Gmail]/垃圾邮件');
  });

  it('skips Noselect container nodes', () => {
    expect(resolveFolders([INBOX, QQ_CONTAINER], ['all']).map((f) => f.path)).toEqual(['INBOX']);
  });

  it('also skips explicitly named Noselect containers', () => {
    expect(resolveFolders([INBOX, QQ_CONTAINER], ['其他文件夹'])).toHaveLength(0);
  });

  it('deduplicates when mixed with explicit folder names', () => {
    const resolved = resolveFolders([INBOX, QQ_JUNK, QQ_ARCHIVE], ['all', 'INBOX', 'spam']);
    expect(new Set(resolved.map((f) => f.path)).size).toBe(resolved.length);
    expect(resolved).toHaveLength(3);
  });
});
