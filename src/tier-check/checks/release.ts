import { Octokit } from '@octokit/rest';
import { ReleaseResult } from '../types';

export async function checkStableRelease(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<ReleaseResult> {
  try {
    const { data: releases } = await octokit.repos.listReleases({
      owner,
      repo,
      per_page: 20
    });

    if (releases.length === 0) {
      return {
        status: 'fail',
        version: null,
        is_stable: false,
        is_prerelease: false
      };
    }

    // Find latest non-draft release
    const latest = releases.find((r) => !r.draft);
    if (!latest) {
      return {
        status: 'fail',
        version: null,
        is_stable: false,
        is_prerelease: false
      };
    }

    const version = latest.tag_name.replace(/^v/, '');
    const isPrerelease =
      latest.prerelease ||
      /-(alpha|beta|rc|dev|preview|snapshot)/i.test(version);

    // Check if version is >= 1.0.0
    const parts = version.split('.').map((p) => parseInt(p, 10));
    const isStable = !isPrerelease && parts.length >= 2 && parts[0] >= 1;

    return {
      status: isStable ? 'pass' : 'fail',
      version,
      is_stable: isStable,
      is_prerelease: isPrerelease
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
