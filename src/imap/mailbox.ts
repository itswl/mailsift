/**
 * The whole mailbox, live: any folder, a page at a time, and a search in it.
 *
 * Everything else mailsift shows is what the poller fetched and judged. This
 * is the rest of the mailbox, read from IMAP when it is asked for and kept
 * nowhere: envelopes and flags only, never a body, and nothing of it enters
 * the store, the model or the queue.
 *
 * A message seen here is named by a live handle: the account, the folder, the
 * folder's UIDVALIDITY, the UID and the Message-ID, as the server listed them.
 * A handle is checked every time it is used (see MessageHint.exact): the
 * folder must still exist, its UIDVALIDITY must not have changed and the UID
 * must still carry that Message-ID. One that no longer fits is refused. It is
 * never followed to wherever a message with that Message-ID is now.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FetchMessageObject, ImapFlow, ListResponse } from 'imapflow';
import type { Account } from '../config.js';
import { getLogger } from '../logger.js';
import { withOwnConnection, withSession } from './connection.js';
import { toFolder } from './folders.js';
import {
  exactFolder, firstAddress, folderRole, listFolders, LiveMailError, messageIdDigest, resolveActionDestination, selectedValidity,
  type FolderRole, type MessageHint,
} from './client.js';
import { extractAttachmentManifest, fallbackMessageId, normalizeDate } from './message.js';

const log = getLogger('imap');

// ---- Live handles ----

export const HANDLE_PREFIX = 'live:';
const HANDLE_VERSION = 2;
const HANDLE_MAX_CHARS = 4096;
/** Where the secret that signs handles is kept, so every process on one database makes the same ones. */
export const HANDLE_KEY_META = 'live_handle_key';
const SIGNATURE_CHARS = 22;

/**
 * The secret handles are signed with. A sender can write any Message-ID,
 * one that spells a handle included; without this secret it cannot write one
 * this server takes as a handle. Kept in the state database (useHandleKey), so
 * the main process and a standalone MCP server make and accept the same ones;
 * until a database is at hand, one for this process alone.
 */
let handleKey: Buffer = randomBytes(32);

/**
 * Sign handles with the secret this database keeps. With none kept yet, this
 * process's own is offered, only where there still is none (two processes
 * starting together race to here), and whichever was kept is used: so no
 * process signs with a key another one overwrote.
 */
export function useHandleKey(store: {
  getMeta(key: string): string | undefined;
  casMeta(key: string, expected: string | undefined, next: string): boolean;
}): void {
  const asKey = (text: string | undefined): Buffer | undefined => {
    const key = text ? Buffer.from(text, 'base64') : undefined;
    return key && key.length === 32 ? key : undefined;
  };
  let key = asKey(store.getMeta(HANDLE_KEY_META));
  if (!key) {
    store.casMeta(HANDLE_KEY_META, undefined, handleKey.toString('base64'));
    key = asKey(store.getMeta(HANDLE_KEY_META));
  }
  if (key) handleKey = key;
}

/** Where one message is, as the mailbox listed it. */
export interface LiveHandle {
  account: string;
  folder: string;
  uidValidity: string;
  uid: number;
  /** The Message-ID as the server has it; '' for a message that has none, or one too long to carry (see idDigest). */
  messageId: string;
  /** For a Message-ID too long to carry in a handle: its digest (messageIdDigest), which it is told apart by. */
  idDigest?: string;
}

/** A Message-ID longer than this (as JSON) is carried in a handle as its digest, so every handle stays short enough to be given back. */
const ID_INLINE_MAX = 512;
const DIGEST_CHARS = 43;

/** Where a live handle sends a lookup: that place exactly, told apart by its Message-ID or that id's digest. */
export function exactHint(handle: LiveHandle): MessageHint {
  return {
    folder: handle.folder, uid: handle.uid, uidValidity: handle.uidValidity, exact: true,
    ...(handle.idDigest ? { idDigest: handle.idDigest } : {}),
  };
}

/**
 * Whether a string is meant as a handle. Decided by its first characters
 * alone: such a string only ever names a live message, never a stored record
 * whose Message-ID a sender happened to write that way.
 */
export function handleShaped(value: string): boolean {
  return value.trimStart().startsWith(HANDLE_PREFIX);
}

const sign = (payload: string): string =>
  createHmac('sha256', handleKey).update(`${HANDLE_PREFIX}${payload}`, 'utf8').digest('base64url').slice(0, SIGNATURE_CHARS);

/**
 * The handle of a message: what it names, and this server's signature over
 * it. One message in one place has exactly one. A Message-ID too long to
 * carry (any sender can write one) is carried as its digest, so that every
 * handle made is one parseLiveHandle takes back.
 */
export function liveHandle(handle: LiveHandle): string {
  const digest = handle.idDigest
    ?? (JSON.stringify(handle.messageId).length > ID_INLINE_MAX ? messageIdDigest(handle.messageId) : undefined);
  const parts = digest
    ? [HANDLE_VERSION, handle.account, handle.folder, handle.uidValidity, handle.uid, '', digest]
    : [HANDLE_VERSION, handle.account, handle.folder, handle.uidValidity, handle.uid, handle.messageId];
  const payload = Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
  return `${HANDLE_PREFIX}${payload}.${sign(payload)}`;
}

/** What a handle says, or undefined when it is not one this server made and signed. */
export function parseLiveHandle(value: string): LiveHandle | undefined {
  const text = value.trim();
  if (!text.startsWith(HANDLE_PREFIX) || text.length > HANDLE_MAX_CHARS) return undefined;
  const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{22})$/.exec(text.slice(HANDLE_PREFIX.length));
  if (!m) return undefined;
  const [, payload, signature] = m as unknown as [string, string, string];
  const expected = Buffer.from(sign(payload));
  if (!timingSafeEqual(expected, Buffer.from(signature))) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || (parsed.length !== 6 && parsed.length !== 7) || parsed[0] !== HANDLE_VERSION) return undefined;
  const [, account, folder, uidValidity, uid, messageId, idDigest] = parsed as unknown[];
  if (typeof account !== 'string' || !account || account.length > 320) return undefined;
  if (typeof folder !== 'string' || !folder || folder.length > 1000) return undefined;
  if (typeof uidValidity !== 'string' || !/^\d{1,20}$/.test(uidValidity)) return undefined;
  if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid <= 0 || uid > 0xffffffff) return undefined;
  if (typeof messageId !== 'string' || JSON.stringify(messageId).length > ID_INLINE_MAX) return undefined;
  if (parsed.length === 7 && (messageId !== '' || typeof idDigest !== 'string' || !new RegExp(`^[A-Za-z0-9_-]{${DIGEST_CHARS}}$`).test(idDigest))) {
    return undefined;
  }
  const handle: LiveHandle = { account, folder, uidValidity, uid, messageId, ...(typeof idDigest === 'string' ? { idDigest } : {}) };
  // Spelled as this server spells it, so that one message has one handle to compare and remember by.
  return liveHandle(handle) === text ? handle : undefined;
}

// ---- Folders ----

export interface MailboxFolder {
  /** Decoded IMAP path; this is the value accepted by mailbox commands. */
  path: string;
  /** The last part of the path, as a person would call the folder. */
  name: string;
  /** The path of the folder it sits in, or null at the top. */
  parent: string | null;
  depth: number;
  delimiter: string;
  flags: string[];
  specialUse: string | null;
  specialUseSource: ListResponse['specialUseSource'] | null;
  /** What it is for, when it is one of the folders every mailbox has. */
  role: FolderRole | null;
  selectable: boolean;
  subscribed: boolean;
  /** How many messages it holds, and how many of them are unread, when the server said cheaply. */
  messages?: number;
  unseen?: number;
}

const ROLE_ORDER: FolderRole[] = ['inbox', 'starred', 'important', 'drafts', 'sent', 'archive', 'all', 'junk', 'trash'];

/** STATUS one folder at a time takes a round trip each; past this, the rest go without counts. */
const STATUS_BUDGET_MS = 4_000;
const STATUS_MAX_FOLDERS = 60;

function folderInfo(entry: ListResponse, provider: string): MailboxFolder {
  const folder = toFolder(entry);
  const delimiter = entry.delimiter || '';
  const parts = delimiter ? entry.path.split(delimiter) : [entry.path];
  const status = (entry as ListResponse & { status?: { messages?: number; unseen?: number } }).status;
  return {
    path: folder.path,
    name: parts.at(-1) || entry.name || entry.path,
    parent: parts.length > 1 ? parts.slice(0, -1).join(delimiter) : null,
    depth: parts.length - 1,
    delimiter: entry.delimiter,
    flags: [...folder.flags].sort(),
    specialUse: entry.specialUse ?? null,
    specialUseSource: entry.specialUseSource ?? null,
    role: folderRole(entry, provider),
    selectable: folder.selectable,
    subscribed: entry.subscribed,
    ...(typeof status?.messages === 'number' ? { messages: status.messages } : {}),
    ...(typeof status?.unseen === 'number' ? { unseen: status.unseen } : {}),
  };
}

/**
 * The folders in the order a mail client lists them: the inbox and the other
 * folders every mailbox has first, wherever the server keeps them (Gmail
 * keeps them under [Gmail]), then the owner's own, each under its parent.
 */
export function orderFolders(folders: MailboxFolder[]): MailboxFolder[] {
  const rank = (folder: MailboxFolder): number => {
    const at = folder.role ? ROLE_ORDER.indexOf(folder.role) : -1;
    return at === -1 ? ROLE_ORDER.length : at;
  };
  // A folder of the owner's own sorts with its parents, so it stays under them.
  const trail = (folder: MailboxFolder): string[] => (folder.delimiter ? folder.path.split(folder.delimiter) : [folder.path])
    .map((part) => part.toLowerCase());
  return [...folders].sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    const ta = trail(a), tb = trail(b);
    for (let i = 0; i < Math.min(ta.length, tb.length); i += 1) {
      const order = ta[i]!.localeCompare(tb[i]!);
      if (order) return order;
    }
    return ta.length - tb.length;
  });
}

/**
 * Every folder of a mailbox, from IMAP LIST, with how many messages each
 * holds and how many are unread when the server says so cheaply: in the LIST
 * itself (LIST-STATUS), or else by STATUS one folder at a time for a few
 * seconds, the rest without counts. Nothing is opened or changed.
 */
export async function mailboxFolders(account: Account, options: { counts?: boolean } = {}): Promise<MailboxFolder[]> {
  return withSession(account, async (client) => {
    let entries: ListResponse[];
    if (options.counts && client.capabilities?.has('LIST-STATUS')) {
      entries = await client.list({ statusQuery: { messages: true, unseen: true } });
    } else {
      entries = await listFolders(client);
      if (options.counts) entries = await withStatus(client, entries, account.provider);
    }
    return orderFolders(entries.map((entry) => folderInfo(entry, account.provider)));
  }, { timeoutMs: 30_000 });
}

async function withStatus(client: ImapFlow, entries: ListResponse[], provider: string): Promise<ListResponse[]> {
  const until = Date.now() + STATUS_BUDGET_MS;
  const out: ListResponse[] = [];
  let asked = 0;
  // In the order the panel shows them, so the budget goes to the inbox and the folders every mailbox has first.
  const shown = orderFolders(entries.map((entry) => folderInfo(entry, provider))).map((folder) => folder.path);
  const ordered = [...entries].sort((a, b) => shown.indexOf(a.path) - shown.indexOf(b.path));
  for (const entry of ordered) {
    const copy = { ...entry } as ListResponse & { status?: unknown };
    if (toFolder(entry).selectable && asked < STATUS_MAX_FOLDERS && Date.now() < until) {
      asked += 1;
      try {
        const status = await client.status(entry.path, { messages: true, unseen: true });
        if (status) copy.status = status;
      } catch (error) {
        log.debug(`STATUS ${entry.path} was refused: ${String(error).slice(0, 120)}`);
      }
    }
    out.push(copy);
  }
  return out;
}

// ---- A folder, a page at a time ----

/** One message as a folder lists it: who, what, when and how it is flagged. No body. */
export interface LiveItem {
  handle: string;
  account: string;
  folder: string;
  uid: number;
  uidValidity: string;
  /** The Message-ID as the server has it; '' when it has none. */
  messageId: string;
  /** The id a stored record of this message carries: its Message-ID, or the one made up for a message without. */
  storedId: string;
  subject: string;
  from: { name: string; address: string };
  to: Array<{ name: string; address: string }>;
  date: string | null;
  size: number | null;
  flags: { seen: boolean; flagged: boolean; answered: boolean };
  /** Whether it carries files, from its structure: a hint, not a list. */
  attachments: boolean;
}

export interface LivePage {
  account: string;
  folder: string;
  uidValidity: string;
  /** How many messages the folder holds now. */
  total: number;
  items: LiveItem[];
  /** Where the next page starts, or null at the oldest. */
  next: string | null;
  /** What was asked of the folder with firstOf: see FirstOf. */
  firstUids?: Record<string, number | null>;
}

/** A stored record's message to look for in a folder: its Message-ID, and the sender it is from. */
export interface FirstAsked {
  id: string;
  sender: string;
  /** The UID the record remembers in this folder, when it has one: while that still carries the id, it is the answer. */
  saved?: number;
}

/**
 * Asked by a listing of the items it lists, under its lock: whose first
 * message in the folder to find. For each, the answer (LivePage.firstUids,
 * under firstKey) is the lowest UID there of a message with that Message-ID
 * from that sender, as the lookup by a record's key finds it; null when the
 * mailbox could not say (no such search, too many answers). The caller may
 * tie a record to a listed message only when that message is this one.
 */
export type FirstOf = (items: LiveItem[]) => FirstAsked[];

/** Where LivePage.firstUids answers one FirstAsked in a folder. */
export function firstKey(folder: string, id: string, sender: string): string {
  return `${folder}\n${id}\n${sender.toLowerCase()}`;
}

/** A Message-ID search answering with more than this (and more than a few per id asked) is not a search for those messages. */
const FIRST_MAX_HITS = 20;
/** How long a mailbox whose header search did not answer is not asked again (QQ's answers nothing). */
const HEADER_BLIND_MS = 6 * 3_600_000;
const headerBlind = new Map<string, number>();

/**
 * The folder now selected: each record's first message from its sender (see
 * FirstOf), for all of a page at once: one search for every Message-ID asked
 * about, one fetch of the envelopes it found, and the rest worked out here.
 * Not asked where a header search is known not to answer: QQ's, or one that
 * missed a message the page itself lists.
 */
async function firstUidsOf(client: ImapFlow, account: Account, folder: string, asked: FirstAsked[]): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {};
  for (const one of asked) out[firstKey(folder, one.id, one.sender)] = null;
  const ids = [...new Set(asked.map((one) => one.id))];
  if (!ids.length || untrustedSearch(account) || (headerBlind.get(account.username) ?? 0) > Date.now()) return out;
  const terms = ids.map((id) => ({ header: { 'message-id': id } }));
  let found: number[] | false | undefined;
  try {
    found = await client.search(terms.length === 1 ? terms[0]! : { or: terms }, { uid: true });
  } catch {
    return out;
  }
  if (!Array.isArray(found) || found.length > Math.max(FIRST_MAX_HITS, ids.length * 4)) return out;
  const lowest = new Map<string, number>();
  const carried = new Set<string>();
  if (found.length) {
    for await (const raw of client.fetch(found, { uid: true, envelope: true }, { uid: true })) {
      const id = raw.envelope?.messageId?.trim() ?? '';
      carried.add(`${id}\n${raw.uid}`);
      const key = firstKey(folder, id, firstAddress(raw.envelope?.from).address);
      if (key in out) lowest.set(key, Math.min(lowest.get(key) ?? raw.uid, raw.uid));
    }
  }
  // Every id asked about is listed in this folder: one the search did not find says its header search does not answer.
  if (ids.some((id) => ![...carried].some((hit) => hit.startsWith(`${id}\n`)))) {
    headerBlind.set(account.username, Date.now() + HEADER_BLIND_MS);
    return out;
  }
  for (const one of asked) {
    const key = firstKey(folder, one.id, one.sender);
    // The UID the record remembers still carries its id: that is its message, as its key finds it.
    out[key] = one.saved !== undefined && carried.has(`${one.id}\n${one.saved}`) ? one.saved : lowest.get(key) ?? null;
  }
  return out;
}

export const LIVE_PAGE_DEFAULT = 50;
export const LIVE_PAGE_MAX = 100;

/** A place in a folder to page on from: the folder's UIDVALIDITY and a UID, as "uidvalidity.uid". */
export function parseFolderCursor(value: string | undefined | null): { uidValidity: string; uid: number } | undefined {
  const m = /^(\d{1,20})\.(\d{1,10})$/.exec((value ?? '').trim());
  if (!m) return undefined;
  const uid = Number(m[2]);
  return uid > 0 ? { uidValidity: m[1]!, uid } : undefined;
}

const LIST_QUERY = { uid: true, envelope: true, flags: true, size: true, bodyStructure: true, internalDate: true } as const;

function people(list: unknown): Array<{ name: string; address: string }> {
  return ((list ?? []) as Array<{ name?: string; address?: string }>)
    .map((p) => ({ name: (p.name ?? '').trim(), address: (p.address ?? '').trim().toLowerCase() }))
    .filter((p) => p.address || p.name)
    .slice(0, 20);
}

function isoDate(value: Date | string | undefined): string | null {
  if (value === undefined) return null;
  const at = new Date(value);
  return Number.isNaN(at.valueOf()) ? null : at.toISOString();
}

export function toLiveItem(raw: FetchMessageObject, account: Account, folder: string, uidValidity: string): LiveItem {
  const envelope = raw.envelope;
  const messageId = envelope?.messageId?.trim() ?? '';
  const from = firstAddress(envelope?.from);
  const flags = raw.flags ?? new Set<string>();
  let attachments = false;
  try {
    const manifest = extractAttachmentManifest(raw.bodyStructure);
    attachments = manifest.items.some((item) => !item.inline) || manifest.truncated;
  } catch {
    // A structure that cannot be read says nothing either way.
  }
  return {
    handle: liveHandle({ account: account.username, folder, uidValidity, uid: raw.uid, messageId }),
    account: account.username,
    folder,
    uid: raw.uid,
    uidValidity,
    messageId,
    // As the poller would have stored it, so a stored copy is recognised by it.
    storedId: messageId || fallbackMessageId(account.username, {
      date: normalizeDate(envelope?.date), subject: envelope?.subject ?? '', from: from.address, uid: raw.uid,
    }),
    subject: envelope?.subject?.trim() ?? '',
    from,
    to: people(envelope?.to),
    date: isoDate(envelope?.date) ?? isoDate(raw.internalDate),
    size: typeof raw.size === 'number' ? raw.size : null,
    flags: { seen: flags.has('\\Seen'), flagged: flags.has('\\Flagged'), answered: flags.has('\\Answered') },
    attachments,
  };
}

/**
 * How many messages of the selected folder have a UID below this one. They
 * are its first ones by sequence: a folder's sequence numbers and its UIDs
 * rise together. A page under a UID is then a plain range of sequence
 * numbers, however large the folder.
 */
async function countBelow(client: ImapFlow, uid: number): Promise<number> {
  if (uid <= 1) return 0;
  const at = await client.fetchOne(String(uid), { uid: true }, { uid: true });
  if (at && at.uid === uid && at.seq > 0) return at.seq - 1;
  // That message is gone since: count what is below it.
  const below = await client.search({ uid: `1:${uid - 1}` }, { uid: true });
  if (!Array.isArray(below)) throw new Error('the server would not count the messages of the folder');
  return below.filter((found) => found < uid).length;
}

/**
 * One page of a folder, newest first: the messages under the cursor, or the
 * newest of all without one. Envelopes, flags, sizes and structure only.
 */
export async function browseFolder(
  account: Account, folder: string, options: { before?: string | null; limit?: number; firstOf?: FirstOf } = {},
): Promise<LivePage> {
  const limit = Math.max(1, Math.min(options.limit ?? LIVE_PAGE_DEFAULT, LIVE_PAGE_MAX));
  const cursor = options.before ? parseFolderCursor(options.before) : undefined;
  if (options.before && !cursor) throw new LiveMailError('cursor', 'not a place in a folder');
  return withSession(account, async (client) => {
    const target = exactFolder(await listFolders(client), folder);
    const lock = await client.getMailboxLock(target.path, { readOnly: true });
    try {
      const uidValidity = selectedValidity(client);
      const mailbox = client.mailbox;
      const total = typeof mailbox === 'object' && mailbox ? Number(mailbox.exists ?? 0) : 0;
      if (cursor && cursor.uidValidity !== uidValidity) {
        throw new LiveMailError('cursor', 'the folder was rebuilt since it was listed; list it again from the top');
      }
      const top = cursor ? await countBelow(client, cursor.uid) : total;
      if (top <= 0) return { account: account.username, folder: target.path, uidValidity, total, items: [], next: null };
      const from = Math.max(1, top - limit + 1);
      const raws: FetchMessageObject[] = [];
      for await (const raw of client.fetch(`${from}:${top}`, LIST_QUERY)) raws.push(raw);
      const items = raws
        .filter((raw) => !cursor || raw.uid < cursor.uid)
        .map((raw) => toLiveItem(raw, account, target.path, uidValidity))
        .sort((a, b) => b.uid - a.uid);
      const oldest = items.at(-1);
      // Asked while the folder is still held, so what is found is the folder as it was listed.
      const firstUids = options.firstOf ? await firstUidsOf(client, account, target.path, options.firstOf(items)) : undefined;
      return {
        account: account.username, folder: target.path, uidValidity, total, items,
        next: from > 1 && oldest ? `${uidValidity}.${oldest.uid}` : null,
        ...(firstUids ? { firstUids } : {}),
      };
    } finally {
      lock.release();
    }
  }, { timeoutMs: 30_000 });
}

// ---- Searching the mailbox ----

/** How long a search may take on the mailbox, under what the page waits for it. */
export const SEARCH_IMAP_MS = 25_000;
let searchImapMs = SEARCH_IMAP_MS;

/** For tests: how long a search may take on the mailbox; null for the usual. */
export function setSearchTimeout(ms: number | null): void {
  searchImapMs = ms ?? SEARCH_IMAP_MS;
}

/**
 * Lists each newest first in its own order, merged by taking the head of
 * whichever list has the newest date, until `limit`: each list gives an
 * unbroken run from its top.
 */
export function mergeNewest(lists: LiveItem[][], limit: number): LiveItem[] {
  const when = (item: LiveItem): number => (item.date ? Date.parse(item.date) : 0) || 0;
  const at = lists.map(() => 0);
  const out: LiveItem[] = [];
  while (out.length < limit) {
    let best = -1;
    for (const [n, list] of lists.entries()) {
      const head = list[at[n]!];
      if (!head) continue;
      if (best === -1 || when(head) > when(lists[best]![at[best]!]!)) best = n;
    }
    if (best === -1) break;
    out.push(lists[best]![at[best]!]!);
    at[best] = at[best]! + 1;
  }
  return out;
}

/** How many of the newest messages of a folder a search that cannot trust the server reads the envelopes of. */
export const SEARCH_SCAN_MESSAGES = 2_000;
const SCAN_BATCH = 500;

/**
 * Why a search was limited to the subject and sender of the newest mail:
 * the provider's own search is known to be unreliable (QQ), the server
 * refused the search, or it found nothing for text outside ASCII, which some
 * servers do not search at all.
 */
export type SearchLimit = 'provider' | 'refused' | 'unicode';

export interface SearchPage {
  account: string;
  query: string;
  /** The folders searched, in the order they were. */
  folders: string[];
  items: LiveItem[];
  /** How many matched in all, across those folders, as far as the search went. */
  total: number;
  next: string | null;
  /** Set when the search read only the subject and sender of each folder's newest messages. */
  limited?: { reason: SearchLimit; scanned: number };
  /** What was asked of each folder with firstOf: see FirstOf. */
  firstUids?: Record<string, number | null>;
}

export class SearchCancelled extends Error {
  constructor() {
    super('a newer search took the place of this one');
    this.name = 'SearchCancelled';
  }
}

/**
 * The mailbox was reached, and took longer to search than a search is given:
 * a slow search (a large archive, a fallback reading thousands of envelopes),
 * not a provider that is down. Said as that, with the way to make it quicker.
 */
export class SearchTimedOut extends Error {
  constructor() {
    super('the mailbox took too long to search');
    this.name = 'SearchTimedOut';
  }
}

/** QQ's search answers header searches wrongly and some of its accounts ignore anything outside ASCII. */
export function untrustedSearch(account: Account): boolean {
  return account.provider.toLowerCase() === 'qq' || /(^|\.)qq\.com$/i.test(account.host.trim());
}

const isGmail = (account: Account): boolean => account.provider.toLowerCase().startsWith('gmail') || /(^|\.)gmail\.com$/i.test(account.host.trim());

/**
 * Where a search looks when no folder is named: the inbox, and the archive
 * when the mailbox has one. On Gmail, All Mail alone, which holds the inbox
 * already: searching both would find everything there twice.
 */
export function defaultSearchFolders(entries: readonly ListResponse[], account: Account): string[] {
  let archive: string | undefined;
  try {
    archive = resolveActionDestination(entries, 'archive', account.provider).path;
  } catch {
    archive = undefined;
  }
  const inbox = entries.find((entry) => entry.path.toUpperCase() === 'INBOX')?.path ?? 'INBOX';
  if (isGmail(account) && archive) return [archive];
  return archive && archive !== inbox ? [inbox, archive] : [inbox];
}

/** Where each folder of a search got to: its UIDVALIDITY and the lowest UID already shown. */
type SearchCursor = Record<string, [string, number]>;

function parseSearchCursor(value: string | null | undefined): SearchCursor | undefined {
  if (!value) return {};
  if (value.length > 4000 || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const out: SearchCursor = {};
    for (const [folder, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(at) || typeof at[0] !== 'string' || typeof at[1] !== 'number' || !(at[1] > 0)) return undefined;
      out[folder] = [at[0], at[1]];
    }
    return out;
  } catch {
    return undefined;
  }
}

const encodeSearchCursor = (cursor: SearchCursor): string => Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

/** Text compared as a person would: case, width and composed forms set aside. */
const fold = (value: string): string => value.normalize('NFKC').toLowerCase();

/** Whether an envelope's subject or sender holds what was asked for. */
export function envelopeMatches(item: Pick<LiveItem, 'subject' | 'from'>, query: string): boolean {
  const asked = fold(query).trim();
  if (!asked) return false;
  const words = asked.split(/\s+/).filter(Boolean);
  const said = fold(`${item.subject}\n${item.from.name}\n${item.from.address}`);
  return words.every((word) => said.includes(word));
}

/** A scan just made, kept a minute so that "more" does not read the same envelopes again. */
const scans = new Map<string, { at: number; items: LiveItem[] }>();
const SCAN_TTL_MS = 60_000;

function rememberScan(key: string, items: LiveItem[]): void {
  scans.delete(key);
  scans.set(key, { at: Date.now(), items });
  while (scans.size > 8) scans.delete(scans.keys().next().value!);
}

/** For tests: no scan remembered. */
export function forgetScans(): void {
  scans.clear();
  headerBlind.clear();
}

/**
 * The newest messages of the selected folder whose subject or sender holds
 * the query, read envelope by envelope: what a search comes to when the
 * server's own cannot be trusted. Bounded to SEARCH_SCAN_MESSAGES.
 */
async function scanFolder(
  client: ImapFlow, account: Account, folder: string, uidValidity: string, query: string, signal?: AbortSignal,
): Promise<{ items: LiveItem[]; scanned: number }> {
  const mailbox = client.mailbox;
  const exists = typeof mailbox === 'object' && mailbox ? Number(mailbox.exists ?? 0) : 0;
  const key = [account.username, folder, uidValidity, exists, fold(query)].join('\u0001');
  const known = scans.get(key);
  const scanned = Math.min(exists, SEARCH_SCAN_MESSAGES);
  if (known && Date.now() - known.at < SCAN_TTL_MS) return { items: known.items, scanned };
  const items: LiveItem[] = [];
  const first = Math.max(1, exists - SEARCH_SCAN_MESSAGES + 1);
  for (let top = exists; top >= first; top -= SCAN_BATCH) {
    if (signal?.aborted) throw new SearchCancelled();
    const bottom = Math.max(first, top - SCAN_BATCH + 1);
    for await (const raw of client.fetch(`${bottom}:${top}`, LIST_QUERY)) {
      const item = toLiveItem(raw, account, folder, uidValidity);
      if (envelopeMatches(item, query)) items.push(item);
    }
  }
  items.sort((a, b) => b.uid - a.uid);
  rememberScan(key, items);
  return { items, scanned };
}

// Anything outside printable ASCII is text some servers do not search.
// eslint-disable-next-line no-control-regex
const nonAscii = (value: string): boolean => /[^\x20-\x7e]/.test(value);

/**
 * Search a mailbox, newest first, a page at a time.
 *
 * Gmail is asked in its own query language (X-GM-RAW), so what works in its
 * search box works here. Elsewhere the subject, the sender and the body are
 * searched (in UTF-8 where the text needs it). Where the server's search
 * cannot be trusted (QQ), refuses, or finds nothing for text outside ASCII,
 * the newest messages are read envelope by envelope instead and only their
 * subject and sender compared: `limited` says so, and the answer must never
 * be passed off as a full search.
 *
 * `signal` stops it between one request to the server and the next: a newer
 * search from the same page takes this one's place.
 */
export async function searchMailbox(
  account: Account,
  options: { query: string; folder?: string | null; before?: string | null; limit?: number; signal?: AbortSignal; firstOf?: FirstOf },
): Promise<SearchPage> {
  const query = options.query.trim();
  const limit = Math.max(1, Math.min(options.limit ?? LIVE_PAGE_DEFAULT, LIVE_PAGE_MAX));
  const cursor = parseSearchCursor(options.before);
  if (!cursor) throw new LiveMailError('cursor', 'not a place in a search');
  const check = (): void => { if (options.signal?.aborted) throw new SearchCancelled(); };
  // On a connection of its own: a slow search, or one given up on, never holds up reading the mailbox.
  return withOwnConnection(account, async (client) => {
    check();
    const entries = await listFolders(client);
    const folders = options.folder ? [exactFolder(entries, options.folder).path] : defaultSearchFolders(entries, account);
    const found: Array<{ folder: string; uidValidity: string; hits: number[]; items: LiveItem[] }> = [];
    const firstUids: Record<string, number | null> = {};
    // Asked of each folder while it is held (see FirstOf).
    const askFirst = async (folder: string, items: LiveItem[]): Promise<void> => {
      if (options.firstOf) Object.assign(firstUids, await firstUidsOf(client, account, folder, options.firstOf(items)));
    };
    let limited: SearchPage['limited'];
    let total = 0;
    for (const path of folders) {
      check();
      const target = exactFolder(entries, path);
      const lock = await client.getMailboxLock(target.path, { readOnly: true });
      try {
        const uidValidity = selectedValidity(client);
        const at = cursor[target.path];
        if (at && at[0] !== uidValidity) {
          throw new LiveMailError('cursor', 'a folder was rebuilt since the search began; search again');
        }
        const below = (uid: number): boolean => !at || uid < at[1];
        let scanned: Awaited<ReturnType<typeof scanFolder>> | undefined;
        let reason: SearchLimit | undefined = untrustedSearch(account) ? 'provider' : undefined;
        let hits: number[] = [];
        if (!reason) {
          const criteria = isGmail(account) ? { gmraw: query } : { or: [{ subject: query }, { from: query }, { body: query }] };
          const answer = await client.search(criteria, { uid: true });
          check();
          if (answer === false) reason = 'refused';
          else {
            hits = Array.isArray(answer) ? answer : [];
            if (!hits.length && nonAscii(query)) reason = 'unicode';
          }
        }
        if (reason) {
          scanned = await scanFolder(client, account, target.path, uidValidity, query, options.signal);
          limited = { reason: limited?.reason ?? reason, scanned: Math.max(limited?.scanned ?? 0, scanned.scanned) };
          const items = scanned.items.filter((item) => below(item.uid));
          total += items.length;
          found.push({ folder: target.path, uidValidity, hits: items.map((item) => item.uid), items: items.slice(0, limit) });
          await askFirst(target.path, items.slice(0, limit));
          continue;
        }
        const shown = [...new Set(hits)].filter(below).sort((a, b) => b - a);
        total += shown.length;
        const wanted = shown.slice(0, limit);
        const items: LiveItem[] = [];
        if (wanted.length) {
          for await (const raw of client.fetch(wanted, LIST_QUERY, { uid: true })) {
            items.push(toLiveItem(raw, account, target.path, uidValidity));
          }
        }
        // Highest UID first, as the merge takes them, whatever order the server answered in.
        items.sort((a, b) => b.uid - a.uid);
        found.push({ folder: target.path, uidValidity, hits: shown, items });
        await askFirst(target.path, items);
      } finally {
        lock.release();
      }
    }
    // Newest first across the folders: each folder gives its hits in its own order, highest UID first,
    // and the page takes from whichever folder's next hit is the newest. So each folder gives an
    // unbroken run from the top, and the next page starts below the last one it gave: nothing is
    // passed over, whatever the dates say (an archive's UIDs follow when mail was archived, not sent).
    const merged = mergeNewest(found.map((entry) => entry.items), limit);
    const next: SearchCursor = { ...cursor };
    let more = false;
    for (const entry of found) {
      const mine = merged.filter((item) => item.folder === entry.folder);
      const lowest = mine.length ? Math.min(...mine.map((item) => item.uid)) : undefined;
      if (lowest !== undefined) next[entry.folder] = [entry.uidValidity, lowest];
      const left = lowest === undefined ? entry.hits.length : entry.hits.filter((uid) => uid < lowest).length;
      if (left > 0) more = true;
    }
    return {
      account: account.username, query, folders, items: merged, total,
      next: more ? encodeSearchCursor(next) : null,
      ...(limited ? { limited } : {}),
      ...(options.firstOf ? { firstUids } : {}),
    };
  }, { timeoutMs: searchImapMs, signal: options.signal, late: () => new SearchTimedOut() }).catch((error: unknown) => {
    // Stopped by a newer search, or given up on: said as that, whatever the closed connection said.
    if (options.signal?.aborted) throw new SearchCancelled();
    throw error;
  });
}
