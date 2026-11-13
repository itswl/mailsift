/**
 * Who gets told what, and when: the bridge from judged mail to Web Push.
 *
 * The dispatcher does not sit in the triage pipeline. It watches the state
 * database for rows that were judged since it last looked and sends each
 * subscribed browser the ones that browser asked for. Three things follow
 * from keeping it outside:
 *
 * - it can never delay or break triage, whatever a push service does;
 * - it works in whichever process serves the web view, the long-running
 *   service or a standalone MCP server beside a cron poller, because all it
 *   needs is the database file;
 * - two such processes do not notify twice: the cursor is moved with a
 *   compare-and-swap before anything is sent, and only the process whose swap
 *   went in sends that batch.
 *
 * Delivery is at most once. A notification that could not be sent is not
 * queued for later: a verification code an hour late is worse than none, and
 * the page still lists everything.
 *
 * Nothing here logs a sender, a subject, a summary or a code.
 */
import { createHash } from 'node:crypto';
import { getLogger } from '../logger.js';
import { VERIFICATION_SUMMARY_PREFIX } from '../imap/message.js';
import { REJUDGED_KEY, StateStore, type MailRow, type PushSubscriptionRow, type RowCursor } from './state.js';
import {
  generateVapidKeys, MAX_PAYLOAD_BYTES, sendPush, type PushSendResult, type VapidKeys,
} from './webpush.js';

const log = getLogger('push');

/** Where the dispatcher has read up to, as JSON `{ createdAt, dedupKey }`. */
export const PUSH_CURSOR_KEY = 'web_push_cursor';
const VAPID_META_KEY = 'web_push_vapid';

const DEFAULT_INTERVAL_MS = 1_500;
/** A code is only worth a notification while it can still be typed in. */
const CODE_FRESH_MS = 15 * 60_000;
/** Other mail is still news for a day; past that it is a backfill, not an arrival. */
const MAIL_FRESH_MS = 24 * 60 * 60_000;
const CODE_TTL_SECONDS = 600;
const MAIL_TTL_SECONDS = 86_400;
/** A catch-up after downtime must not bury a phone: this many, then one line for the rest. */
const MAX_NOTICES_PER_TICK = 4;
/** Rows claimed in one pass; a backlog larger than this waits for the next one. */
const BATCH_ROWS = 50;
const MAX_BATCHES = 4;
/** In a row, with no success between them. The browser re-subscribes when its page next opens. */
const MAX_CONSECUTIVE_FAILURES = 20;
/** Sorts after every dedup key, which all begin with a mailbox address. */
const START_KEY = '\uffff';
const BODY_CHARS = 180;
const TITLE_CHARS = 80;
/** Under the cipher's own limit, with room for whatever a push service adds. */
const PAYLOAD_BUDGET = Math.min(MAX_PAYLOAD_BYTES, 3_000);

/** What the service worker receives and turns into a notification. */
export interface PushNotice {
  kind: 'code' | 'mail' | 'more' | 'test';
  title: string;
  body: string;
  /** Notifications with the same tag replace one another on the device. */
  tag: string;
  /** Where a tap leads, as a path on this origin. */
  url: string;
  /** The message's key, when the notice is about one message. */
  key?: string;
  /** The length of the "needs you" queue, for the app's badge. */
  badge?: number;
}

type Words = Record<
  'code' | 'codeUnread' | 'critical' | 'unknown' | 'more' | 'more1' | 'test', string
>;

// The dispatcher's own few words. The page's table is the browser's; these
// are composed on the server, for a browser that may not be running.
const WORDS: Record<'en' | 'zh', Words> = {
  en: {
    code: '{sender} · verification code',
    codeUnread: 'Verification email · open it for the code',
    critical: 'Critical · {sender}',
    unknown: 'unknown sender',
    more: '{count} more messages need you',
    more1: '1 more message needs you',
    test: 'Notifications are on for this device.',
  },
  zh: {
    code: '{sender} · 验证码',
    codeUnread: '验证码邮件 · 打开查看验证码',
    critical: '紧急 · {sender}',
    unknown: '未知发件人',
    more: '还有 {count} 封邮件待你处理',
    more1: '还有 1 封邮件待你处理',
    test: '这台设备的通知已开启。',
  },
};

const wordsFor = (lang: string): Words => (lang.toLowerCase().startsWith('zh') ? WORDS.zh : WORDS.en);

function readVapid(raw: string | undefined): VapidKeys | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<VapidKeys>;
    if (typeof parsed.publicKey !== 'string' || typeof parsed.privateKey !== 'string') return undefined;
    if (Buffer.from(parsed.publicKey, 'base64url').length !== 65) return undefined;
    // A scalar with leading zero bytes may have been stored without them; it
    // is the same key, so it is widened rather than thrown away. Rejecting it
    // would mint a new identity and orphan every subscription.
    const scalar = Buffer.from(parsed.privateKey, 'base64url');
    if (scalar.length === 0 || scalar.length > 32) return undefined;
    const privateKey = Buffer.concat([Buffer.alloc(32 - scalar.length), scalar]).toString('base64url');
    return { publicKey: parsed.publicKey, privateKey };
  } catch {
    return undefined;
  }
}

/**
 * This server's identity towards push services, minted once and kept.
 *
 * Browsers subscribe against the public half, so it must never change: a new
 * pair silently orphans every subscription. Two processes starting together
 * race for the first write with a compare-and-swap, and the loser reads back
 * the winner's pair instead of keeping its own.
 */
export function vapidKeys(store: StateStore): VapidKeys {
  const raw = store.getMeta(VAPID_META_KEY);
  const existing = readVapid(raw);
  if (existing) return existing;
  const fresh = generateVapidKeys();
  // An unreadable value is replaced: nothing subscribed against it can be served anyway.
  store.casMeta(VAPID_META_KEY, raw, JSON.stringify(fresh));
  return readVapid(store.getMeta(VAPID_META_KEY)) ?? fresh;
}

function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!host.includes('.') || host.includes(':')) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
  return !/(?:^|\.)(?:localhost|local|internal|lan|home\.arpa)$/.test(host);
}

/**
 * The contact a push service is given for this sender (the VAPID `sub`).
 *
 * It has to be a mailto: or https: address, and Apple refuses ones that are
 * plainly not real. WEB_PUSH_SUBJECT wins when set. Otherwise the address the
 * page was served from is the honest answer, when it is a public https name;
 * a loopback or LAN deployment falls back to a placeholder that is at least
 * well formed.
 */
export function pushSubject(origin?: string | null): string {
  const configured = process.env.WEB_PUSH_SUBJECT?.trim();
  if (configured) {
    if (/^mailto:[^\s@]+@[^\s@]+$/i.test(configured) || /^https:\/\/\S+$/i.test(configured)) return configured;
    if (/^[^\s@:]+@[^\s@]+$/.test(configured)) return `mailto:${configured}`;
  }
  if (origin) {
    try {
      const url = new URL(origin);
      if (url.protocol === 'https:' && isPublicHostname(url.hostname)) return url.origin;
    } catch {
      // Not an origin; fall through to the placeholder.
    }
  }
  return 'mailto:mailsift@example.org';
}

/** A verification message, with or without digits that could be extracted. */
function isCodeRow(row: MailRow): boolean {
  return Boolean(row.verificationCode) || Boolean(row.summary?.startsWith(VERIFICATION_SUMMARY_PREFIX));
}

/** How far behind its filing a message's own Date may be before it counts as old mail arriving late. */
const CODE_MAX_LAG_MS = 60 * 60_000;

/**
 * Whether a message is still news: recently filed, and not old mail that
 * only arrived here late.
 *
 * Two clocks, for two questions. How long ago it came is counted from when
 * mailsift filed it, on this server's clock. Whether it was already old when
 * it came is read from its Date header, which is the sender's clock and so is
 * given room: a machine twenty minutes slow must not cost a verification code
 * its notification, while an hour of codes fetched after downtime, or a
 * mailbox being backfilled, should stay quiet.
 */
function stillNews(row: MailRow, now: number, window: number, maxLag: number): boolean {
  const filed = Date.parse(row.createdAt);
  const sent = Date.parse(row.mailDate ?? '');
  if (!Number.isFinite(filed)) return Number.isFinite(sent) && now - sent <= window;
  if (now - filed > window) return false;
  return !Number.isFinite(sent) || filed - sent <= maxLag;
}

/**
 * Whether this browser asked to be told about this row.
 *
 * Verification mail answers only to the codes switch and only while fresh.
 * Everything else goes by level: critical always, warnings when the device
 * chose the wider setting. A digest is a summary of mail already offered, a
 * handled message needs nobody, and mail older than a day is a backfill.
 */
export function wants(sub: PushSubscriptionRow, row: MailRow, now = Date.now()): boolean {
  if (row.handledAt || !row.importance) return false;
  if (isCodeRow(row)) return sub.codes && stillNews(row, now, CODE_FRESH_MS, CODE_MAX_LAG_MS);
  if (row.decidedBy === 'digest') return false;
  const level = row.importance;
  const asked = level === 'critical' || (sub.level === 'warning' && level === 'warning');
  return asked && stillNews(row, now, MAIL_FRESH_MS, MAIL_FRESH_MS);
}

const cut = (text: string, chars: number): string => {
  const points = Array.from(text.replace(/\s+/g, ' ').trim());
  return points.length > chars ? `${points.slice(0, chars - 1).join('').trimEnd()}…` : points.join('');
};

/** Six or eight digits read as two halves, the way the page sets them. */
function groupCode(code: string): string {
  if (/^\d{6}$/.test(code)) return `${code.slice(0, 3)} ${code.slice(3)}`;
  if (/^\d{8}$/.test(code)) return `${code.slice(0, 4)} ${code.slice(4)}`;
  return code;
}

function tagFor(dedupKey: string): string {
  return dedupKey.length <= 64 ? dedupKey : `m-${createHash('sha256').update(dedupKey).digest('hex').slice(0, 32)}`;
}

/**
 * The notification for one row, worded for one device.
 *
 * A code is its own title: the digits are what the lock screen is read for.
 * Other mail leads with who sent it and says what the model's summary says.
 */
export function noticeFor(row: MailRow, lang: string): PushNotice {
  const words = wordsFor(lang);
  const sender = cut(row.senderName || row.sender || words.unknown, TITLE_CHARS);
  if (row.verificationCode) {
    return {
      kind: 'code', title: groupCode(row.verificationCode), body: words.code.replace('{sender}', sender),
      tag: 'code', url: '/?focus=code', key: row.dedupKey,
    };
  }
  if (isCodeRow(row)) {
    // The code is in the message but could not be read out of it.
    return { kind: 'code', title: sender, body: words.codeUnread, tag: 'code', url: '/?focus=code', key: row.dedupKey };
  }
  return {
    kind: 'mail',
    title: row.importance === 'critical' ? words.critical.replace('{sender}', sender) : sender,
    body: cut(row.summary || row.subject || '', BODY_CHARS),
    tag: tagFor(row.dedupKey),
    url: `/#m=${encodeURIComponent(row.dedupKey)}`,
    key: row.dedupKey,
  };
}

const sizeOf = (notice: PushNotice): number => Buffer.byteLength(JSON.stringify(notice), 'utf8');

/**
 * Keep a notice inside what one push message can carry.
 *
 * Characters are not bytes: a Chinese summary is three bytes a character, and
 * a message id can be a kilobyte once it is percent-encoded into the link.
 * The body gives way first, then the link falls back to the page itself.
 */
export function fitNotice(notice: PushNotice): PushNotice {
  let fitted = notice;
  let chars = Array.from(fitted.body).length;
  while (sizeOf(fitted) > PAYLOAD_BUDGET && chars > 20) {
    chars = Math.max(20, Math.floor(chars / 2));
    fitted = { ...fitted, body: cut(fitted.body, chars) };
  }
  if (sizeOf(fitted) > PAYLOAD_BUDGET) {
    const { key: _key, ...rest } = fitted;
    fitted = { ...rest, url: '/', tag: cut(fitted.tag, 64) };
  }
  if (sizeOf(fitted) > PAYLOAD_BUDGET) fitted = { ...fitted, title: cut(fitted.title, 40), body: '' };
  return fitted;
}

function parseCursor(raw: string | undefined): RowCursor | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<RowCursor>;
    if (typeof parsed.createdAt !== 'string' || typeof parsed.dedupKey !== 'string') return undefined;
    return { createdAt: parsed.createdAt, dedupKey: parsed.dedupKey };
  } catch {
    return undefined;
  }
}

/** Codes first, then critical, then the newest: what to send when there is more than a phone should get at once. */
function byUrgency(a: MailRow, b: MailRow): number {
  const rank = (row: MailRow): number => (isCodeRow(row) ? 2 : row.importance === 'critical' ? 1 : 0);
  return rank(b) - rank(a) || b.createdAt.localeCompare(a.createdAt) || b.dedupKey.localeCompare(a.dedupKey);
}

export interface PushDispatcherOptions {
  /** A handle of the dispatcher's own; sharing the writer's would hide the writer's commits from it. */
  openStore?: () => StateStore;
  send?: typeof sendPush;
  intervalMs?: number;
}

export class PushDispatcher {
  private store: StateStore | undefined;
  private timer: NodeJS.Timeout | undefined;
  private version: number | undefined;
  private running = false;
  /** Set by a pass that left the current millisecond's rows unclaimed. */
  private unsettled = false;

  constructor(private readonly options: PushDispatcherOptions = {}) {}

  /** Begin watching. The timer never keeps the process alive on its own. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.closeStore();
  }

  private closeStore(): void {
    try {
      this.store?.close();
    } catch {
      // Already closed; nothing to release.
    }
    this.store = undefined;
    this.version = undefined;
  }

  /**
   * One pass; returns how many notifications were sent.
   *
   * It looks only when another connection has committed since the last pass
   * (the first pass always looks). `force` skips that check, for a caller
   * that writes through the very handle the dispatcher reads with.
   */
  async tick(force = false): Promise<number> {
    // A slow push service must not let passes pile up behind one another.
    if (this.running) return 0;
    this.running = true;
    try {
      const store = this.store ??= (this.options.openStore ?? (() => new StateStore()))();
      const version = store.dataVersion();
      if (!force && this.version !== undefined && version === this.version) return 0;
      this.version = version;
      this.unsettled = false;
      const rows = this.claim(store);
      // Something was left for later: look again next pass even if nothing else commits.
      if (this.unsettled) this.version = undefined;
      // A dry run tells nobody anything: the rows are claimed, so that the
      // run after it does not announce them, and nothing is sent.
      if ((process.env.DRY_RUN ?? '').trim().toLowerCase() === 'true') return 0;
      return rows.length ? await this.deliver(store, rows) : 0;
    } catch (error) {
      log.warn(`Push pass failed: ${String(error).slice(0, 200)}`);
      // The handle may be the thing that broke; the next pass opens a new one.
      this.closeStore();
      return 0;
    } finally {
      this.running = false;
    }
  }

  /**
   * Take the judged rows after the cursor, moving the cursor first.
   *
   * The swap is what makes a row belong to exactly one process. A cursor that
   * does not exist yet starts at this moment and claims nothing, so turning
   * notifications on never replays what is already in the list.
   */
  private claim(store: StateStore): MailRow[] {
    let raw = store.getMeta(PUSH_CURSOR_KEY);
    let cursor = parseCursor(raw);
    if (!cursor) {
      // The key sorts after any real one, so a row filed in this same
      // millisecond counts as already there rather than as an arrival.
      store.casMeta(PUSH_CURSOR_KEY, raw, JSON.stringify({ createdAt: new Date().toISOString(), dedupKey: START_KEY }));
      // Verdicts that changed before anyone was listening are history too.
      this.claimRejudged(store);
      return [];
    }
    // Rows are ordered by the millisecond they were filed in and then by key,
    // and the poller may still be filing into the current millisecond. A row
    // with a smaller key arriving there after the cursor had passed would be
    // skipped for good, so that millisecond is left for the next pass.
    const settled = new Date().toISOString();
    const claimed: MailRow[] = [];
    let more = false;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const found = store.rowsAfter(cursor, BATCH_ROWS);
      const rows = found.filter((row) => row.createdAt < settled);
      if (rows.length < found.length) this.unsettled = true;
      const last = rows.at(-1);
      if (!last) { more = false; break; }
      const next = JSON.stringify({ createdAt: last.createdAt, dedupKey: last.dedupKey });
      // Lost the swap: another process serving the view has these rows.
      if (!store.casMeta(PUSH_CURSOR_KEY, raw, next)) { more = false; break; }
      raw = next;
      cursor = { createdAt: last.createdAt, dedupKey: last.dedupKey };
      claimed.push(...rows);
      more = found.length === BATCH_ROWS;
      if (!more) break;
    }
    // Stopped at the pass's limit with rows still waiting. Moving the cursor
    // is this handle's own write and does not change what it sees as the
    // database's version, so without this the rest would wait for somebody
    // else to commit, and the newest mail sits at the end of a backlog.
    if (more) this.unsettled = true;

    // Rows judged a second time keep their place in the order and are behind
    // the cursor by now; the poller names them and they are taken here.
    const seen = new Set(claimed.map((row) => row.dedupKey));
    for (const row of this.claimRejudged(store)) {
      if (!seen.has(row.dedupKey)) claimed.push(row);
    }
    return claimed;
  }

  /** Take the list of re-judged rows, leaving it empty for whoever looks next. */
  private claimRejudged(store: StateStore): MailRow[] {
    const raw = store.getMeta(REJUDGED_KEY);
    if (!raw || raw === '[]') return [];
    if (!store.casMeta(REJUDGED_KEY, raw, '[]')) return [];
    let keys: unknown;
    try {
      keys = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(keys)) return [];
    const rows: MailRow[] = [];
    for (const key of new Set(keys.filter((key): key is string => typeof key === 'string'))) {
      const row = store.getMail(key);
      if (row) rows.push(row);
    }
    return rows;
  }

  private async deliver(store: StateStore, rows: MailRow[]): Promise<number> {
    const subscriptions = store.listPushSubscriptions();
    if (subscriptions.length === 0) return 0;
    const keys = vapidKeys(store);
    const send = this.options.send ?? sendPush;
    const now = Date.now();
    const badge = store.attentionCount();

    const counts = await Promise.all(subscriptions.map(async (sub) => {
      const wanted = rows.filter((row) => wants(sub, row, now)).sort(byUrgency);
      if (wanted.length === 0) return 0;
      const words = wordsFor(sub.lang);
      const notices: Array<{ notice: PushNotice; ttl: number }> = wanted.slice(0, MAX_NOTICES_PER_TICK).map((row) => {
        const notice = noticeFor(row, sub.lang);
        return { notice, ttl: notice.kind === 'code' ? CODE_TTL_SECONDS : MAIL_TTL_SECONDS };
      });
      const rest = wanted.length - notices.length;
      if (rest > 0) {
        notices.push({
          notice: {
            kind: 'more', title: 'mailsift',
            body: rest === 1 ? words.more1 : words.more.replace('{count}', String(rest)),
            tag: 'more', url: '/',
          },
          ttl: MAIL_TTL_SECONDS,
        });
      }

      let sent = 0;
      for (const { notice, ttl } of notices) {
        const result = await send(
          { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
          fitNotice({ ...notice, badge }),
          keys,
          { ttl, urgency: 'high', subject: pushSubject(sub.origin) },
        );
        if (result === 'sent') {
          store.recordPushResult(sub.endpoint, true);
          sent += 1;
          continue;
        }
        if (result === 'gone') {
          store.deletePushSubscription(sub.endpoint);
          log.info('A push subscription no longer exists at its push service; forgotten.');
        } else if (store.recordPushResult(sub.endpoint, false) >= MAX_CONSECUTIVE_FAILURES) {
          store.deletePushSubscription(sub.endpoint);
          log.warn(`A push subscription failed ${MAX_CONSECUTIVE_FAILURES} times in a row; forgotten.`);
        }
        // One refusal counts once: the rest of this pass would only repeat it.
        break;
      }
      return sent;
    }));
    const total = counts.reduce((sum, count) => sum + count, 0);
    if (total > 0) log.debug(`Sent ${total} push notification(s) to ${counts.filter(Boolean).length} device(s).`);
    return total;
  }
}

/**
 * Send one device a notification that says only that notifications work.
 *
 * `gone` when the endpoint is not subscribed here, or when its push service
 * says it no longer exists (the subscription is then forgotten).
 */
export async function sendTestPush(
  store: StateStore,
  endpoint: string,
  send: typeof sendPush = sendPush,
): Promise<PushSendResult> {
  const sub = store.getPushSubscription(endpoint);
  if (!sub) return 'gone';
  const notice: PushNotice = {
    kind: 'test', title: 'mailsift', body: wordsFor(sub.lang).test, tag: 'test', url: '/',
    badge: store.attentionCount(),
  };
  const result = await send(
    { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
    notice,
    vapidKeys(store),
    { ttl: 300, urgency: 'high', subject: pushSubject(sub.origin) },
  );
  if (result === 'gone') store.deletePushSubscription(endpoint);
  else store.recordPushResult(endpoint, result === 'sent');
  return result;
}
