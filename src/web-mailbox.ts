/**
 * The whole mailbox in the page, and through MCP: any folder, a page at a
 * time, and a search in it, read live from IMAP; and one action on many
 * messages at once.
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
import { LiveMailError, MAIL_ACTIONS, MailActionError, type BulkTarget, type WebMailAction } from './imap/client.js';
import {
  firstKey, SearchCancelled, SearchTimedOut, LIVE_PAGE_MAX, useHandleKey, type FirstAsked, type FirstOf, type LiveItem,
} from './imap/mailbox.js';
import type { MailRow, StateStore } from './services/state.js';
import { getLogger } from './logger.js';
import {
  configuredAccounts, fileBeforeMoving, keepBooks, mailAudit, mailboxFailure, newlyMuted, quietly, readOnly, record, recordOf, resolveTarget,
  snoozeTime,
  type ActionContext, type Life, type MailTarget,
} from './web-actions.js';
import { json, readJson, text, timedOut, within, type WebResponse } from './web-http.js';

const log = getLogger('web');

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
export function withStored(
  items: LiveItem[], store: StateStore, ctx: ActionContext, account: string, firstUids?: Record<string, number | null>,
): Array<Record<string, unknown>> {
  let stored = new Map<string, MailRow>();
  try {
    stored = store.storedFor(account, items.map((item) => item.storedId));
  } catch {
    // Without the store the list is still the mailbox's; it just says nothing of what was judged.
  }
  return items.map((item) => {
    // Only the record's own message, at the record's own place: a copy or a spoof that shares its Message-ID is not it.
    let row: MailRow | undefined;
    try {
      // A record with no place is tied only to its first message from its sender, as the mailbox said (see recordOf).
      const first = firstUids?.[firstKey(item.folder, item.messageId, item.from.address)] ?? null;
      row = recordOf(store, account, {
        id: item.storedId, folder: item.folder, uid: item.uid, uidValidity: item.uidValidity, sender: item.from.address, first,
      }, stored.get(item.storedId) ?? null);
    } catch {
      // As above: the list without what was judged.
    }
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

/**
 * What a listing asks the mailbox under its lock (see FirstOf): for each
 * listed message that could be a stored record with no remembered place
 * there (its Message-ID, in the record's folder, from the record's sender),
 * which message in the folder is that record's first.
 */
function firstOfFor(store: StateStore, account: string): FirstOf {
  return (items) => {
    const asked: FirstAsked[] = [];
    try {
      const stored = store.storedFor(account, items.map((item) => item.messageId));
      for (const item of items) {
        const row = item.messageId ? stored.get(item.messageId) : undefined;
        if (!row || row.folder !== item.folder || !row.sender) continue;
        if (item.from.address.toLowerCase() !== row.sender.toLowerCase()) continue;
        const at = store.placeOf(row.dedupKey);
        if (at && at.uidValidity === item.uidValidity && at.uid === item.uid) continue;
        // Remembered elsewhere in this folder: asked too, since that UID may no longer carry it (see FirstAsked.saved).
        asked.push({ id: item.messageId, sender: row.sender.toLowerCase(), ...(at && at.uidValidity === item.uidValidity ? { saved: at.uid } : {}) });
      }
    } catch {
      // Nothing asked: nothing tied that has no place.
    }
    return asked;
  };
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
  useHandleKey(store);
  const limit = limitOf(asked.limit);
  try {
    const page = await within(ctx.backend.browse(account, asked.folder, {
      ...(asked.before ? { before: asked.before } : {}), ...(limit ? { limit } : {}), firstOf: firstOfFor(store, account.username),
    }), BROWSE_TIMEOUT_MS);
    if (timedOut(page)) return json(504, { error: 'the mailbox did not list this folder in time', code: 'timeout' });
    if (ctx.origin !== 'mcp') store.recordMcpAudit('web:folder', ctx.client, true, `${account.username}|${asked.folder}`.slice(0, 500));
    return json(200, {
      account: account.username, folder: page.folder, total: page.total, next: page.next,
      items: withStored(page.items, store, ctx, account.username, page.firstUids),
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
  asked: { account: string; q: string; folder?: string | null; before?: string | null; limit?: unknown; tab?: string | null },
  store: StateStore, ctx: ActionContext, dropped?: AbortSignal,
): Promise<WebResponse> {
  const account = accountNamed(asked.account);
  if (!account) return unconfigured();
  const query = asked.q.trim();
  if (!query) return json(400, { error: 'q is required', code: 'badRequest' });
  useHandleKey(store);
  if (query.length > QUERY_MAX_CHARS) return json(400, { error: `a search is at most ${QUERY_MAX_CHARS} characters`, code: 'badRequest' });
  const limit = limitOf(asked.limit);
  const controller = new AbortController();
  // The browser gave up on the request: the search stops, and its connection with it.
  if (dropped) {
    if (dropped.aborted) controller.abort();
    else dropped.addEventListener('abort', () => controller.abort(), { once: true });
  }
  // Only a page supersedes its own searches, one tab at a time (two tabs on one address do not stop
  // each other's); two from an MCP client may be meant to run side by side.
  const tab = /^[A-Za-z0-9_-]{6,40}$/.test(asked.tab ?? '') ? asked.tab : 'page';
  const slot = ctx.origin === 'mcp' ? '' : `${ctx.client}|${tab}|${account.username}`;
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
      query, signal: controller.signal, firstOf: firstOfFor(store, account.username),
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
      items: withStored(page.items, store, ctx, account.username, page.firstUids),
    });
  } catch (error) {
    if (error instanceof SearchCancelled) return json(409, { error: 'a newer search took the place of this one', code: 'superseded' });
    audit(false);
    // Reached, and slow: not a provider that is down, and said with the way to make it quicker.
    if (error instanceof SearchTimedOut) return json(504, { error: 'the mailbox did not answer the search in time', code: 'searchTimeout' });
    return listingFailure(error, 'the search failed');
  } finally {
    if (slot && searches.get(slot) === controller) searches.delete(slot);
  }
}

// ---- Many messages at once ----

/** A selection is what a person picks from a list, not a sweep of a mailbox. */
export const BULK_MAX = 100;
/** The queue's own: only a message mailsift stored has a place in it. */
const QUEUE_ACTIONS = new Set(['done', 'not_done', 'snooze']);
const BULK_ACTIONS = new Set<string>([...QUEUE_ACTIONS, ...MAIL_ACTIONS]);
export type BulkAction = 'done' | 'not_done' | 'snooze' | WebMailAction;

/**
 * What became of one message of a batch. A skipped one is one the action
 * does not apply to; nothing was done to it. A pending one was still under
 * way when the answer went: what it comes to is recorded when it does.
 */
interface BulkResult {
  key: string;
  status: 'done' | 'skipped' | 'failed' | 'pending';
  code?: string;
  error?: string;
  row?: Record<string, unknown>;
  moved?: { folder: string; handle?: string };
}

/**
 * Batches asked for by name, so that a second press of the same button, or
 * a request repeated after a dropped answer, is given the first one's
 * outcome rather than acting again.
 */
const BULK_MEMORY_MS = 10 * 60_000;
const bulkJobs = new Map<string, { at: number; outcome: Promise<WebResponse> }>();

let bulkWaitFor: number | null = null;

/** For tests: no batch remembered, and batches waited for as long as usual. */
export function forgetBulk(): void {
  bulkJobs.clear();
  bulkWaitFor = null;
}

/** For tests: how long any batch is waited for before it is answered, in milliseconds. */
export function waitForBatches(ms: number): void {
  bulkWaitFor = ms;
}

/** How long a batch is waited for: a mailbox action's time, and a little more for each message. */
const bulkWait = (count: number): number => bulkWaitFor ?? 30_000 + count * 1_500;

/** A refusal of one message's name, as its result. */
function refusedResult(key: string, answer: WebResponse): BulkResult {
  let said: Record<string, unknown> = {};
  try { said = JSON.parse(String(answer.body)) as Record<string, unknown>; } catch { /* not JSON */ }
  return { key, status: 'failed', code: String(said['code'] ?? 'failed'), error: String(said['error'] ?? 'refused') };
}

/** A mailbox's refusal of one message of a batch: skipped when the action does not apply to it, failed otherwise. */
function outcomeResult(key: string, error: unknown): BulkResult {
  if (error instanceof LiveMailError) {
    return { key, status: 'failed', code: 'liveStale', error: 'the message is no longer where its folder listed it' };
  }
  if (error instanceof MailActionError && error.code === 'not_applicable') return { key, status: 'skipped', code: 'notApplicable', error: error.message };
  if (error instanceof MailActionError && /already in the destination/.test(error.message)) {
    return { key, status: 'skipped', code: 'alreadyThere', error: error.message };
  }
  if (error instanceof MailActionError) return { key, status: 'failed', code: `action_${error.code}`, error: error.message };
  return { key, status: 'failed', code: 'actionFailed', error: String(error).slice(0, 200) };
}

/**
 * One action on many messages. `body`: items (keys of stored messages or
 * live handles, at most 100), action (done, not_done, snooze, or one of the
 * mailbox actions: mark_read, mark_unread, star, unstar, archive, trash,
 * inbox, move, spam, not_spam), destination for a move, until for snooze
 * (as /api/snooze takes it), and id, a name for this batch under which
 * asking again gives the first answer instead of acting twice.
 *
 * Each message is checked as it would be alone, and has a result of its own.
 * The mailbox is reached over one connection per mailbox. Done, not done and
 * snooze apply only to messages mailsift stored; a message an action does
 * not apply to is skipped, not failed. Each is audited as one action alone is.
 */
export async function bulkAct(
  body: Record<string, unknown> | undefined, store: StateStore, ctx: ActionContext, life: Life,
): Promise<WebResponse> {
  const action = text(body?.['action'], 40);
  if (!BULK_ACTIONS.has(action)) return json(400, { error: 'a supported action is required', code: 'badRequest' });
  const queue = QUEUE_ACTIONS.has(action);
  if (queue ? !ctx.mayMark : ctx.session !== 'write') return readOnly();
  const given = body?.['items'];
  if (!Array.isArray(given) || !given.length) return json(400, { error: 'items are required', code: 'badRequest' });
  if (given.length > BULK_MAX) {
    return json(400, { error: `at most ${BULK_MAX} messages at once`, code: 'bulk_too_many', max: BULK_MAX });
  }
  const keys = [...new Set(given.filter((item): item is string => typeof item === 'string').map((item) => item.trim().slice(0, 5000)).filter(Boolean))];
  if (!keys.length) return json(400, { error: 'items are required', code: 'badRequest' });
  const destination = action === 'move' ? text(body?.['destination'], 500) : '';
  if (action === 'move' && !destination) return json(400, { error: 'a move needs a destination folder', code: 'badRequest' });
  let until: string | null | undefined;
  if (action === 'snooze') {
    if (!body || !('until' in body)) return json(400, { error: 'until is required', code: 'badRequest' });
    const asked = body['until'];
    if (asked === 'now' || asked === null) until = asked;
    else {
      const parsed = snoozeTime(asked);
      if ('refused' in parsed) return json(400, { error: parsed.refused, code: parsed.code });
      until = parsed.at;
    }
  }
  const named = text(body?.['id'], 80);
  const id = /^[A-Za-z0-9_-]{8,64}$/.test(named) ? `${ctx.origin ?? 'page'}|${named}` : '';
  if (id) {
    for (const [known, job] of bulkJobs) if (Date.now() - job.at > BULK_MEMORY_MS || bulkJobs.size > 200) bulkJobs.delete(known);
    const earlier = bulkJobs.get(id);
    if (earlier) {
      const answer = await within(earlier.outcome, bulkWait(keys.length));
      if (!timedOut(answer)) return { ...answer };
      return json(504, { error: 'the same batch is still under way', code: 'actionTimeout' });
    }
  }

  const results: BulkResult[] = keys.map((key) => ({ key, status: 'pending', error: 'still under way' }));
  // Spam is a vote; two of one sender's make a rule, which the answer says as the judgement line does.
  let before: { neverImportant: string[] } | undefined;
  if (action === 'spam') { try { before = store.feedbackRuleHints(2); } catch { /* said without it */ } }
  const answer = (): WebResponse => {
    const count = (status: BulkResult['status']): number => results.filter((result) => result.status === status).length;
    let attention: number | undefined;
    let muted: string[] = [];
    try {
      attention = store.attentionCount();
      if (before) muted = newlyMuted(before, store.feedbackRuleHints(2));
    } catch { /* the handle may be closed by now */ }
    return json(200, {
      action, results: results.map((result) => ({ ...result })),
      done: count('done'), skipped: count('skipped'), failed: count('failed'), pending: count('pending'),
      ...(attention !== undefined ? { attention } : {}), ...(muted.length ? { muted } : {}),
    });
  };
  const work = (async (): Promise<WebResponse> => {
    const targets: Array<MailTarget | undefined> = keys.map((key, index) => {
      const resolved = resolveTarget(store, key);
      if ('refused' in resolved) { results[index] = refusedResult(key, resolved.refused); return undefined; }
      return resolved.target;
    });
    if (queue) bulkQueue(action as 'done' | 'not_done' | 'snooze', until, keys, targets, results, store, ctx, life);
    else await bulkMailbox(action as WebMailAction, destination, keys, targets, results, store, ctx, life);
    return answer();
  })();
  if (id) bulkJobs.set(id, { at: Date.now(), outcome: work });
  const done = await within(work.catch((error: unknown) => {
    log.warn(`A batch failed: ${String(error).slice(0, 160)}`);
    return answer();
  }), bulkWait(keys.length));
  // What is not known yet is said as that; it is recorded when the mailbox answers.
  return timedOut(done) ? answer() : done;
}

/** Done, not done and later, for every stored message of a batch; the queue's own books. */
function bulkQueue(
  action: 'done' | 'not_done' | 'snooze', until: string | null | undefined, keys: string[], targets: Array<MailTarget | undefined>,
  results: BulkResult[], store: StateStore, ctx: ActionContext, life: Life,
): void {
  // Done here is done there, as for one message: marked read in its mailbox, in the background.
  const reading = new Map<string, { account: Account; targets: BulkTarget[]; audits: Array<ReturnType<typeof mailAudit>> }>();
  for (const [index, target] of targets.entries()) {
    if (!target) continue;
    const key = keys[index]!;
    const row = target.row;
    if (!row) {
      results[index] = { key, status: 'skipped', code: 'notStored', error: 'mailsift has not stored this message' };
      continue;
    }
    let after: MailRow | undefined;
    let audit: string;
    if (action === 'snooze') {
      // A reminder is for what is not done: one marked done is not brought back by a batch it happened to be in.
      if (row.handledAt && until !== null) {
        results[index] = { key, status: 'skipped', code: 'alreadyDone', row: ctx.decorate(row) };
        continue;
      }
      after = until === 'now' ? store.wakeNow(row.dedupKey) : store.setSnoozed(row.dedupKey, until ?? null);
      audit = until === 'now' ? 'web:wake' : until === null ? 'web:unsnooze' : 'web:snooze';
    } else {
      const handled = action === 'done';
      if (Boolean(row.handledAt) === handled) {
        results[index] = { key, status: 'skipped', code: 'unchanged', row: ctx.decorate(row) };
        continue;
      }
      after = store.setHandled(row.dedupKey, handled);
      audit = handled ? 'web:handled' : 'web:unhandled';
      if (handled && ctx.session === 'write' && (target.messageId || target.handle)) {
        const group = reading.get(target.account.username) ?? { account: target.account, targets: [], audits: [] };
        group.targets.push({ messageId: target.messageId, ...target.place });
        group.audits.push(mailAudit(target, 'mark_read', ctx.client));
        reading.set(target.account.username, group);
      }
    }
    if (!after) {
      results[index] = { key, status: 'failed', code: 'notFound', error: 'not found' };
      continue;
    }
    // Each on record as one alone is: the page's here, an MCP caller's under the tool's name, by the tool, for every id it was asked about.
    if (ctx.origin !== 'mcp') store.recordMcpAudit(audit, ctx.client, true, after.dedupKey);
    results[index] = { key, status: 'done', row: ctx.decorate(after) };
  }
  for (const group of reading.values()) {
    void ctx.backend.bulk(group.account, group.targets, 'mark_read', {}, (index, outcome) => {
      const audit = group.audits[index]!;
      quietly('Marking a handled message read', () => record(ctx, store, life, (db) => db.recordMailAction(
        'done' in outcome ? { ...audit, success: true, sourceFolder: outcome.done.sourceFolder }
          : { ...audit, success: false, error: 'missing' in outcome ? 'not found' : String(outcome.error).slice(0, 300) },
      )));
    }).catch((error: unknown) => log.warn(`Marking handled messages read failed: ${String(error).slice(0, 160)}`));
  }
}

/** A mailbox action on every message of a batch: one connection per mailbox, the mailboxes side by side. */
async function bulkMailbox(
  action: WebMailAction, destination: string, keys: string[], targets: Array<MailTarget | undefined>,
  results: BulkResult[], store: StateStore, ctx: ActionContext, life: Life,
): Promise<void> {
  const groups = new Map<string, { account: Account; indexes: number[] }>();
  for (const [index, target] of targets.entries()) {
    if (!target) continue;
    if (!target.messageId && !target.handle) {
      results[index] = { key: keys[index]!, status: 'failed', code: 'notFound', error: 'not found' };
      continue;
    }
    const group = groups.get(target.account.username) ?? { account: target.account, indexes: [] };
    group.indexes.push(index);
    groups.set(target.account.username, group);
  }
  await Promise.all([...groups.values()].map(async (group) => {
    const audits = group.indexes.map((index) => mailAudit(targets[index]!, action, ctx.client, destination));
    for (const index of group.indexes) fileBeforeMoving(store, targets[index]!, action);
    await ctx.backend.bulk(
      group.account,
      group.indexes.map((index) => ({ messageId: targets[index]!.messageId, ...targets[index]!.place })),
      action, destination ? { destination } : {},
      (at, outcome) => {
        const index = group.indexes[at]!;
        const target = targets[index]!;
        const key = keys[index]!;
        const audit = audits[at]!;
        quietly('One action of a batch', () => record(ctx, store, life, (db) => {
          if ('done' in outcome) {
            const kept = keepBooks(db, target, action, outcome.done, audit);
            results[index] = { key, status: 'done', ...(kept.after ? { row: ctx.decorate(kept.after) } : {}), ...(kept.moved ? { moved: kept.moved } : {}) };
            return;
          }
          if ('missing' in outcome) {
            db.recordMailAction({ ...audit, success: false, error: 'not found' });
            results[index] = { key, status: 'failed', code: 'actionNotFound', error: 'message not found in the mailbox' };
            return;
          }
          db.recordMailAction({ ...audit, success: false, error: String(outcome.error).slice(0, 300) });
          results[index] = outcomeResult(key, outcome.error);
        }));
      },
    );
  }));
}

/**
 * Answer one of this file's routes, or undefined when the path is not one.
 * Reading a folder is reading mail: any session may. Acting on many
 * messages is acting on each: the session must be one that may.
 */
export async function routeMailbox(
  req: IncomingMessage, url: URL, store: StateStore, ctx: ActionContext,
): Promise<WebResponse | undefined> {
  const path = url.pathname;
  const p = url.searchParams;
  // Work a batch starts may outlast its answer; from then on it records on a handle of its own.
  const life: Life = { over: false };
  const answer = await (async (): Promise<WebResponse | undefined> => {
    // A hundred handles, each a few hundred characters.
    if (req.method === 'POST' && path === '/api/bulk') return bulkAct(await readJson(req, 256 * 1024), store, ctx, life);
    if (req.method !== 'GET') return undefined;
    if (path === '/api/folders') return folderList({ account: text(p.get('account'), 320) }, store, ctx);
    if (path === '/api/folder') {
      return folderPage({
        account: text(p.get('account'), 320), folder: text(p.get('folder'), 1000), before: p.get('before'), limit: p.get('limit'),
      }, store, ctx);
    }
    if (path === '/api/search') {
      // A request the browser drops (a closed tab, a search typed over) stops the search it asked for.
      const dropped = new AbortController();
      const drop = (): void => dropped.abort();
      req.socket?.once?.('close', drop);
      try {
        return await mailboxSearch({
          account: text(p.get('account'), 320), q: text(p.get('q'), 1000), folder: p.get('folder'),
          before: p.get('before'), limit: p.get('limit'), tab: p.get('tab'),
        }, store, ctx, dropped.signal);
      } finally {
        req.socket?.off?.('close', drop);
      }
    }
    return undefined;
  })().finally(() => { life.over = true; });
  if (answer) answer.cacheControl = 'no-store';
  return answer;
}
