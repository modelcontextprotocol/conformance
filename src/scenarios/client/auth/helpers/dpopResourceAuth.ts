import type { Request, Response, NextFunction, RequestHandler } from 'express';
import * as jose from 'jose';
import { createHash } from 'node:crypto';

/** Fixed nonce the judge hands out when `requireNonce` is set (RFC 9449 §9). */
const RS_DPOP_NONCE = 'conformance-rs-dpop-nonce';

/** Asymmetric JWS algorithms acceptable for a DPoP proof (RFC 9449 §4.3 / §11.6). */
const DPOP_ASYMMETRIC_ALGS = [
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

/**
 * Accumulated observations of how the client presented its access token and
 * per-request DPoP proof. The scenario turns these into the two
 * sep-1932-client-* checks in getChecks() — freshness needs cross-request
 * state (unique `jti` per request), so we accumulate rather than emit inline.
 */
export interface DpopClientObservations {
  authenticatedRequests: number;
  nonDpopSchemeSeen: boolean;
  observedSchemes: string[];
  jtisSeen: string[];
  replayDetected: boolean;
  allProofsWellFormed: boolean;
  proofError?: string;
  /** The judge issued a `use_dpop_nonce` challenge (RFC 9449 §9). */
  rsNonceChallengeIssued: boolean;
  /** The client retried the request carrying the correct nonce. */
  rsNonceHonored: boolean;
}

export function newDpopClientObservations(): DpopClientObservations {
  return {
    authenticatedRequests: 0,
    nonDpopSchemeSeen: false,
    observedSchemes: [],
    jtisSeen: [],
    replayDetected: false,
    allProofsWellFormed: true,
    rsNonceChallengeIssued: false,
    rsNonceHonored: false
  };
}

/**
 * Test MCP server DPoP judge (SEP-1932 / RFC 9449), passed to `createServer`
 * via its `options.authMiddleware` hook. An unauthenticated request gets a
 * `401 DPoP` discovery challenge; an authenticated one is observed (scheme +
 * per-request proof) and allowed through so the MCP session can complete and
 * multiple requests can be examined for proof freshness.
 *
 * Proof validation is hand-rolled with jose — deliberately an INDEPENDENT code
 * path from the suite's proof builder, so a shared bug surfaces rather than hides.
 */
export function createDpopResourceAuth(
  obs: DpopClientObservations,
  getResourceUrl: () => string,
  getPrmUrl: () => string,
  requireNonce = false
): RequestHandler {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const authorization = req.headers.authorization;
    if (!authorization) {
      res
        .status(401)
        .set('WWW-Authenticate', `DPoP resource_metadata="${getPrmUrl()}"`)
        .json({ error: 'unauthorized' });
      return;
    }

    obs.authenticatedRequests++;
    const { scheme, token } = splitAuthorization(authorization);
    obs.observedSchemes.push(scheme);
    if (scheme.toLowerCase() !== 'dpop') {
      obs.nonDpopSchemeSeen = true;
    }

    const proofHeader = req.headers['dpop'];
    // Node collapses duplicate DPoP request headers into one comma-joined value;
    // validateResourceProof rejects a comma (RFC 9449 §4.2 — at most one proof).
    const proofValue = Array.isArray(proofHeader)
      ? proofHeader.join(', ')
      : proofHeader;
    const result = await validateResourceProof(
      proofValue,
      token,
      req.method,
      getResourceUrl()
    );
    if (!result.ok) {
      obs.allProofsWellFormed = false;
      obs.proofError ??= result.error;
      next();
      return;
    }

    // Record proof freshness on ANY valid proof, before the nonce gate. A
    // nonce-challenged (but otherwise valid) proof still demonstrates freshness,
    // so fresh-proof is never asserted on zero `jti` evidence, and a client that
    // never honours the nonce fails only rs-nonce (not fresh-proof as well).
    //
    // Deliberate consequence: a client that re-sends the *identical* proof
    // across the challenge/retry boundary (same `jti`) trips replay detection.
    // That is a genuine RFC 9449 §4.2 violation (`jti` MUST be unique per proof)
    // — a conformant client mints a fresh proof, carrying the nonce, on retry.
    if (obs.jtisSeen.includes(result.jti)) {
      obs.replayDetected = true;
    } else {
      obs.jtisSeen.push(result.jti);
    }

    // RFC 9449 §9: require a server-provided nonce. A valid proof without the
    // correct nonce is challenged (401 use_dpop_nonce + DPoP-Nonce); the client
    // is expected to retry with it.
    if (requireNonce) {
      let proofNonce: unknown;
      try {
        proofNonce = proofValue ? jose.decodeJwt(proofValue).nonce : undefined;
      } catch {
        proofNonce = undefined;
      }
      if (proofNonce !== RS_DPOP_NONCE) {
        obs.rsNonceChallengeIssued = true;
        res
          .status(401)
          .set(
            'WWW-Authenticate',
            `DPoP error="use_dpop_nonce", resource_metadata="${getPrmUrl()}"`
          )
          .set('DPoP-Nonce', RS_DPOP_NONCE)
          .json({ error: 'use_dpop_nonce' });
        return;
      }
      obs.rsNonceHonored = true;
    }

    next();
  };
}

function splitAuthorization(authorization: string): {
  scheme: string;
  token: string;
} {
  const idx = authorization.indexOf(' ');
  if (idx === -1) return { scheme: authorization, token: '' };
  return {
    scheme: authorization.slice(0, idx),
    token: authorization.slice(idx + 1).trim()
  };
}

/**
 * Canonicalize an `htu` for comparison per RFC 9449 §4.3 (RFC 3986 scheme-based
 * normalization): lowercase scheme/host, drop the default port, ignore a
 * trailing slash. Query/fragment are rejected by the caller (RFC 9449 §4.2),
 * not silently stripped here.
 */
function normalizeHtu(u: string): string {
  try {
    const url = new URL(u);
    // Tolerate a single trailing slash only; `/mcp//` is a distinct path.
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return u;
  }
}

/**
 * Validate a per-request DPoP proof presented alongside an access token
 * (RFC 9449 §4.3, resource-request subset): well-formed `dpop+jwt`, asymmetric
 * alg, embedded public jwk, htm/htu match, `ath` binds the token, signature
 * verifies, and the proof key's thumbprint matches the token's `cnf.jkt`.
 */
export async function validateResourceProof(
  proof: string | undefined,
  token: string,
  method: string,
  resourceUrl: string
): Promise<{ ok: true; jti: string } | { ok: false; error: string }> {
  if (!proof) return { ok: false, error: 'missing DPoP proof header' };
  // RFC 9449 §4.2: at most one DPoP header. A single proof JWT has no comma, so
  // a comma means duplicate headers were sent (Node joins them with ", ").
  if (proof.includes(',')) {
    return { ok: false, error: 'multiple DPoP proof headers' };
  }

  let header: jose.ProtectedHeaderParameters;
  try {
    header = jose.decodeProtectedHeader(proof);
  } catch {
    return { ok: false, error: 'DPoP proof is not a well-formed JWT' };
  }
  if (header.typ !== 'dpop+jwt')
    return { ok: false, error: 'typ must be dpop+jwt' };
  if (!header.alg || !DPOP_ASYMMETRIC_ALGS.includes(header.alg)) {
    return { ok: false, error: 'alg must be a supported asymmetric algorithm' };
  }
  const jwk = header.jwk as jose.JWK | undefined;
  if (!jwk) return { ok: false, error: 'missing jwk header parameter' };
  if ((jwk as Record<string, unknown>).d !== undefined) {
    return { ok: false, error: 'jwk must not contain a private key' };
  }

  let claims: jose.JWTPayload;
  try {
    const key = await jose.importJWK(jwk, header.alg);
    claims = (
      await jose.jwtVerify(proof, key, { algorithms: DPOP_ASYMMETRIC_ALGS })
    ).payload;
  } catch {
    return { ok: false, error: 'DPoP proof signature does not verify' };
  }
  if (typeof claims.jti !== 'string')
    return { ok: false, error: 'missing jti claim' };
  if (claims.htm !== method)
    return { ok: false, error: 'htm does not match the request method' };
  if (typeof claims.htu !== 'string') {
    return { ok: false, error: 'htu does not match the request URI' };
  }
  if (claims.htu.includes('?') || claims.htu.includes('#')) {
    return {
      ok: false,
      error: 'htu MUST NOT contain a query or fragment (RFC 9449 §4.2)'
    };
  }
  if (normalizeHtu(claims.htu) !== normalizeHtu(resourceUrl)) {
    return { ok: false, error: 'htu does not match the request URI' };
  }
  if (
    typeof claims.iat !== 'number' ||
    Math.abs(Math.floor(Date.now() / 1000) - claims.iat) > 300
  ) {
    return { ok: false, error: 'iat outside the acceptable window' };
  }
  // Recompute ath and the thumbprint inline (jose + node crypto) rather than
  // via the proof builder's helpers, so this validator stays a fully
  // independent path.
  const expectedAth = createHash('sha256')
    .update(token, 'ascii')
    .digest('base64url');
  if (typeof claims.ath !== 'string' || claims.ath !== expectedAth) {
    return {
      ok: false,
      error: 'ath does not match the presented access token'
    };
  }

  // Possession: the proof key must be the key the token is bound to.
  try {
    const tokenClaims = jose.decodeJwt(token);
    const cnf = tokenClaims.cnf as { jkt?: unknown } | undefined;
    const thumbprint = await jose.calculateJwkThumbprint(jwk, 'sha256');
    if (!cnf || cnf.jkt !== thumbprint) {
      return {
        ok: false,
        error: 'proof key thumbprint does not match the token cnf.jkt'
      };
    }
  } catch {
    return { ok: false, error: 'access token is not a decodable JWT' };
  }

  return { ok: true, jti: claims.jti };
}
