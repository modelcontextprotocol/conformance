/**
 * Server-side Protected Resource Metadata discovery (RFC 9728).
 *
 * The harness plays an MCP client with no token: one unauthenticated POST to
 * the MCP endpoint, then metadata discovery in client order. Seven checks come
 * from those few requests. A server that answers the probe with 2xx is not
 * configured for authorization, so every check is reported untestable (#248).
 */

import {
  ClientScenario,
  ConformanceCheck,
  type SpecReference
} from '../../../types';
import type { RunContext } from '../../../connection';
import { terminateSessionRaw } from '../../../connection/sdk-client';
import { untestableCheck } from '../../untestable';
import { SpecReferences } from './spec-references';
import {
  acceptedResources,
  challengeParam,
  discoverProtectedResourceMetadata,
  isJsonContentType,
  probeUnauthenticated,
  type MetadataAttempt,
  type MetadataDiscovery,
  type UnauthenticatedProbe
} from './prm';

const CHALLENGE_REFERENCES: SpecReference[] = [
  SpecReferences.MCP_AUTH_ERROR_HANDLING,
  SpecReferences.RFC_9728_WWW_AUTHENTICATE
];

const DISCOVERY_REFERENCES: SpecReference[] = [
  SpecReferences.MCP_PRM_DISCOVERY_REQUIREMENTS,
  SpecReferences.RFC_9728_WWW_AUTHENTICATE
];

const RESPONSE_REFERENCES: SpecReference[] = [
  SpecReferences.MCP_AUTHORIZATION_SERVER_LOCATION,
  SpecReferences.RFC_9728_RESPONSE
];

const RESOURCE_REFERENCES: SpecReference[] = [
  SpecReferences.MCP_AUTHORIZATION_SERVER_LOCATION,
  SpecReferences.RFC_9728_VALIDATION
];

const AUTHORIZATION_SERVERS_REFERENCES: SpecReference[] = [
  SpecReferences.MCP_AUTHORIZATION_SERVER_LOCATION
];

const SCOPE_REFERENCES: SpecReference[] = [
  SpecReferences.MCP_SCOPE_SELECTION_STRATEGY
];

// The array parameters RFC 9728 §2 defines that §3.2 ("Parameters with zero
// values MUST be omitted from the response") applies to. Left out on purpose:
// bearer_methods_supported, because §2 says "The empty array [] can be used to
// indicate that no bearer methods are supported"; and any parameter §2 does
// not define. The MUST has no carve-out for those, but the harness cannot know
// what [] means in someone else's parameter, and §3.2 tells readers to ignore
// parameters they do not understand.
const ZERO_VALUE_PARAMETERS = [
  'authorization_servers',
  'scopes_supported',
  'resource_signing_alg_values_supported',
  'authorization_details_types_supported',
  'dpop_signing_alg_values_supported'
];

interface CheckSpec {
  id: string;
  name: string;
  description: string;
  specReferences: SpecReference[];
  severity: 'FAILURE' | 'WARNING';
}

const CHECKS = {
  auth401: {
    id: 'server-auth-401',
    name: 'ServerAuth401',
    description:
      'Server answers an unauthenticated request with 401 and a WWW-Authenticate header',
    specReferences: CHALLENGE_REFERENCES,
    severity: 'FAILURE'
  },
  discovery: {
    id: 'server-prm-discovery',
    name: 'ServerPrmDiscovery',
    description:
      'Protected resource metadata is reachable via the resource_metadata challenge parameter or a well-known URI',
    specReferences: DISCOVERY_REFERENCES,
    severity: 'FAILURE'
  },
  response: {
    id: 'server-prm-response',
    name: 'ServerPrmResponse',
    description:
      'Protected resource metadata is served as HTTP 200 application/json with a JSON object body',
    specReferences: RESPONSE_REFERENCES,
    severity: 'FAILURE'
  },
  resource: {
    id: 'server-prm-resource',
    name: 'ServerPrmResource',
    description:
      'Protected resource metadata resource field identifies the MCP server',
    specReferences: RESOURCE_REFERENCES,
    severity: 'FAILURE'
  },
  authorizationServers: {
    id: 'server-prm-authorization-servers',
    name: 'ServerPrmAuthorizationServers',
    description:
      'Protected resource metadata lists at least one authorization server',
    specReferences: AUTHORIZATION_SERVERS_REFERENCES,
    severity: 'FAILURE'
  },
  noEmptyParameters: {
    id: 'server-prm-no-empty-parameters',
    name: 'ServerPrmNoEmptyParameters',
    description:
      'Protected resource metadata omits array parameters with zero values; bearer_methods_supported may be empty',
    specReferences: RESPONSE_REFERENCES,
    severity: 'FAILURE'
  },
  scope: {
    id: 'server-www-authenticate-scope',
    name: 'ServerWwwAuthenticateScope',
    description:
      'The 401 challenge includes a scope parameter (servers SHOULD include one)',
    specReferences: SCOPE_REFERENCES,
    severity: 'WARNING'
  }
} as const satisfies Record<string, CheckSpec>;

export const PRM_DECLARED_CHECK_IDS: string[] = Object.values(CHECKS).map(
  (check) => check.id
);

function check(
  spec: CheckSpec,
  errorMessage: string | undefined,
  details: Record<string, unknown>
): ConformanceCheck {
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    status: errorMessage === undefined ? 'SUCCESS' : spec.severity,
    timestamp: new Date().toISOString(),
    specReferences: spec.specReferences,
    details,
    ...(errorMessage === undefined ? {} : { errorMessage })
  };
}

function untestable(spec: CheckSpec, reason: string): ConformanceCheck {
  return untestableCheck(
    spec.id,
    spec.name,
    spec.description,
    reason,
    spec.specReferences,
    spec.severity
  );
}

function attemptSummary(attempt: MetadataAttempt): Record<string, unknown> {
  return {
    source: attempt.source,
    url: attempt.url,
    ...(attempt.url === attempt.requestedUrl
      ? {}
      : { requestedUrl: attempt.requestedUrl }),
    statusCode: attempt.statusCode,
    contentType: attempt.contentType ?? null,
    ...(attempt.error ? { error: attempt.error } : {})
  };
}

function describeMiss(attempt: MetadataAttempt): string {
  if (attempt.error) return `${attempt.url} failed: ${attempt.error}`;
  return `${attempt.url} answered HTTP ${attempt.statusCode}`;
}

function gradeDiscovery(
  discovery: MetadataDiscovery,
  specVersion: string
): ConformanceCheck {
  const { challengeUrl, found, attempts } = discovery;
  const details = {
    specVersion,
    resourceMetadata: challengeUrl ?? null,
    attempts: attempts.map(attemptSummary)
  };
  const challengeAttempt = attempts.find(
    (attempt) => attempt.source === 'resource_metadata'
  );

  if (challengeUrl !== undefined) {
    if (!challengeAttempt) {
      return check(
        CHECKS.discovery,
        `resource_metadata in the WWW-Authenticate challenge is not a URL: ${challengeUrl}`,
        details
      );
    }
    if (challengeAttempt.statusCode !== 200) {
      return check(
        CHECKS.discovery,
        `the WWW-Authenticate challenge names ${challengeUrl} but ${describeMiss(challengeAttempt)}`,
        details
      );
    }
    return check(CHECKS.discovery, undefined, details);
  }

  // 2025-06-18 only knows the header form; "one of" header or well-known
  // arrived in 2025-11-25.
  if (specVersion === '2025-06-18') {
    return check(
      CHECKS.discovery,
      'the 401 challenge carries no resource_metadata parameter; spec version 2025-06-18 requires the metadata URL in WWW-Authenticate',
      details
    );
  }
  if (!found) {
    return check(
      CHECKS.discovery,
      `no resource_metadata parameter in the challenge and no metadata at ${attempts
        .map(describeMiss)
        .join(' or ')}`,
      details
    );
  }
  return check(CHECKS.discovery, undefined, details);
}

function gradeResponse(found: MetadataAttempt): ConformanceCheck {
  const details = {
    ...attemptSummary(found),
    bodyPreview: found.text.slice(0, 200)
  };
  if (!isJsonContentType(found.contentType)) {
    return check(
      CHECKS.response,
      `Content-Type is ${found.contentType ?? 'missing'}, not application/json`,
      details
    );
  }
  if (!found.doc) {
    return check(CHECKS.response, 'body is not a JSON object', details);
  }
  return check(CHECKS.response, undefined, details);
}

function gradeResource(
  doc: Record<string, unknown>,
  resourceUrl: string,
  metadataUrl: string
): ConformanceCheck {
  const allowed = acceptedResources(resourceUrl, metadataUrl);
  const details = { resource: doc.resource ?? null, accepted: allowed };
  if (doc.resource === undefined) {
    return check(
      CHECKS.resource,
      `resource is missing (expected ${allowed.join(' or ')})`,
      details
    );
  }
  if (typeof doc.resource !== 'string' || !allowed.includes(doc.resource)) {
    return check(
      CHECKS.resource,
      `resource ${JSON.stringify(doc.resource)} does not identify the server (expected ${allowed.join(' or ')})`,
      details
    );
  }
  return check(CHECKS.resource, undefined, details);
}

function gradeAuthorizationServers(
  doc: Record<string, unknown>
): ConformanceCheck {
  const servers = doc.authorization_servers;
  const details = { authorization_servers: servers ?? null };
  if (servers === undefined) {
    return check(
      CHECKS.authorizationServers,
      'authorization_servers is missing',
      details
    );
  }
  if (!Array.isArray(servers)) {
    return check(
      CHECKS.authorizationServers,
      'authorization_servers is not an array',
      details
    );
  }
  if (servers.length === 0) {
    return check(
      CHECKS.authorizationServers,
      'authorization_servers is empty',
      details
    );
  }
  const invalid = servers.filter((entry) => {
    if (typeof entry !== 'string') return true;
    try {
      new URL(entry);
      return false;
    } catch {
      return true;
    }
  });
  if (invalid.length > 0) {
    return check(
      CHECKS.authorizationServers,
      `authorization_servers contains entries that are not URLs: ${JSON.stringify(invalid)}`,
      details
    );
  }
  return check(CHECKS.authorizationServers, undefined, details);
}

function gradeNoEmptyParameters(
  doc: Record<string, unknown>
): ConformanceCheck {
  const empty = ZERO_VALUE_PARAMETERS.filter((parameter) => {
    const value = doc[parameter];
    return Array.isArray(value) && value.length === 0;
  });
  const details = { empty };
  if (empty.length > 0) {
    return check(
      CHECKS.noEmptyParameters,
      `parameters with zero values must be omitted, found empty: ${empty.join(', ')}`,
      details
    );
  }
  return check(CHECKS.noEmptyParameters, undefined, details);
}

function gradeScope(
  probe: UnauthenticatedProbe,
  specVersion: string
): ConformanceCheck {
  const details = { wwwAuthenticate: probe.wwwAuthenticate ?? null };
  // The SHOULD first appears in 2025-11-25 ("Scope Selection Strategy");
  // 2025-06-18 says nothing about scope in the challenge, so the check is
  // not applicable there rather than untestable.
  if (specVersion === '2025-06-18') {
    return {
      ...check(CHECKS.scope, undefined, { ...details, specVersion }),
      status: 'SKIPPED',
      errorMessage:
        'not graded at spec version 2025-06-18: the scope parameter SHOULD first appears in 2025-11-25'
    };
  }
  if (!probe.wwwAuthenticate) {
    return check(
      CHECKS.scope,
      'no WWW-Authenticate header to carry a scope parameter',
      details
    );
  }
  const scope = challengeParam(probe.wwwAuthenticate, 'scope');
  if (scope === undefined || scope.trim().length === 0) {
    return check(
      CHECKS.scope,
      'WWW-Authenticate challenge has no scope parameter',
      details
    );
  }
  return check(CHECKS.scope, undefined, { ...details, scope });
}

export class ProtectedResourceMetadataScenario implements ClientScenario {
  name = 'auth/protected-resource-metadata';
  readonly source = { introducedIn: '2025-06-18' } as const;
  description = `Test that an MCP server which requires authorization publishes usable Protected Resource Metadata (RFC 9728).

The harness sends one unauthenticated request to the MCP endpoint, then looks for the metadata the way a client does: the \`resource_metadata\` URL from the \`WWW-Authenticate\` challenge, then the path-based well-known URL, then the root one.

**Server Implementation Requirements:**
- An unauthenticated request **MUST** get \`401 Unauthorized\` with a \`WWW-Authenticate\` header
- The metadata **MUST** be discoverable: via \`resource_metadata\` in the challenge, or at a well-known URI (2025-11-25 and later; 2025-06-18 requires the challenge parameter)
- The metadata response **MUST** be HTTP 200 \`application/json\` with a JSON object body (RFC 9728 §3.2)
- \`resource\` **MUST** identify the MCP server (RFC 9728 §3.3); for metadata at the root well-known URL the origin is accepted
- \`authorization_servers\` **MUST** contain at least one authorization server
- Array parameters with zero values **MUST** be omitted (RFC 9728 §3.2); \`bearer_methods_supported\` is exempt, RFC 9728 §2 allows \`[]\` there
- The challenge **SHOULD** include a \`scope\` parameter (2025-11-25 and later; SKIPPED at 2025-06-18)

**Prerequisite:** the server under test must require authorization. A 2xx to the unauthenticated request makes every check untestable. Each request is bounded to 10 s; a server that holds a stream open fails the checks it blocks with a reason naming the timeout.`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const { serverUrl, specVersion } = ctx;
    const all = Object.values(CHECKS);

    let probe: UnauthenticatedProbe;
    try {
      probe = await probeUnauthenticated(serverUrl, specVersion);
    } catch (error) {
      const reason = `unauthenticated probe to ${serverUrl} failed: ${error instanceof Error ? error.message : String(error)}`;
      return all.map((spec) => untestable(spec, reason));
    }
    if (probe.sessionId !== undefined) {
      // The probe was accepted and opened a session; do not leave it behind.
      await terminateSessionRaw(serverUrl, probe.sessionId, specVersion);
    }

    if (probe.statusCode >= 200 && probe.statusCode < 300) {
      const reason = `server answered the unauthenticated request with HTTP ${probe.statusCode}; it does not require authorization`;
      return all.map((spec) => untestable(spec, reason));
    }

    const checks: ConformanceCheck[] = [];
    const probeDetails = {
      statusCode: probe.statusCode,
      wwwAuthenticate: probe.wwwAuthenticate ?? null
    };
    if (probe.statusCode !== 401) {
      checks.push(
        check(
          CHECKS.auth401,
          `expected HTTP 401 for a missing token, got ${probe.statusCode}`,
          probeDetails
        )
      );
    } else if (!probe.wwwAuthenticate) {
      checks.push(
        check(
          CHECKS.auth401,
          '401 response has no WWW-Authenticate header',
          probeDetails
        )
      );
    } else {
      checks.push(check(CHECKS.auth401, undefined, probeDetails));
    }

    const discovery = await discoverProtectedResourceMetadata(
      serverUrl,
      probe.wwwAuthenticate
    );
    checks.push(gradeDiscovery(discovery, specVersion));

    const { found } = discovery;
    if (!found) {
      const reason = `no protected resource metadata found at ${discovery.attempts
        .map(describeMiss)
        .join(' or ')}`;
      checks.push(untestable(CHECKS.response, reason));
      checks.push(untestable(CHECKS.resource, reason));
      checks.push(untestable(CHECKS.authorizationServers, reason));
      checks.push(untestable(CHECKS.noEmptyParameters, reason));
    } else {
      checks.push(gradeResponse(found));
      if (!found.doc) {
        const reason = `metadata at ${found.url} is not a JSON object`;
        checks.push(untestable(CHECKS.resource, reason));
        checks.push(untestable(CHECKS.authorizationServers, reason));
        checks.push(untestable(CHECKS.noEmptyParameters, reason));
      } else {
        checks.push(gradeResource(found.doc, serverUrl, found.url));
        checks.push(gradeAuthorizationServers(found.doc));
        checks.push(gradeNoEmptyParameters(found.doc));
      }
    }

    checks.push(gradeScope(probe, specVersion));
    return checks;
  }
}
