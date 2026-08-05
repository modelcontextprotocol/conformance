import { execFileSync } from 'child_process';
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
import {
  notScoredScenarios,
  RequirementSet,
  scenariosToRun,
  scoredScenarios
} from '../../requirements';
import {
  ConformanceCheck,
  DRAFT_PROTOCOL_VERSION,
  ScenarioSpecTag,
  SpecVersion
} from '../../types';

const NON_SCORING_TAGS: ScenarioSpecTag[] = [
  DRAFT_PROTOCOL_VERSION,
  'extension'
];

/** Whether a scenario counts toward tier scoring (has at least one date-versioned spec). */
function isTierScoring(specVersions?: ScenarioSpecTag[]): boolean {
  if (!specVersions || specVersions.length === 0) return true; // unknown = count it
  return specVersions.some((v) => !NON_SCORING_TAGS.includes(v));
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
    const scenarioName = dirname(checksFile).replace(/\\/g, '/');
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
  resultPrefix?: string,
  /**
   * Names that count toward the pass rate. When a requirement set is in play it
   * decides this directly, so extensions and post-release additions are run and
   * reported but never scored. Undefined keeps the spec-version heuristic.
   */
  scoredNames?: Set<string>,
  notScoredReasons?: Map<string, string>
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

  // Normalise to the canonical scenario name. Results live in per-run
  // directories (`server-ping-<timestamp>`), and reporting that spelling means
  // a reported name does not match the same scenario in `list` or in a
  // requirement set.
  for (const detail of result.details) {
    let name = stripTimestamp(detail.scenario);
    if (resultPrefix) {
      name = name.replace(new RegExp(`^${resultPrefix}-`), '');
    }
    detail.scenario = name;
    detail.specVersions = getScenarioSpecVersions(name);
    const reason = notScoredReasons?.get(name);
    if (reason) detail.notScoredReason = reason;
  }

  for (const expected of expectedScenarios) {
    if (!reportedNames.has(expected)) {
      result.failed++;
      result.total++;
      const reason = notScoredReasons?.get(expected);
      result.details.push({
        scenario: expected,
        passed: false,
        checks_passed: 0,
        checks_failed: 0,
        specVersions: getScenarioSpecVersions(expected),
        ...(reason ? { notScoredReason: reason } : {})
      });
    }
  }

  // passed/failed/total describe the SCORED set, so they agree with pass_rate and
  // with the report. Counting every scenario here made the object self-
  // contradictory (passed 56, total 64, pass_rate 1) and invited 56/64 to be
  // quoted as the conformance rate. Anything run without being scored is
  // reported under not_scored instead.
  const tierDetails = scoredNames
    ? result.details.filter((d) => scoredNames.has(d.scenario))
    : result.details.filter((d) => isTierScoring(d.specVersions));
  const tierPassed = tierDetails.filter((d) => d.passed).length;
  const tierTotal = tierDetails.length;
  const unscored = result.details.filter((d) => !tierDetails.includes(d));

  result.passed = tierPassed;
  result.failed = tierTotal - tierPassed;
  result.total = tierTotal;
  result.not_scored = {
    total: unscored.length,
    failed: unscored.filter((d) => !d.passed).length
  };
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
 * Run the conformance CLI as a child. A non-zero exit is normal when scenarios
 * fail, so it is not itself an error; what matters is whether the child got far
 * enough to write results. Returns the child's stderr when it did not.
 */
function unmeasured(error: string): ConformanceResult {
  return {
    status: 'fail',
    pass_rate: 0,
    passed: 0,
    failed: 0,
    total: 0,
    details: [],
    error
  };
}

function runChild(args: string[]): string | undefined {
  try {
    execFileSync(process.execPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120_000
    });
    return undefined;
  } catch (error) {
    const e = error as { stderr?: Buffer; signal?: string };
    const stderr = e.stderr?.toString().trim();
    return stderr && stderr.length > 0
      ? stderr.split('\n').slice(-3).join(' ')
      : e.signal
        ? `conformance run terminated (${e.signal})`
        : undefined;
  }
}

/**
 * Run server conformance tests by shelling out to the conformance CLI.
 */
/** Merge per-revision results so a single pass rate spans every revision claimed. */
export function mergeByRevision(
  parts: { revision: string; result: ConformanceResult }[]
): ConformanceResult {
  if (parts.length === 1) return parts[0].result;
  const errored = parts.find((p) => p.result.error);
  if (errored)
    return unmeasured(`${errored.revision}: ${errored.result.error}`);
  const details = parts.flatMap((p) =>
    p.result.details.map((d) => ({ ...d, revision: p.revision }))
  );
  const scored = details.filter((d) => !d.notScoredReason);
  const passed = scored.filter((d) => d.passed).length;
  const unscored = details.filter((d) => d.notScoredReason);
  const pass_rate = scored.length > 0 ? passed / scored.length : 0;
  return {
    status: pass_rate >= 1 ? 'pass' : pass_rate >= 0.8 ? 'partial' : 'fail',
    pass_rate,
    passed,
    failed: scored.length - passed,
    total: scored.length,
    not_scored: {
      total: unscored.length,
      failed: unscored.filter((d) => !d.passed).length
    },
    details
  };
}

export async function checkConformance(options: {
  serverUrl?: string;
  skip?: boolean;
  specVersion?: SpecVersion;
  requirements?: RequirementSet;
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
  const args = [
    process.argv[1],
    'server',
    '--url',
    options.serverUrl,
    '-o',
    outputDir
  ];
  if (options.requirements) {
    args.push('--requirements', options.requirements.revision);
  } else if (options.specVersion) {
    args.push('--spec-version', options.specVersion);
  }

  const failure = runChild(args);

  const parsedServer = parseOutputDir(outputDir);
  if (failure && parsedServer.total === 0) return unmeasured(failure);

  if (options.requirements) {
    return reconcileWithExpected(
      parsedServer,
      scenariosToRun(options.requirements, 'server'),
      'server',
      new Set(scoredScenarios(options.requirements, 'server')),
      new Map(
        notScoredScenarios(options.requirements, 'server').map((e) => [
          e.scenario,
          e.reason
        ])
      )
    );
  }

  const activeScenarios = new Set(listActiveClientScenarios());
  const expectedScenarios = options.specVersion
    ? listClientScenariosForSpec(options.specVersion).filter((s) =>
        activeScenarios.has(s)
      )
    : [...activeScenarios];

  return reconcileWithExpected(parsedServer, expectedScenarios, 'server');
}

/**
 * Run client conformance tests by shelling out to the conformance CLI.
 */
export async function checkClientConformance(options: {
  clientCmd?: string;
  skip?: boolean;
  specVersion?: SpecVersion;
  requirements?: RequirementSet;
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
  const args = [
    process.argv[1],
    'client',
    '--command',
    options.clientCmd,
    '-o',
    outputDir
  ];
  if (options.requirements) {
    args.push('--requirements', options.requirements.revision);
  } else {
    args.push('--suite', 'all');
    if (options.specVersion) {
      args.push('--spec-version', options.specVersion);
    }
  }

  const failure = runChild(args);

  const parsedClient = parseOutputDir(outputDir);
  if (failure && parsedClient.total === 0) return unmeasured(failure);

  if (options.requirements) {
    return reconcileWithExpected(
      parsedClient,
      scenariosToRun(options.requirements, 'client'),
      undefined,
      new Set(scoredScenarios(options.requirements, 'client')),
      new Map(
        notScoredScenarios(options.requirements, 'client').map((e) => [
          e.scenario,
          e.reason
        ])
      )
    );
  }

  const expectedScenarios = options.specVersion
    ? listScenariosForSpec(options.specVersion)
    : listScenarios();

  return reconcileWithExpected(parsedClient, expectedScenarios);
}
