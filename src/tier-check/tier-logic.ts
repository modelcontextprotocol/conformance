import { TierScorecard } from './types';

export function computeTier(
  checks: TierScorecard['checks']
): TierScorecard['implied_tier'] {
  const tier1Blockers: string[] = [];

  // Check Tier 1 requirements
  if (checks.conformance.status === 'skipped') {
    tier1Blockers.push('conformance (skipped)');
  } else if (checks.conformance.pass_rate < 1.0) {
    tier1Blockers.push('conformance');
  }

  if (checks.triage.compliance_rate < 0.9) {
    tier1Blockers.push('triage');
  }

  if (!checks.p0_resolution.all_p0s_resolved_within_7d) {
    tier1Blockers.push('p0_resolution');
  }

  if (!checks.stable_release.is_stable) {
    tier1Blockers.push('stable_release');
  }

  // File checks - needed for T1
  const missingFiles = Object.entries(checks.file_existence.files)
    .filter(([, exists]) => !exists)
    .map(([file]) => file);
  if (missingFiles.length > 0) {
    tier1Blockers.push('file_existence');
  }

  if (checks.spec_tracking.status === 'fail') {
    tier1Blockers.push('spec_tracking');
  }

  if (checks.labels.missing.length > 0) {
    tier1Blockers.push('labels');
  }

  // Check Tier 2 requirements
  const tier2Met =
    (checks.conformance.status === 'skipped' ||
      checks.conformance.pass_rate >= 0.8) &&
    checks.p0_resolution.all_p0s_resolved_within_14d &&
    checks.stable_release.is_stable;

  const tier = tier1Blockers.length === 0 ? 1 : tier2Met ? 2 : 3;

  return {
    tier,
    tier1_blockers: tier1Blockers,
    tier2_met: tier2Met,
    note:
      tier === 1
        ? 'All deterministic checks pass. Judgment-based checks (docs, policy, roadmap) require /mcp-sdk-tier-audit skill.'
        : 'Partial assessment — judgment-based checks require /mcp-sdk-tier-audit skill'
  };
}
