import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(function () {
    return {};
  })
}));

vi.mock('./checks/test-conformance-results', () => ({
  checkConformance: vi.fn().mockResolvedValue({
    status: 'pass',
    pass_rate: 1,
    passed: 1,
    failed: 0,
    total: 1,
    details: []
  }),
  checkClientConformance: vi.fn().mockResolvedValue({
    status: 'skipped',
    pass_rate: 0,
    passed: 0,
    failed: 0,
    total: 0,
    details: []
  })
}));

vi.mock('./checks/labels', () => ({
  checkLabels: vi.fn().mockResolvedValue({
    status: 'pass',
    present: 0,
    required: 0,
    missing: [],
    found: [],
    uses_issue_types: false
  })
}));

vi.mock('./checks/triage', () => ({
  checkTriage: vi.fn().mockResolvedValue({
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
  checkP0Resolution: vi.fn().mockResolvedValue({
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
  checkStableRelease: vi.fn().mockResolvedValue({
    status: 'pass',
    version: '1.0.0',
    is_stable: true,
    is_prerelease: false
  })
}));

vi.mock('./checks/files', () => ({
  checkPolicySignals: vi.fn().mockResolvedValue({
    status: 'pass',
    files: {}
  })
}));

vi.mock('./checks/spec-tracking', () => ({
  checkSpecTracking: vi.fn().mockResolvedValue({
    status: 'pass',
    latest_spec_release: '2025-11-25T00:00:00.000Z',
    latest_sdk_release: '2025-11-25T00:00:00.000Z',
    sdk_release_within_30d: true,
    days_gap: 0,
    target_spec_tag: '2025-11-25',
    submitted_sdk_tag: 'v1.4.0',
    meets_tier1_window: true,
    meets_tier2_window: true
  })
}));

import { createTierCheckCommand } from './index';
import { checkSpecTracking } from './checks/spec-tracking';

describe('createTierCheckCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkSpecTracking).mockResolvedValue({
      status: 'pass',
      latest_spec_release: '2025-11-25T00:00:00.000Z',
      latest_sdk_release: '2025-11-25T00:00:00.000Z',
      sdk_release_within_30d: true,
      days_gap: 0,
      target_spec_tag: '2025-11-25',
      submitted_sdk_tag: 'v1.4.0',
      meets_tier1_window: true,
      meets_tier2_window: true
    });
  });

  it('registers --sdk-release-tag as an option', () => {
    const tierCheck = createTierCheckCommand();
    const flags = tierCheck.options.map((o) => o.long);
    expect(flags).toContain('--sdk-release-tag');
  });

  it('forwards --sdk-release-tag and the raw --spec-version to checkSpecTracking', async () => {
    const tierCheck = createTierCheckCommand();
    await tierCheck.parseAsync(
      [
        '--repo',
        'modelcontextprotocol/typescript-sdk',
        '--skip-conformance',
        '--token',
        'fake-token',
        '--spec-version',
        '2025-11-25',
        '--sdk-release-tag',
        'v1.4.0',
        '--output',
        'json'
      ],
      { from: 'user' }
    );

    expect(checkSpecTracking).toHaveBeenCalledWith(
      expect.anything(),
      'modelcontextprotocol',
      'typescript-sdk',
      { sdkReleaseTag: 'v1.4.0', specVersion: '2025-11-25' }
    );
  });

  it('maps --spec-version draft to undefined (no draft release to track against)', async () => {
    const tierCheck = createTierCheckCommand();
    await tierCheck.parseAsync(
      [
        '--repo',
        'modelcontextprotocol/typescript-sdk',
        '--skip-conformance',
        '--token',
        'fake-token',
        '--spec-version',
        'draft',
        '--sdk-release-tag',
        'v1.4.0',
        '--output',
        'json'
      ],
      { from: 'user' }
    );

    expect(checkSpecTracking).toHaveBeenCalledWith(
      expect.anything(),
      'modelcontextprotocol',
      'typescript-sdk',
      { sdkReleaseTag: 'v1.4.0', specVersion: undefined }
    );
  });

  it('maps an absent --spec-version to undefined (legacy latest-stable mode)', async () => {
    const tierCheck = createTierCheckCommand();
    await tierCheck.parseAsync(
      [
        '--repo',
        'modelcontextprotocol/typescript-sdk',
        '--skip-conformance',
        '--token',
        'fake-token',
        '--sdk-release-tag',
        'v1.4.0',
        '--output',
        'json'
      ],
      { from: 'user' }
    );

    expect(checkSpecTracking).toHaveBeenCalledWith(
      expect.anything(),
      'modelcontextprotocol',
      'typescript-sdk',
      { sdkReleaseTag: 'v1.4.0', specVersion: undefined }
    );
  });
});
