import {
  DATED_SPEC_VERSIONS,
  DRAFT_PROTOCOL_VERSION,
  type SpecVersion
} from '../types';
import type { Connection, ConnectOptions, RunContext } from './index';
import { connectStateful } from './stateful';
import { connectStateless } from './stateless';

/**
 * Spec versions that use the stateful lifecycle (initialize handshake,
 * Mcp-Session-Id). Anything not in this list uses the stateless lifecycle
 * — SEP-2575 (Accepted) removed the initialize handshake on 2026-07-28
 * and later.
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

export function connectFor(
  specVersion: SpecVersion
): (serverUrl: string, opts?: ConnectOptions) => Promise<Connection> {
  return isStatefulVersion(specVersion)
    ? connectStateful
    : // Pass the version through so stateless requests declare the spec
      // version the run was invoked with (matters under --force).
      (serverUrl, opts) => connectStateless(serverUrl, specVersion, opts);
}

/**
 * True when the spec version on the context requires the SEP-2575
 * stateless wire (no initialize handshake; per-request `_meta` envelope).
 *
 * Mirrors `connectFor` so scenarios that drive the wire directly (not via
 * the SDK-wrapped Connection) pick the wire the same way the connection
 * factory does.
 */
export function isStateless(ctx: Pick<RunContext, 'specVersion'>): boolean {
  return !isStatefulVersion(ctx.specVersion);
}
