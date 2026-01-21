import { promises as fs } from 'fs';
import { parse as parseYaml } from 'yaml';
import { ConformanceCheck } from './types';
import { COLORS } from './runner/utils';

export interface ExpectedFailures {
  server?: string[];
  client?: string[];
}

export interface BaselineResult {
  /** Exit code: 0 if only expected failures, 1 if unexpected failures or stale baseline */
  exitCode: number;
  /** Scenarios that failed unexpectedly (not in baseline) */
  unexpectedFailures: string[];
  /** Scenarios in baseline that now pass (stale entries) */
  staleEntries: string[];
  /** Scenarios that failed as expected */
  expectedFailures: string[];
}

/**
 * Load and parse an expected-failures YAML file.
 *
 * Expected format:
 * ```yaml
 * server:
 *   - scenario-name-1
 *   - scenario-name-2
 * client:
 *   - scenario-name-3
 * ```
 */
export async function loadExpectedFailures(
  filePath: string
): Promise<ExpectedFailures> {
  const content = await fs.readFile(filePath, 'utf-8');
  const parsed = parseYaml(content);

  if (parsed === null || parsed === undefined) {
    return {};
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Invalid expected-failures file: expected an object with 'server' and/or 'client' keys`
    );
  }

  const result: ExpectedFailures = {};

  if (parsed.server !== undefined) {
    if (!Array.isArray(parsed.server)) {
      throw new Error(
        `Invalid expected-failures file: 'server' must be an array of scenario names`
      );
    }
    result.server = parsed.server.map(String);
  }

  if (parsed.client !== undefined) {
    if (!Array.isArray(parsed.client)) {
      throw new Error(
        `Invalid expected-failures file: 'client' must be an array of scenario names`
      );
    }
    result.client = parsed.client.map(String);
  }

  return result;
}

/**
 * Evaluate scenario results against an expected-failures baseline.
 *
 * Rules:
 * - Scenario fails and IS in baseline → expected (ok)
 * - Scenario fails and is NOT in baseline → unexpected failure (exit 1)
 * - Scenario passes and IS in baseline → stale entry (exit 1, must update baseline)
 * - Scenario passes and is NOT in baseline → normal pass (ok)
 */
export function evaluateBaseline(
  results: { scenario: string; checks: ConformanceCheck[] }[],
  expectedScenarios: string[]
): BaselineResult {
  const expectedSet = new Set(expectedScenarios);
  const unexpectedFailures: string[] = [];
  const staleEntries: string[] = [];
  const expectedFailures: string[] = [];

  const seenScenarios = new Set<string>();

  for (const result of results) {
    seenScenarios.add(result.scenario);
    const hasFailed =
      result.checks.some((c) => c.status === 'FAILURE') ||
      result.checks.some((c) => c.status === 'WARNING');
    const isExpected = expectedSet.has(result.scenario);

    if (hasFailed && isExpected) {
      expectedFailures.push(result.scenario);
    } else if (hasFailed && !isExpected) {
      unexpectedFailures.push(result.scenario);
    } else if (!hasFailed && isExpected) {
      staleEntries.push(result.scenario);
    }
    // !hasFailed && !isExpected → normal pass, nothing to do
  }

  // Also check for baseline entries that reference scenarios not in the run
  // (these are not stale - they might just not be in this suite)

  const exitCode =
    unexpectedFailures.length > 0 || staleEntries.length > 0 ? 1 : 0;

  return { exitCode, unexpectedFailures, staleEntries, expectedFailures };
}

/**
 * Print baseline evaluation results.
 */
export function printBaselineResults(result: BaselineResult): void {
  if (result.expectedFailures.length > 0) {
    console.log(
      `\n${COLORS.YELLOW}Expected failures (in baseline):${COLORS.RESET}`
    );
    for (const scenario of result.expectedFailures) {
      console.log(`  ~ ${scenario}`);
    }
  }

  if (result.staleEntries.length > 0) {
    console.log(
      `\n${COLORS.RED}Stale baseline entries (now passing - remove from baseline):${COLORS.RESET}`
    );
    for (const scenario of result.staleEntries) {
      console.log(`  ✓ ${scenario}`);
    }
  }

  if (result.unexpectedFailures.length > 0) {
    console.log(
      `\n${COLORS.RED}Unexpected failures (not in baseline):${COLORS.RESET}`
    );
    for (const scenario of result.unexpectedFailures) {
      console.log(`  ✗ ${scenario}`);
    }
  }

  if (result.exitCode === 0) {
    console.log(
      `\n${COLORS.GREEN}Baseline check passed: all failures are expected.${COLORS.RESET}`
    );
  } else {
    if (result.staleEntries.length > 0) {
      console.log(
        `\n${COLORS.RED}Baseline is stale: update your expected-failures file to remove passing scenarios.${COLORS.RESET}`
      );
    }
    if (result.unexpectedFailures.length > 0) {
      console.log(
        `\n${COLORS.RED}Unexpected failures detected: these scenarios are not in your expected-failures baseline.${COLORS.RESET}`
      );
    }
  }
}
