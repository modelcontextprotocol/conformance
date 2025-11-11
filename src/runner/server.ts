import { promises as fs } from 'fs';
import path from 'path';
import { ConformanceCheck } from '../types';
import { getClientScenario } from '../scenarios';
import { ensureResultsDir, createResultDir } from './utils';

export async function runServerConformanceTest(
  serverUrl: string,
  scenarioName: string
): Promise<{
  checks: ConformanceCheck[];
  resultDir: string;
}> {
  await ensureResultsDir();
  const resultDir = createResultDir(scenarioName, 'server');
  await fs.mkdir(resultDir, { recursive: true });

  // Scenario is guaranteed to exist by CLI validation
  const scenario = getClientScenario(scenarioName)!;

  console.log(
    `Running client scenario '${scenarioName}' against server: ${serverUrl}`
  );

  const checks = await scenario.run(serverUrl);

  await fs.writeFile(
    path.join(resultDir, 'checks.json'),
    JSON.stringify(checks, null, 2)
  );

  console.log(`Results saved to ${resultDir}`);

  return {
    checks,
    resultDir
  };
}

export function printServerResults(checks: ConformanceCheck[]): {
  passed: number;
  failed: number;
  denominator: number;
} {
  const denominator = checks.filter(
    (c) => c.status === 'SUCCESS' || c.status === 'FAILURE'
  ).length;
  const passed = checks.filter((c) => c.status === 'SUCCESS').length;
  const failed = checks.filter((c) => c.status === 'FAILURE').length;

  console.log(`Checks:\n${JSON.stringify(checks, null, 2)}`);

  console.log(`\nTest Results:`);
  console.log(`Passed: ${passed}/${denominator}, ${failed} failed`);

  if (failed > 0) {
    console.log('\nFailed Checks:');
    checks
      .filter((c) => c.status === 'FAILURE')
      .forEach((c) => {
        console.log(`  - ${c.name}: ${c.description}`);
        if (c.errorMessage) {
          console.log(`    Error: ${c.errorMessage}`);
        }
      });
  }

  return { passed, failed, denominator };
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
