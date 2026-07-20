import { promises as fs } from 'fs';
import { parse as parseYaml } from 'yaml';
import { ConformanceCheck } from './types';
import { COLORS } from './runner/utils';
import { collapseDuplicateChecks } from './checks/collapse';

/**
 * One line of a baseline list, parsed.
 *
 * Written as `<scenario>` to allow a whole scenario to fail, or
 * `<scenario>:<check-id>` to allow only that check to.
 */
export interface BaselineEntry {
  scenario: string;
  /** When set, only this check may fail; the scenario's others stay enforced. */
  checkId?: string;
}

export interface ExpectedFailures {
  server?: BaselineEntry[];
  client?: BaselineEntry[];
}

export interface BaselineResult {
  /** Exit code: 0 if only expected failures, 1 if unexpected failures or stale baseline */
  exitCode: number;
  /** Entries that failed unexpectedly (not in baseline), formatted as written */
  unexpectedFailures: string[];
  /** Entries in baseline that now pass (stale entries), formatted as written */
  staleEntries: string[];
  /** Entries that failed as expected, formatted as written */
  expectedFailures: string[];
}

/** Render an entry back in the form a user writes it. */
export function formatEntry(entry: BaselineEntry): string {
  return entry.checkId ? `${entry.scenario}:${entry.checkId}` : entry.scenario;
}

/**
 * Parse and validate one baseline list. This is the only place that knows the
 * entry grammar: everything downstream consumes `BaselineEntry`.
 *
 * Scenario names contain slashes but never colons (`auth/basic-dcr`), and no
 * check id contains one, so the first colon is an unambiguous delimiter.
 */
function parseEntryList(entries: unknown[], section: string): BaselineEntry[] {
  const reject = (entry: unknown, why: string): never => {
    throw new Error(
      `Invalid expected-failures file: '${section}' entry ${JSON.stringify(entry)} ` +
        `is not '<scenario>' or '<scenario>:<check-id>'. ${why}`
    );
  };

  const parsed = entries.map((entry): BaselineEntry => {
    if (entry === null || entry === undefined) {
      return reject(entry, 'This one is empty.');
    }
    if (typeof entry === 'object') {
      // A mapping means a space crept in after the colon. Only say so when the
      // parse is actually consistent with that — one key, one non-empty scalar
      // value. Reconstructing the user's line from anything else quotes a line
      // they never wrote.
      const pairs = Array.isArray(entry)
        ? []
        : Object.entries(entry as Record<string, unknown>);
      const [key, value] = pairs[0] ?? [];
      const isSpaceTypo =
        pairs.length === 1 &&
        value !== null &&
        value !== undefined &&
        typeof value !== 'object' &&
        String(value) !== '';
      return reject(
        entry,
        isSpaceTypo
          ? `Did you write '- ${key}: ${value}'? Remove the space after the colon: '- ${key}:${value}'`
          : 'A per-check entry takes no space after the colon.'
      );
    }

    const text = String(entry);
    const sep = text.indexOf(':');
    if (sep === -1) {
      return { scenario: text };
    }
    const scenario = text.slice(0, sep);
    const checkId = text.slice(sep + 1);
    if (!scenario || !checkId) {
      return reject(entry, 'Both sides of the colon are required.');
    }
    return { scenario, checkId };
  });

  const wholesale = new Set(
    parsed.filter((e) => !e.checkId).map((e) => e.scenario)
  );
  for (const entry of parsed) {
    if (entry.checkId && wholesale.has(entry.scenario)) {
      throw new Error(
        `Invalid expected-failures file: '${entry.scenario}' expects the whole scenario to fail, ` +
          `so '${formatEntry(entry)}' is redundant. Remove one or the other.`
      );
    }
  }
  return parsed;
}

/**
 * Load and parse an expected-failures YAML file.
 *
 * Expected format:
 * ```yaml
 * server:
 *   - scenario-name-1              # whole scenario may fail
 *   - scenario-name-2:check-id     # only this check may fail
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

  for (const section of ['server', 'client'] as const) {
    const list = parsed[section];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      throw new Error(
        `Invalid expected-failures file: '${section}' must be an array of scenario names`
      );
    }
    result[section] = parseEntryList(list, section);
  }

  return result;
}

/**
 * Evaluate scenario results against an expected-failures baseline.
 *
 * Whole-scenario entry (`{ scenario }`) — unchanged from the original behaviour:
 * - Scenario fails and IS in baseline → expected (ok)
 * - Scenario fails and is NOT in baseline → unexpected failure (exit 1)
 * - Scenario passes and IS in baseline → stale entry (exit 1, must update baseline)
 * - Scenario passes and is NOT in baseline → normal pass (ok)
 *
 * Per-check entry (`{ scenario, checkId }`) — every failing check in that
 * scenario is judged on its own, so one baselined check no longer excuses the
 * other twenty:
 * - Check fails and IS in baseline → expected (ok)
 * - Check fails and is NOT in baseline → unexpected failure (exit 1)
 * - Check passes and IS in baseline → stale entry (exit 1)
 * - Check is absent or SKIPPED → no signal, tolerated
 *
 * A check id addresses every occurrence of that id, not one: ids repeat within
 * a run (a loop, a retried flow), so the occurrences are collapsed most-severe-
 * first before matching. Baselining an id that repeats therefore excuses all of
 * its occurrences — coarser than ideal, still far narrower than the scenario.
 *
 * Absent and SKIPPED are tolerated for the same reason the runner already
 * treats them as green (AGENTS.md, "Check conventions"): neither reports a
 * requirement violated. The cost is that an entry naming a check that no longer
 * exists — renamed, deleted, or typo'd — sits unnoticed. Whole-scenario entries
 * already carry that weakness for scenarios outside the selected suite.
 */
export function evaluateBaseline(
  results: { scenario: string; checks: ConformanceCheck[] }[],
  expectedEntries: BaselineEntry[]
): BaselineResult {
  const scenarios = new Set(
    expectedEntries.filter((e) => !e.checkId).map((e) => e.scenario)
  );
  const checksByScenario = new Map<string, Set<string>>();
  for (const entry of expectedEntries) {
    if (!entry.checkId) continue;
    const ids = checksByScenario.get(entry.scenario) ?? new Set<string>();
    ids.add(entry.checkId);
    checksByScenario.set(entry.scenario, ids);
  }

  const unexpectedFailures: string[] = [];
  const staleEntries: string[] = [];
  const expectedFailures: string[] = [];

  const isFailed = (c: ConformanceCheck) =>
    c.status === 'FAILURE' || c.status === 'WARNING';

  for (const result of results) {
    if (scenarios.has(result.scenario)) {
      const hasFailed = result.checks.some(isFailed);
      if (hasFailed) expectedFailures.push(result.scenario);
      else staleEntries.push(result.scenario);
      continue;
    }

    const expectedChecks = checksByScenario.get(result.scenario);
    if (!expectedChecks) {
      if (result.checks.some(isFailed))
        unexpectedFailures.push(result.scenario);
      continue;
    }

    const collapsed = collapseDuplicateChecks(result.checks);
    for (const c of collapsed.filter(isFailed)) {
      const entry = formatEntry({ scenario: result.scenario, checkId: c.id });
      (expectedChecks.has(c.id) ? expectedFailures : unexpectedFailures).push(
        entry
      );
    }
    for (const id of expectedChecks) {
      // Only a demonstrated pass makes the entry stale. Absent and SKIPPED
      // report no requirement violated, so they leave the entry alone; a
      // failure was already recorded above. INFO entries are kept rather than
      // collapsed, so one can sit ahead of the real verdict for this id.
      const emitted = collapsed.find((c) => c.id === id && c.status !== 'INFO');
      if (emitted?.status === 'SUCCESS') {
        staleEntries.push(
          formatEntry({ scenario: result.scenario, checkId: id })
        );
      }
    }
  }

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
    for (const entry of result.expectedFailures) {
      console.log(`  ~ ${entry}`);
    }
  }

  if (result.staleEntries.length > 0) {
    console.log(
      `\n${COLORS.RED}Stale baseline entries (now passing - remove from baseline):${COLORS.RESET}`
    );
    for (const entry of result.staleEntries) {
      console.log(`  ✓ ${entry}`);
    }
  }

  if (result.unexpectedFailures.length > 0) {
    console.log(
      `\n${COLORS.RED}Unexpected failures (not in baseline):${COLORS.RESET}`
    );
    for (const entry of result.unexpectedFailures) {
      console.log(`  ✗ ${entry}`);
    }
  }

  if (result.exitCode === 0) {
    console.log(
      `\n${COLORS.GREEN}Baseline check passed: all failures are expected.${COLORS.RESET}`
    );
  } else {
    if (result.staleEntries.length > 0) {
      console.log(
        `\n${COLORS.RED}Baseline is stale: update your expected-failures file to remove passing entries.${COLORS.RESET}`
      );
    }
    if (result.unexpectedFailures.length > 0) {
      console.log(
        `\n${COLORS.RED}Unexpected failures detected: these are not in your expected-failures baseline.${COLORS.RESET}`
      );
    }
  }
}
