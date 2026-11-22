#!/usr/bin/env node

/**
 * MCP Token Audience Validation Reference & Negative-Test Server
 *
 * Built on `@modelcontextprotocol/sdk` (`McpServer`,
 * `StreamableHTTPServerTransport`, `requireBearerAuth`, `checkResourceAllowed`).
 * Validates Bearer JWTs issued by the conformance mock Authorization Server
 * either locally via JWKS (default) or via RFC 7662 token introspection
 * (`AUTH_MODE=introspect`).
 *
 * Environment variables:
 *   PORT                Listening port (default: 3014)
 *   AUTH_SERVER_URL     Mock AS issuer URL (default: http://localhost:8091)
 *   RESOURCE_URL        Canonical MCP server URI expected in `aud`
 *                       (default: http://localhost:<PORT>/mcp)
 *   AUTH_MODE           `jwks` (default) or `introspect`
 *   TOKEN_AUDIENCE_BREAK  Optional defect injection for negative testing:
 *                         - `skip-audience`
 *                         - `allow-missing-audience`
 *                         - `skip-expiration`
 *                         - `no-auth`
 *                         - `reject-all`
 *                         - `wrong-status-403`
 */

import express from 'express';
import { createPublicKey, randomUUID, verify, type JsonWebKey } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import {
  InsufficientScopeError,
  InvalidTokenError
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import {
  checkResourceAllowed,
  resourceUrlFromServerUrl
} from '@modelcontextprotocol/sdk/shared/auth-utils.js';

const ALLOWED_BREAK_MODES = new Set([
  'skip-audience',
  'allow-missing-audience',
  'skip-expiration',
  'no-auth',
  'reject-all',
  'wrong-status-403'
]);

const PORT = Number.parseInt(process.env.PORT || '3014', 10);
const AUTH_SERVER_URL = (
  process.env.AUTH_SERVER_URL || 'http://localhost:8091'
).replace(/\/+$/, '');
const RESOURCE_URL = process.env.RESOURCE_URL || `http://localhost:${PORT}/mcp`;
const AUTH_MODE = (process.env.AUTH_MODE || 'jwks').toLowerCase();
const BREAK_MODE = process.env.TOKEN_AUDIENCE_BREAK || '';

if (BREAK_MODE && !ALLOWED_BREAK_MODES.has(BREAK_MODE)) {
  console.error(
    `Unknown TOKEN_AUDIENCE_BREAK="${BREAK_MODE}". Allowed: ${Array.from(ALLOWED_BREAK_MODES).join(', ')}`
  );
  process.exit(1);
}

if (AUTH_MODE !== 'jwks' && AUTH_MODE !== 'introspect') {
  console.error(`Unknown AUTH_MODE="${AUTH_MODE}". Allowed: jwks, introspect`);
  process.exit(1);
}

const configuredResource = resourceUrlFromServerUrl(RESOURCE_URL);
const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(
  new URL(RESOURCE_URL)
);

interface AsMetadata {
  issuer: string;
  jwks_uri?: string;
  introspection_endpoint?: string;
}

interface JwkWithKid extends JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
}

interface JwtHeader {
  alg?: string;
  kid?: string;
}

interface JwtPayload {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  client_id?: string;
  scope?: string;
}

function decodeBase64UrlJson<T>(segment: string): T {
  const raw = Buffer.from(segment, 'base64url').toString('utf8');
  return JSON.parse(raw) as T;
}

async function fetchAsMetadata(): Promise<AsMetadata> {
  const res = await fetch(
    `${AUTH_SERVER_URL}/.well-known/oauth-authorization-server`,
    { headers: { Accept: 'application/json' } }
  );
  if (!res.ok) {
    throw new InvalidTokenError(
      `Failed to fetch AS metadata: HTTP ${res.status}`
    );
  }
  return (await res.json()) as AsMetadata;
}

function validateAudienceClaim(aud: unknown): URL | undefined {
  if (BREAK_MODE === 'skip-audience') {
    return configuredResource;
  }

  const audiences: string[] =
    typeof aud === 'string'
      ? [aud]
      : Array.isArray(aud)
        ? aud.filter((item): item is string => typeof item === 'string')
        : [];

  if (audiences.length === 0) {
    if (BREAK_MODE === 'allow-missing-audience') {
      return configuredResource;
    }
    throw new InvalidTokenError('Access token is missing required aud claim');
  }

  for (const candidate of audiences) {
    try {
      const candidateUrl = resourceUrlFromServerUrl(candidate);
      if (
        checkResourceAllowed({
          requestedResource: candidateUrl,
          configuredResource
        })
      ) {
        return candidateUrl;
      }
    } catch {
      // Non-URL audience value does not match this server's URI.
    }
  }

  if (BREAK_MODE === 'wrong-status-403') {
    throw new InsufficientScopeError(
      'Deliberately returning 403 for audience mismatch'
    );
  }
  throw new InvalidTokenError(
    `Access token audience does not match ${configuredResource.href}`
  );
}

async function verifyViaJwks(token: string): Promise<AuthInfo> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new InvalidTokenError('Malformed JWT');
  }
  const [headerSeg, payloadSeg, signatureSeg] = parts;

  let header: JwtHeader;
  let payload: JwtPayload;
  try {
    header = decodeBase64UrlJson<JwtHeader>(headerSeg);
    payload = decodeBase64UrlJson<JwtPayload>(payloadSeg);
  } catch {
    throw new InvalidTokenError('Failed to decode JWT');
  }

  if (header.alg !== 'RS256') {
    throw new InvalidTokenError(`Unsupported JWT algorithm: ${header.alg}`);
  }

  const metadata = await fetchAsMetadata();
  if (!metadata.jwks_uri) {
    throw new InvalidTokenError('AS metadata is missing jwks_uri');
  }

  const jwksRes = await fetch(metadata.jwks_uri, {
    headers: { Accept: 'application/json' }
  });
  if (!jwksRes.ok) {
    throw new InvalidTokenError(`Failed to fetch JWKS: HTTP ${jwksRes.status}`);
  }
  const jwks = (await jwksRes.json()) as { keys?: JwkWithKid[] };
  const keys = Array.isArray(jwks.keys) ? jwks.keys : [];
  const matchingKey =
    keys.find((k) => !header.kid || k.kid === header.kid) ?? keys[0];
  if (!matchingKey) {
    throw new InvalidTokenError('No matching signing key found in JWKS');
  }

  const publicKey = createPublicKey({ key: matchingKey, format: 'jwk' });
  const signingInput = Buffer.from(`${headerSeg}.${payloadSeg}`, 'utf8');
  const signature = Buffer.from(signatureSeg, 'base64url');
  const signatureValid = verify(
    'RSA-SHA256',
    signingInput,
    publicKey,
    signature
  );
  if (!signatureValid) {
    throw new InvalidTokenError('Invalid token signature');
  }

  if (payload.iss !== metadata.issuer) {
    throw new InvalidTokenError(
      `Unexpected issuer "${payload.iss ?? ''}", expected "${metadata.issuer}"`
    );
  }

  const now = Math.floor(Date.now() / 1000);
  if (BREAK_MODE !== 'skip-expiration') {
    if (typeof payload.exp !== 'number' || payload.exp <= now) {
      throw new InvalidTokenError('Token has expired');
    }
  }

  const validatedResource = validateAudienceClaim(payload.aud);

  return {
    token,
    clientId: payload.client_id ?? payload.sub ?? 'unknown',
    scopes: payload.scope ? payload.scope.split(/\s+/).filter(Boolean) : [],
    expiresAt: BREAK_MODE === 'skip-expiration' ? now + 3600 : payload.exp,
    resource: validatedResource
  };
}

async function verifyViaIntrospection(token: string): Promise<AuthInfo> {
  const metadata = await fetchAsMetadata();
  if (!metadata.introspection_endpoint) {
    throw new InvalidTokenError(
      'AS metadata is missing introspection_endpoint'
    );
  }

  const res = await fetch(metadata.introspection_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: new URLSearchParams({ token }).toString()
  });

  if (!res.ok) {
    throw new InvalidTokenError(`Introspection failed: HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    active?: boolean;
    aud?: string | string[];
    exp?: number;
    client_id?: string;
    sub?: string;
    scope?: string;
  };

  if (!data.active) {
    throw new InvalidTokenError('Token is not active');
  }

  const validatedResource = validateAudienceClaim(data.aud);
  const now = Math.floor(Date.now() / 1000);

  return {
    token,
    clientId: data.client_id ?? data.sub ?? 'unknown',
    scopes: data.scope ? data.scope.split(/\s+/).filter(Boolean) : [],
    expiresAt: BREAK_MODE === 'skip-expiration' ? now + 3600 : data.exp,
    resource: validatedResource
  };
}

const verifier: OAuthTokenVerifier = {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (BREAK_MODE === 'reject-all') {
      throw new InvalidTokenError('Server configured to reject all tokens');
    }
    if (AUTH_MODE === 'introspect') {
      return verifyViaIntrospection(token);
    }
    return verifyViaJwks(token);
  }
};

function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'auth-token-audience-test-server', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  server.tool('echo', 'Echo a message', {}, async () => ({
    content: [{ type: 'text', text: 'ok' }]
  }));
  return server;
}

const app = express();
app.use(express.json());

const prmDocument = {
  resource: configuredResource.href,
  authorization_servers: [AUTH_SERVER_URL],
  bearer_methods_supported: ['header']
};

app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => {
  res.json(prmDocument);
});

app.get('/.well-known/oauth-protected-resource', (_req, res) => {
  res.json(prmDocument);
});

const authMiddleware =
  BREAK_MODE === 'no-auth'
    ? (
        _req: express.Request,
        _res: express.Response,
        next: express.NextFunction
      ) => next()
    : requireBearerAuth({ verifier, resourceMetadataUrl });

const transports: Record<string, StreamableHTTPServerTransport> = {};
const servers: Record<string, McpServer> = {};

app.post('/mcp', authMiddleware, async (req, res) => {
  const body = req.body as {
    method?: string;
    id?: string | number | null;
    params?: { _meta?: Record<string, unknown> };
  };

  // Support stateless SEP-2575 `server/discover` (2026-07-28 draft wire)
  if (body?.method === 'server/discover') {
    res.status(200).json({
      jsonrpc: '2.0',
      id: body.id ?? 1,
      result: {
        protocolVersion: '2026-07-28',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'auth-token-audience-test-server',
          version: '1.0.0'
        }
      }
    });
    return;
  }

  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  try {
    if (sessionId && transports[sessionId]) {
      await transports[sessionId].handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && body?.method === 'initialize') {
      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          transports[newSessionId] = transport;
          servers[newSessionId] = mcpServer;
        }
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          delete transports[sid];
          if (servers[sid]) {
            void servers[sid].close();
            delete servers[sid];
          }
        }
      };

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      jsonrpc: '2.0',
      id: body?.id ?? null,
      error: { code: -32000, message: 'Invalid or missing session ID' }
    });
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        id: body?.id ?? null,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }
});

app.delete('/mcp', authMiddleware, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(404).send('Session not found');
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(
    `MCP Token Audience Test Server running on http://localhost:${PORT}`
  );
  console.log(`  - MCP endpoint: ${RESOURCE_URL}`);
  console.log(`  - Auth server:  ${AUTH_SERVER_URL} (mode=${AUTH_MODE})`);
  if (BREAK_MODE) {
    console.log(`  - Break mode:   ${BREAK_MODE}`);
  }
});
