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
  InputRequiredResultTamperedStateScenario
} from './input-required-result';

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

function startServer(scriptPath: string, port: number): Promise<ChildProcess> {
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
});
