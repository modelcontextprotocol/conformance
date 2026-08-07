/**
 * Asymmetric JWS algorithms acceptable for a DPoP proof (RFC 9449 §4.3, §11.6).
 * Single source of truth shared by the test AS metadata and both proof
 * validators, so what is advertised and what is enforced cannot drift.
 */
export const DPOP_ASYMMETRIC_ALGS = [
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
