/**
 * Server OAuth Conformance Test Scenarios
 *
 * This module exports all OAuth-related conformance tests for MCP servers.
 * These tests validate that servers correctly implement OAuth 2.1 authorization
 * as specified in the MCP Authorization specification.
 *
 * @see MCP Authorization Specification
 * @see RFC 9728 (Protected Resource Metadata)
 * @see RFC 6750 (Bearer Token Usage)
 */

import { ClientScenario } from '../../../types';
import { AuthPrmDiscoveryScenario } from './scenarios/prm-discovery';
import { AuthUnauthorizedResponseScenario } from './scenarios/unauthorized-response';
import { AuthWWWAuthenticateHeaderScenario } from './scenarios/www-authenticate-header';

/**
 * All server OAuth conformance scenarios.
 *
 * These scenarios test OAuth behavior without requiring a valid token,
 * making them suitable for basic conformance testing.
 */
export const serverAuthScenarios: ClientScenario[] = [
  new AuthPrmDiscoveryScenario(),
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
