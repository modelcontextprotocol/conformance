import * as jose from 'jose';
import type { JWK, CryptoKey } from 'jose';
import { createHash, randomBytes } from 'node:crypto';

/**
 * DPoP proof construction helpers (RFC 9449).
 *
 * Shared across the DPoP client, server, and authorization-server conformance
 * scenarios. The framework uses these to act as a DPoP client: it generates a
 * key pair, builds a well-formed `dpop+jwt` proof for the happy path, and builds
 * deliberately-malformed variants (one defect at a time) for the negative checks.
 *
 * Correctness of this module is anchored to published RFC test vectors in
 * `dpopProof.test.ts` (RFC 9449 §4 examples), not to the conformance servers
 * that consume it — so the builder and the validators cannot share a bug.
 */

const DEFAULT_ALG = 'ES256';
const DPOP_TYP = 'dpop+jwt';

export interface DpopKeyPair {
  /** Private key used to sign proofs. */
  privateKey: CryptoKey;
  /** Public key matching {@link publicJwk}. */
  publicKey: CryptoKey;
  /** Public JWK embedded in the proof's `jwk` header parameter. */
  publicJwk: JWK;
  /** RFC 7638 JWK SHA-256 thumbprint (the value bound as `cnf.jkt`). */
  thumbprint: string;
}

/**
 * Generate an asymmetric key pair for DPoP proofs (default ES256 / P-256).
 * The private key is non-extractable by default (RFC 9449 §11 guidance —
 * production clients should do the same); pass `extractable: true` only for
 * the negative variants that must export it (e.g. `embedPrivateKey`).
 */
export async function generateDpopKeyPair(
  alg: string = DEFAULT_ALG,
  { extractable = false }: { extractable?: boolean } = {}
): Promise<DpopKeyPair> {
  const { publicKey, privateKey } = await jose.generateKeyPair(alg, {
    extractable
  });
  const publicJwk = await jose.exportJWK(publicKey);
  const thumbprint = await jose.calculateJwkThumbprint(publicJwk, 'sha256');
  return { privateKey, publicKey, publicJwk, thumbprint };
}

/**
 * Compute the `ath` claim for a DPoP proof presented with an access token:
 * the base64url-encoded SHA-256 of the ASCII access-token value (RFC 9449 §4.1).
 */
export function accessTokenHash(accessToken: string): string {
  return createHash('sha256').update(accessToken, 'ascii').digest('base64url');
}

/** RFC 7638 JWK SHA-256 thumbprint (base64url). */
export async function jwkThumbprint(jwk: JWK): Promise<string> {
  return jose.calculateJwkThumbprint(jwk, 'sha256');
}

export interface DpopProofOptions {
  /** Key pair whose private key signs the proof and whose public JWK is embedded. */
  keyPair: DpopKeyPair;
  /** HTTP method of the target request (`htm` claim). */
  htm: string;
  /** HTTP target URI of the request, no query/fragment (`htu` claim). */
  htu: string;
  /** When set, adds an `ath` claim bound to this access token. */
  accessToken?: string;
  /** When set, adds a `nonce` claim (server-supplied nonce). */
  nonce?: string;
  /** `iat` in epoch seconds. Defaults to now. Override to craft stale/future proofs. */
  iat?: number;
  /** `jti` value. Defaults to a fresh random id. */
  jti?: string;

  // --- override knobs for crafting deliberately-invalid variants ---
  /** Override the `typ` header (default `dpop+jwt`). */
  typ?: string;
  /** Override the signing algorithm (default ES256). */
  alg?: string;
  /** Embed the PRIVATE JWK in the header instead of the public one (invalid). */
  embedPrivateKey?: boolean;
  /** Replace the embedded `jwk` header entirely. */
  jwkOverride?: JWK;
  /** Omit specific header params / claims to craft "missing field" variants. */
  omit?: Array<'jti' | 'htm' | 'htu' | 'iat' | 'typ' | 'jwk'>;
  /** Force a specific (wrong) `ath` value. */
  athOverride?: string;
  /** Sign with a symmetric key (HS256) — must be rejected (asymmetric-only). */
  symmetric?: boolean;
  /** Produce an unsigned `alg: none` proof — must be rejected. */
  unsigned?: boolean;
  /** Corrupt the signature after signing so verification fails. */
  tamperSignature?: boolean;
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/**
 * Build a DPoP proof JWT. With no override knobs set, produces a well-formed,
 * RFC 9449-conformant proof. The override knobs each introduce exactly one
 * defect so a negative check can attribute a rejection to that single cause.
 */
export async function buildDpopProof(
  options: DpopProofOptions
): Promise<string> {
  const omit = new Set(options.omit ?? []);
  const iat = options.iat ?? Math.floor(Date.now() / 1000);
  const jti = options.jti ?? randomBytes(16).toString('base64url');

  // ----- claims (payload) -----
  const payload: Record<string, unknown> = {};
  if (!omit.has('jti')) payload.jti = jti;
  if (!omit.has('htm')) payload.htm = options.htm;
  if (!omit.has('htu')) payload.htu = options.htu;
  if (!omit.has('iat')) payload.iat = iat;
  if (options.athOverride !== undefined) {
    payload.ath = options.athOverride;
  } else if (options.accessToken !== undefined) {
    payload.ath = accessTokenHash(options.accessToken);
  }
  if (options.nonce !== undefined) payload.nonce = options.nonce;

  // ----- protected header -----
  const unsigned = options.unsigned === true || options.alg === 'none';
  const alg = unsigned
    ? 'none'
    : options.symmetric
      ? 'HS256'
      : (options.alg ?? DEFAULT_ALG);
  const header: Record<string, unknown> = { alg };
  if (!omit.has('typ')) header.typ = options.typ ?? DPOP_TYP;
  if (!omit.has('jwk')) {
    if (options.jwkOverride !== undefined) {
      header.jwk = options.jwkOverride;
    } else if (options.embedPrivateKey === true) {
      header.jwk = await jose.exportJWK(options.keyPair.privateKey);
    } else {
      header.jwk = options.keyPair.publicJwk;
    }
  }

  // ----- assembly / signing -----
  if (unsigned) {
    // `alg: none` — no signature segment.
    return `${base64urlJson(header)}.${base64urlJson(payload)}.`;
  }

  if (options.symmetric) {
    const secret = new Uint8Array(randomBytes(32));
    return new jose.SignJWT(payload)
      .setProtectedHeader(header as jose.JWTHeaderParameters)
      .sign(secret);
  }

  const jwt = await new jose.SignJWT(payload)
    .setProtectedHeader(header as jose.JWTHeaderParameters)
    .sign(options.keyPair.privateKey);

  if (options.tamperSignature) {
    const parts = jwt.split('.');
    parts[2] = corruptSegment(parts[2]);
    return parts.join('.');
  }

  return jwt;
}

/**
 * Corrupt a base64url signature so it no longer verifies. We flip the FIRST
 * character (all 6 of its bits are significant): the LAST character of a
 * 64-byte ECDSA signature carries 4 zero padding bits, so flipping it (e.g.
 * `A`→`B`) can decode to the same bytes and leave the signature valid.
 */
function corruptSegment(segment: string): string {
  const first = segment[0];
  const replacement = first === 'A' ? 'B' : 'A';
  return replacement + segment.slice(1);
}
