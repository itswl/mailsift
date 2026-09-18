import { describe, expect, it } from 'vitest';
import {
  connectAttempts, imapErrorText, isOversizedLookback, isTransientConnectError, retryDelayMs, selectFetchUids,
} from '../src/imap/client.js';
import type { Account } from '../src/config.js';

const OUTLOOK: Account = {
  name: 'Outlook', provider: 'outlook', username: 'me@outlook.com',
  host: 'outlook.office365.com', port: 993, auth: 'outlook_oauth', folders: ['INBOX'], useSsl: true,
};
const QQ: Account = { ...OUTLOOK, name: 'QQ', provider: 'qq', auth: 'password', password: 'x' };

describe('IMAP fetch caps', () => {
  it('takes the oldest UIDs first so a cap does not skip the backlog', () => {
    expect(selectFetchUids([9, 2, 7, 3, 1], 0, 3)).toEqual([1, 2, 3]);
  });

  it('never returns UIDs at or below the cursor', () => {
    expect(selectFetchUids([2, 3, 4, 5], 3, 10)).toEqual([4, 5]);
  });

  it('returns no UIDs when the shared budget is exhausted', () => {
    expect(selectFetchUids([1, 2, 3], 0, 0)).toEqual([]);
  });

  it('detects an oversized fresh lookback for bounded backfill', () => {
    expect(isOversizedLookback(Array.from({ length: 500 }, (_, i) => i + 1), 500)).toBe(false);
    expect(isOversizedLookback(Array.from({ length: 501 }, (_, i) => i + 1), 500)).toBe(true);
  });
});

describe('IMAP connection errors', () => {
  it('preserves the provider response in the diagnostic text', () => {
    const error = {
      message: 'Command failed',
      response: '3 NO User is authenticated but not connected.',
      responseText: 'User is authenticated but not connected.',
      responseStatus: 'NO',
    };
    expect(imapErrorText(error)).toContain('User is authenticated but not connected.');
    expect(imapErrorText(error)).toContain('NO');
  });

  it('recognizes transient connection failures without retrying auth rejection', () => {
    expect(isTransientConnectError({ responseText: 'User is authenticated but not connected.' })).toBe(true);
    expect(isTransientConnectError({ responseText: 'AUTHENTICATE failed.' })).toBe(false);
  });

  it('gives Outlook session failures a longer bounded retry profile', () => {
    expect(connectAttempts(OUTLOOK)).toBe(4);
    expect(retryDelayMs(OUTLOOK, 1)).toBe(3000);
    expect(retryDelayMs(OUTLOOK, 3)).toBe(12000);
    expect(connectAttempts(QQ)).toBe(3);
    expect(retryDelayMs(QQ, 1)).toBe(1000);
  });
});
