import { describe, expect, test } from 'vitest';
import {
  DEFAULT_CLIENT_SUITE_CONCURRENCY,
  mapWithConcurrency,
  parseConcurrency
} from './concurrency';

describe('client suite concurrency', () => {
  test('uses a bounded default and accepts positive integers', () => {
    expect(parseConcurrency(undefined)).toBe(DEFAULT_CLIENT_SUITE_CONCURRENCY);
    expect(parseConcurrency('2')).toBe(2);
  });

  test.each(['0', '-1', '1.5', 'nope'])('rejects %s', (value) => {
    expect(() => parseConcurrency(value)).toThrow(
      '--concurrency must be a positive integer'
    );
  });

  test('preserves input order while limiting active workers', async () => {
    let active = 0;
    let peak = 0;

    const results = await mapWithConcurrency(
      [30, 10, 20, 5],
      2,
      async (delay, index) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, delay));
        active--;
        return index;
      }
    );

    expect(results).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  test('returns immediately for an empty selection', async () => {
    await expect(
      mapWithConcurrency([], 2, async () => 'unused')
    ).resolves.toEqual([]);
  });
});
