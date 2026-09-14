import { describe, it, expect } from 'vitest';
import { Octokit } from '@octokit/rest';
import { checkStableRelease } from './release';

type Release = {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
};

/** An Octokit stub that returns a fixed release list. */
function octokitWith(releases: Release[]): Octokit {
  return {
    repos: {
      listReleases: async () => ({
        data: releases.map((r) => ({
          draft: false,
          prerelease: false,
          ...r
        }))
      })
    }
  } as unknown as Octokit;
}

async function check(releases: Release[]) {
  return checkStableRelease(
    octokitWith(releases),
    'modelcontextprotocol',
    'sdk'
  );
}

describe('checkStableRelease', () => {
  it('accepts a bare semver tag', async () => {
    expect(await check([{ tag_name: '1.2.3' }])).toMatchObject({
      status: 'pass',
      version: '1.2.3',
      is_stable: true
    });
  });

  it('accepts a v-prefixed tag', async () => {
    expect(await check([{ tag_name: 'v1.2.3' }])).toMatchObject({
      status: 'pass',
      version: '1.2.3',
      is_stable: true
    });
  });

  // https://github.com/modelcontextprotocol/conformance/issues/425
  it('accepts a monorepo tag carrying a package-name prefix', async () => {
    expect(await check([{ tag_name: 'rmcp-v3.0.1' }])).toMatchObject({
      status: 'pass',
      version: '3.0.1',
      is_stable: true
    });
  });

  it('accepts a monorepo tag whose package name contains a hyphen', async () => {
    expect(await check([{ tag_name: 'rmcp-macros-v3.0.1' }])).toMatchObject({
      status: 'pass',
      version: '3.0.1',
      is_stable: true
    });
  });

  it('rejects a pre-1.0 release', async () => {
    expect(await check([{ tag_name: 'rmcp-v0.9.0' }])).toMatchObject({
      status: 'fail',
      version: '0.9.0',
      is_stable: false
    });
  });

  it('rejects a prerelease named in the tag', async () => {
    expect(await check([{ tag_name: 'rmcp-v3.0.1-alpha.1' }])).toMatchObject({
      status: 'fail',
      version: '3.0.1-alpha.1',
      is_stable: false,
      is_prerelease: true
    });
  });

  it('rejects a release GitHub flags as a prerelease', async () => {
    expect(
      await check([{ tag_name: 'rmcp-v3.0.1', prerelease: true }])
    ).toMatchObject({
      status: 'fail',
      is_stable: false,
      is_prerelease: true
    });
  });

  it('skips drafts and scores the first published release', async () => {
    expect(
      await check([
        { tag_name: 'rmcp-v4.0.0', draft: true },
        { tag_name: 'rmcp-v3.0.1' }
      ])
    ).toMatchObject({ status: 'pass', version: '3.0.1' });
  });

  it('reports an unparseable tag unchanged rather than dropping it', async () => {
    expect(await check([{ tag_name: 'nightly' }])).toMatchObject({
      status: 'fail',
      version: 'nightly',
      is_stable: false
    });
  });

  it('fails when the repo has no releases', async () => {
    expect(await check([])).toMatchObject({
      status: 'fail',
      version: null,
      is_stable: false
    });
  });
});
