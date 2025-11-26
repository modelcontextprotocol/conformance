/**
 * Server OAuth Conformance Test Scenarios
 *
 * This module exports all OAuth-related conformance tests for MCP servers.
 * These tests validate that servers correctly implement OAuth 2.1 authorization
 * as specified in the MCP Authorization specification.
 *
 * @see MCP Authorization Specification (2025-06-18)
 * @see RFC 9728 (Protected Resource Metadata)
 * @see RFC 8414 (Authorization Server Metadata)
 * @see RFC 7636 (PKCE)
 * @see RFC 7523 (JWT Client Authentication)
 * @see RFC 6750 (Bearer Token Usage)
 * @see OAuth 2.1 Draft (Client Credentials, Token Endpoint Auth)
 * @see MCP Extension SEP-1046 (Client Credentials)
 * @see IETF CIMD Draft (Client ID Metadata Documents)
 */

import { ClientScenario } from '../../../types';
import { AuthPrmDiscoveryScenario } from './scenarios/prm-discovery';
import { AuthUnauthorizedResponseScenario } from './scenarios/unauthorized-response';
import { AuthWWWAuthenticateHeaderScenario } from './scenarios/www-authenticate-header';
import { AuthAsMetadataDiscoveryScenario } from './scenarios/as-metadata-discovery';
import { AuthAsCimdSupportedScenario } from './scenarios/as-cimd-supported';
import { AuthAsPkceSupportScenario } from './scenarios/as-pkce-support';
import { AuthPrmResourceValidationScenario } from './scenarios/prm-resource-validation';
import { AuthDiscoveryMechanismScenario } from './scenarios/discovery-mechanism';
import { AuthAsTokenAuthMethodsScenario } from './scenarios/as-token-auth-methods';
import { AuthAsGrantTypesScenario } from './scenarios/as-grant-types';

/**
 * All server OAuth conformance scenarios.
 *
 * These scenarios test OAuth behavior without requiring a valid token,
 * making them suitable for basic conformance testing.
 *
 * Organized by dependency order:
 * 1. PRM Discovery (foundation)
 * 2. AS Metadata Discovery (depends on PRM)
 * 3. Discovery Mechanism Validation
 * 4. CIMD Support (depends on AS metadata)
 * 5. PKCE Support (depends on AS metadata)
 * 6. Token Auth Methods (depends on AS metadata) - Client credentials readiness
 * 7. Grant Types Support (depends on AS metadata) - Client credentials support
 * 8. PRM Resource Validation
 * 9. 401 Response / WWW-Authenticate (independent)
 */
export const serverAuthScenarios: ClientScenario[] = [
  // Foundation: PRM Discovery
  new AuthPrmDiscoveryScenario(),

  // AS Metadata Discovery (requires PRM)
  new AuthAsMetadataDiscoveryScenario(),

  // Discovery Mechanism Validation
  new AuthDiscoveryMechanismScenario(),

  // CIMD Support (requires AS metadata)
  new AuthAsCimdSupportedScenario(),

  // PKCE Support (requires AS metadata)
  new AuthAsPkceSupportScenario(),

  // Token Auth Methods (requires AS metadata) - Client credentials readiness
  new AuthAsTokenAuthMethodsScenario(),

  // Grant Types Support (requires AS metadata) - Client credentials support
  new AuthAsGrantTypesScenario(),

  // PRM Resource Validation (requires PRM)
  new AuthPrmResourceValidationScenario(),

  // HTTP-level checks (independent)
  new AuthUnauthorizedResponseScenario(),
  new AuthWWWAuthenticateHeaderScenario()
];

/**
 * Get list of server auth scenario names.
 */
export function listServerAuthScenarios(): string[] {
  return serverAuthScenarios.map((s) => s.name);
}

/**
 * Get a server auth scenario by name.
 */
export function getServerAuthScenario(name: string): ClientScenario | undefined {
  return serverAuthScenarios.find((s) => s.name === name);
}

// Re-export individual scenarios for direct use
export { AuthPrmDiscoveryScenario } from './scenarios/prm-discovery';
export { AuthUnauthorizedResponseScenario } from './scenarios/unauthorized-response';
export { AuthWWWAuthenticateHeaderScenario } from './scenarios/www-authenticate-header';
export { AuthAsMetadataDiscoveryScenario } from './scenarios/as-metadata-discovery';
export { AuthAsCimdSupportedScenario } from './scenarios/as-cimd-supported';
export { AuthAsPkceSupportScenario } from './scenarios/as-pkce-support';
export { AuthPrmResourceValidationScenario } from './scenarios/prm-resource-validation';
export { AuthDiscoveryMechanismScenario } from './scenarios/discovery-mechanism';
export { AuthAsTokenAuthMethodsScenario } from './scenarios/as-token-auth-methods';
export { AuthAsGrantTypesScenario } from './scenarios/as-grant-types';

// Re-export spec references
export { ServerAuthSpecReferences } from './spec-references';

// Re-export helpers
export {
  authFetch,
  parseWWWAuthenticate,
  buildPrmUrl,
  getBaseUrl,
  type AuthTestResult,
  type AuthFetchOptions,
  type ParsedWWWAuthenticate
} from './helpers/auth-fetch';

export {
  fetchPrm,
  fetchAsMetadata,
  buildAsMetadataUrl,
  type PrmResult,
  type AsMetadataResult
} from './helpers/as-metadata';
