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

export function isStatefulVersion(v: SpecVersion): boolean {
  return STATEFUL_VERSIONS.has(v);
}

export function connectFor(
  specVersion: SpecVersion
): (serverUrl: string) => Promise<Connection> {
  return isStatefulVersion(specVersion) ? connectStateful : connectStateless;
}
