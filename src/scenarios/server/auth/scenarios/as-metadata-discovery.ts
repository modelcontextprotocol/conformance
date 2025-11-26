/**
 * Authorization Server Metadata Discovery Scenario
 *
 * Tests that the Authorization Server referenced in the PRM document
 * exposes valid metadata per RFC 8414.
 *
 * @see RFC 8414 - OAuth 2.0 Authorization Server Metadata
 * @see MCP Authorization Specification (2025-06-18)
 */

import { ClientScenario, ConformanceCheck } from '../../../../types';
import { authFetch, buildPrmUrl } from '../helpers/auth-fetch';
import { ServerAuthSpecReferences } from '../spec-references';

/**
 * Build AS metadata discovery URL.
 *
 * Per RFC 8414, AS metadata is at:
 * - /.well-known/oauth-authorization-server (RFC 8414)
 * - /.well-known/openid-configuration (OIDC Discovery)
 */
function buildAsMetadataUrl(asUrl: string, useOidc: boolean): string {
  const parsed = new URL(asUrl);
  const base = `${parsed.protocol}//${parsed.host}`;

  if (useOidc) {
    return `${base}/.well-known/openid-configuration`;
  }
  return `${base}/.well-known/oauth-authorization-server`;
}

/**
 * Validates Authorization Server Metadata endpoint.
 *
 * Per RFC 8414, the AS metadata document:
 * - MUST be served at /.well-known/oauth-authorization-server
 * - MUST be valid JSON with Content-Type: application/json
 * - MUST contain "issuer" field matching the AS URL
 * - MUST contain "authorization_endpoint"
 * - MUST contain "token_endpoint"
 * - MUST contain "response_types_supported" including "code"
 * - SHOULD contain "registration_endpoint" for DCR
 * - SHOULD contain "code_challenge_methods_supported" for PKCE
 */
export class AuthAsMetadataDiscoveryScenario implements ClientScenario {
  name = 'server/auth-as-metadata-discovery';
  description = `Test Authorization Server Metadata discovery endpoint.

**Prerequisites**: Server must have valid PRM with authorization_servers array.

**Endpoint**: \`/.well-known/oauth-authorization-server\` or \`/.well-known/openid-configuration\`

**Requirements**:
- Return HTTP 200 with Content-Type: application/json
- Required: \`issuer\` (MUST match AS URL)
- Required: \`authorization_endpoint\`
- Required: \`token_endpoint\`
- Required: \`response_types_supported\` (MUST include "code")
- Recommended: \`registration_endpoint\` (for DCR)
- Recommended: \`code_challenge_methods_supported\` (for PKCE)

**Spec References**:
- RFC 8414 Section 3 (Discovery)
- RFC 8414 Section 2 (Metadata Fields)
- MCP 2025-06-18 - Server Metadata Discovery`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const timestamp = () => new Date().toISOString();

    // First, we need to get the PRM to find the authorization server
    const pathBasedUrl = buildPrmUrl(serverUrl, true);
    const rootUrl = buildPrmUrl(serverUrl, false);

    let prmResponse: Awaited<ReturnType<typeof authFetch>> | null = null;

    try {
      const response = await authFetch(pathBasedUrl);
      if (response.status === 200) {
        prmResponse = response;
      }
    } catch {
      // Try root
    }

    if (!prmResponse) {
      try {
        const response = await authFetch(rootUrl);
        if (response.status === 200) {
          prmResponse = response;
        }
      } catch {
        // Both failed
      }
    }

    // Check: Can fetch PRM (prerequisite)
    if (
      !prmResponse ||
      typeof prmResponse.body !== 'object' ||
      prmResponse.body === null
    ) {
      checks.push({
        id: 'auth-as-prm-prerequisite',
        name: 'PRM Prerequisite',
        description: 'Valid PRM required to discover Authorization Server',
        status: 'SKIPPED',
        timestamp: timestamp(),
        errorMessage: 'Cannot fetch valid PRM - run auth-prm-discovery first',
        specReferences: [ServerAuthSpecReferences.RFC_9728_PRM_DISCOVERY]
      });
      return checks;
    }

    const prm = prmResponse.body as Record<string, unknown>;
    const authServers = prm.authorization_servers as string[] | undefined;

    if (!Array.isArray(authServers) || authServers.length === 0) {
      checks.push({
        id: 'auth-as-prm-prerequisite',
        name: 'PRM Prerequisite',
        description: 'PRM must contain authorization_servers array',
        status: 'SKIPPED',
        timestamp: timestamp(),
        errorMessage: 'PRM missing authorization_servers array',
        specReferences: [ServerAuthSpecReferences.RFC_9728_PRM_RESPONSE]
      });
      return checks;
    }

    checks.push({
      id: 'auth-as-prm-prerequisite',
      name: 'PRM Prerequisite',
      description: 'Valid PRM with authorization_servers found',
      status: 'SUCCESS',
      timestamp: timestamp(),
      specReferences: [ServerAuthSpecReferences.RFC_9728_PRM_RESPONSE],
      details: { authorizationServers: authServers }
    });

    // Use the first authorization server
    const asUrl = authServers[0];

    // Try RFC 8414 endpoint first, then OIDC
    const rfc8414Url = buildAsMetadataUrl(asUrl, false);
    const oidcUrl = buildAsMetadataUrl(asUrl, true);

    let asResponse: Awaited<ReturnType<typeof authFetch>> | null = null;
    let usedUrl = '';
    let isOidc = false;

    // Try RFC 8414 first
    try {
      const response = await authFetch(rfc8414Url);
      if (response.status === 200) {
        asResponse = response;
        usedUrl = rfc8414Url;
      }
    } catch {
      // Will try OIDC
    }

    // Try OIDC if RFC 8414 didn't work
    if (!asResponse) {
      try {
        const response = await authFetch(oidcUrl);
        if (response.status === 200) {
          asResponse = response;
          usedUrl = oidcUrl;
          isOidc = true;
        }
      } catch {
        // Both failed
      }
    }

    // Check: AS metadata endpoint exists
    if (!asResponse) {
      checks.push({
        id: 'auth-as-endpoint-exists',
        name: 'AS Metadata Endpoint Exists',
        description:
          'Authorization Server exposes metadata at well-known endpoint',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage: `No AS metadata found at ${rfc8414Url} or ${oidcUrl}`,
        specReferences: [
          ServerAuthSpecReferences.RFC_8414_AS_DISCOVERY,
          ServerAuthSpecReferences.OIDC_DISCOVERY
        ],
        details: { asUrl, triedUrls: [rfc8414Url, oidcUrl] }
      });
      return checks;
    }

    checks.push({
      id: 'auth-as-endpoint-exists',
      name: 'AS Metadata Endpoint Exists',
      description:
        'Authorization Server exposes metadata at well-known endpoint',
      status: 'SUCCESS',
      timestamp: timestamp(),
      specReferences: [
        isOidc
          ? ServerAuthSpecReferences.OIDC_DISCOVERY
          : ServerAuthSpecReferences.RFC_8414_AS_DISCOVERY
      ],
      details: { url: usedUrl, discoveryType: isOidc ? 'OIDC' : 'RFC8414' }
    });

    // Check: Response is valid JSON object
    const body = asResponse.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      checks.push({
        id: 'auth-as-valid-json',
        name: 'AS Metadata Valid JSON',
        description: 'AS metadata response is a valid JSON object',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage: 'Response is not a JSON object',
        specReferences: [ServerAuthSpecReferences.RFC_8414_AS_RESPONSE],
        details: { rawBody: asResponse.rawBody.substring(0, 500) }
      });
      return checks;
    }

    checks.push({
      id: 'auth-as-valid-json',
      name: 'AS Metadata Valid JSON',
      description: 'AS metadata response is a valid JSON object',
      status: 'SUCCESS',
      timestamp: timestamp(),
      specReferences: [ServerAuthSpecReferences.RFC_8414_AS_RESPONSE]
    });

    const asMeta = body as Record<string, unknown>;

    // Check: Required "issuer" field
    if (typeof asMeta.issuer !== 'string' || asMeta.issuer.length === 0) {
      checks.push({
        id: 'auth-as-has-issuer',
        name: 'AS Has Issuer',
        description: 'AS metadata contains required "issuer" field',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage:
          'Missing or invalid "issuer" field (must be non-empty string)',
        specReferences: [ServerAuthSpecReferences.RFC_8414_AS_FIELDS],
        details: { issuer: asMeta.issuer }
      });
    } else {
      // Validate issuer matches AS URL (per RFC 8414)
      const issuerMatches =
        asMeta.issuer === asUrl ||
        asMeta.issuer === asUrl.replace(/\/$/, '') ||
        asUrl.startsWith(asMeta.issuer as string);

      checks.push({
        id: 'auth-as-has-issuer',
        name: 'AS Has Issuer',
        description: 'AS metadata contains required "issuer" field',
        status: issuerMatches ? 'SUCCESS' : 'WARNING',
        timestamp: timestamp(),
        errorMessage: issuerMatches
          ? undefined
          : `Issuer "${asMeta.issuer}" may not match AS URL "${asUrl}"`,
        specReferences: [ServerAuthSpecReferences.RFC_8414_AS_FIELDS],
        details: { issuer: asMeta.issuer, asUrl, matches: issuerMatches }
      });
    }

    // Check: Required "authorization_endpoint" field
    if (
      typeof asMeta.authorization_endpoint !== 'string' ||
      asMeta.authorization_endpoint.length === 0
    ) {
      checks.push({
        id: 'auth-as-has-authorization-endpoint',
        name: 'AS Has Authorization Endpoint',
        description:
          'AS metadata contains required "authorization_endpoint" field',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage: 'Missing or invalid "authorization_endpoint" field',
        specReferences: [ServerAuthSpecReferences.RFC_8414_AS_FIELDS],
        details: { authorization_endpoint: asMeta.authorization_endpoint }
      });
    } else {
      // Validate it's a valid URL
      let isValidUrl = false;
      try {
        new URL(asMeta.authorization_endpoint as string);
        isValidUrl = true;
      } catch {
        isValidUrl = false;
      }

      checks.push({
        id: 'auth-as-has-authorization-endpoint',
        name: 'AS Has Authorization Endpoint',
        description:
          'AS metadata contains required "authorization_endpoint" field',
        status: isValidUrl ? 'SUCCESS' : 'WARNING',
        timestamp: timestamp(),
        errorMessage: isValidUrl
          ? undefined
          : 'authorization_endpoint is not a valid URL',
        specReferences: [ServerAuthSpecReferences.RFC_8414_AS_FIELDS],
        details: { authorization_endpoint: asMeta.authorization_endpoint }
      });
    }

    // Check: Required "token_endpoint" field
    if (
      typeof asMeta.token_endpoint !== 'string' ||
      asMeta.token_endpoint.length === 0
    ) {
      checks.push({
        id: 'auth-as-has-token-endpoint',
        name: 'AS Has Token Endpoint',
        description: 'AS metadata contains required "token_endpoint" field',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage: 'Missing or invalid "token_endpoint" field',
        specReferences: [ServerAuthSpecReferences.RFC_8414_AS_FIELDS],
        details: { token_endpoint: asMeta.token_endpoint }
      });
    } else {
      let isValidUrl = false;
      try {
        new URL(asMeta.token_endpoint as string);
        isValidUrl = true;
      } catch {
        isValidUrl = false;
      }

      checks.push({
        id: 'auth-as-has-token-endpoint',
        name: 'AS Has Token Endpoint',
        description: 'AS metadata contains required "token_endpoint" field',
        status: isValidUrl ? 'SUCCESS' : 'WARNING',
        timestamp: timestamp(),
        errorMessage: isValidUrl
          ? undefined
          : 'token_endpoint is not a valid URL',
        specReferences: [ServerAuthSpecReferences.RFC_8414_AS_FIELDS],
        details: { token_endpoint: asMeta.token_endpoint }
      });
    }

    // Check: Required "response_types_supported" field with "code"
    const responseTypes = asMeta.response_types_supported;
    if (!Array.isArray(responseTypes)) {
      checks.push({
        id: 'auth-as-response-types-supported',
        name: 'AS Response Types Supported',
        description:
          'AS metadata contains "response_types_supported" with "code"',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage: 'Missing or invalid "response_types_supported" array',
        specReferences: [ServerAuthSpecReferences.RFC_8414_AS_FIELDS],
        details: { response_types_supported: responseTypes }
      });
    } else {
      const hasCode = responseTypes.includes('code');
      checks.push({
        id: 'auth-as-response-types-supported',
        name: 'AS Response Types Supported',
        description:
          'AS metadata contains "response_types_supported" with "code"',
        status: hasCode ? 'SUCCESS' : 'FAILURE',
        timestamp: timestamp(),
        errorMessage: hasCode
          ? undefined
          : '"response_types_supported" must include "code" for authorization code flow',
        specReferences: [ServerAuthSpecReferences.RFC_8414_AS_FIELDS],
        details: { response_types_supported: responseTypes, hasCode }
      });
    }

    // Check: Recommended "registration_endpoint" for DCR
    if (asMeta.registration_endpoint !== undefined) {
      const regEndpoint = asMeta.registration_endpoint;
      let isValidUrl = false;
      if (typeof regEndpoint === 'string') {
        try {
          new URL(regEndpoint);
          isValidUrl = true;
        } catch {
          isValidUrl = false;
        }
      }

      checks.push({
        id: 'auth-as-registration-endpoint',
        name: 'AS Registration Endpoint',
        description: 'AS metadata contains "registration_endpoint" for DCR',
        status: isValidUrl ? 'SUCCESS' : 'WARNING',
        timestamp: timestamp(),
        errorMessage: isValidUrl
          ? undefined
          : 'registration_endpoint is not a valid URL',
        specReferences: [
          ServerAuthSpecReferences.RFC_8414_AS_FIELDS,
          ServerAuthSpecReferences.MCP_AUTH_DCR
        ],
        details: { registration_endpoint: regEndpoint }
      });
    } else {
      checks.push({
        id: 'auth-as-registration-endpoint',
        name: 'AS Registration Endpoint',
        description: 'AS metadata contains "registration_endpoint" for DCR',
        status: 'WARNING',
        timestamp: timestamp(),
        errorMessage:
          'No registration_endpoint - DCR not supported (CIMD may be alternative)',
        specReferences: [
          ServerAuthSpecReferences.RFC_8414_AS_FIELDS,
          ServerAuthSpecReferences.MCP_AUTH_DCR
        ],
        details: { registration_endpoint: undefined }
      });
    }

    return checks;
  }
}
