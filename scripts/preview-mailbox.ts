/**
 * A made-up mailbox for the web preview: folders, the messages in each, and
 * what browsing, searching and acting on them do, without a server.
 *
 * It stands in for what src/imap/mailbox.ts and the exact lookups in
 * src/imap/client.ts do against IMAP: folders with their special use and
 * counts, a folder a page at a time under a UID cursor, a search (Gmail's in
 * its own words, QQ's limited to subject and sender as the real one is), and
 * live handles that are refused once their message has moved.
 *
 * Every name, address and subject is made up.
 */
import type { Account } from '../src/config.js';
import { LiveMailError, MailActionError, type LiveMessage, type MessageHint, type WebMailAction, type WebMailActionResult } from '../src/imap/client.js';
import {
  envelopeMatches, liveHandle, orderFolders, SEARCH_SCAN_MESSAGES, type LiveItem, type LivePage, type MailboxFolder, type SearchPage,
} from '../src/imap/mailbox.js';
import type { AttachmentManifest } from '../src/imap/message.js';
import type { ReadableMessage } from '../src/imap/readable.js';

export interface PreviewMessage {
  uid: number;
  messageId: string;
  subject: string;
  from: { name: string; address: string };
  date: string;
  flags: { seen: boolean; flagged: boolean; answered: boolean };
  size: number;
  attachments?: AttachmentManifest;
  text?: string;
}

interface PreviewFolder {
  path: string;
  delimiter: string;
  specialUse?: string;
  role: MailboxFolder['role'];
  selectable: boolean;
  messages: PreviewMessage[];
  next: number;
}

const VALIDITY = '7';

/** Senders and subjects for the older mail the store never kept. */
const OLDER: Array<[string, string, string]> = [
  ['Ann Lee', 'ann.lee@studio.example', 'Notes from the studio visit'],
  ['Team notes', 'notes@team.example', 'Weekly standup notes'],
  ['Bank', 'statement@bank.example', 'Your statement is ready'],
  ['Airline', 'no-reply@airline.example', 'Your trip receipt'],
  ['Bob Stone', 'bob@acme.example', 'Re: Quarterly numbers'],
  ['Newsletter', 'hello@newsletter.example', 'This week in design'],
  ['Hosting', 'notice@hosting.example', 'Invoice for October'],
  ['读书会', 'club@example.com', '下个月的书单'],
  ['王小明', 'xiaoming@example.cn', '周末爬山的照片'],
  ['包裹追踪', 'tracking@parcel.example', '您的包裹已签收'],
  ['Cloud', 'billing@cloud.example', 'Payment received, thank you'],
  ['Registrar', 'renewals@registrar.example', 'Your domain was renewed'],
];

function at(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

export class PreviewMailbox {
  private readonly folders = new Map<string, PreviewFolder[]>();

  constructor(private readonly accounts: Account[]) {
    for (const account of accounts) this.folders.set(account.username, this.layout(account));
  }

  private layout(account: Account): PreviewFolder[] {
    const gmail = account.provider.startsWith('gmail');
    const f = (path: string, role: MailboxFolder['role'], specialUse?: string, selectable = true): PreviewFolder =>
      ({ path, delimiter: '/', role, selectable, messages: [], next: 1, ...(specialUse ? { specialUse } : {}) });
    if (gmail) {
      return [
        f('INBOX', 'inbox'), f('[Gmail]', null, undefined, false), f('[Gmail]/All Mail', 'all', '\\All'),
        f('[Gmail]/Sent Mail', 'sent', '\\Sent'), f('[Gmail]/Drafts', 'drafts', '\\Drafts'), f('[Gmail]/Spam', 'junk', '\\Junk'),
        f('[Gmail]/Trash', 'trash', '\\Trash'), f('[Gmail]/Starred', 'starred', '\\Flagged'), f('[Gmail]/Important', 'important', '\\Important'),
        f('Clients', null), f('Clients/Acme', null), f('Clients/Studio', null), f('Family', null), f('Hiring', null),
        f('Newsletters', null), f('Projects', null), f('Projects/2026', null), f('Projects/Archive', null),
        f('Receipts', null), f('Travel', null), f('Travel/2025', null), f('Travel/2026', null),
      ];
    }
    return [
      f('INBOX', 'inbox'), f('Sent Messages', 'sent', '\\Sent'), f('Drafts', 'drafts', '\\Drafts'),
      f('Deleted Messages', 'trash', '\\Trash'), f('垃圾邮件', 'junk', '\\Junk'), f('其他文件夹', null, undefined, false),
      f('其他文件夹/发票', null), f('其他文件夹/旅行', null),
    ];
  }

  private folder(account: string, path: string | undefined): PreviewFolder {
    const found = (this.folders.get(account) ?? []).find((folder) => folder.path === path);
    if (!found || !found.selectable) throw new LiveMailError('folder', `no such folder: ${path ?? ''}`);
    return found;
  }

  /** File a message, as it would have been delivered: the newest gets the highest UID. */
  add(account: string, path: string, message: Omit<PreviewMessage, 'uid'>): PreviewMessage {
    const folder = this.folder(account, path);
    const filed = { ...message, uid: folder.next };
    folder.next += 1;
    folder.messages.push(filed);
    return filed;
  }

  /** Mail older than the store keeps, so a folder has pages to turn and a search finds what triage never saw. */
  fillOlder(): void {
    for (const account of this.accounts) {
      const gmail = account.provider.startsWith('gmail');
      const places = gmail
        ? [['INBOX', 40], ['[Gmail]/All Mail', 140], ['Receipts', 18], ['Projects/2026', 9], ['Travel/2026', 6], ['[Gmail]/Sent Mail', 12], ['[Gmail]/Trash', 4]] as const
        : [['INBOX', 90], ['其他文件夹/发票', 14], ['其他文件夹/旅行', 5], ['Sent Messages', 8], ['垃圾邮件', 6]] as const;
      let n = 0;
      for (const [path, count] of places) {
        // Oldest first, so the newest has the highest UID.
        for (let i = count - 1; i >= 0; i -= 1) {
          n += 1;
          const [name, address, subject] = OLDER[(n * 7) % OLDER.length]!;
          const ago = (i + 3) * 24 * 60 + ((n * 37) % 600);
          this.add(account.username, path, {
            messageId: `<older-${account.username.split('@')[0]}-${n}@preview>`, subject: `${subject}${i % 5 === 0 ? '' : ` (${i + 1})`}`,
            from: { name, address }, date: at(ago), flags: { seen: i > 2 || path !== 'INBOX', flagged: n % 11 === 0, answered: n % 13 === 0 },
            size: 4_000 + ((n * 997) % 90_000),
            ...(n % 6 === 0 ? { attachments: { items: [{ partId: '2', filename: `document-${n}.pdf`, contentType: 'application/pdf', sizeBytes: 48_000, inline: false }], truncated: false } } : {}),
            text: `${subject}.\n\nThis is a made-up message the preview keeps in ${path}, older than anything mailsift stored.`,
          });
        }
      }
      // The newest mail sorts last: put each folder in UID order by date.
      for (const folder of this.folders.get(account.username) ?? []) {
        folder.messages.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
        folder.messages.forEach((message, index) => { message.uid = index + 1; });
        folder.next = folder.messages.length + 1;
      }
    }
  }

  async list(account: Account): Promise<MailboxFolder[]> {
    return orderFolders((this.folders.get(account.username) ?? []).map((folder) => {
      const parts = folder.path.split(folder.delimiter);
      return {
        path: folder.path, name: parts.at(-1) ?? folder.path, parent: parts.length > 1 ? parts.slice(0, -1).join(folder.delimiter) : null,
        depth: parts.length - 1, delimiter: folder.delimiter, flags: folder.selectable ? [] : ['\\noselect'],
        specialUse: folder.specialUse ?? null, specialUseSource: null, role: folder.role, selectable: folder.selectable, subscribed: true,
        ...(folder.selectable ? { messages: folder.messages.length, unseen: folder.messages.filter((m) => !m.flags.seen).length } : {}),
      };
    }));
  }

  private item(account: string, folder: PreviewFolder, message: PreviewMessage): LiveItem {
    return {
      handle: liveHandle({ account, folder: folder.path, uidValidity: VALIDITY, uid: message.uid, messageId: message.messageId }),
      account, folder: folder.path, uid: message.uid, uidValidity: VALIDITY, messageId: message.messageId, storedId: message.messageId,
      subject: message.subject, from: message.from, to: [{ name: '', address: account }], date: message.date, size: message.size,
      flags: { ...message.flags }, attachments: Boolean(message.attachments?.items.some((item) => !item.inline)),
    };
  }

  async browse(account: Account, path: string, options: { before?: string | null; limit?: number }): Promise<LivePage> {
    const folder = this.folder(account.username, path);
    const limit = options.limit ?? 50;
    const below = options.before ? /^\d+\.(\d+)$/.exec(options.before) : null;
    if (options.before && (!below || !options.before.startsWith(`${VALIDITY}.`))) throw new LiveMailError('cursor', 'folder changed');
    const under = below ? Number(below[1]) : Infinity;
    const shown = [...folder.messages].filter((m) => m.uid < under).sort((a, b) => b.uid - a.uid);
    const page = shown.slice(0, limit);
    return {
      account: account.username, folder: folder.path, uidValidity: VALIDITY, total: folder.messages.length,
      items: page.map((m) => this.item(account.username, folder, m)),
      next: shown.length > page.length && page.length ? `${VALIDITY}.${page.at(-1)!.uid}` : null,
    };
  }

  async search(account: Account, options: { query: string; folder?: string | null; before?: string | null; limit?: number }): Promise<SearchPage> {
    const gmail = account.provider.startsWith('gmail');
    const folders = options.folder ? [this.folder(account.username, options.folder)]
      : gmail ? [this.folder(account.username, '[Gmail]/All Mail'), this.folder(account.username, 'INBOX')]
        : [this.folder(account.username, 'INBOX')];
    const limit = options.limit ?? 50;
    const skip = Number(options.before ?? 0) || 0;
    const q = options.query.toLowerCase();
    const seen = new Set<string>();
    const hits: LiveItem[] = [];
    for (const folder of folders) {
      for (const message of [...folder.messages].sort((a, b) => b.uid - a.uid)) {
        if (seen.has(message.messageId)) continue;
        const item = this.item(account.username, folder, message);
        // QQ's own search is not trusted: subject and sender only, as the real fallback reads them.
        const found = gmail ? `${message.subject}\n${message.from.name}\n${message.from.address}\n${message.text ?? ''}`.toLowerCase().includes(q)
          : envelopeMatches(item, options.query);
        if (!found) continue;
        seen.add(message.messageId);
        hits.push(item);
      }
    }
    hits.sort((a, b) => Date.parse(b.date ?? '') - Date.parse(a.date ?? ''));
    const page = hits.slice(skip, skip + limit);
    return {
      account: account.username, query: options.query, folders: folders.map((folder) => folder.path), items: page, total: hits.length,
      next: hits.length > skip + page.length ? String(skip + page.length) : null,
      ...(gmail ? {} : { limited: { reason: 'provider' as const, scanned: Math.min(SEARCH_SCAN_MESSAGES, folders[0]!.messages.length) } }),
    };
  }

  /** The message a live handle names, refused as the real lookup refuses it once it has moved. */
  private exact(account: string, messageId: string, hint: MessageHint): { folder: PreviewFolder; message: PreviewMessage } {
    const folder = this.folder(account, hint.folder);
    if (hint.uidValidity !== VALIDITY) throw new LiveMailError('stale', 'the folder was rebuilt');
    const message = folder.messages.find((m) => m.uid === hint.uid);
    if (!message || message.messageId !== messageId) throw new LiveMailError('moved', 'the message is no longer there');
    return { folder, message };
  }

  /** Where a stored message is in the made-up mailbox, if it is in it. */
  private find(account: string, messageId: string): { folder: PreviewFolder; message: PreviewMessage } | undefined {
    for (const folder of this.folders.get(account) ?? []) {
      if (folder.role === 'all') continue;
      const message = folder.messages.find((m) => m.messageId === messageId);
      if (message) return { folder, message };
    }
    return undefined;
  }

  /** A message read live: from its handle, or by Message-ID. `stored` reads one the store has a fixture for. */
  read(account: Account, messageId: string, hint: MessageHint | undefined, stored: (messageId: string) => LiveMessage | undefined): LiveMessage | undefined {
    const place = hint?.exact ? this.exact(account.username, messageId, hint) : this.find(account.username, messageId);
    const fixture = stored(messageId);
    if (fixture) {
      return place ? { ...fixture, folder: place.folder.path, uid: place.message.uid, uidValidity: VALIDITY, flags: { ...place.message.flags } } : fixture;
    }
    if (!place) return undefined;
    const m = place.message;
    const readable: ReadableMessage = {
      html: null, htmlOmitted: false, text: m.text ?? m.subject, quoted: '', truncated: false, from: m.from,
      to: [{ name: '', address: account.username }], cc: [], replyTo: [], subject: m.subject, date: m.date, messageId: m.messageId,
      inReplyTo: null, references: [], auth: { result: 'none', dkim: null, spf: null, dmarc: null, signedBy: null }, unsubscribe: null, inlineImages: 0,
    };
    return { readable, folder: place.folder.path, flags: { ...m.flags }, uid: m.uid, uidValidity: VALIDITY };
  }

  attachments(account: Account, messageId: string, hint: MessageHint | undefined): AttachmentManifest | undefined {
    const place = hint?.exact ? this.exact(account.username, messageId, hint) : this.find(account.username, messageId);
    return place ? place.message.attachments ?? { items: [], truncated: false } : undefined;
  }

  /** An action on a message, in the made-up mailbox; undefined when the message is not in it. */
  act(
    account: Account, messageId: string, action: WebMailAction, options: { destination?: string; hint?: MessageHint } = {},
  ): WebMailActionResult | undefined {
    const place = options.hint?.exact ? this.exact(account.username, messageId, options.hint) : this.find(account.username, messageId);
    if (!place) return undefined;
    const { folder, message } = place;
    const flag = { mark_read: ['seen', true], mark_unread: ['seen', false], star: ['flagged', true], unstar: ['flagged', false], answered: ['answered', true] } as const;
    if (action in flag) {
      const [name, on] = flag[action as keyof typeof flag];
      message.flags[name] = on;
      return { action, account: account.username, messageId, sourceFolder: folder.path };
    }
    const folders = this.folders.get(account.username) ?? [];
    const byRole = (role: MailboxFolder['role']): PreviewFolder | undefined => folders.find((f) => f.role === role && f.selectable);
    if (action === 'not_spam' && folder.role !== 'junk') throw new MailActionError('not_applicable', 'the message is not in a spam folder');
    const target = action === 'move' ? folders.find((f) => f.path === options.destination && f.selectable)
      : action === 'archive' ? byRole('archive') ?? byRole('all')
        : action === 'trash' ? byRole('trash')
          : action === 'spam' ? byRole('junk')
            : action === 'inbox' || action === 'not_spam' ? byRole('inbox') : undefined;
    if (!target) throw new MailActionError('invalid_destination', action === 'archive' ? 'this mailbox has no archive folder' : 'destination folder not found');
    if (target === folder) throw new MailActionError('invalid_destination', 'message is already in the destination folder');
    folder.messages = folder.messages.filter((m) => m !== message);
    // All Mail already holds what the inbox does; archiving there is only leaving the inbox.
    let moved = target.messages.find((m) => m.messageId === message.messageId);
    if (!moved) {
      moved = { ...message, uid: target.next };
      target.next += 1;
      target.messages.push(moved);
    }
    return {
      action, account: account.username, messageId, sourceFolder: folder.path, destinationFolder: target.path,
      destinationIsSpam: target.role === 'junk', ...(target.role === 'trash' ? { destinationIsTrash: true } : {}),
      destinationUid: moved.uid, destinationUidValidity: VALIDITY,
    };
  }
}
