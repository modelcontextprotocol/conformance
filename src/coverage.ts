/**
 * Expected-vs-emitted check coverage per scenario (issue #451).
 *
 * A scenario can pass while emitting only a fraction of its checks, for
 * example when the implementation under test fails early and the checks that
 * would have run never fire. Pass/fail cannot show that. This module compares
 * the check IDs a run emitted against the IDs the same scenario emitted when
 * the traceability workflow ran it against the reference SDK, and reports
 * the ones that are missing.
 *
 * The baseline lives in src/seps/traceability.json under `scenarios`, so SDKs
 * do not keep their own per-scenario snapshots. Coverage is advisory: it is
 * printed and written to coverage.json, and it never changes the exit code.
 */
import { promises as fs } from 'fs';
import path from 'path';
import type { ConformanceCheck } from './types';
import type { TraceabilityManifest } from './traceability/types';
import manifestJson from './seps/traceability.json';

/** Which CLI mode ran the scenario: `client` tests a client, `server` a server. */
export type Side = 'client' | 'server';

/** Statuses that mean the check actually ran. INFO and SKIPPED do not count. */
const COUNTED = new Set(['SUCCESS', 'FAILURE', 'WARNING']);

export interface Coverage {
  /** Check IDs the reference SDK emitted for this scenario. */
  expected: number;
  /** How many of those this run emitted. */
  emitted: number;
  /** Expected check IDs this run did not emit, sorted. */
  missing: string[];
}

export function scenarioKey(side: Side, scenario: string): string {
  return `${side}:${scenario}`;
}

export function countedIds(checks: ConformanceCheck[]): Set<string> {
  return new Set(checks.filter((c) => COUNTED.has(c.status)).map((c) => c.id));
}

/** Pure: null when there is no baseline, or the baseline is empty. */
export function computeCoverage(
  expected: string[] | undefined,
  checks: ConformanceCheck[]
): Coverage | null {
  if (!expected || expected.length === 0) return null;
  const emitted = countedIds(checks);
  const missing = expected.filter((id) => !emitted.has(id)).sort();
  return {
    expected: expected.length,
    emitted: expected.length - missing.length,
    missing
  };
}

const bundled = manifestJson as unknown as TraceabilityManifest;

/**
 * The reference run uses each scenario's default spec version. A run at any
 * other version can legitimately emit a different set, so it gets no baseline
 * rather than a false gap.
 */
export function expectedFor(
  side: Side,
  scenario: string,
  atDefaultSpecVersion: boolean,
  manifest: TraceabilityManifest = bundled
): string[] | undefined {
  if (!atDefaultSpecVersion) return undefined;
  return manifest.scenarios?.[scenarioKey(side, scenario)]?.expected;
}

export function scenarioCoverage(
  side: Side,
  scenario: string,
  checks: ConformanceCheck[],
  atDefaultSpecVersion: boolean
): Coverage | null {
  return computeCoverage(
    expectedFor(side, scenario, atDefaultSpecVersion),
    checks
  );
}

const MAX_LISTED = 10;

/** One line for the per-scenario results, plus the missing IDs if any. */
export function formatCoverage(c: Coverage): string {
  const head = `Coverage: ${c.emitted}/${c.expected} expected checks emitted`;
  if (c.missing.length === 0) return head;
  const listed = c.missing.slice(0, MAX_LISTED).join(', ');
  const more =
    c.missing.length > MAX_LISTED
      ? `, and ${c.missing.length - MAX_LISTED} more`
      : '';
  return `${head}. Not emitted: ${listed}${more}`;
}

/** Suffix for a summary line. Empty when coverage is complete or unknown. */
export function coverageSuffix(c: Coverage | null | undefined): string {
  if (!c || c.missing.length === 0) return '';
  return ` (coverage ${c.emitted}/${c.expected})`;
}

export async function writeCoverage(
  resultDir: string,
  side: Side,
  scenario: string,
  c: Coverage
): Promise<void> {
  await fs.writeFile(
    path.join(resultDir, 'coverage.json'),
    JSON.stringify(
      { scenario, side, baseline: bundled.source, ...c },
      null,
      2
    ) + '\n'
  );
}
