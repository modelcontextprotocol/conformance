/**
 * Token Endpoint Authentication Methods Validation Scenario
 *
 * Tests that the Authorization Server properly advertises supported
 * token endpoint authentication methods.
 *
 * @see RFC 8414 Section 2 (token_endpoint_auth_methods_supported)
 * @see OAuth 2.1 Section 2.4 (Client Authentication)
 * @see RFC 7523 (JWT Client Authentication)
 */

import { ClientScenario, ConformanceCheck } from '../../../../types';
import { fetchAsMetadata } from '../helpers/as-metadata';
import { ServerAuthSpecReferences } from '../spec-references';

/**
 * Valid token endpoint authentication methods per OAuth 2.1.
 */
const VALID_AUTH_METHODS = [
  'none', // Public clients (no authentication)
  'client_secret_basic', // HTTP Basic authentication
  'client_secret_post', // Client credentials in POST body
  'client_secret_jwt', // Client secret used to sign JWT assertion
  'private_key_jwt', // Private key used to sign JWT assertion
  'tls_client_auth', // Mutual TLS client authentication
  'self_signed_tls_client_auth' // Self-signed certificate mutual TLS
];

/**
 * Secure JWT signing algorithms.
 */
const SECURE_SIGNING_ALGORITHMS = [
  'ES256',
  'ES384',
  'ES512',
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512'
];

/**
 * Validates token endpoint authentication methods in AS metadata.
 *
 * Per RFC 8414 and OAuth 2.1:
 * - AS MAY advertise token_endpoint_auth_methods_supported
 * - If private_key_jwt is supported, SHOULD include signing algorithms
 * - Important for client_credentials grant type support
 */
export class AuthAsTokenAuthMethodsScenario implements ClientScenario {
  name = 'server/auth-as-token-auth-methods';
  description = `Test token endpoint authentication methods advertisement.

**Prerequisites**: Server must have valid AS metadata endpoint.

**Check**: AS metadata contains \`token_endpoint_auth_methods_supported\` field
with valid authentication methods.

Token endpoint authentication methods determine how clients authenticate
when making token requests. Important for client_credentials grant.

**Spec References**:
- RFC 8414 Section 2 (AS Metadata Fields)
- OAuth 2.1 Section 2.4 (Client Authentication)
- RFC 7523 (JWT Client Authentication)`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const timestamp = () => new Date().toISOString();

    // Fetch AS metadata
    const asResult = await fetchAsMetadata(serverUrl);

    if (!asResult.success || !asResult.metadata) {
      checks.push({
        id: 'auth-token-auth-methods-prerequisite',
        name: 'AS Metadata Prerequisite',
        description: 'Valid AS metadata required to check token auth methods',
        status: 'SKIPPED',
        timestamp: timestamp(),
        errorMessage:
          asResult.error ||
          'Cannot fetch AS metadata - run auth-as-metadata-discovery first',
        specReferences: [ServerAuthSpecReferences.RFC_8414_AS_DISCOVERY]
      });
      return checks;
    }

    checks.push({
      id: 'auth-token-auth-methods-prerequisite',
      name: 'AS Metadata Prerequisite',
      description: 'Valid AS metadata found',
      status: 'SUCCESS',
      timestamp: timestamp(),
      specReferences: [ServerAuthSpecReferences.RFC_8414_AS_DISCOVERY],
      details: { asUrl: asResult.asUrl, metadataUrl: asResult.url }
    });

    const metadata = asResult.metadata;
    const authMethods = metadata.token_endpoint_auth_methods_supported;
    const signingAlgorithms =
      metadata.token_endpoint_auth_signing_alg_values_supported;

    // Check: token_endpoint_auth_methods_supported field present
    if (authMethods === undefined) {
      checks.push({
        id: 'auth-token-auth-methods-present',
        name: 'Token Auth Methods Field Present',
        description:
          'AS metadata contains token_endpoint_auth_methods_supported field',
        status: 'INFO',
        timestamp: timestamp(),
        errorMessage:
          'Field not present - defaults to ["client_secret_basic"] per RFC 8414',
        specReferences: [ServerAuthSpecReferences.RFC_8414_AS_FIELDS],
        details: {
          token_endpoint_auth_methods_supported: undefined,
          default_value: ['client_secret_basic']
        }
      });

      // Cannot determine further details
      return checks;
    }

    // Check: field is an array
    if (!Array.isArray(authMethods)) {
      checks.push({
        id: 'auth-token-auth-methods-present',
        name: 'Token Auth Methods Field Present',
        description:
          'AS metadata contains token_endpoint_auth_methods_supported field',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage: `Invalid type: expected array, got ${typeof authMethods}`,
        specReferences: [ServerAuthSpecReferences.RFC_8414_AS_FIELDS],
        details: { token_endpoint_auth_methods_supported: authMethods }
      });
      return checks;
    }

    // Check: array is not empty
    if (authMethods.length === 0) {
      checks.push({
        id: 'auth-token-auth-methods-present',
        name: 'Token Auth Methods Field Present',
        description:
          'AS metadata contains token_endpoint_auth_methods_supported field',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage:
          'Empty array - at least one auth method must be supported',
        specReferences: [ServerAuthSpecReferences.RFC_8414_AS_FIELDS],
        details: { token_endpoint_auth_methods_supported: authMethods }
      });
      return checks;
    }

    checks.push({
      id: 'auth-token-auth-methods-present',
      name: 'Token Auth Methods Field Present',
      description:
        'AS metadata contains token_endpoint_auth_methods_supported field',
      status: 'SUCCESS',
      timestamp: timestamp(),
      specReferences: [ServerAuthSpecReferences.RFC_8414_AS_FIELDS],
      details: { token_endpoint_auth_methods_supported: authMethods }
    });

    // Check: all methods are valid
    const invalidMethods = authMethods.filter(
      (m: unknown) =>
        typeof m !== 'string' || !VALID_AUTH_METHODS.includes(m as string)
    );

    if (invalidMethods.length > 0) {
      checks.push({
        id: 'auth-token-auth-methods-valid',
        name: 'Token Auth Methods Valid',
        description: 'All advertised auth methods are valid OAuth methods',
        status: 'WARNING',
        timestamp: timestamp(),
        errorMessage: `Unknown auth method(s): ${invalidMethods.join(', ')}`,
        specReferences: [
          ServerAuthSpecReferences.OAUTH_2_1_TOKEN_ENDPOINT_AUTH
        ],
        details: {
          token_endpoint_auth_methods_supported: authMethods,
          invalid_methods: invalidMethods,
          valid_methods: VALID_AUTH_METHODS
        }
      });
    } else {
      checks.push({
        id: 'auth-token-auth-methods-valid',
        name: 'Token Auth Methods Valid',
        description: 'All advertised auth methods are valid OAuth methods',
        status: 'SUCCESS',
        timestamp: timestamp(),
        specReferences: [
          ServerAuthSpecReferences.OAUTH_2_1_TOKEN_ENDPOINT_AUTH
        ],
        details: { token_endpoint_auth_methods_supported: authMethods }
      });
    }

    // Check: public clients only (none as only method)
    if (authMethods.length === 1 && authMethods[0] === 'none') {
      checks.push({
        id: 'auth-token-auth-methods-public-only',
        name: 'Public Clients Only',
        description:
          'Check if only public clients (no authentication) supported',
        status: 'INFO',
        timestamp: timestamp(),
        specReferences: [
          ServerAuthSpecReferences.OAUTH_2_1_TOKEN_ENDPOINT_AUTH
        ],
        details: {
          note: 'Only "none" auth method supported - public clients only',
          client_credentials_support: 'Not available for confidential clients'
        }
      });
    }

    // Check: private_key_jwt support
    const hasPrivateKeyJwt = authMethods.includes('private_key_jwt');
    const hasClientSecretJwt = authMethods.includes('client_secret_jwt');

    if (hasPrivateKeyJwt || hasClientSecretJwt) {
      // Check: signing algorithms advertised
      if (signingAlgorithms === undefined) {
        checks.push({
          id: 'auth-token-auth-jwt-signing-algs',
          name: 'JWT Signing Algorithms',
          description:
            'Check token_endpoint_auth_signing_alg_values_supported for JWT auth',
          status: 'WARNING',
          timestamp: timestamp(),
          errorMessage:
            'JWT auth supported but token_endpoint_auth_signing_alg_values_supported not advertised',
          specReferences: [
            ServerAuthSpecReferences.RFC_7523_JWT_CLIENT_AUTH,
            ServerAuthSpecReferences.RFC_8414_AS_FIELDS
          ],
          details: {
            jwt_auth_methods: authMethods.filter(
              (m: unknown) =>
                m === 'private_key_jwt' || m === 'client_secret_jwt'
            ),
            signing_algorithms: undefined
          }
        });
      } else if (!Array.isArray(signingAlgorithms)) {
        checks.push({
          id: 'auth-token-auth-jwt-signing-algs',
          name: 'JWT Signing Algorithms',
          description:
            'Check token_endpoint_auth_signing_alg_values_supported for JWT auth',
          status: 'FAILURE',
          timestamp: timestamp(),
          errorMessage: `Invalid type: expected array, got ${typeof signingAlgorithms}`,
          specReferences: [ServerAuthSpecReferences.RFC_8414_AS_FIELDS],
          details: {
            token_endpoint_auth_signing_alg_values_supported: signingAlgorithms
          }
        });
      } else {
        // Check for secure algorithms
        const secureAlgs = signingAlgorithms.filter(
          (alg: unknown) =>
            typeof alg === 'string' &&
            SECURE_SIGNING_ALGORITHMS.includes(alg as string)
        );

        if (secureAlgs.length > 0) {
          checks.push({
            id: 'auth-token-auth-jwt-signing-algs',
            name: 'JWT Signing Algorithms',
            description:
              'Check token_endpoint_auth_signing_alg_values_supported for JWT auth',
            status: 'SUCCESS',
            timestamp: timestamp(),
            specReferences: [
              ServerAuthSpecReferences.RFC_7523_JWT_CLIENT_AUTH,
              ServerAuthSpecReferences.RFC_8414_AS_FIELDS
            ],
            details: {
              token_endpoint_auth_signing_alg_values_supported:
                signingAlgorithms,
              secure_algorithms: secureAlgs
            }
          });
        } else {
          checks.push({
            id: 'auth-token-auth-jwt-signing-algs',
            name: 'JWT Signing Algorithms',
            description:
              'Check token_endpoint_auth_signing_alg_values_supported for JWT auth',
            status: 'WARNING',
            timestamp: timestamp(),
            errorMessage:
              'No secure signing algorithms found (ES256, RS256, etc. recommended)',
            specReferences: [ServerAuthSpecReferences.RFC_7523_JWT_CLIENT_AUTH],
            details: {
              token_endpoint_auth_signing_alg_values_supported:
                signingAlgorithms,
              recommended: SECURE_SIGNING_ALGORITHMS.slice(0, 4)
            }
          });
        }
      }
    }

    // Check: client_secret_basic support (most common for confidential clients)
    const hasClientSecretBasic = authMethods.includes('client_secret_basic');

    if (hasClientSecretBasic) {
      checks.push({
        id: 'auth-token-auth-basic-supported',
        name: 'Client Secret Basic Supported',
        description:
          'Authorization Server supports client_secret_basic authentication',
        status: 'SUCCESS',
        timestamp: timestamp(),
        specReferences: [
          ServerAuthSpecReferences.OAUTH_2_1_TOKEN_ENDPOINT_AUTH
        ],
        details: {
          client_secret_basic: true,
          note: 'Standard HTTP Basic authentication for confidential clients'
        }
      });
    }

    // Summary check: client credentials readiness
    const supportsConfidentialClients =
      hasClientSecretBasic ||
      authMethods.includes('client_secret_post') ||
      hasPrivateKeyJwt ||
      hasClientSecretJwt;

    checks.push({
      id: 'auth-token-auth-confidential-client-ready',
      name: 'Confidential Client Ready',
      description:
        'Authorization Server supports authentication for confidential clients',
      status: supportsConfidentialClients ? 'SUCCESS' : 'INFO',
      timestamp: timestamp(),
      specReferences: [
        ServerAuthSpecReferences.OAUTH_2_1_TOKEN_ENDPOINT_AUTH,
        ServerAuthSpecReferences.OAUTH_2_1_CLIENT_CREDENTIALS
      ],
      details: {
        supports_confidential_clients: supportsConfidentialClients,
        token_endpoint_auth_methods_supported: authMethods,
        client_credentials_ready: supportsConfidentialClients,
        note: supportsConfidentialClients
          ? 'Server can authenticate confidential clients for client_credentials grant'
          : 'Only public clients supported - client_credentials grant not available'
      }
    });

    return checks;
  }
}
