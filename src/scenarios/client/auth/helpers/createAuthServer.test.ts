import { describe, it, expect } from 'vitest';
import type { ConformanceCheck } from '../../../../types';
import { testScenarioContext } from '../../../../mock-server/testing';
import { generateDpopKeyPair, buildDpopProof } from './dpopProof';
import {
  createAuthServer,
  type DpopTokenRequestObservation
} from './createAuthServer';
import { ServerLifecycle } from './serverLifecycle';

function newObs(): DpopTokenRequestObservation {
  return {
    recorded: false,
    validProof: false,
    asNonceChallengeIssued: false,
    asNonceHonored: false,
    dpopJktMatched: false
  };
}

describe('createAuthServer — RFC 9449 §10 dpop_jkt binding', () => {
  it('rejects authorization_code with 400 invalid_grant when dpop_jkt does not match the proof key', async () => {
    const checks: ConformanceCheck[] = [];
    const lifecycle = new ServerLifecycle();
    const obs = newObs();
    const app = createAuthServer(
      testScenarioContext(),
      checks,
      lifecycle.getUrl,
      {
        dpopSigningAlgValuesSupported: ['ES256'],
        dpopTokenRequestObs: obs,
        loggingEnabled: false
      }
    );
    await lifecycle.start(app);
    try {
      const proofKp = await generateDpopKeyPair();
      const otherKp = await generateDpopKeyPair();
      const authorizeUrl = `${lifecycle.getUrl()}/authorize?${new URLSearchParams(
        {
          response_type: 'code',
          client_id: 'test',
          redirect_uri: 'http://127.0.0.1:9876/callback',
          code_challenge: 'x',
          code_challenge_method: 'S256',
          dpop_jkt: otherKp.thumbprint
        }
      ).toString()}`;
      await fetch(authorizeUrl, { redirect: 'manual' });

      const tokenEndpoint = `${lifecycle.getUrl()}/token`;
      const proof = await buildDpopProof({
        keyPair: proofKp,
        htm: 'POST',
        htu: tokenEndpoint
      });
      const tokenRes = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          dpop: proof
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'test-auth-code',
          redirect_uri: 'http://127.0.0.1:9876/callback',
          code_verifier: 'x',
          client_id: 'test'
        })
      });

      expect(tokenRes.status).toBe(400);
      const body = (await tokenRes.json()) as {
        error?: string;
        error_description?: string;
      };
      expect(body.error).toBe('invalid_grant');
      expect(body.error_description).toBe(
        'dpop_jkt does not match the DPoP proof key'
      );
      expect(obs.dpopJktSent).toBe(otherKp.thumbprint);
      expect(obs.dpopJktMatched).toBe(false);
      expect(obs.validProof).toBe(true);
    } finally {
      await lifecycle.stop();
    }
  });
});
