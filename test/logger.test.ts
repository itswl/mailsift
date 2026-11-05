import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLogger, REDACTED, redactSecrets } from '../src/logger.js';

describe('redactSecrets', () => {
  it('blanks Google OAuth credentials', () => {
    expect(redactSecrets('token ya29.a0AfH6SMBxyz-123_ABC expired')).toBe(`token ${REDACTED} expired`);
    expect(redactSecrets('refresh 1//09abcdefghijklmnopqrstuvwxyz failed')).toBe(`refresh ${REDACTED} failed`);
    expect(redactSecrets('GOCSPX-aBcD1234efGh')).toBe(REDACTED);
  });

  it('blanks a JWT, which is what Microsoft returns', () => {
    const jwt = 'eyJ0eXAiOiJKV1QiLCJhbGc.eyJhdWQiOiJodHRwcz.SflKxwRJSMeKKF2QT4';
    expect(redactSecrets(`Authorization failed for ${jwt}`)).toBe(`Authorization failed for ${REDACTED}`);
  });

  it('keeps the scheme of an Authorization header and drops the value', () => {
    expect(redactSecrets('sent Bearer sk-abcdef0123456789')).toBe(`sent Bearer ${REDACTED}`);
    expect(redactSecrets('Basic dXNlcjpwYXNzd29yZA==')).toBe(`Basic ${REDACTED}`);
  });

  it('blanks secrets in a query string or form body', () => {
    expect(redactSecrets('POST /token refresh_token=1234567890&grant_type=refresh_token'))
      .toBe(`POST /token refresh_token=${REDACTED}&grant_type=refresh_token`);
    expect(redactSecrets('?api_key=abc123&page=2')).toBe(`?api_key=${REDACTED}&page=2`);
    expect(redactSecrets('password=hunter2')).toBe(`password=${REDACTED}`);
  });

  it('blanks the path segment that is itself the credential', () => {
    expect(redactSecrets('POST https://open.feishu.cn/open-apis/bot/v2/hook/abc-123-def-456 failed'))
      .toBe(`POST https://open.feishu.cn/open-apis/bot/v2/hook/${REDACTED} failed`);
    expect(redactSecrets('GET https://hc-ping.com/ping/9f8e7d6c5b4a3210'))
      .toBe(`GET https://hc-ping.com/ping/${REDACTED}`);
  });

  it('blanks a user name and password in a URL', () => {
    expect(redactSecrets('connect https://alice:s3cret@example.com/path'))
      .toBe(`connect https://${REDACTED}@example.com/path`);
  });

  it('keeps the readable half of a mail account line and drops the password', () => {
    expect(redactSecrets('MAIL_ACCOUNT_1=qq|me@qq.com|app-password is malformed'))
      .toBe(`MAIL_ACCOUNT_1=qq|me@qq.com|${REDACTED} is malformed`);
  });

  it('leaves an ordinary message alone', () => {
    const line = 'Poll finished: 2 accounts, 7 messages, 1 pushed';
    expect(redactSecrets(line)).toBe(line);
  });
});

describe('logger', () => {
  const written: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });

  afterEach(() => {
    written.length = 0;
  });

  it('redacts the message and anything passed after it', () => {
    vi.stubEnv('LOG_LEVEL', 'info');
    getLogger('auth').error('token refresh failed', new Error('body: refresh_token=abcdef123456'));
    expect(written.join('')).toContain(`refresh_token=${REDACTED}`);
    expect(written.join('')).not.toContain('abcdef123456');
    vi.unstubAllEnvs();
  });

  it('writes to stderr, because stdout is the MCP channel', () => {
    vi.stubEnv('LOG_LEVEL', 'info');
    getLogger('test').info('hello');
    expect(spy).toHaveBeenCalled();
    expect(written.join('')).toContain('[INFO] test: hello');
    vi.unstubAllEnvs();
  });
});
