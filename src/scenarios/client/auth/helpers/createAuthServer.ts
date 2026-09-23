import express, { Request, Response } from 'express';
import { createHash, randomBytes } from 'crypto';
import type { ConformanceCheck } from '../../../../types';
import type { ScenarioContext } from '../../../../mock-server';
import { isStatefulVersion } from '../../../../connection/select';
import { createRequestLogger } from '../../../request-logger';
import { SpecReferences } from '../spec-references';
import { MockTokenVerifier } from './mockTokenVerifier';
import * as jose from 'jose';
import {
  generateIssuerKey,
  mintDpopBoundToken,
  type TokenIssuerKey
} from './dpopToken';

/**
 * Compute S256 code challenge from a code verifier.
 * BASE64URL(SHA256(code_verifier))
 */
function computeS256Challenge(codeVerifier: string): string {
  const hash = createHash('sha256').update(codeVerifier).digest();
  return hash
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Fixed nonce the test AS hands out when `dpopRequireNonce` is set (RFC 9449 §8).
const AS_DPOP_NONCE = 'conformance-as-dpop-nonce';

// Asymmetric JWS algorithms acceptable for a DPoP proof (RFC 9449 §4.3, §11.6).
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
 * Validate a DPoP proof presented at the token endpoint (the token-request
 * subset of RFC 9449 §4.3). Hand-rolled with jose primitives — deliberately an
 * INDEPENDENT code path from the suite's proof builder, so a shared bug
 * surfaces rather than hides. Returns the JWK thumbprint to bind on success.
 */
export async function validateDpopProofAtTokenEndpoint(
  proof: string,
  tokenEndpointUrl: string
): Promise<{ ok: true; jkt: string } | { ok: false; error: string }> {
  let header: jose.ProtectedHeaderParameters;
  try {
    header = jose.decodeProtectedHeader(proof);
  } catch {
    return { ok: false, error: 'DPoP proof is not a well-formed JWT' };
  }
  if (header.typ !== 'dpop+jwt') {
    return { ok: false, error: 'typ must be dpop+jwt' };
  }
  if (!header.alg || !DPOP_ASYMMETRIC_ALGS.includes(header.alg)) {
    return { ok: false, error: 'alg must be a supported asymmetric algorithm' };
  }
  const jwk = header.jwk as jose.JWK | undefined;
  if (!jwk) {
    return { ok: false, error: 'missing jwk header parameter' };
  }
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
  if (typeof claims.jti !== 'string') {
    return { ok: false, error: 'missing jti claim' };
  }
  if (claims.htm !== 'POST') {
    return { ok: false, error: 'htm does not match POST' };
  }
  if (typeof claims.htu !== 'string') {
    return { ok: false, error: 'htu does not match the token endpoint' };
  }
  if (claims.htu.includes('?') || claims.htu.includes('#')) {
    return {
      ok: false,
      error: 'htu MUST NOT contain a query or fragment (RFC 9449 §4.2)'
    };
  }
  if (normalizeHtu(claims.htu) !== normalizeHtu(tokenEndpointUrl)) {
    return { ok: false, error: 'htu does not match the token endpoint' };
  }
  if (
    typeof claims.iat !== 'number' ||
    Math.abs(Math.floor(Date.now() / 1000) - claims.iat) > 300
  ) {
    return { ok: false, error: 'iat outside the acceptable window' };
  }
  const jkt = await jose.calculateJwkThumbprint(jwk, 'sha256');
  return { ok: true, jkt };
}

export interface TokenRequestResult {
  token: string;
  scopes: string[];
}

export interface TokenRequestError {
  error: string;
  errorDescription?: string;
  statusCode?: number;
}

/**
 * Sink for the DPoP token-request observation (RFC 9449 §5). The AS writes to
 * it on the authorization_code exchange (sticky-failure: once any exchange
 * lacks a valid proof it stays FAILURE; refresh grants are ignored) so the
 * client scenario can emit sep-1932-client-token-request-proof unconditionally
 * — FAILURE by default when the client never reaches the token endpoint,
 * matching its sibling checks.
 */
export interface DpopTokenRequestObservation {
  recorded: boolean;
  validProof: boolean;
  error?: string;
  /** The token endpoint issued a `use_dpop_nonce` challenge (RFC 9449 §8). */
  asNonceChallengeIssued: boolean;
  /** The client retried the token request carrying the correct nonce. */
  asNonceHonored: boolean;
  /**
   * `dpop_jkt` from the authorization request, if any (RFC 9449 §10).
   * Written only on an authorization_code exchange after a valid proof,
   * matching recordTokenRequestProof.
   */
  dpopJktSent?: string;
  /**
   * Whether `dpop_jkt` equals the JWK thumbprint of the token-request proof
   * key. Written only on an authorization_code exchange after a valid proof.
   */
  dpopJktMatched: boolean;
  /**
   * A later authorization_code exchange completed after an earlier one had
   * already issued a token. The client recovered by re-authorizing rather
   * than presenting the refresh token.
   */
  reauthorizedInsteadOfRefreshing?: boolean;
}

/**
 * What the client presented on a `refresh_token` grant (RFC 9449 §5).
 * Written for bound and unbound refreshes; a refresh never satisfies the
 * authorization_code §8 nonce observation.
 */
export interface DpopRefreshObservation {
  seen: boolean;
  proofPresent: boolean;
  proofValid: boolean;
  jktMatched: boolean;
  error?: string;
}

interface StoredRefreshToken {
  jkt?: string;
  scopes: string[];
  resource?: string;
  issuedAt: number;
}

export interface AuthServerOptions {
  metadataPath?: string;
  isOpenIdConfiguration?: boolean;
  loggingEnabled?: boolean;
  routePrefix?: string;
  scopesSupported?: string[];
  grantTypesSupported?: string[];
  tokenEndpointAuthMethodsSupported?: string[];
  tokenEndpointAuthSigningAlgValuesSupported?: string[];
  clientIdMetadataDocumentSupported?: boolean;
  /** Set to true to NOT advertise registration_endpoint (for pre-registration tests) */
  disableDynamicRegistration?: boolean;
  /** PKCE code_challenge_methods_supported. Set to null to omit from metadata. Default: ['S256'] */
  codeChallengeMethodsSupported?: string[] | null;
  /** Advertise authorization_response_iss_parameter_supported in AS metadata. Default: true. Pass null to omit. */
  issParameterSupported?: boolean | null;
  /**
   * What iss value to include in authorization redirect. Default: 'correct'.
   * 'normalized' sends a normalization-equivalent variant of the correct
   * issuer (trailing slash appended, exactly what `new URL(x).href`
   * round-tripping produces) — equal under RFC 3986 §6.2.2–6.2.3
   * normalization but not under simple string comparison.
   */
  issInRedirect?: 'correct' | 'wrong' | 'omit' | 'normalized';
  /**
   * Override the `issuer` value served in the AS metadata document. Used to
   * test that clients validate the metadata issuer against the issuer
   * identifier used to construct the well-known URL (RFC 8414 §3.3).
   * Accepts a lazy getter for callers that don't know the server URL until
   * after `start()`.
   */
  metadataIssuer?: string | (() => string);
  /**
   * DPoP (SEP-1932 / RFC 9449) — opt-in; absent ⇒ no DPoP behaviour at all.
   * When set, the AS advertises `dpop_signing_alg_values_supported` in its
   * metadata and validates+binds a DPoP proof presented at the token endpoint.
   */
  dpopSigningAlgValuesSupported?: string[];
  /**
   * Negative-test mode: make the AS misbehave in one specific way so a check
   * can be proven to FAIL.
   *  - 'omit-alg-values'   — drop `dpop_signing_alg_values_supported` entirely
   *  - 'empty-alg-values'  — advertise the field as an empty array
   *  - 'include-none'      — list `none` among the supported proof algs
   *  - 'unbound-token'     — issue a Bearer token ignoring a valid proof
   *  - 'unbound-refresh'   — accept a refresh with no proof or any key, and
   *    issue a token bound to the presented key, or none
   *  - 'rebind-on-refresh' — bind the new access token to the presented key
   *    even when it differs from the key bound to the refresh token
   */
  dpopMisbehavior?:
    | 'omit-alg-values'
    | 'empty-alg-values'
    | 'include-none'
    | 'unbound-token'
    | 'unbound-refresh'
    | 'rebind-on-refresh';
  /** Sink for the DPoP token-request observation; see the interface docstring. */
  dpopTokenRequestObs?: DpopTokenRequestObservation;
  /** Sink for refresh-grant observations; see DpopRefreshObservation. */
  dpopRefreshObs?: DpopRefreshObservation;
  /**
   * `expires_in` (seconds) on token responses, and the DPoP access-token
   * lifetime. Default 3600. The refresh posture sets this to 30 so a client
   * must refresh during the run.
   */
  accessTokenExpiresIn?: number;
  /**
   * When true, the token endpoint requires a DPoP nonce (RFC 9449 §8): a
   * proof-bearing request without the correct `nonce` claim is answered with
   * `400 use_dpop_nonce` + a `DPoP-Nonce` header, and the retry carrying the
   * nonce is accepted. Used to exercise the client's nonce handling.
   */
  dpopRequireNonce?: boolean;
  tokenVerifier?: MockTokenVerifier;
  onTokenRequest?: (requestData: {
    scope?: string;
    grantType: string;
    timestamp: string;
    body: Record<string, string>;
    authBaseUrl: string;
    tokenEndpoint: string;
    authorizationHeader?: string;
  }) =>
    | TokenRequestResult
    | TokenRequestError
    | Promise<TokenRequestResult | TokenRequestError>;
  onAuthorizationRequest?: (requestData: {
    clientId?: string;
    scope?: string;
    resource?: string;
    timestamp: string;
  }) => void;
  onRegistrationRequest?: (req: Request) => {
    clientId: string;
    clientSecret?: string;
    tokenEndpointAuthMethod?: string;
  };
}

export function createAuthServer(
  ctx: ScenarioContext,
  checks: ConformanceCheck[],
  getAuthBaseUrl: () => string,
  options: AuthServerOptions = {}
): express.Application {
  const {
    metadataPath = '/.well-known/oauth-authorization-server',
    isOpenIdConfiguration = false,
    loggingEnabled = true,
    routePrefix = '',
    scopesSupported,
    grantTypesSupported = ['authorization_code', 'refresh_token'],
    tokenEndpointAuthMethodsSupported = ['none'],
    tokenEndpointAuthSigningAlgValuesSupported,
    clientIdMetadataDocumentSupported,
    disableDynamicRegistration = false,
    codeChallengeMethodsSupported = ['S256'],
    issParameterSupported = true,
    issInRedirect = 'correct',
    metadataIssuer,
    dpopSigningAlgValuesSupported,
    dpopMisbehavior,
    dpopTokenRequestObs,
    dpopRefreshObs,
    dpopRequireNonce = false,
    accessTokenExpiresIn = 3600,
    tokenVerifier,
    onTokenRequest,
    onAuthorizationRequest,
    onRegistrationRequest
  } = options;

  // Track scopes from the most recent authorization request
  let lastAuthorizationScopes: string[] = [];
  // Track PKCE code_challenge for verification in token request
  let storedCodeChallenge: string | undefined;
  // RFC 9449 §10: dpop_jkt from the authorization request, if the client sent it.
  let storedDpopJkt: string | undefined;
  // Lazily-created issuer key for minting DPoP-bound JWT access tokens.
  let dpopIssuerKey: TokenIssuerKey | undefined;
  // DPoP behaviour is active only when the caller opts in (any DPoP option).
  const dpopEnabled =
    dpopSigningAlgValuesSupported !== undefined ||
    dpopMisbehavior !== undefined;

  // Records whether the client presented a valid DPoP proof at its
  // authorization_code token request (RFC 9449 §5) into the caller's observation
  // sink. Sticky-failure: FAILURE if ANY exchange lacked a valid proof, SUCCESS
  // only if every one had one — so a later proof-less exchange (e.g. a refresh
  // done as authorization_code) can't overwrite an earlier failure, nor vice
  // versa. Refresh grants are ignored entirely. The client scenario reads this
  // to emit sep-1932-client-token-request-proof unconditionally (FAILURE by
  // default when the client never reaches the token endpoint).
  const recordTokenRequestProof = (
    grantType: string,
    ok: boolean,
    detail?: string
  ): void => {
    if (grantType !== 'authorization_code' || !dpopTokenRequestObs) return;
    const valid = dpopTokenRequestObs.recorded
      ? dpopTokenRequestObs.validProof && ok
      : ok;
    dpopTokenRequestObs.recorded = true;
    dpopTokenRequestObs.validProof = valid;
    if (!valid && detail) dpopTokenRequestObs.error ??= detail;
  };

  const refreshTokens = new Map<string, StoredRefreshToken>();
  let issuedAuthorizationCode = false;

  const issueRefreshToken = (entry: StoredRefreshToken): string => {
    const refreshToken = randomBytes(32).toString('base64url');
    refreshTokens.set(refreshToken, entry);
    return refreshToken;
  };

  const markAuthorizationCodeIssued = (grantType: string): void => {
    if (grantType !== 'authorization_code') return;
    if (issuedAuthorizationCode && dpopTokenRequestObs) {
      dpopTokenRequestObs.reauthorizedInsteadOfRefreshing = true;
    }
    issuedAuthorizationCode = true;
  };

  const recordRefresh = (fields: {
    proofPresent: boolean;
    proofValid: boolean;
    jktMatched: boolean;
    error?: string;
  }): void => {
    if (!dpopRefreshObs) return;
    dpopRefreshObs.seen = true;
    dpopRefreshObs.proofPresent = fields.proofPresent;
    dpopRefreshObs.proofValid = fields.proofValid;
    dpopRefreshObs.jktMatched = fields.jktMatched;
    if (fields.error) dpopRefreshObs.error ??= fields.error;
  };

  const readDpopHeader = (
    req: Request
  ): { multiple: true } | { multiple: false; proof?: string } => {
    const proofHeader = req.headers['dpop'];
    const proofValue = Array.isArray(proofHeader)
      ? proofHeader.join(', ')
      : proofHeader;
    if (typeof proofValue === 'string' && proofValue.includes(',')) {
      return { multiple: true };
    }
    return { multiple: false, proof: proofValue };
  };

  const sendTokenResponse = (
    res: Response,
    grantType: string,
    body: {
      accessToken: string;
      tokenType: 'Bearer' | 'DPoP';
      scopes: string[];
      /** Exact `scope` string to echo. Omit to join `scopes` when non-empty. */
      scope?: string;
      omitScope?: boolean;
      jkt?: string;
      resource?: string;
    }
  ): void => {
    markAuthorizationCodeIssued(grantType);
    const refresh_token = issueRefreshToken({
      ...(body.jkt !== undefined ? { jkt: body.jkt } : {}),
      scopes: body.scopes,
      ...(body.resource !== undefined ? { resource: body.resource } : {}),
      issuedAt: Date.now()
    });
    const scope = body.omitScope
      ? undefined
      : body.scope !== undefined
        ? body.scope
        : body.scopes.length > 0
          ? body.scopes.join(' ')
          : undefined;
    res.json({
      access_token: body.accessToken,
      token_type: body.tokenType,
      expires_in: accessTokenExpiresIn,
      refresh_token,
      ...(scope !== undefined ? { scope } : {})
    });
  };

  const handleRefreshGrant = async (
    req: Request,
    res: Response
  ): Promise<void> => {
    const presented = req.body.refresh_token as string | undefined;
    const entry = presented ? refreshTokens.get(presented) : undefined;
    if (!presented || !entry) {
      res.status(400).json({
        error: 'invalid_grant',
        error_description: 'unknown or already-rotated refresh token'
      });
      return;
    }

    const tokenEndpointUrl = `${getAuthBaseUrl()}${routePrefix}/token`;
    const header = readDpopHeader(req);
    const resource = entry.resource;

    const rotateAndRespond = async (
      jkt: string | undefined,
      tokenType: 'Bearer' | 'DPoP'
    ): Promise<void> => {
      refreshTokens.delete(presented);
      if (tokenType === 'DPoP' && jkt) {
        if (!dpopIssuerKey) dpopIssuerKey = await generateIssuerKey();
        const accessToken = await mintDpopBoundToken({
          issuerKey: dpopIssuerKey,
          issuer: resolveIssuer(),
          audience: resource || 'urn:conformance-test-resource',
          jkt,
          expiresInSeconds: accessTokenExpiresIn,
          ...(entry.scopes.length > 0 ? { scope: entry.scopes.join(' ') } : {})
        });
        sendTokenResponse(res, 'refresh_token', {
          accessToken,
          tokenType: 'DPoP',
          scopes: entry.scopes,
          jkt,
          ...(resource !== undefined ? { resource } : {})
        });
        return;
      }
      const accessToken = `test-token-${Date.now()}`;
      if (tokenVerifier) tokenVerifier.registerToken(accessToken, entry.scopes);
      sendTokenResponse(res, 'refresh_token', {
        accessToken,
        tokenType: 'Bearer',
        scopes: entry.scopes,
        ...(resource !== undefined ? { resource } : {})
      });
    };

    if (!entry.jkt) {
      recordRefresh({
        proofPresent: !header.multiple && Boolean(header.proof),
        proofValid: false,
        jktMatched: false
      });
      await rotateAndRespond(undefined, 'Bearer');
      return;
    }

    if (dpopMisbehavior === 'unbound-refresh') {
      let presentedJkt: string | undefined;
      if (!header.multiple && header.proof) {
        const result = await validateDpopProofAtTokenEndpoint(
          header.proof,
          tokenEndpointUrl
        );
        recordRefresh({
          proofPresent: true,
          proofValid: result.ok,
          jktMatched: result.ok && result.jkt === entry.jkt,
          ...(result.ok ? {} : { error: result.error })
        });
        if (result.ok) presentedJkt = result.jkt;
      } else {
        recordRefresh({
          proofPresent: false,
          proofValid: false,
          jktMatched: false,
          error: header.multiple
            ? 'multiple DPoP proof headers'
            : 'no DPoP proof in the refresh request'
        });
      }
      if (presentedJkt) {
        await rotateAndRespond(presentedJkt, 'DPoP');
      } else {
        await rotateAndRespond(undefined, 'Bearer');
      }
      return;
    }

    if (header.multiple) {
      recordRefresh({
        proofPresent: true,
        proofValid: false,
        jktMatched: false,
        error: 'multiple DPoP proof headers'
      });
      res.status(400).json({
        error: 'invalid_dpop_proof',
        error_description: 'Multiple DPoP proof headers'
      });
      return;
    }
    if (!header.proof) {
      recordRefresh({
        proofPresent: false,
        proofValid: false,
        jktMatched: false,
        error: 'no DPoP proof in the refresh request'
      });
      res.status(400).json({
        error: 'invalid_grant',
        error_description: 'DPoP proof required for a bound refresh token'
      });
      return;
    }

    const result = await validateDpopProofAtTokenEndpoint(
      header.proof,
      tokenEndpointUrl
    );
    if (!result.ok) {
      recordRefresh({
        proofPresent: true,
        proofValid: false,
        jktMatched: false,
        error: result.error
      });
      res.status(400).json({
        error: 'invalid_dpop_proof',
        error_description: result.error
      });
      return;
    }

    const matched = result.jkt === entry.jkt;
    recordRefresh({
      proofPresent: true,
      proofValid: true,
      jktMatched: matched,
      ...(matched
        ? {}
        : {
            error: 'DPoP proof key does not match the refresh token binding'
          })
    });
    if (!matched && dpopMisbehavior !== 'rebind-on-refresh') {
      res.status(400).json({
        error: 'invalid_grant',
        error_description:
          'DPoP proof key does not match the refresh token binding'
      });
      return;
    }

    // RFC 9449 §8 applies to the refresh grant too. Do not record it on the
    // authorization_code nonce observation: honoring a challenge here must
    // not satisfy §8.
    if (dpopRequireNonce) {
      let proofNonce: unknown;
      try {
        proofNonce = jose.decodeJwt(header.proof).nonce;
      } catch {
        proofNonce = undefined;
      }
      if (proofNonce !== AS_DPOP_NONCE) {
        res.status(400).set('DPoP-Nonce', AS_DPOP_NONCE).json({
          error: 'use_dpop_nonce',
          error_description: 'Authorization server requires a DPoP nonce'
        });
        return;
      }
    }

    const bindJkt =
      dpopMisbehavior === 'rebind-on-refresh' ? result.jkt : entry.jkt;
    await rotateAndRespond(bindJkt, 'DPoP');
  };

  const authRoutes = {
    authorization_endpoint: `${routePrefix}/authorize`,
    token_endpoint: `${routePrefix}/token`,
    registration_endpoint: `${routePrefix}/register`
  };

  // The issuer identifier this AS publishes — used for both the metadata
  // `issuer` field and the RFC 9207 callback `iss` parameter, which per
  // RFC 9207 §2.4 must be identical under simple string comparison.
  const resolveIssuer = () =>
    typeof metadataIssuer === 'function'
      ? metadataIssuer()
      : (metadataIssuer ?? `${getAuthBaseUrl()}${routePrefix}`);

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  if (loggingEnabled) {
    app.use(
      createRequestLogger(checks, {
        incomingId: 'incoming-auth-request',
        outgoingId: 'outgoing-auth-response'
      })
    );
  }

  app.get(metadataPath, (req: Request, res: Response) => {
    checks.push({
      id: 'authorization-server-metadata',
      name: 'AuthorizationServerMetadata',
      description: 'Client requested authorization server metadata',
      status: 'SUCCESS',
      timestamp: new Date().toISOString(),
      specReferences: [
        SpecReferences.RFC_AUTH_SERVER_METADATA_REQUEST,
        SpecReferences.MCP_AUTH_DISCOVERY
      ],
      details: {
        url: req.url,
        path: req.path
      }
    });

    const metadata: any = {
      issuer: resolveIssuer(),
      authorization_endpoint: `${getAuthBaseUrl()}${authRoutes.authorization_endpoint}`,
      token_endpoint: `${getAuthBaseUrl()}${authRoutes.token_endpoint}`,
      ...(!disableDynamicRegistration && {
        registration_endpoint: `${getAuthBaseUrl()}${authRoutes.registration_endpoint}`
      }),
      response_types_supported: ['code'],
      grant_types_supported: grantTypesSupported,
      // PKCE support - null means omit from metadata (for negative testing)
      ...(codeChallengeMethodsSupported !== null && {
        code_challenge_methods_supported: codeChallengeMethodsSupported
      }),
      ...(issParameterSupported !== null && {
        authorization_response_iss_parameter_supported: issParameterSupported
      }),
      token_endpoint_auth_methods_supported: tokenEndpointAuthMethodsSupported,
      ...(tokenEndpointAuthSigningAlgValuesSupported && {
        token_endpoint_auth_signing_alg_values_supported:
          tokenEndpointAuthSigningAlgValuesSupported
      }),
      // DPoP AS-metadata support signal (SEP-1932 / RFC 9449 §5.1). Opt-in;
      // misbehaviour modes alter it: 'omit-alg-values' drops the field,
      // 'empty-alg-values' advertises an empty array, 'include-none' adds the
      // forbidden `none` alg. (dpop_bound_access_tokens is client-registration
      // metadata per RFC 9449 §5.2, so it is deliberately NOT advertised here.)
      ...(dpopMisbehavior !== 'omit-alg-values' &&
        dpopSigningAlgValuesSupported !== undefined && {
          dpop_signing_alg_values_supported:
            dpopMisbehavior === 'empty-alg-values'
              ? []
              : dpopMisbehavior === 'include-none'
                ? [...dpopSigningAlgValuesSupported, 'none']
                : dpopSigningAlgValuesSupported
        })
    };

    // Add scopes_supported if provided
    if (scopesSupported !== undefined) {
      metadata.scopes_supported = scopesSupported;
    }

    // Add client_id_metadata_document_supported if provided
    if (clientIdMetadataDocumentSupported !== undefined) {
      metadata.client_id_metadata_document_supported =
        clientIdMetadataDocumentSupported;
    }

    // Add OpenID Configuration specific fields
    if (isOpenIdConfiguration) {
      metadata.jwks_uri = `${getAuthBaseUrl()}/.well-known/jwks.json`;
      metadata.subject_types_supported = ['public'];
      metadata.id_token_signing_alg_values_supported = ['RS256'];
    }

    res.json(metadata);
  });

  app.get(authRoutes.authorization_endpoint, (req: Request, res: Response) => {
    const timestamp = new Date().toISOString();
    checks.push({
      id: 'authorization-request',
      name: 'AuthorizationRequest',
      description: 'Client made authorization request',
      status: 'SUCCESS',
      timestamp,
      specReferences: [SpecReferences.OAUTH_2_1_AUTHORIZATION_ENDPOINT],
      details: {
        query: req.query
      }
    });

    // PKCE: Store code_challenge for later verification
    const codeChallenge = req.query.code_challenge as string | undefined;
    const codeChallengeMethod = req.query.code_challenge_method as
      | string
      | undefined;
    storedCodeChallenge = codeChallenge;
    // RFC 9449 §10: capture dpop_jkt so the token endpoint can bind the
    // authorization code to the client's DPoP key.
    storedDpopJkt = req.query.dpop_jkt as string | undefined;

    // PKCE: Check code_challenge is present
    checks.push({
      id: 'pkce-code-challenge-sent',
      name: 'PKCE Code Challenge',
      description: codeChallenge
        ? 'Client sent code_challenge in authorization request'
        : 'Client MUST send code_challenge in authorization request',
      status: codeChallenge ? 'SUCCESS' : 'FAILURE',
      timestamp,
      specReferences: [SpecReferences.MCP_PKCE]
    });

    // PKCE: Check S256 method is used
    checks.push({
      id: 'pkce-s256-method-used',
      name: 'PKCE S256 Method',
      description:
        codeChallengeMethod === 'S256'
          ? 'Client used S256 code challenge method'
          : 'Client MUST use S256 code challenge method when technically capable',
      status: codeChallengeMethod === 'S256' ? 'SUCCESS' : 'FAILURE',
      timestamp,
      specReferences: [SpecReferences.MCP_PKCE],
      details: {
        method: codeChallengeMethod || 'not specified'
      }
    });

    // Track scopes from authorization request for token issuance
    const scopeParam = req.query.scope as string | undefined;
    lastAuthorizationScopes = scopeParam ? scopeParam.split(' ') : [];

    if (onAuthorizationRequest) {
      onAuthorizationRequest({
        clientId: req.query.client_id as string | undefined,
        scope: scopeParam,
        resource: req.query.resource as string | undefined,
        timestamp
      });
    }

    const redirectUri = req.query.redirect_uri as string;
    const state = req.query.state as string;
    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set('code', 'test-auth-code');
    if (state) {
      redirectUrl.searchParams.set('state', state);
    }

    // ISS: Include iss parameter in redirect if configured. The 'correct'
    // value must equal the metadata `issuer` exactly (RFC 9207 §2.4 simple
    // string comparison), so honor the same metadataIssuer override the
    // metadata document does.
    if (issInRedirect === 'correct') {
      redirectUrl.searchParams.set('iss', resolveIssuer());
    } else if (issInRedirect === 'wrong') {
      redirectUrl.searchParams.set('iss', 'https://evil.example.com');
    } else if (issInRedirect === 'normalized') {
      // Normalization-equivalent variant of the correct issuer: identical
      // after RFC 3986 scheme-based normalization (trailing slash on an
      // empty path) but different under simple string comparison.
      redirectUrl.searchParams.set('iss', `${resolveIssuer()}/`);
    }

    res.redirect(redirectUrl.toString());
  });

  app.post(authRoutes.token_endpoint, async (req: Request, res: Response) => {
    const timestamp = new Date().toISOString();
    const requestedScope = req.body.scope;
    const grantType = req.body.grant_type;

    checks.push({
      id: 'token-request',
      name: 'TokenRequest',
      description: 'Client requested access token',
      status: 'SUCCESS',
      timestamp,
      specReferences: [SpecReferences.OAUTH_2_1_TOKEN],
      details: {
        endpoint: '/token',
        grantType
      }
    });

    if (grantType === 'refresh_token') {
      await handleRefreshGrant(req, res);
      return;
    }

    // PKCE: Check code_verifier is present (only for authorization_code grant)
    const codeVerifier = req.body.code_verifier as string | undefined;
    if (grantType === 'authorization_code') {
      checks.push({
        id: 'pkce-code-verifier-sent',
        name: 'PKCE Code Verifier',
        description: codeVerifier
          ? 'Client sent code_verifier in token request'
          : 'Client MUST send code_verifier in token request',
        status: codeVerifier ? 'SUCCESS' : 'FAILURE',
        timestamp,
        specReferences: [SpecReferences.MCP_PKCE]
      });

      // PKCE: Validate code_verifier matches code_challenge (S256)
      // Fail if either is missing
      const computedChallenge =
        codeVerifier && storedCodeChallenge
          ? computeS256Challenge(codeVerifier)
          : undefined;
      const matches =
        computedChallenge !== undefined &&
        computedChallenge === storedCodeChallenge;

      let description: string;
      if (!storedCodeChallenge && !codeVerifier) {
        description =
          'Neither code_challenge nor code_verifier were sent - PKCE is required';
      } else if (!storedCodeChallenge) {
        description =
          'code_challenge was not sent in authorization request - PKCE is required';
      } else if (!codeVerifier) {
        description =
          'code_verifier was not sent in token request - PKCE is required';
      } else if (matches) {
        description = 'code_verifier correctly matches code_challenge (S256)';
      } else {
        description = 'code_verifier does not match code_challenge';
      }

      checks.push({
        id: 'pkce-verifier-matches-challenge',
        name: 'PKCE Verifier Validation',
        description,
        status: matches ? 'SUCCESS' : 'FAILURE',
        timestamp,
        specReferences: [SpecReferences.MCP_PKCE],
        details: {
          matches,
          storedChallenge: storedCodeChallenge || 'not sent',
          computedChallenge: computedChallenge || 'not computed'
        }
      });
    }

    // ---- DPoP token binding (SEP-1932 / RFC 9449) — opt-in ----
    if (dpopEnabled) {
      const proofHeader = req.headers['dpop'];
      const proofValue = Array.isArray(proofHeader)
        ? proofHeader.join(', ')
        : proofHeader;
      // RFC 9449 §4.2: at most one DPoP header field. Node collapses duplicate
      // request headers into one comma-joined value; a valid proof JWT contains
      // no comma, so a comma means more than one proof was sent.
      if (typeof proofValue === 'string' && proofValue.includes(',')) {
        recordTokenRequestProof(
          grantType,
          false,
          'multiple DPoP proof headers'
        );
        res.status(400).json({
          error: 'invalid_dpop_proof',
          error_description: 'Multiple DPoP proof headers'
        });
        return;
      }
      const proof = proofValue;
      const tokenEndpointUrl = `${getAuthBaseUrl()}${authRoutes.token_endpoint}`;
      const grantedScopes = requestedScope
        ? requestedScope.split(' ')
        : lastAuthorizationScopes;

      // No proof ⇒ DPoP is not being exercised here; fall through to a Bearer
      // token. (Requiring a proof is a per-client `dpop_bound_access_tokens`
      // registration policy — RFC 9449 §5.2 — not a global AS behaviour.) The
      // client-side check still records that the client failed to ask for a
      // bound token.
      if (proof) {
        const result = await validateDpopProofAtTokenEndpoint(
          proof,
          tokenEndpointUrl
        );
        if (!result.ok) {
          recordTokenRequestProof(grantType, false, result.error);
          res.status(400).json({
            error: 'invalid_dpop_proof',
            error_description: result.error
          });
          return;
        }
        // The proof itself is valid — record that now, BEFORE any nonce
        // challenge, so a client that is challenged but does not retry is not
        // mis-reported by token-request-proof as "never completed a token
        // request" (its proof was just verified). Sticky + gated on
        // authorization_code inside recordTokenRequestProof.
        recordTokenRequestProof(grantType, true);

        // RFC 9449 §10: if the authorization request carried dpop_jkt, the
        // token-request proof key MUST match it. RFC 9449 names no error
        // code, so invalid_grant by analogy with PKCE failure. Only
        // authorization_code grants count, same gating as
        // recordTokenRequestProof.
        if (grantType === 'authorization_code' && dpopTokenRequestObs) {
          dpopTokenRequestObs.dpopJktSent = storedDpopJkt;
          dpopTokenRequestObs.dpopJktMatched =
            storedDpopJkt !== undefined && storedDpopJkt === result.jkt;
        }
        if (
          grantType === 'authorization_code' &&
          storedDpopJkt !== undefined &&
          storedDpopJkt !== result.jkt
        ) {
          res.status(400).json({
            error: 'invalid_grant',
            error_description: 'dpop_jkt does not match the DPoP proof key'
          });
          return;
        }

        // RFC 9449 §8: require a server-provided nonce. A proof without the
        // correct nonce is challenged (400 use_dpop_nonce + DPoP-Nonce); the
        // client is expected to retry with it. The nonce observation is gated
        // on the authorization_code exchange, matching recordTokenRequestProof
        // (honoring a challenge on a refresh exchange must not satisfy §8).
        if (dpopRequireNonce) {
          let proofNonce: unknown;
          try {
            proofNonce = jose.decodeJwt(proof).nonce;
          } catch {
            proofNonce = undefined;
          }
          if (proofNonce !== AS_DPOP_NONCE) {
            if (grantType === 'authorization_code' && dpopTokenRequestObs)
              dpopTokenRequestObs.asNonceChallengeIssued = true;
            res.status(400).set('DPoP-Nonce', AS_DPOP_NONCE).json({
              error: 'use_dpop_nonce',
              error_description: 'Authorization server requires a DPoP nonce'
            });
            return;
          }
          if (grantType === 'authorization_code' && dpopTokenRequestObs)
            dpopTokenRequestObs.asNonceHonored = true;
        }

        if (dpopMisbehavior === 'unbound-token') {
          // Misbehaviour: ignore the binding and issue a plain Bearer token.
          // The proof was valid, so the refresh token stays bound to that key.
          const bearer = `test-token-${Date.now()}`;
          if (tokenVerifier) tokenVerifier.registerToken(bearer, grantedScopes);
          sendTokenResponse(res, grantType, {
            accessToken: bearer,
            tokenType: 'Bearer',
            scopes: grantedScopes,
            omitScope: true,
            jkt: result.jkt,
            ...((req.body.resource as string | undefined)
              ? { resource: req.body.resource as string }
              : {})
          });
          return;
        }

        if (!dpopIssuerKey) {
          dpopIssuerKey = await generateIssuerKey();
        }
        const resource = req.body.resource as string | undefined;
        const boundToken = await mintDpopBoundToken({
          issuerKey: dpopIssuerKey,
          issuer: resolveIssuer(),
          audience: resource || 'urn:conformance-test-resource',
          jkt: result.jkt,
          expiresInSeconds: accessTokenExpiresIn,
          ...(requestedScope && { scope: requestedScope })
        });
        sendTokenResponse(res, grantType, {
          accessToken: boundToken,
          tokenType: 'DPoP',
          scopes: grantedScopes,
          ...(requestedScope ? { scope: requestedScope } : { omitScope: true }),
          jkt: result.jkt,
          ...(resource ? { resource } : {})
        });
        return;
      }
      // dpopEnabled but the token request carried no DPoP proof.
      recordTokenRequestProof(
        grantType,
        false,
        'no DPoP proof in the token request'
      );
    }

    let token = `test-token-${Date.now()}`;
    let scopes: string[] = lastAuthorizationScopes;

    if (onTokenRequest) {
      const result = await onTokenRequest({
        scope: requestedScope,
        grantType,
        timestamp,
        body: req.body,
        authBaseUrl: getAuthBaseUrl(),
        tokenEndpoint: `${getAuthBaseUrl()}${authRoutes.token_endpoint}`,
        authorizationHeader: req.headers.authorization
      });

      // Check if result is an error
      if ('error' in result) {
        res.status(result.statusCode || 400).json({
          error: result.error,
          error_description: result.errorDescription
        });
        return;
      }

      token = result.token;
      scopes = result.scopes;
    }

    // Register token with verifier if provided
    if (tokenVerifier) {
      tokenVerifier.registerToken(token, scopes);
    }

    const resource = req.body.resource as string | undefined;
    sendTokenResponse(res, grantType, {
      accessToken: token,
      tokenType: 'Bearer',
      scopes,
      ...(resource ? { resource } : {})
    });
  });

  app.post(authRoutes.registration_endpoint, (req: Request, res: Response) => {
    let clientId = 'test-client-id';
    let clientSecret: string | undefined = 'test-client-secret';
    let tokenEndpointAuthMethod: string | undefined;

    if (onRegistrationRequest) {
      const result = onRegistrationRequest(req);
      clientId = result.clientId;
      clientSecret = result.clientSecret;
      tokenEndpointAuthMethod = result.tokenEndpointAuthMethod;
    }

    checks.push({
      id: 'client-registration',
      name: 'ClientRegistration',
      description: 'Client registered with authorization server',
      status: 'SUCCESS',
      timestamp: new Date().toISOString(),
      specReferences: [SpecReferences.MCP_DCR],
      details: {
        endpoint: '/register',
        clientName: req.body.client_name,
        ...(tokenEndpointAuthMethod && { tokenEndpointAuthMethod })
      }
    });

    // SEP-837: clients MUST specify an appropriate application_type during DCR.
    // The harness can't know the client's real class (native vs web), so this
    // checks presence + that the value is one of the two OIDC-defined values.
    // SEP-837 first appears in the draft spec (the same revision that
    // introduces the stateless lifecycle), so the check only exists for runs
    // targeting a version that includes it; at dated versions it is not
    // emitted at all.
    if (!isStatefulVersion(ctx.specVersion)) {
      const appType = req.body.application_type;
      const validAppType = appType === 'native' || appType === 'web';
      checks.push({
        id: 'sep-837-application-type-present',
        name: 'DCR application_type specified',
        description: validAppType
          ? `Client specified application_type "${appType}" during Dynamic Client Registration`
          : appType === undefined
            ? 'Client MUST specify an appropriate application_type during Dynamic Client Registration (SEP-837); field was omitted'
            : `Client MUST specify an appropriate application_type during Dynamic Client Registration (SEP-837); got "${appType}", expected "native" or "web"`,
        status: validAppType ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [SpecReferences.MCP_DCR],
        details: { application_type: appType ?? '(omitted)' }
      });
    }

    res.status(201).json({
      client_id: clientId,
      ...(clientSecret && { client_secret: clientSecret }),
      client_name: req.body.client_name || 'test-client',
      redirect_uris: req.body.redirect_uris || [],
      ...(tokenEndpointAuthMethod && {
        token_endpoint_auth_method: tokenEndpointAuthMethod
      })
    });
  });

  return app;
}
