/**
 * Web Push: notifications to an installed copy of the web view.
 *
 * The page can ask the browser for a push subscription, and this module can
 * then reach that browser while the page is closed: a verification code on
 * the lock screen, a critical message the moment it is judged. It is the
 * protocol only (RFC 8291 message encryption over RFC 8188 `aes128gcm`, and
 * RFC 8292 VAPID), written against node:crypto so the runtime gains no
 * dependency for it.
 *
 * What travels: the payload is encrypted to keys only that browser holds, so
 * the push service (Apple, Google, Mozilla, Microsoft) relays bytes it cannot
 * read. What it does learn is that this server sent something, and when.
 *
 * Where it may be sent: a subscription's endpoint comes from a browser, so it
 * is treated as untrusted input. Only HTTPS endpoints on the known push
 * services are accepted, which keeps this from being a way to make the server
 * post to an address of someone's choosing.
 */
import {
  createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign,
} from 'node:crypto';
import { getLogger } from '../logger.js';

const log = getLogger('webpush');

const b64u = (value: Buffer): string => value.toString('base64url');
const fromB64u = (value: string): Buffer => Buffer.from(value, 'base64url');

/** One record is plenty: push services cap a message near 4096 bytes anyway. */
const RECORD_SIZE = 4096;
/** Salt, record size, key id length and the 65-byte sender key. */
const HEADER_BYTES = 16 + 4 + 1 + 65;
/** What is left for the plaintext after the header, the delimiter and the GCM tag. */
export const MAX_PAYLOAD_BYTES = RECORD_SIZE - HEADER_BYTES - 1 - 16;

/** HKDF (RFC 5869) with SHA-256, for outputs of at most one block. */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  return createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, length);
}

export interface EncryptOptions {
  /** Fixed values, for checking against the RFC's worked example. Never set in service. */
  salt?: Buffer;
  senderPrivateKey?: Buffer;
}

/**
 * Encrypt one push message for one subscription (RFC 8291 section 3).
 *
 * `p256dh` is the browser's public key as an uncompressed P-256 point and
 * `auth` its 16-byte secret; both come from PushSubscription.getKey().
 */
export function encryptPayload(plaintext: Buffer, p256dh: Buffer, auth: Buffer, options: EncryptOptions = {}): Buffer {
  if (plaintext.length > MAX_PAYLOAD_BYTES) throw new Error(`push payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  if (p256dh.length !== 65 || p256dh[0] !== 4) throw new Error('push subscription key is not an uncompressed P-256 point');
  if (auth.length !== 16) throw new Error('push subscription auth secret must be 16 bytes');

  // A fresh key pair for every message: the sender half is thrown away.
  const sender = createECDH('prime256v1');
  if (options.senderPrivateKey) sender.setPrivateKey(options.senderPrivateKey);
  else sender.generateKeys();
  const senderPublic = sender.getPublicKey();
  const shared = sender.computeSecret(p256dh);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'ascii'), p256dh, senderPublic]);
  const ikm = hkdf(auth, shared, keyInfo, 32);
  const salt = options.salt ?? randomBytes(16);
  const key = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'ascii'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'ascii'), 12);

  const cipher = createCipheriv('aes-128-gcm', key, nonce);
  // 0x02 marks the last record; no padding beyond it.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = senderPublic.length;
  return Buffer.concat([header, senderPublic, sealed]);
}

/** The server's own identity towards push services, as base64url raw keys. */
export interface VapidKeys {
  /** Uncompressed P-256 point, 65 bytes. This is what the browser subscribes with. */
  publicKey: string;
  /** The 32-byte scalar. */
  privateKey: string;
}

export function generateVapidKeys(): VapidKeys {
  const pair = createECDH('prime256v1');
  pair.generateKeys();
  // node returns the scalar without its leading zero bytes, so about one key
  // in 250 comes back 31 bytes long. Stored at full width, every key has the
  // same shape and nothing downstream has to wonder whether a short one is damaged.
  const scalar = pair.getPrivateKey();
  const privateKey = Buffer.concat([Buffer.alloc(Math.max(0, 32 - scalar.length)), scalar]);
  return { publicKey: b64u(pair.getPublicKey()), privateKey: b64u(privateKey) };
}

/** Twelve hours: push services refuse a token valid for more than a day. */
const VAPID_LIFETIME_SECONDS = 12 * 60 * 60;

/**
 * The Authorization header that names this server to a push service (RFC 8292).
 *
 * A signed token whose audience is the push service's origin. `subject` is a
 * contact for that service's operator: a mailto: or https: URL.
 */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + VAPID_LIFETIME_SECONDS,
    sub: subject,
  })));
  const point = fromB64u(keys.publicKey);
  const key = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33, 65)) },
    format: 'jwk',
  });
  // JOSE wants the raw r||s pair, not the DER structure node signs by default.
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${keys.publicKey}`;
}

/**
 * Hosts a subscription endpoint may live on.
 *
 * Chrome and its relatives use FCM, Safari uses Apple's web push, Firefox uses
 * Mozilla's autopush and older Edge used WNS. WEB_PUSH_ALLOWED_HOSTS adds
 * suffixes for a browser that is not on this list.
 */
const PUSH_HOST_SUFFIXES = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.apple.com',
  'push.services.mozilla.com',
  'notify.windows.com',
];

function allowedHostSuffixes(): string[] {
  const extra = (process.env.WEB_PUSH_ALLOWED_HOSTS ?? '')
    .split(',').map((host) => host.trim().toLowerCase().replace(/^\.+/, '')).filter(Boolean);
  return [...PUSH_HOST_SUFFIXES, ...extra];
}

/** Whether an endpoint is an HTTPS address on a push service this server will post to. */
export function isPushEndpoint(endpoint: string): boolean {
  if (endpoint.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  if (url.port && url.port !== '443') return false;
  const host = url.hostname.toLowerCase();
  return allowedHostSuffixes().some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export interface PushTarget {
  endpoint: string;
  /** base64url, as PushSubscription.toJSON() gives them. */
  p256dh: string;
  auth: string;
}

export interface PushOptions {
  /** Seconds the push service may hold the message for a device that is offline. */
  ttl: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  subject: string;
}

/**
 * `gone` means the browser dropped the subscription (uninstalled, permission
 * revoked): it will never work again and should be forgotten. `failed` may
 * work next time.
 */
export type PushSendResult = 'sent' | 'gone' | 'failed';

type Fetch = typeof fetch;

/** Deliver one encrypted message. Never throws: a notification must not break what triggered it. */
export async function sendPush(
  target: PushTarget,
  payload: unknown,
  keys: VapidKeys,
  options: PushOptions,
  fetchImpl: Fetch = fetch,
): Promise<PushSendResult> {
  if (!isPushEndpoint(target.endpoint)) return 'gone';
  let body: Buffer;
  let authorization: string;
  try {
    body = encryptPayload(Buffer.from(JSON.stringify(payload), 'utf8'), fromB64u(target.p256dh), fromB64u(target.auth));
    authorization = vapidAuthorization(target.endpoint, keys, options.subject);
  } catch (error) {
    log.warn(`Push not sent: ${String(error).slice(0, 200)}`);
    return 'failed';
  }
  const host = new URL(target.endpoint).hostname;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetchImpl(target.endpoint, {
        method: 'POST',
        headers: {
          authorization,
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
          ttl: String(Math.max(0, Math.floor(options.ttl))),
          urgency: options.urgency ?? 'high',
        },
        body: new Uint8Array(body),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 404 || response.status === 410) return 'gone';
      if (response.ok) return 'sent';
      // The body is the push service's own short explanation; nothing of ours is in it.
      const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
      log.warn(`Push refused by ${host}: HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
      if (response.status !== 429 && response.status < 500) return 'failed';
    } catch (error) {
      log.warn(`Push to ${host} failed: ${String(error).slice(0, 160)}`);
    }
    if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, 1_500).unref());
  }
  return 'failed';
}
