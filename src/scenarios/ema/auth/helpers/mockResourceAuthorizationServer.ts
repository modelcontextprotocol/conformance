/**
 * Mock **Resource Authorization Server** for the Enterprise-Managed
 * Authorization (EMA) conformance tests (ISSUE-470). A real Resource AS can't
 * be stood up as a test target, so this module provides a spec-shaped stand-in
 * that the test runner drives while simulating an MCP Client.
 *
 * It implements the Resource-AS side of the Identity Assertion JWT
 * Authorization Grant (ID-JAG) flow:
 *   - hosts authorization-server metadata (well-known URI) advertising the
 *     `urn:ietf:params:oauth:grant-profile:id-jag` grant profile and the
 *     `jwt-bearer` grant type (Discovery, EMA §6),
 *   - exposes a token endpoint that accepts a `jwt-bearer` grant carrying an
 *     ID-JAG assertion, validates it against a configured set of trusted IdP
 *     Authorization Servers (fetching their `jwks_uri` to verify the
 *     signature), and
 *   - on success issues an access token audience-restricted to the MCP Server
 *     named by the ID-JAG `resource` claim (EMA §5.1).
 *
 * Spec references:
 *   - Enterprise-Managed Authorization
 *     https://github.com/modelcontextprotocol/ext-auth/blob/main/specification/stable/enterprise-managed-authorization.mdx
 *   - Identity Assertion JWT Authorization Grant (draft-04)
 *     https://www.ietf.org/archive/id/draft-ietf-oauth-identity-assertion-authz-grant-04.html
 *   - RFC 7523 (JWT Profile for OAuth 2.0 Authorization Grants)
 */
import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import * as jose from 'jose';
import type { JWK } from 'jose';
import { request } from 'undici';
import {
  ID_JAG_ALG,
  ID_JAG_TYP,
  OAUTH_AS_WELL_KNOWN,
  createIdPKeyPair,
  fetchIdPServerMetadata,
  fetchJwks,
  type IdPKeyPair
} from './provideIdPAuthorizationServer';
import type { ResourceAuthorizationServerUnderTest } from './resourceAuthorizationServerTarget';

/** RFC 7523 grant type the MCP Client uses to present an ID-JAG to the Resource AS. */
export const JWT_BEARER_GRANT_TYPE =
  'urn:ietf:params:oauth:grant-type:jwt-bearer';

/** Grant-profile identifier a Resource AS advertises to signal ID-JAG support (EMA §6). */
export const ID_JAG_GRANT_PROFILE =
  'urn:ietf:params:oauth:grant-profile:id-jag';

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// ID-JAG validation (Resource-AS processing rules)
// ---------------------------------------------------------------------------

/** Resolves the signing keys (JWK Set) published by a given IdP issuer. */
export type ResourceAsKeyResolver = (idpIssuer: string) => Promise<JWK[]>;

export interface ValidateIdJagOptions {
  /** This Resource AS's issuer identifier; the ID-JAG `aud` MUST match it. */
  resourceAsIssuer: string;
  /** IdP issuer identifiers this Resource AS trusts. */
  trustedIdpIssuers: string[];
  /**
   * MCP Server identifiers this Resource AS trusts. When non-empty, the ID-JAG
   * `resource` claim (the MCP Server the access token is minted for) MUST be
   * one of them. In ID-JAG the MCP Server is the `resource` claim — the JWT
   * `aud` is the Resource AS itself.
   */
  trustedMcpServers?: string[];
  /**
   * Whether the ID-JAG `resource` claim is mandatory. Defaults to true. The
   * `resource` claim is OPTIONAL in EMA §4.3, so set false to accept grants
   * without it (the issued access token is then not audience-restricted).
   */
  requireResourceClaim?: boolean;
  /**
   * Scopes this Resource AS recognises. When non-empty, every space-delimited
   * value in the ID-JAG `scope` claim MUST be one of them, else the grant is
   * rejected with `invalid_scope` (RFC 6749 §5.2).
   */
  registeredScopes?: string[];
  /** Fetches the signing keys for a trusted IdP issuer. */
  resolveIdpKeys: ResourceAsKeyResolver;
  /** Leeway for `exp`/`iat` in seconds. Defaults to 5. */
  clockToleranceSeconds?: number;
}

export interface IdJagValidationSuccess {
  ok: true;
  issuer: string;
  subject: string;
  /** MCP Server resource identifier the access token is restricted to, if present. */
  resource?: string;
  scope?: string;
  clientId?: string;
  payload: jose.JWTPayload;
}

export interface IdJagValidationFailure {
  ok: false;
  /** OAuth 2.0 token error code (RFC 6749 §5.2 / RFC 8707). */
  error: string;
  errorDescription: string;
}

export type IdJagValidationResult =
  | IdJagValidationSuccess
  | IdJagValidationFailure;

function validationFailure(
  error: string,
  errorDescription: string
): IdJagValidationFailure {
  return { ok: false, error, errorDescription };
}

/**
 * Validate an ID-JAG the way a Resource AS must (EMA §5.1 /
 * draft-ietf-oauth-identity-assertion-authz-grant §4.4.1):
 *   1. the assertion is a well-formed JWT typed `oauth-id-jag+jwt` signed with ES256,
 *   2. its `iss` names a trusted IdP,
 *   3. its signature verifies against that IdP's published keys,
 *   4. its `aud` equals this Resource AS's issuer identifier and it is unexpired,
 *   5. it carries a `resource` claim identifying the MCP Server.
 *
 * Returned as a discriminated result rather than thrown so the token endpoint
 * can map failures onto OAuth error responses. Exported so tests can exercise
 * the rules directly with a stub key resolver.
 */
export async function validateIdJagForResourceAs(
  assertion: string,
  options: ValidateIdJagOptions
): Promise<IdJagValidationResult> {
  let header: jose.ProtectedHeaderParameters;
  try {
    header = jose.decodeProtectedHeader(assertion);
  } catch {
    return validationFailure(
      'invalid_request',
      'Assertion is not a well-formed JWT'
    );
  }
  if (header.typ !== ID_JAG_TYP) {
    return validationFailure(
      'invalid_grant',
      `Assertion "typ" header must be "${ID_JAG_TYP}"`
    );
  }
  if (header.alg !== ID_JAG_ALG) {
    return validationFailure(
      'invalid_grant',
      `Assertion "alg" header must be "${ID_JAG_ALG}"`
    );
  }

  let unverified: jose.JWTPayload;
  try {
    unverified = jose.decodeJwt(assertion);
  } catch {
    return validationFailure(
      'invalid_request',
      'Assertion payload is not a valid JWT'
    );
  }
  const issuer =
    typeof unverified.iss === 'string' ? unverified.iss : undefined;
  if (!issuer) {
    return validationFailure(
      'invalid_grant',
      'Assertion is missing the "iss" claim'
    );
  }
  if (!options.trustedIdpIssuers.includes(issuer)) {
    return validationFailure(
      'invalid_grant',
      `Assertion issuer "${issuer}" is not a trusted IdP`
    );
  }

  let keys: JWK[];
  try {
    keys = await options.resolveIdpKeys(issuer);
  } catch (error) {
    return validationFailure(
      'invalid_grant',
      `Unable to resolve signing keys for issuer "${issuer}": ${toErrorMessage(error)}`
    );
  }
  if (keys.length === 0) {
    return validationFailure(
      'invalid_grant',
      `Issuer "${issuer}" published no signing keys`
    );
  }

  let payload: jose.JWTPayload;
  try {
    const jwks = jose.createLocalJWKSet({ keys });
    ({ payload } = await jose.jwtVerify(assertion, jwks, {
      algorithms: [ID_JAG_ALG],
      typ: ID_JAG_TYP,
      issuer,
      audience: options.resourceAsIssuer,
      clockTolerance: options.clockToleranceSeconds ?? 5
    }));
  } catch (error) {
    return validationFailure(
      'invalid_grant',
      `ID-JAG verification failed: ${toErrorMessage(error)}`
    );
  }

  for (const claim of ['sub', 'jti', 'exp', 'iat'] as const) {
    if (payload[claim] === undefined) {
      return validationFailure(
        'invalid_grant',
        `ID-JAG is missing required claim "${claim}"`
      );
    }
  }

  const resource =
    typeof payload.resource === 'string' ? payload.resource : undefined;
  if (!resource) {
    if (options.requireResourceClaim ?? true) {
      return validationFailure(
        'invalid_target',
        'ID-JAG is missing the "resource" claim identifying the MCP Server'
      );
    }
  } else if (
    options.trustedMcpServers &&
    options.trustedMcpServers.length > 0 &&
    !options.trustedMcpServers.includes(resource)
  ) {
    return validationFailure(
      'invalid_target',
      `MCP Server "${resource}" is not a trusted MCP Server`
    );
  }

  const scope = typeof payload.scope === 'string' ? payload.scope : undefined;
  if (
    options.registeredScopes &&
    options.registeredScopes.length > 0 &&
    scope !== undefined
  ) {
    const unknownScopes = scope
      .split(' ')
      .filter((s) => s.length > 0 && !options.registeredScopes!.includes(s));
    if (unknownScopes.length > 0) {
      return validationFailure(
        'invalid_scope',
        `Requested scope(s) not recognised: ${unknownScopes.join(' ')}`
      );
    }
  }

  return {
    ok: true,
    issuer,
    subject: payload.sub as string,
    resource,
    scope,
    clientId:
      typeof payload.client_id === 'string' ? payload.client_id : undefined,
    payload
  };
}

// ---------------------------------------------------------------------------
// Resource AS metadata + host
// ---------------------------------------------------------------------------

export interface ResourceServerMetadata {
  issuer: string;
  token_endpoint: string;
  introspection_endpoint: string;
  jwks_uri: string;
  grant_types_supported: string[];
  authorization_grant_profiles_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  introspection_endpoint_auth_methods_supported: string[];
}

export interface MockResourceAuthorizationServerOptions {
  /** IdP issuer identifiers this Resource AS trusts. */
  trustedIdpIssuers?: string[];
  /** MCP Server URLs this Resource AS trusts (matched against the ID-JAG `resource`). */
  trustedMcpServers?: string[];
  /** Whether the ID-JAG `resource` claim is mandatory. Defaults to true. */
  requireResourceClaim?: boolean;
  /** Reuse an existing ES256 key pair for signing access tokens. */
  signingKeyPair?: IdPKeyPair;
  /** Well-known suffix for the metadata endpoint. Defaults to RFC 8414's. */
  wellKnownPath?: string;
  /** Access-token lifetime in seconds. Defaults to 3600. */
  accessTokenLifetimeSeconds?: number;
  /** Leeway for ID-JAG `exp`/`iat` in seconds. Defaults to 5. */
  clockToleranceSeconds?: number;
  /**
   * Rewrite the metadata document served at the well-known URI. Receives the
   * default (conformant) metadata and returns the object to serve — negative
   * tests use this to drop or malform fields and produce a Resource AS that
   * fails discovery.
   */
  metadataTransform?: (
    defaults: ResourceServerMetadata
  ) => Record<string, unknown>;
}

export interface AccessTokenRequestParams {
  assertion: string;
  clientId?: string;
  clientSecret?: string;
  resource?: string;
  scope?: string;
  /** Override the grant type (for negative tests). Defaults to `jwt-bearer`. */
  grantType?: string;
  /**
   * How to present client credentials. Defaults to `client_secret_basic` when a
   * `clientSecret` is supplied.
   */
  clientAuthMethod?: 'client_secret_basic' | 'client_secret_post';
}

export interface TokenEndpointResponse {
  statusCode: number;
  contentType?: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

/**
 * POST a `jwt-bearer` grant carrying an ID-JAG assertion to a Resource AS token
 * endpoint, as an MCP Client would. Returns the status code and parsed body.
 */
export async function requestAccessTokenWithIdJag(
  tokenEndpoint: string,
  params: AccessTokenRequestParams
): Promise<TokenEndpointResponse> {
  const form = new URLSearchParams();
  form.set('grant_type', params.grantType ?? JWT_BEARER_GRANT_TYPE);
  form.set('assertion', params.assertion);
  if (params.resource) form.set('resource', params.resource);
  if (params.scope) form.set('scope', params.scope);

  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded'
  };

  const useBasicAuth =
    params.clientId !== undefined &&
    params.clientSecret !== undefined &&
    params.clientAuthMethod !== 'client_secret_post';

  if (useBasicAuth) {
    const credentials = Buffer.from(
      `${params.clientId}:${params.clientSecret}`
    ).toString('base64');
    headers['authorization'] = `Basic ${credentials}`;
  } else {
    if (params.clientId) form.set('client_id', params.clientId);
    if (params.clientSecret) form.set('client_secret', params.clientSecret);
  }

  const response = await request(tokenEndpoint, {
    method: 'POST',
    headers,
    body: form.toString()
  });
  const contentTypeHeader = response.headers['content-type'];
  const contentType = Array.isArray(contentTypeHeader)
    ? contentTypeHeader[0]
    : contentTypeHeader;
  const body = (await response.body.json()) as Record<string, unknown>;
  return {
    statusCode: response.statusCode,
    contentType,
    headers: response.headers,
    body
  };
}

export interface IntrospectionRequestParams {
  token: string;
  /** RFC 7662 `token_type_hint` (e.g. `access_token`). */
  tokenTypeHint?: string;
  clientId?: string;
  clientSecret?: string;
  /** Defaults to `client_secret_basic` when a `clientSecret` is provided. */
  clientAuthMethod?: 'client_secret_basic' | 'client_secret_post';
}

export interface IntrospectionEndpointResponse {
  statusCode: number;
  contentType?: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

/**
 * POST a token to a Resource AS introspection endpoint (RFC 7662 §2.1) and
 * return the status code and parsed introspection response.
 */
export async function introspectToken(
  introspectionEndpoint: string,
  params: IntrospectionRequestParams
): Promise<IntrospectionEndpointResponse> {
  const form = new URLSearchParams();
  form.set('token', params.token);
  if (params.tokenTypeHint) form.set('token_type_hint', params.tokenTypeHint);

  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded'
  };

  const useBasicAuth =
    params.clientId !== undefined &&
    params.clientSecret !== undefined &&
    params.clientAuthMethod !== 'client_secret_post';

  if (useBasicAuth) {
    const credentials = Buffer.from(
      `${params.clientId}:${params.clientSecret}`
    ).toString('base64');
    headers['authorization'] = `Basic ${credentials}`;
  } else {
    if (params.clientId) form.set('client_id', params.clientId);
    if (params.clientSecret) form.set('client_secret', params.clientSecret);
  }

  const response = await request(introspectionEndpoint, {
    method: 'POST',
    headers,
    body: form.toString()
  });
  const contentTypeHeader = response.headers['content-type'];
  const contentType = Array.isArray(contentTypeHeader)
    ? contentTypeHeader[0]
    : contentTypeHeader;
  const body = (await response.body.json()) as Record<string, unknown>;
  return {
    statusCode: response.statusCode,
    contentType,
    headers: response.headers,
    body
  };
}

/**
 * A localhost Resource Authorization Server that stands in for a real one. It
 * hosts its metadata and token endpoints, validates presented ID-JAGs against
 * its trusted IdPs, and issues audience-restricted access tokens.
 */
export class MockResourceAuthorizationServer implements ResourceAuthorizationServerUnderTest {
  private readonly signingKey: IdPKeyPair;
  private readonly wellKnownPath: string;
  private readonly accessTokenLifetimeSeconds: number;
  private readonly clockToleranceSeconds: number;
  private readonly trustedIdpIssuers: string[];
  private readonly trustedMcpServers: Set<string>;
  private readonly requireResourceClaim: boolean;
  private readonly clients = new Map<string, string>();
  private readonly users = new Map<string, string>();
  private readonly idpSubjectLinks = new Map<string, string>();
  private readonly scopes = new Set<string>();
  private readonly metadataTransform?: (
    defaults: ResourceServerMetadata
  ) => Record<string, unknown>;
  private readonly jwksCache = new Map<string, JWK[]>();
  private httpServer: Server | null = null;
  private baseUrl = '';

  private constructor(
    signingKey: IdPKeyPair,
    trustedIdpIssuers: string[],
    wellKnownPath: string,
    accessTokenLifetimeSeconds: number,
    clockToleranceSeconds: number,
    trustedMcpServers: string[],
    requireResourceClaim: boolean,
    metadataTransform?: (
      defaults: ResourceServerMetadata
    ) => Record<string, unknown>
  ) {
    this.signingKey = signingKey;
    this.trustedIdpIssuers = trustedIdpIssuers;
    this.wellKnownPath = wellKnownPath;
    this.accessTokenLifetimeSeconds = accessTokenLifetimeSeconds;
    this.clockToleranceSeconds = clockToleranceSeconds;
    this.trustedMcpServers = new Set(trustedMcpServers);
    this.requireResourceClaim = requireResourceClaim;
    this.metadataTransform = metadataTransform;
  }

  static async create(
    options: MockResourceAuthorizationServerOptions = {}
  ): Promise<MockResourceAuthorizationServer> {
    const signingKey =
      options.signingKeyPair ?? (await createIdPKeyPair('resource-as-es256-1'));
    return new MockResourceAuthorizationServer(
      signingKey,
      [...(options.trustedIdpIssuers ?? [])],
      options.wellKnownPath ?? OAUTH_AS_WELL_KNOWN,
      options.accessTokenLifetimeSeconds ?? 3600,
      options.clockToleranceSeconds ?? 5,
      [...(options.trustedMcpServers ?? [])],
      options.requireResourceClaim ?? true,
      options.metadataTransform
    );
  }

  /** Add an IdP issuer to the trust list (issuer URLs are known only after the IdP starts). */
  addTrustedIdp(issuer: string): void {
    if (!this.trustedIdpIssuers.includes(issuer)) {
      this.trustedIdpIssuers.push(issuer);
    }
  }

  /** Register a trusted IdP AS by issuer URL (alias of {@link addTrustedIdp}). */
  registerTrustedIdp(issuer: string): void {
    this.addTrustedIdp(issuer);
  }

  /**
   * Register a trusted MCP Server by URL. Once at least one is registered, the
   * Resource AS only accepts ID-JAGs whose `resource` (the MCP Server the
   * access token is minted for) is one of the registered servers.
   */
  registerTrustedMcpServer(url: string): void {
    this.trustedMcpServers.add(url);
  }

  /**
   * Register a client for `client_secret_basic` authentication and return its
   * secret. Once any client is registered, the token endpoint requires a valid
   * client_secret_basic credential.
   */
  registerClient(clientId: string, clientSecret?: string): string {
    const secret = clientSecret ?? `secret_${crypto.randomUUID()}`;
    this.clients.set(clientId, secret);
    return secret;
  }

  /** Register a user and return its id, registered with this Resource AS. */
  registerUser(username: string, userId?: string): string {
    const id = userId ?? `user_${crypto.randomUUID()}`;
    this.users.set(username, id);
    return id;
  }

  /**
   * Link an ID-JAG `sub` (a user id registered with a trusted IdP) to a user id
   * registered with this Resource AS. When a validated ID-JAG's `sub` matches a
   * linked idpSub, the issued access token's `sub` claim uses the linked
   * Resource AS user id rather than echoing the ID-JAG value verbatim.
   */
  linkIdpSubject(idpSub: string, resourceAsUserId: string): void {
    this.idpSubjectLinks.set(idpSub, resourceAsUserId);
  }

  /** Register a scope the Resource AS recognises. */
  registerScope(scope: string): void {
    this.scopes.add(scope);
  }

  /** The secret registered for a client id, if any. */
  getClientSecret(clientId: string): string | undefined {
    return this.clients.get(clientId);
  }

  /** The user id registered for a username, if any. */
  getUserId(username: string): string | undefined {
    return this.users.get(username);
  }

  getRegisteredScopes(): string[] {
    return [...this.scopes];
  }

  getTrustedIdpIssuers(): string[] {
    return [...this.trustedIdpIssuers];
  }

  getTrustedMcpServers(): string[] {
    return [...this.trustedMcpServers];
  }

  async start(): Promise<string> {
    const app = express();
    app.use(express.urlencoded({ extended: false }));

    app.get(`/${this.wellKnownPath}`, (_req: Request, res: Response) => {
      res.type('application/json').json(this.getServedMetadata());
    });

    app.get('/jwks', (_req: Request, res: Response) => {
      res.type('application/json').json({ keys: [this.signingKey.publicJwk] });
    });

    app.post('/token', (req: Request, res: Response) => {
      void this.handleTokenRequest(req, res);
    });

    app.post('/introspect', (req: Request, res: Response) => {
      void this.handleIntrospectionRequest(req, res);
    });

    this.httpServer = app.listen(0);
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once('listening', resolve);
      this.httpServer!.once('error', reject);
    });
    const address = this.httpServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Resource AS failed to bind to a TCP port');
    }
    this.baseUrl = `http://localhost:${address.port}`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    if (this.httpServer) {
      const server = this.httpServer;
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
      this.httpServer = null;
    }
    this.baseUrl = '';
    this.jwksCache.clear();
  }

  get issuer(): string {
    if (!this.baseUrl) {
      throw new Error('Resource AS has not been started');
    }
    return this.baseUrl;
  }

  get metadataUrl(): string {
    return `${this.issuer}/${this.wellKnownPath}`;
  }

  get tokenEndpoint(): string {
    return `${this.issuer}/token`;
  }

  get introspectionEndpoint(): string {
    return `${this.issuer}/introspect`;
  }

  get jwksUrl(): string {
    return `${this.issuer}/jwks`;
  }

  getMetadata(): ResourceServerMetadata {
    return {
      issuer: this.issuer,
      token_endpoint: this.tokenEndpoint,
      introspection_endpoint: this.introspectionEndpoint,
      jwks_uri: this.jwksUrl,
      grant_types_supported: [JWT_BEARER_GRANT_TYPE],
      authorization_grant_profiles_supported: [ID_JAG_GRANT_PROFILE],
      token_endpoint_auth_methods_supported: [
        'client_secret_basic',
        'client_secret_post',
        'none'
      ],
      introspection_endpoint_auth_methods_supported: [
        'client_secret_basic',
        'client_secret_post'
      ]
    };
  }

  /** The metadata document actually served, after any configured transform. */
  getServedMetadata(): Record<string, unknown> {
    const defaults = this.getMetadata();
    return this.metadataTransform
      ? this.metadataTransform(defaults)
      : { ...defaults };
  }

  /** Verify an access token this Resource AS issued (for test introspection). */
  async verifyAccessToken(
    token: string,
    expectedAudience?: string
  ): Promise<jose.JWTPayload> {
    const key = await jose.importJWK(this.signingKey.publicJwk, ID_JAG_ALG);
    const { payload } = await jose.jwtVerify(token, key, {
      algorithms: [ID_JAG_ALG],
      issuer: this.issuer,
      audience: expectedAudience
    });
    return payload;
  }

  /**
   * Introspect an access token this Resource AS issued (RFC 7662 §2.2). Returns
   * `{ active: true, ... }` with the token's claims when it verifies and is
   * unexpired, otherwise `{ active: false }`.
   */
  async introspect(token: string): Promise<Record<string, unknown>> {
    let payload: jose.JWTPayload;
    try {
      const key = await jose.importJWK(this.signingKey.publicJwk, ID_JAG_ALG);
      ({ payload } = await jose.jwtVerify(token, key, {
        algorithms: [ID_JAG_ALG],
        issuer: this.issuer,
        clockTolerance: this.clockToleranceSeconds
      }));
    } catch {
      return { active: false };
    }

    const response: Record<string, unknown> = {
      active: true,
      token_type: 'Bearer'
    };
    if (typeof payload.scope === 'string') response.scope = payload.scope;
    if (typeof payload.client_id === 'string') {
      response.client_id = payload.client_id;
    }
    if (typeof payload.sub === 'string') {
      response.sub = payload.sub;
      const username = this.usernameForUserId(payload.sub);
      if (username) response.username = username;
    }
    if (payload.aud !== undefined) response.aud = payload.aud;
    if (payload.iss !== undefined) response.iss = payload.iss;
    if (payload.exp !== undefined) response.exp = payload.exp;
    if (payload.iat !== undefined) response.iat = payload.iat;
    if (payload.jti !== undefined) response.jti = payload.jti;
    return response;
  }

  private usernameForUserId(userId: string): string | undefined {
    for (const [username, id] of this.users) {
      if (id === userId) return username;
    }
    return undefined;
  }

  /** Resolve a trusted IdP's signing keys via its metadata `jwks_uri`, cached per issuer. */
  private resolveIdpKeys: ResourceAsKeyResolver = async (idpIssuer) => {
    const cached = this.jwksCache.get(idpIssuer);
    if (cached) {
      return cached;
    }
    const metadata = await fetchIdPServerMetadata(idpIssuer);
    const jwksUri = metadata.body.jwks_uri;
    if (!jwksUri || typeof jwksUri !== 'string') {
      throw new Error(`IdP metadata for "${idpIssuer}" has no jwks_uri`);
    }
    const { keys } = await fetchJwks(jwksUri);
    this.jwksCache.set(idpIssuer, keys);
    return keys;
  };

  /**
   * Authenticate the client via `client_secret_post` or `client_secret_basic`.
   * When no clients are registered, authentication is skipped (open token
   * endpoint). Returns the authenticated client id on success.
   */
  private authenticateClient(
    req: Request
  ):
    | { ok: true; clientId?: string }
    | { ok: false; error: string; errorDescription: string } {
    if (this.clients.size === 0) {
      return { ok: true };
    }
    // client_secret_post: credentials in the form body (OpenID Connect Core §9).
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (
      typeof body.client_id === 'string' ||
      typeof body.client_secret === 'string'
    ) {
      const clientId = typeof body.client_id === 'string' ? body.client_id : '';
      const clientSecret =
        typeof body.client_secret === 'string' ? body.client_secret : '';
      const expected = this.clients.get(clientId);
      if (expected === undefined || expected !== clientSecret) {
        return {
          ok: false,
          error: 'invalid_client',
          errorDescription: 'Unknown client or invalid client secret'
        };
      }
      return { ok: true, clientId };
    }
    // client_secret_basic: credentials in the Authorization header (RFC 6749 §2.3.1).
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Basic ')) {
      return {
        ok: false,
        error: 'invalid_client',
        errorDescription:
          'client_secret_post or client_secret_basic authentication is required'
      };
    }
    const decoded = Buffer.from(
      header.slice('Basic '.length),
      'base64'
    ).toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) {
      return {
        ok: false,
        error: 'invalid_client',
        errorDescription: 'Malformed Basic authorization header'
      };
    }
    const clientId = decoded.slice(0, separator);
    const clientSecret = decoded.slice(separator + 1);
    const expected = this.clients.get(clientId);
    if (expected === undefined || expected !== clientSecret) {
      return {
        ok: false,
        error: 'invalid_client',
        errorDescription: 'Unknown client or invalid client secret'
      };
    }
    return { ok: true, clientId };
  }

  private async handleTokenRequest(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const grantType = body.grant_type;
    if (grantType !== JWT_BEARER_GRANT_TYPE) {
      res
        .status(400)
        .set('Cache-Control', 'no-store')
        .json({
          error: 'unsupported_grant_type',
          error_description: `Only "${JWT_BEARER_GRANT_TYPE}" is supported`
        });
      return;
    }

    const auth = this.authenticateClient(req);
    if (!auth.ok) {
      res.status(401).set('Cache-Control', 'no-store').json({
        error: auth.error,
        error_description: auth.errorDescription
      });
      return;
    }

    const assertion = body.assertion;
    if (typeof assertion !== 'string' || assertion.length === 0) {
      res.status(400).set('Cache-Control', 'no-store').json({
        error: 'invalid_request',
        error_description: 'Missing "assertion" parameter'
      });
      return;
    }

    const result = await validateIdJagForResourceAs(assertion, {
      resourceAsIssuer: this.issuer,
      trustedIdpIssuers: this.trustedIdpIssuers,
      trustedMcpServers: [...this.trustedMcpServers],
      requireResourceClaim: this.requireResourceClaim,
      registeredScopes: [...this.scopes],
      resolveIdpKeys: this.resolveIdpKeys,
      clockToleranceSeconds: this.clockToleranceSeconds
    });

    if (!result.ok) {
      res.status(400).set('Cache-Control', 'no-store').json({
        error: result.error,
        error_description: result.errorDescription
      });
      return;
    }

    const clientId =
      auth.clientId ??
      (typeof body.client_id === 'string' ? body.client_id : result.clientId);
    const accessToken = await this.issueAccessToken(result, clientId);

    res
      .status(200)
      .set('Cache-Control', 'no-store')
      .json({
        token_type: 'Bearer',
        access_token: accessToken,
        expires_in: this.accessTokenLifetimeSeconds,
        ...(result.scope ? { scope: result.scope } : {})
      });
  }

  /** RFC 7662 introspection endpoint: authenticate the caller, then introspect. */
  private async handleIntrospectionRequest(
    req: Request,
    res: Response
  ): Promise<void> {
    const auth = this.authenticateClient(req);
    if (!auth.ok) {
      res.status(401).set('Cache-Control', 'no-store').json({
        error: auth.error,
        error_description: auth.errorDescription
      });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = body.token;
    if (typeof token !== 'string' || token.length === 0) {
      res.status(400).set('Cache-Control', 'no-store').json({
        error: 'invalid_request',
        error_description: 'Missing "token" parameter'
      });
      return;
    }

    const introspection = await this.introspect(token);
    res.status(200).set('Cache-Control', 'no-store').json(introspection);
  }

  /** Mint an access token audience-restricted to the ID-JAG `resource` (EMA §5.1). */
  private async issueAccessToken(
    result: IdJagValidationSuccess,
    clientId?: string
  ): Promise<string> {
    const claims: Record<string, unknown> = {};
    if (result.scope !== undefined) claims.scope = result.scope;
    if (clientId !== undefined) claims.client_id = clientId;

    // Map the ID-JAG's IdP-registered subject to this Resource AS's own user
    // id, if linked; otherwise echo the ID-JAG subject verbatim.
    const subject = this.idpSubjectLinks.get(result.subject) ?? result.subject;

    let builder = new jose.SignJWT(claims)
      .setProtectedHeader({
        alg: ID_JAG_ALG,
        typ: 'at+jwt',
        kid: this.signingKey.kid
      })
      .setIssuer(this.issuer)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime(`${this.accessTokenLifetimeSeconds}s`)
      .setJti(crypto.randomUUID());

    // Only audience-restrict when the grant identified an MCP Server.
    if (result.resource !== undefined) {
      builder = builder.setAudience(result.resource);
    }

    return builder.sign(this.signingKey.privateKey);
  }
}
