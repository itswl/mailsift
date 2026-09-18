import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuthError, TokenStore, buildTokenRecord } from '../src/imap/auth.js';

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
