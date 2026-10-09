import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { createServer } from 'net';
import path from 'path';
import { testContext } from '../../connection/testing';
import { ToolsCallProtocolErrorScenario } from './tools-call-protocol-error';
import { DRAFT_PROTOCOL_VERSION } from '../../types';

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
    const proc = spawn('npx', ['tsx', scriptPath], {
      env: { ...process.env, PORT: port.toString() },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32'
    });
    let stderr = '';
    proc.stderr?.on('data', (d) => (stderr += d.toString()));
    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`Server failed to start within 30s: ${stderr}`));
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

describe('tools-call-protocol-error negative test', () => {
  let serverProcess: ChildProcess | null = null;
  let serverUrl: string;

  beforeAll(async () => {
    const port = await getFreePort();
    serverUrl = `http://localhost:${port}/mcp`;
    serverProcess = await startServer(
      path.join(
        process.cwd(),
        'examples/servers/typescript/tools-call-unknown-tool-as-result.ts'
      ),
      port
    );
  }, 35000);

  afterAll(async () => {
    await stopServer(serverProcess);
  });

  it('fails the protocol-error and id checks against a server that answers an unknown tool with isError and stringifies ids', async () => {
    const checks = await new ToolsCallProtocolErrorScenario().run(
      testContext(serverUrl, DRAFT_PROTOCOL_VERSION)
    );
    const byId = new Map(checks.map((c) => [c.id, c]));

    expect(byId.get('tools-call-unknown-tool-protocol-error')?.status).toBe(
      'FAILURE'
    );
    expect(
      byId.get('tools-call-unknown-tool-protocol-error')?.errorMessage
    ).toMatch(/isError: true/);
    // The error-frame checks cannot run without an error frame and report that
    // rather than SKIPPED (issue #248).
    expect(byId.get('jsonrpc-error-code-integer')?.status).toBe('FAILURE');
    expect(byId.get('jsonrpc-error-code-integer')?.errorMessage).toMatch(
      /^Not testable:/
    );
    expect(byId.get('tools-call-unknown-tool-error-code')?.status).toBe(
      'WARNING'
    );
    // The result path is independent of the error path: a string id survives
    // this fixture's stringification, so the result-id check passes here...
    expect(
      byId.get('jsonrpc-result-response-id-string-preserved')?.status
    ).toBe('SUCCESS');
    // ...while every check id is emitted exactly once.
    expect(checks.map((c) => c.id).sort()).toEqual(
      [
        'jsonrpc-error-code-integer',
        'jsonrpc-error-message-string',
        'jsonrpc-error-response-id-matches',
        'jsonrpc-error-response-id-string-preserved',
        'jsonrpc-error-response-no-result',
        'jsonrpc-result-response-id-string-preserved',
        'tools-call-unknown-tool-error-code',
        'tools-call-unknown-tool-protocol-error'
      ].sort()
    );
  }, 20000);
});
