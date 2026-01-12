/**
 * Discovery Mechanism Validation Scenario
 *
 * Tests that at least one discovery mechanism is available
 * and validates consistency if multiple mechanisms are present.
 *
 * @see RFC 8414 - OAuth 2.0 Authorization Server Metadata
 * @see OpenID Connect Discovery 1.0
 * @see MCP Authorization Specification (2025-06-18)
 */

import { ClientScenario, ConformanceCheck } from '../../../../types';
import { authFetch } from '../helpers/auth-fetch';
import {
  fetchPrm,
  buildAsMetadataDiscoveryAttempts
} from '../helpers/as-metadata';
import { ServerAuthSpecReferences } from '../spec-references';

/**
 * Validates discovery mechanisms are available.
 *
 * Per MCP spec and OAuth best practices:
 * - Server MUST provide at least one discovery mechanism
 * - RFC 8414: /.well-known/oauth-authorization-server
 * - OIDC: /.well-known/openid-configuration
 * - If both present, key fields should be consistent
 */
export class AuthDiscoveryMechanismScenario implements ClientScenario {
  name = 'server/auth-discovery-mechanism';
  description = `Test discovery mechanism availability.

**Prerequisites**: Server must have valid PRM with authorization_servers.

**Checks**:
- At least one discovery endpoint available:
  - RFC 8414: \`/.well-known/oauth-authorization-server\`
  - OIDC: \`/.well-known/openid-configuration\`
- If both present, validates consistency of common fields

**Spec References**:
- RFC 8414 Section 3 (Discovery)
- OIDC Discovery 1.0
- MCP 2025-06-18 - Server Metadata Discovery`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const timestamp = () => new Date().toISOString();

    // Fetch PRM to get AS URL
    const prmResult = await fetchPrm(serverUrl);

    if (!prmResult.success || !prmResult.prm) {
      checks.push({
        id: 'auth-discovery-prm-prerequisite',
        name: 'PRM Prerequisite',
        description: 'Valid PRM required to discover Authorization Server',
        status: 'SKIPPED',
        timestamp: timestamp(),
        errorMessage:
          prmResult.error || 'Cannot fetch PRM - run auth-prm-discovery first',
        specReferences: [ServerAuthSpecReferences.RFC_9728_PRM_DISCOVERY]
      });
      return checks;
    }

    const authServers = prmResult.prm.authorization_servers as
      | string[]
      | undefined;

    if (!Array.isArray(authServers) || authServers.length === 0) {
      checks.push({
        id: 'auth-discovery-prm-prerequisite',
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
      id: 'auth-discovery-prm-prerequisite',
      name: 'PRM Prerequisite',
      description: 'Valid PRM with authorization_servers found',
      status: 'SUCCESS',
      timestamp: timestamp(),
      specReferences: [ServerAuthSpecReferences.RFC_9728_PRM_RESPONSE],
      details: { authorizationServers: authServers }
    });

    const asUrl = authServers[0];

    const attempts = buildAsMetadataDiscoveryAttempts(asUrl);
    const triedUrls = attempts.map((a) => a.url);
    const rfcAttempts = attempts.filter((a) => a.kind === 'RFC8414');
    const oidcAttempts = attempts.filter((a) => a.kind === 'OIDC');

    let rfc8414Response: Awaited<ReturnType<typeof authFetch>> | null = null;
    let rfc8414Metadata: Record<string, unknown> | null = null;
    let rfc8414Url: string | undefined;

    let oidcResponse: Awaited<ReturnType<typeof authFetch>> | null = null;
    let oidcMetadata: Record<string, unknown> | null = null;
    let oidcUrl: string | undefined;

    // Try attempts in spec-defined priority order, tracking the first success
    // for each discovery mechanism type.
    for (const attempt of attempts) {
      try {
        const response = await authFetch(attempt.url);
        if (
          response.status === 200 &&
          typeof response.body === 'object' &&
          response.body !== null
        ) {
          if (
            attempt.kind === 'RFC8414' &&
            rfc8414Metadata === null &&
            rfc8414Response === null
          ) {
            rfc8414Url = attempt.url;
            rfc8414Response = response;
            rfc8414Metadata = response.body as Record<string, unknown>;
          } else if (attempt.kind === 'OIDC' && oidcMetadata === null) {
            oidcUrl = attempt.url;
            oidcResponse = response;
            oidcMetadata = response.body as Record<string, unknown>;
          }
        }
      } catch {
        // Try next
      }
    }

    const hasRfc8414 = rfc8414Metadata !== null;
    const hasOidc = oidcMetadata !== null;

    // Check: RFC 8414 endpoint
    if (hasRfc8414) {
      checks.push({
        id: 'auth-discovery-rfc8414',
        name: 'RFC 8414 Discovery',
        description: 'OAuth 2.0 AS Metadata endpoint available',
        status: 'SUCCESS',
        timestamp: timestamp(),
        specReferences: [ServerAuthSpecReferences.RFC_8414_AS_DISCOVERY],
        details: {
          url: rfc8414Url,
          status: rfc8414Response?.status,
          triedUrls: rfcAttempts.map((a) => a.url)
        }
      });
    } else {
      checks.push({
        id: 'auth-discovery-rfc8414',
        name: 'RFC 8414 Discovery',
        description: 'OAuth 2.0 AS Metadata endpoint available',
        status: 'INFO',
        timestamp: timestamp(),
        errorMessage: `No response from ${rfcAttempts.map((a) => a.url).join(' or ')}`,
        specReferences: [ServerAuthSpecReferences.RFC_8414_AS_DISCOVERY],
        details: { triedUrls: rfcAttempts.map((a) => a.url) }
      });
    }

    // Check: OIDC endpoint
    if (hasOidc) {
      checks.push({
        id: 'auth-discovery-oidc',
        name: 'OIDC Discovery',
        description: 'OpenID Connect Discovery endpoint available',
        status: 'SUCCESS',
        timestamp: timestamp(),
        specReferences: [ServerAuthSpecReferences.OIDC_DISCOVERY],
        details: {
          url: oidcUrl,
          status: oidcResponse?.status,
          triedUrls: oidcAttempts.map((a) => a.url)
        }
      });
    } else {
      checks.push({
        id: 'auth-discovery-oidc',
        name: 'OIDC Discovery',
        description: 'OpenID Connect Discovery endpoint available',
        status: 'INFO',
        timestamp: timestamp(),
        errorMessage: `No response from ${oidcAttempts.map((a) => a.url).join(' or ')}`,
        specReferences: [ServerAuthSpecReferences.OIDC_DISCOVERY],
        details: { triedUrls: oidcAttempts.map((a) => a.url) }
      });
    }

    // Check: At least one mechanism available
    if (!hasRfc8414 && !hasOidc) {
      checks.push({
        id: 'auth-discovery-any-available',
        name: 'Discovery Available',
        description: 'At least one discovery mechanism is available',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage:
          'No discovery endpoint found - AS metadata not discoverable',
        specReferences: [
          ServerAuthSpecReferences.RFC_8414_AS_DISCOVERY,
          ServerAuthSpecReferences.OIDC_DISCOVERY,
          ServerAuthSpecReferences.MCP_AUTH_SERVER_METADATA
        ],
        details: {
          rfc8414_urls: rfcAttempts.map((a) => a.url),
          oidc_urls: oidcAttempts.map((a) => a.url),
          rfc8414_available: false,
          oidc_available: false,
          triedUrls
        }
      });
      return checks;
    }

    checks.push({
      id: 'auth-discovery-any-available',
      name: 'Discovery Available',
      description: 'At least one discovery mechanism is available',
      status: 'SUCCESS',
      timestamp: timestamp(),
      specReferences: [
        ServerAuthSpecReferences.RFC_8414_AS_DISCOVERY,
        ServerAuthSpecReferences.MCP_AUTH_SERVER_METADATA
      ],
      details: {
        rfc8414_available: hasRfc8414,
        oidc_available: hasOidc,
        triedUrls,
        mechanisms: [
          ...(hasRfc8414 ? ['RFC8414'] : []),
          ...(hasOidc ? ['OIDC'] : [])
        ]
      }
    });

    // Check: If both available, validate consistency
    if (hasRfc8414 && hasOidc && rfc8414Metadata && oidcMetadata) {
      const consistencyIssues: string[] = [];

      // Check issuer consistency
      if (rfc8414Metadata.issuer !== oidcMetadata.issuer) {
        consistencyIssues.push(
          `issuer mismatch: RFC8414="${rfc8414Metadata.issuer}" vs OIDC="${oidcMetadata.issuer}"`
        );
      }

      // Check authorization_endpoint consistency
      if (
        rfc8414Metadata.authorization_endpoint !==
        oidcMetadata.authorization_endpoint
      ) {
        consistencyIssues.push(
          'authorization_endpoint differs between endpoints'
        );
      }

      // Check token_endpoint consistency
      if (rfc8414Metadata.token_endpoint !== oidcMetadata.token_endpoint) {
        consistencyIssues.push('token_endpoint differs between endpoints');
      }

      if (consistencyIssues.length === 0) {
        checks.push({
          id: 'auth-discovery-consistency',
          name: 'Discovery Consistency',
          description: 'RFC 8414 and OIDC Discovery return consistent metadata',
          status: 'SUCCESS',
          timestamp: timestamp(),
          specReferences: [
            ServerAuthSpecReferences.RFC_8414_AS_FIELDS,
            ServerAuthSpecReferences.OIDC_DISCOVERY
          ],
          details: {
            rfc8414_issuer: rfc8414Metadata.issuer,
            oidc_issuer: oidcMetadata.issuer,
            consistent: true
          }
        });
      } else {
        checks.push({
          id: 'auth-discovery-consistency',
          name: 'Discovery Consistency',
          description: 'RFC 8414 and OIDC Discovery return consistent metadata',
          status: 'WARNING',
          timestamp: timestamp(),
          errorMessage: `Inconsistencies found: ${consistencyIssues.join('; ')}`,
          specReferences: [
            ServerAuthSpecReferences.RFC_8414_AS_FIELDS,
            ServerAuthSpecReferences.OIDC_DISCOVERY
          ],
          details: {
            issues: consistencyIssues,
            rfc8414_issuer: rfc8414Metadata.issuer,
            oidc_issuer: oidcMetadata.issuer
          }
        });
      }
    }

    // Summary
    checks.push({
      id: 'auth-discovery-summary',
      name: 'Discovery Summary',
      description: 'Summary of available discovery mechanisms',
      status: 'SUCCESS',
      timestamp: timestamp(),
      specReferences: [ServerAuthSpecReferences.MCP_AUTH_SERVER_METADATA],
      details: {
        as_url: asUrl,
        rfc8414: {
          available: hasRfc8414,
          url: rfc8414Url,
          triedUrls: rfcAttempts.map((a) => a.url)
        },
        oidc: {
          available: hasOidc,
          url: oidcUrl,
          triedUrls: oidcAttempts.map((a) => a.url)
        },
        recommended: hasRfc8414 ? 'RFC8414' : 'OIDC'
      }
    });

    return checks;
  }
}
