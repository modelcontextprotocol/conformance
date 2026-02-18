/**
 * Server Authentication Conformance Scenarios
 *
 * This module exports scenarios for testing MCP servers' OAuth implementation.
 * These are client scenarios that connect to a server and verify its conformance
 * with OAuth-related RFCs and the MCP authorization specification.
 */

import type { ClientScenario } from '../../types';
import { BasicAuthFlowScenario } from './run-auth-flow';

// Re-export helpers and spec references
export * from './helpers/oauth-client';
export * from './spec-references';
export { BasicAuthFlowScenario } from './run-auth-flow';

/**
 * All server authentication scenarios.
 */
export const serverAuthScenarios: ClientScenario[] = [
  new BasicAuthFlowScenario()
];

/**
 * List all available server auth scenarios.
 */
export function listServerAuthScenarios(): {
  name: string;
  description: string;
}[] {
  return serverAuthScenarios.map((s) => ({
    name: s.name,
    description: s.description
  }));
}

/**
 * Get a server auth scenario by name.
 */
export function getServerAuthScenario(
  name: string
): ClientScenario | undefined {
  return serverAuthScenarios.find((s) => s.name === name);
}
