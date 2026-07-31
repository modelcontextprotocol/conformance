import { describe, test, expect, vi } from 'vitest';
import { Octokit } from '@octokit/rest';
import { checkStableRelease, extractSemver } from './release';

function mockOctokit(
  releases: Array<{ tag_name: string; draft?: boolean; prerelease?: boolean }>
) {
  return {
    repos: {
      listReleases: vi.fn().mockResolvedValue({ data: releases })
    }
  } as unknown as Octokit;
}

describe('extractSemver', () => {
  test('plain tag', () => {
    expect(extractSemver('v1.2.3')).toEqual({
      version: '1.2.3',
      major: 1,
      prerelease: null
    });
  });

  test('no leading v', () => {
    expect(extractSemver('1.2.3')).toEqual({
      version: '1.2.3',
      major: 1,
      prerelease: null
    });
  });

  test('crate prefix', () => {
    expect(extractSemver('rust-mcp-sdk-v1.0.1')).toEqual({
      version: '1.0.1',
      major: 1,
      prerelease: null
    });
  });

  test('npm-style prefix with prerelease', () => {
    expect(extractSemver('mcp-use@1.18.0-canary.3')).toEqual({
      version: '1.18.0-canary.3',
      major: 1,
      prerelease: 'canary.3'
    });
  });

  test('semver prerelease', () => {
    expect(extractSemver('pkg-v2.0.0-rc.1')).toEqual({
      version: '2.0.0-rc.1',
      major: 2,
      prerelease: 'rc.1'
    });
  });

  test('0.x version', () => {
    expect(extractSemver('v0.9.1')).toEqual({
      version: '0.9.1',
      major: 0,
      prerelease: null
    });
  });

  test('no semver returns null', () => {
    expect(extractSemver('nightly')).toBeNull();
  });

  test('empty string returns null', () => {
    expect(extractSemver('')).toBeNull();
  });
});

describe('checkStableRelease', () => {
  test('plain tag passes', async () => {
    const octokit = mockOctokit([{ tag_name: 'v1.2.3' }]);
    const result = await checkStableRelease(octokit, 'owner', 'repo');
    expect(result).toEqual({
      status: 'pass',
      version: '1.2.3',
      is_stable: true,
      is_prerelease: false
    });
  });

  test('no leading v passes', async () => {
    const octokit = mockOctokit([{ tag_name: '1.2.3' }]);
    const result = await checkStableRelease(octokit, 'owner', 'repo');
    expect(result.status).toBe('pass');
    expect(result.version).toBe('1.2.3');
  });

  test('crate prefix passes', async () => {
    const octokit = mockOctokit([{ tag_name: 'rust-mcp-sdk-v1.0.1' }]);
    const result = await checkStableRelease(octokit, 'owner', 'repo');
    expect(result.status).toBe('pass');
    expect(result.version).toBe('1.0.1');
  });

  test('npm-style prefix with canary is prerelease', async () => {
    const octokit = mockOctokit([{ tag_name: 'mcp-use@1.18.0-canary.3' }]);
    const result = await checkStableRelease(octokit, 'owner', 'repo');
    expect(result.is_prerelease).toBe(true);
    expect(result.is_stable).toBe(false);
    expect(result.status).toBe('fail');
    expect(result.version).toBe('1.18.0-canary.3');
  });

  test('prefix filter picks correct tag', async () => {
    const octokit = mockOctokit([
      { tag_name: 'mcp-use@1.18.0-canary.3' },
      { tag_name: 'python-v1.5.2' }
    ]);
    const result = await checkStableRelease(
      octokit,
      'owner',
      'repo',
      'python-v'
    );
    expect(result.status).toBe('pass');
    expect(result.version).toBe('1.5.2');
    expect(result.is_stable).toBe(true);
  });

  test('0.x version fails', async () => {
    const octokit = mockOctokit([{ tag_name: 'v0.9.1' }]);
    const result = await checkStableRelease(octokit, 'owner', 'repo');
    expect(result.is_stable).toBe(false);
    expect(result.status).toBe('fail');
  });

  test('semver prerelease is prerelease', async () => {
    const octokit = mockOctokit([{ tag_name: 'pkg-v2.0.0-rc.1' }]);
    const result = await checkStableRelease(octokit, 'owner', 'repo');
    expect(result.is_prerelease).toBe(true);
    expect(result.is_stable).toBe(false);
    expect(result.status).toBe('fail');
  });

  test('unparseable tags are skipped in favor of a parseable one', async () => {
    const octokit = mockOctokit([
      { tag_name: 'nightly' },
      { tag_name: 'v1.0.0' }
    ]);
    const result = await checkStableRelease(octokit, 'owner', 'repo');
    expect(result.status).toBe('pass');
    expect(result.version).toBe('1.0.0');
  });

  test('drafts are ignored when a published release exists', async () => {
    const octokit = mockOctokit([
      { tag_name: 'v2.0.0', draft: true },
      { tag_name: 'v1.0.0' }
    ]);
    const result = await checkStableRelease(octokit, 'owner', 'repo');
    expect(result.status).toBe('pass');
    expect(result.version).toBe('1.0.0');
  });

  test('empty releases fails', async () => {
    const octokit = mockOctokit([]);
    const result = await checkStableRelease(octokit, 'owner', 'repo');
    expect(result.status).toBe('fail');
    expect(result.version).toBeNull();
    expect(result.is_stable).toBe(false);
  });

  test('candidate with prerelease flag on GitHub is prerelease', async () => {
    const octokit = mockOctokit([{ tag_name: 'v1.0.0', prerelease: true }]);
    const result = await checkStableRelease(octokit, 'owner', 'repo');
    expect(result.is_prerelease).toBe(true);
    expect(result.is_stable).toBe(false);
    expect(result.status).toBe('fail');
  });

  test('tag with prerelease markers in non-semver portion is prerelease', async () => {
    const octokit = mockOctokit([{ tag_name: 'canary-v1.0.0' }]);
    const result = await checkStableRelease(octokit, 'owner', 'repo');
    expect(result.is_prerelease).toBe(true);
    expect(result.is_stable).toBe(false);
  });

  test('tagPrefix filters out non-matching releases', async () => {
    const octokit = mockOctokit([
      { tag_name: 'rust-mcp-transport-v1.0.0' },
      { tag_name: 'rust-mcp-sdk-v1.0.1' }
    ]);
    const result = await checkStableRelease(
      octokit,
      'owner',
      'repo',
      'rust-mcp-sdk-v'
    );
    expect(result.status).toBe('pass');
    expect(result.version).toBe('1.0.1');
  });

  test('tagPrefix with no matching releases fails', async () => {
    const octokit = mockOctokit([{ tag_name: 'other-pkg-v1.0.0' }]);
    const result = await checkStableRelease(
      octokit,
      'owner',
      'repo',
      'my-pkg-v'
    );
    expect(result.status).toBe('fail');
    expect(result.version).toBeNull();
  });
});
