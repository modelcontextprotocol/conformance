/**
 * The build a checkout would serve, read from git: the short commit, with
 * `-dirty` when tracked files have uncommitted changes. For the local
 * `hosted` command and the Val Town deploy script only; the deployed server
 * never imports this (it has no git, and reads ./build-stamp.ts).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PACKAGE_NAME = '@modelcontextprotocol/conformance';

/**
 * The environment without git's own GIT_* variables. A git hook runs with
 * GIT_DIR (and others) set, and with GIT_DIR set git treats any directory
 * as the top of that repository; without them, discovery depends only on
 * the directory git runs in.
 */
function gitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.toUpperCase().startsWith('GIT_')
    )
  );
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    env: gitEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2000
  }).trim();
}

/**
 * `dir`'s commit, or undefined when `dir` is not the top of a git checkout
 * (an installed package sitting inside some other repository must not
 * report that repository's commit) or git is not there.
 */
export function gitBuild(dir: string): string | undefined {
  try {
    const top = git(dir, ['rev-parse', '--show-toplevel']);
    if (realpathSync(top) !== realpathSync(dir)) return undefined;
    const sha = git(dir, ['rev-parse', '--short', 'HEAD']);
    const dirty =
      git(dir, ['status', '--porcelain', '--untracked-files=no']) !== '';
    return `${sha}${dirty ? '-dirty' : ''}`;
  } catch {
    return undefined;
  }
}

/** The directory of this package's package.json, above `from`. */
export function packageRoot(from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf8')).name === PACKAGE_NAME)
          return dir;
      } catch {
        // Not this package's; keep looking.
      }
    }
    if (dirname(dir) === dir) return undefined;
  }
}
