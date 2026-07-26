import { Octokit } from '@octokit/rest';
import { ReleaseResult } from '../types';

/**
 * Extracts the first semver from a release tag, tolerating monorepo tag
 * prefixes such as `rust-mcp-sdk-v1.0.1`, `mcp-use@1.18.0-canary.3`,
 * or plain `v1.2.3`. Returns null when the tag contains no semver.
 */
export function extractSemver(
  tag: string
): { version: string; major: number; prerelease: string | null } | null {
  const match = tag.match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return {
    version: match[0],
    major: parseInt(match[1], 10),
    prerelease: match[4] ?? null
  };
}

// Word-boundary match so markers are caught both at the start of a tag
// (e.g. `canary-v1.0.0`) and after a `-` separator (e.g. `v1.0.0-alpha`).
const PRERELEASE_MARKERS = /\b(alpha|beta|rc|dev|preview|snapshot|canary)\b/i;

export async function checkStableRelease(
  octokit: Octokit,
  owner: string,
  repo: string,
  tagPrefix?: string
): Promise<ReleaseResult> {
  try {
    const { data: releases } = await octokit.repos.listReleases({
      owner,
      repo,
      // With a prefix filter, widen the window so the package's latest
      // release isn't pushed out by other packages' releases.
      per_page: tagPrefix ? 100 : 20
    });

    if (releases.length === 0) {
      return {
        status: 'fail',
        version: null,
        is_stable: false,
        is_prerelease: false
      };
    }

    const candidates = releases.filter(
      (r) => !r.draft && (!tagPrefix || r.tag_name.startsWith(tagPrefix))
    );

    // First release (API order) whose tag contains a parseable semver.
    // Tags with no semver are skipped , previously they produced a fail with
    // the raw tag as version, which broke selection in mixed-tag monorepos.
    for (const release of candidates) {
      const parsed = extractSemver(release.tag_name);
      if (!parsed) continue;

      const isPrerelease =
        release.prerelease ||
        (parsed.prerelease !== null &&
          PRERELEASE_MARKERS.test(`-${parsed.prerelease}`)) ||
        PRERELEASE_MARKERS.test(release.tag_name);

      const isStable = !isPrerelease && parsed.major >= 1;

      return {
        status: isStable ? 'pass' : 'fail',
        version: parsed.version,
        is_stable: isStable,
        is_prerelease: isPrerelease
      };
    }

    return {
      status: 'fail',
      version: null,
      is_stable: false,
      is_prerelease: false
    };
  } catch {
    return {
      status: 'fail',
      version: null,
      is_stable: false,
      is_prerelease: false
    };
  }
}
