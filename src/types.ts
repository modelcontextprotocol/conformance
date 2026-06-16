import type { RunContext } from './connection';
import type { ScenarioContext } from './mock-server';

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
  details?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  errorMessage?: string;
  logs?: string[];
}

export const DATED_SPEC_VERSIONS = [
  '2025-03-26',
  '2025-06-18',
  '2025-11-25'
] as const;

export type DatedSpecVersion = (typeof DATED_SPEC_VERSIONS)[number];

export const LATEST_SPEC_VERSION: DatedSpecVersion = '2025-11-25';

/**
 * Wire `protocolVersion` for the in-progress spec. Mirrors
 * `LATEST_PROTOCOL_VERSION` in the spec repo's `schema/draft/schema.ts`;
 * bump when that constant changes.
 */
export const DRAFT_PROTOCOL_VERSION = '2026-07-28';

// Wire protocolVersion strings the mock server will negotiate on initialize.
export const NEGOTIABLE_PROTOCOL_VERSIONS: readonly string[] = [
  '2025-06-18',
  LATEST_SPEC_VERSION,
  DRAFT_PROTOCOL_VERSION
];

/**
 * A spec revision the conformance suite can target via `--spec-version`.
 * Always a wire `protocolVersion` string. The CLI also accepts `'draft'` as
 * an alias for {@link DRAFT_PROTOCOL_VERSION}.
 */
export type SpecVersion = DatedSpecVersion | typeof DRAFT_PROTOCOL_VERSION;

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
  'io.modelcontextprotocol/enterprise-managed-authorization'
] as const;
export type ExtensionId = (typeof EXTENSION_IDS)[number];

/**
 * Where a scenario's requirement comes from. Either the dated spec timeline
 * (`introducedIn`/`removedIn`) or a named protocol extension that lives
 * outside the spec release cycle. Extensions never match `--spec-version`.
 */
export type ScenarioSource =
  | {
      introducedIn: DatedSpecVersion | typeof DRAFT_PROTOCOL_VERSION;
      removedIn?: DatedSpecVersion | typeof DRAFT_PROTOCOL_VERSION;
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
  run(serverUrl: string): Promise<ConformanceCheck[]>;
}
