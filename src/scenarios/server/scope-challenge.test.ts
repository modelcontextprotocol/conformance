import { spawn, type ChildProcess } from 'child_process';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { testContext } from '../../connection/testing';
import { DRAFT_PROTOCOL_VERSION } from '../../types';
import {
  SCOPE_CHALLENGE_FIXTURES,
  SCOPE_CHALLENGE_FULL_TOKEN,
  SCOPE_CHALLENGE_LOW_TOKEN,
  ServerScopeChallengeScenario,
  parseBearerChallenge,
  scopeChallengeResourceMetadataUrl
} from './scope-challenge';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

function fixtureResult(request: JsonRpcRequest): Record<string, unknown> {
  if (request.method === 'tools/call') {
    return {
      resultType: 'complete',
      content: [
        {
          type: 'text',
          text: 'This is a simple text response for testing.'
        }
      ]
    };
  }
  if (request.method === 'resources/read') {
    const uri = request.params?.uri;
    return {
      resultType: 'complete',
      ttlMs: 0,
      cacheScope: 'private',
      contents: [
        {
          uri,
          mimeType:
            uri === 'test://static-text' ? 'text/plain' : 'application/json',
          text:
            uri === 'test://static-text'
              ? 'This is the content of the static text resource.'
              : '{"id":"123","templateTest":true,"data":"Data for ID: 123"}'
        }
      ]
    };
  }
  return {
    resultType: 'complete',
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: 'This is a simple prompt for testing.'
        }
      }
    ]
  };
}

function findFixture(request: JsonRpcRequest) {
  return SCOPE_CHALLENGE_FIXTURES.find((fixture) => {
    if (fixture.method !== request.method) return false;
    if (request.method === 'resources/read') {
      return fixture.params.uri === request.params?.uri;
    }
    return fixture.params.name === request.params?.name;
  });
}

async function listen(server: Server, endpoint = '/mcp'): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}${endpoint}`;
}

async function close(server: Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

function startBrokenFixture(port: number): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'npx',
      [
        'tsx',
        path.join(
          process.cwd(),
          'examples/servers/typescript/sep-2350-no-scope-challenge.ts'
        )
      ],
      {
        env: { ...process.env, PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32'
      }
    );
    let stderr = '';
    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`Broken fixture did not start: ${stderr}`));
    }, 30000);
    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    proc.stdout?.on('data', (data) => {
      if (data.toString().includes('running on')) {
        clearTimeout(timeout);
        resolve(proc);
      }
    });
    proc.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function stopProcess(proc: ChildProcess | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!proc || proc.killed) return resolve();
    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve();
    }, 5000);
    proc.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

describe('scope challenge header parsing', () => {
  it('parses quoted URLs and bare token values', () => {
    const parsed = parseBearerChallenge(
      'Bearer error=insufficient_scope, mode=token-._~+, resource_metadata="https://example.com/.well-known/oauth-protected-resource/mcp?tenant=a,b"'
    );

    expect(parsed?.params).toMatchObject({
      error: 'insufficient_scope',
      mode: 'token-._~+',
      resource_metadata:
        'https://example.com/.well-known/oauth-protected-resource/mcp?tenant=a,b'
    });
  });

  it('rejects URL separators in unquoted auth-param values', () => {
    const parsed = parseBearerChallenge(
      'Bearer error=insufficient_scope, scope=files:read, resource_metadata=https://example.com/.well-known/oauth-protected-resource'
    );

    expect(parsed?.params.error).toBe('insufficient_scope');
    expect(parsed?.params.scope).toBeUndefined();
    expect(parsed?.params.resource_metadata).toBeUndefined();
  });
});

describe('scope challenge metadata URL derivation', () => {
  it.each([
    [
      'endpoint path',
      'https://example.com/tenant/mcp',
      'https://example.com/.well-known/oauth-protected-resource/tenant/mcp'
    ],
    [
      'trailing path slash',
      'https://example.com/tenant/mcp/',
      'https://example.com/.well-known/oauth-protected-resource/tenant/mcp/'
    ],
    [
      'query component',
      'https://example.com/tenant/mcp?tenant=blue%2Fgreen',
      'https://example.com/.well-known/oauth-protected-resource/tenant/mcp?tenant=blue%2Fgreen'
    ],
    [
      'root resource',
      'https://example.com/',
      'https://example.com/.well-known/oauth-protected-resource'
    ]
  ])('preserves %s semantics', (_case, resource, expected) => {
    expect(scopeChallengeResourceMetadataUrl(resource)).toBe(expected);
  });
});

describe('ServerScopeChallengeScenario', () => {
  let server: Server | undefined;
  let process: ChildProcess | undefined;

  afterEach(async () => {
    await Promise.all([close(server), stopProcess(process)]);
    server = undefined;
    process = undefined;
  });

  const validMetadataCases: readonly [
    label: string,
    endpoint: string,
    metadataLocation: 'derived' | 'root'
  ][] = [
    ['path-derived endpoint', '/tenant/mcp', 'derived'],
    ['path-derived trailing slash', '/tenant/mcp/', 'derived'],
    ['path-derived query', '/tenant/mcp?tenant=blue%2Fgreen', 'derived'],
    ['root well-known alternative', '/tenant/mcp', 'root']
  ];

  it.each(validMetadataCases)(
    'passes every primitive with a %s metadata URL',
    async (_label, endpoint, metadataLocation) => {
      let serverUrl = '';
      server = createServer((req, res) => {
        let rawBody = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
          rawBody += chunk;
        });
        req.on('end', () => {
          const request = JSON.parse(rawBody) as JsonRpcRequest;
          const fixture = findFixture(request);
          if (!fixture) {
            res.statusCode = 404;
            res.end();
            return;
          }

          const authorization = req.headers.authorization;
          if (authorization === `Bearer ${SCOPE_CHALLENGE_LOW_TOKEN}`) {
            const metadata =
              metadataLocation === 'root'
                ? new URL(
                    '/.well-known/oauth-protected-resource',
                    serverUrl
                  ).toString()
                : scopeChallengeResourceMetadataUrl(serverUrl);
            res.statusCode = 403;
            res.setHeader('Content-Type', 'application/json');
            res.setHeader(
              'WWW-Authenticate',
              `Bearer resource_metadata="${metadata}", error_description="Needs \\"both\\", scopes", scope="${fixture.requiredScopes.join(' ')} mcp:conformance:extra", error="insufficient_scope"`
            );
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: request.id,
                error: { code: -32600, message: 'Insufficient scope' }
              })
            );
            return;
          }

          if (authorization !== `Bearer ${SCOPE_CHALLENGE_FULL_TOKEN}`) {
            res.statusCode = 401;
            res.end();
            return;
          }

          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: fixtureResult(request)
            })
          );
        });
      });
      serverUrl = await listen(server, endpoint);

      const checks = await new ServerScopeChallengeScenario().run(
        testContext(serverUrl, DRAFT_PROTOCOL_VERSION)
      );

      expect(checks).toHaveLength(16);
      expect(checks.every((check) => check.status === 'SUCCESS')).toBe(true);
      expect(
        checks.filter(
          (check) => check.id === 'sep-2350-server-single-challenge'
        )
      ).toHaveLength(4);
    }
  );

  it.each([
    ['missing', undefined],
    ['malformed', 'Bearer/ error="insufficient_scope"']
  ])(
    'skips completeness when the WWW-Authenticate header is %s',
    async (_case, wwwAuthenticate) => {
      server = createServer((req, res) => {
        let rawBody = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
          rawBody += chunk;
        });
        req.on('end', () => {
          const request = JSON.parse(rawBody) as JsonRpcRequest;
          const fixture = findFixture(request);
          if (!fixture) {
            res.statusCode = 404;
            res.end();
            return;
          }

          if (
            req.headers.authorization === `Bearer ${SCOPE_CHALLENGE_LOW_TOKEN}`
          ) {
            res.statusCode = 403;
            if (wwwAuthenticate) {
              res.setHeader('WWW-Authenticate', wwwAuthenticate);
            }
            res.end();
            return;
          }

          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: fixtureResult(request)
            })
          );
        });
      });

      const checks = await new ServerScopeChallengeScenario().run(
        testContext(await listen(server), DRAFT_PROTOCOL_VERSION)
      );

      const challengeChecks = checks.filter(
        (check) => check.id === 'server-scope-challenge-www-authenticate'
      );
      expect(challengeChecks).toHaveLength(4);
      expect(challengeChecks.every((check) => check.status === 'WARNING')).toBe(
        true
      );

      const completenessChecks = checks.filter(
        (check) => check.id === 'sep-2350-server-single-challenge'
      );
      expect(completenessChecks).toHaveLength(4);
      expect(
        completenessChecks.every((check) => check.status === 'SKIPPED')
      ).toBe(true);
    }
  );

  it('emits prerequisite warnings and skips completeness against a server that does not challenge', async () => {
    const port = await getFreePort();
    process = await startBrokenFixture(port);

    const checks = await new ServerScopeChallengeScenario().run(
      testContext(`http://127.0.0.1:${port}/mcp`, DRAFT_PROTOCOL_VERSION)
    );

    for (const id of [
      'server-scope-challenge-http-403',
      'server-scope-challenge-www-authenticate'
    ]) {
      const matching = checks.filter((check) => check.id === id);
      expect(matching).toHaveLength(4);
      expect(matching.every((check) => check.status === 'WARNING')).toBe(true);
    }

    const completeness = checks.filter(
      (check) => check.id === 'sep-2350-server-single-challenge'
    );
    expect(completeness).toHaveLength(4);
    expect(completeness.every((check) => check.status === 'SKIPPED')).toBe(
      true
    );

    const retries = checks.filter(
      (check) => check.id === 'server-scope-challenge-upgraded-retry'
    );
    expect(retries).toHaveLength(4);
    expect(retries.every((check) => check.status === 'SUCCESS')).toBe(true);
  }, 40000);
});
