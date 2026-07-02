/**
 * Token audience validation scenario for MCP servers (issue #78).
 *
 * Tests that an OAuth-protected MCP server, acting as an OAuth 2.1 resource
 * server, validates inbound access tokens and — critically — validates that
 * tokens were issued specifically for it as the intended audience (RFC 8707).
 *
 * The scenario stands up a signing-enabled mock Authorization Server (RS256
 * keypair, RFC 8414 metadata, JWKS endpoint) and mints JWTs with
 * correct / wrong / missing `aud` claims, an expired token, and a token
 * signed by an untrusted key, asserting the server accepts only the valid
 * token and rejects the rest with HTTP 401.
 *
 * Authorization is OPTIONAL in MCP. If the server under test accepts the
 * unauthenticated probe (i.e. it is not an OAuth-protected server), every
 * check reports SKIPPED — the requirement is not applicable.
 */

import { createServer, type Server } from 'http';
import { randomUUID } from 'crypto';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import {
  ClientScenario,
  ConformanceCheck,
  DRAFT_PROTOCOL_VERSION,
  type SpecVersion
} from '../../types';
import { buildStandardHeaders, type RunContext } from '../../connection';
import { untestableCheck } from '../untestable';

/**
 * Port the mock Authorization Server listens on while the scenario runs.
 * The server under test must be launched trusting
 * `http://127.0.0.1:<port>` as its authorization server (issuer) and must
 * fetch the issuer's JWKS lazily (at token-validation time), since the mock
 * AS is only running while this scenario executes.
 * Override with the MCP_CONFORMANCE_AUTH_SERVER_PORT environment variable.
 */
export const DEFAULT_MOCK_AUTH_SERVER_PORT = 9797;

const SPEC_REFERENCES = {
  tokenHandling: {
    id: 'MCP-Auth-Token-Handling',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#token-handling'
  },
  audienceBinding: {
    id: 'MCP-Auth-Token-Audience-Binding-And-Validation',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#token-audience-binding-and-validation'
  },
  privilegeRestriction: {
    id: 'MCP-Auth-Access-Token-Privilege-Restriction',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#access-token-privilege-restriction'
  },
  errorHandling: {
    id: 'MCP-Auth-Error-Handling',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#error-handling'
  },
  rfc8707: {
    id: 'RFC-8707-Section-2',
    url: 'https://www.rfc-editor.org/rfc/rfc8707.html#section-2'
  }
} as const;

interface SignTokenOptions {
  /** `aud` claim; omitted entirely when undefined. */
  audience?: string;
  /** Seconds from now for `exp`; negative mints an already-expired token. */
  expiresInSeconds?: number;
}

export interface MockAuthorizationServer {
  /** Issuer URL, e.g. `http://127.0.0.1:9797`. */
  issuer: string;
  /** Mint an RS256 JWT signed with the key published in the JWKS. */
  signToken(options?: SignTokenOptions): Promise<string>;
  /**
   * Mint a JWT with the requested claims but signed by a keypair that is
   * NOT published in the JWKS (i.e. not issued by any trusted AS).
   */
  signTokenWithUntrustedKey(options?: SignTokenOptions): Promise<string>;
  close(): Promise<void>;
}

async function buildSignedJwt(
  privateKey: CryptoKey,
  kid: string,
  issuer: string,
  options: SignTokenOptions
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresIn = options.expiresInSeconds ?? 300;
  const jwt = new SignJWT({ client_id: 'mcp-conformance-client' })
    .setProtectedHeader({ alg: 'RS256', kid, typ: 'at+jwt' })
    .setIssuer(issuer)
    .setSubject('mcp-conformance-user')
    .setJti(randomUUID())
    .setIssuedAt(expiresIn < 0 ? nowSeconds + expiresIn - 3600 : nowSeconds)
    .setExpirationTime(nowSeconds + expiresIn);
  if (options.audience !== undefined) {
    jwt.setAudience(options.audience);
  }
  return jwt.sign(privateKey);
}

/**
 * Start a minimal signing-enabled mock Authorization Server: RFC 8414
 * metadata at `/.well-known/oauth-authorization-server` and the signing
 * key's public JWK at `/.well-known/jwks.json`.
 */
export async function startMockAuthorizationServer(
  port: number
): Promise<MockAuthorizationServer> {
  const kid = 'mcp-conformance-mock-as';
  const { publicKey, privateKey } = await generateKeyPair('RS256', {
    extractable: true
  });
  const untrustedPair = await generateKeyPair('RS256', { extractable: true });

  const issuer = `http://127.0.0.1:${port}`;
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    id_token_signing_alg_values_supported: ['RS256']
  };

  const server: Server = createServer((req, res) => {
    const url = req.url?.split('?')[0];
    if (url === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(metadata));
      return;
    }
    if (url === '/.well-known/jwks.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Loopback only: the mock AS serves the local server-under-test and
    // must not be reachable from other hosts.
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  return {
    issuer,
    signToken: (options = {}) =>
      buildSignedJwt(privateKey, kid, issuer, options),
    signTokenWithUntrustedKey: (options = {}) =>
      buildSignedJwt(untrustedPair.privateKey, kid, issuer, options),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
  };
}

/**
 * Build a request body any server for the given spec version should accept
 * without prior setup (initialize for the stateful lifecycle, server/discover
 * with _meta for the stateless lifecycle). Mirrors the DNS-rebinding probe.
 */
function probeBody(
  specVersion: SpecVersion,
  id: number
): {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
} {
  const clientInfo = {
    name: 'conformance-token-audience-test',
    version: '1.0.0'
  };
  if (specVersion === DRAFT_PROTOCOL_VERSION) {
    return {
      jsonrpc: '2.0',
      id,
      method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': specVersion,
          'io.modelcontextprotocol/clientInfo': clientInfo,
          'io.modelcontextprotocol/clientCapabilities': {}
        }
      }
    };
  }
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: specVersion,
      capabilities: {},
      clientInfo
    }
  };
}

interface ProbeResponse {
  status: number;
  wwwAuthenticate?: string;
  bodySnippet?: string;
}

let probeRequestId = 1;

/**
 * POST an MCP probe request, optionally with a Bearer token. Only the HTTP
 * status matters to this scenario — token validation happens before any MCP
 * processing — so the body is read only for diagnostics.
 */
async function sendProbe(
  serverUrl: string,
  specVersion: SpecVersion,
  token?: string
): Promise<ProbeResponse> {
  const probe = probeBody(specVersion, probeRequestId++);
  const headers = buildStandardHeaders(probe.method, probe.params, {
    specVersion,
    headers: token !== undefined ? { Authorization: `Bearer ${token}` } : {}
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(serverUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(probe),
      signal: controller.signal
    });
    const wwwAuthenticate = res.headers.get('www-authenticate') ?? undefined;
    let bodySnippet: string | undefined;
    if (res.headers.get('content-type')?.includes('application/json')) {
      bodySnippet = (await res.text()).slice(0, 500);
    } else {
      // SSE or other streaming body: don't wait on it, just drop it.
      await res.body?.cancel().catch(() => {});
    }
    return { status: res.status, wwwAuthenticate, bodySnippet };
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

interface CheckDefinition {
  id: string;
  name: string;
  description: string;
  specReferences: { id: string; url: string }[];
}

const CHECKS: Record<string, CheckDefinition> = {
  unauthenticated: {
    id: 'auth-unauthenticated-request-rejected',
    name: 'UnauthenticatedRequestRejected',
    description:
      'Server rejects a request without an access token with HTTP 401 ' +
      '("MCP servers MUST validate access tokens before processing the request")',
    specReferences: [
      SPEC_REFERENCES.privilegeRestriction,
      SPEC_REFERENCES.errorHandling
    ]
  },
  validAccepted: {
    id: 'auth-valid-audience-token-accepted',
    name: 'ValidAudienceTokenAccepted',
    description:
      'Server accepts a baseline valid access token (trusted signature, its ' +
      'own canonical URI as audience, unexpired) — the control that shows ' +
      'the rejection checks below reflect targeted validation per "MCP ' +
      'servers, acting in their role as an OAuth 2.1 resource server, MUST ' +
      'validate access tokens", not blanket rejection',
    specReferences: [SPEC_REFERENCES.tokenHandling, SPEC_REFERENCES.rfc8707]
  },
  wrongAudience: {
    id: 'auth-wrong-audience-token-rejected',
    name: 'WrongAudienceTokenRejected',
    description:
      'Server rejects with HTTP 401 a validly-signed token whose aud claim ' +
      'names a different resource ("MCP servers MUST validate that access ' +
      'tokens were issued specifically for them as the intended audience")',
    specReferences: [
      SPEC_REFERENCES.tokenHandling,
      SPEC_REFERENCES.audienceBinding,
      SPEC_REFERENCES.rfc8707
    ]
  },
  missingAudience: {
    id: 'auth-missing-audience-token-rejected',
    name: 'MissingAudienceTokenRejected',
    description:
      'Server rejects with HTTP 401 a validly-signed token that carries no ' +
      'aud claim ("MCP servers ... MUST reject tokens that do not include ' +
      'them in the audience claim or otherwise verify that they are the ' +
      'intended recipient of the token")',
    specReferences: [
      SPEC_REFERENCES.privilegeRestriction,
      SPEC_REFERENCES.audienceBinding
    ]
  },
  expired: {
    id: 'auth-expired-token-rejected',
    name: 'ExpiredTokenRejected',
    description:
      'Server rejects an expired token with HTTP 401 ("Invalid or expired ' +
      'tokens MUST receive a HTTP 401 response")',
    specReferences: [SPEC_REFERENCES.tokenHandling]
  },
  untrusted: {
    id: 'auth-untrusted-token-rejected',
    name: 'UntrustedTokenRejected',
    description:
      'Server rejects with HTTP 401 a token signed by a key its ' +
      'authorization server never published ("MCP servers ... MUST validate ' +
      'access tokens as described in OAuth 2.1 Section 5.2")',
    specReferences: [SPEC_REFERENCES.tokenHandling]
  }
};

const TOKEN_CHECK_KEYS = [
  'wrongAudience',
  'missingAudience',
  'expired',
  'untrusted'
] as const;

export class TokenAudienceValidationScenario implements ClientScenario {
  name = 'auth-token-audience-validation';
  readonly source = { introducedIn: '2025-06-18' } as const;
  description = `Tests that an OAuth-protected MCP server validates access-token audiences (server-side token audience validation, RFC 8707).

**Scope:** Authorization is OPTIONAL in MCP. If the server under test accepts an unauthenticated request, it has not enabled authorization and every check reports SKIPPED.

**Setup contract for servers that enable authorization:** the conformance suite runs a signing-enabled mock Authorization Server at \`http://127.0.0.1:9797\` (override the port with \`MCP_CONFORMANCE_AUTH_SERVER_PORT\`) for the duration of the scenario. It serves RFC 8414 metadata at \`/.well-known/oauth-authorization-server\` and its signing key at \`/.well-known/jwks.json\`. Before running the scenario, launch the server under test configured to:

1. trust \`http://127.0.0.1:<port>\` as its authorization server (issuer), fetching the JWKS lazily (at token-validation time) rather than at startup, and
2. expect its own URL — exactly the \`--url\` passed to the conformance CLI — as the token audience, and
3. not require particular scopes for \`initialize\` / \`server/discover\`.

The reference fixture is \`examples/servers/typescript/everything-server.ts\` launched with \`MCP_CONFORMANCE_AUTH_ISSUER\` (and optionally \`MCP_CONFORMANCE_AUTH_AUDIENCE\`) set. Run this scenario as a dedicated auth-enabled launch (e.g. \`conformance server --url ... --scenario auth-token-audience-validation\`): the rest of the default suite sends no Bearer tokens, so it would fail with 401s against an auth-enabled server.

**Checks (all MUST-level):**
1. Request without a token is rejected with HTTP 401
2. Valid token (trusted signature, correct \`aud\`, unexpired) is accepted — the baseline that makes checks 3-6 meaningful
3. Token with a different resource in \`aud\` is rejected with HTTP 401
4. Token with no \`aud\` claim is rejected with HTTP 401
5. Expired token is rejected with HTTP 401
6. Token signed by an untrusted key is rejected with HTTP 401

If the baseline valid token (check 2) is rejected, checks 3-6 cannot distinguish audience validation from blanket rejection and are reported as not testable (issue #248).

**Spec:** MCP Authorization (2025-06-18 and later), sections "Token Handling", "Token Audience Binding and Validation", "Access Token Privilege Restriction", "Error Handling"; RFC 8707 Section 2.`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const { serverUrl, specVersion } = ctx;
    const checks: ConformanceCheck[] = [];
    const timestamp = () => new Date().toISOString();

    // Gate: authorization is optional. A server that accepts the
    // unauthenticated probe has not enabled it — nothing here applies.
    let unauthenticated: ProbeResponse;
    try {
      unauthenticated = await sendProbe(serverUrl, specVersion);
    } catch (error) {
      return Object.values(CHECKS).map((def) =>
        untestableCheck(
          def.id,
          def.name,
          def.description,
          `Could not reach the server under test: ${
            error instanceof Error ? error.message : String(error)
          }`,
          def.specReferences
        )
      );
    }

    if (unauthenticated.status >= 200 && unauthenticated.status < 300) {
      // Legitimately not applicable: optional capability not enabled.
      return Object.values(CHECKS).map((def) => ({
        ...def,
        status: 'SKIPPED' as const,
        timestamp: timestamp(),
        details: {
          reason:
            'Server accepted an unauthenticated request; authorization ' +
            '(optional in MCP) is not enabled, so token-audience ' +
            'requirements do not apply.',
          statusCode: unauthenticated.status
        }
      }));
    }

    // Only an authorization challenge (401, or 403 for servers that
    // misreport the missing-token case) shows authorization is enabled.
    // Any other non-2xx status means the probe failed for unrelated
    // reasons (wrong URL, server error, ...) and nothing can be concluded.
    if (unauthenticated.status !== 401 && unauthenticated.status !== 403) {
      return Object.values(CHECKS).map((def) =>
        untestableCheck(
          def.id,
          def.name,
          def.description,
          `the unauthenticated probe returned HTTP ` +
            `${unauthenticated.status}; expected 2xx (authorization not ` +
            `enabled) or an authorization challenge (401/403), so it cannot ` +
            `be determined whether authorization is enabled`,
          def.specReferences
        )
      );
    }

    checks.push({
      ...CHECKS.unauthenticated,
      status: unauthenticated.status === 401 ? 'SUCCESS' : 'FAILURE',
      timestamp: timestamp(),
      ...(unauthenticated.status !== 401 && {
        errorMessage:
          `Expected HTTP 401 for a request without an access token, got ` +
          `${unauthenticated.status}`
      }),
      details: {
        statusCode: unauthenticated.status,
        wwwAuthenticate: unauthenticated.wwwAuthenticate
      }
    });

    let port = DEFAULT_MOCK_AUTH_SERVER_PORT;
    const portEnv = process.env.MCP_CONFORMANCE_AUTH_SERVER_PORT;
    if (portEnv !== undefined && portEnv !== '') {
      const parsed = Number(portEnv);
      if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
        port = parsed;
      } else {
        console.warn(
          `Ignoring MCP_CONFORMANCE_AUTH_SERVER_PORT="${portEnv}" (not a ` +
            `valid port); using default port ${DEFAULT_MOCK_AUTH_SERVER_PORT}.`
        );
      }
    }

    let mockAs: MockAuthorizationServer;
    try {
      mockAs = await startMockAuthorizationServer(port);
    } catch (error) {
      for (const key of ['validAccepted', ...TOKEN_CHECK_KEYS] as const) {
        const def = CHECKS[key];
        checks.push(
          untestableCheck(
            def.id,
            def.name,
            def.description,
            `Could not start the mock authorization server on port ${port}: ` +
              `${error instanceof Error ? error.message : String(error)}. ` +
              `Set MCP_CONFORMANCE_AUTH_SERVER_PORT to a free port.`,
            def.specReferences
          )
        );
      }
      return checks;
    }

    try {
      // Baseline: a valid token — trusted signature, this server's canonical
      // URI as audience, unexpired. Its acceptance is what makes the
      // rejection checks below evidence of targeted validation rather than
      // blanket rejection.
      const validToken = await mockAs.signToken({ audience: serverUrl });
      let validResponse: ProbeResponse | undefined;
      let validProbeError: unknown;
      try {
        validResponse = await sendProbe(serverUrl, specVersion, validToken);
      } catch (error) {
        validProbeError = error;
      }
      const accepted =
        validResponse !== undefined &&
        validResponse.status >= 200 &&
        validResponse.status < 300;

      checks.push({
        ...CHECKS.validAccepted,
        status: accepted ? 'SUCCESS' : 'FAILURE',
        timestamp: timestamp(),
        ...(!accepted && {
          errorMessage:
            validResponse === undefined
              ? `Request with the baseline valid token failed: ${
                  validProbeError instanceof Error
                    ? validProbeError.message
                    : String(validProbeError)
                }`
              : `Server rejected a valid access token (HTTP ` +
                `${validResponse.status}) issued by ${mockAs.issuer} with ` +
                `aud="${serverUrl}". If the server is not configured to ` +
                `trust the conformance mock authorization server, see the ` +
                `scenario description for the setup contract.`
        }),
        details: {
          statusCode: validResponse?.status,
          issuer: mockAs.issuer,
          audience: serverUrl,
          wwwAuthenticate: validResponse?.wwwAuthenticate
        }
      });

      if (!accepted) {
        // Rejection of the targeted tokens below would be indistinguishable
        // from blanket rejection, so the audience checks cannot be exercised.
        for (const key of TOKEN_CHECK_KEYS) {
          const def = CHECKS[key];
          checks.push(
            untestableCheck(
              def.id,
              def.name,
              def.description,
              'the server rejected the baseline valid token, so targeted ' +
                'rejection cannot be distinguished from blanket rejection. ' +
                'Configure the server under test to trust the conformance ' +
                'mock authorization server (see scenario description).',
              def.specReferences
            )
          );
        }
        return checks;
      }

      const rejectionCases: {
        key: (typeof TOKEN_CHECK_KEYS)[number];
        token: string;
        tokenDescription: string;
      }[] = [
        {
          key: 'wrongAudience',
          token: await mockAs.signToken({
            audience: 'https://another-resource.example.com/mcp'
          }),
          tokenDescription:
            'validly-signed token with aud="https://another-resource.example.com/mcp"'
        },
        {
          key: 'missingAudience',
          token: await mockAs.signToken({}),
          tokenDescription: 'validly-signed token with no aud claim'
        },
        {
          key: 'expired',
          token: await mockAs.signToken({
            audience: serverUrl,
            expiresInSeconds: -600
          }),
          tokenDescription:
            'token with correct audience that expired 10 minutes ago'
        },
        {
          key: 'untrusted',
          token: await mockAs.signTokenWithUntrustedKey({
            audience: serverUrl
          }),
          tokenDescription:
            'token with correct audience signed by a key absent from the JWKS'
        }
      ];

      for (const { key, token, tokenDescription } of rejectionCases) {
        const def = CHECKS[key];
        let response: ProbeResponse;
        try {
          response = await sendProbe(serverUrl, specVersion, token);
        } catch (error) {
          // A timeout or connection reset on one probe must not throw away
          // the checks already collected (mirrors the DNS-rebinding pattern).
          checks.push({
            ...def,
            status: 'FAILURE',
            timestamp: timestamp(),
            errorMessage: `Request with a ${tokenDescription} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            details: { token: tokenDescription }
          });
          continue;
        }
        const rejectedWith401 = response.status === 401;

        checks.push({
          ...def,
          status: rejectedWith401 ? 'SUCCESS' : 'FAILURE',
          timestamp: timestamp(),
          ...(!rejectedWith401 && {
            errorMessage:
              response.status >= 200 && response.status < 300
                ? `Server accepted a ${tokenDescription} (HTTP ` +
                  `${response.status}); it MUST be rejected`
                : `Server rejected a ${tokenDescription} with HTTP ` +
                  `${response.status}; invalid or expired tokens MUST ` +
                  `receive a HTTP 401 response`
          }),
          details: {
            statusCode: response.status,
            token: tokenDescription,
            wwwAuthenticate: response.wwwAuthenticate
          }
        });
      }
    } finally {
      await mockAs.close();
    }

    return checks;
  }
}
