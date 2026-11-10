import type { ConformanceCheck } from '../../../../types';
import { SpecReferences } from '../spec-references';

/**
 * What a scenario's mock servers observed about the RFC 8707 `resource`
 * parameter: the values the client sent to the authorization and token
 * endpoints, and the identifier the protected resource metadata served.
 */
export interface ResourceParameterObservation {
  /** `resource` query parameter the client sent to the authorization endpoint. */
  authorizationResource?: string;
  /** `resource` form parameter the client sent to the token endpoint. */
  tokenResource?: string;
  /** `resource` value the protected resource metadata document served. */
  prmResource?: string;
}

/**
 * RFC 8707 resource-parameter checks, shared by every client-auth scenario
 * whose mock servers observe the authorization and token requests. The check
 * IDs are stable across scenarios so one slug finds every emission.
 *
 * Each check is emitted once per scenario run; a check already present under
 * the same id is left alone.
 */
export function addResourceParameterChecks(
  checks: ConformanceCheck[],
  observed: ResourceParameterObservation,
  timestamp: string
): void {
  const { authorizationResource, tokenResource, prmResource } = observed;
  const specRefs = [
    SpecReferences.RFC_8707_RESOURCE_INDICATORS,
    SpecReferences.MCP_RESOURCE_PARAMETER
  ];

  // Check 1: Resource parameter in authorization request
  if (!checks.some((c) => c.id === 'resource-parameter-in-authorization')) {
    const hasResource = !!authorizationResource;
    checks.push({
      id: 'resource-parameter-in-authorization',
      name: 'Resource parameter in authorization request',
      description: hasResource
        ? 'Client included resource parameter in authorization request'
        : 'Client MUST include resource parameter in authorization request per RFC 8707',
      status: hasResource ? 'SUCCESS' : 'FAILURE',
      timestamp,
      specReferences: specRefs,
      details: {
        resource: authorizationResource || 'not provided'
      }
    });
  }

  // Check 2: Resource parameter in token request
  if (!checks.some((c) => c.id === 'resource-parameter-in-token')) {
    const hasResource = !!tokenResource;
    checks.push({
      id: 'resource-parameter-in-token',
      name: 'Resource parameter in token request',
      description: hasResource
        ? 'Client included resource parameter in token request'
        : 'Client MUST include resource parameter in token request per RFC 8707',
      status: hasResource ? 'SUCCESS' : 'FAILURE',
      timestamp,
      specReferences: specRefs,
      details: {
        resource: tokenResource || 'not provided'
      }
    });
  }

  // Check 3: Resource parameter is valid canonical URI
  if (!checks.some((c) => c.id === 'resource-parameter-valid-uri')) {
    const resourceToValidate = authorizationResource || tokenResource;
    if (resourceToValidate) {
      const validation = validateCanonicalUri(resourceToValidate);
      checks.push({
        id: 'resource-parameter-valid-uri',
        name: 'Resource parameter is valid canonical URI',
        description: validation.valid
          ? 'Resource parameter is a valid canonical URI (has scheme, no fragment)'
          : `Resource parameter is invalid: ${validation.error}`,
        status: validation.valid ? 'SUCCESS' : 'FAILURE',
        timestamp,
        specReferences: specRefs,
        details: {
          resource: resourceToValidate,
          ...(validation.error && { error: validation.error })
        }
      });
    }
  }

  // Check 4: Resource parameter consistency between requests
  if (!checks.some((c) => c.id === 'resource-parameter-consistency')) {
    if (authorizationResource && tokenResource) {
      const consistent = authorizationResource === tokenResource;
      checks.push({
        id: 'resource-parameter-consistency',
        name: 'Resource parameter consistency',
        description: consistent
          ? 'Resource parameter is consistent between authorization and token requests'
          : 'Resource parameter MUST be consistent between authorization and token requests',
        status: consistent ? 'SUCCESS' : 'FAILURE',
        timestamp,
        specReferences: specRefs,
        details: {
          authorizationResource,
          tokenResource
        }
      });
    }
  }

  // Check 5: Resource parameter equals the identifier published in PRM.
  // The MCP spec requires the canonical URI, which it defines as the RFC 9728
  // `resource` value; RFC 9728 §3.3 requires that value to be identical to the
  // identifier the client used. Re-serializing it through a URL parser is the
  // usual way to break this: `new URL('https://example.com').href` is
  // `https://example.com/`, and authorization servers that match the
  // indicator exactly reject the extra slash.
  if (!checks.some((c) => c.id === 'resource-parameter-matches-prm')) {
    const sent: Array<[request: string, value: string]> = [];
    if (authorizationResource !== undefined) {
      sent.push(['authorization', authorizationResource]);
    }
    if (tokenResource !== undefined) {
      sent.push(['token', tokenResource]);
    }
    if (prmResource !== undefined && sent.length > 0) {
      const mismatched = sent
        .filter(([, value]) => value !== prmResource)
        .map(([request]) => request);
      const matches = mismatched.length === 0;
      const errorMessage = `Client MUST send the resource identifier exactly as published in protected resource metadata; the ${mismatched.join(' and ')} request sent a different value (a URL parser that appends "/" to a pathless identifier is the usual cause)`;
      checks.push({
        id: 'resource-parameter-matches-prm',
        name: 'Resource parameter matches protected resource metadata',
        description: matches
          ? 'Client sent the resource identifier exactly as published in protected resource metadata'
          : errorMessage,
        status: matches ? 'SUCCESS' : 'FAILURE',
        timestamp,
        specReferences: [
          ...specRefs,
          SpecReferences.MCP_CANONICAL_SERVER_URI,
          SpecReferences.RFC_9728_RESOURCE_IDENTITY
        ],
        ...(!matches && { errorMessage }),
        details: {
          prmResource,
          authorizationResource: authorizationResource ?? 'not provided',
          tokenResource: tokenResource ?? 'not provided'
        }
      });
    }
  }
}

function validateCanonicalUri(uri: string): {
  valid: boolean;
  error?: string;
} {
  try {
    const parsed = new URL(uri);
    // Check for fragment (RFC 8707: MUST NOT include fragment)
    if (parsed.hash) {
      return {
        valid: false,
        error: 'contains fragment (not allowed per RFC 8707)'
      };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: 'invalid URI format' };
  }
}
