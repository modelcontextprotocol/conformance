import { spawn, ChildProcess } from 'child_process';
import { getClientScenario, listActiveClientScenarios } from '../index.js';
import path from 'path';

describe('Server Scenarios', () => {
  let serverProcess: ChildProcess;
  const TEST_PORT = 3001;
  const SERVER_URL = `http://localhost:${TEST_PORT}/mcp`;
  const SERVER_STARTUP_TIMEOUT = 10000; // 10 seconds to start

  beforeAll(async () => {
    // Start the everything-server once for all scenarios
    const serverPath = path.join(
      process.cwd(),
      'examples/servers/typescript/everything-server.ts'
    );

    serverProcess = spawn('npx', ['tsx', serverPath], {
      env: { ...process.env, PORT: TEST_PORT.toString() },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Wait for server to be ready
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(`Server failed to start within ${SERVER_STARTUP_TIMEOUT}ms`)
        );
      }, SERVER_STARTUP_TIMEOUT);

      serverProcess.stdout?.on('data', (data) => {
        const output = data.toString();
        if (output.includes('running on')) {
          clearTimeout(timeout);
          resolve();
        }
      });

      serverProcess.on('error', (error) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to start server: ${error.message}`));
      });

      serverProcess.on('exit', (code) => {
        if (code !== null && code !== 0) {
          clearTimeout(timeout);
          reject(new Error(`Server exited prematurely with code ${code}`));
        }
      });
    });
  }, SERVER_STARTUP_TIMEOUT + 5000);

  afterAll(async () => {
    // Stop the server
    if (serverProcess) {
      serverProcess.kill('SIGTERM');

      // Wait for graceful shutdown
      await new Promise<void>((resolve) => {
        const timeoutHandle = setTimeout(() => {
          if (!serverProcess.killed) {
            serverProcess.kill('SIGKILL');
          }
          resolve();
        }, 5000);

        const cleanUp = () => {
          clearTimeout(timeoutHandle);
          serverProcess.removeListener('exit', cleanUp);
          resolve();
        };

        serverProcess.on('exit', cleanUp);
      });
    }
  });

  // Generate individual test for each scenario
  const scenarios = listActiveClientScenarios();

  for (const scenarioName of scenarios) {
    it(`${scenarioName}`, async () => {
      const scenario = getClientScenario(scenarioName);
      expect(scenario).toBeDefined();

      if (!scenario) {
        throw new Error(`Scenario ${scenarioName} not found`);
      }

      const checks = await scenario.run(SERVER_URL);

      // Verify checks were returned
      expect(checks.length).toBeGreaterThan(0);

      // Verify all checks passed
      const failures = checks.filter((c) => c.status === 'FAILURE');
      if (failures.length > 0) {
        const failureMessages = failures
          .map((c) => `${c.name}: ${c.errorMessage || c.description}`)
          .join('\n  ');
        throw new Error(`Scenario failed with checks:\n  ${failureMessages}`);
      }

      // All checks should be SUCCESS
      const successes = checks.filter((c) => c.status === 'SUCCESS');
      expect(successes.length).toBe(checks.length);
    }, 10000); // 10 second timeout per scenario
  }
});
