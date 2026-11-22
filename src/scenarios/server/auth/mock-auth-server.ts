/**
 * Local Mock Authorization Server for server-side token validation tests.
 *
 * Serves OAuth 2.0 Authorization Server Metadata (RFC 8414), a JWKS endpoint
 * (RFC 7517), and an RFC 7662 Token Introspection endpoint so MCP servers under
 * test can validate signed JWT access tokens either locally via JWKS or via
 * introspection.
 */

import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import * as jose from 'jose';
import type { CryptoKey, JWK } from 'jose';

const DEFAULT_ALG = 'RS256';
const DEFAULT_KID = 'conformance-mock-as-key-1';

export interface MockTokenAuthServerOptions {
  /** TCP port to listen on. Pass `0` for an ephemeral OS-assigned port. */
  port?: number;
  /** Bind address for the HTTP socket. Defaults to `'127.0.0.1'`. */
  host?: string;
  /**
   * Explicit `issuer` URL advertised in metadata and placed in JWT `iss`.
   * Defaults to `http://<host>:<boundPort>`.
   */
  issuerUrl?: string;
  /** JWS signing algorithm. Defaults to `'RS256'`. */
  alg?: string;
  /** Key ID (`kid`) published in JWKS and JWT headers. */
  kid?: string;
}

export interface MintAccessTokenOptions {
  /** `aud` claim value (single URI or array). Ignored when `omitAud` is true. */
  audience?: string | string[];
  /** Omit the `aud` claim entirely. */
  omitAud?: boolean;
  /** Issue an already-expired token (`exp` 5 minutes in the past). */
  expired?: boolean;
  /** Token lifetime in seconds for non-expired tokens. Defaults to 3600. */
  expiresInSeconds?: number;
  /** `sub` claim. Defaults to `'conformance-test-subject'`. */
  subject?: string;
  /** `client_id` claim. Defaults to `'conformance-test-client'`. */
  clientId?: string;
  /** `scope` claim. Defaults to `'mcp:tools'`. */
  scope?: string;
  /** Override `iat` (epoch seconds). Defaults to current time. */
  iat?: number;
}

export interface MockAuthServerCounters {
  metadataRequests: number;
  jwksRequests: number;
  introspectionRequests: number;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function extractIntrospectionToken(
  rawBody: string,
  contentType: string | undefined
): string | undefined {
  if (contentType?.toLowerCase().includes('application/json')) {
    try {
      const parsed = JSON.parse(rawBody) as { token?: unknown };
      return typeof parsed.token === 'string' ? parsed.token : undefined;
    } catch {
      return undefined;
    }
  }
  const params = new URLSearchParams(rawBody);
  return params.get('token') ?? undefined;
}

export class MockTokenAuthServer {
  private readonly requestedPort: number;
  private readonly host: string;
  private readonly explicitIssuerUrl?: string;
  private readonly alg: string;
  private readonly kid: string;

  private server: http.Server | null = null;
  private privateKey: CryptoKey | null = null;
  private publicKey: CryptoKey | null = null;
  private publicJwk: JWK | null = null;
  private boundPort: number | null = null;
  private resolvedIssuerUrl: string | null = null;

  private counters: MockAuthServerCounters = {
    metadataRequests: 0,
    jwksRequests: 0,
    introspectionRequests: 0
  };

  constructor(options: MockTokenAuthServerOptions = {}) {
    this.requestedPort = options.port ?? 0;
    this.host = options.host ?? '127.0.0.1';
    this.explicitIssuerUrl = options.issuerUrl?.replace(/\/+$/, '');
    this.alg = options.alg ?? DEFAULT_ALG;
    this.kid = options.kid ?? DEFAULT_KID;
  }

  /** Base issuer URL (available after `start()`). */
  get issuerUrl(): string {
    if (!this.resolvedIssuerUrl) {
      throw new Error('MockTokenAuthServer has not been started');
    }
    return this.resolvedIssuerUrl;
  }

  /** Bound TCP port (available after `start()`). */
  get port(): number {
    if (this.boundPort === null) {
      throw new Error('MockTokenAuthServer has not been started');
    }
    return this.boundPort;
  }

  /** Snapshot of observed requests to the mock AS endpoints. */
  getCounters(): MockAuthServerCounters {
    return { ...this.counters };
  }

  async start(): Promise<void> {
    if (this.server) return;

    const { publicKey, privateKey } = await jose.generateKeyPair(this.alg, {
      extractable: true
    });
    const exportedJwk = await jose.exportJWK(publicKey);
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    this.publicJwk = {
      ...exportedJwk,
      kid: this.kid,
      use: 'sig',
      alg: this.alg
    };

    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res).catch((error) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'server_error',
              error_description:
                error instanceof Error ? error.message : String(error)
            })
          );
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once('error', onError);
      server.listen(this.requestedPort, this.host, () => {
        server.off('error', onError);
        resolve();
      });
    });

    const address = server.address() as AddressInfo | null;
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('MockTokenAuthServer did not bind to a TCP port');
    }

    this.server = server;
    this.boundPort = address.port;
    this.resolvedIssuerUrl =
      this.explicitIssuerUrl ?? `http://${this.host}:${this.boundPort}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    srv.closeAllConnections();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }

  async mintToken(options: MintAccessTokenOptions = {}): Promise<string> {
    if (!this.privateKey || !this.resolvedIssuerUrl) {
      throw new Error('MockTokenAuthServer must be started before minting');
    }

    const now = options.iat ?? Math.floor(Date.now() / 1000);
    const lifetime = options.expiresInSeconds ?? 3600;
    const iat = options.expired ? now - 600 : now;
    const exp = options.expired ? now - 300 : now + lifetime;

    const payload: Record<string, unknown> = {
      client_id: options.clientId ?? 'conformance-test-client',
      scope: options.scope ?? 'mcp:tools'
    };

    let builder = new jose.SignJWT(payload)
      .setProtectedHeader({
        alg: this.alg,
        kid: this.kid,
        typ: 'at+jwt'
      })
      .setIssuer(this.resolvedIssuerUrl)
      .setSubject(options.subject ?? 'conformance-test-subject')
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .setJti(randomUUID());

    if (!options.omitAud && options.audience !== undefined) {
      builder = builder.setAudience(options.audience);
    }

    return builder.sign(this.privateKey);
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const method = req.method ?? 'GET';
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (
      method === 'GET' &&
      (pathname === '/.well-known/oauth-authorization-server' ||
        pathname === '/.well-known/openid-configuration')
    ) {
      this.counters.metadataRequests += 1;
      const issuer = this.issuerUrl;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer,
          jwks_uri: `${issuer}/jwks`,
          introspection_endpoint: `${issuer}/introspect`,
          token_endpoint: `${issuer}/token`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'client_credentials'],
          id_token_signing_alg_values_supported: [this.alg]
        })
      );
      return;
    }

    if (
      method === 'GET' &&
      (pathname === '/jwks' || pathname === '/.well-known/jwks.json')
    ) {
      this.counters.jwksRequests += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: this.publicJwk ? [this.publicJwk] : [] }));
      return;
    }

    if (method === 'POST' && pathname === '/introspect') {
      this.counters.introspectionRequests += 1;
      const rawBody = await readBody(req);
      const token = extractIntrospectionToken(
        rawBody,
        req.headers['content-type']
      );

      if (!token || !this.publicKey || !this.resolvedIssuerUrl) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ active: false }));
        return;
      }

      try {
        // Verify signature, issuer, and expiration without filtering on `aud`:
        // per RFC 7662, introspection reports the token's `aud` so the resource
        // server performs audience validation.
        const { payload } = await jose.jwtVerify(token, this.publicKey, {
          issuer: this.resolvedIssuerUrl,
          algorithms: [this.alg]
        });

        const response: Record<string, unknown> = {
          active: true,
          iss: payload.iss,
          sub: payload.sub,
          exp: payload.exp,
          iat: payload.iat,
          jti: payload.jti,
          client_id: payload.client_id,
          scope: payload.scope,
          token_type: 'Bearer'
        };
        if (payload.aud !== undefined) {
          response.aud = payload.aud;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ active: false }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  }
}
