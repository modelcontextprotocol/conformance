import { Command } from 'commander';
import { Octokit } from '@octokit/rest';
import { promises as fs } from 'fs';
import path from 'path';

export interface RequirementRow {
  text: string;
  check?: string;
  excluded?: string;
  issue?: string;
  /** Full spec URL for this requirement; overrides the file-level spec_url. */
  url?: string;
}

const OUT_DIR = 'src/seps';
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
  const checkRows = reqs.filter((r) => r.check);
  const excludedRows = reqs.filter((r) => !r.check);

  const lines: string[] = [];
  lines.push(`sep: ${input.sep}`);
  lines.push(`spec_url: ${input.specUrl}`);
  lines.push('requirements:');

  for (const r of checkRows) {
    lines.push(`  - check: ${r.check}`);
    lines.push(`    text: '${escapeSingleQuoted(r.text)}'`);
    if (r.url) lines.push(`    url: ${r.url}`);
  }

  if (checkRows.length > 0 && excludedRows.length > 0) {
    lines.push('');
  }

  for (const r of excludedRows) {
    lines.push(`  - text: '${escapeSingleQuoted(r.text)}'`);
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
  repo: string;
  token: string;
}): Promise<string[]> {
  const [owner, repoName] = args.repo.split('/');
  if (!owner || !repoName) {
    throw new Error(`Invalid --repo: ${args.repo} (expected owner/repo)`);
  }
  const octokit = new Octokit({ auth: args.token });

  // SEP numbers are PR numbers in the spec repo by convention.
  const prNumber = args.sep;

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
  candidates.sort((a, b) => b.additions - a.additions);
  return candidates.map((c) => c.filename);
}

export function createNewSepCommand(): Command {
  return new Command('new-sep')
    .description(
      'Scaffold a sep-NNNN.yaml requirement-traceability file for a new SEP'
    )
    .argument('<number>', 'SEP number, e.g. 2164')
    .option(
      '--spec-url <url>',
      'Use this spec URL verbatim (skips GitHub lookup)'
    )
    .option(
      '--spec-path <path>',
      `${SPEC_PATH_PREFIX}... path to derive spec_url from (skips GitHub lookup)`
    )
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

      let specUrl: string | undefined = options.specUrl;
      let specPath: string | undefined = options.specPath;
      let otherSpecPaths: string[] = [];

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
          const specPaths = await lookupSpecPath({
            sep,
            repo: options.repo,
            token
          });
          specPath = specPaths[0];
          otherSpecPaths = specPaths.slice(1);
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

      const outPath = path.join(OUT_DIR, `sep-${sep}.yaml`);

      await fs.mkdir(OUT_DIR, { recursive: true });

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
      if (otherSpecPaths.length > 0) {
        console.error(
          `Note: PR also changes ${otherSpecPaths.length} other spec file(s):`
        );
        for (const p of otherSpecPaths) {
          console.error(`  ${specPathToUrl(p)}`);
        }
        console.error(
          `  Use a per-row "url:" for requirements from those files.`
        );
      }
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
