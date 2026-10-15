import { testContext } from '../../connection/testing';
/**
 * SEP-1036 URL mode elicitation, server side: negative tests.
 *
 * The positive run is all-scenarios.test.ts against the everything-server.
 * These run the scenario against a deliberately broken server, and against a
 * server without the fixture tool, to verify the checks emit FAILURE.
 */

import { spawn, ChildProcess } from 'child_process';
import http from 'http';
import { createServer } from 'net';
import path from 'path';
import { ElicitationUrlModeScenario } from './elicitation-url-mode';
import {
  formatWireViolation,
  takeWireViolations
} from '../../validation/wire-schema';
import type { ConformanceCheck } from '../../types';

const SPEC_VERSION = '2026-07-28';

/**
 * Run the scenario, then drain the wire-schema recorder: the broken fixture
 * violates the schema by design. Only the implementation may be invalid; a
 * harness-origin violation is a real harness bug and still fails.
 */
async function runScenario(serverUrl: string): Promise<ConformanceCheck[]> {
  const checks = await new ElicitationUrlModeScenario().run(
    testContext(serverUrl, SPEC_VERSION)
  );
  const { violations } = takeWireViolations();
  const harnessViolations = violations.filter((v) => v.origin === 'harness');
  if (harnessViolations.length > 0) {
    throw new Error(
      'Harness-origin wire-schema violations in a URL mode negative test ' +
        '(only the fixture may be invalid here):\n  ' +
        harnessViolations.map(formatWireViolation).join('\n  ')
    );
  }
  return checks;
}

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

function findCheck(checks: ConformanceCheck[], id: string): ConformanceCheck {
  const check = checks.find((c) => c.id === id);
  if (!check) throw new Error(`Check ${id} not emitted`);
  return check;
}

/** A FAILURE that reports a violation, not a missing prerequisite. */
function expectViolation(check: ConformanceCheck): void {
  expect(check.status, check.errorMessage).toBe('FAILURE');
  expect(check.details?.untestable).toBeUndefined();
}

describe('SEP-1036 URL mode elicitation negative tests', () => {
  let serverProcess: ChildProcess | null = null;
  let checks: ConformanceCheck[] = [];

  beforeAll(async () => {
    const port = await getFreePort();
    serverProcess = await startServer(
      path.join(
        process.cwd(),
        'examples/servers/typescript/sep-1036-url-elicitation-broken-server.ts'
      ),
      port
    );
    checks = await runScenario(`http://localhost:${port}/mcp`);
  }, 45000);

  afterAll(async () => {
    await stopServer(serverProcess);
  });

  it('fails sep-1036-url-request-params when the URL-mode request has no mode', () => {
    const check = findCheck(checks, 'sep-1036-url-request-params');
    expectViolation(check);
    expect(check.errorMessage).toContain('no mode "url"');
  });

  it('fails sep-1036-url-valid when the url is not an absolute URI', () => {
    const check = findCheck(checks, 'sep-1036-url-valid');
    expectViolation(check);
    expect(check.errorMessage).toContain('not a valid absolute URI');
  });

  it('fails sep-2322-server-handles-decline-cancel when a decline is an internal error', () => {
    const check = findCheck(checks, 'sep-2322-server-handles-decline-cancel');
    expectViolation(check);
    expect(check.errorMessage).toContain('decline retry failed');
    // The cancel retry's -32042 is a deliberate error, so it counts as handled.
    expect(check.errorMessage).not.toContain('cancel retry');
  });

  it('fails sep-1036-server-no-unsupported-mode in both directions', () => {
    const check = findCheck(checks, 'sep-1036-server-no-unsupported-mode');
    expectViolation(check);
    expect(check.errorMessage).toContain('(form mode only)');
    expect(check.errorMessage).toContain('(URL mode only)');
  });

  it('fails sep-2575-server-rejects-undeclared-capability when no -32021 comes back', () => {
    const check = findCheck(
      checks,
      'sep-2575-server-rejects-undeclared-capability'
    );
    expectViolation(check);
    expect(check.errorMessage).toContain('instead of -32021');
  });

  it('reports sep-2575-missing-capability-http-400 as untestable when -32021 never comes back', () => {
    const check = findCheck(checks, 'sep-2575-missing-capability-http-400');
    expect(check.status).toBe('FAILURE');
    expect(check.errorMessage).toContain('Not testable:');
    expect(check.details?.untestable).toBe(true);
  });

  it('fails sep-1036-server-no-url-elicitation-required-error on a -32042 answer', () => {
    const check = findCheck(
      checks,
      'sep-1036-server-no-url-elicitation-required-error'
    );
    expectViolation(check);
    expect(check.errorMessage).toContain('cancel retry');
  });
});

describe('SEP-1036 URL mode elicitation against a server without the fixture tool', () => {
  let server: http.Server;
  let checks: ConformanceCheck[] = [];

  beforeAll(async () => {
    // Answers every request as an unknown tool, like an SDK server that has
    // not implemented test_url_elicitation yet.
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const { id } = JSON.parse(body) as { id: number };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: 'Unknown tool' }
          })
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as { port: number };
    checks = await runScenario(`http://localhost:${port}/mcp`);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reports every check as untestable rather than passing or failing it', () => {
    for (const id of [
      'sep-1036-url-request-params',
      'sep-1036-url-valid',
      'sep-2322-server-handles-decline-cancel',
      'sep-1036-server-no-unsupported-mode',
      'sep-2575-server-rejects-undeclared-capability',
      'sep-2575-missing-capability-http-400',
      'sep-1036-server-no-url-elicitation-required-error'
    ]) {
      const check = findCheck(checks, id);
      expect(check.status, id).toBe('FAILURE');
      expect(check.details?.untestable, id).toBe(true);
    }
  });
});
