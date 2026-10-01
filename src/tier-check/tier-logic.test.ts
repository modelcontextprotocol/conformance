import { describe, it, expect } from 'vitest';
import { computeTier } from './tier-logic';
import { TierScorecard } from './types';

/** A fully-passing fixture; tests override individual checks. */
function buildChecks(
  overrides: Partial<TierScorecard['checks']> = {}
): TierScorecard['checks'] {
  return {
    conformance: {
      status: 'pass',
      pass_rate: 1,
      passed: 10,
      failed: 0,
      total: 10,
      details: []
    },
    client_conformance: {
      status: 'pass',
      pass_rate: 1,
      passed: 10,
      failed: 0,
      total: 10,
      details: []
    },
    labels: {
      status: 'pass',
      present: 5,
      required: 5,
      missing: [],
      found: [],
      uses_issue_types: true
    },
    triage: {
      status: 'pass',
      compliance_rate: 1,
      total_issues: 10,
      triaged_within_sla: 10,
      exceeding_sla: 0,
      median_hours: 1,
      p95_hours: 2,
      days_analyzed: 30
    },
    p0_resolution: {
      status: 'pass',
      open_p0s: 0,
      open_p0_details: [],
      closed_within_7d: 1,
      closed_within_14d: 1,
      closed_total: 1,
      all_p0s_resolved_within_7d: true,
      all_p0s_resolved_within_14d: true
    },
    stable_release: {
      status: 'pass',
      version: '1.0.0',
      is_stable: true,
      is_prerelease: false
    },
    policy_signals: {
      status: 'pass',
      files: {}
    },
    spec_tracking: {
      status: 'pass',
      latest_spec_release: '2025-11-25T00:00:00.000Z',
      latest_sdk_release: '2025-11-25T00:00:00.000Z',
      sdk_release_within_30d: true,
      days_gap: 0,
      target_spec_tag: '2025-11-25',
      submitted_sdk_tag: 'v1.4.0',
      meets_tier1_window: true,
      meets_tier2_window: true
    },
    ...overrides
  };
}

describe('computeTier — spec_tracking', () => {
  it('pass: no blocker, tier 1', () => {
    const result = computeTier(buildChecks());
    expect(result.tier1_blockers).not.toContain('spec_tracking');
    expect(result.tier).toBe(1);
  });

  it('partial: blocks tier 1 but tier2Met stays true (tier 2)', () => {
    const checks = buildChecks({
      spec_tracking: {
        status: 'partial',
        latest_spec_release: '2025-11-25T00:00:00.000Z',
        latest_sdk_release: '2026-01-01T00:00:00.000Z',
        sdk_release_within_30d: false,
        days_gap: 37,
        target_spec_tag: '2025-11-25',
        submitted_sdk_tag: 'v1.4.0',
        meets_tier1_window: false,
        meets_tier2_window: true
      }
    });
    const result = computeTier(checks);
    expect(result.tier1_blockers).toContain('spec_tracking');
    expect(result.tier2_met).toBe(true);
    expect(result.tier).toBe(2);
  });

  it('fail: blocks tier 1 and tier2Met becomes false (tier 3)', () => {
    const checks = buildChecks({
      spec_tracking: {
        status: 'fail',
        latest_spec_release: '2025-11-25T00:00:00.000Z',
        latest_sdk_release: '2026-06-01T00:00:00.000Z',
        sdk_release_within_30d: false,
        days_gap: 188,
        target_spec_tag: '2025-11-25',
        submitted_sdk_tag: 'v1.4.0',
        meets_tier1_window: false,
        meets_tier2_window: false
      }
    });
    const result = computeTier(checks);
    expect(result.tier1_blockers).toContain('spec_tracking');
    expect(result.tier2_met).toBe(false);
    expect(result.tier).toBe(3);
  });

  it('skipped: pushes "spec_tracking (skipped)" blocker, tier2Met tolerates it (tier 2)', () => {
    const checks = buildChecks({
      spec_tracking: {
        status: 'skipped',
        latest_spec_release: null,
        latest_sdk_release: null,
        sdk_release_within_30d: null,
        days_gap: null,
        target_spec_tag: null,
        submitted_sdk_tag: null,
        meets_tier1_window: null,
        meets_tier2_window: null,
        reason: 'github api error'
      }
    });
    const result = computeTier(checks);
    expect(result.tier1_blockers).toContain('spec_tracking (skipped)');
    expect(result.tier1_blockers).not.toContain('spec_tracking');
    expect(result.tier2_met).toBe(true);
    expect(result.tier).toBe(2);
  });

  it('driven by meets_tier1_window/meets_tier2_window fields, not the status string', () => {
    // A hypothetical 'partial' result whose window fields say Tier 1 is
    // actually met should not block tier 1 — computeTier reads the fields,
    // not the status label.
    const checks = buildChecks({
      spec_tracking: {
        status: 'partial',
        latest_spec_release: '2025-11-25T00:00:00.000Z',
        latest_sdk_release: '2025-11-20T00:00:00.000Z',
        sdk_release_within_30d: true,
        days_gap: -5,
        target_spec_tag: '2025-11-25',
        submitted_sdk_tag: 'v1.4.0',
        meets_tier1_window: true,
        meets_tier2_window: true
      }
    });
    const result = computeTier(checks);
    expect(result.tier1_blockers).not.toContain('spec_tracking');
    expect(result.tier).toBe(1);
  });
});
