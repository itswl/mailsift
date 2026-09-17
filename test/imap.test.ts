import { describe, expect, it } from 'vitest';
import { isOversizedLookback, selectFetchUids } from '../src/imap/client.js';

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

  it('skips an oversized fresh lookback instead of partially backfilling it', () => {
    expect(isOversizedLookback(Array.from({ length: 500 }, (_, i) => i + 1), 500)).toBe(false);
    expect(isOversizedLookback(Array.from({ length: 501 }, (_, i) => i + 1), 500)).toBe(true);
  });
});
