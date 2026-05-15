/**
 * SEP-2322 MRTR positive tests.
 *
 * Runs all InputRequiredResult scenarios against the dedicated
 * sep-2322-mrtr-server (which uses the low-level Server class to return
 * resultType: "input_required").
 */

import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import {
  InputRequiredResultBasicElicitationScenario,
  InputRequiredResultBasicSamplingScenario,
  InputRequiredResultBasicListRootsScenario,
  InputRequiredResultRequestStateScenario,
  InputRequiredResultMultipleInputRequestsScenario,
  InputRequiredResultMultiRoundScenario,
  InputRequiredResultMissingInputResponseScenario,
  InputRequiredResultNonToolRequestScenario
} from './input-required-result';
import {
  InputRequiredResultTaskBasicScenario,
  InputRequiredResultTaskBadInputResponseScenario,
  InputRequiredResultTaskInputResponseInputRequiredScenario
} from './input-required-result-tasks';

function startServer(
  scriptPath: string,
  port: number
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const proc = spawn('npx', ['tsx', scriptPath], {
      env: { ...process.env, PORT: port.toString() },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows
    });
    let stderr = '';
    proc.stderr?.on('data', (d) => (stderr += d.toString()));
    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(
        new Error(`Server ${scriptPath} failed to start within 30s: ${stderr}`)
      );
    }, 30000);
    proc.stdout?.on('data', (data) => {
      if (data.toString().includes('running on')) {
        clearTimeout(timeout);
        resolve(proc);
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function stopServer(proc: ChildProcess | null): Promise<void> {
  return new Promise((resolve) => {
    if (!proc || proc.killed) return resolve();
    const t = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve();
    }, 5000);
    proc.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

describe('SEP-2322 MRTR positive tests', () => {
  let serverProcess: ChildProcess | null = null;
  const PORT = 3010;
  const SERVER_URL = `http://localhost:${PORT}/mcp`;

  beforeAll(async () => {
    serverProcess = await startServer(
      path.join(
        process.cwd(),
        'examples/servers/typescript/sep-2322-mrtr-server.ts'
      ),
      PORT
    );
  }, 35000);

  afterAll(async () => {
    await stopServer(serverProcess);
  });

  const scenarios = [
    new InputRequiredResultBasicElicitationScenario(),
    new InputRequiredResultBasicSamplingScenario(),
    new InputRequiredResultBasicListRootsScenario(),
    new InputRequiredResultRequestStateScenario(),
    new InputRequiredResultMultipleInputRequestsScenario(),
    new InputRequiredResultMultiRoundScenario(),
    new InputRequiredResultMissingInputResponseScenario(),
    new InputRequiredResultNonToolRequestScenario(),
    new InputRequiredResultTaskBasicScenario(),
    new InputRequiredResultTaskBadInputResponseScenario(),
    new InputRequiredResultTaskInputResponseInputRequiredScenario()
  ];

  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      const checks = await scenario.run(SERVER_URL);

      expect(checks.length).toBeGreaterThan(0);

      const failures = checks.filter((c) => c.status === 'FAILURE');
      if (failures.length > 0) {
        const failureMessages = failures
          .map((c) => `${c.name}: ${c.errorMessage || c.description}`)
          .join('\n  ');
        throw new Error(`Scenario failed with checks:\n  ${failureMessages}`);
      }
    }, 15000);
  }
});
