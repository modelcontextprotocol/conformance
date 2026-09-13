import { describe, it, expect } from 'vitest';
import { finalizeChecks } from '../../../hosted/session';
import { getScenario } from '../../index';
import { testScenarioContext } from '../../../mock-server/testing';
import { tokenWithScopes } from './helpers/mockTokenVerifier';
import {
  DRAFT_PROTOCOL_VERSION,
  LATEST_SPEC_VERSION,
  type ConformanceCheck,
  type SpecVersion
} from '../../../types';

/**
 * The request sequence the C# SDK sent to auth/scope-step-up: its
 * server/discover probe drew a 401 and it began authorizing, the probe
 * window ran out mid-flow (that authorization never reached /token), it
 * authorized again for tools/list, and then once more after the
 * insufficient_scope challenge on tools/call.
 */
describe('auth/scope-step-up with an abandoned first authorization', () => {
  it.each<SpecVersion>([LATEST_SPEC_VERSION, DRAFT_PROTOCOL_VERSION])(
    'judges the authorization that follows the challenge at %s',
    async (specVersion) => {
      const scenario = getScenario('auth/scope-step-up')!;
      const { serverUrl } = await scenario.start(
        testScenarioContext(specVersion)
      );
      try {
        const prm = await fetch(
          `${new URL(serverUrl).origin}/.well-known/oauth-protected-resource/mcp`
        ).then((r) => r.json());
        const authorize = (scope: string) =>
          fetch(
            `${prm.authorization_servers[0]}/authorize?` +
              new URLSearchParams({
                response_type: 'code',
                client_id: 'test-client-id',
                redirect_uri: 'http://localhost:0/callback',
                code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
                code_challenge_method: 'S256',
                scope
              }),
            { redirect: 'manual' }
          );

        expect((await authorize('mcp:basic')).status).toBe(302); // abandoned
        expect((await authorize('mcp:basic')).status).toBe(302);
        const call = await fetch(serverUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${tokenWithScopes('test-token-step-up', ['mcp:basic'])}`
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 4,
            method: 'tools/call',
            params: { name: 'test-tool', arguments: {} }
          })
        });
        expect(call.status).toBe(403);
        expect((await authorize('mcp:basic mcp:write')).status).toBe(302);

        const checks = scenario.getChecks();
        expect(
          checks.find((c) => c.id === 'scope-step-up-initial')
        ).toMatchObject({ status: 'SUCCESS' });
        expect(
          checks.find((c) => c.id === 'scope-step-up-escalation')
        ).toMatchObject({
          status: 'SUCCESS',
          details: { requestedScope: 'mcp:basic mcp:write' }
        });
        if (specVersion === DRAFT_PROTOCOL_VERSION) {
          expect(
            checks.find((c) => c.id === 'sep-2350-scope-union-on-reauth')
          ).toMatchObject({ status: 'SUCCESS' });
        }
      } finally {
        await scenario.stop();
      }
    }
  );

  it('falls back to the second authorization when no challenge was logged', () => {
    const authorization = (scope: string): ConformanceCheck => ({
      id: 'authorization-request',
      name: 'AuthorizationRequest',
      description: 'Client made authorization request',
      status: 'SUCCESS',
      timestamp: new Date().toISOString(),
      details: { query: { scope } }
    });
    const judged = finalizeChecks(
      'auth/scope-step-up',
      [authorization('mcp:basic'), authorization('mcp:basic mcp:write')],
      LATEST_SPEC_VERSION
    );
    expect(
      judged.find((c) => c.id === 'scope-step-up-escalation')
    ).toMatchObject({
      status: 'SUCCESS',
      details: { requestedScope: 'mcp:basic mcp:write' }
    });
  });
});

/**
 * The hosted server re-judges a merged log in a fresh instance that never
 * ran authHandlers(); the revision the cell ran at is all it is told.
 */
describe('auth/scope-step-up judged from a log alone', () => {
  const union = 'sep-2350-scope-union-on-reauth';

  it('keeps the 2026-07-28 union check when the client never authorized', () => {
    const judged = finalizeChecks('auth/scope-step-up', [], '2026-07-28');
    expect(judged.find((c) => c.id === union)).toMatchObject({
      status: 'FAILURE'
    });
  });

  it('has no union check at 2025-11-25', () => {
    const judged = finalizeChecks('auth/scope-step-up', [], '2025-11-25');
    expect(judged.some((c) => c.id === union)).toBe(false);
    expect(
      judged.find((c) => c.id === 'scope-step-up-escalation')
    ).toMatchObject({ status: 'FAILURE' });
  });
});
