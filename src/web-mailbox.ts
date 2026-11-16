/**
 * The whole mailbox in the page, and through MCP: any folder, a page at a
 * time, and a search in it, read live from IMAP.
 *
 * What triage stored is the rest of the view. This is the mailbox around it:
 * nothing here is stored, judged, queued or sent to the model. A message
 * listed here that mailsift did store is shown with what it stored (its key,
 * how it was judged, whether it was dealt with), so that marking it done or
 * putting it off from a folder is the same as doing it from the triaged list.
 *
 * The page and MCP share these cores, as they share the ones in
 * web-actions.ts: what the page can read, a caller holding a token can read.
 */
import type { IncomingMessage } from 'node:http';
import type { Account } from './config.js';
import { LiveMailError } from './imap/client.js';
import { SearchCancelled, LIVE_PAGE_MAX, type LiveItem } from './imap/mailbox.js';
import type { MailRow, StateStore } from './services/state.js';
import { configuredAccounts, mailboxFailure, type ActionContext } from './web-actions.js';
import { json, text, timedOut, within, type WebResponse } from './web-http.js';

/** As long as the page waits for a message; a folder or a search of one is the same kind of request. */
const BROWSE_TIMEOUT_MS = 25_000;
/** A search that reads envelopes one by one (QQ) can take a while; past this the page is told, and the work stopped. */
const SEARCH_TIMEOUT_MS = 30_000;
const QUERY_MAX_CHARS = 300;

/** What a stored record adds to a message listed live. */
function storedPart(row: MailRow): Record<string, unknown> {
  return {
    key: row.dedupKey,
    stored: {
      importance: row.importance, category: row.category, summary: row.summary, deadline: row.deadline,
      pushed: row.pushed, withheld: row.withheld, handledAt: row.handledAt, snoozedUntil: row.snoozedUntil,
    },
  };
}

/**
 * Messages listed live as they are given out: what the mailbox says of each,
 * its handle, and, when the same mailbox has a stored record with its
 * Message-ID, that record's key and how it was judged and dealt with.
 */
export function withStored(items: LiveItem[], store: StateStore, ctx: ActionContext, account: string): Array<Record<string, unknown>> {
  let stored = new Map<string, MailRow>();
  try {
    stored = store.storedFor(account, items.map((item) => item.storedId));
  } catch {
    // Without the store the list is still the mailbox's; it just says nothing of what was judged.
  }
  return items.map((item) => {
    const row = stored.get(item.storedId);
    // The provider's own link to the message, as a stored row carries one, where the caller is shown links.
    const linked = ctx.origin === 'mcp' || !item.messageId ? {} : ctx.decorate({
      dedupKey: item.handle, messageId: item.messageId, account, threadKey: null, accountLabel: null, subject: null, sender: null,
      senderName: null, folder: item.folder, inSpam: false, importance: null, category: null, summary: null, reason: null,
      deadline: null, decidedBy: null, pushed: false, withheld: false, mailDate: null, createdAt: '', handledAt: null, snoozedUntil: null,
    });
    return {
      handle: item.handle, folder: item.folder, uid: item.uid, messageId: item.messageId,
      from: item.from, to: item.to, subject: item.subject, date: item.date, size: item.size,
      flags: item.flags, attachments: item.attachments,
      ...('link' in linked ? { link: linked['link'], provider: linked['provider'] } : {}),
      ...(row ? storedPart(row) : {}),
    };
  });
}

function accountNamed(address: string): Account | undefined {
  return configuredAccounts().find((candidate) => candidate.username === address);
}

const unconfigured = (): WebResponse => json(409, { error: 'this mailbox is not configured', code: 'unconfigured' });

function limitOf(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), LIVE_PAGE_MAX) : undefined;
}

/** A failure of a live listing in the words the page has for it. */
function listingFailure(error: unknown, what: string): WebResponse {
  if (error instanceof LiveMailError && error.code === 'folder') {
    return json(404, { error: 'there is no such folder in this mailbox', code: 'noFolder' });
  }
  if (error instanceof LiveMailError) {
    return json(409, { error: 'the folder changed since it was listed; list it again from the top', code: 'liveCursor' });
  }
  return mailboxFailure(error, 'liveFailed', what);
}

/** A mailbox's folders, with their counts where the server gave them cheaply. `asked`: account. */
export async function folderList(asked: { account: string }, store: StateStore, ctx: ActionContext): Promise<WebResponse> {
  const account = accountNamed(asked.account);
  if (!account) return unconfigured();
  try {
    const folders = await within(ctx.backend.folders(account), BROWSE_TIMEOUT_MS);
    if (timedOut(folders)) return json(504, { error: 'the mailbox did not list its folders in time', code: 'timeout' });
    if (ctx.origin !== 'mcp') store.recordMcpAudit('web:folders', ctx.client, true, account.username);
    return json(200, { account: account.username, name: account.name, folders });
  } catch (error) {
    if (ctx.origin !== 'mcp') store.recordMcpAudit('web:folders', ctx.client, false, account.username);
    return listingFailure(error, 'the folders could not be listed');
  }
}

/** One page of a folder, newest first. `asked`: account, folder, and before (the last page's `next`) and limit. */
export async function folderPage(
  asked: { account: string; folder: string; before?: string | null; limit?: unknown }, store: StateStore, ctx: ActionContext,
): Promise<WebResponse> {
  const account = accountNamed(asked.account);
  if (!account) return unconfigured();
  if (!asked.folder) return json(400, { error: 'folder is required', code: 'badRequest' });
  const limit = limitOf(asked.limit);
  try {
    const page = await within(ctx.backend.browse(account, asked.folder, {
      ...(asked.before ? { before: asked.before } : {}), ...(limit ? { limit } : {}),
    }), BROWSE_TIMEOUT_MS);
    if (timedOut(page)) return json(504, { error: 'the mailbox did not list this folder in time', code: 'timeout' });
    if (ctx.origin !== 'mcp') store.recordMcpAudit('web:folder', ctx.client, true, `${account.username}|${asked.folder}`.slice(0, 500));
    return json(200, {
      account: account.username, folder: page.folder, total: page.total, next: page.next,
      items: withStored(page.items, store, ctx, account.username),
    });
  } catch (error) {
    if (ctx.origin !== 'mcp') store.recordMcpAudit('web:folder', ctx.client, false, `${account.username}|${asked.folder}`.slice(0, 500));
    return listingFailure(error, 'the folder could not be listed');
  }
}

/**
 * Searches from the page under way, one per page and mailbox: a newer one
 * takes the place of the one before, which stops at its next request to the server.
 */
const searches = new Map<string, AbortController>();

/**
 * A search of the mailbox, newest first. `asked`: account, q, and folder
 * (default: the inbox and the archive), before and limit. `limited` in the
 * answer says the search read only the subject and sender of recent mail.
 */
export async function mailboxSearch(
  asked: { account: string; q: string; folder?: string | null; before?: string | null; limit?: unknown },
  store: StateStore, ctx: ActionContext,
): Promise<WebResponse> {
  const account = accountNamed(asked.account);
  if (!account) return unconfigured();
  const query = asked.q.trim();
  if (!query) return json(400, { error: 'q is required', code: 'badRequest' });
  if (query.length > QUERY_MAX_CHARS) return json(400, { error: `a search is at most ${QUERY_MAX_CHARS} characters`, code: 'badRequest' });
  const limit = limitOf(asked.limit);
  const controller = new AbortController();
  // Only the page supersedes its own searches; two from an MCP client may be meant to run side by side.
  const slot = ctx.origin === 'mcp' ? '' : `${ctx.client}|${account.username}`;
  if (slot) {
    searches.get(slot)?.abort();
    searches.set(slot, controller);
  }
  const audit = (ok: boolean): void => {
    // Which mailbox and folder were searched, never what for.
    if (ctx.origin !== 'mcp') store.recordMcpAudit('web:search', ctx.client, ok, `${account.username}|${asked.folder ?? ''}`.slice(0, 500));
  };
  try {
    const page = await within(ctx.backend.search(account, {
      query, signal: controller.signal,
      ...(asked.folder ? { folder: asked.folder } : {}), ...(asked.before ? { before: asked.before } : {}), ...(limit ? { limit } : {}),
    }), SEARCH_TIMEOUT_MS);
    if (timedOut(page)) {
      controller.abort();
      audit(false);
      return json(504, { error: 'the mailbox did not answer the search in time', code: 'searchTimeout' });
    }
    audit(true);
    return json(200, {
      account: account.username, query: page.query, folders: page.folders, total: page.total, next: page.next,
      ...(page.limited ? { limited: page.limited } : {}),
      items: withStored(page.items, store, ctx, account.username),
    });
  } catch (error) {
    if (error instanceof SearchCancelled) return json(409, { error: 'a newer search took the place of this one', code: 'superseded' });
    audit(false);
    return listingFailure(error, 'the search failed');
  } finally {
    if (slot && searches.get(slot) === controller) searches.delete(slot);
  }
}

/**
 * Answer one of this file's routes, or undefined when the path is not one.
 * Reading a folder is reading mail: any session may.
 */
export async function routeMailbox(
  req: IncomingMessage, url: URL, store: StateStore, ctx: ActionContext,
): Promise<WebResponse | undefined> {
  const path = url.pathname;
  const p = url.searchParams;
  const answer = await (async (): Promise<WebResponse | undefined> => {
    if (req.method !== 'GET') return undefined;
    if (path === '/api/folders') return folderList({ account: text(p.get('account'), 320) }, store, ctx);
    if (path === '/api/folder') {
      return folderPage({
        account: text(p.get('account'), 320), folder: text(p.get('folder'), 1000), before: p.get('before'), limit: p.get('limit'),
      }, store, ctx);
    }
    if (path === '/api/search') {
      return mailboxSearch({
        account: text(p.get('account'), 320), q: text(p.get('q'), 1000), folder: p.get('folder'),
        before: p.get('before'), limit: p.get('limit'),
      }, store, ctx);
    }
    return undefined;
  })();
  if (answer) answer.cacheControl = 'no-store';
  return answer;
}
