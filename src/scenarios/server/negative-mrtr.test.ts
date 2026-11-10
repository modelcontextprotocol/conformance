import { testContext } from '../../connection/testing';
/**
 * SEP-2322 MRTR negative tests.
 *
 * Positive tests run via the CLI runner against the everything-server
 * (which implements MRTR in its stateless path). These negative tests run
 * against a deliberately broken server to verify checks emit FAILURE.
 */

import { spawn, ChildProcess } from 'child_process';
import { createServer } from 'net';
import path from 'path';
import {
  InputRequiredResultResultTypeScenario,
  InputRequiredResultUnsupportedMethodsScenario,
  InputRequiredResultTamperedStateScenario,
  InputRequiredResultCapabilityCheckScenario,
  InputRequiredResultRequestStateScenario
} from './input-required-result';
import {
  formatWireViolation,
  takeWireViolations
} from '../../validation/wire-schema';

// The broken fixture violates the draft schema by design; drain the wire-schema recorder
// so the suite-wide guard doesn't re-flag it. Only the *implementation* may be invalid —
// a harness-origin violation is a real harness bug and must still fail.
afterEach(() => {
  const { violations } = takeWireViolations();
  const harnessViolations = violations.filter((v) => v.origin === 'harness');
  if (harnessViolations.length > 0) {
    throw new Error(
      'Harness-origin wire-schema violations in an MRTR negative test ' +
        '(only the broken fixture may be invalid here):\n  ' +
        harnessViolations.map(formatWireViolation).join('\n  ')
    );
  }
});

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function startServer(
  scriptPath: string,
  port: number,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const proc = spawn('npx', ['tsx', scriptPath], {
      env: { ...process.env, ...extraEnv, PORT: port.toString() },
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

describe('SEP-2322 MRTR negative tests', () => {
  let serverProcess: ChildProcess | null = null;
  let SERVER_URL: string;

  beforeAll(async () => {
    const port = await getFreePort();
    SERVER_URL = `http://localhost:${port}/mcp`;
    serverProcess = await startServer(
      path.join(
        process.cwd(),
        'examples/servers/typescript/sep-2322-mrtr-broken-server.ts'
      ),
      port
    );
  }, 35000);

  afterAll(async () => {
    await stopServer(serverProcess);
  });

  it('emits FAILURE for sep-2322-result-type-included against server that omits resultType', async () => {
    const scenario = new InputRequiredResultResultTypeScenario();
    const checks = await scenario.run(testContext(SERVER_URL));

    const resultTypeCheck = checks.find(
      (c) => c.id === 'sep-2322-result-type-included'
    );
    expect(resultTypeCheck).toBeDefined();
    expect(resultTypeCheck?.status).toBe('FAILURE');
  }, 10000);

  it('emits FAILURE for sep-2322-not-on-unsupported-requests against server returning InputRequiredResult on tools/list', async () => {
    const scenario = new InputRequiredResultUnsupportedMethodsScenario();
    const checks = await scenario.run(testContext(SERVER_URL));

    const unsupportedCheck = checks.find(
      (c) => c.id === 'sep-2322-not-on-unsupported-requests'
    );
    expect(unsupportedCheck).toBeDefined();
    expect(unsupportedCheck?.status).toBe('FAILURE');
  }, 10000);

  it('emits FAILURE for sep-2322-reject-tampered-state against server that accepts tampered state', async () => {
    const scenario = new InputRequiredResultTamperedStateScenario();
    const checks = await scenario.run(testContext(SERVER_URL));

    const tamperedCheck = checks.find(
      (c) => c.id === 'sep-2322-reject-tampered-state'
    );
    expect(tamperedCheck).toBeDefined();
    expect(tamperedCheck?.status).toBe('FAILURE');
  }, 10000);

  it('reports sep-2322-respect-client-capabilities as untestable against a server whose input_required result requests nothing', async () => {
    const scenario = new InputRequiredResultCapabilityCheckScenario();
    const checks = await scenario.run(testContext(SERVER_URL));

    const capabilityCheck = checks.find(
      (c) => c.id === 'sep-2322-respect-client-capabilities'
    );
    expect(capabilityCheck).toBeDefined();
    expect(capabilityCheck?.status).toBe('FAILURE');
    // The requirement was not violated, it could not be exercised (#248).
    expect(capabilityCheck?.errorMessage).toContain('Not testable:');
    expect(capabilityCheck?.details?.untestable).toBe(true);
  }, 10000);
});

// Issue #505: completion type alone does not establish fixture success.
describe('SEP-2322 request-state completion semantics', () => {
  it.each([
    ['valid', 'SUCCESS'],
    ['valid-second-text', 'SUCCESS'],
    ['missing-marker', 'FAILURE'],
    ['empty-content', 'FAILURE'],
    ['tool-error', 'FAILURE'],
    ['tool-error-with-marker', 'FAILURE'],
    ['jsonrpc-error', 'FAILURE'],
    ['input-required', 'FAILURE']
  ])(
    'request-state %s emits %s',
    async (mode, expected) => {
      const port = await getFreePort();
      let proc: ChildProcess | null = null;
      try {
        proc = await startServer(
          path.join(
            process.cwd(),
            'examples/servers/typescript/sep-2322-mrtr-broken-server.ts'
          ),
          port,
          { MRTR_REQUEST_STATE_MODE: mode }
        );
        const checks = await new InputRequiredResultRequestStateScenario().run(
          testContext(`http://localhost:${port}/mcp`)
        );
        // Prove the second check was reached with a valid round-1 prerequisite.
        expect(
          checks.find((c) => c.id === 'sep-2322-request-state-incomplete')
            ?.status
        ).toBe('SUCCESS');
        const complete = checks.filter(
          (c) => c.id === 'sep-2322-request-state-complete'
        );
        expect(complete).toHaveLength(1);
        expect(complete[0].status).toBe(expected);
        if (mode.startsWith('tool-error')) {
          expect(complete[0].errorMessage).toContain('isError');
        }
        if (mode === 'missing-marker' || mode === 'empty-content') {
          expect(complete[0].errorMessage).toContain('state-ok');
        }
      } finally {
        await stopServer(proc);
      }
    },
    20000
  );
});
