import { promises as fs } from 'fs';
import path from 'path';
import { ConformanceCheck, SpecVersion } from '../types';
import {
  defaultSpecVersionFor,
  getClientScenario,
  isScenarioApplicableAt
} from '../scenarios';
import { connectFor, type RunContext } from '../connection';
import {
  resetWireValidation,
  wireSchemaChecks
} from '../validation/wire-schema';
import { createResultDir, formatPrettyChecks } from './utils';

/**
 * Format markdown-style text for terminal output using ANSI codes
 */
function formatMarkdown(text: string): string {
  return (
    text
      // Bold text: **text** -> bold
      .replace(/\*\*([^*]+)\*\*/g, '\x1b[1m$1\x1b[0m')
      // Inline code: `code` -> dim/gray
      .replace(/`([^`]+)`/g, '\x1b[2m$1\x1b[0m')
  );
}

/**
 * Bound `scenario.run` so a server that accepts connections but never answers
 * fails one scenario instead of stalling the whole suite.
 *
 * The losing promise is left pending on purpose: a scenario blocked on a socket
 * read has no cancellation channel, so there is nothing to await. Its rejection
 * is swallowed to keep a late failure from surfacing as an unhandled rejection
 * against whichever scenario happens to be running by then.
 */
async function runScenarioBounded(
  run: Promise<ConformanceCheck[]>,
  scenarioName: string,
  timeout: number
): Promise<ConformanceCheck[]> {
  const timedOut = Symbol('timed-out');
  let timeoutHandle: NodeJS.Timeout | undefined;

  run.catch(() => {});

  const result = await Promise.race([
    run,
    new Promise<typeof timedOut>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(timedOut), timeout);
    })
  ]);
  clearTimeout(timeoutHandle);

  if (result !== timedOut) {
    return result;
  }

  console.log(`\nScenario timed out after ${timeout}ms`);
  return [
    {
      id: 'scenario-timeout',
      name: 'Scenario completes within the timeout',
      description:
        'The scenario must finish within the configured timeout. A server that ' +
        'accepts the connection but never responds leaves it running forever.',
      status: 'FAILURE',
      timestamp: new Date().toISOString(),
      errorMessage: `Scenario '${scenarioName}' did not complete within ${timeout}ms. The server under test accepted the connection but did not finish the exchange.`
    }
  ];
}

export async function runServerConformanceTest(
  serverUrl: string,
  scenarioName: string,
  outputDir?: string,
  specVersion?: SpecVersion,
  force = false,
  timeout: number = 30000
): Promise<{
  checks: ConformanceCheck[];
  resultDir?: string;
  scenarioDescription: string;
  skipped?: boolean;
}> {
  let resultDir: string | undefined;

  if (outputDir) {
    resultDir = createResultDir(outputDir, scenarioName, 'server');
    await fs.mkdir(resultDir, { recursive: true });
  }

  // Scenario is guaranteed to exist by CLI validation
  const scenario = getClientScenario(scenarioName)!;

  // An explicitly-requested spec version outside the scenario's applicability
  // window is a contradiction: running anyway would test something other than
  // what the flag claims. Skip (exit 0) unless --force.
  if (
    specVersion !== undefined &&
    !force &&
    !isScenarioApplicableAt(scenario.source, specVersion)
  ) {
    const introduced =
      'introducedIn' in scenario.source
        ? `introduced in ${scenario.source.introducedIn}` +
          (scenario.source.removedIn !== undefined
            ? `, removed in ${scenario.source.removedIn}`
            : '')
        : 'extension scenario, not on the spec timeline';
    console.log(
      `SKIPPED: scenario '${scenarioName}' is not applicable at spec version ` +
        `${specVersion} (${introduced}). Use --force to run it anyway.`
    );
    return {
      checks: [],
      resultDir,
      scenarioDescription: scenario.description,
      skipped: true
    };
  }

  // When --spec-version is omitted, infer the version from the scenario's
  // declared source so each scenario gets a connection speaking a wire it was
  // written for: the latest release when it applies there, otherwise the
  // newest revision in its window (draft-only → draft, removed → the last
  // release before). Extension scenarios are off-timeline and run at the
  // latest release.
  const resolvedSpecVersion =
    specVersion ?? defaultSpecVersionFor(scenario.source);

  console.log(
    `Running client scenario '${scenarioName}' against server: ${serverUrl}`
  );

  const ctx: RunContext = {
    serverUrl,
    specVersion: resolvedSpecVersion,
    connect: (opts) => connectFor(resolvedSpecVersion)(serverUrl, opts)
  };
  resetWireValidation();
  const checks = await runScenarioBounded(
    scenario.run(ctx),
    scenarioName,
    timeout
  );
  checks.push(...wireSchemaChecks(resolvedSpecVersion));

  if (resultDir) {
    await fs.writeFile(
      path.join(resultDir, 'checks.json'),
      JSON.stringify(checks, null, 2)
    );

    console.log(`Results saved to ${resultDir}`);
  }

  return {
    checks,
    resultDir,
    scenarioDescription: scenario.description
  };
}

export function printServerResults(
  checks: ConformanceCheck[],
  scenarioDescription: string,
  verbose: boolean = false
): {
  passed: number;
  failed: number;
  denominator: number;
  warnings: number;
} {
  const denominator = checks.filter(
    (c) => c.status === 'SUCCESS' || c.status === 'FAILURE'
  ).length;
  const passed = checks.filter((c) => c.status === 'SUCCESS').length;
  const failed = checks.filter((c) => c.status === 'FAILURE').length;
  const warnings = checks.filter((c) => c.status === 'WARNING').length;

  if (verbose) {
    console.log(JSON.stringify(checks, null, 2));
  } else {
    console.log(`Checks:\n${formatPrettyChecks(checks)}`);
  }

  console.log(`\nTest Results:`);
  console.log(
    `Passed: ${passed}/${denominator}, ${failed} failed, ${warnings} warnings`
  );

  if (failed > 0) {
    console.log('\n=== Failed Checks ===');
    checks
      .filter((c) => c.status === 'FAILURE')
      .forEach((c) => {
        console.log(`\n  - ${c.name}: ${c.description}`);
        if (c.errorMessage) {
          console.log(`    Error: ${c.errorMessage}`);
        }
        console.log(`\n${formatMarkdown(scenarioDescription)}`);
      });
  }

  return { passed, failed, denominator, warnings };
}

export function printServerSummary(
  allResults: { scenario: string; checks: ConformanceCheck[] }[]
): { totalPassed: number; totalFailed: number } {
  console.log('\n\n=== SUMMARY ===');
  let totalPassed = 0;
  let totalFailed = 0;

  for (const result of allResults) {
    const passed = result.checks.filter((c) => c.status === 'SUCCESS').length;
    const failed = result.checks.filter((c) => c.status === 'FAILURE').length;
    totalPassed += passed;
    totalFailed += failed;

    const status = failed === 0 ? '✓' : '✗';
    console.log(
      `${status} ${result.scenario}: ${passed} passed, ${failed} failed`
    );
  }

  console.log(`\nTotal: ${totalPassed} passed, ${totalFailed} failed`);

  return { totalPassed, totalFailed };
}
