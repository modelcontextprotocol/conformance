import {
  ConformanceResult,
  LabelsResult,
  TriageResult,
  P0Result,
  ReleaseResult,
  PolicySignalsResult,
  SpecTrackingResult
} from '../types';

export const skippedConformance = (): ConformanceResult => ({
  status: 'skipped',
  pass_rate: 0,
  passed: 0,
  failed: 0,
  total: 0,
  details: []
});

export const skippedLabels = (): LabelsResult => ({
  status: 'skipped',
  present: 0,
  required: 0,
  missing: [],
  found: [],
  uses_issue_types: false
});

export const skippedTriage = (): TriageResult => ({
  status: 'skipped',
  compliance_rate: 0,
  total_issues: 0,
  triaged_within_sla: 0,
  exceeding_sla: 0,
  median_hours: 0,
  p95_hours: 0,
  days_analyzed: undefined
});

export const skippedP0 = (): P0Result => ({
  status: 'skipped',
  open_p0s: 0,
  open_p0_details: [],
  closed_within_7d: 0,
  closed_within_14d: 0,
  closed_total: 0,
  all_p0s_resolved_within_7d: false,
  all_p0s_resolved_within_14d: false
});

export const skippedRelease = (): ReleaseResult => ({
  status: 'skipped',
  version: null,
  is_stable: false,
  is_prerelease: false
});

export const skippedPolicySignals = (): PolicySignalsResult => ({
  status: 'skipped',
  files: {}
});

export const skippedSpecTracking = (): SpecTrackingResult => ({
  status: 'skipped',
  latest_spec_release: null,
  latest_sdk_release: null,
  sdk_release_within_30d: null,
  days_gap: null
});
