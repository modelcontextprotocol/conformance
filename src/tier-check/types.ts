export type CheckStatus = 'pass' | 'fail' | 'partial' | 'skipped';

export interface CheckResult {
  status: CheckStatus;
  [key: string]: unknown;
}

export interface ConformanceResult extends CheckResult {
  pass_rate: number;
  passed: number;
  failed: number;
  total: number;
  details: Array<{
    scenario: string;
    passed: boolean;
    checks_passed: number;
    checks_failed: number;
  }>;
}

export interface LabelsResult extends CheckResult {
  present: number;
  required: number;
  missing: string[];
  found: string[];
  uses_issue_types: boolean;
}

export interface TriageResult extends CheckResult {
  compliance_rate: number;
  total_issues: number;
  triaged_within_sla: number;
  exceeding_sla: number;
  median_hours: number;
  p95_hours: number;
  days_analyzed: number | undefined;
}

export interface P0Result extends CheckResult {
  open_p0s: number;
  open_p0_details: Array<{ number: number; title: string; age_days: number }>;
  closed_within_7d: number;
  closed_within_14d: number;
  closed_total: number;
  all_p0s_resolved_within_7d: boolean;
  all_p0s_resolved_within_14d: boolean;
}

export interface ReleaseResult extends CheckResult {
  version: string | null;
  is_stable: boolean;
  is_prerelease: boolean;
}

export interface PolicySignalsResult extends CheckResult {
  files: Record<string, boolean>;
}

export interface SpecTrackingResult extends CheckResult {
  latest_spec_release: string | null;
  latest_sdk_release: string | null;
  sdk_release_within_30d: boolean | null;
  days_gap: number | null;
}

export interface TierScorecard {
  repo: string;
  branch: string | null;
  timestamp: string;
  version: string | null;
  checks: {
    conformance: ConformanceResult;
    client_conformance: ConformanceResult;
    labels: LabelsResult;
    triage: TriageResult;
    p0_resolution: P0Result;
    stable_release: ReleaseResult;
    policy_signals: PolicySignalsResult;
    spec_tracking: SpecTrackingResult;
  };
  implied_tier: {
    tier: 1 | 2 | 3;
    tier1_blockers: string[];
    tier2_met: boolean;
    note: string;
  };
}
