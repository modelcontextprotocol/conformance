/**
 * Which build of the server answered: the short git commit it was built
 * from (with `-dirty` when the tree had uncommitted changes), and when it
 * was deployed, where that is known. Shown on every page and stored in each
 * run report, so a frozen copy says which build produced it.
 */

import { BUILD_STAMP } from './build-stamp';

export interface BuildInfo {
  /** Short git commit, `<sha>-dirty`, or UNKNOWN_BUILD. */
  build: string;
  /** When the build was deployed (ISO 8601), where the deploy said. */
  deployedAt?: string;
}

export const UNKNOWN_BUILD = 'unknown';

const BUILD_RE = /^[0-9a-f]{7,40}(-dirty)?$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;

/**
 * `stamp` as shown: a build that is not a commit reads UNKNOWN_BUILD, and a
 * deploy time that is not an ISO 8601 UTC instant is left out.
 */
export function buildInfo(
  stamp: { build?: string; deployedAt?: string } = BUILD_STAMP
): BuildInfo {
  const build =
    stamp.build && BUILD_RE.test(stamp.build) ? stamp.build : UNKNOWN_BUILD;
  return {
    build,
    ...(stamp.deployedAt &&
      ISO_RE.test(stamp.deployedAt) && { deployedAt: stamp.deployedAt })
  };
}

/** The commit a build names, or undefined when it names none. */
export function buildCommit(info: BuildInfo): string | undefined {
  return BUILD_RE.test(info.build) ? info.build.split('-')[0] : undefined;
}

/**
 * "build 9004a11, deployed 2026-09-14 06:40 UTC"; for a report stored
 * before builds were recorded, "build not recorded".
 */
export function buildText(info: BuildInfo | undefined): string {
  if (!info) return 'build not recorded';
  const at = info.deployedAt
    ? `, deployed ${info.deployedAt.slice(0, 10)} ${info.deployedAt.slice(11, 16)} UTC`
    : '';
  return `build ${info.build}${at}`;
}
