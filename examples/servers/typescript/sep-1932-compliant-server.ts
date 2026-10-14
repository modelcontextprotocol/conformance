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
 *   DPOP_IAT_SKEW_SECONDS (default 300), DPOP_REQUIRE_NONCE ('1'), DPOP_NONCE,
 *   DPOP_BEARER_REJECT_STATUS (negative-test: Bearer-scheme status, no challenge),
 *   DPOP_UNBOUND_REJECT_STATUS (negative-test: unbound Bearer status),
 *   DPOP_UNBOUND_NONCE_CHALLENGE (unbound Bearer gets a use_dpop_nonce 401),
 *   DPOP_ERROR_CODE_OVERRIDE (negative-test: that code on every 401),
 *   DPOP_PRM_OMIT_ALGS (negative-test: PRM omits dpop_signing_alg_values_supported),
 *   DPOP_PRM_OMIT_REQUIRED (negative-test: PRM omits dpop_bound_access_tokens_required),
 *   DPOP_PRM_EMPTY_ALGS, DPOP_PRM_ALGS_NOT_ARRAY, DPOP_PRM_ALG_NON_STRING,
 *   DPOP_PRM_REQUIRED_NOT_BOOLEAN, DPOP_PRM_INCLUDE_NONE, DPOP_PRM_INCLUDE_HS256,
 *   DPOP_PRM_DISABLED (no PRM route), DPOP_PRM_WRONG_RESOURCE,
 *   DPOP_PRM_OMIT_RESOURCE, DPOP_PRM_HTML,
 *   DPOP_PRM_AT_ROOT (PRM only at the root well-known URL, resource = origin),
 *   DPOP_PRM_REDIRECT (metadata URL 308s to the document),
 *   DPOP_ACCEPT_UNBOUND_BEARER (negative-test: accept an unbound Bearer token),
 *   DPOP_OMIT_CHALLENGE_ALGS (negative-test: DPoP challenge without `algs`),
 *   DPOP_BEARER_ONLY_CHALLENGE (unauthenticated 401 is Bearer, not DPoP),
 *   DPOP_OMIT_RESOURCE_METADATA (challenge omits resource_metadata).
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
// Bearer-downgrade negative mode: answer a Bearer-scheme request with this
// status and no WWW-Authenticate challenge. Used to prove RejectsBearerScheme
// FAILs a server that crashes or 404s instead of authenticating.
const BEARER_REJECT_STATUS = process.env.DPOP_BEARER_REJECT_STATUS
  ? intEnv('DPOP_BEARER_REJECT_STATUS', 0)
  : 0;
// Wrong-error-code mode (negative-test fixture only): every 401 uses this
// `error` value instead of the real one. Proves ReportsDpopErrorCode can WARNING.
const ERROR_CODE_OVERRIDE = process.env.DPOP_ERROR_CODE_OVERRIDE || '';
// PRM omits dpop_signing_alg_values_supported. Proves PrmDpop can FAILURE.
const PRM_OMIT_ALGS = process.env.DPOP_PRM_OMIT_ALGS === '1';
// PRM omits dpop_bound_access_tokens_required. Absence is valid (RFC 9728).
const PRM_OMIT_REQUIRED = process.env.DPOP_PRM_OMIT_REQUIRED === '1';
const PRM_EMPTY_ALGS = process.env.DPOP_PRM_EMPTY_ALGS === '1';
const PRM_ALGS_NOT_ARRAY = process.env.DPOP_PRM_ALGS_NOT_ARRAY === '1';
const PRM_ALG_NON_STRING = process.env.DPOP_PRM_ALG_NON_STRING === '1';
const PRM_REQUIRED_NOT_BOOLEAN =
  process.env.DPOP_PRM_REQUIRED_NOT_BOOLEAN === '1';
// PRM lists `none` among its DPoP algs. Proves PrmDpop can FAILURE.
const PRM_INCLUDE_NONE = process.env.DPOP_PRM_INCLUDE_NONE === '1';
const PRM_INCLUDE_HS256 = process.env.DPOP_PRM_INCLUDE_HS256 === '1';
// No protected-resource-metadata route. Proves the unreachable paths.
const PRM_DISABLED = process.env.DPOP_PRM_DISABLED === '1';
const PRM_WRONG_RESOURCE = process.env.DPOP_PRM_WRONG_RESOURCE === '1';
const PRM_OMIT_RESOURCE = process.env.DPOP_PRM_OMIT_RESOURCE === '1';
// 200 whose body is JSON but whose Content-Type is not application/json.
const PRM_HTML = process.env.DPOP_PRM_HTML === '1';
// resource_metadata URL answers 308, then the real document.
const PRM_REDIRECT = process.env.DPOP_PRM_REDIRECT === '1';
// PRM is served only at the root well-known URL, naming the origin as its
// resource (RFC 9728 §3.3 for that URL).
const PRM_AT_ROOT = process.env.DPOP_PRM_AT_ROOT === '1';
// Accept a valid unbound Bearer token (no cnf). A DPoP-bound token presented
// as Bearer is still rejected. Proves PrmConsistency can FAILURE.
const ACCEPT_UNBOUND_BEARER = process.env.DPOP_ACCEPT_UNBOUND_BEARER === '1';
// Unbound Bearer token is answered with this status (4xx counts as rejection;
// 5xx must not).
const UNBOUND_REJECT_STATUS = process.env.DPOP_UNBOUND_REJECT_STATUS
  ? intEnv('DPOP_UNBOUND_REJECT_STATUS', 0)
  : 0;
// Unbound Bearer token is answered with a use_dpop_nonce 401 (no DPoP-Nonce
// header, so later probes are unaffected).
const UNBOUND_NONCE_CHALLENGE =
  process.env.DPOP_UNBOUND_NONCE_CHALLENGE === '1';
// DPoP challenge omits `algs`. Proves AdvertisesDpop can WARNING.
const OMIT_CHALLENGE_ALGS = process.env.DPOP_OMIT_CHALLENGE_ALGS === '1';
// Unauthenticated 401 carries only a Bearer challenge.
const BEARER_ONLY_CHALLENGE = process.env.DPOP_BEARER_ONLY_CHALLENGE === '1';
// Challenge omits resource_metadata so discovery uses the well-known URL.
const OMIT_RESOURCE_METADATA = process.env.DPOP_OMIT_RESOURCE_METADATA === '1';

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

function metadataUrl(): string {
  const origin = new URL(AUDIENCE).origin;
  if (PRM_REDIRECT) return `${origin}/prm-redirect`;
  if (PRM_AT_ROOT) return `${origin}/.well-known/oauth-protected-resource`;
  return `${origin}/.well-known/oauth-protected-resource/mcp`;
}

function prmResource(): string {
  if (PRM_WRONG_RESOURCE) return 'https://attacker.example/mcp';
  if (PRM_AT_ROOT) return new URL(AUDIENCE).origin;
  return AUDIENCE;
}

function prmDocument(): Record<string, unknown> {
  const doc: Record<string, unknown> = PRM_OMIT_RESOURCE
    ? {}
    : { resource: prmResource() };
  if (!PRM_OMIT_ALGS) {
    const listed = [
      ...ASYMMETRIC_ALGS,
      ...(PRM_INCLUDE_NONE ? ['none'] : []),
      ...(PRM_INCLUDE_HS256 ? ['HS256'] : [])
    ];
    doc.dpop_signing_alg_values_supported = PRM_EMPTY_ALGS
      ? []
      : PRM_ALGS_NOT_ARRAY
        ? 'ES256'
        : PRM_ALG_NON_STRING
          ? [1]
          : listed;
  }
  if (!PRM_OMIT_REQUIRED) {
    doc.dpop_bound_access_tokens_required = PRM_REQUIRED_NOT_BOOLEAN
      ? 'true'
      : true;
  }
  return doc;
}

function tokenIsBound(authz: string): boolean {
  try {
    const claims = jose.decodeJwt(authz.slice('Bearer '.length).trim());
    const cnf = claims.cnf as { jkt?: string } | undefined;
    return typeof cnf?.jkt === 'string';
  } catch {
    return false;
  }
}

function send401(req: Request, res: Response, f: Failure): void {
  const error = ERROR_CODE_OVERRIDE || f.error;
  const metadata = OMIT_RESOURCE_METADATA
    ? []
    : [`resource_metadata="${metadataUrl()}"`];
  // Only the unauthenticated probe. Authenticated 401s keep the DPoP challenge
  // so the rejection battery still has a scheme to grade.
  if (BEARER_ONLY_CHALLENGE && !req.headers.authorization) {
    const bearerParams = ['realm="mcp"', ...metadata];
    res.setHeader('WWW-Authenticate', `Bearer ${bearerParams.join(', ')}`);
  } else {
    const params = [`error="${error}"`, `error_description="${f.description}"`];
    if (!OMIT_CHALLENGE_ALGS) {
      params.push(`algs="${ASYMMETRIC_ALGS.join(' ')}"`);
    }
    params.push(...metadata);
    res.setHeader('WWW-Authenticate', `DPoP ${params.join(', ')}`);
  }
  if (f.nonce) res.setHeader('DPoP-Nonce', NONCE);
  res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Unauthorized' },
    id: null
  });
}

async function handleMcp(req: Request, res: Response): Promise<void> {
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

if (PRM_REDIRECT) {
  app.get('/prm-redirect', (_req, res) => {
    res.redirect(308, '/.well-known/oauth-protected-resource/mcp');
  });
}

if (!PRM_DISABLED) {
  const prmPath = PRM_AT_ROOT
    ? '/.well-known/oauth-protected-resource'
    : '/.well-known/oauth-protected-resource/mcp';
  app.get(prmPath, (_req, res) => {
    if (PRM_HTML) {
      res.status(200).type('text/html').send(JSON.stringify(prmDocument()));
      return;
    }
    res.json(prmDocument());
  });
}

app.post('/mcp', async (req: Request, res: Response) => {
  const authz = req.headers.authorization ?? '';
  if (authz.startsWith('Bearer ')) {
    const bound = tokenIsBound(authz);
    if (bound && BEARER_REJECT_STATUS) {
      // Only the downgrade probe (a DPoP-bound token presented as Bearer). An
      // unbound Bearer token is the consistency probe and must still be judged
      // by validateDpop, unless an UNBOUND_* mode below answers it first.
      res.status(BEARER_REJECT_STATUS).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal error' },
        id: null
      });
      return;
    }
    if (!bound && UNBOUND_NONCE_CHALLENGE) {
      res.setHeader('WWW-Authenticate', `DPoP error="use_dpop_nonce"`);
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized' },
        id: null
      });
      return;
    }
    if (!bound && UNBOUND_REJECT_STATUS) {
      res.status(UNBOUND_REJECT_STATUS).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized' },
        id: null
      });
      return;
    }
  }
  if (ACCEPT_UNBOUND_BEARER && authz.startsWith('Bearer ')) {
    const raw = authz.slice('Bearer '.length).trim();
    try {
      const verified = await jose.jwtVerify(raw, issuerKey, {
        issuer: ISSUER,
        audience: AUDIENCE
      });
      const cnf = verified.payload.cnf as { jkt?: string } | undefined;
      if (!cnf?.jkt) {
        await handleMcp(req, res);
        return;
      }
    } catch {
      // Not a valid unbound token. Fall through and reject it as Bearer.
    }
  }
  const result = await validateDpop(req);
  if (!result.ok) {
    send401(req, res, result);
    return;
  }
  await handleMcp(req, res);
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
