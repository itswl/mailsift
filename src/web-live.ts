/**
 * The page's live line: server-sent events that say "something changed".
 *
 * A page that polls once a minute shows a verification code a minute late.
 * This keeps one stream open per page and tells it, within a second, that the
 * list or the status line would now read differently; the page then asks for
 * the data over the routes it already uses. The stream itself carries no mail,
 * only two opaque signatures, so there is nothing in it to protect beyond the
 * session that opened it.
 *
 * Like the push dispatcher, the hub watches the database rather than the
 * poller: it works the same in the long-running service and in a standalone
 * MCP server next to a cron job, and the poller does not know it exists. One
 * timer serves every page, and it runs only while a page is listening.
 */
import { getLogger } from './logger.js';
import { StateStore } from './services/state.js';

const log = getLogger('live');

/** What the hub needs from an HTTP response: a way to write, and to hear it close. */
export interface LiveChannel {
  write(chunk: string): void;
  onClose(listener: () => void): void;
  /** End the response. A page that is not taken on must not be left holding an open request. */
  close(): void;
}

export interface LiveHubOptions {
  /** A handle of the hub's own; SQLite reports only other connections' commits. */
  openStore?: () => StateStore;
  intervalMs?: number;
  maxClients?: number;
  /** How many of those one client may hold, so one browser cannot take every place. */
  maxPerOwner?: number;
  keepAliveMs?: number;
}

const DEFAULT_INTERVAL_MS = 1_000;
/** A person has a handful of tabs and devices; past this something is looping. */
const DEFAULT_MAX_CLIENTS = 32;
/** Tabs and windows of one browser. Behind a proxy that hides addresses, everyone shares this. */
const DEFAULT_MAX_PER_OWNER = 12;
/** Under the idle timeout of the usual proxies, so a quiet stream is not cut. */
const DEFAULT_KEEP_ALIVE_MS = 20_000;

const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export class LiveHub {
  private readonly clients = new Set<LiveChannel>();
  private readonly owners = new Map<LiveChannel, string>();
  private store: StateStore | undefined;
  private timer: NodeJS.Timeout | undefined;
  private keepAlive: NodeJS.Timeout | undefined;
  private version: number | undefined;
  private signature: { mail: string; poll: string } | undefined;
  private failing = false;

  constructor(private readonly options: LiveHubOptions = {}) {}

  get size(): number {
    return this.clients.size;
  }

  /** Whether another page of this client would be taken on. Asked before a response is begun. */
  hasRoom(owner = ''): boolean {
    if (this.clients.size >= (this.options.maxClients ?? DEFAULT_MAX_CLIENTS)) return false;
    let held = 0;
    for (const name of this.owners.values()) if (name === owner) held += 1;
    return held < (this.options.maxPerOwner ?? DEFAULT_MAX_PER_OWNER);
  }

  /**
   * Add a page to the stream. False when the hub is full, this client already
   * holds its share, or the database cannot be opened; the caller ends the
   * response and the page falls back to asking on a timer.
   *
   * The first thing a page hears is `hello` with the current signatures. A
   * page that reconnects compares them with the last ones it saw, which is
   * how a change that happened while it was away is not missed.
   */
  attach(channel: LiveChannel, owner = ''): boolean {
    if (!this.hasRoom(owner)) return false;
    try {
      this.store ??= (this.options.openStore ?? (() => new StateStore()))();
      // Tell the pages already listening about anything pending first, so the
      // newcomer's hello is the present and not the last tick's.
      this.check();
      // Version before signature: a commit landing between the two reads is
      // then seen again on the next pass rather than missed.
      this.version ??= this.store.dataVersion();
      this.signature ??= this.store.changeSignature();
      channel.write('retry: 3000\n\n' + frame('hello', this.signature));
    } catch (error) {
      log.warn(`Live stream not opened: ${String(error).slice(0, 200)}`);
      if (this.clients.size === 0) this.release();
      return false;
    }
    this.clients.add(channel);
    this.owners.set(channel, owner);
    channel.onClose(() => this.detach(channel));
    this.startTimers();
    return true;
  }

  /**
   * One pass of the change check; the timer calls this.
   *
   * Reading SQLite's data version is the whole cost while nothing happens.
   * When another connection has committed, the signatures are recomputed and
   * only the part that actually changed is announced: an audit entry or a
   * cursor moves the version and neither signature.
   */
  check(): void {
    if (this.clients.size === 0) return;
    try {
      const store = this.store ??= (this.options.openStore ?? (() => new StateStore()))();
      const version = store.dataVersion();
      if (version === this.version) return;
      const next = store.changeSignature();
      // Only now: a version noted before a read that then failed would be a
      // change nobody is ever told about.
      this.version = version;
      this.failing = false;
      const previous = this.signature;
      this.signature = next;
      if (!previous) return;
      if (previous.mail !== next.mail) this.broadcast(frame('mail', { sig: next.mail }));
      if (previous.poll !== next.poll) this.broadcast(frame('poll', { sig: next.poll }));
    } catch (error) {
      // Said once per run of failures, not once a second.
      if (!this.failing) log.warn(`Live change check failed: ${String(error).slice(0, 200)}`);
      this.failing = true;
      // The handle may be the thing that broke. The next pass opens a new one
      // and, with no version remembered, compares against what the pages
      // were last told.
      try {
        this.store?.close();
      } catch {
        // Already closed.
      }
      this.store = undefined;
      this.version = undefined;
    }
  }

  /** Stop everything and forget every page. Their responses are the caller's to end. */
  close(): void {
    this.clients.clear();
    this.owners.clear();
    this.release();
  }

  private broadcast(chunk: string): void {
    for (const channel of [...this.clients]) {
      try {
        channel.write(chunk);
      } catch {
        // A response that can no longer be written to is a page that left.
        this.detach(channel);
      }
    }
  }

  private detach(channel: LiveChannel): void {
    if (!this.clients.delete(channel)) return;
    this.owners.delete(channel);
    if (this.clients.size === 0) this.release();
  }

  private startTimers(): void {
    if (!this.timer) {
      this.timer = setInterval(() => this.check(), this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
      this.timer.unref();
    }
    if (!this.keepAlive) {
      // A comment line: proxies see traffic, the page's event handlers see nothing.
      this.keepAlive = setInterval(() => this.broadcast(': keep-alive\n\n'), this.options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS);
      this.keepAlive.unref();
    }
  }

  /** With nobody listening there is nothing to watch: no timer, no open database handle. */
  private release(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.timer = undefined;
    this.keepAlive = undefined;
    try {
      this.store?.close();
    } catch {
      // Already closed.
    }
    this.store = undefined;
    this.version = undefined;
    this.signature = undefined;
  }
}

/** The hub the web routes share. */
export const liveHub = new LiveHub();
