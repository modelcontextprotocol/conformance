import type { SpecVersion } from '../types';
import type { Connection } from './index';
import { connectStateful } from './stateful';
import { connectStateless } from './stateless';

/**
 * Spec versions that use the stateful lifecycle (initialize handshake,
 * Mcp-Session-Id). Anything not in this list uses the stateless lifecycle.
 */
const STATEFUL_VERSIONS: ReadonlySet<string> = new Set([
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25'
]);

export function connectFor(
  specVersion: SpecVersion
): (serverUrl: string) => Promise<Connection> {
  return STATEFUL_VERSIONS.has(specVersion)
    ? connectStateful
    : // Pass the version through so stateless requests declare the spec
      // version the run was invoked with (matters under --force).
      (serverUrl) => connectStateless(serverUrl, specVersion);
}
