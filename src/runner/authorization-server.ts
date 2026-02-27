import { promises as fs } from 'fs';
import path from 'path';
import { ConformanceCheck } from '../types';
import { getClientScenarioForAuthorizationServer } from '../scenarios';
import { createResultDir } from './utils';

export async function runAuthorizationServerConformanceTest(
  serverUrl: string,
  scenarioName: string,
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
      'authorization-server'
    );
    await fs.mkdir(resultDir, { recursive: true });
  }

  // Scenario is guaranteed to exist by CLI validation
  const scenario = getClientScenarioForAuthorizationServer(scenarioName)!;

  console.log(
    `Running client scenario for authorization server '${scenarioName}' against server: ${serverUrl}`
  );

  const checks = await scenario.run(serverUrl);

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

export function printAuthorizationServerSummary(
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
