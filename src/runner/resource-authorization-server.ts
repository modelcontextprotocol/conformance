import { promises as fs } from 'fs';
import path from 'path';
import { ConformanceCheck } from '../types';
import { getScenarioForResourceAuthorizationServer } from '../scenarios';
import { createResultDir, formatPrettyChecks } from './utils';
import { ResourceAuthorizationServerOptions } from '../schemas';
import { IdPAuthorizationServer } from '../scenarios/ema/auth/helpers/provideIdPAuthorizationServer';
import {
  TRUSTED_IDP_DETAIL,
  UNTRUSTED_IDP_DETAIL
} from '../scenarios/ema/resource-authorization-server/support';

export async function runResourceAuthorizationServerConformanceTest(
  options: ResourceAuthorizationServerOptions,
  scenarioName: string,
  details: Record<string, unknown>,
  outputDir?: string
): Promise<{
  checks: ConformanceCheck[];
  resultDir?: string;
  scenarioDescription: string;
}> {
  let resultDir: string | undefined;

  if (outputDir) {
    resultDir = createResultDir(
      outputDir,
      scenarioName,
      'resource-authorization-server'
    );
    await fs.mkdir(resultDir, { recursive: true });
  }

  // Scenario is guaranteed to exist by CLI validation
  const scenario = getScenarioForResourceAuthorizationServer(scenarioName)!;

  console.log(
    `Running scenario '${scenarioName}' against resource authorization server: ${options.url}`
  );

  const checks = await scenario.run(options, details);

  if (resultDir) {
    await fs.writeFile(
      path.join(resultDir, 'checks.json'),
      JSON.stringify(checks, null, 2)
    );

    console.log(`Results saved to ${resultDir}`);
  }

  return { checks, resultDir, scenarioDescription: scenario.description };
}

export function printResourceAuthorizationServerResults(
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
      });
  }

  return { passed, failed, denominator, warnings };
}

export function printResourceAuthorizationServerSummary(
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

/**
 * Start the runner-hosted IdP AS instance(s) these scenarios mint ID-JAGs
 * with, and package them into the `details` bag the way scenarios expect
 * (see `scenarios/ema/resource-authorization-server/support.ts`). The target
 * Resource AS must independently be configured (out of band) to trust the
 * printed issuer(s) before running scenarios that require them; scenarios
 * that don't (e.g. the untrusted-IdP negative test needing only the trusted
 * one) SKIP gracefully when a detail is absent.
 *
 * `options.trustedIdpIssuer`/`untrustedIdpIssuer` let a tester front this
 * process with a stable URL instead of the ephemeral localhost one: a
 * `http://localhost:PORT`/`http://127.0.0.1:PORT` value binds directly to
 * that port (so a locally-running Resource AS can be preconfigured with it
 * ahead of time), while any other URL is expected to be fronted by a
 * tunnel/proxy forwarding to the printed local address.
 */
export async function startIdps(
  options: ResourceAuthorizationServerOptions
): Promise<{
  details: Record<string, unknown>;
  stop: () => Promise<void>;
}> {
  const trustedIdp = await IdPAuthorizationServer.create({
    issuer: options.trustedIdpIssuer
  });
  await trustedIdp.start();

  const untrustedIdp = await IdPAuthorizationServer.create({
    issuer: options.untrustedIdpIssuer
  });
  await untrustedIdp.start();

  console.log('Started runner-hosted IdP Authorization Server(s):');
  console.log(`  trusted   issuer: ${trustedIdp.issuer}`);
  console.log(`            local:  ${trustedIdp.localUrl}`);
  console.log(`  untrusted issuer: ${untrustedIdp.issuer}`);
  console.log(`            local:  ${untrustedIdp.localUrl}`);
  console.log(
    'The target Resource AS must already be configured to trust the ' +
      'trusted issuer above (and, for scenario 8, know of but not trust the ' +
      'untrusted one) before running scenarios that need them.\n'
  );

  return {
    details: {
      [TRUSTED_IDP_DETAIL]: trustedIdp,
      [UNTRUSTED_IDP_DETAIL]: untrustedIdp
    },
    stop: async () => {
      await trustedIdp.stop();
      await untrustedIdp.stop();
    }
  };
}
