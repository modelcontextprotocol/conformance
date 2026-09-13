import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { OfflineAccessScopeScenario } from './offline-access';
import { testScenarioContext } from '../../../mock-server/testing';
import { DRAFT_PROTOCOL_VERSION } from '../../../types';

/**
 * A CIMD client: the client_id is the URL of its metadata document, which
 * here lists no refresh_token grant.
 */
describe('auth/offline-access-scope with a CIMD client', () => {
  let cimd: http.Server;
  let cimdUrl: string;
  let fetches = 0;

  beforeAll(async () => {
    cimd = http.createServer((_req, res) => {
      fetches++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          client_id: cimdUrl,
          grant_types: ['authorization_code']
        })
      );
    });
    await new Promise<void>((r) => cimd.listen(0, r));
    cimdUrl = `http://localhost:${(cimd.address() as { port: number }).port}/client.json`;
  });

  afterAll(async () => {
    cimd.closeAllConnections?.();
    await new Promise<void>((r) => cimd.close(() => r()));
  });

  const authorize = (asUrl: string) =>
    fetch(
      `${asUrl}/authorize?` +
        new URLSearchParams({
          response_type: 'code',
          client_id: cimdUrl,
          redirect_uri: 'http://localhost:0/cb',
          code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
          code_challenge_method: 'S256',
          scope: 'mcp:basic'
        }),
      { redirect: 'manual' }
    );

  it('reports the metadata document grant_types in the results the runner reads', async () => {
    fetches = 0;
    const scenario = new OfflineAccessScopeScenario();
    const { serverUrl } = await scenario.start(
      testScenarioContext(DRAFT_PROTOCOL_VERSION)
    );
    try {
      const prm = await fetch(
        `${new URL(serverUrl).origin}/.well-known/oauth-protected-resource/mcp`
      ).then((r) => r.json());
      const res = await authorize(prm.authorization_servers[0]);
      expect(res.status).toBe(302);

      // The runner takes the checks before it stops the scenario.
      const checks = scenario.getChecks();
      expect(
        checks.filter((c) => c.id === 'sep-2207-client-metadata-grant-types')
      ).toEqual([
        expect.objectContaining({
          status: 'WARNING',
          details: expect.objectContaining({
            registrationMethod: 'CIMD',
            cimdUrl,
            grantTypes: 'authorization_code'
          })
        })
      ]);
      expect(fetches).toBe(1);
    } finally {
      await scenario.stop();
    }
  });

  it('never fetches a client-supplied URL when hosted', async () => {
    fetches = 0;
    const scenario = new OfflineAccessScopeScenario();
    let asUrl = '';
    // The hosted server builds the handlers itself; start() never runs.
    const handlers = scenario.authHandlers({
      ...testScenarioContext(DRAFT_PROTOCOL_VERSION),
      getRsBaseUrl: () => 'http://rs.invalid',
      getAuxBaseUrl: () => asUrl
    });
    const as = http.createServer(handlers.aux.as!);
    await new Promise<void>((r) => as.listen(0, r));
    asUrl = `http://localhost:${(as.address() as { port: number }).port}`;
    try {
      const res = await authorize(asUrl);
      expect(res.status).toBe(302);
      expect(fetches).toBe(0);
      expect(
        scenario
          .getChecks()
          .find((c) => c.id === 'sep-2207-client-metadata-grant-types')
      ).toMatchObject({
        status: 'INFO',
        details: { registrationMethod: 'unknown' }
      });
    } finally {
      as.closeAllConnections?.();
      await new Promise<void>((r) => as.close(() => r()));
    }
  });
});
