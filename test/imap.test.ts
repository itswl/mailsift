import { describe, expect, it } from 'vitest';
import {
  imapErrorText, isOversizedLookback, isTransientConnectError, selectFetchUids,
} from '../src/imap/client.js';

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
});
