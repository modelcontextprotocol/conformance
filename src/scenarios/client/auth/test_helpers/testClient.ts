import { getScenario } from '../../../index.js';
import { spawn } from 'child_process';

const CLIENT_TIMEOUT = 10000; // 10 seconds for client to complete

/**
 * Represents a client that can be executed against a scenario.
 * Implementations can run client code inline or by spawning a process.
 */
export interface ClientRunner {
  /**
   * Run the client against the given server URL.
   * Should reject if the client fails.
   */
  run(serverUrl: string): Promise<void>;
}

/**
 * Client runner that spawns a shell process to execute a client file.
 */
export class SpawnedClientRunner implements ClientRunner {
  constructor(private clientPath: string) {}

  async run(serverUrl: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const clientProcess = spawn('npx', ['tsx', this.clientPath, serverUrl], {
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
  }
}

/**
 * Client runner that executes a client function inline without spawning a shell.
 */
export class InlineClientRunner implements ClientRunner {
  constructor(private clientFn: (serverUrl: string) => Promise<void>) {}

  async run(serverUrl: string): Promise<void> {
    await this.clientFn(serverUrl);
  }
}

export async function runClientAgainstScenario(
  clientRunner: ClientRunner | string,
  scenarioName: string,
  expectedFailureSlugs: string[] = []
): Promise<void> {
  // Handle backward compatibility: if string is passed, treat as file path
  const runner =
    typeof clientRunner === 'string'
      ? new SpawnedClientRunner(clientRunner)
      : clientRunner;

  const scenario = getScenario(scenarioName);
  if (!scenario) {
    throw new Error(`Scenario ${scenarioName} not found`);
  }

  // Start the scenario server
  const urls = await scenario.start();
  const serverUrl = urls.serverUrl;

  try {
    // Run the client
    await runner.run(serverUrl);

    // Get checks from the scenario
    const checks = scenario.getChecks();

    // Verify checks were returned
    if (checks.length === 0) {
      throw new Error('No checks returned from scenario');
    }

    // Filter out INFO checks
    const nonInfoChecks = checks.filter((c) => c.status !== 'INFO');

    // Check for expected failures
    if (expectedFailureSlugs.length > 0) {
      // Verify that the expected failures are present
      for (const slug of expectedFailureSlugs) {
        const check = checks.find((c) => c.id === slug);
        if (!check) {
          throw new Error(`Expected failure check ${slug} not found`);
        }
      }

      // Verify that only the expected checks failed
      const failures = nonInfoChecks.filter((c) => c.status === 'FAILURE');
      const failureSlugs = failures.map((c) => c.id);
      if (
        failureSlugs.sort().join(',') !== expectedFailureSlugs.sort().join(',')
      ) {
        throw new Error(
          `Expected failures ${expectedFailureSlugs.sort().join(', ')} but got ${failureSlugs.sort().join(', ')}`
        );
      }
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
      if (successes.length !== nonInfoChecks.length) {
        throw new Error(
          `Expected all checks to pass but got ${successes.length}/${nonInfoChecks.length}`
        );
      }
    }
  } finally {
    // Stop the scenario server
    await scenario.stop();
  }
}
