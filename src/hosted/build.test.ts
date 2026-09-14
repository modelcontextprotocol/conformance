import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCommit, buildInfo, buildText, UNKNOWN_BUILD } from './build';
import { gitBuild, packageRoot } from './git-build';

describe('server build', () => {
  it('shows a stamped commit and deploy time', () => {
    const info = buildInfo({
      build: '9004a11',
      deployedAt: '2026-09-14T06:40:12.345Z'
    });
    expect(info).toEqual({
      build: '9004a11',
      deployedAt: '2026-09-14T06:40:12.345Z'
    });
    expect(buildText(info)).toBe(
      'build 9004a11, deployed 2026-09-14 06:40 UTC'
    );
    expect(buildCommit(info)).toBe('9004a11');
    expect(buildCommit(buildInfo({ build: '9004a11-dirty' }))).toBe('9004a11');
  });

  it('reads "unknown" when nothing, or something that is not a commit, was stamped', () => {
    expect(buildInfo({})).toEqual({ build: UNKNOWN_BUILD });
    expect(buildInfo({ build: '<b>x</b>', deployedAt: 'yesterday' })).toEqual({
      build: UNKNOWN_BUILD
    });
    expect(buildText(buildInfo({}))).toBe('build unknown');
    expect(buildCommit(buildInfo({}))).toBeUndefined();
    // A report frozen before builds were recorded.
    expect(buildText(undefined)).toBe('build not recorded');
  });

  it('reads the checkout’s commit from git, and nothing outside a checkout', () => {
    const root = packageRoot(__dirname);
    expect(root).toBeDefined();
    expect(gitBuild(root!)).toMatch(/^[0-9a-f]{7,40}(-dirty)?$/);
    // A directory that is not the top of a checkout.
    expect(gitBuild(__dirname)).toBeUndefined();
    expect(gitBuild(mkdtempSync(join(tmpdir(), 'no-git-')))).toBeUndefined();
  });

  it('ignores GIT_DIR in the environment, as a git hook sets it', () => {
    const root = packageRoot(__dirname)!;
    const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: root,
      encoding: 'utf8'
    }).trim();
    vi.stubEnv('GIT_DIR', gitDir);
    try {
      expect(gitBuild(root)).toMatch(/^[0-9a-f]{7,40}(-dirty)?$/);
      expect(gitBuild(__dirname)).toBeUndefined();
      expect(gitBuild(mkdtempSync(join(tmpdir(), 'no-git-')))).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
