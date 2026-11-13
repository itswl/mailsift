/**
 * The small HTTP vocabulary the web view's routes share.
 *
 * Routes return a response object instead of writing to the socket, so the
 * whole surface can be exercised in tests without one. This file holds that
 * object, the request-body readers and the two checks every route that
 * changes something makes first: who is asking, and from where.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { LiveChannel } from './web-live.js';

export interface WebResponse {
  status: number;
  body: string | Buffer;
  contentType: string;
  /** Set-Cookie value, when a request establishes or ends a session. */
  cookie?: string;
  cacheControl?: string;
  headers?: Record<string, string>;
  /**
   * A response that stays open. The server writes the head, hands over a
   * channel and does not end the response; the body above is ignored.
   */
  stream?: (channel: LiveChannel) => void;
}

export const json = (status: number, value: unknown): WebResponse => ({
  status,
  body: JSON.stringify(value),
  contentType: 'application/json; charset=utf-8',
});

/**
 * What a request may do.
 *
 * `read` sees everything the triage stored and can read a message live.
 * `write` can also change a mailbox, send mail and correct a judgement. Which
 * one a browser gets is decided by the token it signed in with, so the split
 * MCP already makes between its two credentials holds here too: nobody gains
 * the power to act on mail by holding the read token.
 */
export type Session = 'none' | 'read' | 'write';

export const SESSION_COOKIE = 'mailsift_session';

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/**
 * Constant-time comparison of a configured secret with what was presented.
 *
 * The digests are compared, not the values: they are always the same length,
 * so nothing about the secret's length is learned and no input, however it is
 * encoded, can make the comparison throw.
 */
export function secretEquals(expected: string, presented: string): boolean {
  return timingSafeEqual(digest(expected), digest(presented));
}

/** Whether a presented token is the expected one; with none configured, everything is. */
export function tokenMatches(expected: string, presented: string): boolean {
  if (!expected) return true;
  return secretEquals(expected, presented);
}

/**
 * A name for a credential that is not the credential.
 *
 * Stored next to what a session leaves behind (a notification subscription),
 * so that rotating the token can end those too, without the token itself ever
 * being written to the database.
 */
export function credentialMark(token: string): string {
  return token ? createHash('sha256').update(`mailsift-credential:${token}`, 'utf8').digest('hex').slice(0, 24) : '';
}

/**
 * Whether a request reached this server under a name that is this machine's.
 *
 * Asked only when no token is configured, which the server allows only while
 * it listens on loopback. That is still reachable from a browser: a page on
 * any site can point a host name of its own at 127.0.0.1 and then read the
 * answers as its own origin. Such a request arrives carrying that site's name
 * in Host, so answering only to loopback names shuts it out. A proxy on the
 * same machine that forwards its public name is listed in MCP_ALLOWED_HOSTS.
 */
export function localHost(header: string | undefined, allowed = process.env.MCP_ALLOWED_HOSTS ?? ''): boolean {
  // HTTP/1.1 requires Host and every browser sends it; without one this is not a browser.
  if (!header) return true;
  const raw = header.trim().toLowerCase();
  const name = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.replace(/:\d+$/, '');
  if (name === 'localhost' || name.endsWith('.localhost') || name === '[::1]' || /^127(\.\d{1,3}){3}$/.test(name)) return true;
  return allowed.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean).includes(name);
}

/**
 * Whether the browser is loading this address as part of another document:
 * an image, a stylesheet, a frame. Nothing under /api is any of those, but a
 * message shown with its remote images may name this server as one, and the
 * request would carry the reader's session.
 */
export function embedded(req: IncomingMessage): boolean {
  const dest = String(req.headers['sec-fetch-dest'] ?? '').toLowerCase();
  return dest !== '' && dest !== 'empty' && dest !== 'document';
}

export function readCookie(header: string | undefined, name: string): string {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key !== name) continue;
    try {
      return decodeURIComponent(rest.join('='));
    } catch {
      // A cookie cut off mid-escape is no credential; it must not be a 500 either.
      return '';
    }
  }
  return '';
}

/** The credential a request carries: a bearer token, else the session cookie. */
export function presentedToken(req: IncomingMessage): string {
  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice('Bearer '.length)
    : '';
  return bearer || readCookie(req.headers.cookie, SESSION_COOKIE);
}

export function sessionOf(req: IncomingMessage, token: string, writeToken = ''): Session {
  const presented = presentedToken(req);
  if (writeToken && presented && tokenMatches(writeToken, presented)) return 'write';
  if (!token) return 'read';
  return presented && tokenMatches(token, presented) ? 'read' : 'none';
}

/**
 * Whether a request that changes something was started by another site.
 *
 * The session cookie is SameSite=Lax, which already keeps it off a cross-site
 * POST. This is the second lock: a browser says where a request came from in
 * Sec-Fetch-Site, and older ones in Origin. A client that sends neither is
 * not a browser being steered by a page, and still has to present the token.
 */
export function crossSite(req: IncomingMessage): boolean {
  const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
  if (site) return site !== 'same-origin' && site !== 'none';
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

/** Read a bounded request body; anything larger is refused outright. */
export async function readBody(req: IncomingMessage, limit = 4096): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A JSON object body, or undefined when it is absent, oversized or not an object. */
export async function readJson(req: IncomingMessage, limit = 16 * 1024): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readBody(req, limit));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** A per-client budget over a one-minute window. */
export function rateWindow(perMinute: number): (client: string, now?: number) => boolean {
  const windows = new Map<string, { startedAt: number; count: number }>();
  return (client, now = Date.now()) => {
    const current = windows.get(client);
    if (!current || now - current.startedAt >= 60_000) {
      // Bound the table: a spread of client fingerprints must not grow it forever.
      if (windows.size > 2000) windows.clear();
      windows.set(client, { startedAt: now, count: 1 });
      return true;
    }
    if (current.count >= perMinute) return false;
    current.count += 1;
    return true;
  };
}

const TIMED_OUT = Symbol('timed out');
export type TimedOut = typeof TIMED_OUT;
export const timedOut = (value: unknown): value is TimedOut => value === TIMED_OUT;

/** Settle with the work or with a marker, whichever comes first; the work is not cancelled. */
export function within<T>(work: Promise<T>, ms: number): Promise<T | TimedOut> {
  return Promise.race([
    work,
    new Promise<TimedOut>((resolve) => setTimeout(() => resolve(TIMED_OUT), ms).unref()),
  ]);
}

export const text = (value: unknown, max = 2000): string =>
  (typeof value === 'string' ? value : '').slice(0, max);

export const textList = (value: unknown, maxItems = 60, maxLength = 1000): string[] =>
  (Array.isArray(value) ? value : [])
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
