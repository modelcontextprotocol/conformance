import { spawn, ChildProcess } from 'child_process';
import { listActiveClientScenarios, listCoreScenarios } from '../../scenarios';
import { runServerConformanceTest, runConformanceTest } from '../../runner';
import { ConformanceResult } from '../types';

async function waitForServer(
  url: string,
  timeoutMs: number = 30000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(url, { method: 'GET' });
      // Any HTTP response means the server is listening (400, 405, etc. are all valid)
      return;
    } catch {
      // server not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `Server at ${url} did not become ready within ${timeoutMs}ms`
  );
}

const SCENARIO_TIMEOUT_MS = 30_000;

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label}: timed out after ${ms}ms`)),
      ms
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function checkConformance(options: {
  serverCmd?: string;
  serverCwd?: string;
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

  let serverProcess: ChildProcess | undefined;
  try {
    // Spawn server if a command was provided; otherwise assume it's already running
    if (options.serverCmd) {
      const [cmd, ...args] = options.serverCmd.split(' ');
      serverProcess = spawn(cmd, args, {
        cwd: options.serverCwd || process.cwd(),
        stdio: 'pipe',
        shell: true
      });
    }

    // Wait for server to be ready
    await waitForServer(options.serverUrl);

    // Run all active scenarios
    const scenarios = listActiveClientScenarios();
    const details: ConformanceResult['details'] = [];
    let totalPassed = 0;
    let totalFailed = 0;

    for (const scenarioName of scenarios) {
      try {
        const result = await withTimeout(
          runServerConformanceTest(options.serverUrl, scenarioName),
          SCENARIO_TIMEOUT_MS,
          scenarioName
        );
        const passed = result.checks.filter(
          (c) => c.status === 'SUCCESS'
        ).length;
        const failed = result.checks.filter(
          (c) => c.status === 'FAILURE'
        ).length;
        totalPassed += passed > 0 && failed === 0 ? 1 : 0;
        totalFailed += failed > 0 ? 1 : 0;
        details.push({
          scenario: scenarioName,
          passed: failed === 0,
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
  } finally {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      // Give it a moment, then force kill
      setTimeout(() => serverProcess?.kill('SIGKILL'), 5000);
    }
  }
}

/**
 * Run client conformance tests — the conformance tool acts as a server and
 * spawns the SDK's conformance client to validate client-side behaviour.
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

  const scenarios = listCoreScenarios();
  const details: ConformanceResult['details'] = [];
  let totalPassed = 0;
  let totalFailed = 0;

  for (const scenarioName of scenarios) {
    try {
      const result = await withTimeout(
        runConformanceTest(
          options.clientCmd,
          scenarioName,
          SCENARIO_TIMEOUT_MS
        ),
        SCENARIO_TIMEOUT_MS + 5_000, // extra buffer beyond the inner timeout
        scenarioName
      );
      const passed = result.checks.filter((c) => c.status === 'SUCCESS').length;
      const failed = result.checks.filter((c) => c.status === 'FAILURE').length;

      // A non-zero exit code counts as a failure unless the scenario expects it
      const clientFailed =
        !result.allowClientError && result.clientOutput.exitCode !== 0;

      const scenarioPassed = failed === 0 && passed > 0 && !clientFailed;
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
