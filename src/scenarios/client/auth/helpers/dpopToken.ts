import * as jose from 'jose';
import type { JWK, CryptoKey } from 'jose';

/**
 * DPoP-bound access-token minting (RFC 9449 §6).
 *
 * Transport-free: this issues a signed JWT access token carrying the
 * `cnf.jkt` confirmation that binds the token to a DPoP key. It is the
 * token-issuing *core* shared across the DPoP scenarios:
 *
 *  - #369 server: the scenario (acting as client) mints a bound token to
 *    PRESENT to the server under test.
 *  - #370 AS / #368 client: the compliant/test authorization-server fixtures
 *    call this to ISSUE bound tokens (wrapped by an HTTP token endpoint).
 *
 * `jkt` is a parameter (not derived here) so the same function works whether
 * the bound key is ours (#369/#370) or extracted from a client's proof (#368).
 */

const DEFAULT_ALG = 'ES256';

export interface TokenIssuerKey {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicJwk: JWK;
  alg: string;
}

/** Generate an asymmetric signing key for the (test) token issuer. */
export async function generateIssuerKey(
  alg: string = DEFAULT_ALG
): Promise<TokenIssuerKey> {
  const { publicKey, privateKey } = await jose.generateKeyPair(alg, {
    extractable: true
  });
  const publicJwk = await jose.exportJWK(publicKey);
  return { privateKey, publicKey, publicJwk, alg };
}

/**
 * Reconstruct a {@link TokenIssuerKey} from a private JWK (e.g. supplied to a
 * scenario via env), deriving the public JWK by stripping the private scalar.
 * EC/OKP keys only (sufficient for the ES256 test issuer).
 */
export async function importIssuerKey(
  privateJwk: JWK,
  alg: string = DEFAULT_ALG
): Promise<TokenIssuerKey> {
  const privateKey = (await jose.importJWK(privateJwk, alg)) as CryptoKey;
  const publicJwk: JWK = { ...privateJwk };
  delete (publicJwk as Record<string, unknown>).d;
  const publicKey = (await jose.importJWK(publicJwk, alg)) as CryptoKey;
  return { privateKey, publicKey, publicJwk, alg };
}

export interface MintDpopBoundTokenOptions {
  /** Issuer signing key (the server under test must trust its public key). */
  issuerKey: TokenIssuerKey;
  /** `iss` claim — the token issuer identifier. */
  issuer: string;
  /** `aud` claim — the resource the token is for (the MCP server's canonical URI). */
  audience: string;
  /** Thumbprint bound as `cnf.jkt` (RFC 7638 JWK thumbprint of the DPoP public key). */
  jkt: string;
  /** `sub` claim. Defaults to a fixed test subject. */
  subject?: string;
  /** `scope` claim, if any. */
  scope?: string;
  /** `iat` in epoch seconds. Defaults to now. */
  iat?: number;
  /** Token lifetime in seconds. Defaults to 3600. */
  expiresInSeconds?: number;

  // --- override knobs for crafting deliberately-invalid variants ---
  /** Omit `cnf` entirely — an unbound (bearer-style) token. */
  omitCnf?: boolean;
  /** Bind to a different (foreign/wrong) thumbprint than the presented proof. */
  jktOverride?: string;
  /** Issue an already-expired token (`exp` in the past). */
  expired?: boolean;
  /** Additional claims to merge into the payload. */
  extraClaims?: Record<string, unknown>;
}

/**
 * Mint a signed JWT access token. With no override knobs set, produces a
 * valid DPoP-bound token whose `cnf.jkt` equals {@link MintDpopBoundTokenOptions.jkt}.
 */
export async function mintDpopBoundToken(
  options: MintDpopBoundTokenOptions
): Promise<string> {
  const iat = options.iat ?? Math.floor(Date.now() / 1000);
  const lifetime = options.expiresInSeconds ?? 3600;
  const exp = options.expired ? iat - 60 : iat + lifetime;

  const payload: Record<string, unknown> = { ...(options.extraClaims ?? {}) };
  if (options.scope !== undefined) payload.scope = options.scope;
  if (!options.omitCnf) {
    payload.cnf = { jkt: options.jktOverride ?? options.jkt };
  }

  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: options.issuerKey.alg, typ: 'at+jwt' })
    .setIssuer(options.issuer)
    .setAudience(options.audience)
    .setSubject(options.subject ?? 'conformance-test-subject')
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(options.issuerKey.privateKey);
}

/** The two DPoP sender-constraint signals carried by a token-endpoint response. */
export interface TokenBinding {
  /** Raw `token_type` from the token-endpoint response, or undefined if absent. */
  tokenType?: string;
  /** True when `token_type` is `DPoP` (RFC 6749 §7.1 makes token_type case-insensitive). */
  isDpopTokenType: boolean;
  /** `cnf.jkt` bound into the access token (RFC 9449 §6), or undefined if the
   *  token is opaque / not a JWT / carries no confirmation. */
  jkt?: string;
  /** True when the access token parsed as a JWT. When false the token is opaque,
   *  so `cnf.jkt` cannot be inspected off the wire (the binding may still hold,
   *  verifiable only via introspection) — a caller must not read a missing `jkt`
   *  as a binding failure in that case. */
  accessTokenIsJwt: boolean;
}

/**
 * Read the DPoP binding back out of an OAuth token-endpoint response, from the
 * perspective of an inspector (the #370 AS scenario). Combines the two signals
 * RFC 9449 §5 requires an AS to emit when it issues a bound token:
 *   1. `token_type: "DPoP"` in the JSON response, and
 *   2. `cnf.jkt` inside the access token.
 * Never throws — an opaque (non-JWT) access token yields `jkt: undefined` so a
 * caller can distinguish "bound" from "unbound/bearer" without special-casing.
 */
export function readTokenBinding(response: {
  access_token?: unknown;
  token_type?: unknown;
}): TokenBinding {
  const tokenType =
    typeof response.token_type === 'string' ? response.token_type : undefined;
  const isDpopTokenType = tokenType?.toLowerCase() === 'dpop';

  let jkt: string | undefined;
  let accessTokenIsJwt = false;
  if (typeof response.access_token === 'string') {
    try {
      const claims = jose.decodeJwt(response.access_token);
      accessTokenIsJwt = true;
      const cnf = claims.cnf as { jkt?: unknown } | undefined;
      if (cnf && typeof cnf.jkt === 'string') {
        jkt = cnf.jkt;
      }
    } catch {
      // Opaque / non-JWT access token → no readable binding.
    }
  }

  return { tokenType, isDpopTokenType, jkt, accessTokenIsJwt };
}
