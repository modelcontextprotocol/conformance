/**
 * Which wire does the everything-server think a request is on?
 *
 * `_meta` is part of the base request shape in every revision, so a
 * session-era request may carry it (MCP Python SDK 2.x sends `_meta: {}` on
 * `initialize`). Classifying by its presence rejected that traffic — -32020
 * without a header, -32602 with a session-era one — and made the fixture
 * unusable as an upstream server for those clients (#506).
 *
 * These probes pin both halves: session-era traffic carrying `_meta` is
 * served, and the 2026-07-28 rejections the per-request metadata envelope is
 * there to trigger still fire.
 */

import { spawn, ChildProcess } from 'child_process';
import { createServer } from 'net';
import path from 'path';

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

describe('everything-server request classification (#506)', () => {
  let serverProcess: ChildProcess | null = null;
  let serverUrl = '';

  beforeAll(async () => {
    const port = await getFreePort();
    serverUrl = `http://127.0.0.1:${port}/mcp`;
    serverProcess = await startServer(
      path.join(
        process.cwd(),
        'examples/servers/typescript/everything-server.ts'
      ),
      port
    );
  }, 60000);

  afterAll(async () => {
    await stopServer(serverProcess);
    serverProcess = null;
  });

  /** One POST, no session, with exactly the headers the caller names. */
  async function post(
    body: Record<string, unknown>,
    headers: Record<string, string> = {}
  ): Promise<{ status: number; payload: any }> {
    const res = await fetch(serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers
      },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    const line = text
      .split('\n')
      .map((l) => (l.startsWith('data:') ? l.slice(5).trim() : l.trim()))
      .find((l) => l.startsWith('{'));
    return { status: res.status, payload: line ? JSON.parse(line) : null };
  }

  const sessionEraInitialize = (meta: Record<string, unknown>) => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'classification-probe', version: '1.0.0' },
      _meta: meta
    }
  });

  const requestMetaEnvelope = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {}
  };

  it('initializes a session-era client that sends an empty _meta and no header', async () => {
    // The MCP Python SDK 2.x shape. Answering -32020 here is what made the
    // fixture unusable as its upstream server.
    const { status, payload } = await post(sessionEraInitialize({}));

    expect(payload?.error).toBeUndefined();
    expect(status).toBe(200);
    expect(payload?.result?.protocolVersion).toBe('2025-11-25');
  });

  it('initializes a session-era client whose _meta carries a progress token, with the session-era header', async () => {
    // `_meta` is base-shape in that revision; the header names the same one.
    const { status, payload } = await post(
      sessionEraInitialize({ progressToken: 'probe-1' }),
      { 'MCP-Protocol-Version': '2025-11-25' }
    );

    expect(payload?.error).toBeUndefined();
    expect(status).toBe(200);
    expect(payload?.result?.protocolVersion).toBe('2025-11-25');
  });

  it('still answers -32020 when a request-meta-era request omits the protocol header', async () => {
    const { status, payload } = await post({
      jsonrpc: '2.0',
      id: 2,
      method: 'server/discover',
      params: { _meta: requestMetaEnvelope }
    });

    expect(status).toBe(400);
    expect(payload?.error?.code).toBe(-32020);
  });

  it('still answers -32602 when the envelope is missing its protocol version', async () => {
    const { status, payload } = await post(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'server/discover',
        params: {
          _meta: {
            'io.modelcontextprotocol/clientCapabilities': {}
          }
        }
      },
      { 'MCP-Protocol-Version': '2026-07-28' }
    );

    expect(status).toBe(400);
    expect(payload?.error?.code).toBe(-32602);
  });

  it('serves a complete request-meta-era request', async () => {
    const { status, payload } = await post(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'server/discover',
        params: { _meta: requestMetaEnvelope }
      },
      { 'MCP-Protocol-Version': '2026-07-28' }
    );

    expect(status).toBe(200);
    expect(payload?.error).toBeUndefined();
    expect(payload?.result?.supportedVersions).toContain('2026-07-28');
  });
});
