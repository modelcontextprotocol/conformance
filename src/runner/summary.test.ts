import { describe, test, expect } from 'vitest';
import type { ConformanceCheck } from '../types';
import { untestableCheck, notTestable } from '../scenarios/untestable';
import { formatTally, isUnverified, tallyChecks } from './summary';

const check = (
  id: string,
  status: ConformanceCheck['status'],
  extra: Partial<ConformanceCheck> = {}
): ConformanceCheck => ({
  id,
  name: id,
  description: id,
  status,
  timestamp: '2026-09-24T00:00:00.000Z',
  specReferences: [],
  ...extra
});

const ref = [{ specVersion: 'draft', section: 'x' }] as never;

describe('tallyChecks', () => {
  test('counts the same four numbers the runners counted before', () => {
    const tally = tallyChecks([
      check('a', 'SUCCESS'),
      check('b', 'SUCCESS'),
      check('c', 'FAILURE'),
      check('d', 'WARNING'),
      check('e', 'SKIPPED')
    ]);
    expect(tally).toMatchObject({
      passed: 2,
      failed: 1,
      warnings: 1,
      denominator: 3
    });
  });

  test('unverified is a subset of failed and warnings, never an addition', () => {
    const tally = tallyChecks([
      check('violated', 'FAILURE', { errorMessage: 'cursor was 42' }),
      untestableCheck('missing', 'missing', 'd', 'no control', ref),
      untestableCheck('soft', 'soft', 'd', 'no control', ref, 'WARNING')
    ]);
    expect(tally.failed).toBe(2);
    expect(tally.warnings).toBe(1);
    expect(tally.unverified).toBe(2);
    // The verdict a runner keys its exit code off is unchanged by the split.
    expect(tally.failed + tally.warnings).toBeGreaterThan(0);
  });

  test('a scenario that formats its own message still counts as unverified', () => {
    const own = check('own', 'FAILURE', {
      errorMessage: notTestable('the fixture exposes no control'),
      details: {}
    });
    expect(isUnverified(own)).toBe(true);
    expect(tallyChecks([own]).unverified).toBe(1);
  });

  test('a skipped check is neither failed nor unverified', () => {
    const skipped = check('skip', 'SKIPPED', {
      errorMessage: notTestable('does not apply')
    });
    expect(isUnverified(skipped)).toBe(false);
    expect(tallyChecks([skipped])).toMatchObject({
      failed: 0,
      unverified: 0,
      denominator: 0
    });
  });
});

describe('formatTally', () => {
  test('prints what it always printed when nothing is unverified', () => {
    const line = formatTally({
      passed: 9,
      failed: 1,
      warnings: 0,
      denominator: 10,
      unverified: 0
    });
    expect(line).toBe('Passed: 9/10, 1 failed, 0 warnings');
  });

  test('says how much of a red run was never checked', () => {
    const line = formatTally({
      passed: 2,
      failed: 27,
      warnings: 0,
      denominator: 29,
      unverified: 27
    });
    expect(line).toContain('27 failed');
    expect(line).toContain('27 of those unverified, not violated');
  });
});
