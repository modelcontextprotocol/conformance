import { promises as fs } from 'fs';
import path from 'path';
import {
  ConformanceCheck,
  SpecVersion,
  LATEST_SPEC_VERSION,
  DRAFT_PROTOCOL_VERSION
} from '../types';
import { getClientScenario, isScenarioApplicableAt } from '../scenarios';
import { connectFor, type Connection, type RunContext } from '../connection';
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

/**
 * Hand a connection to the scenario while remembering it, so the runner can
 * terminate whatever the scenario did not.
 *
 * An explicit `conn.close()` removes it from `open` before delegating, so a
 * scenario that closes on its own path is not closed twice — a second
 * `close()` sends a second HTTP DELETE for the same session, which is exactly
 * the wire noise this is meant to avoid.
 *
 * `notifications` is exposed as a getter rather than copied: it is appended to
 * for the connection's lifetime, and scenarios read it after the requests that
 * produce the notifications.
 */
function trackConnection(open: Set<Connection>, conn: Connection): Connection {
  const tracked: Connection = {
    request: <R = unknown>(
      method: string,
      params?: Record<string, unknown>,
      extraHeaders?: Record<string, string>
    ) => conn.request<R>(method, params, extraHeaders),
    get notifications() {
      return conn.notifications;
    },
    discover: () => conn.discover(),
    close: async () => {
      open.delete(tracked);
      await conn.close();
    }
  };
  open.add(tracked);
  return tracked;
}

/**
 * Terminate every session the scenario left open.
 *
 * Scenarios overwhelmingly call `close()` as the last statement of a `try`,
 * so a scenario that throws — a `-32601` for a method the server does not
 * implement, a failed assertion — leaves its session and its standalone GET
 * stream open until the process exits. A server that caps concurrent sessions
 * per client then refuses the sessions of later scenarios, and their results
 * describe the harness rather than the server.
 *
 * This lives in the runner, not in a `finally` inside each scenario, because
 * `runScenarioBounded` abandons a timed-out scenario with its promise left
 * pending on purpose: that scenario's own `finally` never runs, so the runner
 * is the only place that can still close the connection.
 *
 * Failures are swallowed: the cleanup is best effort, and a server that has
 * already dropped the session must not turn into a scenario failure.
 */
async function closeOpenConnections(open: Set<Connection>): Promise<void> {
  const leaked = [...open];
  open.clear();
  for (const conn of leaked) {
    try {
      await conn.close();
    } catch {
      // best-effort teardown; the scenario's own result already stands
    }
  }
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
  // declared source so draft-only scenarios get the draft (stateless)
  // connection rather than the stateful latest-spec default. Extension
  // scenarios are off-timeline; today every extension in this repo lives
  // on draft, so they fall under the same inference.
  const resolvedSpecVersion =
    specVersion ??
    ('extensionId' in scenario.source ||
    scenario.source.introducedIn === DRAFT_PROTOCOL_VERSION
      ? DRAFT_PROTOCOL_VERSION
      : LATEST_SPEC_VERSION);

  console.log(
    `Running client scenario '${scenarioName}' against server: ${serverUrl}`
  );

  const openConnections = new Set<Connection>();
  let scenarioFinished = false;
  const ctx: RunContext = {
    serverUrl,
    specVersion: resolvedSpecVersion,
    connect: async (opts) => {
      if (scenarioFinished) {
        throw new Error(`Scenario '${scenarioName}' has already finished`);
      }
      const conn = await connectFor(resolvedSpecVersion)(serverUrl, opts);
      // A handshake can finish after the timeout's cleanup sweep. Close it
      // here and keep the abandoned scenario from issuing any more probes.
      if (scenarioFinished) {
        await conn.close();
        throw new Error(`Scenario '${scenarioName}' has already finished`);
      }
      return trackConnection(openConnections, conn);
    }
  };
  resetWireValidation();
  const checks = await runScenarioBounded(
    scenario.run(ctx),
    scenarioName,
    timeout
  );
  scenarioFinished = true;
  await closeOpenConnections(openConnections);
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
