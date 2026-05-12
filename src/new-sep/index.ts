import { Command } from 'commander';
import { Octokit } from '@octokit/rest';
import { promises as fs } from 'fs';
import path from 'path';

export type Target = 'client' | 'server' | 'authorization-server';

export interface RequirementRow {
  text: string;
  check?: string;
  excluded?: string;
  issue?: string;
}

const TARGET_DIRS: Record<Target, string> = {
  client: 'src/scenarios/client',
  server: 'src/scenarios/server',
  'authorization-server': 'src/scenarios/authorization-server'
};

const SPEC_PATH_PREFIX = 'docs/specification/draft/';
const DEFAULT_SPEC_REPO = 'modelcontextprotocol/modelcontextprotocol';

export function specPathToUrl(specPath: string): string {
  if (!specPath.startsWith(SPEC_PATH_PREFIX)) {
    throw new Error(
      `spec path must start with "${SPEC_PATH_PREFIX}"; got: ${specPath}`
    );
  }
  const rest = specPath.slice(SPEC_PATH_PREFIX.length).replace(/\.mdx$/, '');
  return `https://modelcontextprotocol.io/specification/draft/${rest}`;
}

export function inferTarget(specPath: string): {
  target: Target;
  inferred: boolean;
} {
  const rest = specPath.startsWith(SPEC_PATH_PREFIX)
    ? specPath.slice(SPEC_PATH_PREFIX.length)
    : specPath;
  if (rest.startsWith('server/')) return { target: 'server', inferred: false };
  if (rest.startsWith('client/')) return { target: 'client', inferred: false };
  if (/^basic\/authorization/.test(rest) || /^auth/.test(rest)) {
    return { target: 'authorization-server', inferred: false };
  }
  return { target: 'server', inferred: true };
}

function escapeSingleQuoted(s: string): string {
  return s.replace(/'/g, "''");
}

function defaultPlaceholderRequirements(sep: number): RequirementRow[] {
  return [
    {
      text: 'TODO: quote the normative sentence from the spec diff',
      check: `sep-${sep}-todo`
    },
    {
      text: 'TODO: requirement that cannot be tested',
      excluded: 'TODO: reason',
      issue: 'https://github.com/modelcontextprotocol/conformance/issues/<NNNN>'
    }
  ];
}

export function renderYaml(input: {
  sep: number;
  specUrl: string;
  requirements?: RequirementRow[];
}): string {
  const reqs = input.requirements ?? defaultPlaceholderRequirements(input.sep);
  const lines: string[] = [];
  lines.push(`sep: ${input.sep}`);
  lines.push(`spec_url: ${input.specUrl}`);
  lines.push('requirements:');
  for (const r of reqs) {
    lines.push(`  - text: '${escapeSingleQuoted(r.text)}'`);
    if (r.check) lines.push(`    check: ${r.check}`);
    if (r.excluded) {
      lines.push(`    excluded: '${escapeSingleQuoted(r.excluded)}'`);
    }
    if (r.issue) lines.push(`    issue: ${r.issue}`);
  }
  return lines.join('\n') + '\n';
}

async function resolveToken(explicit?: string): Promise<string | undefined> {
  let token = explicit || process.env.GITHUB_TOKEN;
  if (!token) {
    try {
      const { execSync } = await import('child_process');
      token = execSync('gh auth token', { encoding: 'utf-8' }).trim();
    } catch {
      // gh not installed or not authenticated
    }
  }
  return token;
}

interface SpecCandidate {
  filename: string;
  additions: number;
}

async function lookupSpecPath(args: {
  sep: number;
  pr?: number;
  repo: string;
  token: string;
}): Promise<string> {
  const [owner, repoName] = args.repo.split('/');
  if (!owner || !repoName) {
    throw new Error(`Invalid --repo: ${args.repo} (expected owner/repo)`);
  }
  const octokit = new Octokit({ auth: args.token });

  let prNumber = args.pr;
  if (!prNumber) {
    const q = `repo:${args.repo} type:pr SEP-${args.sep} in:title`;
    const res = await octokit.search.issuesAndPullRequests({ q });
    if (res.data.total_count === 0) {
      throw new Error(
        `No PRs in ${args.repo} matching "SEP-${args.sep}" in title. ` +
          `Pass --pr <num> to disambiguate.`
      );
    }
    if (res.data.total_count > 1) {
      const candidates = res.data.items
        .slice(0, 5)
        .map((i) => `  #${i.number}  ${i.title}`)
        .join('\n');
      throw new Error(
        `Multiple PRs in ${args.repo} match "SEP-${args.sep}":\n${candidates}\n` +
          `Pass --pr <num> to pick one.`
      );
    }
    prNumber = res.data.items[0].number;
  }

  const files = await octokit.paginate(octokit.pulls.listFiles, {
    owner,
    repo: repoName,
    pull_number: prNumber,
    per_page: 100
  });

  const candidates: SpecCandidate[] = files
    .filter(
      (f) =>
        f.filename.startsWith(SPEC_PATH_PREFIX) && f.filename.endsWith('.mdx')
    )
    .map((f) => ({ filename: f.filename, additions: f.additions }));

  if (candidates.length === 0) {
    throw new Error(
      `PR #${prNumber} in ${args.repo} does not change any ` +
        `${SPEC_PATH_PREFIX}*.mdx file. Pass --spec-path <path> to override.`
    );
  }
  if (candidates.length === 1) {
    return candidates[0].filename;
  }
  candidates.sort((a, b) => b.additions - a.additions);
  if (candidates[0].additions > candidates[1].additions) {
    console.error(
      `Multiple spec files changed; picking ${candidates[0].filename} ` +
        `(most additions).`
    );
    return candidates[0].filename;
  }
  const list = candidates
    .map((c) => `  ${c.filename}  (+${c.additions})`)
    .join('\n');
  throw new Error(
    `Multiple spec files changed with equal weight in PR #${prNumber}:\n${list}\n` +
      `Pass --spec-path <path> to pick one.`
  );
}

export function createNewSepCommand(): Command {
  return new Command('new-sep')
    .description(
      'Scaffold a sep-NNNN.yaml requirement-traceability file for a new SEP'
    )
    .argument('<number>', 'SEP number, e.g. 2164')
    .option(
      '--target <target>',
      'Output directory: client | server | authorization-server'
    )
    .option(
      '--spec-url <url>',
      'Use this spec URL verbatim (skips GitHub lookup)'
    )
    .option(
      '--spec-path <path>',
      `${SPEC_PATH_PREFIX}... path to derive spec_url from (skips GitHub lookup)`
    )
    .option('--pr <num>', 'PR number in the spec repo (skips title search)')
    .option(
      '--repo <owner/repo>',
      'Spec repo to query for the SEP PR',
      DEFAULT_SPEC_REPO
    )
    .option(
      '--token <token>',
      'GitHub token (defaults to GITHUB_TOKEN env or `gh auth token`)'
    )
    .option('--force', 'Overwrite existing sep-NNNN.yaml')
    .action(async (sepArg: string, options) => {
      const sep = parseInt(sepArg, 10);
      if (!Number.isFinite(sep) || sep <= 0 || String(sep) !== sepArg.trim()) {
        console.error(`Invalid SEP number: ${sepArg}`);
        process.exit(1);
      }

      const explicitTarget = options.target as Target | undefined;
      if (
        explicitTarget &&
        !['client', 'server', 'authorization-server'].includes(explicitTarget)
      ) {
        console.error(
          `Invalid --target: ${explicitTarget} ` +
            `(expected client | server | authorization-server)`
        );
        process.exit(1);
      }

      let specUrl: string | undefined = options.specUrl;
      let specPath: string | undefined = options.specPath;

      if (!specUrl && !specPath) {
        const token = await resolveToken(options.token);
        if (!token) {
          console.error(
            'GitHub token required to look up the SEP PR. Either:\n' +
              '  gh auth login\n' +
              '  export GITHUB_TOKEN=$(gh auth token)\n' +
              '  or pass --token <token>\n' +
              '  or pass --spec-url / --spec-path to skip the lookup'
          );
          process.exit(1);
        }
        try {
          specPath = await lookupSpecPath({
            sep,
            pr: options.pr ? parseInt(options.pr, 10) : undefined,
            repo: options.repo,
            token
          });
          console.error(`Resolved spec path: ${specPath}`);
        } catch (err) {
          console.error((err as Error).message);
          process.exit(1);
        }
      }

      if (specPath && !specUrl) {
        try {
          specUrl = specPathToUrl(specPath);
        } catch (err) {
          console.error((err as Error).message);
          process.exit(1);
        }
      }
      if (!specUrl) {
        console.error('Could not resolve spec_url. Internal error.');
        process.exit(1);
      }

      let target: Target;
      if (explicitTarget) {
        target = explicitTarget;
      } else if (specPath) {
        const inferred = inferTarget(specPath);
        target = inferred.target;
        if (inferred.inferred) {
          console.error(`inferred target=${target}; use --target to override`);
        }
      } else {
        target = 'server';
        console.error(
          'No --target and no --spec-path given; defaulting to target=server. ' +
            'Use --target to override.'
        );
      }

      const outDir = TARGET_DIRS[target];
      const outPath = path.join(outDir, `sep-${sep}.yaml`);

      await fs.mkdir(outDir, { recursive: true });

      if (!options.force) {
        try {
          await fs.access(outPath);
          console.error(
            `${outPath} already exists. Pass --force to overwrite.`
          );
          process.exit(1);
        } catch {
          // does not exist, OK
        }
      }

      const yaml = renderYaml({ sep, specUrl });
      await fs.writeFile(outPath, yaml, 'utf-8');

      console.error(`Wrote ${outPath}`);
      console.error('Next steps:');
      console.error(
        '  1. Edit the file to quote real normative sentences from the spec diff'
      );
      console.error(
        '     (and add a "#anchor" to spec_url if the requirement lives in a subsection)'
      );
      console.error('  2. Implement the TypeScript scenario');
      console.error(
        '  3. Register it in the appropriate suite list in src/scenarios/index.ts'
      );
    });
}
