import {
  SPEC_VERSION_TIMELINE,
  protocolVersionFor,
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

export function isStatefulVersion(v: SpecVersion): boolean {
  return STATEFUL_VERSIONS.has(v);
}

/**
 * Spec versions that use the stateless lifecycle, derived from
 * {@link isStatefulVersion} so there is a single source of truth for the
 * version→lifecycle mapping. The list grows automatically when a new dated
 * revision is added to `DATED_SPEC_VERSIONS` without joining
 * `STATEFUL_VERSIONS`.
 */
export const STATELESS_SPEC_VERSIONS: readonly SpecVersion[] =
  SPEC_VERSION_TIMELINE.filter((v) => !isStatefulVersion(v));

/**
 * Wire `protocolVersion` strings of the stateless revisions, deduplicated
 * (the draft shares the latest release's wire string until the spec repo
 * gives the next draft its own). What a stateless mock server advertises in
 * `server/discover` when the run does not pin one version.
 */
export const STATELESS_PROTOCOL_VERSIONS: readonly string[] = [
  ...new Set(STATELESS_SPEC_VERSIONS.map(protocolVersionFor))
];

export function connectFor(
  specVersion: SpecVersion
): (serverUrl: string, opts?: ConnectOptions) => Promise<Connection> {
  // Pass the version through so requests declare (and are wire-schema
  // validated against) the spec version the run was invoked with.
  return isStatefulVersion(specVersion)
    ? (serverUrl, opts) => connectStateful(serverUrl, opts ?? {}, specVersion)
    : (serverUrl, opts) => connectStateless(serverUrl, specVersion, opts);
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
