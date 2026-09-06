import type { RunContext } from './connection';
import type { ScenarioContext } from './mock-server';
import type { AuthorizationServerOptions } from './schemas';
import { LATEST_PROTOCOL_VERSION as DRAFT_SCHEMA_PROTOCOL_VERSION } from './spec-types/draft';

export type CheckStatus =
  | 'SUCCESS'
  | 'FAILURE'
  | 'WARNING'
  | 'SKIPPED'
  | 'INFO';

export interface SpecReference {
  id: string;
  url?: string;
}

export interface ConformanceCheck {
  id: string;
  name: string;
  description: string;
  status: CheckStatus;
  timestamp: string;
  specReferences?: SpecReference[];
  /**
   * Optional spec-version range for this individual check. When set, runners
   * drop the check for `--spec-version` values outside the range.
   */
  source?: ScenarioSource;
  details?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  errorMessage?: string;
  logs?: string[];
}

/**
 * Released spec revisions the suite can target, oldest first. Publishing a
 * new revision means appending its date here and running
 * `npm run sync-schema -- <release tag>`; see src/spec-types/README.md for
 * the full checklist. The last entry is {@link LATEST_SPEC_VERSION}.
 */
export const DATED_SPEC_VERSIONS = [
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
  '2026-07-28'
] as const;

export type DatedSpecVersion = (typeof DATED_SPEC_VERSIONS)[number];

type Last<T extends readonly unknown[]> = T extends readonly [
  ...unknown[],
  infer L
]
  ? L
  : never;

/** The most recent released revision: the last entry of {@link DATED_SPEC_VERSIONS}. */
export const LATEST_SPEC_VERSION = DATED_SPEC_VERSIONS[
  DATED_SPEC_VERSIONS.length - 1
] as Last<typeof DATED_SPEC_VERSIONS>;

/**
 * Names the in-progress spec revision: whatever `docs/specification/draft/`
 * in the spec repo will become after {@link LATEST_SPEC_VERSION}. It sits
 * last on the timeline, so a scenario `introducedIn: DRAFT_SPEC_VERSION` runs
 * only under `--spec-version draft`, and one `removedIn: DRAFT_SPEC_VERSION`
 * runs at every dated revision but not the draft.
 */
export const DRAFT_SPEC_VERSION = 'draft';

/**
 * Wire `protocolVersion` the draft currently declares: `LATEST_PROTOCOL_VERSION`
 * from the vendored `schema/draft/schema.ts`, so it tracks the spec repo with
 * `npm run sync-schema` and needs no edit here. Right after a release the spec
 * repo leaves this equal to the released revision until the next draft gets
 * its own marker, so it can coincide with {@link LATEST_SPEC_VERSION};
 * {@link DRAFT_SPEC_VERSION} is what keeps the draft distinct on the timeline
 * regardless.
 */
export const DRAFT_PROTOCOL_VERSION: string = DRAFT_SCHEMA_PROTOCOL_VERSION;

/**
 * A spec revision the conformance suite can target via `--spec-version`:
 * a dated release, or `'draft'` for the revision after the latest release.
 * For dated revisions the value is also the wire `protocolVersion`; use
 * {@link protocolVersionFor} wherever a value goes on the wire so the draft
 * maps to {@link DRAFT_PROTOCOL_VERSION}.
 */
export type SpecVersion = DatedSpecVersion | typeof DRAFT_SPEC_VERSION;

/** Spec versions in timeline order, dated revisions followed by the draft. */
export const SPEC_VERSION_TIMELINE: readonly SpecVersion[] = [
  ...DATED_SPEC_VERSIONS,
  DRAFT_SPEC_VERSION
];

/** Wire `protocolVersion` string to send/expect when a run targets `v`. */
export function protocolVersionFor(v: SpecVersion): string {
  return v === DRAFT_SPEC_VERSION ? DRAFT_PROTOCOL_VERSION : v;
}

// Wire protocolVersion strings the mock server will negotiate on initialize.
export const NEGOTIABLE_PROTOCOL_VERSIONS: readonly string[] = [
  ...new Set([
    '2025-06-18',
    '2025-11-25',
    LATEST_SPEC_VERSION,
    DRAFT_PROTOCOL_VERSION
  ])
];

/** True when `v` names a known spec version (dated or draft). */
export function isSpecVersion(v: unknown): v is SpecVersion {
  return SPEC_VERSION_TIMELINE.includes(v as SpecVersion);
}

/**
 * True when `v` is at or after `threshold` on the spec timeline. Lets a check
 * gate itself to the version that introduced its requirement (e.g. a
 * requirement added in 2026-07-28 passes `'2026-07-28'` as the threshold and
 * is then also enforced under the draft).
 */
export function specVersionAtLeast(
  v: SpecVersion,
  threshold: SpecVersion
): boolean {
  return (
    SPEC_VERSION_TIMELINE.indexOf(v) >= SPEC_VERSION_TIMELINE.indexOf(threshold)
  );
}

// Scenarios may also be tagged 'extension' to mark them as off-timeline
// (selectable via --suite extensions, never via --spec-version). See #256.
export type ScenarioSpecTag = SpecVersion | 'extension';

/**
 * Known protocol extensions that this suite has scenarios for.
 * Values are SEP-2133 extension identifiers (the keys used in
 * `capabilities.extensions`).
 */
export const EXTENSION_IDS = [
  'io.modelcontextprotocol/oauth-client-credentials',
  'io.modelcontextprotocol/enterprise-managed-authorization',
  'io.modelcontextprotocol/auth/dpop',
  'io.modelcontextprotocol/auth/wif',
  'io.modelcontextprotocol/tasks'
] as const;
export type ExtensionId = (typeof EXTENSION_IDS)[number];

/**
 * Where a scenario's requirement comes from. Either the dated spec timeline
 * (`introducedIn`/`removedIn`) or a named protocol extension that lives
 * outside the spec release cycle. Extensions never match `--spec-version`.
 */
export type ScenarioSource =
  | {
      introducedIn: SpecVersion;
      removedIn?: SpecVersion;
    }
  | { extensionId: ExtensionId };

export interface ScenarioUrls {
  serverUrl: string;
  authUrl?: string;
  /**
   * Optional context to pass to the client via MCP_CONFORMANCE_CONTEXT env var.
   * This is a JSON-serializable object containing scenario-specific data like credentials.
   */
  context?: Record<string, unknown>;
}

export interface Scenario {
  name: string;
  description: string;
  source: ScenarioSource;
  /**
   * If true, a non-zero client exit code is expected and will not cause the test to fail.
   * Use this for scenarios where the client is expected to error (e.g., rejecting invalid auth).
   */
  allowClientError?: boolean;
  start(ctx: ScenarioContext): Promise<ScenarioUrls>;
  stop(): Promise<void>;
  getChecks(): ConformanceCheck[];
}

export interface ClientScenario {
  name: string;
  description: string;
  source: ScenarioSource;
  run(ctx: RunContext): Promise<ConformanceCheck[]>;
}

export interface ClientScenarioForAuthorizationServer {
  name: string;
  description: string;
  source: ScenarioSource;
  run(
    options: AuthorizationServerOptions,
    details: Record<string, unknown>
  ): Promise<ConformanceCheck[]>;
}
