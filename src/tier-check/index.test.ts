import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTierCheckCommand } from './index';
import { listRequirementRevisions } from '../requirements';
import type { ConformanceResult, TierScorecard } from './types';

// The GitHub-backed checks and the conformance legs are stubbed: these tests
// are about which requirement set the command claims to have scored, not
// about the checks themselves, and must not reach the network or spawn the
// CLI.
vi.mock('./checks/labels', () => ({
  checkLabels: async () => ({
    status: 'pass',
    present: 0,
    required: 0,
    missing: [],
    found: [],
    uses_issue_types: false
  })
}));
vi.mock('./checks/triage', () => ({
  checkTriage: async () => ({
    status: 'pass',
    compliance_rate: 1,
    total_issues: 0,
    triaged_within_sla: 0,
    exceeding_sla: 0,
    median_hours: 0,
    p95_hours: 0,
    days_analyzed: undefined
  })
}));
vi.mock('./checks/p0', () => ({
  checkP0Resolution: async () => ({
    status: 'pass',
    open_p0s: 0,
    open_p0_details: [],
    closed_within_7d: 0,
    closed_within_14d: 0,
    closed_total: 0,
    all_p0s_resolved_within_7d: true,
    all_p0s_resolved_within_14d: true
  })
}));
vi.mock('./checks/release', () => ({
  checkStableRelease: async () => ({
    status: 'pass',
    version: '1.0.0',
    is_stable: true,
    is_prerelease: false
  })
}));
vi.mock('./checks/files', () => ({
  checkPolicySignals: async () => ({ status: 'pass', files: {} })
}));
vi.mock('./checks/spec-tracking', () => ({
  checkSpecTracking: async () => ({
    status: 'pass',
    latest_spec_release: null,
    latest_sdk_release: null,
    sdk_release_within_30d: null,
    days_gap: null
  })
}));
vi.mock('./checks/test-conformance-results', () => {
  const skipped = (): ConformanceResult => ({
    status: 'skipped',
    pass_rate: 0,
    passed: 0,
    failed: 0,
    total: 0,
    details: []
  });
  return {
    checkConformance: async () => skipped(),
    checkClientConformance: async () => skipped(),
    mergeByRevision: () => skipped()
  };
});

/** Run `tier-check <args> --output json` and return the printed scorecard. */
async function runTierCheck(args: string[]): Promise<TierScorecard> {
  const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await createTierCheckCommand().parseAsync(
    ['--repo', 'modelcontextprotocol/sdk', '--token', 'test', ...args],
    { from: 'user' }
  );
  const printed = stdout.mock.calls[stdout.mock.calls.length - 1]?.[0];
  return JSON.parse(String(printed));
}

describe('tier-check default requirement set', () => {
  const exitCode = process.exitCode;

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = exitCode;
  });

  const revisions = listRequirementRevisions();
  const latest = revisions[revisions.length - 1];

  it('claims no requirement set when there is no conformance leg to score', async () => {
    // Neither --conformance-server-url nor --client-cmd: a GitHub-only run.
    // Nothing is measured, so the scorecard must not say a revision was.
    const scorecard = await runTierCheck(['--output', 'json']);
    expect(scorecard.checks.conformance.status).toBe('skipped');
    expect(scorecard.checks.client_conformance.status).toBe('skipped');
    expect(scorecard.requirements_revisions).toBeNull();
  });

  it('defaults to the latest shipped revision when a server URL is given', async () => {
    const scorecard = await runTierCheck([
      '--conformance-server-url',
      'http://localhost:3000/mcp',
      '--output',
      'json'
    ]);
    expect(scorecard.requirements_revisions).toEqual([latest]);
  });

  it('defaults to the latest shipped revision when only a client command is given', async () => {
    const scorecard = await runTierCheck([
      '--client-cmd',
      'node client.js',
      '--output',
      'json'
    ]);
    expect(scorecard.requirements_revisions).toEqual([latest]);
  });

  it('leaves an explicit --requirements untouched without a conformance leg', async () => {
    const scorecard = await runTierCheck([
      '--requirements',
      latest,
      '--output',
      'json'
    ]);
    expect(scorecard.requirements_revisions).toEqual([latest]);
  });
});
