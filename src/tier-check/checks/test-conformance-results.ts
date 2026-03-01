import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, existsSync, globSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { ConformanceResult } from '../types';
import {
  listScenarios,
  listActiveClientScenarios,
  listScenariosForSpec,
  listClientScenariosForSpec,
  getScenarioSpecVersions
} from '../../scenarios';
import { ConformanceCheck, SpecVersion } from '../../types';

const NON_SCORING_VERSIONS: SpecVersion[] = ['draft', 'extension'];

/** Whether a scenario counts toward tier scoring (has at least one date-versioned spec). */
function isTierScoring(specVersions?: SpecVersion[]): boolean {
  if (!specVersions || specVersions.length === 0) return true; // unknown = count it
  return specVersions.some((v) => !NON_SCORING_VERSIONS.includes(v));
}

/**
 * Parse conformance results from an output directory.
 * The conformance CLI saves checks.json per scenario under outputDir/<scenario>/server/ or client/.
 */
function parseOutputDir(outputDir: string): ConformanceResult {
  if (!existsSync(outputDir)) {
    return {
      status: 'fail',
      pass_rate: 0,
      passed: 0,
      failed: 0,
      total: 0,
      details: []
    };
  }

  const details: ConformanceResult['details'] = [];
  let totalPassed = 0;
  let totalFailed = 0;

  // Find all checks.json files recursively to handle scenarios with '/' in
  // their name (e.g. auth/metadata-default) which create nested subdirectories.
  const checksFiles = globSync('**/checks.json', { cwd: outputDir });

  for (const checksFile of checksFiles) {
    const scenarioName = dirname(checksFile);
    const checksPath = join(outputDir, checksFile);

    try {
      const checks: ConformanceCheck[] = JSON.parse(
        readFileSync(checksPath, 'utf-8')
      );
      const passed = checks.filter((c) => c.status === 'SUCCESS').length;
      const failed = checks.filter((c) => c.status === 'FAILURE').length;
      const scenarioPassed = failed === 0 && passed > 0;

      totalPassed += scenarioPassed ? 1 : 0;
      totalFailed += scenarioPassed ? 0 : 1;
      details.push({
        scenario: scenarioName,
        passed: scenarioPassed,
        checks_passed: passed,
        checks_failed: failed
      });
    } catch {
      totalFailed++;
      details.push({
        scenario: scenarioName,
        passed: false,
        checks_passed: 0,
        checks_failed: 1
      });
    }
  }

  const total = totalPassed + totalFailed;
  const pass_rate = total > 0 ? totalPassed / total : 0;

  return {
    status: pass_rate >= 1.0 ? 'pass' : pass_rate >= 0.8 ? 'partial' : 'fail',
    pass_rate,
    passed: totalPassed,
    failed: totalFailed,
    total,
    details
  };
}

/**
 * Strip the timestamp suffix from a result directory name.
 * Result dirs are named `{scenario}-{ISO timestamp}` where the timestamp
 * has colons/dots replaced with dashes (e.g., `initialize-2026-02-12T16-08-37-806Z`).
 * Server scenarios also have a `server-` prefix (e.g., `server-ping-2026-02-12T16-08-37-806Z`).
 */
function stripTimestamp(dirName: string): string {
  return dirName.replace(/-\d{4}-\d{2}-\d{2}T[\d-]+Z$/, '');
}

/**
 * Reconcile parsed results against the full list of expected scenarios.
 * Any expected scenario that didn't produce results is counted as a failure.
 * This ensures the denominator reflects the full test suite, not just
 * scenarios that ran successfully enough to write checks.json.
 */
function reconcileWithExpected(
  result: ConformanceResult,
  expectedScenarios: string[],
  resultPrefix?: string
): ConformanceResult {
  const reportedNames = new Set(
    result.details.map((d) => {
      let name = stripTimestamp(d.scenario);
      if (resultPrefix) {
        name = name.replace(new RegExp(`^${resultPrefix}-`), '');
      }
      return name;
    })
  );

  // Attach specVersion to existing detail entries
  for (const detail of result.details) {
    let name = stripTimestamp(detail.scenario);
    if (resultPrefix) {
      name = name.replace(new RegExp(`^${resultPrefix}-`), '');
    }
    detail.specVersions = getScenarioSpecVersions(name);
  }

  for (const expected of expectedScenarios) {
    if (!reportedNames.has(expected)) {
      result.failed++;
      result.total++;
      result.details.push({
        scenario: expected,
        passed: false,
        checks_passed: 0,
        checks_failed: 0,
        specVersions: getScenarioSpecVersions(expected)
      });
    }
  }

  // pass_rate only counts tier-scoring scenarios (date-versioned, not draft/extension).
  // passed/failed/total reflect ALL scenarios for full reporting; pass_rate and status
  // reflect only tier-scoring scenarios for tier logic.
  const tierDetails = result.details.filter((d) =>
    isTierScoring(d.specVersions)
  );
  const tierPassed = tierDetails.filter((d) => d.passed).length;
  const tierTotal = tierDetails.length;

  result.pass_rate = tierTotal > 0 ? tierPassed / tierTotal : 0;
  result.status =
    result.pass_rate >= 1.0
      ? 'pass'
      : result.pass_rate >= 0.8
        ? 'partial'
        : 'fail';

  return result;
}

/**
 * Run server conformance tests by shelling out to the conformance CLI.
 */
export async function checkConformance(options: {
  serverUrl?: string;
  skip?: boolean;
  specVersion?: SpecVersion;
}): Promise<ConformanceResult> {
  if (options.skip || !options.serverUrl) {
    return {
      status: 'skipped',
      pass_rate: 0,
      passed: 0,
      failed: 0,
      total: 0,
      details: []
    };
  }

  const outputDir = mkdtempSync(join(tmpdir(), 'tier-check-server-'));
  const specVersionArg = options.specVersion
    ? `--spec-version ${options.specVersion}`
    : '';

  try {
    execSync(
      `node dist/index.js server --url ${options.serverUrl} -o ${outputDir} ${specVersionArg}`,
      {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120_000
      }
    );
  } catch {
    // Non-zero exit is expected when tests fail — results are still in outputDir
  }

  const activeScenarios = new Set(listActiveClientScenarios());
  const expectedScenarios = options.specVersion
    ? listClientScenariosForSpec(options.specVersion).filter((s) =>
        activeScenarios.has(s)
      )
    : [...activeScenarios];

  return reconcileWithExpected(
    parseOutputDir(outputDir),
    expectedScenarios,
    'server'
  );
}

/**
 * Run client conformance tests by shelling out to the conformance CLI.
 */
export async function checkClientConformance(options: {
  clientCmd?: string;
  skip?: boolean;
  specVersion?: SpecVersion;
}): Promise<ConformanceResult> {
  if (options.skip || !options.clientCmd) {
    return {
      status: 'skipped',
      pass_rate: 0,
      passed: 0,
      failed: 0,
      total: 0,
      details: []
    };
  }

  const outputDir = mkdtempSync(join(tmpdir(), 'tier-check-client-'));
  const specVersionArg = options.specVersion
    ? `--spec-version ${options.specVersion}`
    : '';

  try {
    execSync(
      `node dist/index.js client --command '${options.clientCmd}' --suite all -o ${outputDir} ${specVersionArg}`,
      {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120_000
      }
    );
  } catch {
    // Non-zero exit is expected when tests fail — results are still in outputDir
  }

  const expectedScenarios = options.specVersion
    ? listScenariosForSpec(options.specVersion)
    : listScenarios();

  return reconcileWithExpected(parseOutputDir(outputDir), expectedScenarios);
}
