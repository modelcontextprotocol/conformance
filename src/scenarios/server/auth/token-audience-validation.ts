/**
 * Server-side Token Audience Validation conformance scenario (issue #78).
 *
 * Verifies that an MCP server acting as an OAuth 2.1 resource server validates
 * presented JWT access tokens against its own intended audience (RFC 8707) and
 * expiration time:
 *   1. Valid token with `aud` matching the server URI -> accepted (HTTP 2xx)
 *   2. Token with `aud` for a different server -> rejected (HTTP 401)
 *   3. Token missing the `aud` claim -> rejected (HTTP 401)
 *   4. Expired token -> rejected (HTTP 401)
 *
 * Runs a local mock Authorization Server serving RFC 8414 metadata
 * (`/.well-known/oauth-authorization-server`), JWKS (`/jwks`), and RFC 7662
 * token introspection (`/introspect`), so servers validating via either JWKS
 * or introspection can integrate without external infrastructure.
 */

import { request } from 'undici';
import {
  ClientScenario,
  ConformanceCheck,
  DRAFT_PROTOCOL_VERSION,
  SpecReference
} from '../../../types';
import {
  buildStandardHeaders,
  withRequestMeta,
  type RunContext
} from '../../../connection';
import { untestableCheck } from '../../untestable';
import { MockTokenAuthServer } from './mock-auth-server';

export const DEFAULT_MOCK_AS_PORT = 8091;

const REQUEST_TIMEOUT_MS = 10_000;
const DISCOVERY_TIMEOUT_MS = 5_000;
const BODY_READ_TIMEOUT_MS = 2_000;

const WRONG_AUDIENCE_PRIMARY = 'https://other-mcp-server.example.com/mcp';
const WRONG_AUDIENCE_FALLBACK = 'https://different-mcp-server.example.com/mcp';

const SPEC_REF_TOKEN_HANDLING: SpecReference = {
  id: 'MCP-Token-Handling',
  url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#token-handling'
};

const SPEC_REF_AUDIENCE_VALIDATION: SpecReference = {
  id: 'MCP-Token-Audience-Validation',
  url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#token-audience-binding-and-validation'
};

const SPEC_REF_PRIVILEGE_RESTRICTION: SpecReference = {
  id: 'MCP-Access-Token-Privilege-Restriction',
  url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#access-token-privilege-restriction'
};

const SPEC_REF_RFC_8707: SpecReference = {
  id: 'RFC-8707-Resource-Indicators',
  url: 'https://www.rfc-editor.org/rfc/rfc8707.html#section-2'
};

const VALID_ACCEPTED_REFS: SpecReference[] = [
  SPEC_REF_TOKEN_HANDLING,
  SPEC_REF_AUDIENCE_VALIDATION
];

const AUDIENCE_VALIDATION_REFS: SpecReference[] = [
  SPEC_REF_TOKEN_HANDLING,
  SPEC_REF_AUDIENCE_VALIDATION,
  SPEC_REF_PRIVILEGE_RESTRICTION,
  SPEC_REF_RFC_8707
];

const EXPIRED_TOKEN_REFS: SpecReference[] = [SPEC_REF_TOKEN_HANDLING];

export interface TokenAudienceValidationOptions {
  /**
   * Optional pre-started mock Authorization Server (useful in automated tests
   * where the server under test is started after binding an ephemeral AS port).
   * When supplied, the caller owns its lifecycle and this scenario will not
   * stop it.
   */
  mockAuthServer?: MockTokenAuthServer;
  /** Explicit TCP port for the scenario-managed mock AS. */
  mockAsPort?: number;
  /** Explicit issuer URL for the scenario-managed mock AS. */
  mockAsIssuerUrl?: string;
}

interface ProbePayload {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface ProbeResponse {
  statusCode: number;
  wwwAuthenticate?: string;
  sessionId?: string;
  bodySnippet?: string;
}

interface LoopbackAsConfig {
  host: string;
  port: number;
  issuerUrl: string;
}

/**
 * Strip any fragment from the server URL per RFC 8707 §2 to form the canonical
 * resource identifier expected in the `aud` claim.
 */
function canonicalResourceUri(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.hash = '';
  return url.href;
}

/**
 * Build a version-appropriate MCP JSON-RPC probe body:
 * - 2025-x (stateful): `initialize`
 * - 2026-07-28 / draft (stateless): `server/discover` with `_meta` envelope
 */
function buildProbeBody(specVersion: string): ProbePayload {
  if (specVersion === DRAFT_PROTOCOL_VERSION) {
    return {
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: withRequestMeta({}, specVersion)
    };
  }
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: specVersion,
      capabilities: {},
      clientInfo: {
        name: 'conformance-token-audience-test',
        version: '1.0.0'
      }
    }
  };
}

function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const value = headers[name.toLowerCase()];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) return value.join(', ');
  return undefined;
}

function isAcceptedStatus(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}

/**
 * Abort and release an undici response body without surfacing an unhandled
 * `UND_ERR_ABORTED` error event on the stream.
 */
function discardResponseBody(
  body: Awaited<ReturnType<typeof request>>['body']
): void {
  body.on('error', () => {});
  body.destroy();
}

/**
 * Safely read a short diagnostic body snippet without hanging on open SSE
 * streams. Always consumes or destroys the response body to release sockets.
 */
async function readBoundedBodySnippet(
  response: Awaited<ReturnType<typeof request>>
): Promise<string | undefined> {
  const contentType =
    getHeader(response.headers, 'content-type')?.toLowerCase() ?? '';
  if (contentType.includes('text/event-stream')) {
    discardResponseBody(response.body);
    return undefined;
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    const text = await Promise.race<string | undefined>([
      response.body.text(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          discardResponseBody(response.body);
          resolve(undefined);
        }, BODY_READ_TIMEOUT_MS);
      })
    ]);
    if (text === undefined) return undefined;
    return text.length > 300 ? `${text.slice(0, 300)}...` : text;
  } catch {
    discardResponseBody(response.body);
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function sendMcpProbe(
  serverUrl: string,
  specVersion: string,
  bearerToken?: string
): Promise<ProbeResponse> {
  const probe = buildProbeBody(specVersion);
  const extraHeaders: Record<string, string> = {
    'MCP-Protocol-Version': specVersion
  };
  if (bearerToken !== undefined) {
    extraHeaders.Authorization = `Bearer ${bearerToken}`;
  }

  const response = await request(serverUrl, {
    method: 'POST',
    headers: buildStandardHeaders(probe.method, probe.params, {
      headers: extraHeaders
    }),
    body: JSON.stringify(probe),
    headersTimeout: REQUEST_TIMEOUT_MS,
    bodyTimeout: REQUEST_TIMEOUT_MS,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  const bodySnippet = await readBoundedBodySnippet(response);

  return {
    statusCode: response.statusCode,
    wwwAuthenticate: getHeader(response.headers, 'www-authenticate'),
    sessionId: getHeader(response.headers, 'mcp-session-id'),
    bodySnippet
  };
}

/**
 * Best-effort cleanup for stateful sessions created during the valid-token
 * probe so we don't leave open sessions on the server under test.
 */
async function closeStatefulSession(
  serverUrl: string,
  specVersion: string,
  sessionId: string,
  bearerToken: string
): Promise<void> {
  try {
    const response = await request(serverUrl, {
      method: 'DELETE',
      headers: {
        'MCP-Protocol-Version': specVersion,
        'Mcp-Session-Id': sessionId,
        Authorization: `Bearer ${bearerToken}`
      },
      headersTimeout: DISCOVERY_TIMEOUT_MS,
      bodyTimeout: DISCOVERY_TIMEOUT_MS,
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
    });
    discardResponseBody(response.body);
  } catch {
    // Best-effort cleanup only.
  }
}

/**
 * Extract `resource_metadata` URL from a `WWW-Authenticate` header (RFC 9728).
 */
function extractResourceMetadataUrl(
  wwwAuthenticate: string | undefined
): string | undefined {
  if (!wwwAuthenticate) return undefined;
  const quoted = /resource_metadata\s*=\s*"([^"]+)"/i.exec(wwwAuthenticate);
  if (quoted?.[1]) return quoted[1];
  const unquoted = /resource_metadata\s*=\s*([^\s,]+)/i.exec(wwwAuthenticate);
  return unquoted?.[1];
}

function parseLoopbackAuthServerUrl(
  candidate: string
): LoopbackAsConfig | undefined {
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:') return undefined;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
      return undefined;
    }
    if (!parsed.port) return undefined;
    if (parsed.pathname !== '' && parsed.pathname !== '/') return undefined;
    const port = Number.parseInt(parsed.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    return {
      host: '127.0.0.1',
      port,
      issuerUrl: `${parsed.protocol}//${parsed.host}`
    };
  } catch {
    return undefined;
  }
}

/**
 * Attempt to discover a loopback Authorization Server URL from the server's
 * RFC 9728 Protected Resource Metadata so an operator who pointed their server
 * at a local mock AS port needs no extra CLI/env configuration.
 */
async function discoverLoopbackAuthServerFromPrm(
  serverUrl: string,
  wwwAuthenticate: string | undefined
): Promise<LoopbackAsConfig | undefined> {
  const parsedServer = new URL(serverUrl);
  const candidates: string[] = [];

  const fromHeader = extractResourceMetadataUrl(wwwAuthenticate);
  if (fromHeader) candidates.push(fromHeader);

  const normalizedPath = parsedServer.pathname.replace(/\/+$/, '');
  if (normalizedPath && normalizedPath !== '/') {
    candidates.push(
      `${parsedServer.origin}/.well-known/oauth-protected-resource${normalizedPath}`
    );
  }
  candidates.push(
    `${parsedServer.origin}/.well-known/oauth-protected-resource`
  );

  const seen = new Set<string>();
  for (const url of candidates) {
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const res = await request(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        headersTimeout: DISCOVERY_TIMEOUT_MS,
        bodyTimeout: DISCOVERY_TIMEOUT_MS,
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
      });
      if (res.statusCode !== 200) {
        discardResponseBody(res.body);
        continue;
      }
      const data = (await res.body.json()) as {
        authorization_servers?: unknown;
      };
      if (Array.isArray(data?.authorization_servers)) {
        for (const entry of data.authorization_servers) {
          if (typeof entry === 'string') {
            const loopback = parseLoopbackAuthServerUrl(entry);
            if (loopback) return loopback;
          }
        }
      }
    } catch {
      // PRM discovery is best-effort for auto-configuring the mock AS port.
    }
  }
  return undefined;
}

function resolveEnvMockAsConfig(): LoopbackAsConfig | undefined {
  const rawPort = process.env.MCP_CONFORMANCE_MOCK_AS_PORT;
  if (!rawPort) return undefined;
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  const issuerUrl =
    process.env.MCP_CONFORMANCE_MOCK_AS_ISSUER?.replace(/\/+$/, '') ||
    `http://localhost:${port}`;
  return { host: '127.0.0.1', port, issuerUrl };
}

export class TokenAudienceValidationScenario implements ClientScenario {
  name = 'auth/token-audience-validation';
  readonly source = { introducedIn: '2025-06-18' } as const;
  description = `Test server-side OAuth access token audience validation (RFC 8707 / OAuth 2.1).

**Requirements:**
- Server **MUST** validate access tokens as an OAuth 2.1 resource server
- Server **MUST** accept valid tokens whose \`aud\` claim matches the server URI
- Server **MUST** validate that access tokens were issued specifically for it as the intended audience and reject tokens with a mismatched \`aud\` claim (HTTP 401)
- Server **MUST** reject tokens missing an \`aud\` claim (HTTP 401)
- Server **MUST** reject expired tokens (HTTP 401)

**Server Setup:**
The scenario starts a local mock Authorization Server exposing:
- \`/.well-known/oauth-authorization-server\` (RFC 8414 metadata with \`jwks_uri\` and \`introspection_endpoint\`)
- \`/jwks\` (RS256 public key in JWKS format)
- \`/introspect\` (RFC 7662 token introspection)

Configure the server under test to trust this mock AS (either via JWKS or token introspection) and validate \`aud\` against its own \`--url\`. The mock AS port is selected in order:
1. \`MCP_CONFORMANCE_MOCK_AS_PORT\` env var (optional \`MCP_CONFORMANCE_MOCK_AS_ISSUER\`)
2. Loopback URL advertised in the server's Protected Resource Metadata (\`authorization_servers[0]\`)
3. Default: \`http://localhost:${DEFAULT_MOCK_AS_PORT}\``;

  private readonly options: TokenAudienceValidationOptions;

  constructor(options: TokenAudienceValidationOptions = {}) {
    this.options = options;
  }

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const { serverUrl, specVersion } = ctx;
    const checks: ConformanceCheck[] = [];
    const timestamp = new Date().toISOString();

    const validAudience = canonicalResourceUri(serverUrl);
    const wrongAudience =
      validAudience === WRONG_AUDIENCE_PRIMARY
        ? WRONG_AUDIENCE_FALLBACK
        : WRONG_AUDIENCE_PRIMARY;

    // Step 0: Unauthenticated probe to detect servers without auth and to
    // read WWW-Authenticate / PRM metadata for automatic mock AS port binding.
    let unauthenticatedAccepted = false;
    let unauthStatusCode: number | undefined;
    let unauthWwwAuthenticate: string | undefined;

    try {
      const unauthRes = await sendMcpProbe(serverUrl, specVersion);
      unauthStatusCode = unauthRes.statusCode;
      unauthWwwAuthenticate = unauthRes.wwwAuthenticate;
      unauthenticatedAccepted = isAcceptedStatus(unauthRes.statusCode);
      if (
        unauthenticatedAccepted &&
        specVersion !== DRAFT_PROTOCOL_VERSION &&
        unauthRes.sessionId
      ) {
        await closeStatefulSession(
          serverUrl,
          specVersion,
          unauthRes.sessionId,
          ''
        );
      }
    } catch {
      // Connection/timeout errors will be surfaced cleanly by the checks below.
    }

    // Step 1: Resolve or start the local mock Authorization Server.
    let mockAs: MockTokenAuthServer;
    let ownsMockAs = false;

    if (this.options.mockAuthServer) {
      mockAs = this.options.mockAuthServer;
    } else {
      let config: LoopbackAsConfig;
      if (this.options.mockAsPort !== undefined) {
        const port = this.options.mockAsPort;
        config = {
          host: '127.0.0.1',
          port,
          issuerUrl:
            this.options.mockAsIssuerUrl?.replace(/\/+$/, '') ||
            `http://localhost:${port}`
        };
      } else {
        const fromEnv = resolveEnvMockAsConfig();
        const fromPrm =
          fromEnv ??
          (await discoverLoopbackAuthServerFromPrm(
            serverUrl,
            unauthWwwAuthenticate
          ));
        config = fromPrm ?? {
          host: '127.0.0.1',
          port: DEFAULT_MOCK_AS_PORT,
          issuerUrl:
            process.env.MCP_CONFORMANCE_MOCK_AS_ISSUER?.replace(/\/+$/, '') ||
            `http://localhost:${DEFAULT_MOCK_AS_PORT}`
        };
      }

      mockAs = new MockTokenAuthServer({
        host: config.host,
        port: config.port,
        issuerUrl: config.issuerUrl
      });

      try {
        await mockAs.start();
        ownsMockAs = true;
      } catch (error) {
        const reason = `Failed to start mock authorization server on ${config.host}:${config.port}: ${error instanceof Error ? error.message : String(error)}`;
        return [
          untestableCheck(
            'server-token-valid-accepted',
            'TokenValidAccepted',
            'Server accepts a valid access token whose aud claim matches its own URI',
            reason,
            VALID_ACCEPTED_REFS
          ),
          untestableCheck(
            'server-token-audience-validation',
            'TokenAudienceValidation',
            'Server rejects an access token issued for a different audience with HTTP 401',
            reason,
            AUDIENCE_VALIDATION_REFS
          ),
          untestableCheck(
            'server-token-missing-audience-rejected',
            'TokenMissingAudienceRejected',
            'Server rejects an access token missing the aud claim with HTTP 401',
            reason,
            AUDIENCE_VALIDATION_REFS
          ),
          untestableCheck(
            'server-token-expired-rejected',
            'TokenExpiredRejected',
            'Server rejects an expired access token with HTTP 401',
            reason,
            EXPIRED_TOKEN_REFS
          )
        ];
      }
    }

    try {
      const issuerUrl = mockAs.issuerUrl;
      let validTokenAccepted = false;

      // Check 1: Valid token with `aud` matching this server's URI -> accepted
      if (unauthenticatedAccepted) {
        checks.push(
          untestableCheck(
            'server-token-valid-accepted',
            'TokenValidAccepted',
            'Server accepts a valid access token whose aud claim matches its own URI',
            `Server accepted an unauthenticated request (HTTP ${unauthStatusCode}); authentication does not appear to be enforced`,
            VALID_ACCEPTED_REFS
          )
        );
      } else {
        try {
          const validToken = await mockAs.mintToken({
            audience: validAudience
          });
          const res = await sendMcpProbe(serverUrl, specVersion, validToken);
          const accepted = isAcceptedStatus(res.statusCode);
          validTokenAccepted = accepted;

          if (
            accepted &&
            specVersion !== DRAFT_PROTOCOL_VERSION &&
            res.sessionId
          ) {
            await closeStatefulSession(
              serverUrl,
              specVersion,
              res.sessionId,
              validToken
            );
          }

          checks.push({
            id: 'server-token-valid-accepted',
            name: 'TokenValidAccepted',
            description:
              'Server accepts a valid access token whose aud claim matches its own URI',
            status: accepted ? 'SUCCESS' : 'FAILURE',
            timestamp,
            specReferences: VALID_ACCEPTED_REFS,
            errorMessage: accepted
              ? undefined
              : `Expected HTTP 2xx for valid token with aud="${validAudience}", got ${res.statusCode}. Ensure the server is configured to trust the mock authorization server at ${issuerUrl}.`,
            details: {
              issuer: issuerUrl,
              audience: validAudience,
              statusCode: res.statusCode,
              wwwAuthenticate: res.wwwAuthenticate,
              mockAsRequests: mockAs.getCounters()
            }
          });
        } catch (error) {
          checks.push({
            id: 'server-token-valid-accepted',
            name: 'TokenValidAccepted',
            description:
              'Server accepts a valid access token whose aud claim matches its own URI',
            status: 'FAILURE',
            timestamp,
            specReferences: VALID_ACCEPTED_REFS,
            errorMessage: `Request failed: ${error instanceof Error ? error.message : String(error)}`,
            details: {
              issuer: issuerUrl,
              audience: validAudience
            }
          });
        }
      }

      // Helper for the three negative token checks (wrong aud, missing aud, expired).
      // A 401 only proves the server enforced the specific claim when the
      // positive valid-token probe succeeded; otherwise a reject-all server or
      // misconfigured AS would falsely score green (#248 / #483).
      const runNegativeProbe = async (params: {
        id: string;
        name: string;
        description: string;
        token: string;
        caseLabel: string;
        specReferences: SpecReference[];
        extraDetails: Record<string, unknown>;
      }): Promise<void> => {
        try {
          const res = await sendMcpProbe(serverUrl, specVersion, params.token);
          const rejectedWith401 = res.statusCode === 401;

          if (
            isAcceptedStatus(res.statusCode) &&
            specVersion !== DRAFT_PROTOCOL_VERSION &&
            res.sessionId
          ) {
            await closeStatefulSession(
              serverUrl,
              specVersion,
              res.sessionId,
              params.token
            );
          }

          if (!rejectedWith401) {
            checks.push({
              id: params.id,
              name: params.name,
              description: params.description,
              status: 'FAILURE',
              timestamp,
              specReferences: params.specReferences,
              errorMessage: `Expected HTTP 401 for ${params.caseLabel}, got ${res.statusCode}`,
              details: {
                issuer: issuerUrl,
                statusCode: res.statusCode,
                wwwAuthenticate: res.wwwAuthenticate,
                ...params.extraDetails
              }
            });
            return;
          }

          if (!validTokenAccepted) {
            checks.push(
              untestableCheck(
                params.id,
                params.name,
                params.description,
                `Server returned HTTP 401 for ${params.caseLabel}, but did not accept the valid token with matching audience (aud="${validAudience}"), so rejection cannot be attributed to ${params.caseLabel} validation`,
                params.specReferences
              )
            );
            return;
          }

          checks.push({
            id: params.id,
            name: params.name,
            description: params.description,
            status: 'SUCCESS',
            timestamp,
            specReferences: params.specReferences,
            details: {
              issuer: issuerUrl,
              statusCode: res.statusCode,
              wwwAuthenticate: res.wwwAuthenticate,
              ...params.extraDetails
            }
          });
        } catch (error) {
          checks.push({
            id: params.id,
            name: params.name,
            description: params.description,
            status: 'FAILURE',
            timestamp,
            specReferences: params.specReferences,
            errorMessage: `Request failed: ${error instanceof Error ? error.message : String(error)}`,
            details: {
              issuer: issuerUrl,
              ...params.extraDetails
            }
          });
        }
      };

      // Check 2: Token with `aud` for a different server -> rejected (401)
      const wrongAudToken = await mockAs.mintToken({
        audience: wrongAudience
      });
      await runNegativeProbe({
        id: 'server-token-audience-validation',
        name: 'TokenAudienceValidation',
        description:
          'Server rejects an access token issued for a different audience with HTTP 401',
        token: wrongAudToken,
        caseLabel: `token with wrong aud claim ("${wrongAudience}")`,
        specReferences: AUDIENCE_VALIDATION_REFS,
        extraDetails: {
          expectedAudience: validAudience,
          sentAudience: wrongAudience
        }
      });

      // Check 3: Token with missing `aud` claim -> rejected (401)
      const missingAudToken = await mockAs.mintToken({
        omitAud: true
      });
      await runNegativeProbe({
        id: 'server-token-missing-audience-rejected',
        name: 'TokenMissingAudienceRejected',
        description:
          'Server rejects an access token missing the aud claim with HTTP 401',
        token: missingAudToken,
        caseLabel: 'token with missing aud claim',
        specReferences: AUDIENCE_VALIDATION_REFS,
        extraDetails: {
          expectedAudience: validAudience,
          sentAudience: null
        }
      });

      // Check 4: Expired token (with matching `aud`) -> rejected (401)
      const expiredToken = await mockAs.mintToken({
        audience: validAudience,
        expired: true
      });
      await runNegativeProbe({
        id: 'server-token-expired-rejected',
        name: 'TokenExpiredRejected',
        description: 'Server rejects an expired access token with HTTP 401',
        token: expiredToken,
        caseLabel: 'expired token',
        specReferences: EXPIRED_TOKEN_REFS,
        extraDetails: {
          audience: validAudience,
          expired: true
        }
      });

      return checks;
    } finally {
      if (ownsMockAs) {
        await mockAs.stop();
      }
    }
  }
}
