import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { ConformanceCheck } from '../types.js';
import { getScenario } from '../scenarios/index.js';

// ANSI color codes
const COLORS = {
  RESET: '\x1b[0m',
  GRAY: '\x1b[90m',
  GREEN: '\x1b[32m',
  YELLOW: '\x1b[33m',
  RED: '\x1b[31m',
  BLUE: '\x1b[36m'
};

function getStatusColor(status: string): string {
  switch (status) {
    case 'SUCCESS':
      return COLORS.GREEN;
    case 'FAILURE':
      return COLORS.RED;
    case 'INFO':
      return COLORS.BLUE;
    default:
      return COLORS.RESET;
  }
}

function formatPrettyChecks(checks: ConformanceCheck[]): string {
  // Find the longest id and status for column alignment
  const maxIdLength = Math.max(...checks.map((c) => c.id.length));
  const maxStatusLength = Math.max(...checks.map((c) => c.status.length));

  return checks
    .map((check) => {
      const timestamp = `${COLORS.GRAY}${check.timestamp}${COLORS.RESET}`;
      const id = check.id.padEnd(maxIdLength);
      const statusColor = getStatusColor(check.status);
      const status = `${statusColor}${check.status.padEnd(maxStatusLength)}${COLORS.RESET}`;
      const description = check.description;
      return `${timestamp} [${id}] ${status} ${description}`;
    })
    .join('\n');
}

export interface ClientExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function ensureResultsDir(): Promise<string> {
  const resultsDir = path.join(process.cwd(), 'results');
  await fs.mkdir(resultsDir, { recursive: true });
  return resultsDir;
}

function createResultDir(scenario: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join('results', `${scenario}-${timestamp}`);
}

async function executeClient(
  command: string,
  serverUrl: string,
  timeout: number = 30000
): Promise<ClientExecutionResult> {
  const commandParts = command.split(' ');
  const executable = commandParts[0];
  const args = [...commandParts.slice(1), serverUrl];

  let stdout = '';
  let stderr = '';
  let timedOut = false;

  return new Promise((resolve) => {
    const process = spawn(executable, args, {
      shell: true,
      stdio: 'pipe'
    });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      process.kill();
    }, timeout);

    if (process.stdout) {
      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });
    }

    if (process.stderr) {
      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    }

    process.on('close', (code) => {
      clearTimeout(timeoutHandle);
      resolve({
        exitCode: code || 0,
        stdout,
        stderr,
        timedOut
      });
    });

    process.on('error', (error) => {
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

  const scenario = getScenario(scenarioName);
  if (!scenario) {
    throw new Error(`Unknown scenario: ${scenarioName}`);
  }

  console.log(`Starting scenario: ${scenarioName}`);
  const urls = await scenario.start();

  console.log(`Executing client: ${clientCommand} ${urls.serverUrl}`);

  try {
    const clientOutput = await executeClient(
      clientCommand,
      urls.serverUrl,
      timeout
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

    console.log(`Results saved to ${resultDir}`);

    return {
      checks,
      clientOutput,
      resultDir
    };
  } finally {
    await scenario.stop();
  }
}

async function runInteractiveMode(scenarioName: string): Promise<void> {
  await ensureResultsDir();
  const resultDir = createResultDir(scenarioName);
  await fs.mkdir(resultDir, { recursive: true });

  const scenario = getScenario(scenarioName);
  if (!scenario) {
    throw new Error(`Unknown scenario: ${scenarioName}`);
  }

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

    console.log(`\nChecks:\n${JSON.stringify(checks, null, 2)}`);
    console.log(`\nChecks saved to ${resultDir}/checks.json`);

    await scenario.stop();
    process.exit(0);
  };

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  await new Promise(() => {});
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let command: string | null = null;
  let scenario: string | null = null;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--command' && i + 1 < args.length) {
      command = args[i + 1];
      i++;
    } else if (args[i] === '--scenario' && i + 1 < args.length) {
      scenario = args[i + 1];
      i++;
    } else if (args[i] === '--verbose') {
      verbose = true;
    }
  }

  if (!scenario) {
    console.error(
      'Usage: runner --scenario <scenario> [--command "<command>"] [--verbose]'
    );
    console.error(
      'Example: runner --scenario initialize --command "tsx examples/clients/typescript/test1.ts"'
    );
    console.error('Or run without --command for interactive mode');
    process.exit(1);
  }

  if (!command) {
    try {
      await runInteractiveMode(scenario);
    } catch (error) {
      console.error('Interactive mode error:', error);
      process.exit(1);
    }
    return;
  }

  try {
    const result = await runConformanceTest(command, scenario);

    const denominator = result.checks.filter(
      (c) => c.status === 'SUCCESS' || c.status == 'FAILURE'
    ).length;
    const passed = result.checks.filter((c) => c.status === 'SUCCESS').length;
    const failed = result.checks.filter((c) => c.status === 'FAILURE').length;

    if (verbose) {
      console.log(`Checks:\n${JSON.stringify(result.checks, null, 2)}`);
    } else {
      console.log(`Checks:\n${formatPrettyChecks(result.checks)}`);
    }

    console.log(`\nTest Results:`);
    console.log(`Passed: ${passed}/${denominator}, ${failed} failed`);

    if (failed > 0) {
      console.log('\nFailed Checks:');
      result.checks
        .filter((c) => c.status === 'FAILURE')
        .forEach((c) => {
          console.log(`  - ${c.name}: ${c.description}`);
          if (c.errorMessage) {
            console.log(`    Error: ${c.errorMessage}`);
          }
        });
    }

    process.exit(failed > 0 ? 1 : 0);
  } catch (error) {
    console.error('Test runner error:', error);
    process.exit(1);
  }
}

main();
