import { promises as fs } from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { ConformanceCheck } from '../types';
import { getClientScenario, getServerAuthScenario } from '../scenarios';
import { ensureResultsDir, createResultDir, formatPrettyChecks } from './utils';
import { createAuthServer } from '../scenarios/client/auth/helpers/createAuthServer';
import { ServerLifecycle } from '../scenarios/client/auth/helpers/serverLifecycle';

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

export async function runServerConformanceTest(
  serverUrl: string,
  scenarioName: string
): Promise<{
  checks: ConformanceCheck[];
  resultDir: string;
  scenarioDescription: string;
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

/**
 * Wait for a URL to become available by polling
 */
async function waitForServerReady(
  url: string,
  timeoutMs: number = 30000,
  intervalMs: number = 500
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(url, { method: 'HEAD' });
      if (response.ok || response.status === 401 || response.status === 404) {
        // Server is up (401/404 are acceptable - means server is responding)
        return;
      }
    } catch {
      // Server not ready yet, keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `Server at ${url} did not become ready within ${timeoutMs}ms`
  );
}

/**
 * Run server auth conformance test
 *
 * For --command mode: Spawns the fake AS, then spawns the server with
 * MCP_CONFORMANCE_AUTH_SERVER_URL env var pointing to the fake AS.
 *
 * For --url mode: Just runs the auth scenario against the provided URL.
 */
export async function runServerAuthConformanceTest(options: {
  url?: string;
  command?: string;
  scenarioName: string;
  timeout?: number;
  interactive?: boolean;
}): Promise<{
  checks: ConformanceCheck[];
  resultDir: string;
  scenarioDescription: string;
}> {
  const {
    url,
    command,
    scenarioName,
    timeout = 30000,
    interactive = false
  } = options;

  await ensureResultsDir();
  const resultDir = createResultDir(scenarioName, 'server-auth');
  await fs.mkdir(resultDir, { recursive: true });

  // Get the scenario
  const scenario = getServerAuthScenario(scenarioName);
  if (!scenario) {
    throw new Error(`Unknown server auth scenario: ${scenarioName}`);
  }

  let checks: ConformanceCheck[] = [];
  let serverProcess: ChildProcess | null = null;
  let authServerLifecycle: ServerLifecycle | null = null;

  try {
    if (command) {
      // --command mode: Start fake AS, then spawn server with env var
      console.log(`Starting fake authorization server...`);

      authServerLifecycle = new ServerLifecycle();
      const authApp = createAuthServer(checks, authServerLifecycle.getUrl);
      const authServerUrl = await authServerLifecycle.start(authApp);
      console.log(`Fake AS running at ${authServerUrl}`);

      // Spawn the server command with the auth server URL env var
      console.log(`Starting server with command: ${command}`);
      serverProcess = spawn(command, {
        shell: true,
        env: {
          ...process.env,
          MCP_CONFORMANCE_AUTH_SERVER_URL: authServerUrl
        },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // Collect server output for debugging
      let serverOutput = '';
      serverProcess.stdout?.on('data', (data) => {
        serverOutput += data.toString();
      });
      serverProcess.stderr?.on('data', (data) => {
        serverOutput += data.toString();
      });

      // Wait for server to be ready
      // The server should output its URL or we need a way to determine it
      // For now, we'll assume the server outputs its URL to stdout
      const serverUrl = await new Promise<string>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(
            new Error(
              `Server did not start within ${timeout}ms. Output: ${serverOutput}`
            )
          );
        }, timeout);

        // Look for URL in server output
        const checkOutput = () => {
          const urlMatch = serverOutput.match(/https?:\/\/localhost:\d+\/mcp/);
          if (urlMatch) {
            clearTimeout(timeoutId);
            resolve(urlMatch[0]);
          }
        };

        serverProcess!.stdout?.on('data', checkOutput);
        serverProcess!.stderr?.on('data', checkOutput);

        serverProcess!.on('error', (err) => {
          clearTimeout(timeoutId);
          reject(err);
        });

        serverProcess!.on('exit', (code) => {
          if (code !== null && code !== 0) {
            clearTimeout(timeoutId);
            reject(
              new Error(
                `Server process exited with code ${code}. Output: ${serverOutput}`
              )
            );
          }
        });
      });

      console.log(`Server running at ${serverUrl}`);
      await waitForServerReady(serverUrl);

      // Run the scenario
      console.log(
        `Running server auth scenario '${scenarioName}' against server: ${serverUrl}`
      );
      const scenarioChecks = await scenario.run(serverUrl, { interactive });
      checks.push(...scenarioChecks);
    } else if (url) {
      // --url mode: Just run the scenario against the provided URL
      console.log(
        `Running server auth scenario '${scenarioName}' against: ${url}`
      );
      checks = await scenario.run(url, { interactive });
    } else {
      throw new Error(
        'Either --url or --command must be provided for auth scenarios'
      );
    }

    await fs.writeFile(
      path.join(resultDir, 'checks.json'),
      JSON.stringify(checks, null, 2)
    );

    console.log(`Results saved to ${resultDir}`);

    return {
      checks,
      resultDir,
      scenarioDescription: scenario.description
    };
  } finally {
    // Cleanup
    if (serverProcess) {
      console.log('Stopping server process...');
      serverProcess.kill();
    }
    if (authServerLifecycle) {
      console.log('Stopping fake authorization server...');
      await authServerLifecycle.stop();
    }
  }
}

/**
 * Start a standalone fake authorization server for manual testing
 */
export async function startFakeAuthServer(port?: number): Promise<{
  url: string;
  stop: () => Promise<void>;
}> {
  const checks: ConformanceCheck[] = [];
  const lifecycle = new ServerLifecycle();
  const app = createAuthServer(checks, lifecycle.getUrl, {
    loggingEnabled: true
  });

  if (port) {
    // If a specific port is requested, we need to handle it differently
    const httpServer = app.listen(port);
    const url = `http://localhost:${port}`;
    return {
      url,
      stop: async () => {
        await new Promise<void>((resolve) => {
          httpServer.closeAllConnections?.();
          httpServer.close(() => resolve());
        });
      }
    };
  }

  const url = await lifecycle.start(app);
  return {
    url,
    stop: () => lifecycle.stop()
  };
}
