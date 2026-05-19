import { Command } from 'commander';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import {
  TRACEABILITY_SCHEMA_VERSION,
  TraceabilityManifest,
  ExcludedRequirement,
  RequirementTraceability,
  SepTraceability,
  UnkeyedRequirement
} from './types';

const SEPS_DIR = 'src/seps';
const OUT_FILE = path.join(SEPS_DIR, 'traceability.json');

const DOCS =
  'https://github.com/modelcontextprotocol/conformance/blob/main/AGENTS.md#traceability-manifest';

// A yaml requirement row (mirrors new-sep's RequirementRow).
interface RawRequirement {
  text?: string;
  check?: string;
  excluded?: string;
  issue?: string;
  url?: string;
}
interface RawSepYaml {
  sep?: number;
  spec_url?: string;
  requirements?: RawRequirement[];
}

export interface DeclaredSep {
  sep: number;
  yaml: string;
  specUrl: string | null;
  requirements: RawRequirement[];
}

const CHECK_ID_RE = /^sep-\d+-/;

function sepOf(id: string): number | null {
  const m = id.match(/^sep-(\d+)-/);
  return m ? Number(m[1]) : null;
}

/**
 * Pure: join declared requirements against the emitted check-ID set into the
 * manifest. A requirement is "tested" iff its check ID was emitted by the run.
 * No filesystem access — fully testable.
 */
export function computeTraceability(args: {
  declared: DeclaredSep[];
  emitted: Set<string>;
  source?: string | null;
}): TraceabilityManifest {
  const { declared, emitted } = args;

  const emittedBySep = new Map<number, Set<string>>();
  for (const id of emitted) {
    const sep = sepOf(id);
    if (sep === null) continue;
    let set = emittedBySep.get(sep);
    if (!set) emittedBySep.set(sep, (set = new Set()));
    set.add(id);
  }

  const declaredBySep = new Map<number, DeclaredSep>();
  for (const d of declared) declaredBySep.set(d.sep, d);

  const allSeps = [
    ...new Set<number>([...declaredBySep.keys(), ...emittedBySep.keys()])
  ].sort((a, b) => a - b);

  const seps: Record<string, SepTraceability> = {};

  for (const sep of allSeps) {
    const d = declaredBySep.get(sep);
    const emittedIds = emittedBySep.get(sep) ?? new Set<string>();

    const requirements: RequirementTraceability[] = [];
    const excluded: ExcludedRequirement[] = [];
    const unkeyed: UnkeyedRequirement[] = [];
    const declaredCheckIds = new Set<string>();

    for (const r of d?.requirements ?? []) {
      const check = r.check;
      if (check) {
        declaredCheckIds.add(check);
        requirements.push({
          check,
          status: emittedIds.has(check) ? 'tested' : 'untested',
          ...(r.text ? { text: r.text } : {}),
          ...(r.url ? { url: r.url } : {}),
          ...(r.issue ? { issue: r.issue } : {})
        });
      } else if (r.excluded) {
        excluded.push({
          text: r.text ?? '',
          reason: r.excluded,
          ...(r.issue ? { issue: r.issue } : {})
        });
      } else {
        unkeyed.push({ text: r.text ?? '' });
      }
    }

    // Untracked: emitted IDs not declared in any yaml row.
    const untracked = [...emittedIds]
      .filter((id) => !declaredCheckIds.has(id))
      .sort();

    seps[String(sep)] = {
      yaml: d?.yaml ?? null,
      specUrl: d?.specUrl ?? null,
      requirements,
      excluded,
      unkeyed,
      untracked,
      summary: {
        tested: requirements.filter((r) => r.status === 'tested').length,
        untested: requirements.filter((r) => r.status === 'untested').length,
        excluded: excluded.length,
        untracked: untracked.length,
        unkeyed: unkeyed.length
      }
    };
  }

  return {
    schemaVersion: TRACEABILITY_SCHEMA_VERSION,
    docs: DOCS,
    source: args.source ?? null,
    seps
  };
}

/** Serialize deterministically (sorted SEP keys, trailing newline). */
export function serializeManifest(manifest: TraceabilityManifest): string {
  return JSON.stringify(manifest, null, 2) + '\n';
}

// --- filesystem gathering (not unit-tested; thin IO wrappers) -------------

/** Recursively collect emitted sep-NNNN-* check IDs from checks.json files. */
export function collectEmittedIds(resultsDir: string): Set<string> {
  const ids = new Set<string>();
  let entries: string[];
  try {
    entries = readdirSync(resultsDir, { recursive: true, encoding: 'utf-8' });
  } catch {
    return ids;
  }
  for (const rel of entries) {
    if (path.basename(rel) !== 'checks.json') continue;
    try {
      const arr = JSON.parse(readFileSync(path.join(resultsDir, rel), 'utf8'));
      if (!Array.isArray(arr)) continue;
      for (const c of arr) {
        if (c && typeof c.id === 'string' && CHECK_ID_RE.test(c.id))
          ids.add(c.id);
      }
    } catch {
      // skip unreadable/partial result files
    }
  }
  return ids;
}

export function gatherDeclared(sepsDir = SEPS_DIR): DeclaredSep[] {
  const out: DeclaredSep[] = [];
  const files = readdirSync(sepsDir)
    .filter((f) => /^sep-\d+\.yaml$/.test(f))
    .sort();
  for (const f of files) {
    const full = path.join(sepsDir, f);
    const doc = (parseYaml(readFileSync(full, 'utf8')) ?? {}) as RawSepYaml;
    const fileSep = Number(f.match(/^sep-(\d+)\.yaml$/)![1]);
    if (!Number.isInteger(doc.sep)) {
      console.warn(`WARN ${f}: missing/invalid \`sep:\`; skipping`);
      continue;
    }
    if (doc.sep !== fileSep) {
      console.warn(
        `WARN ${f}: filename SEP ${fileSep} != doc.sep ${doc.sep}; using doc.sep`
      );
    }
    out.push({
      sep: doc.sep as number,
      yaml: full,
      specUrl: doc.spec_url ?? null,
      requirements: doc.requirements ?? []
    });
  }
  return out;
}

/** Print per-SEP gaps to stderr. */
function reportGaps(manifest: TraceabilityManifest): void {
  for (const [sep, c] of Object.entries(manifest.seps)) {
    const untested = c.requirements.filter((r) => r.status === 'untested');
    if (!untested.length && !c.summary.unkeyed && !c.summary.untracked)
      continue;

    const bits: string[] = [];
    if (untested.length) bits.push(`${untested.length} untested`);
    if (c.summary.unkeyed) bits.push(`${c.summary.unkeyed} unkeyed`);
    if (c.summary.untracked) bits.push(`${c.summary.untracked} untracked`);
    console.error(
      `sep-${sep}: ${bits.join(', ')}${c.yaml ? '' : ' (no yaml)'}`
    );
    for (const r of untested) console.error(`  untested: ${r.check}`);
    for (const id of c.untracked) console.error(`  untracked: ${id}`);
  }
}

const HELP_EPILOG = `
"tested" means a scenario emitted the check ID when the conformance suite ran
against the reference SDK — NOT that any SDK passes it. "untested" means the
declared check ID was never emitted (a real gap, or a check that only fires
against a broken impl / a feature the reference SDK has not implemented).

--results <dir> is required: point it at the output of a suite run against the
reference SDK. Produce one with the sdk runner (clones+builds+runs the SDK),
once per side into the same dir:
  conformance sdk typescript-sdk@<ref> --mode client --suite all -o <dir>
  conformance sdk typescript-sdk@<ref> --mode server --suite all --skip-build -o <dir>
Check IDs are collected from <dir>/**/checks.json.

--source records what the run was against (e.g. "typescript-sdk@<sha>").
--allow-empty writes even when no check IDs were collected (default: refuse).
--check exits 1 if the on-disk traceability.json differs from a fresh compute.
--strict exits 1 on any untested requirement (advisory for now).`;

export function createTraceabilityCommand(): Command {
  return new Command('traceability')
    .description(
      'Generate src/seps/traceability.json: a manifest mapping declared SEP ' +
        'requirements to conformance scenarios that emit their check IDs'
    )
    .addHelpText('after', HELP_EPILOG)
    .requiredOption(
      '--results <dir>',
      'Results dir from a suite run against the reference SDK ' +
        '(reads <dir>/**/checks.json)'
    )
    .option(
      '--source <ref>',
      'What the run was against, recorded in the manifest (e.g. typescript-sdk@<sha>)'
    )
    .option(
      '--allow-empty',
      'Write even when zero check IDs were collected (default: refuse)'
    )
    .option(
      '--check',
      'Do not write; exit 1 if the on-disk traceability.json is stale'
    )
    .option('--strict', 'Exit 1 if any declared requirement is untested')
    .action((options) => {
      if (!existsSync(options.results)) {
        console.error(`results dir not found: ${options.results}`);
        process.exit(1);
      }
      const declared = gatherDeclared();
      const emitted = collectEmittedIds(options.results);

      // Guard the footgun: an empty/wrong results dir would mark everything
      // untested and silently clobber the manifest.
      if (emitted.size === 0 && !options.allowEmpty) {
        console.error(
          `no sep-NNNN-* check IDs found under ${options.results} — did the ` +
            `suite run write checks.json there? Pass --allow-empty to override.`
        );
        process.exit(1);
      }

      const manifest = computeTraceability({
        declared,
        emitted,
        source: options.source ?? null
      });
      const serialized = serializeManifest(manifest);
      const untestedTotal = Object.values(manifest.seps).reduce(
        (n, c) => n + c.summary.untested,
        0
      );

      if (options.check) {
        let current = '';
        try {
          current = readFileSync(OUT_FILE, 'utf8');
        } catch {
          // missing file -> stale
        }
        if (current !== serialized) {
          console.error(
            `${OUT_FILE} is out of date. Regenerate with ` +
              `\`npm run traceability -- --results ${options.results}\`, ` +
              `review with \`git diff ${OUT_FILE}\`, and commit.`
          );
          process.exit(1);
        }
        console.log(`${OUT_FILE} is up to date.`);
      } else {
        writeFileSync(OUT_FILE, serialized);
        console.log(
          `wrote ${OUT_FILE}: ${Object.keys(manifest.seps).length} SEP(s)`
        );
        reportGaps(manifest);
      }

      if (options.strict && untestedTotal > 0) process.exit(1);
    });
}
