import { describe, it, expect } from 'vitest';
import type { ConformanceCheck } from '../../../../types';
import { testScenarioContext } from '../../../../mock-server/testing';
import {
  generateDpopKeyPair,
  buildDpopProof,
  type DpopKeyPair
} from './dpopProof';
import {
  createAuthServer,
  type DpopTokenRequestObservation
} from './createAuthServer';
import { ServerLifecycle } from './serverLifecycle';

const REDIRECT = 'http://127.0.0.1:9876/callback';

function newObs(): DpopTokenRequestObservation {
  return {
    recorded: false,
    validProof: false,
    asNonceChallengeIssued: false,
    asNonceHonored: false,
    dpopJktMatched: false
  };
}

async function requestAuthorizationCode(
  base: string,
  keyPair: DpopKeyPair
): Promise<string> {
  const authorizeUrl = `${base}/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: 'test',
    redirect_uri: REDIRECT,
    code_challenge: 'x',
    code_challenge_method: 'S256',
    dpop_jkt: keyPair.thumbprint
  }).toString()}`;
  const response = await fetch(authorizeUrl, { redirect: 'manual' });
  return new URL(response.headers.get('location')!).searchParams.get('code')!;
}

async function exchangeAuthorizationCode(
  base: string,
  code: string,
  keyPair: DpopKeyPair
): Promise<Response> {
  const tokenEndpoint = `${base}/token`;
  const proof = await buildDpopProof({
    keyPair,
    htm: 'POST',
    htu: tokenEndpoint
  });
  return fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      dpop: proof
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: 'x',
      client_id: 'test'
    })
  });
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
      const code = await requestAuthorizationCode(lifecycle.getUrl(), otherKp);
      const tokenRes = await exchangeAuthorizationCode(
        lifecycle.getUrl(),
        code,
        proofKp
      );

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

  it('binds dpop_jkt to each authorization code across overlapping flows', async () => {
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
      const first = await generateDpopKeyPair();
      const second = await generateDpopKeyPair();
      const firstCode = await requestAuthorizationCode(
        lifecycle.getUrl(),
        first
      );
      const secondCode = await requestAuthorizationCode(
        lifecycle.getUrl(),
        second
      );

      for (const [code, keyPair] of [
        [firstCode, first],
        [secondCode, second]
      ] as const) {
        const response = await exchangeAuthorizationCode(
          lifecycle.getUrl(),
          code,
          keyPair
        );
        expect(response.status).toBe(200);
        expect(obs.dpopJktSent).toBe(keyPair.thumbprint);
        expect(obs.dpopJktMatched).toBe(true);
      }
    } finally {
      await lifecycle.stop();
    }
  });
});
