import { Octokit } from '@octokit/rest';
import { SpecTrackingResult } from '../types';

export async function checkSpecTracking(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<SpecTrackingResult> {
  try {
    // Get latest spec release from modelcontextprotocol/modelcontextprotocol
    const { data: specReleases } = await octokit.repos.listReleases({
      owner: 'modelcontextprotocol',
      repo: 'modelcontextprotocol',
      per_page: 5
    });
    const latestSpec = specReleases.find((r) => !r.draft && !r.prerelease);

    // Get SDK releases (API returns newest-first)
    const { data: sdkReleases } = await octokit.repos.listReleases({
      owner,
      repo,
      per_page: 50
    });
    const nonDraftSdkReleases = sdkReleases.filter((r) => !r.draft);

    if (!latestSpec || nonDraftSdkReleases.length === 0) {
      return {
        status: 'skipped',
        latest_spec_release: latestSpec?.published_at || null,
        latest_sdk_release: nonDraftSdkReleases[0]?.published_at || null,
        sdk_release_within_30d: null,
        days_gap: null
      };
    }

    const specDate = new Date(latestSpec.published_at!);

    // Reverse so oldest-first, then find the FIRST SDK release after the spec
    const oldestFirst = [...nonDraftSdkReleases].reverse();
    const firstSdkAfterSpec = oldestFirst.find(
      (r) => new Date(r.published_at!) >= specDate
    );

    if (!firstSdkAfterSpec) {
      // No SDK release after the latest spec release
      const daysSinceSpec = Math.round(
        (Date.now() - specDate.getTime()) / (1000 * 60 * 60 * 24)
      );
      return {
        status: daysSinceSpec <= 30 ? 'pass' : 'fail',
        latest_spec_release: latestSpec.published_at,
        latest_sdk_release: nonDraftSdkReleases[0]?.published_at || null,
        sdk_release_within_30d: daysSinceSpec <= 30,
        days_gap: daysSinceSpec
      };
    }

    const sdkDate = new Date(firstSdkAfterSpec.published_at!);
    const daysGap = Math.round(
      (sdkDate.getTime() - specDate.getTime()) / (1000 * 60 * 60 * 24)
    );

    return {
      status: daysGap <= 30 ? 'pass' : 'fail',
      latest_spec_release: latestSpec.published_at,
      latest_sdk_release: firstSdkAfterSpec.published_at,
      sdk_release_within_30d: daysGap <= 30,
      days_gap: daysGap
    };
  } catch {
    return {
      status: 'skipped',
      latest_spec_release: null,
      latest_sdk_release: null,
      sdk_release_within_30d: null,
      days_gap: null
    };
  }
}
