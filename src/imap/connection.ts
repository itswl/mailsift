/**
 * Getting a connection to a mailbox, for two kinds of caller.
 *
 * The poller can wait. It makes one attempt at a time, gives the server a
 * minute and a half, and tries four times with a pause in between, because a
 * poll that connects a little later has lost nothing.
 *
 * A person reading mail cannot. Opening a message used to make its own
 * connection for the text, another for the attachment list and another for a
 * download, each prepared to wait that same minute and a half. On a day when
 * a provider drops half of its handshakes, that is a reader watching a
 * spinner. So the reading view gets two things here:
 *
 * - `connectInteractive`: short attempts on a clock kept here, and another
 *   started beside the first if the first has not signed in within two
 *   seconds. Whichever arrives is used and the others are hung up on.
 * - `withSession`: one connection per mailbox that stays open for ten
 *   minutes after its last use. Everything the reader asks of that mailbox
 *   goes down it in turn, so the handshake is paid once, not per click.
 * - `warmSession`: that connection made when the page is opened, before
 *   anything is asked of it.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { ImapFlow } from 'imapflow';
import { getAccessToken } from './auth.js';
import { needsOAuth, type Account } from '../config.js';
import { getLogger } from '../logger.js';

const log = getLogger('imap');

const TRANSIENT_CONNECT_MARKERS = [
  'user is authenticated but not connected',
  'connection reset', 'connection refused', 'socket hang up',
  'timed out', 'timeout', 'econnreset', 'econnrefused', 'etimedout',
  'temporarily unavailable', 'try again',
  // A server that takes the connection and then drops it before saying anything.
  'unexpected close',
];

export function imapErrorText(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const value = error as {
    message?: unknown;
    response?: unknown;
    responseText?: unknown;
    responseStatus?: unknown;
    code?: unknown;
  };
  return [value.message, value.responseText, value.response, value.responseStatus, value.code]
    .filter((part) => part !== undefined && part !== null && String(part))
    .map(String)
    .filter((part, index, all) => all.indexOf(part) === index)
    .join(' | ');
}

export function isTransientConnectError(error: unknown): boolean {
  const text = imapErrorText(error).toLowerCase();
  return TRANSIENT_CONNECT_MARKERS.some((marker) => text.includes(marker));
}

export function connectAttempts(account: Account): number {
  void account;
  return 4;
}

export function retryDelayMs(account: Account, attempt: number): number {
  void account;
  return 2_000 * 2 ** Math.max(0, attempt - 1);
}

export interface ConnectOptions {
  /** Tune the connection for a long-lived IDLE listener instead of a short poll. */
  idle?: boolean;
}

type ImapAuth = { user: string; accessToken: string } | { user: string; pass: string };

async function authFor(account: Account): Promise<ImapAuth> {
  return needsOAuth(account)
    ? { user: account.username, accessToken: await getAccessToken(account.username, account.auth) }
    : { user: account.username, pass: account.password ?? '' };
}

function newClient(account: Account, auth: ImapAuth, extra: Record<string, unknown> = {}): ImapFlow {
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.useSsl,
    auth,
    logger: false,
    // Observe only; do not modify mailbox state.
    emitLogs: false,
    ...extra,
  });
  // ImapFlow can emit a later socket error after connect() has rejected. Node
  // treats an EventEmitter "error" without a listener as process-fatal, which
  // used to turn one provider reset into a container restart loop.
  client.on('error', (error: unknown) => {
    log.warn(`[${account.name}] asynchronous IMAP error: ${imapErrorText(error)}`);
  });
  return client;
}

function hangUp(client: ImapFlow): void {
  try {
    client.close();
  } catch {
    // Already gone.
  }
}

// ---- Shutting down ----

/**
 * Connections that are still being made, and whether new ones may begin.
 *
 * A poll that is stuck making connections to a provider that is not
 * answering can run for six minutes: four attempts of ninety seconds. A
 * service told to stop in the middle of that used to be killed when its grace
 * ran out. Told to stop, it now hangs up on the attempts in flight and makes
 * no more, so the poll ends and the process leaves by itself.
 */
let stopped = false;
const connecting = new Set<ImapFlow>();

export function stopConnecting(): void {
  stopped = true;
  for (const client of connecting) hangUp(client);
  connecting.clear();
  closeSessions();
}

/** For a process that goes on after all, which in practice means a test. */
export function resumeConnecting(): void {
  stopped = false;
}

async function attempt(client: ImapFlow): Promise<void> {
  connecting.add(client);
  try {
    await client.connect();
  } finally {
    connecting.delete(client);
  }
}

// ---- The poller's connection ----

export async function connect(account: Account, options: ConnectOptions = {}): Promise<ImapFlow> {
  const auth = await authFor(account);
  const maxAttempts = connectAttempts(account);
  for (let tried = 1; tried <= maxAttempts; tried += 1) {
    if (stopped) throw new Error('shutting down; no new mailbox connections');
    log.info(
      `Connecting ${account.name} (${account.host}:${account.port}, auth=${account.auth}, attempt ${tried}/${maxAttempts})`,
    );
    const client = newClient(account, auth, options.idle
      ? {
          // Re-enter IDLE soon after a wake-up fetch so the listening gap stays
          // short; this connection issues few commands, so the extra round
          // trips do not matter. RFC 2177 lets servers drop an IDLE after 29
          // minutes, so restart it well before that.
          autoIdleDelay: 1_000,
          maxIdleTime: 20 * 60_000,
          missingIdleCommand: 'NOOP' as const,
        }
      : {});
    try {
      await attempt(client);
      return client;
    } catch (error) {
      // A failed handshake can leave a half-open TLS socket behind. Close it
      // before retrying or handing the connection failure back to the watcher.
      hangUp(client);

      const detail = imapErrorText(error);
      if (stopped || tried === maxAttempts || !isTransientConnectError(error)) {
        throw new Error(detail, { cause: error });
      }

      const delayMs = retryDelayMs(account, tried);
      log.warn(
        `[${account.name}] transient IMAP connection failure (${tried}/${maxAttempts}); ` +
          `retrying in ${delayMs}ms: ${detail}`,
      );
      await sleep(delayMs);
    }
  }

  throw new Error(`Unable to connect to ${account.name}`);
}

// ---- The reader's connection ----

/**
 * One attempt is given this long, from the first packet to being signed in.
 * A healthy server takes well under a second. The clock is kept here, not
 * left to the library's own timeouts: those cover reaching the server and its
 * greeting, and a server that greets and then never answers the sign-in
 * (which is what a provider in trouble does) would be waited on for minutes.
 */
const INTERACTIVE_ATTEMPT_MS = 9_000;
/** With no answer after this long, another attempt is started beside the ones running. */
const HEDGE_AFTER_MS = 2_000;
/** Four: with a provider stalling every other sign-in, that is a one-in-sixteen chance of none getting through. */
const INTERACTIVE_ATTEMPTS = 4;

export interface InteractiveTiming {
  attemptMs?: number;
  hedgeAfterMs?: number;
  attempts?: number;
}

/**
 * Connect for someone who is waiting.
 *
 * Up to four attempts, started two seconds apart and left running side by
 * side; the first to connect is the connection, and the rest are hung up on.
 * An attempt that fails outright is replaced at once. When a provider is
 * stalling one handshake in two, this turns a fair chance of a long wait into
 * a small chance of a short one, at the cost of a second handshake now and
 * then.
 *
 * A refused sign-in is tried once more and no further. The same provider in
 * trouble answers "Login failed" to a token it accepted a second ago, so one
 * refusal proves nothing; but a password that really is wrong must not be
 * presented three times for every message someone tries to open.
 */
export async function connectInteractive(account: Account, timing: InteractiveTiming = {}): Promise<ImapFlow> {
  if (stopped) throw new Error('shutting down; no new mailbox connections');
  const auth = await authFor(account);
  const attemptMs = timing.attemptMs ?? INTERACTIVE_ATTEMPT_MS;
  const hedgeAfterMs = timing.hedgeAfterMs ?? HEDGE_AFTER_MS;
  const maxAttempts = timing.attempts ?? INTERACTIVE_ATTEMPTS;

  return new Promise<ImapFlow>((resolve, reject) => {
    let settled = false;
    let started = 0;
    let running = 0;
    let lastError: unknown;
    const timers: NodeJS.Timeout[] = [];
    const racing = new Set<ImapFlow>();
    const settle = (): void => {
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      // The attempts still waiting are not needed any more. Hanging up on
      // them now is kinder to a server that is already struggling than
      // leaving each to run out its own time.
      for (const other of racing) hangUp(other);
      racing.clear();
    };
    let refusals = 0;
    const start = (): void => {
      if (settled || stopped || started >= maxAttempts) return;
      started += 1;
      running += 1;
      const client = newClient(account, auth, { connectionTimeout: attemptMs, greetingTimeout: attemptMs });
      racing.add(client);
      // Out of time: hang up, which fails the attempt, and it is counted as a
      // stall whatever words the library finds for a connection closed on it.
      let outOfTime = false;
      const deadline = setTimeout(() => { outOfTime = true; hangUp(client); }, attemptMs);
      attempt(client).then(() => {
        clearTimeout(deadline);
        running -= 1;
        racing.delete(client);
        if (settled) {
          // A slower twin of the one already in use.
          void client.logout().catch(() => hangUp(client));
          return;
        }
        settle();
        resolve(client);
      }, (error: unknown) => {
        clearTimeout(deadline);
        running -= 1;
        racing.delete(client);
        lastError = outOfTime ? new Error('the mail server did not complete the sign-in in time | ETIMEDOUT') : error;
        hangUp(client);
        if (settled) return;
        const stalled = outOfTime || isTransientConnectError(error);
        if (!stalled) refusals += 1;
        if (stopped || refusals >= 2) {
          settle();
          reject(new Error(imapErrorText(lastError), { cause: lastError }));
          return;
        }
        if (started < maxAttempts) start();
        else if (running === 0) {
          settle();
          reject(new Error(imapErrorText(lastError), { cause: lastError }));
        }
      });
    };
    start();
    for (let n = 1; n < maxAttempts; n += 1) timers.push(setTimeout(start, hedgeAfterMs * n));
  });
}

// ---- One connection per mailbox, kept for the reader ----

/**
 * How long a connection is kept after its last use. Making one is the slow
 * and uncertain part, so it is kept for as long as someone is plausibly still
 * reading; the library keeps it alive in the meantime.
 */
const SESSION_IDLE_MS = 10 * 60_000;
/** After a connection could not be made, requests in the next few seconds are told so at once. */
const FAILURE_MEMORY_MS = 4_000;
/** A mailbox is not warmed more often than this, whether or not the last warming worked. */
const WARM_EVERY_MS = 60_000;
/** A single request of the mailbox. Past this the connection is treated as dead and closed. */
const SESSION_WORK_MS = 30_000;

interface Session {
  client: ImapFlow;
  timer?: NodeJS.Timeout;
}

const sessions = new Map<string, Session>();
const queues = new Map<string, Promise<unknown>>();
/** The last failure to connect, per mailbox: the page asks for several things at once, and each would try again. */
const failures = new Map<string, { at: number; error: Error }>();
const warmed = new Map<string, number>();

function endSession(key: string, session: Session, polite: boolean): void {
  if (session.timer) clearTimeout(session.timer);
  if (sessions.get(key) === session) sessions.delete(key);
  if (polite && session.client.usable) void session.client.logout().catch(() => hangUp(session.client));
  else hangUp(session.client);
}

/** Close every kept connection. Called on shutdown; a later request simply connects again. */
export function closeSessions(): void {
  for (const [key, session] of [...sessions]) endSession(key, session, true);
  failures.clear();
  warmed.clear();
}

/**
 * Have a connection ready before it is asked for.
 *
 * Called when someone opens the page: by the time they tap a message, the
 * handshake is likely done. It makes nothing when a connection is already
 * kept or being made, and tries a mailbox at most once a minute, so a page
 * left open, or a provider that is down, does not turn into a stream of
 * sign-ins.
 */
export function warmSession(account: Account, now = Date.now()): void {
  const key = account.username;
  if (stopped || sessions.get(key)?.client.usable || queues.has(key)) return;
  if (now - (warmed.get(key) ?? 0) < WARM_EVERY_MS) return;
  warmed.set(key, now);
  void withSession(account, async () => undefined).catch(() => undefined);
}

/** How many mailboxes have a connection kept open; for tests and for curiosity. */
export function openSessions(): number {
  return sessions.size;
}

export interface SessionOptions {
  /**
   * Whether the work may be done again on a new connection when the kept one
   * turns out to have died. True for reading. False for anything that changes
   * the mailbox: a move that went through just before the line dropped must
   * not be attempted twice.
   */
  repeatable?: boolean;
  /** How long the work may take before the connection is given up on. */
  timeoutMs?: number;
  timing?: InteractiveTiming;
}

/** Run the work, and if it outlasts its time, close the connection under it so it ends. */
async function bounded<T>(client: ImapFlow, work: (client: ImapFlow) => Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const running = work(client);
  // Its late rejection, after the connection was closed under it, is expected.
  running.catch(() => undefined);
  try {
    return await Promise.race([
      running,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          hangUp(client);
          reject(new Error('the mailbox did not answer in time | ETIMEDOUT'));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function onSession<T>(account: Account, work: (client: ImapFlow) => Promise<T>, options: SessionOptions): Promise<T> {
  const key = account.username;
  const ms = options.timeoutMs ?? SESSION_WORK_MS;
  const open = async (): Promise<Session> => {
    // The page asks for a message's text and its attachments together. When
    // the mailbox could not be reached a moment ago, the second is told so
    // rather than made to wait through the same attempts again.
    const recent = failures.get(key);
    if (recent && Date.now() - recent.at < FAILURE_MEMORY_MS) throw recent.error;
    try {
      const session: Session = { client: await connectInteractive(account, options.timing) };
      failures.delete(key);
      sessions.set(key, session);
      return session;
    } catch (error) {
      failures.set(key, { at: Date.now(), error: error instanceof Error ? error : new Error(String(error)) });
      throw error;
    }
  };

  let session = sessions.get(key);
  const kept = Boolean(session?.client.usable);
  if (session && !kept) endSession(key, session, false);
  if (!session || !kept) session = await open();
  if (session.timer) clearTimeout(session.timer);

  try {
    try {
      return await bounded(session.client, work, ms);
    } catch (error) {
      // A connection that sat idle may have been dropped by the server
      // without a word. That shows on first use, and says nothing about the
      // mailbox: reading is simply done again on a new connection.
      if (session.client.usable || !kept || options.repeatable === false) throw error;
      endSession(key, session, false);
      session = await open();
      return await bounded(session.client, work, ms);
    }
  } finally {
    const current = session;
    if (!current.client.usable) endSession(key, current, false);
    else {
      current.timer = setTimeout(() => endSession(key, current, true), SESSION_IDLE_MS);
      current.timer.unref();
    }
  }
}

/**
 * Do something with a mailbox on its kept connection.
 *
 * Requests for one mailbox run one at a time, in the order they were made:
 * IMAP is one conversation, and the text of a message, its attachment list
 * and a download asked for together are three questions on one line rather
 * than three lines. Different mailboxes do not wait for each other.
 */
export function withSession<T>(
  account: Account,
  work: (client: ImapFlow) => Promise<T>,
  options: SessionOptions = {},
): Promise<T> {
  const key = account.username;
  const before = queues.get(key) ?? Promise.resolve();
  const mine = before.catch(() => undefined).then(() => onSession(account, work, options));
  queues.set(key, mine);
  const release = (): void => {
    if (queues.get(key) === mine) queues.delete(key);
  };
  mine.then(release, release);
  return mine;
}
