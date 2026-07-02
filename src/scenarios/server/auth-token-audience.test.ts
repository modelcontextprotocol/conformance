import { spawn, ChildProcess } from 'child_process';
import { createServer, type Server } from 'http';
import { createServer as createNetServer } from 'net';
import path from 'path';
import { testContext } from '../../connection/testing';
import { TokenAudienceValidationScenario } from './auth-token-audience';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
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
  env: Record<string, string> = {}
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const proc = spawn('npx', ['tsx', scriptPath], {
      env: { ...process.env, PORT: port.toString(), ...env },
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

const ALL_CHECK_IDS = [
  'auth-unauthenticated-request-rejected',
  'auth-valid-audience-token-accepted',
  'auth-wrong-audience-token-rejected',
  'auth-missing-audience-token-rejected',
  'auth-expired-token-rejected',
  'auth-untrusted-token-rejected'
];

describe('auth-token-audience-validation', () => {
  const savedPortEnv = process.env.MCP_CONFORMANCE_AUTH_SERVER_PORT;

  afterAll(() => {
    if (savedPortEnv === undefined) {
      delete process.env.MCP_CONFORMANCE_AUTH_SERVER_PORT;
    } else {
      process.env.MCP_CONFORMANCE_AUTH_SERVER_PORT = savedPortEnv;
    }
  });

  describe('against the everything-server with auth enabled', () => {
    let serverProcess: ChildProcess | null = null;
    let serverUrl: string;

    beforeAll(async () => {
      const asPort = await getFreePort();
      const port = await getFreePort();
      process.env.MCP_CONFORMANCE_AUTH_SERVER_PORT = asPort.toString();
      serverUrl = `http://localhost:${port}/mcp`;
      serverProcess = await startServer(
        path.join(
          process.cwd(),
          'examples/servers/typescript/everything-server.ts'
        ),
        port,
        {
          MCP_CONFORMANCE_AUTH_ISSUER: `http://127.0.0.1:${asPort}`
          // MCP_CONFORMANCE_AUTH_AUDIENCE is intentionally omitted: the
          // fixture's default (its own /mcp URL) must match serverUrl.
        }
      );
    }, 35000);

    afterAll(async () => {
      await stopServer(serverProcess);
    });

    it('emits SUCCESS for every check', async () => {
      const scenario = new TokenAudienceValidationScenario();
      const checks = await scenario.run(testContext(serverUrl));

      expect(checks.map((c) => c.id).sort()).toEqual([...ALL_CHECK_IDS].sort());
      for (const check of checks) {
        expect(check.status, `${check.id}: ${check.errorMessage}`).toBe(
          'SUCCESS'
        );
      }
    }, 20000);
  });

  describe('against a server that skips audience validation', () => {
    let serverProcess: ChildProcess | null = null;
    let serverUrl: string;

    beforeAll(async () => {
      const asPort = await getFreePort();
      const port = await getFreePort();
      process.env.MCP_CONFORMANCE_AUTH_SERVER_PORT = asPort.toString();
      serverUrl = `http://localhost:${port}/mcp`;
      serverProcess = await startServer(
        path.join(
          process.cwd(),
          'examples/servers/typescript/auth-no-audience-validation.ts'
        ),
        port,
        { MCP_CONFORMANCE_AUTH_ISSUER: `http://127.0.0.1:${asPort}` }
      );
    }, 35000);

    afterAll(async () => {
      await stopServer(serverProcess);
    });

    it('emits FAILURE for the audience checks and SUCCESS for the rest', async () => {
      const scenario = new TokenAudienceValidationScenario();
      const checks = await scenario.run(testContext(serverUrl));
      const byId = new Map(checks.map((c) => [c.id, c]));

      expect(byId.get('auth-wrong-audience-token-rejected')?.status).toBe(
        'FAILURE'
      );
      expect(byId.get('auth-missing-audience-token-rejected')?.status).toBe(
        'FAILURE'
      );

      // Signature, expiry, and baseline behaviour are intact, so the broken
      // audience validation is the only thing flagged.
      expect(byId.get('auth-unauthenticated-request-rejected')?.status).toBe(
        'SUCCESS'
      );
      expect(byId.get('auth-valid-audience-token-accepted')?.status).toBe(
        'SUCCESS'
      );
      expect(byId.get('auth-expired-token-rejected')?.status).toBe('SUCCESS');
      expect(byId.get('auth-untrusted-token-rejected')?.status).toBe('SUCCESS');
    }, 20000);
  });

  describe('against a server without authorization enabled', () => {
    let plainServer: Server;
    let serverUrl: string;

    beforeAll(async () => {
      const port = await getFreePort();
      serverUrl = `http://localhost:${port}/mcp`;
      // Minimal unauthenticated server: accepts the initialize probe with a
      // JSON-RPC result, no token required.
      plainServer = createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', () => {
          let id: unknown = null;
          try {
            id = (JSON.parse(raw) as { id?: unknown }).id ?? null;
          } catch {
            // ignore malformed body; respond with id null
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id,
              result: {
                protocolVersion: '2025-11-25',
                capabilities: {},
                serverInfo: { name: 'no-auth', version: '1.0.0' }
              }
            })
          );
        });
      });
      await new Promise<void>((resolve) =>
        plainServer.listen(port, () => resolve())
      );
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) =>
        plainServer.close((err) => (err ? reject(err) : resolve()))
      );
    });

    it('emits SKIPPED for every check (authorization is optional)', async () => {
      const scenario = new TokenAudienceValidationScenario();
      const checks = await scenario.run(testContext(serverUrl));

      expect(checks.map((c) => c.id).sort()).toEqual([...ALL_CHECK_IDS].sort());
      for (const check of checks) {
        expect(check.status, check.id).toBe('SKIPPED');
      }
    }, 15000);
  });
});
