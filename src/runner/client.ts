import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { ConformanceCheck } from '../types';
import { getScenario } from '../scenarios';
import { ensureResultsDir, createResultDir, formatPrettyChecks } from './utils';

export interface ClientExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function executeClient(
  command: string,
  serverUrl: string,
  timeout: number = 30000,
  context?: Record<string, unknown>
): Promise<ClientExecutionResult> {
  const commandParts = command.split(' ');
  const executable = commandParts[0];
  const args = [...commandParts.slice(1), serverUrl];

  let stdout = '';
  let stderr = '';
  let timedOut = false;

  // Build environment with optional context
  const env = { ...process.env };
  if (context) {
    env.MCP_CONFORMANCE_CONTEXT = JSON.stringify(context);
  }

  return new Promise((resolve) => {
    const childProcess = spawn(executable, args, {
      shell: true,
      stdio: 'pipe',
      env
    });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      childProcess.kill();
    }, timeout);

    if (childProcess.stdout) {
      childProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });
    }

    if (childProcess.stderr) {
      childProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    }

    childProcess.on('close', (code) => {
      clearTimeout(timeoutHandle);
      resolve({
        exitCode: code || 0,
        stdout,
        stderr,
        timedOut
      });
    });

    childProcess.on('error', (error) => {
      clearTimeout(timeoutHandle);
      resolve({
        exitCode: -1,
        stdout,
        stderr: stderr + `\nProcess error: ${error.message}`,
        timedOut
      });
    });
  });
}

export async function runConformanceTest(
  clientCommand: string,
  scenarioName: string,
  timeout: number = 30000
): Promise<{
  checks: ConformanceCheck[];
  clientOutput: ClientExecutionResult;
  resultDir: string;
}> {
  await ensureResultsDir();
  const resultDir = createResultDir(scenarioName);
  await fs.mkdir(resultDir, { recursive: true });

  // Scenario is guaranteed to exist by CLI validation
  const scenario = getScenario(scenarioName)!;

  console.error(`Starting scenario: ${scenarioName}`);
  const urls = await scenario.start();

  console.error(`Executing client: ${clientCommand} ${urls.serverUrl}`);
  if (urls.context) {
    console.error(`With context: ${JSON.stringify(urls.context)}`);
  }

  try {
    const clientOutput = await executeClient(
      clientCommand,
      urls.serverUrl,
      timeout,
      urls.context
    );

    // Print stdout/stderr if client exited with nonzero code
    if (clientOutput.exitCode !== 0) {
      console.error(`\nClient exited with code ${clientOutput.exitCode}`);
      if (clientOutput.stdout) {
        console.error(`\nStdout:\n${clientOutput.stdout}`);
      }
      if (clientOutput.stderr) {
        console.error(`\nStderr:\n${clientOutput.stderr}`);
      }
    }

    if (clientOutput.timedOut) {
      console.error(`\nClient timed out after ${timeout}ms`);
    }

    const checks = scenario.getChecks();

    await fs.writeFile(
      path.join(resultDir, 'checks.json'),
      JSON.stringify(checks, null, 2)
    );

    await fs.writeFile(path.join(resultDir, 'stdout.txt'), clientOutput.stdout);

    await fs.writeFile(path.join(resultDir, 'stderr.txt'), clientOutput.stderr);

    console.error(`Results saved to ${resultDir}`);

    return {
      checks,
      clientOutput,
      resultDir
    };
  } finally {
    await scenario.stop();
  }
}

export function printClientResults(
  checks: ConformanceCheck[],
  verbose: boolean = false,
  clientOutput?: ClientExecutionResult
): {
  passed: number;
  failed: number;
  denominator: number;
  warnings: number;
  overallFailure: boolean;
} {
  const denominator = checks.filter(
    (c) => c.status === 'SUCCESS' || c.status === 'FAILURE'
  ).length;
  const passed = checks.filter((c) => c.status === 'SUCCESS').length;
  const failed = checks.filter((c) => c.status === 'FAILURE').length;
  const warnings = checks.filter((c) => c.status === 'WARNING').length;

  // Determine if there's an overall failure (client timeout or exit failure)
  const clientTimedOut = clientOutput?.timedOut ?? false;
  const clientExitedWithError = clientOutput
    ? clientOutput.exitCode !== 0
    : false;
  const overallFailure = failed > 0 || clientTimedOut || clientExitedWithError;

  if (verbose) {
    // Verbose mode: JSON goes to stdout for piping to jq/jless
    console.log(JSON.stringify(checks, null, 2));
  } else {
    // Non-verbose: Pretty checks go to stderr
    console.error(`Checks:\n${formatPrettyChecks(checks)}`);
  }

  // Test results summary goes to stderr
  console.error(`\nTest Results:`);
  console.error(
    `Passed: ${passed}/${denominator}, ${failed} failed, ${warnings} warnings`
  );

  if (clientTimedOut) {
    console.error(`\n⚠️  CLIENT TIMED OUT - Test incomplete`);
  }

  if (clientExitedWithError && !clientTimedOut) {
    console.error(
      `\n⚠️  CLIENT EXITED WITH ERROR (code ${clientOutput?.exitCode}) - Test may be incomplete`
    );
  }

  if (failed > 0) {
    console.error('\nFailed Checks:');
    checks
      .filter((c) => c.status === 'FAILURE')
      .forEach((c) => {
        console.error(`  - ${c.name}: ${c.description}`);
        if (c.errorMessage) {
          console.error(`    Error: ${c.errorMessage}`);
        }
      });
  }

  if (overallFailure) {
    console.error('\n❌ OVERALL: FAILED');
  } else {
    console.error('\n✅ OVERALL: PASSED');
  }

  return { passed, failed, denominator, warnings, overallFailure };
}

export async function runInteractiveMode(
  scenarioName: string,
  verbose: boolean = false
): Promise<void> {
  await ensureResultsDir();
  const resultDir = createResultDir(scenarioName);
  await fs.mkdir(resultDir, { recursive: true });

  // Scenario is guaranteed to exist by CLI validation
  const scenario = getScenario(scenarioName)!;

  console.log(`Starting scenario: ${scenarioName}`);
  const urls = await scenario.start();

  console.log(`Server URL: ${urls.serverUrl}`);
  console.log('Press Ctrl+C to stop and save checks...');

  const handleShutdown = async () => {
    console.log('\nShutting down...');

    const checks = scenario.getChecks();
    await fs.writeFile(
      path.join(resultDir, 'checks.json'),
      JSON.stringify(checks, null, 2)
    );

    if (verbose) {
      console.log(`\nChecks:\n${JSON.stringify(checks, null, 2)}`);
    } else {
      console.log(`\nChecks:\n${formatPrettyChecks(checks)}`);
    }
    console.log(`\nChecks saved to ${resultDir}/checks.json`);

    await scenario.stop();
    process.exit(0);
  };

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  await new Promise(() => {});
}
