import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import './setup.js';
import {
  AuthError, TokenStore, authorizedScope, buildTokenRecord, getAccessToken, getOAuthProvider, OUTLOOK_SEND_SCOPE,
} from '../src/imap/auth.js';

describe('OAuth token storage', () => {
  it('creates and validates a new token store under a missing directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mailsift-auth-'));
    const path = join(dir, 'nested', 'tokens.json');
    try {
      const store = new TokenStore(path);
      const record = { refreshToken: 'refresh', accessToken: 'access', expiresAt: Date.now() / 1000 + 3600 };
      await store.save('me@example.com', record);
      await expect(store.get('me@example.com')).resolves.toEqual(record);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed on malformed token files without overwriting them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mailsift-auth-'));
    const path = join(dir, 'tokens.json');
    await writeFile(path, '{not-json', 'utf8');
    try {
      const store = new TokenStore(path);
      await expect(store.get('me@example.com')).rejects.toBeInstanceOf(AuthError);
      await expect(store.save('me@example.com', {
        refreshToken: 'refresh', accessToken: 'access', expiresAt: Date.now() / 1000 + 3600,
      })).rejects.toBeInstanceOf(AuthError);
      expect(await readFile(path, 'utf8')).toBe('{not-json');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects token responses without a usable access token', () => {
    expect(() => buildTokenRecord({ refresh_token: 'refresh' })).toThrow(AuthError);
    expect(() => buildTokenRecord({ refresh_token: 'refresh', access_token: 'access', expires_in: 0 }))
      .toThrow(AuthError);
  });
});

describe('what a mailbox was authorized for', () => {
  const READ_ONLY = 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access';
  const WITH_SEND = `https://outlook.office.com/IMAP.AccessAsUser.All ${OUTLOOK_SEND_SCOPE} offline_access`;

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OUTLOOK_CLIENT_ID;
  });

  it('asks Microsoft for sending only when the owner asked for it', () => {
    process.env.OUTLOOK_CLIENT_ID = 'client';
    expect(getOAuthProvider('outlook_oauth').scope).toBe(READ_ONLY);
    expect(getOAuthProvider('outlook_oauth', { send: true }).scope).toBe(WITH_SEND);
  });

  it('keeps the scopes with the token, through every refresh', async () => {
    const first = buildTokenRecord({ refresh_token: 'r1', access_token: 'a1', expires_in: 3600 }, undefined, WITH_SEND);
    expect(first.scope).toBe(WITH_SEND);
    // A refresh response says nothing about scopes; the record must not forget them.
    expect(buildTokenRecord({ access_token: 'a2', expires_in: 3600 }, first).scope).toBe(WITH_SEND);
    // A record from before scopes were stored stays without one.
    const old = { refreshToken: 'r', accessToken: 'a', expiresAt: 1 };
    expect(buildTokenRecord({ access_token: 'a2', expires_in: 3600 }, old)).not.toHaveProperty('scope');
  });

  it('refreshes with the scopes that were consented to, not the ones a new authorization would ask', async () => {
    process.env.OUTLOOK_CLIENT_ID = 'client';
    const dir = await mkdtemp(join(tmpdir(), 'mailsift-auth-'));
    const path = join(dir, 'tokens.json');
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: URLSearchParams }) => {
      asked.push(String(init.body.get('scope')));
      return new Response(JSON.stringify({ access_token: 'fresh', expires_in: 3600 }), { status: 200 });
    });
    try {
      const store = new TokenStore(path);
      await store.save('send@outlook.com', { refreshToken: 'r', accessToken: 'stale', expiresAt: 1, scope: WITH_SEND });
      await store.save('read@outlook.com', { refreshToken: 'r', accessToken: 'stale', expiresAt: 1 });
      expect(await getAccessToken('send@outlook.com', 'outlook_oauth', store)).toBe('fresh');
      expect(await getAccessToken('read@outlook.com', 'outlook_oauth', store)).toBe('fresh');
      // Asking the old record for more than it was granted would fail the refresh, and reading with it.
      expect(asked).toEqual([WITH_SEND, READ_ONLY]);
      expect((await store.get('send@outlook.com'))?.scope).toBe(WITH_SEND);

      expect(authorizedScope('send@outlook.com', path)).toBe(WITH_SEND);
      expect(authorizedScope('read@outlook.com', path)).toBeUndefined();
      expect(authorizedScope('nobody@outlook.com', path)).toBeUndefined();
      expect(authorizedScope('send@outlook.com', join(dir, 'absent.json'))).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
