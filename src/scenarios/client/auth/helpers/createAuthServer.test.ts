import { describe, it, expect } from 'vitest';
import * as jose from 'jose';
import type { ConformanceCheck } from '../../../../types';
import { testScenarioContext } from '../../../../mock-server/testing';
import {
  generateDpopKeyPair,
  buildDpopProof,
  type DpopKeyPair
} from './dpopProof';
import {
  createAuthServer,
  type AuthServerOptions,
  type DpopRefreshObservation,
  type DpopTokenRequestObservation
} from './createAuthServer';
import { ServerLifecycle } from './serverLifecycle';

function newObs(): DpopTokenRequestObservation {
  return {
    recorded: false,
    validProof: false,
    asNonceChallengeIssued: false,
    asNonceHonored: false
  };
}

const REDIRECT = 'http://127.0.0.1:9876/callback';
const AS_NONCE = 'conformance-as-dpop-nonce';

function newRefreshObs(): DpopRefreshObservation {
  return {
    seen: false,
    proofPresent: false,
    proofValid: false,
    jktMatched: false
  };
}

async function startServer(options: AuthServerOptions = {}): Promise<{
  lifecycle: ServerLifecycle;
  tokenObs: DpopTokenRequestObservation;
  refreshObs: DpopRefreshObservation;
  base: string;
}> {
  const checks: ConformanceCheck[] = [];
  const lifecycle = new ServerLifecycle();
  const tokenObs = newObs();
  const refreshObs = newRefreshObs();
  const app = createAuthServer(
    testScenarioContext(),
    checks,
    lifecycle.getUrl,
    {
      loggingEnabled: false,
      dpopSigningAlgValuesSupported: ['ES256'],
      dpopTokenRequestObs: tokenObs,
      dpopRefreshObs: refreshObs,
      ...options
    }
  );
  const base = await lifecycle.start(app);
  return { lifecycle, tokenObs, refreshObs, base };
}

async function postToken(
  base: string,
  body: Record<string, string>,
  proof?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded'
  };
  if (proof) headers.dpop = proof;
  return fetch(`${base}/token`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(body)
  });
}

async function authorizationCode(
  base: string,
  keyPair: DpopKeyPair | undefined,
  nonce?: string
): Promise<{ refreshToken: string; accessToken: string; tokenType: string }> {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: 'test',
    redirect_uri: REDIRECT,
    code_challenge: 'x',
    code_challenge_method: 'S256'
  });
  await fetch(`${base}/authorize?${params}`, { redirect: 'manual' });
  const proof = keyPair
    ? await buildDpopProof({
        keyPair,
        htm: 'POST',
        htu: `${base}/token`,
        ...(nonce ? { nonce } : {})
      })
    : undefined;
  const res = await postToken(
    base,
    {
      grant_type: 'authorization_code',
      code: 'test-auth-code',
      redirect_uri: REDIRECT,
      code_verifier: 'x',
      client_id: 'test'
    },
    proof
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    token_type: string;
  };
  return {
    refreshToken: body.refresh_token,
    accessToken: body.access_token,
    tokenType: body.token_type
  };
}

async function refresh(
  base: string,
  refreshToken: string,
  keyPair?: DpopKeyPair,
  nonce?: string
): Promise<Response> {
  const proof = keyPair
    ? await buildDpopProof({
        keyPair,
        htm: 'POST',
        htu: `${base}/token`,
        ...(nonce ? { nonce } : {})
      })
    : undefined;
  return postToken(
    base,
    {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: 'test'
    },
    proof
  );
}

describe('createAuthServer — refresh tokens (RFC 9449 §5)', () => {
  it('rotates a bound refresh token when the same DPoP key is presented', async () => {
    const server = await startServer();
    try {
      const kp = await generateDpopKeyPair();
      const issued = await authorizationCode(server.base, kp);
      const res = await refresh(server.base, issued.refreshToken, kp);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        access_token: string;
        refresh_token: string;
        token_type: string;
        expires_in: number;
      };
      expect(body.token_type).toBe('DPoP');
      expect(body.refresh_token).not.toBe(issued.refreshToken);
      expect(body.expires_in).toBe(3600);
      expect(
        (jose.decodeJwt(body.access_token).cnf as { jkt: string }).jkt
      ).toBe(kp.thumbprint);
      expect(server.refreshObs).toMatchObject({
        seen: true,
        proofPresent: true,
        proofValid: true,
        jktMatched: true
      });

      const reused = await refresh(server.base, issued.refreshToken, kp);
      expect(reused.status).toBe(400);
      expect(((await reused.json()) as { error: string }).error).toBe(
        'invalid_grant'
      );
    } finally {
      await server.lifecycle.stop();
    }
  });

  it('rejects a bound refresh that omits the DPoP proof', async () => {
    const server = await startServer();
    try {
      const kp = await generateDpopKeyPair();
      const issued = await authorizationCode(server.base, kp);
      const res = await refresh(server.base, issued.refreshToken);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        'invalid_grant'
      );
      expect(server.refreshObs.proofPresent).toBe(false);
      expect(server.refreshObs.jktMatched).toBe(false);
    } finally {
      await server.lifecycle.stop();
    }
  });

  it('rejects a bound refresh signed by a different key', async () => {
    const server = await startServer();
    try {
      const kp = await generateDpopKeyPair();
      const other = await generateDpopKeyPair();
      const issued = await authorizationCode(server.base, kp);
      const res = await refresh(server.base, issued.refreshToken, other);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        'invalid_grant'
      );
      expect(server.refreshObs).toMatchObject({
        proofPresent: true,
        proofValid: true,
        jktMatched: false
      });
    } finally {
      await server.lifecycle.stop();
    }
  });

  it('rejects a malformed DPoP proof with invalid_dpop_proof', async () => {
    const server = await startServer();
    try {
      const kp = await generateDpopKeyPair();
      const issued = await authorizationCode(server.base, kp);
      const res = await postToken(
        server.base,
        {
          grant_type: 'refresh_token',
          refresh_token: issued.refreshToken,
          client_id: 'test'
        },
        'not-a-jwt'
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        'invalid_dpop_proof'
      );
    } finally {
      await server.lifecycle.stop();
    }
  });

  it('rotates an unbound refresh token as a Bearer token', async () => {
    const server = await startServer();
    try {
      const issued = await authorizationCode(server.base, undefined);
      expect(issued.tokenType).toBe('Bearer');
      const res = await refresh(server.base, issued.refreshToken);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        token_type: string;
        refresh_token: string;
      };
      expect(body.token_type).toBe('Bearer');
      expect(body.refresh_token).not.toBe(issued.refreshToken);
    } finally {
      await server.lifecycle.stop();
    }
  });

  it('unbound-refresh accepts a missing proof and a different key', async () => {
    const server = await startServer({ dpopMisbehavior: 'unbound-refresh' });
    try {
      const kp = await generateDpopKeyPair();
      const other = await generateDpopKeyPair();
      const issued = await authorizationCode(server.base, kp);
      const noProof = await refresh(server.base, issued.refreshToken);
      expect(noProof.status).toBe(200);
      expect(
        ((await noProof.json()) as { token_type: string }).token_type
      ).toBe('Bearer');

      const again = await authorizationCode(server.base, kp);
      const rebound = await refresh(server.base, again.refreshToken, other);
      expect(rebound.status).toBe(200);
      const body = (await rebound.json()) as {
        access_token: string;
        token_type: string;
      };
      expect(body.token_type).toBe('DPoP');
      expect(
        (jose.decodeJwt(body.access_token).cnf as { jkt: string }).jkt
      ).toBe(other.thumbprint);
    } finally {
      await server.lifecycle.stop();
    }
  });

  it('rebind-on-refresh binds the new access token to the presented key', async () => {
    const server = await startServer({ dpopMisbehavior: 'rebind-on-refresh' });
    try {
      const kp = await generateDpopKeyPair();
      const other = await generateDpopKeyPair();
      const issued = await authorizationCode(server.base, kp);
      const res = await refresh(server.base, issued.refreshToken, other);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { access_token: string };
      expect(
        (jose.decodeJwt(body.access_token).cnf as { jkt: string }).jkt
      ).toBe(other.thumbprint);
      expect(server.refreshObs.jktMatched).toBe(false);
    } finally {
      await server.lifecycle.stop();
    }
  });

  it('challenges a refresh for a nonce without recording the §8 observation', async () => {
    const server = await startServer({ dpopRequireNonce: true });
    try {
      const kp = await generateDpopKeyPair();
      const issued = await authorizationCode(server.base, kp, AS_NONCE);
      expect(server.tokenObs.asNonceChallengeIssued).toBe(false);
      expect(server.tokenObs.asNonceHonored).toBe(true);

      const challenged = await refresh(server.base, issued.refreshToken, kp);
      expect(challenged.status).toBe(400);
      expect(((await challenged.json()) as { error: string }).error).toBe(
        'use_dpop_nonce'
      );
      expect(server.tokenObs.asNonceChallengeIssued).toBe(false);

      const retried = await refresh(
        server.base,
        issued.refreshToken,
        kp,
        AS_NONCE
      );
      expect(retried.status).toBe(200);
      expect(server.tokenObs.asNonceChallengeIssued).toBe(false);
    } finally {
      await server.lifecycle.stop();
    }
  });
});
