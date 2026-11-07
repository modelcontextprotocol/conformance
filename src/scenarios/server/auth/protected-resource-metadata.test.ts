import { spawn, ChildProcess } from 'child_process';
import { createServer as createHttpServer, type Server } from 'http';
import { createServer } from 'net';
import path from 'path';
import { testContext } from '../../../connection/testing';
import {
  ProtectedResourceMetadataScenario,
  PRM_DECLARED_CHECK_IDS
} from './protected-resource-metadata';
import {
  acceptedResources,
  parseChallenges,
  REQUEST_TIMEOUT_MS,
  wellKnownUrls
} from './prm';
import type { ConformanceCheck } from '../../../types';

const FIXTURE = path.join(
  process.cwd(),
  'examples/servers/typescript/auth-prm-server.ts'
);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function startServer(
  port: number,
  env: Record<string, string>
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const proc = spawn('npx', ['tsx', FIXTURE], {
      env: { ...process.env, PORT: port.toString(), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows
    });
    let stderr = '';
    proc.stderr?.on('data', (d) => (stderr += d.toString()));
    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(
        new Error(`Server ${FIXTURE} failed to start within 30s: ${stderr}`)
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

async function runAgainst(
  breakMode: string,
  specVersion?: '2025-06-18' | '2025-11-25' | '2026-07-28'
): Promise<ConformanceCheck[]> {
  const port = await freePort();
  const proc = await startServer(port, { PRM_BREAK: breakMode });
  try {
    return await new ProtectedResourceMetadataScenario().run(
      testContext(`http://localhost:${port}/mcp`, specVersion)
    );
  } finally {
    await stopServer(proc);
  }
}

function byId(checks: ConformanceCheck[], id: string): ConformanceCheck {
  const found = checks.filter((c) => c.id === id);
  expect(found, id).toHaveLength(1);
  return found[0];
}

// server-www-authenticate-scope is not graded at 2025-06-18.
const SKIPPED_AT_2025_06_18 = ['server-www-authenticate-scope'];

function expectAllPass(
  checks: ConformanceCheck[],
  skipped: string[] = []
): void {
  expect(checks.map((c) => c.id).sort()).toEqual(
    [...PRM_DECLARED_CHECK_IDS].sort()
  );
  for (const check of checks) {
    expect(check.status, `${check.id}: ${check.errorMessage}`).toBe(
      skipped.includes(check.id) ? 'SKIPPED' : 'SUCCESS'
    );
  }
}

function expectOnlyFailing(
  checks: ConformanceCheck[],
  id: string,
  severity: 'FAILURE' | 'WARNING',
  skipped: string[] = []
): ConformanceCheck {
  expect(checks.map((c) => c.id).sort()).toEqual(
    [...PRM_DECLARED_CHECK_IDS].sort()
  );
  for (const check of checks) {
    if (check.id === id) continue;
    expect(check.status, `${check.id}: ${check.errorMessage}`).toBe(
      skipped.includes(check.id) ? 'SKIPPED' : 'SUCCESS'
    );
  }
  const failing = byId(checks, id);
  expect(failing.status).toBe(severity);
  expect(failing.details?.untestable).toBeUndefined();
  return failing;
}

describe('auth/protected-resource-metadata', () => {
  describe('compliant fixture', () => {
    it('passes every check at the latest dated version', async () => {
      expectAllPass(await runAgainst('none'));
    }, 40000);

    it('passes every check at the draft version', async () => {
      expectAllPass(await runAgainst('none', '2026-07-28'));
    }, 40000);

    it('passes every check at 2025-06-18, scope check skipped', async () => {
      const checks = await runAgainst('none', '2025-06-18');
      expectAllPass(checks, SKIPPED_AT_2025_06_18);
      const scope = byId(checks, 'server-www-authenticate-scope');
      expect(scope.errorMessage).toContain('2025-11-25');
      expect(scope.details?.untestable).toBeUndefined();
    }, 40000);

    it('fetches a challenge URL that equals the well-known URL once', async () => {
      const checks = await runAgainst('none');
      expectAllPass(checks);
      const attempts = byId(checks, 'server-prm-discovery').details
        ?.attempts as Array<{ source: string; url: string }>;
      expect(attempts).toHaveLength(1);
      expect(attempts[0].source).toBe('resource_metadata');
    }, 40000);

    it('accepts the origin as resource for metadata at the root well-known URL', async () => {
      const checks = await runAgainst('root-well-known');
      expectAllPass(checks);
      expect(byId(checks, 'server-prm-resource').details?.accepted).toContain(
        byId(checks, 'server-prm-resource').details?.resource
      );
    }, 40000);

    it('accepts bearer_methods_supported: [], which RFC 9728 §2 allows', async () => {
      const checks = await runAgainst('empty-bearer-methods-supported');
      expectAllPass(checks);
      expect(
        byId(checks, 'server-prm-response').details?.bodyPreview
      ).toContain('"bearer_methods_supported":[]');
    }, 40000);
  });

  describe('well-known only', () => {
    it('passes at 2025-11-25 via the path-based well-known URL', async () => {
      const checks = await runAgainst('well-known-only', '2025-11-25');
      expectAllPass(checks);
      const attempts = byId(checks, 'server-prm-discovery').details
        ?.attempts as Array<{ source: string; statusCode: number }>;
      expect(attempts[0]).toMatchObject({
        source: 'well-known-path',
        statusCode: 200
      });
    }, 40000);

    it('fails discovery at 2025-06-18, which requires the challenge URL', async () => {
      const checks = await runAgainst('well-known-only', '2025-06-18');
      const failing = expectOnlyFailing(
        checks,
        'server-prm-discovery',
        'FAILURE',
        SKIPPED_AT_2025_06_18
      );
      expect(failing.errorMessage).toContain('2025-06-18');
    }, 40000);
  });

  describe('break modes', () => {
    it('no-prm fails discovery and leaves the document checks untestable', async () => {
      const checks = await runAgainst('no-prm');
      const discovery = byId(checks, 'server-prm-discovery');
      expect(discovery.status).toBe('FAILURE');
      expect(discovery.details?.untestable).toBeUndefined();
      expect(discovery.errorMessage).toContain('no resource_metadata');
      for (const id of [
        'server-prm-response',
        'server-prm-resource',
        'server-prm-authorization-servers',
        'server-prm-no-empty-parameters'
      ]) {
        const check = byId(checks, id);
        expect(check.status, id).toBe('FAILURE');
        expect(check.errorMessage, id).toContain('Not testable:');
        expect(check.details, id).toMatchObject({ untestable: true });
      }
      expect(byId(checks, 'server-auth-401').status).toBe('SUCCESS');
      expect(byId(checks, 'server-www-authenticate-scope').status).toBe(
        'SUCCESS'
      );
    }, 40000);

    it('challenge-404 fails discovery even though the well-known document works', async () => {
      const failing = expectOnlyFailing(
        await runAgainst('challenge-404'),
        'server-prm-discovery',
        'FAILURE'
      );
      expect(failing.errorMessage).toContain('/missing-prm');
      expect(failing.errorMessage).toContain('HTTP 404');
    }, 40000);

    it('wrong-content-type fails the response check', async () => {
      const failing = expectOnlyFailing(
        await runAgainst('wrong-content-type'),
        'server-prm-response',
        'FAILURE'
      );
      expect(failing.errorMessage).toContain('text/html');
    }, 40000);

    it('wrong-resource fails the resource check', async () => {
      const failing = expectOnlyFailing(
        await runAgainst('wrong-resource'),
        'server-prm-resource',
        'FAILURE'
      );
      expect(failing.errorMessage).toContain('https://attacker.example/mcp');
    }, 40000);

    it('missing-resource fails the resource check', async () => {
      const failing = expectOnlyFailing(
        await runAgainst('missing-resource'),
        'server-prm-resource',
        'FAILURE'
      );
      expect(failing.errorMessage).toContain('resource is missing');
    }, 40000);

    it('missing-authorization-servers fails the authorization_servers check', async () => {
      const failing = expectOnlyFailing(
        await runAgainst('missing-authorization-servers'),
        'server-prm-authorization-servers',
        'FAILURE'
      );
      expect(failing.errorMessage).toContain('missing');
    }, 40000);

    it('empty-authorization-servers fails the MCP rule and RFC 9728 §3.2', async () => {
      const checks = await runAgainst('empty-authorization-servers');
      const failing = [
        'server-prm-authorization-servers',
        'server-prm-no-empty-parameters'
      ];
      for (const check of checks) {
        expect(check.status, check.id).toBe(
          failing.includes(check.id) ? 'FAILURE' : 'SUCCESS'
        );
      }
      expect(
        byId(checks, 'server-prm-authorization-servers').errorMessage
      ).toContain('empty');
      expect(
        byId(checks, 'server-prm-no-empty-parameters').errorMessage
      ).toContain('authorization_servers');
    }, 40000);

    it('empty-scopes-supported fails the zero-value check', async () => {
      const failing = expectOnlyFailing(
        await runAgainst('empty-scopes-supported'),
        'server-prm-no-empty-parameters',
        'FAILURE'
      );
      expect(failing.errorMessage).toContain('scopes_supported');
      expect(failing.details?.empty).toEqual(['scopes_supported']);
    }, 40000);

    it('status-403 fails the 401 check', async () => {
      const failing = expectOnlyFailing(
        await runAgainst('status-403'),
        'server-auth-401',
        'FAILURE'
      );
      expect(failing.errorMessage).toContain('got 403');
    }, 40000);

    it('no-scope warns on the scope check', async () => {
      const failing = expectOnlyFailing(
        await runAgainst('no-scope'),
        'server-www-authenticate-scope',
        'WARNING'
      );
      expect(failing.errorMessage).toContain('scope');
    }, 40000);

    it('no-auth makes every check untestable, never SKIPPED', async () => {
      const checks = await runAgainst('no-auth');
      expect(checks.map((c) => c.id).sort()).toEqual(
        [...PRM_DECLARED_CHECK_IDS].sort()
      );
      for (const check of checks) {
        expect(check.status, check.id).toBe(
          check.id === 'server-www-authenticate-scope' ? 'WARNING' : 'FAILURE'
        );
        expect(check.errorMessage, check.id).toContain('Not testable:');
        expect(check.details, check.id).toMatchObject({ untestable: true });
      }
      expect(checks.every((c) => c.status !== 'SKIPPED')).toBe(true);
    }, 40000);
  });
});

describe('timeouts', () => {
  // A server that never ends its response must not hang the suite: each
  // request is bounded to REQUEST_TIMEOUT_MS (10 s) and the scenario reports
  // the timeout instead of waiting.
  let server: Server;
  let url: string;
  let mode: 'probe-hangs' | 'metadata-hangs';

  beforeAll(async () => {
    server = createHttpServer((req, res) => {
      if (req.method === 'POST' && req.url === '/mcp') {
        if (mode === 'probe-hangs') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(': open\n\n');
          return; // never ends
        }
        res.writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${url}/prm", scope="mcp:read"`
        });
        res.end('{"error":"unauthorized"}');
        return;
      }
      if (req.method === 'GET' && req.url === '/prm') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"resource":');
        return; // never ends
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    url = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reports every check untestable when the probe response never ends', async () => {
    mode = 'probe-hangs';
    const started = Date.now();
    const checks = await new ProtectedResourceMetadataScenario().run(
      testContext(`${url}/mcp`)
    );
    expect(Date.now() - started).toBeLessThan(15000);
    expect(checks.map((c) => c.id).sort()).toEqual(
      [...PRM_DECLARED_CHECK_IDS].sort()
    );
    for (const check of checks) {
      expect(check.errorMessage, check.id).toContain('Not testable:');
      expect(check.errorMessage, check.id).toContain(
        `timed out after ${REQUEST_TIMEOUT_MS} ms`
      );
    }
  }, 20000);

  it('fails discovery when the metadata body never ends', async () => {
    mode = 'metadata-hangs';
    const started = Date.now();
    const checks = await new ProtectedResourceMetadataScenario().run(
      testContext(`${url}/mcp`)
    );
    expect(Date.now() - started).toBeLessThan(15000);
    expect(byId(checks, 'server-auth-401').status).toBe('SUCCESS');
    const discovery = byId(checks, 'server-prm-discovery');
    expect(discovery.status).toBe('FAILURE');
    expect(discovery.details?.untestable).toBeUndefined();
    expect(discovery.errorMessage).toContain(
      `timed out after ${REQUEST_TIMEOUT_MS} ms`
    );
  }, 20000);
});

describe('zero-valued parameters', () => {
  // RFC 9728 §3.2 read against documents the fixture has no break mode for.
  let server: Server;
  let url: string;
  let extra: Record<string, unknown>;
  let rawBody: string | undefined;

  beforeAll(async () => {
    server = createHttpServer((req, res) => {
      if (req.method === 'POST' && req.url === '/mcp') {
        res.writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${url}/prm", scope="mcp:read"`
        });
        res.end('{"error":"unauthorized"}');
        return;
      }
      if (req.method === 'GET' && req.url === '/prm') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          rawBody ??
            JSON.stringify({
              resource: `${url}/mcp`,
              authorization_servers: ['https://auth.example.com'],
              ...extra
            })
        );
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    url = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function grade(
    parameters: Record<string, unknown>
  ): Promise<ConformanceCheck[]> {
    extra = parameters;
    rawBody = undefined;
    return new ProtectedResourceMetadataScenario().run(
      testContext(`${url}/mcp`)
    );
  }

  it.each([
    'scopes_supported',
    'resource_signing_alg_values_supported',
    'authorization_details_types_supported',
    'dpop_signing_alg_values_supported'
  ])('fails on an empty %s', async (parameter) => {
    const failing = expectOnlyFailing(
      await grade({ [parameter]: [] }),
      'server-prm-no-empty-parameters',
      'FAILURE'
    );
    expect(failing.errorMessage).toContain(parameter);
  });

  it('names every empty parameter in one failure', async () => {
    const failing = expectOnlyFailing(
      await grade({
        scopes_supported: [],
        dpop_signing_alg_values_supported: [],
        bearer_methods_supported: []
      }),
      'server-prm-no-empty-parameters',
      'FAILURE'
    );
    expect(failing.details?.empty).toEqual([
      'scopes_supported',
      'dpop_signing_alg_values_supported'
    ]);
  });

  it.each([
    ['a populated array', { scopes_supported: ['mcp:read'] }],
    ['bearer_methods_supported: []', { bearer_methods_supported: [] }],
    ['a single-valued parameter that is empty', { resource_name: '' }],
    ['a boolean set to false', { dpop_bound_access_tokens_required: false }],
    ['an empty parameter it does not understand', { example_extension: [] }],
    // null is a type problem, not zero values, and nothing here checks types.
    ['scopes_supported: null', { scopes_supported: null }],
    ['a listed parameter set to an empty string', { scopes_supported: '' }],
    ['a listed parameter set to false', { scopes_supported: false }],
    ['a listed parameter set to 0', { scopes_supported: 0 }]
  ])('passes on %s', async (_name, parameters) => {
    expectAllPass(await grade(parameters));
  });

  it.each([
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
    ['invalid JSON', '{']
  ])('leaves the document checks untestable on %s', async (_name, body) => {
    rawBody = body;
    const checks = await new ProtectedResourceMetadataScenario().run(
      testContext(`${url}/mcp`)
    );
    expect(checks.map((c) => c.id).sort()).toEqual(
      [...PRM_DECLARED_CHECK_IDS].sort()
    );
    const response = byId(checks, 'server-prm-response');
    expect(response.status).toBe('FAILURE');
    expect(response.details?.untestable).toBeUndefined();
    for (const id of [
      'server-prm-resource',
      'server-prm-authorization-servers',
      'server-prm-no-empty-parameters'
    ]) {
      const check = byId(checks, id);
      expect(check.status, id).toBe('FAILURE');
      expect(check.errorMessage, id).toContain('Not testable:');
      expect(check.details, id).toMatchObject({ untestable: true });
    }
  });
});

describe('prm helpers', () => {
  it('keeps the Bearer challenge after a token68 challenge', () => {
    expect(
      parseChallenges(
        'Negotiate abc==, Bearer resource_metadata="https://x.example/.well-known/oauth-protected-resource"'
      )
    ).toEqual([
      { scheme: 'Negotiate', params: {} },
      {
        scheme: 'Bearer',
        params: {
          resource_metadata:
            'https://x.example/.well-known/oauth-protected-resource'
        }
      }
    ]);
  });

  it('reads an unquoted resource_metadata value up to the next comma or space', () => {
    expect(
      parseChallenges(
        'Bearer resource_metadata=https://x.example/.well-known/oauth-protected-resource/mcp, scope=mcp:read'
      )
    ).toEqual([
      {
        scheme: 'Bearer',
        params: {
          resource_metadata:
            'https://x.example/.well-known/oauth-protected-resource/mcp',
          scope: 'mcp:read'
        }
      }
    ]);
  });

  it('parses multiple challenges with quoted and bare params', () => {
    const challenges = parseChallenges(
      'Bearer realm="mcp", scope="a b", resource_metadata="https://x.example/.well-known/oauth-protected-resource/mcp", DPoP algs=ES256'
    );
    expect(challenges).toEqual([
      {
        scheme: 'Bearer',
        params: {
          realm: 'mcp',
          scope: 'a b',
          resource_metadata:
            'https://x.example/.well-known/oauth-protected-resource/mcp'
        }
      },
      { scheme: 'DPoP', params: { algs: 'ES256' } }
    ]);
  });

  it('unescapes quoted-pair characters', () => {
    expect(parseChallenges('Bearer error_description="say \\"hi\\""')).toEqual([
      { scheme: 'Bearer', params: { error_description: 'say "hi"' } }
    ]);
  });

  it('derives the path-based well-known URL before the root one', () => {
    expect(wellKnownUrls('http://localhost:9/public/mcp')).toEqual({
      pathBased:
        'http://localhost:9/.well-known/oauth-protected-resource/public/mcp',
      root: 'http://localhost:9/.well-known/oauth-protected-resource'
    });
    expect(wellKnownUrls('http://localhost:9/')).toEqual({
      pathBased: 'http://localhost:9/.well-known/oauth-protected-resource',
      root: 'http://localhost:9/.well-known/oauth-protected-resource'
    });
  });

  it('accepts the origin only for a document at the root well-known URL', () => {
    expect(
      acceptedResources(
        'http://localhost:9/mcp',
        'http://localhost:9/.well-known/oauth-protected-resource'
      )
    ).toEqual([
      'http://localhost:9/mcp',
      'http://localhost:9',
      'http://localhost:9/'
    ]);
    expect(
      acceptedResources(
        'http://localhost:9/mcp',
        'http://localhost:9/.well-known/oauth-protected-resource/mcp'
      )
    ).toEqual(['http://localhost:9/mcp']);
  });
});
