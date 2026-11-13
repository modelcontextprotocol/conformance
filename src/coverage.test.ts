import { describe, expect, it } from 'vitest';
import {
  computeCoverage,
  coverageSuffix,
  expectedFor,
  formatCoverage
} from './coverage';
import type { ConformanceCheck, CheckStatus } from './types';
import type { TraceabilityManifest } from './traceability/types';

function check(id: string, status: CheckStatus = 'SUCCESS'): ConformanceCheck {
  return {
    id,
    name: id,
    description: id,
    status,
    timestamp: '2026-01-01T00:00:00.000Z'
  };
}

const EXPECTED = ['a', 'b', 'c', 'd', 'wire-schema-valid'];

describe('computeCoverage', () => {
  it('reports every expected check when the run is complete', () => {
    const c = computeCoverage(
      EXPECTED,
      EXPECTED.map((id) => check(id))
    );
    expect(c).toEqual({ expected: 5, emitted: 5, missing: [] });
    expect(coverageSuffix(c)).toBe('');
  });

  it('shows a thin run that passes every check it emitted', () => {
    // Every emitted check is green, so pass/fail reads as a clean pass.
    const checks = [check('b'), check('wire-schema-valid')];
    const c = computeCoverage(EXPECTED, checks)!;
    expect(checks.every((x) => x.status === 'SUCCESS')).toBe(true);
    expect(c).toEqual({ expected: 5, emitted: 2, missing: ['a', 'c', 'd'] });
    expect(coverageSuffix(c)).toBe(' (coverage 2/5)');
  });

  it('shows how much of the scenario a setup failure skipped', () => {
    const c = computeCoverage(EXPECTED, [check('a', 'FAILURE')])!;
    expect(c.emitted).toBe(1);
    expect(c.missing).toEqual(['b', 'c', 'd', 'wire-schema-valid']);
  });

  it('does not count INFO or SKIPPED rows as emitted', () => {
    const c = computeCoverage(
      ['a', 'b'],
      [check('a', 'INFO'), check('b', 'SKIPPED')]
    )!;
    expect(c.emitted).toBe(0);
  });

  it('counts WARNING as emitted', () => {
    expect(computeCoverage(['a'], [check('a', 'WARNING')])!.missing).toEqual(
      []
    );
  });

  it('returns null without a baseline', () => {
    expect(computeCoverage(undefined, [check('a')])).toBeNull();
    expect(computeCoverage([], [check('a')])).toBeNull();
  });
});

describe('expectedFor', () => {
  const manifest: TraceabilityManifest = {
    schemaVersion: 1,
    docs: '',
    source: 'typescript-sdk@test',
    seps: {},
    scenarios: {
      'server:tools-list': { expected: ['x'] },
      'client:auth/dpop': { expected: ['y'] }
    }
  };

  it('keys by CLI mode and scenario name', () => {
    expect(expectedFor('server', 'tools-list', true, manifest)).toEqual(['x']);
    expect(expectedFor('client', 'auth/dpop', true, manifest)).toEqual(['y']);
    expect(expectedFor('client', 'tools-list', true, manifest)).toBeUndefined();
  });

  it('gives no baseline away from the default spec version', () => {
    expect(
      expectedFor('server', 'tools-list', false, manifest)
    ).toBeUndefined();
  });

  it('gives no baseline for a manifest built before scenarios existed', () => {
    const old = { ...manifest, scenarios: undefined };
    expect(expectedFor('server', 'tools-list', true, old)).toBeUndefined();
  });
});

describe('formatCoverage', () => {
  it('lists missing IDs and caps the list', () => {
    const missing = Array.from({ length: 12 }, (_, i) => `m${i}`);
    const line = formatCoverage({ expected: 15, emitted: 3, missing });
    expect(line).toMatch(/^Coverage: 3\/15 expected checks emitted\. /);
    expect(line).toContain('m9');
    expect(line).not.toContain('m10');
    expect(line).toMatch(/and 2 more$/);
  });
});
