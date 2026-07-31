import { getScenario } from '../../../index';
import { testScenarioContext } from '../../../../mock-server/testing';
import type { SpecVersion, ConformanceCheck } from '../../../../types';
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

export interface RunClientOptions {
  expectedFailureSlugs?: string[];
  /**
   * Slugs that MUST be present and SUCCESS. Use alongside expectedFailureSlugs
   * to pin that a specific check is *not* collateral damage of the injected
   * defect (e.g. a client that skips the nonce retry still passes
   * token-request-proof because it did present a valid proof).
   */
  expectedSuccessSlugs?: string[];
  allowClientError?: boolean;
  /**
   * Spec version to run the scenario at. Defaults to the latest dated spec
   * version (see {@link testScenarioContext}). Pass the draft version to
   * exercise checks gated to draft-only requirements.
   */
  specVersion?: SpecVersion;
}

export async function runClientAgainstScenario(
  clientRunner: ClientRunner,
  scenarioName: string,
  options: RunClientOptions = {}
): Promise<ConformanceCheck[]> {
  const {
    expectedFailureSlugs = [],
    expectedSuccessSlugs = [],
    allowClientError = false,
    specVersion
  } = options;

  const runner = clientRunner;

  const scenario = getScenario(scenarioName);
  if (!scenario) {
    throw new Error(`Scenario ${scenarioName} not found`);
  }

  // Start the scenario server
  const ctx = testScenarioContext(specVersion);
  const urls = await scenario.start(ctx);
  const serverUrl = urls.serverUrl;

  // The emitted checks, returned to the caller for assertions the standard
  // pass/fail options don't cover (e.g. counting occurrences of a shared check).
  let collected: ConformanceCheck[] = [];

  try {
    // Set environment variables for inline clients
    // These mirror what src/runner/client.ts does for spawned processes
    process.env.MCP_CONFORMANCE_SCENARIO = scenarioName;
    process.env.MCP_CONFORMANCE_PROTOCOL_VERSION = ctx.specVersion;
    if (urls.context) {
      process.env.MCP_CONFORMANCE_CONTEXT = JSON.stringify({
        name: scenarioName,
        ...urls.context
      });
    }

    // Run the client
    try {
      await runner.run(serverUrl);
    } catch (err) {
      if (expectedFailureSlugs.length === 0 && !allowClientError) {
        throw err; // Unexpected failure
      }
      // Otherwise, expected failure or allowed error - continue to checks verification
    }

    // Get checks from the scenario
    const checks = scenario.getChecks();
    collected = checks;

    // Verify checks were returned
    if (checks.length === 0) {
      throw new Error('No checks returned from scenario');
    }

    // Filter out INFO checks
    const nonInfoChecks = checks.filter((c) => c.status !== 'INFO');

    // Slugs that must be present and SUCCESS (independent of the failure set).
    for (const slug of expectedSuccessSlugs) {
      const check = checks.find((c) => c.id === slug);
      if (!check) {
        throw new Error(`Expected-success check ${slug} not found`);
      }
      expect(check.status).toBe('SUCCESS');
    }

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
      const failures = nonInfoChecks.filter(
        (c) => c.status === 'FAILURE' || c.status === 'WARNING'
      );
      const failureSlugs = failures.map((c) => c.id);
      // Check that failureSlugs contains all expectedFailureSlugs
      expect(failureSlugs).toEqual(
        expect.arrayContaining(expectedFailureSlugs)
      );
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
    // Clean up environment variables
    delete process.env.MCP_CONFORMANCE_SCENARIO;
    delete process.env.MCP_CONFORMANCE_CONTEXT;
    delete process.env.MCP_CONFORMANCE_PROTOCOL_VERSION;

    // Stop the scenario server
    await scenario.stop();
  }

  return collected;
}
