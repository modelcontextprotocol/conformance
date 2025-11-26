/**
 * Grant Types Support Validation Scenario
 *
 * Tests that the Authorization Server properly advertises supported OAuth grant types.
 *
 * @see RFC 8414 Section 2 (grant_types_supported)
 * @see OAuth 2.1 Section 4 (Grant Types)
 * @see OAuth 2.1 Section 4.2 (Client Credentials Grant)
 * @see MCP Extension SEP-1046 (Client Credentials)
 */

import { ClientScenario, ConformanceCheck } from '../../../../types';
import { fetchAsMetadata } from '../helpers/as-metadata';
import { ServerAuthSpecReferences } from '../spec-references';

/**
 * Standard OAuth 2.1 grant types.
 */
const STANDARD_GRANT_TYPES = [
  'authorization_code', // Standard OAuth code flow
  'refresh_token', // Token refresh
  'client_credentials', // Machine-to-machine (M2M)
  'urn:ietf:params:oauth:grant-type:device_code', // Device flow
  'urn:ietf:params:oauth:grant-type:jwt-bearer', // JWT bearer assertion
  'urn:ietf:params:oauth:grant-type:token-exchange' // Token exchange
];

/**
 * Validates grant types advertisement in AS metadata.
 *
 * Per RFC 8414:
 * - AS MAY advertise grant_types_supported
 * - Defaults to ["authorization_code", "implicit"] if not present
 * - Important for determining M2M (client_credentials) support
 */
export class AuthAsGrantTypesScenario implements ClientScenario {
  name = 'server/auth-as-grant-types';
  description = `Test OAuth grant types advertisement.

**Prerequisites**: Server must have valid AS metadata endpoint.

**Check**: AS metadata contains \`grant_types_supported\` field
advertising available OAuth grant types.

Grant types determine the OAuth flows a server supports:
- authorization_code: Standard OAuth flow for user authorization
- refresh_token: Support for token refresh
- client_credentials: Machine-to-machine (M2M) authentication

**Spec References**:
- RFC 8414 Section 2 (AS Metadata Fields)
- OAuth 2.1 Section 4 (Grant Types)
- OAuth 2.1 Section 4.2 (Client Credentials Grant)
- MCP Extension SEP-1046 (Client Credentials)`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const timestamp = () => new Date().toISOString();

    // Fetch AS metadata
    const asResult = await fetchAsMetadata(serverUrl);

    if (!asResult.success || !asResult.metadata) {
      checks.push({
        id: 'auth-grant-types-prerequisite',
        name: 'AS Metadata Prerequisite',
        description: 'Valid AS metadata required to check grant types',
        status: 'SKIPPED',
        timestamp: timestamp(),
        errorMessage: asResult.error || 'Cannot fetch AS metadata - run auth-as-metadata-discovery first',
        specReferences: [ServerAuthSpecReferences.RFC_8414_AS_DISCOVERY]
      });
      return checks;
    }

    checks.push({
      id: 'auth-grant-types-prerequisite',
      name: 'AS Metadata Prerequisite',
      description: 'Valid AS metadata found',
      status: 'SUCCESS',
      timestamp: timestamp(),
      specReferences: [ServerAuthSpecReferences.RFC_8414_AS_DISCOVERY],
      details: { asUrl: asResult.asUrl, metadataUrl: asResult.url }
    });

    const metadata = asResult.metadata;
    const grantTypes = metadata.grant_types_supported;

    // Check: grant_types_supported field present
    if (grantTypes === undefined) {
      checks.push({
        id: 'auth-grant-types-present',
        name: 'Grant Types Field Present',
        description: 'AS metadata contains grant_types_supported field',
        status: 'WARNING',
        timestamp: timestamp(),
        errorMessage: 'Field not present - defaults to ["authorization_code", "implicit"] per RFC 8414',
        specReferences: [ServerAuthSpecReferences.RFC_8414_AS_FIELDS],
        details: {
          grant_types_supported: undefined,
          default_value: ['authorization_code', 'implicit'],
          note: 'implicit is deprecated in OAuth 2.1'
        }
      });

      // Assume defaults per RFC 8414
      checks.push({
        id: 'auth-grant-types-authorization-code',
        name: 'Authorization Code Grant',
        description: 'Check if authorization_code grant is supported',
        status: 'INFO',
        timestamp: timestamp(),
        specReferences: [ServerAuthSpecReferences.OAUTH_2_1_GRANT_TYPES],
        details: {
          authorization_code: 'assumed (default)',
          note: 'Field not advertised - assuming default per RFC 8414'
        }
      });

      checks.push({
        id: 'auth-grant-types-client-credentials',
        name: 'Client Credentials Grant',
        description: 'Check if client_credentials grant is supported',
        status: 'INFO',
        timestamp: timestamp(),
        specReferences: [
          ServerAuthSpecReferences.OAUTH_2_1_CLIENT_CREDENTIALS,
          ServerAuthSpecReferences.SEP_1046_CLIENT_CREDENTIALS
        ],
        details: {
          client_credentials: 'unknown',
          note: 'Grant types not advertised - client_credentials support unknown'
        }
      });

      return checks;
    }

    // Check: field is an array
    if (!Array.isArray(grantTypes)) {
      checks.push({
        id: 'auth-grant-types-present',
        name: 'Grant Types Field Present',
        description: 'AS metadata contains grant_types_supported field',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage: `Invalid type: expected array, got ${typeof grantTypes}`,
        specReferences: [ServerAuthSpecReferences.RFC_8414_AS_FIELDS],
        details: { grant_types_supported: grantTypes }
      });
      return checks;
    }

    // Check: array is not empty
    if (grantTypes.length === 0) {
      checks.push({
        id: 'auth-grant-types-present',
        name: 'Grant Types Field Present',
        description: 'AS metadata contains grant_types_supported field',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage: 'Empty array - at least one grant type must be supported',
        specReferences: [ServerAuthSpecReferences.RFC_8414_AS_FIELDS],
        details: { grant_types_supported: grantTypes }
      });
      return checks;
    }

    checks.push({
      id: 'auth-grant-types-present',
      name: 'Grant Types Field Present',
      description: 'AS metadata contains grant_types_supported field',
      status: 'SUCCESS',
      timestamp: timestamp(),
      specReferences: [ServerAuthSpecReferences.RFC_8414_AS_FIELDS],
      details: { grant_types_supported: grantTypes }
    });

    // Check: authorization_code support (required for standard OAuth)
    const hasAuthorizationCode = grantTypes.includes('authorization_code');

    if (hasAuthorizationCode) {
      checks.push({
        id: 'auth-grant-types-authorization-code',
        name: 'Authorization Code Grant',
        description: 'Check if authorization_code grant is supported',
        status: 'SUCCESS',
        timestamp: timestamp(),
        specReferences: [ServerAuthSpecReferences.OAUTH_2_1_GRANT_TYPES],
        details: {
          authorization_code: true,
          note: 'Standard OAuth flow for user authorization supported'
        }
      });
    } else {
      checks.push({
        id: 'auth-grant-types-authorization-code',
        name: 'Authorization Code Grant',
        description: 'Check if authorization_code grant is supported',
        status: 'WARNING',
        timestamp: timestamp(),
        errorMessage: 'authorization_code not in grant_types_supported',
        specReferences: [ServerAuthSpecReferences.OAUTH_2_1_GRANT_TYPES],
        details: {
          authorization_code: false,
          grant_types_supported: grantTypes,
          note: 'Standard OAuth flow may not be available'
        }
      });
    }

    // Check: refresh_token support
    const hasRefreshToken = grantTypes.includes('refresh_token');

    checks.push({
      id: 'auth-grant-types-refresh-token',
      name: 'Refresh Token Grant',
      description: 'Check if refresh_token grant is supported',
      status: hasRefreshToken ? 'SUCCESS' : 'INFO',
      timestamp: timestamp(),
      specReferences: [ServerAuthSpecReferences.OAUTH_2_1_GRANT_TYPES],
      details: {
        refresh_token: hasRefreshToken,
        note: hasRefreshToken
          ? 'Token refresh supported - long-lived sessions possible'
          : 'Token refresh not advertised - clients must re-authorize when tokens expire'
      }
    });

    // Check: client_credentials support (M2M authentication)
    const hasClientCredentials = grantTypes.includes('client_credentials');

    if (hasClientCredentials) {
      checks.push({
        id: 'auth-grant-types-client-credentials',
        name: 'Client Credentials Grant',
        description: 'Check if client_credentials grant is supported',
        status: 'SUCCESS',
        timestamp: timestamp(),
        specReferences: [
          ServerAuthSpecReferences.OAUTH_2_1_CLIENT_CREDENTIALS,
          ServerAuthSpecReferences.SEP_1046_CLIENT_CREDENTIALS
        ],
        details: {
          client_credentials: true,
          note: 'Machine-to-machine (M2M) authentication supported per SEP-1046'
        }
      });
    } else {
      checks.push({
        id: 'auth-grant-types-client-credentials',
        name: 'Client Credentials Grant',
        description: 'Check if client_credentials grant is supported',
        status: 'INFO',
        timestamp: timestamp(),
        specReferences: [
          ServerAuthSpecReferences.OAUTH_2_1_CLIENT_CREDENTIALS,
          ServerAuthSpecReferences.SEP_1046_CLIENT_CREDENTIALS
        ],
        details: {
          client_credentials: false,
          note: 'M2M authentication not supported - user authorization required'
        }
      });
    }

    // Check: deprecated implicit grant (OAuth 2.1 removes this)
    const hasImplicit = grantTypes.includes('implicit');

    if (hasImplicit) {
      checks.push({
        id: 'auth-grant-types-implicit-deprecated',
        name: 'Implicit Grant Deprecated',
        description: 'Check for deprecated implicit grant type',
        status: 'WARNING',
        timestamp: timestamp(),
        errorMessage: 'implicit grant is deprecated in OAuth 2.1 - use authorization_code with PKCE instead',
        specReferences: [ServerAuthSpecReferences.OAUTH_2_1_GRANT_TYPES],
        details: {
          implicit: true,
          deprecated: true,
          recommendation: 'Use authorization_code with PKCE for public clients'
        }
      });
    }

    // Check: deprecated password grant (OAuth 2.1 removes this)
    const hasPassword = grantTypes.includes('password');

    if (hasPassword) {
      checks.push({
        id: 'auth-grant-types-password-deprecated',
        name: 'Password Grant Deprecated',
        description: 'Check for deprecated password grant type',
        status: 'WARNING',
        timestamp: timestamp(),
        errorMessage: 'password grant (Resource Owner Password Credentials) is removed in OAuth 2.1',
        specReferences: [ServerAuthSpecReferences.OAUTH_2_1_GRANT_TYPES],
        details: {
          password: true,
          deprecated: true,
          note: 'ROPC grant should not be used in new implementations'
        }
      });
    }

    // Check: unknown/non-standard grant types
    const unknownGrants = grantTypes.filter((g: unknown) => typeof g !== 'string' || !STANDARD_GRANT_TYPES.includes(g as string));
    const deprecatedGrants = ['implicit', 'password'];
    const customGrants = unknownGrants.filter((g: unknown) => typeof g !== 'string' || !deprecatedGrants.includes(g as string));

    if (customGrants.length > 0) {
      checks.push({
        id: 'auth-grant-types-custom',
        name: 'Custom Grant Types',
        description: 'Check for non-standard grant types',
        status: 'INFO',
        timestamp: timestamp(),
        specReferences: [ServerAuthSpecReferences.OAUTH_2_1_GRANT_TYPES],
        details: {
          custom_grant_types: customGrants,
          note: 'Non-standard grant types detected - may be extension grants'
        }
      });
    }

    // Summary check: SEP-1046 readiness
    const sep1046Ready = hasClientCredentials;

    checks.push({
      id: 'auth-grant-types-sep1046-ready',
      name: 'SEP-1046 Client Credentials Ready',
      description: 'Authorization Server is ready for MCP client_credentials flow',
      status: sep1046Ready ? 'SUCCESS' : 'INFO',
      timestamp: timestamp(),
      specReferences: [
        ServerAuthSpecReferences.OAUTH_2_1_CLIENT_CREDENTIALS,
        ServerAuthSpecReferences.SEP_1046_CLIENT_CREDENTIALS
      ],
      details: {
        sep1046_ready: sep1046Ready,
        grant_types_supported: grantTypes,
        note: sep1046Ready
          ? 'Server supports client_credentials grant per MCP SEP-1046'
          : 'Server does not advertise client_credentials - M2M flow not available'
      }
    });

    return checks;
  }
}
