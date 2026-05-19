/**
 * Shared types for the SEP traceability manifest (src/seps/traceability.json).
 *
 * IMPORTANT scope note: this manifest records whether a *conformance scenario
 * exists* for each declared SEP requirement. It says NOTHING about whether any
 * particular SDK passes that scenario — per-SDK pass/fail lives in `tier-check`.
 *
 * Joining the two is a future goal, NOT possible today: tier-check reports at
 * scenario granularity and does not currently expose per-check IDs, while this
 * manifest carries check IDs but not scenario names. Wiring plan.mcp.io's two
 * feeds together needs one side to add the missing column first.
 */

export const TRACEABILITY_SCHEMA_VERSION = 1;

/** Status of a single declared requirement (a yaml `check:` row). */
export type CheckStatus =
  /** A matching check ID was emitted when the conformance suite ran. */
  | 'tested'
  /** Declared, but no matching check ID was emitted by any scenario run. */
  | 'untested';

export interface RequirementTraceability {
  check: string;
  status: CheckStatus;
  /** The normative sentence from the yaml (for tracker display). */
  text?: string;
  /** Per-requirement spec URL from the yaml, if finer than the SEP's specUrl. */
  url?: string;
  /** Tracking issue from the yaml, if any. */
  issue?: string;
}

export interface ExcludedRequirement {
  text: string;
  reason: string;
  issue?: string;
}

/** A yaml row with neither `check:` nor `excluded:` (an authoring gap). */
export interface UnkeyedRequirement {
  text: string;
}

export interface SepTraceability {
  /** Path to the traceability yaml, or null if scenarios exist but no yaml. */
  yaml: string | null;
  /** Spec URL from the yaml's `spec_url`, or null. */
  specUrl: string | null;
  requirements: RequirementTraceability[];
  excluded: ExcludedRequirement[];
  unkeyed: UnkeyedRequirement[];
  /**
   * Check IDs emitted by the suite run but not declared in any yaml row.
   * Usually scenario scaffolding (gates) or extra checks beyond the SEP.
   */
  untracked: string[];
  summary: {
    tested: number;
    untested: number;
    excluded: number;
    untracked: number;
    unkeyed: number;
  };
}

export interface TraceabilityManifest {
  schemaVersion: number;
  /** Pointer to where this file's semantics are documented (not prose-in-data). */
  docs: string;
  /**
   * What the emitted set was collected against, e.g. "typescript-sdk@<sha>".
   * Provenance for consumers; no wall-clock timestamp so an unchanged run
   * produces an empty diff. null when not supplied.
   */
  source: string | null;
  /** Keyed by SEP number (as a string). */
  seps: Record<string, SepTraceability>;
}
