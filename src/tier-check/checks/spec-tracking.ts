import { Octokit } from '@octokit/rest';
import { SpecTrackingResult } from '../types';

const MS_PER_DAY = 1000 * 60 * 60 * 24;

// SEP-1730 Tier 2 window: an SDK release lands within six months of the
// spec version it targets. Replaces the previous hardcoded 30-day check.
const TIER2_WINDOW_DAYS = 183;

interface ReleaseLike {
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string | null;
  created_at?: string | null;
}

export interface SpecTrackingOptions {
  /** Exact release tag of the submitted SDK version (no normalization). */
  sdkReleaseTag?: string;
  /** Exact release tag on modelcontextprotocol/modelcontextprotocol to pin to. */
  specVersion?: string;
}

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    (err as { status?: unknown }).status === 404
  );
}

// SEP-1730 window verdicts, derived once alongside the display status: Tier 1
// requires landing before (or with) the spec release; Tier 2 tolerates up to
// six months after.
function windows(daysGap: number): {
  status: SpecTrackingResult['status'];
  meetsTier1Window: boolean;
  meetsTier2Window: boolean;
} {
  const meetsTier1Window = daysGap <= 0;
  const meetsTier2Window = daysGap <= TIER2_WINDOW_DAYS;
  const status = meetsTier1Window
    ? 'pass'
    : meetsTier2Window
      ? 'partial'
      : 'fail';
  return { status, meetsTier1Window, meetsTier2Window };
}

function gapResult(params: {
  specPublishedAt: string;
  sdkPublishedAt: string;
  targetSpecTag: string | null;
  submittedSdkTag: string | null;
}): SpecTrackingResult {
  const daysGap = Math.round(
    (new Date(params.sdkPublishedAt).getTime() -
      new Date(params.specPublishedAt).getTime()) /
      MS_PER_DAY
  );
  const { status, meetsTier1Window, meetsTier2Window } = windows(daysGap);

  return {
    status,
    latest_spec_release: params.specPublishedAt,
    latest_sdk_release: params.sdkPublishedAt,
    sdk_release_within_30d: daysGap <= 30,
    days_gap: daysGap,
    target_spec_tag: params.targetSpecTag,
    submitted_sdk_tag: params.submittedSdkTag,
    meets_tier1_window: meetsTier1Window,
    meets_tier2_window: meetsTier2Window
  };
}

export async function checkSpecTracking(
  octokit: Octokit,
  owner: string,
  repo: string,
  opts: SpecTrackingOptions = {}
): Promise<SpecTrackingResult> {
  const targetSpecTag = opts.specVersion ?? null;
  const submittedSdkTag = opts.sdkReleaseTag ?? null;

  // Fail/skip results always carry the tags already known at the call site
  // (from the function-scope consts above) plus latest_spec_release when the
  // spec was already resolved — a single derivation site so no return path
  // can silently drop information a caller would expect.
  function failResult(
    reason: string,
    latestSpecRelease: string | null = null
  ): SpecTrackingResult {
    return {
      status: 'fail',
      latest_spec_release: latestSpecRelease,
      latest_sdk_release: null,
      sdk_release_within_30d: null,
      days_gap: null,
      target_spec_tag: targetSpecTag,
      submitted_sdk_tag: submittedSdkTag,
      meets_tier1_window: false,
      meets_tier2_window: false,
      reason
    };
  }

  function skipResult(
    reason: string,
    latestSpecRelease: string | null = null
  ): SpecTrackingResult {
    return {
      status: 'skipped',
      latest_spec_release: latestSpecRelease,
      latest_sdk_release: null,
      sdk_release_within_30d: null,
      days_gap: null,
      target_spec_tag: targetSpecTag,
      submitted_sdk_tag: submittedSdkTag,
      meets_tier1_window: null,
      meets_tier2_window: null,
      reason
    };
  }

  // --- Resolve the spec release to track against ---
  let specRelease: ReleaseLike;
  if (opts.specVersion) {
    try {
      const { data } = await octokit.repos.getReleaseByTag({
        owner: 'modelcontextprotocol',
        repo: 'modelcontextprotocol',
        tag: opts.specVersion
      });
      specRelease = data;
    } catch (err) {
      if (isNotFoundError(err)) {
        return failResult(`spec release tag not found: ${opts.specVersion}`);
      }
      return skipResult('github api error');
    }

    if (specRelease.draft) {
      return failResult(`spec release is a draft: ${opts.specVersion}`);
    }
  } else {
    try {
      const { data: specReleases } = await octokit.repos.listReleases({
        owner: 'modelcontextprotocol',
        repo: 'modelcontextprotocol',
        per_page: 5
      });
      const latestSpec = specReleases.find((r) => !r.draft && !r.prerelease);
      if (!latestSpec) {
        return skipResult('no spec releases found');
      }
      specRelease = latestSpec;
    } catch {
      return skipResult('github api error');
    }
  }

  const specPublishedAt = specRelease.published_at ?? specRelease.created_at!;
  const specDate = new Date(specPublishedAt);

  // --- Resolve the SDK release to compare against the spec ---
  if (opts.sdkReleaseTag) {
    let sdkRelease: ReleaseLike;
    try {
      const { data } = await octokit.repos.getReleaseByTag({
        owner,
        repo,
        tag: opts.sdkReleaseTag
      });
      sdkRelease = data;
    } catch (err) {
      if (isNotFoundError(err)) {
        return failResult(
          `sdk release tag not found: ${opts.sdkReleaseTag}`,
          specPublishedAt
        );
      }
      return skipResult('github api error', specPublishedAt);
    }

    if (sdkRelease.draft) {
      return failResult(
        `submitted release is a draft: ${opts.sdkReleaseTag}`,
        specPublishedAt
      );
    }

    const sdkPublishedAt = sdkRelease.published_at ?? sdkRelease.created_at!;
    return gapResult({
      specPublishedAt,
      sdkPublishedAt,
      targetSpecTag,
      submittedSdkTag
    });
  }

  // Legacy mode: first non-draft SDK release published on/after the spec.
  try {
    const { data: sdkReleases } = await octokit.repos.listReleases({
      owner,
      repo,
      per_page: 50
    });
    const nonDraftSdkReleases = sdkReleases.filter((r) => !r.draft);

    if (nonDraftSdkReleases.length === 0) {
      return skipResult('no sdk releases found', specPublishedAt);
    }

    // API returns newest-first; reverse so oldest-first, then find the
    // FIRST SDK release published on/after the spec.
    const oldestFirst = [...nonDraftSdkReleases].reverse();
    const firstSdkAfterSpec = oldestFirst.find(
      (r) => new Date(r.published_at!) >= specDate
    );

    if (!firstSdkAfterSpec) {
      const daysElapsed = Math.round(
        (Date.now() - specDate.getTime()) / MS_PER_DAY
      );
      const { status, meetsTier1Window, meetsTier2Window } =
        windows(daysElapsed);
      return {
        status,
        latest_spec_release: specPublishedAt,
        latest_sdk_release: nonDraftSdkReleases[0]?.published_at ?? null,
        sdk_release_within_30d: daysElapsed <= 30,
        days_gap: daysElapsed,
        target_spec_tag: targetSpecTag,
        submitted_sdk_tag: submittedSdkTag,
        meets_tier1_window: meetsTier1Window,
        meets_tier2_window: meetsTier2Window
      };
    }

    return gapResult({
      specPublishedAt,
      sdkPublishedAt: firstSdkAfterSpec.published_at!,
      targetSpecTag,
      submittedSdkTag
    });
  } catch {
    return skipResult('github api error', specPublishedAt);
  }
}
