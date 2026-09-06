import * as jose from 'jose';

export const JWT_BEARER_GRANT_TYPE =
  'urn:ietf:params:oauth:grant-type:jwt-bearer';
export const DEFAULT_WORKLOAD_JWT_ALG = 'ES256';

// Scope values used by the WIF scenario's mock AS and broken-client runners.
// Exported here so both sides stay in sync without manual duplication.
export const WIF_TRIGGER_UNAUTHORIZED_SCOPE = 'wif.trigger-unauthorized';
export const WIF_REJECTED_SCOPE = 'wif.rejected';

export interface CreateWorkloadJwtOptions {
  issuer: string;
  subject: string;
  audience: string | string[];
  privateKey: jose.CryptoKey;
  /** Jose duration string (e.g. '5m', '-60s', '60 seconds ago'). Use a negative offset to construct already-expired tokens for negative tests. */
  expiresIn?: string;
  jwtId?: string;
  issuedAt?: number;
  notBefore?: number;
  algorithm?: string;
  additionalClaims?: Record<string, unknown>;
}

export async function createWorkloadJwt(
  opts: CreateWorkloadJwtOptions
): Promise<string> {
  const {
    issuer,
    subject,
    audience,
    privateKey,
    expiresIn = '5m',
    jwtId = crypto.randomUUID(),
    issuedAt,
    notBefore,
    algorithm = DEFAULT_WORKLOAD_JWT_ALG,
    additionalClaims
  } = opts;

  // additionalClaims are merged first; reserved claims set via builder methods
  // overwrite any same-named key already in the payload, so callers cannot
  // accidentally override iss/sub/aud/exp/iat/jti via additionalClaims.
  const extra: Record<string, unknown> = additionalClaims
    ? { ...additionalClaims }
    : {};

  let builder = new jose.SignJWT(extra)
    .setProtectedHeader({ alg: algorithm })
    .setIssuer(issuer)
    .setSubject(subject)
    .setAudience(audience)
    .setExpirationTime(expiresIn)
    .setJti(jwtId);

  if (issuedAt !== undefined) {
    builder = builder.setIssuedAt(issuedAt);
  } else {
    builder = builder.setIssuedAt();
  }

  if (notBefore !== undefined) {
    builder = builder.setNotBefore(notBefore);
  }

  return builder.sign(privateKey);
}

export interface WorkloadKeypair {
  publicKey: jose.CryptoKey;
  privateKey: jose.CryptoKey;
  privateKeyPem: string;
  publicJwk: jose.JWK;
}

export async function generateWorkloadKeypair(
  alg: string = DEFAULT_WORKLOAD_JWT_ALG
): Promise<WorkloadKeypair> {
  const { publicKey, privateKey } = await jose.generateKeyPair(alg, {
    extractable: true
  });
  const privateKeyPem = await jose.exportPKCS8(privateKey);
  const publicJwk = await jose.exportJWK(publicKey);
  return { publicKey, privateKey, privateKeyPem, publicJwk };
}
