/**
 * PRM Resource Identifier Validation Scenario
 *
 * Tests that the "resource" field in the Protected Resource Metadata
 * is properly formatted and relates to the server URL.
 *
 * @see RFC 8707 - Resource Indicators for OAuth 2.0
 * @see MCP Authorization Specification (2025-06-18)
 */

import { ClientScenario, ConformanceCheck } from '../../../../types';
import { fetchPrm } from '../helpers/as-metadata';
import { ServerAuthSpecReferences } from '../spec-references';

/**
 * Validates the "resource" field in PRM.
 *
 * Per RFC 8707 and MCP spec:
 * - "resource" MUST be a valid absolute URI
 * - "resource" SHOULD use HTTPS scheme
 * - "resource" SHOULD match or be related to the server URL
 * - "resource" MUST NOT contain a fragment component
 */
export class AuthPrmResourceValidationScenario implements ClientScenario {
  name = 'server/auth-prm-resource-validation';
  description = `Test PRM "resource" field validation.

**Prerequisites**: Server must have valid PRM endpoint.

**Checks**:
- "resource" is a valid absolute URI
- "resource" uses HTTPS scheme (recommended)
- "resource" relates to the server URL
- "resource" has no fragment component

The resource identifier is used for token audience binding.

**Spec References**:
- RFC 8707 Section 2 (Resource Parameter)
- MCP 2025-06-18 - Canonical Server URI`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const timestamp = () => new Date().toISOString();

    // Fetch PRM
    const prmResult = await fetchPrm(serverUrl);

    if (!prmResult.success || !prmResult.prm) {
      checks.push({
        id: 'auth-prm-resource-prerequisite',
        name: 'PRM Prerequisite',
        description: 'Valid PRM required to validate resource field',
        status: 'SKIPPED',
        timestamp: timestamp(),
        errorMessage:
          prmResult.error || 'Cannot fetch PRM - run auth-prm-discovery first',
        specReferences: [ServerAuthSpecReferences.RFC_9728_PRM_DISCOVERY]
      });
      return checks;
    }

    checks.push({
      id: 'auth-prm-resource-prerequisite',
      name: 'PRM Prerequisite',
      description: 'Valid PRM found',
      status: 'SUCCESS',
      timestamp: timestamp(),
      specReferences: [ServerAuthSpecReferences.RFC_9728_PRM_DISCOVERY],
      details: { prmUrl: prmResult.url }
    });

    const resource = prmResult.prm.resource;

    // Check: resource field exists and is string
    if (typeof resource !== 'string' || resource.length === 0) {
      checks.push({
        id: 'auth-prm-resource-exists',
        name: 'Resource Field Exists',
        description: 'PRM contains "resource" field',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage:
          'Missing or invalid "resource" field (must be non-empty string)',
        specReferences: [ServerAuthSpecReferences.RFC_9728_PRM_FIELDS],
        details: { resource }
      });
      return checks;
    }

    checks.push({
      id: 'auth-prm-resource-exists',
      name: 'Resource Field Exists',
      description: 'PRM contains "resource" field',
      status: 'SUCCESS',
      timestamp: timestamp(),
      specReferences: [ServerAuthSpecReferences.RFC_9728_PRM_FIELDS],
      details: { resource }
    });

    // Check: resource is a valid absolute URI
    let resourceUrl: URL | null = null;
    try {
      resourceUrl = new URL(resource);
    } catch {
      checks.push({
        id: 'auth-prm-resource-valid-uri',
        name: 'Resource Valid URI',
        description: 'Resource field is a valid absolute URI',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage: `"${resource}" is not a valid absolute URI`,
        specReferences: [ServerAuthSpecReferences.RFC_8707_RESOURCE_PARAMETER],
        details: { resource, valid: false }
      });
      return checks;
    }

    checks.push({
      id: 'auth-prm-resource-valid-uri',
      name: 'Resource Valid URI',
      description: 'Resource field is a valid absolute URI',
      status: 'SUCCESS',
      timestamp: timestamp(),
      specReferences: [ServerAuthSpecReferences.RFC_8707_RESOURCE_PARAMETER],
      details: { resource, valid: true }
    });

    // Check: resource uses HTTPS
    if (resourceUrl.protocol !== 'https:') {
      checks.push({
        id: 'auth-prm-resource-https',
        name: 'Resource Uses HTTPS',
        description: 'Resource URI uses HTTPS scheme (recommended)',
        status: 'WARNING',
        timestamp: timestamp(),
        errorMessage: `Resource uses ${resourceUrl.protocol} - HTTPS is recommended for security`,
        specReferences: [ServerAuthSpecReferences.RFC_8707_SECURITY],
        details: { resource, protocol: resourceUrl.protocol }
      });
    } else {
      checks.push({
        id: 'auth-prm-resource-https',
        name: 'Resource Uses HTTPS',
        description: 'Resource URI uses HTTPS scheme (recommended)',
        status: 'SUCCESS',
        timestamp: timestamp(),
        specReferences: [ServerAuthSpecReferences.RFC_8707_SECURITY],
        details: { resource, protocol: resourceUrl.protocol }
      });
    }

    // Check: resource has no fragment
    if (resourceUrl.hash && resourceUrl.hash.length > 0) {
      checks.push({
        id: 'auth-prm-resource-no-fragment',
        name: 'Resource No Fragment',
        description: 'Resource URI does not contain fragment component',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage:
          'Resource URI contains fragment - not allowed per RFC 8707',
        specReferences: [ServerAuthSpecReferences.RFC_8707_RESOURCE_PARAMETER],
        details: { resource, fragment: resourceUrl.hash }
      });
    } else {
      checks.push({
        id: 'auth-prm-resource-no-fragment',
        name: 'Resource No Fragment',
        description: 'Resource URI does not contain fragment component',
        status: 'SUCCESS',
        timestamp: timestamp(),
        specReferences: [ServerAuthSpecReferences.RFC_8707_RESOURCE_PARAMETER],
        details: { resource }
      });
    }

    // Check: resource relates to server URL
    let serverUrlParsed: URL;
    try {
      serverUrlParsed = new URL(serverUrl);
    } catch {
      // Can't compare, skip this check
      checks.push({
        id: 'auth-prm-resource-matches-server',
        name: 'Resource Matches Server',
        description: 'Resource URI relates to the server URL',
        status: 'SKIPPED',
        timestamp: timestamp(),
        errorMessage: 'Cannot parse server URL for comparison',
        specReferences: [ServerAuthSpecReferences.MCP_AUTH_CANONICAL_URI],
        details: { resource, serverUrl }
      });
      return checks;
    }

    // Check if resource matches server URL in various ways:
    // 1. Exact match
    // 2. Same host with resource being prefix of server
    // 3. Same host with server being prefix of resource
    const resourceBase = `${resourceUrl.protocol}//${resourceUrl.host}`;
    const serverBase = `${serverUrlParsed.protocol}//${serverUrlParsed.host}`;

    const exactMatch =
      resource === serverUrl ||
      resource === serverUrl.replace(/\/$/, '') ||
      resource.replace(/\/$/, '') === serverUrl;

    const sameHost = resourceUrl.host === serverUrlParsed.host;

    const resourceIsPrefix = serverUrl.startsWith(resource.replace(/\/$/, ''));
    const serverIsPrefix = resource.startsWith(serverUrl.replace(/\/$/, ''));

    const relatesTo =
      exactMatch || (sameHost && (resourceIsPrefix || serverIsPrefix));

    if (relatesTo) {
      checks.push({
        id: 'auth-prm-resource-matches-server',
        name: 'Resource Matches Server',
        description: 'Resource URI relates to the server URL',
        status: 'SUCCESS',
        timestamp: timestamp(),
        specReferences: [ServerAuthSpecReferences.MCP_AUTH_CANONICAL_URI],
        details: {
          resource,
          serverUrl,
          exactMatch,
          sameHost,
          relationship: exactMatch
            ? 'exact'
            : resourceIsPrefix
              ? 'resource_is_prefix'
              : 'server_is_prefix'
        }
      });
    } else if (sameHost) {
      checks.push({
        id: 'auth-prm-resource-matches-server',
        name: 'Resource Matches Server',
        description: 'Resource URI relates to the server URL',
        status: 'WARNING',
        timestamp: timestamp(),
        errorMessage:
          'Same host but paths differ significantly - verify this is intentional',
        specReferences: [ServerAuthSpecReferences.MCP_AUTH_CANONICAL_URI],
        details: {
          resource,
          serverUrl,
          resourceBase,
          serverBase,
          sameHost: true
        }
      });
    } else {
      checks.push({
        id: 'auth-prm-resource-matches-server',
        name: 'Resource Matches Server',
        description: 'Resource URI relates to the server URL',
        status: 'WARNING',
        timestamp: timestamp(),
        errorMessage: `Resource host (${resourceUrl.host}) differs from server host (${serverUrlParsed.host})`,
        specReferences: [ServerAuthSpecReferences.MCP_AUTH_CANONICAL_URI],
        details: {
          resource,
          serverUrl,
          resourceHost: resourceUrl.host,
          serverHost: serverUrlParsed.host,
          sameHost: false
        }
      });
    }

    return checks;
  }
}
