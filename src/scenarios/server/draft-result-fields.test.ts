import { spawn, ChildProcess } from 'child_process';
import { createServer } from 'net';
import path from 'path';
import { DRAFT_PROTOCOL_VERSION } from '../../types';

/**
 * Pins that the stateless everything-server fixture answers `tools/call` with
 * spec-valid results on the 2026-07-28 wire.
 *
 * Two branches hand-write a chunked response instead of going through
 * `sendStatelessJson` — they emit a notification before the result, so they
 * cannot use `res.json()`. Bypassing the shared normalization left their
 * results without `resultType`, while the 2026-07-28 result-response rule makes
 * `resultType` a MUST, so the reference fixture violated the very rule the
 * suite grades. The client-direction counterpart of this pin lives in
 * ../client/draft-result-fields.test.ts.
 */

const meta = {
  'io.modelcontextprotocol/protocolVersion': DRAFT_PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {}
};

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

interface Frame {
  method?: string;
  result?: Record<string, unknown>;
}

/** Call a tool and return the JSON lines the server wrote on the response. */
async function callTool(serverUrl: string, name: string): Promise<Frame[]> {
  const response = await fetch(serverUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': DRAFT_PROTOCOL_VERSION
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: {}, _meta: meta }
    })
  });
  expect(response.status).toBe(200);
  return (await response.text())
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Frame);
}

describe('everything-server stateless tools/call results (2026-07-28)', () => {
  let proc: ChildProcess | null = null;
  let serverUrl: string;

  beforeAll(async () => {
    const port = await getFreePort();
    serverUrl = `http://127.0.0.1:${port}/mcp`;
    proc = await startServer(
      path.join(
        process.cwd(),
        'examples/servers/typescript/everything-server.ts'
      ),
      port
    );
  }, 60000);

  afterAll(async () => {
    await stopServer(proc);
  });

  // Both branches stream an optional notification and then a hand-written
  // result. The request sends no logLevel `_meta`, so only the elicitation
  // branch — which writes its notification unconditionally — has one.
  const cases = [
    {
      name: 'test_logging_tool',
      text: 'Logging evaluated',
      notification: undefined
    },
    {
      name: 'test_streaming_elicitation',
      text: 'Streaming complete',
      notification: 'notifications/progress'
    }
  ];

  for (const c of cases) {
    it(`${c.name} result carries the draft-required resultType`, async () => {
      const frames = await callTool(serverUrl, c.name);
      const result = frames.find((f) => f.result !== undefined);

      if (c.notification === undefined) {
        expect(frames.filter((f) => f.method !== undefined)).toEqual([]);
      } else {
        expect(frames.map((f) => f.method)).toContain(c.notification);
      }

      expect(
        result,
        `no result frame in ${JSON.stringify(frames)}`
      ).toBeDefined();
      expect(result!.result).toEqual({
        resultType: 'complete',
        content: [{ type: 'text', text: c.text }]
      });
    });
  }
});
