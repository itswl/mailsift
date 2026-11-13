import { createECDH, createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import './setup.js';
import {
  encryptPayload, generateVapidKeys, isPushEndpoint, MAX_PAYLOAD_BYTES, sendPush, vapidAuthorization,
} from '../src/services/webpush.js';

const unb64 = (value: string): Buffer => Buffer.from(value, 'base64url');

describe('message encryption', () => {
  it('reproduces the worked example of RFC 8291, byte for byte', () => {
    // Section 5 and Appendix A: every input fixed, so the output is the RFC's.
    const body = encryptPayload(
      Buffer.from('When I grow up, I want to be a watermelon'),
      unb64('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
      unb64('BTBZMqHH6r4Tts7J_aSIgg'),
      {
        salt: unb64('DGv6ra1nlYgDCS1FRnbzlw'),
        senderPrivateKey: unb64('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
      },
    );
    expect(body.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml'
      + 'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT'
      + 'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('uses a new sender key and salt for every message', () => {
    const device = createECDH('prime256v1');
    device.generateKeys();
    const auth = Buffer.alloc(16, 7);
    const one = encryptPayload(Buffer.from('same'), device.getPublicKey(), auth);
    const two = encryptPayload(Buffer.from('same'), device.getPublicKey(), auth);
    expect(one.equals(two)).toBe(false);
    expect(one.subarray(0, 16).equals(two.subarray(0, 16))).toBe(false);
  });

  it('refuses what a push service would refuse, and malformed keys', () => {
    const device = createECDH('prime256v1');
    device.generateKeys();
    const auth = Buffer.alloc(16);
    expect(() => encryptPayload(Buffer.alloc(MAX_PAYLOAD_BYTES + 1), device.getPublicKey(), auth)).toThrow(/exceeds/);
    expect(() => encryptPayload(Buffer.from('x'), Buffer.alloc(65), auth)).toThrow(/P-256/);
    expect(() => encryptPayload(Buffer.from('x'), device.getPublicKey(), Buffer.alloc(8))).toThrow(/16 bytes/);
  });
});

describe('server identity', () => {
  it('signs a token the push service can verify with the public key it was given', () => {
    const keys = generateVapidKeys();
    const now = Date.parse('2026-11-12T00:00:00Z');
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'mailto:ops@example.org', now);
    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, head, claims, signature, k] = match!;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(unb64(head!).toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(unb64(claims!).toString())).toEqual({
      aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: 'mailto:ops@example.org',
    });
    const point = unb64(keys.publicKey);
    const publicKey = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') },
      format: 'jwk',
    });
    expect(verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, unb64(signature!))).toBe(true);
    expect(unb64(signature!)).toHaveLength(64);
  });
});

describe('generated keys', () => {
  it('are always full width, though node drops a scalar\'s leading zero bytes', () => {
    // Roughly one in 250 would otherwise come out 31 bytes long.
    for (let n = 0; n < 600; n += 1) {
      const keys = generateVapidKeys();
      expect(unb64(keys.privateKey)).toHaveLength(32);
      expect(unb64(keys.publicKey)).toHaveLength(65);
    }
  });
});

describe('where a push may be sent', () => {
  it('accepts the push services browsers use', () => {
    expect(isPushEndpoint('https://fcm.googleapis.com/fcm/send/abc:def')).toBe(true);
    expect(isPushEndpoint('https://web.push.apple.com/QGk3')).toBe(true);
    expect(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/gAAA')).toBe(true);
    expect(isPushEndpoint('https://wns2-by3p.notify.windows.com/w/?token=x')).toBe(true);
  });

  it('refuses anything that would turn a subscription into a way to post elsewhere', () => {
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://127.0.0.1/hook',
      'https://internal.example/push',
      'https://fcm.googleapis.com.evil.example/x',
      'https://evilfcm.googleapis.com.example/x',
      'https://user:pw@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'not a url',
      `https://fcm.googleapis.com/${'a'.repeat(3000)}`,
    ]) expect(isPushEndpoint(endpoint), endpoint).toBe(false);
  });

  it('lets a deployment name one more host', () => {
    expect(isPushEndpoint('https://push.vendor.example/x')).toBe(false);
    process.env.WEB_PUSH_ALLOWED_HOSTS = 'vendor.example';
    expect(isPushEndpoint('https://push.vendor.example/x')).toBe(true);
  });
});

describe('delivery', () => {
  const device = (): { endpoint: string; p256dh: string; auth: string } => {
    const pair = createECDH('prime256v1');
    pair.generateKeys();
    return {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      p256dh: pair.getPublicKey().toString('base64url'),
      auth: Buffer.alloc(16, 1).toString('base64url'),
    };
  };
  const options = { ttl: 600, subject: 'mailto:ops@example.org' };

  it('posts ciphertext, never the message, with the headers a push service requires', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const result = await sendPush(device(), { title: 'secret 482913' }, generateVapidKeys(), options, fake);
    expect(result).toBe('sent');
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['content-encoding']).toBe('aes128gcm');
    expect(headers['ttl']).toBe('600');
    expect(headers['urgency']).toBe('high');
    expect(headers['authorization']).toMatch(/^vapid t=/);
    expect(Buffer.from(calls[0]!.init.body as Uint8Array).toString('latin1')).not.toContain('482913');
  });

  it('tells a dropped subscription from a passing failure', async () => {
    const answering = (status: number): typeof fetch =>
      (async () => new Response('nope', { status })) as unknown as typeof fetch;
    const keys = generateVapidKeys();
    expect(await sendPush(device(), {}, keys, options, answering(410))).toBe('gone');
    expect(await sendPush(device(), {}, keys, options, answering(404))).toBe('gone');
    expect(await sendPush(device(), {}, keys, options, answering(403))).toBe('failed');
    // An endpoint off the list is never contacted.
    let contacted = false;
    const spy = (async () => { contacted = true; return new Response(null, { status: 201 }); }) as unknown as typeof fetch;
    expect(await sendPush({ ...device(), endpoint: 'https://internal.example/x' }, {}, keys, options, spy)).toBe('gone');
    expect(contacted).toBe(false);
  });

  it('tries once more when the push service is busy', async () => {
    let calls = 0;
    const flaky = (async () => {
      calls += 1;
      return new Response(null, { status: calls === 1 ? 503 : 201 });
    }) as unknown as typeof fetch;
    expect(await sendPush(device(), {}, generateVapidKeys(), options, flaky)).toBe('sent');
    expect(calls).toBe(2);
  });
});
