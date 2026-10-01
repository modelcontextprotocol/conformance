/**
 * Groundwork for the Enterprise-Managed Authorization (EMA) conformance tests
 * (ISSUE-470). This module implements a self-contained **IdP Authorization
 * Server** that the test runner controls while simulating an MCP Client.
 *
 * The IdP AS provides the building blocks the runner needs to drive a Resource
 * Authorization Server through the ID-JAG flow:
 *   - an ES256 JWS key pair (with a helper to prove it round-trips),
 *   - creation and signing of an Identity Assertion JWT Authorization Grant
 *     (ID-JAG) plus verification of its signature and claims,
 *   - an HTTP server hosting the two endpoints the issue calls out — the
 *     authorization-server metadata endpoint (well-known URI) and the JWK Set
 *     endpoint (`jwks_uri`) — plus GET helpers to retrieve them.
 *
 * Spec references:
 *   - Enterprise-Managed Authorization
 *     https://github.com/modelcontextprotocol/ext-auth/blob/main/specification/stable/enterprise-managed-authorization.mdx
 *   - Identity Assertion JWT Authorization Grant (draft-04)
 *     https://www.ietf.org/archive/id/draft-ietf-oauth-identity-assertion-authz-grant-04.html
 *   - RFC 8414 (Authorization Server Metadata)
 */
import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import * as jose from 'jose';
import type { CryptoKey, JWK } from 'jose';
import { request } from 'undici';

/** JWS algorithm used for the IdP signing key and the ID-JAG. */
export const ID_JAG_ALG = 'ES256';

/** `typ` header of an ID-JAG (draft-ietf-oauth-identity-assertion-authz-grant §3.1). */
export const ID_JAG_TYP = 'oauth-id-jag+jwt';

/** OAuth 2.0 token type identifier for an issued ID-JAG. */
export const ID_JAG_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id-jag';

/** RFC 8693 token-exchange grant type used to request an ID-JAG from the IdP. */
export const TOKEN_EXCHANGE_GRANT_TYPE =
  'urn:ietf:params:oauth:grant-type:token-exchange';

/** RFC 8414 well-known suffix for OAuth authorization-server metadata. */
export const OAUTH_AS_WELL_KNOWN = '.well-known/oauth-authorization-server';

// ---------------------------------------------------------------------------
// Key pairs (JWS / ES256)
// ---------------------------------------------------------------------------

export interface IdPKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  /** Public key as a JWK, annotated with `kid`, `alg` and `use` for the JWK Set. */
  publicJwk: JWK;
  kid: string;
}

/**
 * Create an ES256 JWS key pair for the IdP. The public key is exported as a
 * JWK carrying the metadata (`kid`, `alg`, `use`) needed to publish it in a
 * JWK Set.
 */
export async function createIdPKeyPair(
  kid: string = 'idp-es256-1'
): Promise<IdPKeyPair> {
  const { publicKey, privateKey } = await jose.generateKeyPair(ID_JAG_ALG, {
    extractable: true
  });
  const publicJwk: JWK = {
    ...(await jose.exportJWK(publicKey)),
    kid,
    alg: ID_JAG_ALG,
    use: 'sig'
  };
  return { publicKey, privateKey, publicJwk, kid };
}

/**
 * Prove a key pair is internally consistent: sign a probe token with the
 * private key and verify it with the exported public JWK. Returns true only
 * when the round-trip succeeds. Used to test freshly generated key pairs.
 */
export async function verifyIdPKeyPair(keyPair: IdPKeyPair): Promise<boolean> {
  try {
    const probe = await new jose.SignJWT({ probe: true })
      .setProtectedHeader({ alg: ID_JAG_ALG, kid: keyPair.kid })
      .setIssuedAt()
      .sign(keyPair.privateKey);
    const publicKey = await jose.importJWK(keyPair.publicJwk, ID_JAG_ALG);
    await jose.jwtVerify(probe, publicKey, { algorithms: [ID_JAG_ALG] });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// ID-JAG (Identity Assertion JWT Authorization Grant)
// ---------------------------------------------------------------------------

export interface CreateIdJagInput {
  /** IdP issuer identifier (`iss`). */
  issuer: string;
  /** End-user subject identifier (`sub`). */
  subject: string;
  /** Resource AS issuer identifier (`aud`). */
  audience: string;
  /** MCP Server resource identifier (`resource`); MUST be set if present per EMA §4.3. */
  resource?: string;
  /** MCP Client's `client_id` at the Resource AS. */
  clientId?: string;
  /** Space-delimited scopes (`scope`). */
  scope?: string;
  /** End-user email (`email`). */
  email?: string;
  /** JWT id (`jti`); a random UUID is used when omitted. */
  jwtId?: string;
  /** jose duration string for `exp`; defaults to `5m`. Use a negative offset for expired tokens. */
  expiresIn?: string;
  /** Override `iat` (seconds since epoch). */
  issuedAt?: number;
  /** Extra claims merged before the reserved claims above are applied. */
  additionalClaims?: Record<string, unknown>;
}

/**
 * Create and sign an ID-JAG with the supplied private key. The token carries
 * the `oauth-id-jag+jwt` type header and the claims defined in
 * draft-ietf-oauth-identity-assertion-authz-grant §3.1.
 */
export async function createIdJag(
  privateKey: CryptoKey,
  kid: string,
  input: CreateIdJagInput
): Promise<string> {
  const {
    issuer,
    subject,
    audience,
    resource,
    clientId,
    scope,
    email,
    jwtId = crypto.randomUUID(),
    expiresIn = '5m',
    issuedAt,
    additionalClaims
  } = input;

  const payload: Record<string, unknown> = { ...(additionalClaims ?? {}) };
  if (resource !== undefined) payload.resource = resource;
  if (clientId !== undefined) payload.client_id = clientId;
  if (scope !== undefined) payload.scope = scope;
  if (email !== undefined) payload.email = email;

  let builder = new jose.SignJWT(payload)
    .setProtectedHeader({ alg: ID_JAG_ALG, typ: ID_JAG_TYP, kid })
    .setIssuer(issuer)
    .setSubject(subject)
    .setAudience(audience)
    .setExpirationTime(expiresIn)
    .setJti(jwtId);

  builder =
    issuedAt !== undefined
      ? builder.setIssuedAt(issuedAt)
      : builder.setIssuedAt();

  return builder.sign(privateKey);
}

export interface VerifyIdJagOptions {
  /** Require this `iss` value. */
  issuer?: string;
  /** Require this `aud` value. */
  audience?: string;
}

export interface VerifiedIdJag {
  header: jose.ProtectedHeaderParameters;
  payload: jose.JWTPayload;
}

/**
 * Verify an ID-JAG's signature against a public JWK and check that its type
 * header and claims are well-formed. Throws when the signature is invalid, the
 * `typ` header is wrong, or a required claim is missing.
 */
export async function verifyIdJag(
  idJag: string,
  publicJwk: JWK,
  options: VerifyIdJagOptions = {}
): Promise<VerifiedIdJag> {
  const publicKey = await jose.importJWK(publicJwk, ID_JAG_ALG);
  const { protectedHeader, payload } = await jose.jwtVerify(idJag, publicKey, {
    algorithms: [ID_JAG_ALG],
    typ: ID_JAG_TYP,
    issuer: options.issuer,
    audience: options.audience
  });

  for (const claim of ['sub', 'aud', 'iss', 'exp', 'iat', 'jti'] as const) {
    if (payload[claim] === undefined) {
      throw new Error(`ID-JAG is missing required claim "${claim}"`);
    }
  }

  return { header: protectedHeader, payload };
}

// ---------------------------------------------------------------------------
// IdP Authorization Server metadata + host
// ---------------------------------------------------------------------------

export interface IdPServerMetadata {
  issuer: string;
  token_endpoint: string;
  jwks_uri: string;
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  response_types_supported: string[];
  id_token_signing_alg_values_supported: string[];
}

export interface FetchedMetadata {
  statusCode: number;
  contentType?: string;
  body: IdPServerMetadata & Record<string, unknown>;
}

/**
 * Retrieve an IdP AS metadata document by HTTP GET on its well-known URI, as an
 * MCP Client / Resource AS would. Returns the status code, content type and the
 * parsed JSON body.
 */
export async function fetchIdPServerMetadata(
  issuer: string,
  wellKnownPath: string = OAUTH_AS_WELL_KNOWN
): Promise<FetchedMetadata> {
  const url = `${issuer.replace(/\/$/, '')}/${wellKnownPath}`;
  const response = await request(url, { method: 'GET' });
  const contentTypeHeader = response.headers['content-type'];
  const contentType = Array.isArray(contentTypeHeader)
    ? contentTypeHeader[0]
    : contentTypeHeader;
  const body = (await response.body.json()) as IdPServerMetadata &
    Record<string, unknown>;
  return { statusCode: response.statusCode, contentType, body };
}

export interface FetchedJwks {
  statusCode: number;
  keys: JWK[];
}

/** Retrieve a JWK Set by HTTP GET on its `jwks_uri`. */
export async function fetchJwks(jwksUri: string): Promise<FetchedJwks> {
  const response = await request(jwksUri, { method: 'GET' });
  const body = (await response.body.json()) as { keys?: JWK[] };
  return { statusCode: response.statusCode, keys: body.keys ?? [] };
}

export interface IdPAuthorizationServerOptions {
  /** Reuse an existing key pair; a fresh ES256 pair is generated otherwise. */
  keyPair?: IdPKeyPair;
  /** Well-known suffix for the metadata endpoint. Defaults to RFC 8414's. */
  wellKnownPath?: string;
  /**
   * Issuer identifier to advertise instead of the bound localhost address. Set
   * this to a stable, externally reachable URL when a real Resource AS must
   * fetch the IdP's metadata and jwks_uri (e.g. a tunnel/proxy that forwards to
   * {@link IdPAuthorizationServer.localUrl}). It flows into the metadata
   * `issuer`, `token_endpoint` and `jwks_uri`, and into the ID-JAG `iss`.
   *
   * When this names an explicit port on a loopback host (`http://localhost:PORT`
   * or `http://127.0.0.1:PORT`), {@link IdPAuthorizationServer.start} binds
   * directly to that port instead of an ephemeral one, so a locally-running
   * Resource AS can be preconfigured with a fixed, stable address without
   * needing a tunnel/proxy.
   */
  issuer?: string;
}

/**
 * A localhost IdP Authorization Server that hosts the two endpoints the test
 * runner needs: the authorization-server metadata endpoint (well-known URI) and
 * the JWK Set endpoint (`jwks_uri`). It also mints ID-JAGs signed with its own
 * key so the runner can present valid — or deliberately invalid — grants.
 */
export class IdPAuthorizationServer {
  private readonly keyPair: IdPKeyPair;
  private readonly wellKnownPath: string;
  private readonly issuerOverride?: string;
  private httpServer: Server | null = null;
  private baseUrl = '';

  private constructor(
    keyPair: IdPKeyPair,
    wellKnownPath: string,
    issuerOverride?: string
  ) {
    this.keyPair = keyPair;
    this.wellKnownPath = wellKnownPath;
    this.issuerOverride = issuerOverride;
  }

  static async create(
    options: IdPAuthorizationServerOptions = {}
  ): Promise<IdPAuthorizationServer> {
    const keyPair = options.keyPair ?? (await createIdPKeyPair());
    return new IdPAuthorizationServer(
      keyPair,
      options.wellKnownPath ?? OAUTH_AS_WELL_KNOWN,
      options.issuer?.replace(/\/$/, '')
    );
  }

  /**
   * Port named by a loopback issuer override (e.g. `http://localhost:9464`),
   * or undefined if the override is absent, non-loopback, or has no explicit
   * port — in which case {@link start} binds an ephemeral port instead.
   */
  private loopbackPort(): number | undefined {
    if (!this.issuerOverride) {
      return undefined;
    }
    let url: URL;
    try {
      url = new URL(this.issuerOverride);
    } catch {
      return undefined;
    }
    const isLoopback =
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '::1';
    return isLoopback && url.port ? Number(url.port) : undefined;
  }

  /** Start listening (on the loopback port named by the issuer override, if any, otherwise an ephemeral port) and return the issuer identifier. */
  async start(): Promise<string> {
    const app = express();

    app.get(`/${this.wellKnownPath}`, (_req: Request, res: Response) => {
      res.type('application/json').json(this.getMetadata());
    });

    app.get('/jwks', (_req: Request, res: Response) => {
      res.type('application/json').json({ keys: [this.keyPair.publicJwk] });
    });

    this.httpServer = app.listen(this.loopbackPort() ?? 0);
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once('listening', resolve);
      this.httpServer!.once('error', reject);
    });
    const address = this.httpServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('IdP AS failed to bind to a TCP port');
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
  }

  /** The actual bound localhost address; only valid after {@link start}. */
  get localUrl(): string {
    if (!this.baseUrl) {
      throw new Error('IdP AS has not been started');
    }
    return this.baseUrl;
  }

  /**
   * Issuer identifier: the configured override when set, otherwise the bound
   * localhost address (which requires {@link start}).
   */
  get issuer(): string {
    return this.issuerOverride ?? this.localUrl;
  }

  get keyPairRef(): IdPKeyPair {
    return this.keyPair;
  }

  get metadataUrl(): string {
    return `${this.issuer}/${this.wellKnownPath}`;
  }

  get jwksUrl(): string {
    return `${this.issuer}/jwks`;
  }

  get tokenEndpoint(): string {
    return `${this.issuer}/token`;
  }

  /** The metadata document served at the well-known URI. */
  getMetadata(): IdPServerMetadata {
    return {
      issuer: this.issuer,
      token_endpoint: this.tokenEndpoint,
      jwks_uri: this.jwksUrl,
      grant_types_supported: [TOKEN_EXCHANGE_GRANT_TYPE],
      token_endpoint_auth_methods_supported: ['client_secret_basic'],
      response_types_supported: ['code'],
      id_token_signing_alg_values_supported: [ID_JAG_ALG]
    };
  }

  /** Mint an ID-JAG signed with this IdP's private key. */
  async issueIdJag(
    input: Omit<CreateIdJagInput, 'issuer'> & { issuer?: string }
  ): Promise<string> {
    return createIdJag(this.keyPair.privateKey, this.keyPair.kid, {
      ...input,
      issuer: input.issuer ?? this.issuer
    });
  }

  /**
   * Mint an ID-JAG the same way {@link issueIdJag} does, except signed with a
   * freshly generated key that this IdP never adds to its own JWK Set (it is
   * not served at {@link jwksUrl}). Models an IdP that itself issues a token
   * whose signature a Resource AS cannot verify against the IdP's published
   * key — e.g. an unpropagated key rotation — for negative testing.
   */
  async issueIdJagWithUnpublishedKey(
    input: Omit<CreateIdJagInput, 'issuer'> & { issuer?: string }
  ): Promise<string> {
    const unpublishedKey = await createIdPKeyPair('idp-unpublished-es256');
    return createIdJag(unpublishedKey.privateKey, unpublishedKey.kid, {
      ...input,
      issuer: input.issuer ?? this.issuer
    });
  }
}
