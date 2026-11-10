import {
  type ClientScenario,
  type ConformanceCheck,
  DRAFT_PROTOCOL_VERSION
} from '../../types';
import {
  buildStandardHeaders,
  sendStatelessRequest,
  withRequestMeta,
  type RunContext,
  type StatelessResponse
} from '../../connection';

export const SCOPE_CHALLENGE_LOW_TOKEN = 'mcp-conformance-scope-low';
export const SCOPE_CHALLENGE_FULL_TOKEN = 'mcp-conformance-scope-full';

interface ScopeChallengeFixture {
  key: string;
  label: string;
  method: string;
  params: Record<string, unknown>;
  requiredScopes: readonly [string, string];
  validateResult(result: Record<string, unknown>): string | undefined;
}

function firstArrayItem(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined;
  const first = value[0];
  return typeof first === 'object' && first !== null
    ? (first as Record<string, unknown>)
    : undefined;
}

export const SCOPE_CHALLENGE_FIXTURES: readonly ScopeChallengeFixture[] = [
  {
    key: 'tool',
    label: 'Tool',
    method: 'tools/call',
    params: { name: 'test_simple_text' },
    requiredScopes: [
      'mcp:conformance:tools:call',
      'mcp:conformance:tools:test_simple_text'
    ],
    validateResult: (result) => {
      const content = firstArrayItem(result.content);
      return content?.type === 'text' && typeof content.text === 'string'
        ? undefined
        : 'Expected the test_simple_text tool result';
    }
  },
  {
    key: 'static-resource',
    label: 'Static resource',
    method: 'resources/read',
    params: { uri: 'test://static-text' },
    requiredScopes: [
      'mcp:conformance:resources:read',
      'mcp:conformance:resources:static'
    ],
    validateResult: (result) => {
      const content = firstArrayItem(result.contents);
      return content?.uri === 'test://static-text' &&
        typeof content.text === 'string'
        ? undefined
        : 'Expected the test://static-text resource result';
    }
  },
  {
    key: 'template-resource',
    label: 'Template resource',
    method: 'resources/read',
    params: { uri: 'test://template/123/data' },
    requiredScopes: [
      'mcp:conformance:resources:read',
      'mcp:conformance:resources:template:123'
    ],
    validateResult: (result) => {
      const content = firstArrayItem(result.contents);
      return content?.uri === 'test://template/123/data' &&
        typeof content.text === 'string' &&
        content.text.includes('123')
        ? undefined
        : 'Expected the template-expanded test://template/123/data resource result';
    }
  },
  {
    key: 'prompt',
    label: 'Prompt',
    method: 'prompts/get',
    params: { name: 'test_simple_prompt' },
    requiredScopes: [
      'mcp:conformance:prompts:get',
      'mcp:conformance:prompts:test_simple_prompt'
    ],
    validateResult: (result) => {
      const message = firstArrayItem(result.messages);
      return message?.role === 'user' &&
        typeof message.content === 'object' &&
        message.content !== null
        ? undefined
        : 'Expected the test_simple_prompt result';
    }
  }
];

const SPEC_REFERENCE = {
  id: 'MCP-Authorization-Runtime-Insufficient-Scope',
  url: 'https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#runtime-insufficient-scope-errors'
};

export interface ParsedChallenge {
  scheme: string;
  params: Record<string, string>;
}

interface ChallengeResponse {
  status: number;
  wwwAuthenticate: string | null;
  body?: unknown;
}

function splitOutsideQuotes(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;

  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && char === ',') {
      parts.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }

  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function parseAuthParam(part: string): [string, string] | undefined {
  const match = part.match(
    /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)\s*=\s*(?:"((?:\\.|[^"])*)"|([!#$%&'*+\-.^_`|~0-9A-Za-z]+))$/
  );
  if (!match) return undefined;
  const value = match[2]?.replace(/\\(.)/g, '$1') ?? match[3];
  return [match[1].toLowerCase(), value];
}

export function parseBearerChallenge(
  value: string | null
): ParsedChallenge | undefined {
  if (!value) return undefined;

  let current: ParsedChallenge | undefined;
  for (const part of splitOutsideQuotes(value)) {
    const challenge = part.match(
      /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)(?:\s+(.*))?$/
    );
    const parameter = parseAuthParam(part);

    if (challenge && !parameter) {
      if (current?.scheme.toLowerCase() === 'bearer') return current;
      current = { scheme: challenge[1], params: {} };
      const firstParam = challenge[2]
        ? parseAuthParam(challenge[2])
        : undefined;
      if (firstParam) current.params[firstParam[0]] = firstParam[1];
      continue;
    }

    if (current && parameter) {
      current.params[parameter[0]] = parameter[1];
    }
  }

  return current?.scheme.toLowerCase() === 'bearer' ? current : undefined;
}

export function scopeChallengeResourceMetadataUrl(serverUrl: string): string {
  const resource = new URL(serverUrl);
  const metadata = new URL(resource.origin);
  metadata.pathname = `/.well-known/oauth-protected-resource${
    resource.pathname === '/' ? '' : resource.pathname
  }`;
  metadata.search = resource.search;
  return metadata.toString();
}

function resourceMetadataUrlError(
  resourceMetadata: string | undefined,
  serverUrl: string
): string | undefined {
  if (!resourceMetadata) {
    return 'The challenge did not include resource_metadata';
  }

  let metadata: URL;
  try {
    metadata = new URL(resourceMetadata);
  } catch {
    return `resource_metadata is not an absolute URL: ${resourceMetadata}`;
  }

  if (metadata.username || metadata.password) {
    return 'resource_metadata must not contain user information';
  }
  if (metadata.hash) {
    return 'resource_metadata must not contain a fragment';
  }

  const resource = new URL(serverUrl);
  const isHttps = metadata.protocol === 'https:';
  const isSameOriginHttpFixture =
    metadata.protocol === 'http:' &&
    resource.protocol === 'http:' &&
    metadata.origin === resource.origin;
  if (!isHttps && !isSameOriginHttpFixture) {
    return 'resource_metadata must use HTTPS (same-origin HTTP is accepted for local conformance fixtures)';
  }

  return undefined;
}

async function sendChallengeRequest(
  ctx: RunContext,
  fixture: ScopeChallengeFixture
): Promise<ChallengeResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  const request = {
    jsonrpc: '2.0',
    id: `scope-challenge-${fixture.key}`,
    method: fixture.method,
    params: withRequestMeta(fixture.params, ctx.specVersion)
  };

  try {
    const response = await fetch(ctx.serverUrl, {
      method: 'POST',
      headers: buildStandardHeaders(fixture.method, fixture.params, {
        specVersion: ctx.specVersion,
        headers: {
          Authorization: `Bearer ${SCOPE_CHALLENGE_LOW_TOKEN}`
        }
      }),
      body: JSON.stringify(request),
      signal: controller.signal
    });

    const wwwAuthenticate = response.headers.get('www-authenticate');
    if (response.status !== 403) {
      await response.body?.cancel().catch(() => {});
      return { status: response.status, wwwAuthenticate };
    }

    const text = await response.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // The authorization spec does not constrain the 403 body.
    }
    return { status: response.status, wwwAuthenticate, body };
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

function check(
  fixture: ScopeChallengeFixture,
  id: string,
  nameSuffix: string,
  description: string,
  passed: boolean,
  severity: 'FAILURE' | 'WARNING',
  errorMessage: string | undefined,
  details: Record<string, unknown>
): ConformanceCheck {
  return {
    id,
    name: `${fixture.label.replace(/ /g, '')}${nameSuffix}`,
    description,
    status: passed ? 'SUCCESS' : severity,
    timestamp: new Date().toISOString(),
    errorMessage: passed ? undefined : errorMessage,
    specReferences: [SPEC_REFERENCE],
    details: {
      fixture: fixture.key,
      method: fixture.method,
      params: fixture.params,
      requiredScopes: fixture.requiredScopes,
      ...details
    }
  };
}

function challengeChecks(
  fixture: ScopeChallengeFixture,
  response: ChallengeResponse | undefined,
  requestError: unknown,
  serverUrl: string
): ConformanceCheck[] {
  const parsed = parseBearerChallenge(response?.wwwAuthenticate ?? null);
  const scopes = parsed?.params.scope?.split(/\s+/).filter(Boolean) ?? [];
  const metadataError = resourceMetadataUrlError(
    parsed?.params.resource_metadata,
    serverUrl
  );
  const hasAllScopes = fixture.requiredScopes.every((scope) =>
    scopes.includes(scope)
  );
  const details = {
    responseStatus: response?.status,
    wwwAuthenticate: response?.wwwAuthenticate,
    responseBody: response?.body
  };
  const requestErrorMessage =
    requestError instanceof Error ? requestError.message : String(requestError);
  const completenessCheck: ConformanceCheck = parsed
    ? check(
        fixture,
        'sep-2350-server-single-challenge',
        'ScopeChallengeCompleteScopeSet',
        `${fixture.label} includes all scopes required for the operation in one challenge`,
        hasAllScopes,
        'WARNING',
        `Expected one challenge containing ${fixture.requiredScopes.join(' and ')}, got ${scopes.join(' ') || '(no scopes)'}`,
        { ...details, challengedScopes: scopes }
      )
    : {
        id: 'sep-2350-server-single-challenge',
        name: `${fixture.label.replace(/ /g, '')}ScopeChallengeCompleteScopeSet`,
        description: `${fixture.label} includes all scopes required for the operation in one challenge`,
        status: 'SKIPPED',
        timestamp: new Date().toISOString(),
        specReferences: [SPEC_REFERENCE],
        details: {
          fixture: fixture.key,
          method: fixture.method,
          params: fixture.params,
          requiredScopes: fixture.requiredScopes,
          ...details,
          note: 'No parseable Bearer challenge; the prerequisite challenge check reports the missing or malformed header'
        }
      };

  return [
    check(
      fixture,
      'server-scope-challenge-http-403',
      'ScopeChallengeHttp403',
      `${fixture.label} returns HTTP 403 for a valid under-scoped token`,
      response?.status === 403,
      'WARNING',
      response
        ? `Expected HTTP 403, got ${response.status}`
        : `Request failed: ${requestErrorMessage}`,
      details
    ),
    check(
      fixture,
      'server-scope-challenge-www-authenticate',
      'ScopeChallengeWwwAuthenticate',
      `${fixture.label} returns a Bearer insufficient_scope challenge with protected-resource metadata`,
      parsed?.params.error === 'insufficient_scope' &&
        metadataError === undefined,
      'WARNING',
      parsed
        ? `Expected error="insufficient_scope" and a valid resource_metadata URL, got ${response?.wwwAuthenticate ?? '(missing header)'}${metadataError ? ` (${metadataError})` : ''}`
        : `Expected a Bearer WWW-Authenticate challenge, got ${response?.wwwAuthenticate ?? '(missing header)'}`,
      {
        ...details,
        resourceMetadata: parsed?.params.resource_metadata,
        metadataError
      }
    ),
    completenessCheck
  ];
}

function retryCheck(
  fixture: ScopeChallengeFixture,
  response: StatelessResponse | undefined,
  requestError: unknown
): ConformanceCheck {
  const result = response?.body?.result;
  const resultError =
    result === undefined
      ? 'Response did not contain an MCP result'
      : fixture.validateResult(result);
  const passed =
    response?.status === 200 &&
    response.body?.error === undefined &&
    resultError === undefined;
  const requestErrorMessage =
    requestError instanceof Error ? requestError.message : String(requestError);

  return check(
    fixture,
    'server-scope-challenge-upgraded-retry',
    'ScopeChallengeUpgradedRetry',
    `${fixture.label} succeeds when the same operation is retried with the full-scope token`,
    passed,
    'FAILURE',
    response
      ? `Expected HTTP 200 with the normal MCP result, got HTTP ${response.status}: ${resultError ?? response.body?.error?.message ?? response.text ?? 'unknown response'}`
      : `Retry failed: ${requestErrorMessage}`,
    {
      responseStatus: response?.status,
      responseBody: response?.body,
      responseText: response?.text
    }
  );
}

export class ServerScopeChallengeScenario implements ClientScenario {
  name = 'sep-2350-server-scope-challenge';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  description = `Test request-time OAuth insufficient_scope challenges (SEP-2350).

**Server fixture contract:**
- Keep unauthenticated behavior unchanged for the existing conformance scenarios.
- Treat \`${SCOPE_CHALLENGE_LOW_TOKEN}\` as a valid opaque token with only
  \`mcp:conformance:baseline\`.
- Treat \`${SCOPE_CHALLENGE_FULL_TOKEN}\` as a valid opaque token containing every
  scope required below.
- For the low token, return HTTP 403 and a Bearer \`WWW-Authenticate\` challenge
  with \`error="insufficient_scope"\`, protected-resource metadata, and all scopes
  required for the current operation in one challenge.
- Accept the full token when the same operation is retried.

The scenario exercises tools/call, resources/read for both the existing static and
template-expanded fixtures, and prompts/get. See SDK_INTEGRATION.md for the fixed
scope pairs and metadata URL rule.`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    for (const fixture of SCOPE_CHALLENGE_FIXTURES) {
      let challengeResponse: ChallengeResponse | undefined;
      let challengeError: unknown;
      try {
        challengeResponse = await sendChallengeRequest(ctx, fixture);
      } catch (error) {
        challengeError = error;
      }
      checks.push(
        ...challengeChecks(
          fixture,
          challengeResponse,
          challengeError,
          ctx.serverUrl
        )
      );

      let retryResponse: StatelessResponse | undefined;
      let retryError: unknown;
      try {
        retryResponse = await sendStatelessRequest(
          ctx.serverUrl,
          fixture.method,
          fixture.params,
          {
            specVersion: ctx.specVersion,
            headers: {
              Authorization: `Bearer ${SCOPE_CHALLENGE_FULL_TOKEN}`
            }
          }
        );
      } catch (error) {
        retryError = error;
      }
      checks.push(retryCheck(fixture, retryResponse, retryError));
    }

    return checks;
  }
}
