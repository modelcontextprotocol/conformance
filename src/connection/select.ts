import {
  DATED_SPEC_VERSIONS,
  DRAFT_PROTOCOL_VERSION,
  type SpecVersion
} from '../types';
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

/** Every spec version the suite can target, in timeline order. */
const ALL_SPEC_VERSIONS: readonly SpecVersion[] = [
  ...DATED_SPEC_VERSIONS,
  DRAFT_PROTOCOL_VERSION
];

export function isStatefulVersion(v: SpecVersion): boolean {
  return STATEFUL_VERSIONS.has(v);
}

/**
 * Spec versions that use the stateless lifecycle, derived from
 * {@link isStatefulVersion} so there is a single source of truth for the
 * version→lifecycle mapping. The list grows automatically when the draft is
 * dated (added to `DATED_SPEC_VERSIONS` without joining `STATEFUL_VERSIONS`)
 * or a second stateless version appears.
 */
export const STATELESS_SPEC_VERSIONS: readonly SpecVersion[] =
  ALL_SPEC_VERSIONS.filter((v) => !isStatefulVersion(v));

/**
 * Lifecycle label for a spec version. This is the value the runner exports
 * to client processes as `MCP_CONFORMANCE_LIFECYCLE` so clients in any
 * language can pick the right lifecycle without maintaining their own copy
 * of the version→lifecycle map.
 */
export function lifecycleFor(v: SpecVersion): 'stateful' | 'stateless' {
  return isStatefulVersion(v) ? 'stateful' : 'stateless';
}

export function connectFor(
  specVersion: SpecVersion
): (serverUrl: string) => Promise<Connection> {
  return isStatefulVersion(specVersion)
    ? connectStateful
    : // Pass the version through so stateless requests declare the spec
      // version the run was invoked with (matters under --force).
      (serverUrl) => connectStateless(serverUrl, specVersion);
}
