#!/usr/bin/env node

/**
 * MCP server that correctly enforces DPoP (RFC 9449) — POSITIVE test fixture.
 *
 * Used only to validate the dpop server conformance scenario: it should PASS
 * every sep-1932-server-* check. It is NOT what an SDK author runs against.
 *
 * The DPoP validation here is written from scratch against RFC 9449 §4.3 (using
 * jose only for primitive verify/thumbprint) so it is an INDEPENDENT code path
 * from the conformance suite's proof-builder/minter — a shared bug surfaces as a
 * test failure rather than mutual agreement on a wrong answer.
 *
 * Trust config is supplied via env (the scenario mints tokens with the matching
 * issuer private key):
 *   PORT, DPOP_ISSUER_JWK (public JWK JSON), DPOP_ISSUER, DPOP_AUDIENCE,
 *   DPOP_IAT_SKEW_SECONDS (default 300), DPOP_REQUIRE_NONCE ('1'), DPOP_NONCE.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import * as jose from 'jose';
import { createHash } from 'node:crypto';

const ISSUER_JWK = JSON.parse(process.env.DPOP_ISSUER_JWK || '{}');
const ISSUER = process.env.DPOP_ISSUER || 'https://auth.example.com';
const AUDIENCE = process.env.DPOP_AUDIENCE || '';
// Parse an integer env var, falling back to the default on absent OR malformed
// input — a bare parseInt would yield NaN, which silently disables the iat
// window (`Math.abs(...) > NaN` is false) or the clock skew (NaN is falsy).
const intEnv = (name: string, def: number): number => {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isNaN(n) ? def : n;
};
const IAT_SKEW = intEnv('DPOP_IAT_SKEW_SECONDS', 300);
const REQUIRE_NONCE = process.env.DPOP_REQUIRE_NONCE === '1';
const NONCE = process.env.DPOP_NONCE || 'conformance-test-nonce';
// Buggy-nonce mode (negative-test fixture only): challenge when no nonce is
// present, but accept ANY nonce value without validating it. Used to prove the
// scenario's nonce check can report WARNING.
const NONCE_ACCEPT_ANY = process.env.DPOP_NONCE_ACCEPT_ANY === '1';
// Nonce-first mode (negative-test fixture only): gate on the nonce BEFORE any
// structural proof validation, so every nonce-less request — even a malformed
// proof — is answered with use_dpop_nonce. Models a server that checks the
// nonce first; used to prove the scenario reports those rejections as
// not-testable rather than a vacuous SUCCESS.
const NONCE_FIRST = process.env.DPOP_NONCE_FIRST === '1';
// Clock-offset mode (negative-test fixture only): shift the server's notion of
// "now" — and its `Date` header — by N seconds to simulate a skewed server
// clock. Used to prove the scenario anchors its iat probes to the server's Date.
const CLOCK_OFFSET = intEnv('DPOP_CLOCK_OFFSET_SECONDS', 0);

// Asymmetric JWS algorithms acceptable for a DPoP proof (RFC 9449 §4.3 step 5).
const ASYMMETRIC_ALGS = [
  'ES256',
  'ES384',
  'ES512',
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'EdDSA'
];

type Failure = { error: string; description: string; nonce?: boolean };
type Result = { ok: true } | ({ ok: false } & Failure);

const fail = (error: string, description: string, nonce = false): Result => ({
  ok: false,
  error,
  description,
  nonce
});

let issuerKey: jose.CryptoKey | Uint8Array;

function reconstructHtu(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || 'http';
  const host = req.headers.host;
  return `${proto}://${host}${req.originalUrl.split('?')[0]}`;
}

function countHeader(req: Request, name: string): number {
  let n = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === name) n++;
  }
  return n;
}

async function validateDpop(req: Request): Promise<Result> {
  // --- Access token presentation: must use the DPoP scheme (RFC 9449 §7.1) ---
  const authz = req.headers.authorization;
  if (!authz) return fail('invalid_token', 'missing Authorization header');
  if (!authz.startsWith('DPoP ')) {
    return fail(
      'invalid_token',
      'access token must be presented with the DPoP scheme'
    );
  }
  const accessToken = authz.slice('DPoP '.length).trim();

  // --- Exactly one DPoP header (§4.3 step 1) ---
  const dpopCount = countHeader(req, 'dpop');
  if (dpopCount === 0)
    return fail('invalid_dpop_proof', 'missing DPoP proof header');
  if (dpopCount > 1)
    return fail('invalid_dpop_proof', 'more than one DPoP header field');
  const proof = req.headers.dpop as string;

  // --- Nonce-first negative mode: challenge before structural validation ---
  if (REQUIRE_NONCE && NONCE_FIRST) {
    let nonce: unknown;
    try {
      nonce = jose.decodeJwt(proof).nonce;
    } catch {
      nonce = undefined;
    }
    const hasNonce = typeof nonce === 'string' && nonce.length > 0;
    if (!hasNonce) {
      return fail(
        'use_dpop_nonce',
        'a server-provided nonce is required',
        true
      );
    }
    if (!NONCE_ACCEPT_ANY && nonce !== NONCE) {
      return fail('use_dpop_nonce', 'the supplied nonce does not match', true);
    }
  }

  // --- Proof is a well-formed JWT with required header params (§4.3 steps 2,4,5,7) ---
  let header: jose.ProtectedHeaderParameters;
  try {
    header = jose.decodeProtectedHeader(proof);
  } catch {
    return fail('invalid_dpop_proof', 'DPoP proof is not a well-formed JWT');
  }
  if (header.typ !== 'dpop+jwt')
    return fail('invalid_dpop_proof', 'typ must be dpop+jwt');
  if (!header.alg || !ASYMMETRIC_ALGS.includes(header.alg)) {
    return fail(
      'invalid_dpop_proof',
      'alg must be a supported asymmetric algorithm'
    );
  }
  const jwk = header.jwk as jose.JWK | undefined;
  if (!jwk) return fail('invalid_dpop_proof', 'missing jwk header parameter');
  if ((jwk as Record<string, unknown>).d !== undefined) {
    return fail('invalid_dpop_proof', 'jwk must not contain a private key');
  }

  // --- Signature verifies with the embedded public key (§4.3 step 6) ---
  let claims: jose.JWTPayload;
  try {
    const proofKey = await jose.importJWK(jwk, header.alg);
    const verified = await jose.jwtVerify(proof, proofKey, {
      algorithms: ASYMMETRIC_ALGS
    });
    claims = verified.payload;
  } catch {
    return fail('invalid_dpop_proof', 'DPoP proof signature does not verify');
  }

  // --- Required claims + htm/htu match (§4.3 steps 3,8,9) ---
  if (typeof claims.jti !== 'string')
    return fail('invalid_dpop_proof', 'missing jti claim');
  if (claims.htm !== req.method)
    return fail('invalid_dpop_proof', 'htm does not match request method');
  if (claims.htu !== reconstructHtu(req))
    return fail('invalid_dpop_proof', 'htu does not match request URI');

  // --- iat acceptance window of ±IAT_SKEW (§4.3 step 11; SEP ±5 min) ---
  if (typeof claims.iat !== 'number')
    return fail('invalid_dpop_proof', 'missing iat claim');
  const now = Math.floor(Date.now() / 1000) + CLOCK_OFFSET;
  if (Math.abs(now - claims.iat) > IAT_SKEW) {
    return fail('invalid_dpop_proof', 'iat outside the acceptable window');
  }

  // --- Access token validity: signature, issuer, audience, expiry ---
  let tokenClaims: jose.JWTPayload;
  try {
    const verified = await jose.jwtVerify(accessToken, issuerKey, {
      issuer: ISSUER,
      audience: AUDIENCE
    });
    tokenClaims = verified.payload;
  } catch {
    return fail(
      'invalid_token',
      'access token is invalid (signature/issuer/audience/expiry)'
    );
  }

  // --- ath binds the proof to this access token (§4.3 step 12a) ---
  const expectedAth = createHash('sha256')
    .update(accessToken, 'ascii')
    .digest('base64url');
  if (claims.ath !== expectedAth)
    return fail('invalid_dpop_proof', 'ath does not match the access token');

  // --- Token is bound to the proof key (§4.3 step 12b) ---
  const cnf = tokenClaims.cnf as { jkt?: string } | undefined;
  const thumbprint = await jose.calculateJwkThumbprint(jwk, 'sha256');
  if (!cnf || cnf.jkt !== thumbprint) {
    return fail(
      'invalid_token',
      'access token is not bound to the DPoP proof key (cnf.jkt mismatch)'
    );
  }

  // --- Optional server-provided nonce (§4.3 step 10; §9) ---
  if (REQUIRE_NONCE) {
    const hasNonce =
      typeof claims.nonce === 'string' && claims.nonce.length > 0;
    if (!hasNonce) {
      return fail(
        'use_dpop_nonce',
        'a server-provided nonce is required',
        true
      );
    }
    if (!NONCE_ACCEPT_ANY && claims.nonce !== NONCE) {
      return fail('use_dpop_nonce', 'the supplied nonce does not match', true);
    }
  }

  return { ok: true };
}

function send401(res: Response, f: Failure): void {
  const algs = ASYMMETRIC_ALGS.join(' ');
  res.setHeader(
    'WWW-Authenticate',
    `DPoP error="${f.error}", error_description="${f.description}", algs="${algs}"`
  );
  if (f.nonce) res.setHeader('DPoP-Nonce', NONCE);
  res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Unauthorized' },
    id: null
  });
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'sep-1932-compliant-server',
    version: '1.0.0'
  });
  server.registerTool(
    'echo',
    {
      description: 'Echo the input back',
      inputSchema: { message: z.string() }
    },
    async ({ message }) => ({
      content: [{ type: 'text', text: `Echo: ${message}` }]
    })
  );
  return server;
}

const app = express();
app.use(express.json());

// Clock-offset mode: reflect the skewed clock in the Date header too, so a
// client that anchors to it measures against the same clock the server uses.
if (CLOCK_OFFSET) {
  app.use((_req: Request, res: Response, next) => {
    res.setHeader(
      'Date',
      new Date(Date.now() + CLOCK_OFFSET * 1000).toUTCString()
    );
    next();
  });
}

app.post('/mcp', async (req: Request, res: Response) => {
  const result = await validateDpop(req);
  if (!result.ok) {
    send401(res, result);
    return;
  }
  try {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: `Internal error: ${error instanceof Error ? error.message : String(error)}`
        },
        id: null
      });
    }
  }
});

const PORT = parseInt(process.env.PORT || '3010', 10);

async function main(): Promise<void> {
  issuerKey = await jose.importJWK(ISSUER_JWK, ISSUER_JWK.alg || 'ES256');
  app.listen(PORT, '127.0.0.1', () => {
    console.log(
      `DPoP compliant server running on http://localhost:${PORT}/mcp`
    );
  });
}

main().catch((err) => {
  console.error('Failed to start DPoP compliant server:', err);
  process.exit(1);
});
