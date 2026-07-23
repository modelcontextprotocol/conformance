import { testContext } from '../../connection/testing';
import { spawn, ChildProcess } from 'child_process';
import { createServer, type IncomingMessage, type Server } from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { DNSRebindingProtectionScenario } from './dns-rebinding';
import { ResourcesNotFoundErrorScenario } from './resources';
import { CachingScenario } from './caching';
import {
  JsonSchema2020_12Scenario,
  sep2106KeywordCheckStatus
} from './json-schema-2020-12';
import { DRAFT_PROTOCOL_VERSION, LATEST_SPEC_VERSION } from '../../types';

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

async function readJsonBody(
  req: IncomingMessage
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
    string,
    unknown
  >;
}

function listenOnRandomPort(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Server did not listen on a TCP port'));
        return;
      }
      resolve(`http://localhost:${(address as AddressInfo).port}/mcp`);
    });
  });
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

describe('Server scenario negative tests', () => {
  describe('dns-rebinding-protection', () => {
    let serverProcess: ChildProcess | null = null;
    const PORT = 3004;

    beforeAll(async () => {
      serverProcess = await startServer(
        path.join(
          process.cwd(),
          'examples/servers/typescript/no-dns-rebinding-protection.ts'
        ),
        PORT
      );
    }, 35000);

    afterAll(async () => {
      await stopServer(serverProcess);
    });

    it('emits FAILURE against a server without rebinding protection', async () => {
      const scenario = new DNSRebindingProtectionScenario();
      const checks = await scenario.run(
        testContext(`http://localhost:${PORT}/mcp`)
      );

      const rebindingCheck = checks.find(
        (c) => c.id === 'localhost-host-rebinding-rejected'
      );
      expect(rebindingCheck?.status).toBe('FAILURE');
    }, 10000);

    it('sends initialized notification after a successful dated initialize', async () => {
      const requests: Array<{
        method?: string;
        host?: string;
        origin?: string;
        sessionId?: string;
      }> = [];
      const sessionId = 'session-338';
      const server = createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/mcp') {
          res.writeHead(404).end();
          return;
        }

        const body = await readJsonBody(req);
        const method =
          typeof body.method === 'string' ? body.method : undefined;
        requests.push({
          method,
          host: req.headers.host,
          origin:
            typeof req.headers.origin === 'string'
              ? req.headers.origin
              : undefined,
          sessionId:
            typeof req.headers['mcp-session-id'] === 'string'
              ? req.headers['mcp-session-id']
              : undefined
        });

        if (
          req.headers.host === 'evil.example.com' ||
          req.headers.origin === 'http://evil.example.com'
        ) {
          res
            .writeHead(403, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ error: 'forbidden' }));
          return;
        }

        if (method === 'initialize') {
          res
            .writeHead(200, {
              'Content-Type': 'application/json',
              'Mcp-Session-Id': sessionId
            })
            .end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: body.id,
                result: {
                  protocolVersion: LATEST_SPEC_VERSION,
                  capabilities: {},
                  serverInfo: {
                    name: 'dns-rebinding-lifecycle-test',
                    version: '1.0.0'
                  }
                }
              })
            );
          return;
        }

        if (method === 'notifications/initialized') {
          res.writeHead(
            req.headers['mcp-session-id'] === sessionId ? 202 : 400
          );
          res.end();
          return;
        }

        res.writeHead(500).end();
      });

      const serverUrl = await listenOnRandomPort(server);
      try {
        const checks = await new DNSRebindingProtectionScenario().run(
          testContext(serverUrl, LATEST_SPEC_VERSION)
        );

        expect(
          checks.find((c) => c.id === 'localhost-host-rebinding-rejected')
            ?.status
        ).toBe('SUCCESS');
        expect(
          checks.find((c) => c.id === 'localhost-host-valid-accepted')?.status
        ).toBe('SUCCESS');

        const validHost = new URL(serverUrl).host;
        expect(requests).toEqual([
          expect.objectContaining({
            method: 'initialize',
            host: 'evil.example.com',
            origin: 'http://evil.example.com'
          }),
          expect.objectContaining({
            method: 'initialize',
            host: validHost,
            origin: `http://${validHost}`
          }),
          expect.objectContaining({
            method: 'notifications/initialized',
            host: validHost,
            origin: `http://${validHost}`,
            sessionId
          })
        ]);
      } finally {
        await closeHttpServer(server);
      }
    }, 10000);

    it('does not send initialized notification for the draft discover probe', async () => {
      const methods: Array<string | undefined> = [];
      const server = createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/mcp') {
          res.writeHead(404).end();
          return;
        }

        const body = await readJsonBody(req);
        const method =
          typeof body.method === 'string' ? body.method : undefined;
        methods.push(method);

        if (
          req.headers.host === 'evil.example.com' ||
          req.headers.origin === 'http://evil.example.com'
        ) {
          res
            .writeHead(403, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ error: 'forbidden' }));
          return;
        }

        if (method === 'server/discover') {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: {}
            })
          );
          return;
        }

        res.writeHead(500).end();
      });

      const serverUrl = await listenOnRandomPort(server);
      try {
        const checks = await new DNSRebindingProtectionScenario().run(
          testContext(serverUrl, DRAFT_PROTOCOL_VERSION)
        );

        expect(
          checks.find((c) => c.id === 'localhost-host-rebinding-rejected')
            ?.status
        ).toBe('SUCCESS');
        expect(
          checks.find((c) => c.id === 'localhost-host-valid-accepted')?.status
        ).toBe('SUCCESS');
        expect(methods).toEqual(['server/discover', 'server/discover']);
      } finally {
        await closeHttpServer(server);
      }
    }, 10000);
  });

  describe('sep-2164-resource-not-found', () => {
    let serverProcess: ChildProcess | null = null;
    const PORT = 3005;

    beforeAll(async () => {
      serverProcess = await startServer(
        path.join(
          process.cwd(),
          'examples/servers/typescript/sep-2164-empty-contents.ts'
        ),
        PORT
      );
    }, 35000);

    afterAll(async () => {
      await stopServer(serverProcess);
    });

    it('emits FAILURE for no-empty-contents and WARNING for error-code against a server returning empty contents', async () => {
      const scenario = new ResourcesNotFoundErrorScenario();
      const checks = await scenario.run(
        testContext(`http://localhost:${PORT}/mcp`, DRAFT_PROTOCOL_VERSION)
      );

      const noEmpty = checks.find((c) => c.id === 'sep-2164-no-empty-contents');
      expect(noEmpty?.status).toBe('FAILURE');

      const errorCode = checks.find((c) => c.id === 'sep-2164-error-code');
      expect(errorCode?.status).toBe('WARNING');
    }, 10000);
  });

  describe('sep-2549-caching-hints', () => {
    let serverProcess: ChildProcess | null = null;
    const PORT = 3006;

    beforeAll(async () => {
      serverProcess = await startServer(
        path.join(
          process.cwd(),
          'examples/servers/typescript/sep-2549-no-caching-hints.ts'
        ),
        PORT
      );
    }, 35000);

    afterAll(async () => {
      await stopServer(serverProcess);
    });

    it('emits FAILURE for presence checks against a server without caching hints', async () => {
      const scenario = new CachingScenario();
      const checks = await scenario.run(
        testContext(`http://localhost:${PORT}/mcp`, DRAFT_PROTOCOL_VERSION)
      );

      // Should have at least 7 checks (5 presence + 2 aggregate)
      expect(checks.length).toBeGreaterThanOrEqual(7);

      const presenceCheckIds = [
        'sep-2549-tools-list-caching-hints',
        'sep-2549-prompts-list-caching-hints',
        'sep-2549-resources-list-caching-hints',
        'sep-2549-resources-templates-list-caching-hints',
        'sep-2549-resources-read-caching-hints'
      ];

      for (const checkId of presenceCheckIds) {
        const check = checks.find((c) => c.id === checkId);
        expect(check).toBeDefined();
        expect(check?.status).toBe('FAILURE');
      }
    }, 15000);
  });

  describe('json-schema-2020-12 (SEP-2106)', () => {
    let serverProcess: ChildProcess | null = null;
    const PORT = 3007;

    beforeAll(async () => {
      serverProcess = await startServer(
        path.join(
          process.cwd(),
          'examples/servers/typescript/sep-2106-stripped-schema.ts'
        ),
        PORT
      );
    }, 35000);

    afterAll(async () => {
      await stopServer(serverProcess);
    });

    it('flags SEP-2106 keyword-preservation checks against a server that strips the 2020-12 vocabulary', async () => {
      const scenario = new JsonSchema2020_12Scenario();
      const checks = await scenario.run(
        testContext(`http://localhost:${PORT}/mcp`)
      );

      // The tool is still advertised, so it must be found...
      const found = checks.find(
        (c) => c.id === 'json-schema-2020-12-tool-found'
      );
      expect(found?.status).toBe('SUCCESS');

      // ...but the stripped 2020-12 keywords must be flagged. testContext()
      // defaults to LATEST_SPEC_VERSION (2025-11-25), so the soft version gate
      // reports SKIPPED rather than FAILURE; see sep2106KeywordCheckStatus.
      const composition = checks.find(
        (c) => c.id === 'sep-2106-composition-keywords-preserved'
      );
      expect(composition?.status).toBe('SKIPPED');

      const conditional = checks.find(
        (c) => c.id === 'sep-2106-conditional-keywords-preserved'
      );
      expect(conditional?.status).toBe('SKIPPED');

      const anchor = checks.find(
        (c) => c.id === 'sep-2106-anchor-keyword-preserved'
      );
      expect(anchor?.status).toBe('SKIPPED');
    }, 10000);
  });

  describe('sep2106KeywordCheckStatus (soft version gate)', () => {
    it('passes preserved keywords at any target version', () => {
      expect(sep2106KeywordCheckStatus(true, DRAFT_PROTOCOL_VERSION)).toBe(
        'SUCCESS'
      );
      expect(sep2106KeywordCheckStatus(true, LATEST_SPEC_VERSION)).toBe(
        'SUCCESS'
      );
    });

    it('fails stripped keywords only when targeting the draft version', () => {
      expect(sep2106KeywordCheckStatus(false, DRAFT_PROTOCOL_VERSION)).toBe(
        'FAILURE'
      );
      expect(sep2106KeywordCheckStatus(false, LATEST_SPEC_VERSION)).toBe(
        'SKIPPED'
      );
    });
  });
});
