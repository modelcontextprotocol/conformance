import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { createServer as createNetServer } from 'net';
import path from 'path';
import * as jose from 'jose';
import { testContext } from '../../../connection/testing';
import {
  DRAFT_PROTOCOL_VERSION,
  LATEST_SPEC_VERSION,
  type ConformanceCheck
} from '../../../types';
import {
  getClientScenario,
  listActiveClientScenarios,
  listClientScenariosForSpec,
  listPendingClientScenarios
} from '../../index';
import { MockTokenAuthServer } from './mock-auth-server';
import { TokenAudienceValidationScenario } from './token-audience-validation';

const EXAMPLE_SERVER_PATH = path.join(
  process.cwd(),
  'examples/servers/typescript/auth-token-audience-server.ts'
);

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('Failed to allocate free port'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

function startExampleServer(options: {
  port: number;
  authServerUrl: string;
  authMode?: 'jwks' | 'introspect';
  breakMode?: string;
}): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(options.port),
      AUTH_SERVER_URL: options.authServerUrl,
      RESOURCE_URL: `http://localhost:${options.port}/mcp`,
      AUTH_MODE: options.authMode ?? 'jwks'
    };
    if (options.breakMode) {
      env.TOKEN_AUDIENCE_BREAK = options.breakMode;
    } else {
      delete env.TOKEN_AUDIENCE_BREAK;
    }

    const proc = spawn('npx', ['tsx', EXAMPLE_SERVER_PATH], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows
    });

    let stderr = '';
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(
        new Error(`Example server did not start within 25s. STDERR: ${stderr}`)
      );
    }, 25_000);

    let settled = false;
    proc.stdout?.on('data', (chunk) => {
      if (!settled && chunk.toString().includes('running on')) {
        settled = true;
        clearTimeout(timer);
        resolve(proc);
      }
    });
    proc.once('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    proc.once('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(
          new Error(
            `Example server exited prematurely (code=${code}). STDERR: ${stderr}`
          )
        );
      }
    });
  });
}

function stopProcess(proc: ChildProcess | null): Promise<void> {
  return new Promise((resolve) => {
    if (!proc || proc.killed || proc.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
      resolve();
    }, 5_000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

function checkById(checks: ConformanceCheck[], id: string): ConformanceCheck {
  const found = checks.find((c) => c.id === id);
  expect(found, `Expected check "${id}" to be emitted`).toBeDefined();
  return found!;
}

describe('MockTokenAuthServer', () => {
  let mockAs: MockTokenAuthServer | null = null;

  afterEach(async () => {
    await mockAs?.stop();
    mockAs = null;
  });

  it('serves AS metadata, JWKS, and verifies minted tokens', async () => {
    mockAs = new MockTokenAuthServer({ port: 0, host: '127.0.0.1' });
    await mockAs.start();

    const metaRes = await fetch(
      `${mockAs.issuerUrl}/.well-known/oauth-authorization-server`
    );
    expect(metaRes.status).toBe(200);
    const meta = (await metaRes.json()) as {
      issuer: string;
      jwks_uri: string;
      introspection_endpoint: string;
    };
    expect(meta.issuer).toBe(mockAs.issuerUrl);
    expect(meta.jwks_uri).toBe(`${mockAs.issuerUrl}/jwks`);
    expect(meta.introspection_endpoint).toBe(`${mockAs.issuerUrl}/introspect`);

    const jwks = jose.createRemoteJWKSet(new URL(meta.jwks_uri));
    const token = await mockAs.mintToken({
      audience: 'http://localhost:3014/mcp'
    });
    const { payload } = await jose.jwtVerify(token, jwks, {
      issuer: meta.issuer,
      audience: 'http://localhost:3014/mcp'
    });
    expect(payload.aud).toBe('http://localhost:3014/mcp');

    const noAudToken = await mockAs.mintToken({ omitAud: true });
    expect(jose.decodeJwt(noAudToken).aud).toBeUndefined();

    const expiredToken = await mockAs.mintToken({
      audience: 'http://localhost:3014/mcp',
      expired: true
    });
    await expect(
      jose.jwtVerify(expiredToken, jwks, { issuer: meta.issuer })
    ).rejects.toThrow();

    expect(mockAs.getCounters()).toEqual({
      metadataRequests: 1,
      jwksRequests: 1,
      introspectionRequests: 0
    });
  });

  it('serves RFC 7662 token introspection with aud claim and active status', async () => {
    mockAs = new MockTokenAuthServer({ port: 0, host: '127.0.0.1' });
    await mockAs.start();

    const validToken = await mockAs.mintToken({
      audience: 'http://localhost:3014/mcp'
    });
    const validRes = await fetch(`${mockAs.issuerUrl}/introspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: validToken }).toString()
    });
    expect(validRes.status).toBe(200);
    const validBody = (await validRes.json()) as {
      active: boolean;
      aud?: string;
    };
    expect(validBody.active).toBe(true);
    expect(validBody.aud).toBe('http://localhost:3014/mcp');

    const missingAudToken = await mockAs.mintToken({ omitAud: true });
    const missingAudRes = await fetch(`${mockAs.issuerUrl}/introspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: missingAudToken }).toString()
    });
    const missingAudBody = (await missingAudRes.json()) as {
      active: boolean;
      aud?: string;
    };
    expect(missingAudBody.active).toBe(true);
    expect(missingAudBody.aud).toBeUndefined();

    const expiredToken = await mockAs.mintToken({
      audience: 'http://localhost:3014/mcp',
      expired: true
    });
    const expiredRes = await fetch(`${mockAs.issuerUrl}/introspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: expiredToken }).toString()
    });
    const expiredBody = (await expiredRes.json()) as { active: boolean };
    expect(expiredBody.active).toBe(false);
  });
});

describe('TokenAudienceValidationScenario registry', () => {
  it('is registered in pending suite and scoped to 2025-06-18+', () => {
    const scenario = getClientScenario('auth/token-audience-validation');
    expect(scenario).toBeDefined();
    expect(scenario?.source).toEqual({ introducedIn: '2025-06-18' });

    expect(listPendingClientScenarios()).toContain(
      'auth/token-audience-validation'
    );
    expect(listActiveClientScenarios()).not.toContain(
      'auth/token-audience-validation'
    );

    expect(listClientScenariosForSpec('2025-03-26')).not.toContain(
      'auth/token-audience-validation'
    );
    expect(listClientScenariosForSpec('2025-06-18')).toContain(
      'auth/token-audience-validation'
    );
    expect(listClientScenariosForSpec('2025-11-25')).toContain(
      'auth/token-audience-validation'
    );
    expect(listClientScenariosForSpec(DRAFT_PROTOCOL_VERSION)).toContain(
      'auth/token-audience-validation'
    );
  });
});

describe('TokenAudienceValidationScenario end-to-end', () => {
  let mockAs: MockTokenAuthServer | null = null;
  let serverProc: ChildProcess | null = null;

  afterEach(async () => {
    await stopProcess(serverProc);
    serverProc = null;
    await mockAs?.stop();
    mockAs = null;
  });

  async function runAgainstExampleServer(
    options: {
      authMode?: 'jwks' | 'introspect';
      breakMode?: string;
      specVersion?: '2025-06-18' | '2025-11-25' | typeof DRAFT_PROTOCOL_VERSION;
    } = {}
  ): Promise<ConformanceCheck[]> {
    mockAs = new MockTokenAuthServer({ port: 0, host: '127.0.0.1' });
    await mockAs.start();

    const serverPort = await getFreePort();
    serverProc = await startExampleServer({
      port: serverPort,
      authServerUrl: mockAs.issuerUrl,
      authMode: options.authMode,
      breakMode: options.breakMode
    });

    const scenario = new TokenAudienceValidationScenario({
      mockAuthServer: mockAs
    });
    return scenario.run(
      testContext(
        `http://localhost:${serverPort}/mcp`,
        options.specVersion ?? LATEST_SPEC_VERSION
      )
    );
  }

  it('passes all 4 checks against a compliant JWKS server (2025-11-25)', async () => {
    const checks = await runAgainstExampleServer({
      authMode: 'jwks',
      specVersion: '2025-11-25'
    });

    expect(checks).toHaveLength(4);
    expect(checkById(checks, 'server-token-valid-accepted').status).toBe(
      'SUCCESS'
    );
    expect(checkById(checks, 'server-token-audience-validation').status).toBe(
      'SUCCESS'
    );
    expect(
      checkById(checks, 'server-token-missing-audience-rejected').status
    ).toBe('SUCCESS');
    expect(checkById(checks, 'server-token-expired-rejected').status).toBe(
      'SUCCESS'
    );
    expect(mockAs!.getCounters().jwksRequests).toBeGreaterThan(0);
  }, 30_000);

  it('passes all 4 checks on 2025-06-18 and 2026-07-28 (stateless) wire versions', async () => {
    mockAs = new MockTokenAuthServer({ port: 0, host: '127.0.0.1' });
    await mockAs.start();
    const serverPort = await getFreePort();
    serverProc = await startExampleServer({
      port: serverPort,
      authServerUrl: mockAs.issuerUrl
    });

    const scenario = new TokenAudienceValidationScenario({
      mockAuthServer: mockAs
    });
    const url = `http://localhost:${serverPort}/mcp`;

    for (const version of ['2025-06-18', DRAFT_PROTOCOL_VERSION] as const) {
      const checks = await scenario.run(testContext(url, version));
      expect(checks.map((c) => c.status)).toEqual([
        'SUCCESS',
        'SUCCESS',
        'SUCCESS',
        'SUCCESS'
      ]);
    }
  }, 30_000);

  it('passes all 4 checks against a compliant RFC 7662 introspection server', async () => {
    const checks = await runAgainstExampleServer({
      authMode: 'introspect',
      specVersion: '2025-11-25'
    });

    expect(checks.map((c) => c.status)).toEqual([
      'SUCCESS',
      'SUCCESS',
      'SUCCESS',
      'SUCCESS'
    ]);
    expect(mockAs!.getCounters().introspectionRequests).toBeGreaterThan(0);
  }, 30_000);

  it('auto-binds its own mock AS to a loopback port advertised in server PRM', async () => {
    const freeAsPort = await getFreePort();
    const serverPort = await getFreePort();

    // Start the server BEFORE the mock AS exists — it advertises
    // http://localhost:<freeAsPort> in /.well-known/oauth-protected-resource.
    serverProc = await startExampleServer({
      port: serverPort,
      authServerUrl: `http://localhost:${freeAsPort}`
    });

    const scenario = new TokenAudienceValidationScenario();
    const checks = await scenario.run(
      testContext(`http://localhost:${serverPort}/mcp`, '2025-11-25')
    );

    expect(checks.map((c) => c.status)).toEqual([
      'SUCCESS',
      'SUCCESS',
      'SUCCESS',
      'SUCCESS'
    ]);
  }, 30_000);

  it('fails wrong-aud and missing-aud checks when server skips audience validation', async () => {
    const checks = await runAgainstExampleServer({
      breakMode: 'skip-audience'
    });

    expect(checkById(checks, 'server-token-valid-accepted').status).toBe(
      'SUCCESS'
    );
    expect(checkById(checks, 'server-token-audience-validation').status).toBe(
      'FAILURE'
    );
    expect(
      checkById(checks, 'server-token-missing-audience-rejected').status
    ).toBe('FAILURE');
    expect(checkById(checks, 'server-token-expired-rejected').status).toBe(
      'SUCCESS'
    );
  }, 30_000);

  it('fails only missing-aud check when server allows tokens without aud claim', async () => {
    const checks = await runAgainstExampleServer({
      breakMode: 'allow-missing-audience'
    });

    expect(checkById(checks, 'server-token-valid-accepted').status).toBe(
      'SUCCESS'
    );
    expect(checkById(checks, 'server-token-audience-validation').status).toBe(
      'SUCCESS'
    );
    expect(
      checkById(checks, 'server-token-missing-audience-rejected').status
    ).toBe('FAILURE');
    expect(checkById(checks, 'server-token-expired-rejected').status).toBe(
      'SUCCESS'
    );
  }, 30_000);

  it('fails expired-token check when server skips expiration validation', async () => {
    const checks = await runAgainstExampleServer({
      breakMode: 'skip-expiration'
    });

    expect(checkById(checks, 'server-token-valid-accepted').status).toBe(
      'SUCCESS'
    );
    expect(checkById(checks, 'server-token-audience-validation').status).toBe(
      'SUCCESS'
    );
    expect(
      checkById(checks, 'server-token-missing-audience-rejected').status
    ).toBe('SUCCESS');
    expect(checkById(checks, 'server-token-expired-rejected').status).toBe(
      'FAILURE'
    );
  }, 30_000);

  it('fails all checks without false positives against an unauthenticated server', async () => {
    const checks = await runAgainstExampleServer({ breakMode: 'no-auth' });

    const valid = checkById(checks, 'server-token-valid-accepted');
    expect(valid.status).toBe('FAILURE');
    expect(valid.details?.untestable).toBe(true);
    expect(checkById(checks, 'server-token-audience-validation').status).toBe(
      'FAILURE'
    );
    expect(
      checkById(checks, 'server-token-missing-audience-rejected').status
    ).toBe('FAILURE');
    expect(checkById(checks, 'server-token-expired-rejected').status).toBe(
      'FAILURE'
    );
  }, 30_000);

  it('marks negative checks untestable (not SUCCESS) against a reject-all server', async () => {
    const checks = await runAgainstExampleServer({ breakMode: 'reject-all' });

    expect(checkById(checks, 'server-token-valid-accepted').status).toBe(
      'FAILURE'
    );
    for (const id of [
      'server-token-audience-validation',
      'server-token-missing-audience-rejected',
      'server-token-expired-rejected'
    ]) {
      const check = checkById(checks, id);
      expect(check.status).toBe('FAILURE');
      expect(check.details?.untestable).toBe(true);
    }
  }, 30_000);

  it('fails audience validation when server returns HTTP 403 instead of 401', async () => {
    const checks = await runAgainstExampleServer({
      breakMode: 'wrong-status-403'
    });

    expect(checkById(checks, 'server-token-valid-accepted').status).toBe(
      'SUCCESS'
    );
    const audCheck = checkById(checks, 'server-token-audience-validation');
    expect(audCheck.status).toBe('FAILURE');
    expect(audCheck.errorMessage).toContain('Expected HTTP 401');
    expect(audCheck.errorMessage).toContain('403');
    expect(
      checkById(checks, 'server-token-missing-audience-rejected').status
    ).toBe('SUCCESS');
    expect(checkById(checks, 'server-token-expired-rejected').status).toBe(
      'SUCCESS'
    );
  }, 30_000);
});
