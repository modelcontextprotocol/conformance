import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConformanceResult } from '../types';

interface ConformanceCheck {
  name: string;
  status: 'SUCCESS' | 'FAILURE' | 'WARNING';
  description?: string;
  errorMessage?: string;
}

/**
 * Parse conformance results from an output directory.
 * The conformance CLI saves checks.json per scenario under outputDir/<scenario>/server/ or client/.
 */
function parseOutputDir(
  outputDir: string,
  mode: 'server' | 'client'
): ConformanceResult {
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

  const entries = readdirSync(outputDir);
  for (const scenarioName of entries) {
    const checksPath = join(outputDir, scenarioName, mode, 'checks.json');
    if (!existsSync(checksPath)) continue;

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
 * Run server conformance tests by shelling out to the conformance CLI.
 */
export async function checkConformance(options: {
  serverUrl?: string;
  skip?: boolean;
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

  try {
    execSync(
      `node dist/index.js server --url ${options.serverUrl} -o ${outputDir}`,
      {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120_000
      }
    );
  } catch {
    // Non-zero exit is expected when tests fail — results are still in outputDir
  }

  return parseOutputDir(outputDir, 'server');
}

/**
 * Run client conformance tests by shelling out to the conformance CLI.
 */
export async function checkClientConformance(options: {
  clientCmd?: string;
  skip?: boolean;
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

  try {
    execSync(
      `node dist/index.js client --command '${options.clientCmd}' --suite all -o ${outputDir}`,
      {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120_000
      }
    );
  } catch {
    // Non-zero exit is expected when tests fail — results are still in outputDir
  }

  return parseOutputDir(outputDir, 'client');
}
