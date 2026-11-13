import { promises as fs } from 'fs';
import path from 'path';
import {
  ConformanceCheck,
  ScenarioSource,
  SpecVersion,
  LATEST_SPEC_VERSION,
  DRAFT_PROTOCOL_VERSION
} from '../types';
import { getClientScenario, isScenarioApplicableAt } from '../scenarios';
import { connectFor, type RunContext } from '../connection';
import {
  evaluateScenarioRequirements,
  isPlainObject
} from '../scenarios/server/requirements-check';
import {
  resetWireValidation,
  wireSchemaChecks
} from '../validation/wire-schema';
import { createResultDir, formatPrettyChecks } from './utils';

export interface ServerRunOptions {
  /**
   * When true, evaluate each scenario's declarative `requires` metadata
   * against the server's advertised capabilities and emit `SKIPPED` checks
   * for undeclared optional capabilities/extensions or fixture contracts.
   */
  production?: boolean;
  /**
   * Optional per-spec-version capability cache shared across scenarios in a
   * suite run so capability discovery happens at most once per wire version.
   */
  capabilitiesCache?: Map<SpecVersion, Record<string, unknown>>;
}

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

async function discoverServerCapabilities(
  serverUrl: string,
  specVersion: SpecVersion,
  timeout: number,
  cache?: Map<SpecVersion, Record<string, unknown>>
): Promise<Record<string, unknown> | null> {
  if (cache?.has(specVersion)) {
    return cache.get(specVersion)!;
  }

  let timeoutHandle: NodeJS.Timeout | undefined;
  const probe = (async () => {
    const conn = await connectFor(specVersion)(serverUrl);
    try {
      const discovered = await conn.discover();
      return isPlainObject(discovered.capabilities)
        ? discovered.capabilities
        : {};
    } finally {
      await conn.close().catch(() => {});
    }
  })();
  probe.catch(() => {});

  try {
    const result = await Promise.race([
      probe,
      new Promise<null>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(null), timeout);
      })
    ]);
    if (result !== null) {
      cache?.set(specVersion, result);
    }
    return result;
  } catch {
    // Discovery failed (unreachable server or broken handshake). Return null
    // so the scenario executes and surfaces the real protocol/network failure
    // rather than falsely skipping.
    return null;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function writeChecksIfNeeded(
  resultDir: string | undefined,
  checks: ConformanceCheck[]
): Promise<void> {
  if (!resultDir) return;
  await fs.writeFile(
    path.join(resultDir, 'checks.json'),
    JSON.stringify(checks, null, 2)
  );
  console.log(`Results saved to ${resultDir}`);
}

function logSpecVersionSkipIfNeeded(
  scenarioName: string,
  source: ScenarioSource,
  specVersion: SpecVersion | undefined,
  force: boolean
): boolean {
  if (
    specVersion === undefined ||
    force ||
    isScenarioApplicableAt(source, specVersion)
  ) {
    return false;
  }

  const introduced =
    'introducedIn' in source
      ? `introduced in ${source.introducedIn}` +
        (source.removedIn !== undefined
          ? `, removed in ${source.removedIn}`
          : '')
      : 'extension scenario, not on the spec timeline';
  console.log(
    `SKIPPED: scenario '${scenarioName}' is not applicable at spec version ` +
      `${specVersion} (${introduced}). Use --force to run it anyway.`
  );
  return true;
}

function resolveDefaultSpecVersion(
  source: ScenarioSource,
  specVersion?: SpecVersion
): SpecVersion {
  if (specVersion) return specVersion;
  return 'extensionId' in source ||
    source.introducedIn === DRAFT_PROTOCOL_VERSION
    ? DRAFT_PROTOCOL_VERSION
    : LATEST_SPEC_VERSION;
}

async function evaluateProductionSkip(
  serverUrl: string,
  scenarioName: string,
  requires: NonNullable<ReturnType<typeof getClientScenario>>['requires'],
  resolvedSpecVersion: SpecVersion,
  timeout: number,
  options?: ServerRunOptions
): Promise<ConformanceCheck[] | null> {
  if (!options?.production || !requires) return null;
  resetWireValidation();
  const capabilities = await discoverServerCapabilities(
    serverUrl,
    resolvedSpecVersion,
    timeout,
    options.capabilitiesCache
  );
  if (capabilities === null) return null;

  const skippedCheck = evaluateScenarioRequirements(
    scenarioName,
    requires,
    capabilities
  );
  if (!skippedCheck) return null;

  const discoverySchemaFailures = wireSchemaChecks(resolvedSpecVersion).filter(
    (c) => c.status === 'FAILURE'
  );
  console.log(`SKIPPED: ${skippedCheck.description}`);
  return [skippedCheck, ...discoverySchemaFailures];
}

export async function runServerConformanceTest(
  serverUrl: string,
  scenarioName: string,
  outputDir?: string,
  specVersion?: SpecVersion,
  force = false,
  timeout: number = 30000,
  options?: ServerRunOptions
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

  const scenario = getClientScenario(scenarioName)!;
  if (
    logSpecVersionSkipIfNeeded(
      scenarioName,
      scenario.source,
      specVersion,
      force
    )
  ) {
    return {
      checks: [],
      resultDir,
      scenarioDescription: scenario.description,
      skipped: true
    };
  }

  const resolvedSpecVersion = resolveDefaultSpecVersion(
    scenario.source,
    specVersion
  );
  const skippedChecks = await evaluateProductionSkip(
    serverUrl,
    scenarioName,
    scenario.requires,
    resolvedSpecVersion,
    timeout,
    options
  );
  if (skippedChecks) {
    await writeChecksIfNeeded(resultDir, skippedChecks);
    return {
      checks: skippedChecks,
      resultDir,
      scenarioDescription: scenario.description
    };
  }

  console.log(
    `Running client scenario '${scenarioName}' against server: ${serverUrl}`
  );
  const ctx: RunContext = {
    serverUrl,
    specVersion: resolvedSpecVersion,
    production: Boolean(options?.production),
    connect: (opts) => connectFor(resolvedSpecVersion)(serverUrl, opts)
  };
  resetWireValidation();
  const checks = await runScenarioBounded(
    scenario.run(ctx),
    scenarioName,
    timeout
  );
  checks.push(...wireSchemaChecks(resolvedSpecVersion));
  await writeChecksIfNeeded(resultDir, checks);

  return { checks, resultDir, scenarioDescription: scenario.description };
}

export function printServerResults(
  checks: ConformanceCheck[],
  scenarioDescription: string,
  verbose: boolean = false
): {
  passed: number;
  failed: number;
  skipped: number;
  denominator: number;
  warnings: number;
} {
  const denominator = checks.filter(
    (c) => c.status === 'SUCCESS' || c.status === 'FAILURE'
  ).length;
  const passed = checks.filter((c) => c.status === 'SUCCESS').length;
  const failed = checks.filter((c) => c.status === 'FAILURE').length;
  const skipped = checks.filter((c) => c.status === 'SKIPPED').length;
  const warnings = checks.filter((c) => c.status === 'WARNING').length;

  if (verbose) {
    console.log(JSON.stringify(checks, null, 2));
  } else {
    console.log(`Checks:\n${formatPrettyChecks(checks)}`);
  }

  const skippedSuffix = skipped > 0 ? `, ${skipped} skipped` : '';
  console.log(`\nTest Results:`);
  console.log(
    `Passed: ${passed}/${denominator}, ${failed} failed, ${warnings} warnings${skippedSuffix}`
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

  return { passed, failed, skipped, denominator, warnings };
}

export function printServerSummary(
  allResults: { scenario: string; checks: ConformanceCheck[] }[]
): { totalPassed: number; totalFailed: number; totalSkipped: number } {
  console.log('\n\n=== SUMMARY ===');
  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  for (const result of allResults) {
    const passed = result.checks.filter((c) => c.status === 'SUCCESS').length;
    const failed = result.checks.filter((c) => c.status === 'FAILURE').length;
    const skipped = result.checks.filter((c) => c.status === 'SKIPPED').length;
    totalPassed += passed;
    totalFailed += failed;
    totalSkipped += skipped;

    if (passed === 0 && failed === 0 && skipped > 0) {
      console.log(`- ${result.scenario}: ${skipped} skipped`);
      continue;
    }

    const status = failed === 0 ? '✓' : '✗';
    const skippedSuffix = skipped > 0 ? `, ${skipped} skipped` : '';
    console.log(
      `${status} ${result.scenario}: ${passed} passed, ${failed} failed${skippedSuffix}`
    );
  }

  const totalSkippedSuffix =
    totalSkipped > 0 ? `, ${totalSkipped} skipped` : '';
  console.log(
    `\nTotal: ${totalPassed} passed, ${totalFailed} failed${totalSkippedSuffix}`
  );

  return { totalPassed, totalFailed, totalSkipped };
}
