import { describe, test, expect } from '@jest/globals';
import { getScenario } from '../../index.js';
import { spawn } from 'child_process';
import path from 'path';

const CLIENT_TIMEOUT = 10000; // 10 seconds for client to complete

async function runClientAgainstScenario(
  clientPath: string,
  scenarioName: string,
  expectedFailureSlugs: string[] = []
): Promise<void> {
  const scenario = getScenario(scenarioName);
  expect(scenario).toBeDefined();

  if (!scenario) {
    throw new Error(`Scenario ${scenarioName} not found`);
  }

  // Start the scenario server
  const urls = await scenario.start();
  const serverUrl = urls.serverUrl;

  try {
    // Run the client
    await new Promise<void>((resolve, reject) => {
      const clientProcess = spawn('npx', ['tsx', clientPath, serverUrl], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      clientProcess.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      clientProcess.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      const timeout = setTimeout(() => {
        clientProcess.kill('SIGTERM');
        reject(
          new Error(
            `Client failed to complete within ${CLIENT_TIMEOUT}ms\nStdout: ${stdout}\nStderr: ${stderr}`
          )
        );
      }, CLIENT_TIMEOUT);

      clientProcess.on('exit', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `Client exited with code ${code}\nStdout: ${stdout}\nStderr: ${stderr}`
            )
          );
        }
      });

      clientProcess.on('error', (error) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `Failed to start client: ${error.message}\nStdout: ${stdout}\nStderr: ${stderr}`
          )
        );
      });
    });

    // Get checks from the scenario
    const checks = scenario.getChecks();

    // Verify checks were returned
    expect(checks.length).toBeGreaterThan(0);

    // Filter out INFO checks
    const nonInfoChecks = checks.filter((c) => c.status !== 'INFO');

    // Check for expected failures
    if (expectedFailureSlugs.length > 0) {
      // Verify that the expected failures are present
      for (const slug of expectedFailureSlugs) {
        const check = checks.find((c) => c.id === slug);
        expect(check).toMatchSnapshot();
      }

      // Verify that only the expected checks failed
      const failures = nonInfoChecks.filter((c) => c.status === 'FAILURE');
      const failureSlugs = failures.map((c) => c.id);
      expect(failureSlugs.sort()).toEqual(expectedFailureSlugs.sort());
    } else {
      // Default: expect all checks to pass
      const failures = nonInfoChecks.filter((c) => c.status === 'FAILURE');
      if (failures.length > 0) {
        const failureMessages = failures
          .map((c) => `${c.name}: ${c.errorMessage || c.description}`)
          .join('\n  ');
        throw new Error(`Scenario failed with checks:\n  ${failureMessages}`);
      }

      // All non-INFO checks should be SUCCESS
      const successes = nonInfoChecks.filter((c) => c.status === 'SUCCESS');
      expect(successes.length).toBe(nonInfoChecks.length);
    }
  } finally {
    // Stop the scenario server
    await scenario.stop();
  }
}

describe('PRM Path-Based Discovery', () => {
  test('client discovers PRM at path-based location before root', async () => {
    const clientPath = path.join(
      process.cwd(),
      'examples/clients/typescript/auth-test.ts'
    );
    await runClientAgainstScenario(clientPath, 'auth-prm-pathbased');
  });
});
