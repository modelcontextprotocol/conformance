#!/usr/bin/env node
// Run one conformance selection (scenario / suite / requirement set) across
// every SDK in KNOWN_SDKS and render an SDK x check matrix.
//
// This is deliberately thin orchestration over `conformance sdk`: cloning,
// building and running each SDK is that command's job. This script only fans
// out over SDKs (one SDK's failure never stops the others), captures each
// run's log and the checks.json files it writes, and aggregates them into
// matrix.json + matrix.md. `--merge` re-renders from previously written
// matrix.json files, which is how the CI report job combines per-SDK legs.
//
// Usage: node scripts/sdk-matrix.mjs --mode client --scenario auth/metadata-default
//        node scripts/sdk-matrix.mjs --help

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');
const DEFAULT_HARNESS_REPO =
  'https://github.com/modelcontextprotocol/conformance.git';

// ---------------------------------------------------------------------------
// CLI parsing

const HELP = `Usage: node scripts/sdk-matrix.mjs [options]

Runs \`conformance sdk <name>\` for each SDK and aggregates the results into
<output>/matrix.json and <output>/matrix.md (also printed to stdout).

Selection:
  --sdks <all|a,b,...>         SDKs to run: KNOWN_SDKS names, optionally
                               name@ref (default: all)
  --mode <client|server|both>  Side to test (default: client)
  --scenario <a,b,...>         Scenario(s) to run (one sdk invocation each)
  --suite <name>               Suite to run instead of scenarios
  --requirements <rev>         Requirement set to run instead (e.g. 2026-07-28)
  --spec-version <v>           Passed through to \`conformance sdk\`
  --timeout <ms>               Passed through to \`conformance sdk\`

Harness:
  --ref <git-ref|PR-number>    Conformance ref to test. A bare number is a PR
                               (fetched as pull/<n>/head). Default: this
                               checkout, rebuilt first.
  --harness-repo <url>         Where --ref is fetched from (default: upstream)
  --harness-dir <dir>          Use this already-built conformance checkout as
                               the harness (its dist/ and KNOWN_SDKS) instead
                               of this one; nothing is rebuilt
  --skip-harness-build         Don't rebuild this checkout before running
  --skip-build                 Reuse each SDK's previous build (passed through)
  --cache-dir <dir>            SDK clone/build cache (default: .sdk-under-test)
  --concurrency <n>            SDKs in flight at once (default: 2). Server-mode
                               runs are serialized regardless, because every
                               SDK's conformance server listens on port 3000.

Output:
  -o, --output <dir>           Result directory (default: sdk-matrix-results)
  --title <text>               Heading for matrix.md
  --merge <dir[,dir...]>       Run nothing; merge the matrix.json files found
                               under these directories and re-render
  --list-sdks [--json]         Print the KNOWN_SDKS names (of --ref, if given)
  --strict                     Exit 1 if the run would turn any SDK's own CI
                               red: a failure its baseline does not excuse, a
                               stale baseline entry, or an SDK that errored
  --strict-errors              Exit 1 only if an SDK could not be built or run
  -h, --help
`;

export function parseArgs(argv) {
  const opts = {
    sdks: 'all',
    mode: 'client',
    scenario: undefined,
    suite: undefined,
    requirements: undefined,
    specVersion: undefined,
    timeout: undefined,
    ref: undefined,
    harnessRepo: DEFAULT_HARNESS_REPO,
    harnessDir: undefined,
    skipHarnessBuild: false,
    skipBuild: false,
    cacheDir: undefined,
    concurrency: 2,
    output: 'sdk-matrix-results',
    title: undefined,
    merge: [],
    listSdks: false,
    json: false,
    strict: false,
    strictErrors: false,
    help: false
  };
  const takesValue = {
    '--sdks': 'sdks',
    '--mode': 'mode',
    '--scenario': 'scenario',
    '--suite': 'suite',
    '--requirements': 'requirements',
    '--spec-version': 'specVersion',
    '--timeout': 'timeout',
    '--ref': 'ref',
    '--pr': 'ref',
    '--harness-repo': 'harnessRepo',
    '--harness-dir': 'harnessDir',
    '--cache-dir': 'cacheDir',
    '--concurrency': 'concurrency',
    '-o': 'output',
    '--output': 'output',
    '--title': 'title',
    '--merge': 'merge'
  };
  const flags = {
    '--skip-harness-build': 'skipHarnessBuild',
    '--skip-build': 'skipBuild',
    '--list-sdks': 'listSdks',
    '--json': 'json',
    '--strict': 'strict',
    '--strict-errors': 'strictErrors',
    '-h': 'help',
    '--help': 'help'
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const key = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    if (key in takesValue) {
      const value = inline ?? argv[++i];
      if (value === undefined || value === '' || value.startsWith('--')) {
        // Empty values come from unset workflow inputs; treat as "not given".
        if (value === '') continue;
        throw new Error(`${key} requires a value`);
      }
      if (key === '--merge') opts.merge.push(...splitList(value));
      else if (key === '--concurrency') opts.concurrency = Number(value);
      else opts[takesValue[key]] = value;
    } else if (key in flags) {
      opts[flags[key]] = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!['client', 'server', 'both'].includes(opts.mode)) {
    throw new Error(`--mode must be client, server or both (got ${opts.mode})`);
  }
  const selections = [opts.scenario, opts.suite, opts.requirements].filter(
    (v) => v !== undefined
  );
  if (selections.length > 1) {
    throw new Error('Pass at most one of --scenario, --suite, --requirements');
  }
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
    throw new Error('--concurrency must be a positive integer');
  }
  return opts;
}

export function splitList(value) {
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// KNOWN_SDKS discovery
//
// The SDK list comes from the harness under test (which may be an older ref
// that predates this script), so it is read from that checkout's source rather
// than imported. KNOWN_SDKS is a prettier-formatted object literal whose
// top-level keys sit at two-space indent; the unit test cross-checks this
// parse against the real module so a format change can't silently drift.

export function parseKnownSdkNames(source) {
  const start = source.indexOf('export const KNOWN_SDKS');
  if (start < 0) throw new Error('KNOWN_SDKS not found in known-sdks.ts');
  const names = [];
  for (const m of source.slice(start).matchAll(/^ {2}'([^']+)':\s*\{/gm)) {
    names.push(m[1]);
  }
  if (names.length === 0) {
    throw new Error('No SDK entries parsed from KNOWN_SDKS');
  }
  return names;
}

export function listKnownSdks(harnessRoot) {
  const file = path.join(harnessRoot, 'src', 'sdk-runner', 'known-sdks.ts');
  return parseKnownSdkNames(fs.readFileSync(file, 'utf-8'));
}

/** `name[@ref]` -> { spec, name, ref }. Mirrors parseSdkSpec in checkout.ts. */
export function parseSdkSpec(spec) {
  const at = spec.lastIndexOf('@');
  if (at <= 0) return { spec, name: spec, ref: undefined };
  const ref = spec.slice(at + 1) || undefined;
  return { spec, name: spec.slice(0, at), ref };
}

/** The KNOWN_SDKS key a spec resolves to (basename of owner/repo). */
export function sdkKey(name) {
  return name.split('/').pop();
}

export function resolveSdkList(sdksArg, known) {
  if (!sdksArg || sdksArg === 'all') return known.map((k) => parseSdkSpec(k));
  return splitList(sdksArg).map((s) => parseSdkSpec(s));
}

/** Filesystem/artifact-safe form of an SDK spec. */
export function safeName(spec) {
  return spec.replace(/[^A-Za-z0-9._-]+/g, '_');
}

// ---------------------------------------------------------------------------
// Toolchain probes, reported per SDK so a red cell can be read against the
// toolchain that produced it.

const PROBES = {
  node: ['node', ['--version']],
  npm: ['npm', ['--version']],
  pnpm: ['pnpm', ['--version']],
  uv: ['uv', ['--version']],
  python: ['python3', ['--version']],
  go: ['go', ['version']],
  cargo: ['cargo', ['--version']],
  rustc: ['rustc', ['--version']],
  dotnet: ['dotnet', ['--version']],
  ruby: ['ruby', ['--version']],
  bundler: ['bundle', ['--version']],
  java: ['java', ['-version']]
};

const SDK_PROBES = [
  [/typescript-sdk/, ['node', 'pnpm', 'npm']],
  [/python-sdk/, ['uv', 'python']],
  [/go-sdk/, ['go']],
  [/rust-sdk/, ['cargo', 'rustc']],
  [/csharp-sdk/, ['dotnet']],
  [/ruby-sdk/, ['ruby', 'bundler']],
  [/java-sdk|kotlin-sdk/, ['java']]
];

export function probesFor(sdkName) {
  for (const [re, probes] of SDK_PROBES) {
    if (re.test(sdkName)) return probes;
  }
  return ['node'];
}

function probeToolchain(sdkName, cwd) {
  const out = {};
  for (const key of probesFor(sdkName)) {
    const [cmd, args] = PROBES[key];
    try {
      // Probe inside the SDK checkout when we have it, so per-repo pins
      // (rust-toolchain.toml, packageManager, .python-version) are reflected.
      const r = spawnSync(cmd, args, {
        cwd: cwd && fs.existsSync(cwd) ? cwd : undefined,
        encoding: 'utf-8',
        timeout: 120_000,
        env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' }
      });
      if (r.error || r.status !== 0) {
        out[key] = null;
        continue;
      }
      const text = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
      out[key] = text.split('\n')[0].trim() || null;
    } catch {
      out[key] = null;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Process helpers

function run(cmd, args, { cwd, logFile, prefix, env } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const log = logFile ? fs.createWriteStream(logFile, { flags: 'a' }) : null;
    if (log) log.write(`$ ${cmd} ${args.join(' ')}\n`);
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let captured = '';
    let partial = '';
    const onData = (chunk) => {
      const text = chunk.toString();
      captured += text;
      if (captured.length > 4_000_000) captured = captured.slice(-2_000_000);
      if (log) log.write(text);
      if (prefix !== undefined) {
        const pieces = (partial + text).split('\n');
        partial = pieces.pop() ?? '';
        for (const line of pieces) process.stderr.write(`${prefix}${line}\n`);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      captured += `\nspawn error: ${err.message}\n`;
      if (log) log.end(`\nspawn error: ${err.message}\n`);
      resolve({
        exitCode: -1,
        output: captured,
        durationMs: Date.now() - started
      });
    });
    child.on('close', (code) => {
      if (prefix !== undefined && partial) {
        process.stderr.write(`${prefix}${partial}\n`);
      }
      if (log) log.end(`\n[exit ${code}]\n`);
      resolve({
        exitCode: code ?? -1,
        output: captured,
        durationMs: Date.now() - started
      });
    });
  });
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

function tryGit(args, cwd) {
  try {
    return git(args, cwd) || undefined;
  } catch {
    return undefined;
  }
}

/** Promise pool: run `fn` over items with at most `n` in flight. */
export async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(n, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

/** A minimal async mutex. */
function createLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const runIt = tail.then(fn, fn);
    tail = runIt.catch(() => {});
    return runIt;
  };
}

// ---------------------------------------------------------------------------
// Harness preparation (--ref)

async function prepareHarness(opts, cacheDir, outDir) {
  if (opts.harnessDir) {
    // An existing, already-built checkout (CI builds the ref under test in a
    // separate directory and drives it with this branch's script).
    const root = path.resolve(opts.harnessDir);
    if (!opts.listSdks && !fs.existsSync(path.join(root, 'dist', 'index.js'))) {
      throw new Error(
        `No dist/index.js in --harness-dir ${root}; run npm ci && npm run build there`
      );
    }
    return { root, ...describeCheckout(root) };
  }
  if (!opts.ref) {
    const root = REPO_ROOT;
    if (!opts.skipHarnessBuild) {
      console.error('[matrix] Building harness (npm run build)');
      const logFile = path.join(outDir, 'harness-build.log');
      const r = await run('npm', ['run', 'build', '--silent'], {
        cwd: root,
        logFile
      });
      if (r.exitCode !== 0) {
        throw new Error(`Harness build failed (see ${logFile})`);
      }
    }
    if (!fs.existsSync(path.join(root, 'dist', 'index.js'))) {
      throw new Error(`No dist/index.js in ${root}; run npm run build`);
    }
    return { root, ...describeCheckout(root) };
  }

  // A separate clone (not a worktree of this checkout) so this also works
  // where the invoking checkout has no usable .git, e.g. a bind-mounted
  // worktree inside the container.
  const isPr = /^\d+$/.test(opts.ref);
  const refspec = isPr ? `pull/${opts.ref}/head` : opts.ref;
  const root = path.join(cacheDir, '_harness', 'conformance');
  fs.mkdirSync(path.dirname(root), { recursive: true });
  if (!fs.existsSync(path.join(root, '.git'))) {
    console.error(`[matrix] Cloning ${opts.harnessRepo} -> ${root}`);
    git(['clone', opts.harnessRepo, root], path.dirname(root));
  }
  console.error(`[matrix] Fetching ${refspec} from ${opts.harnessRepo}`);
  git(['fetch', opts.harnessRepo, refspec], root);
  const sha = git(['rev-parse', 'FETCH_HEAD'], root);
  git(['checkout', '--detach', '--force', sha], root);
  git(['clean', '-fdx', '-e', 'node_modules', '-e', 'dist'], root);

  const logFile = path.join(outDir, 'harness-build.log');
  const lock = fs.readFileSync(path.join(root, 'package-lock.json'), 'utf-8');
  const lockStamp = `${lock.length}:${simpleHash(lock)}`;
  const stampFile = path.join(root, 'node_modules', '.sdk-matrix-lock');
  const prev = fs.existsSync(stampFile)
    ? fs.readFileSync(stampFile, 'utf-8')
    : '';
  if (prev !== lockStamp) {
    console.error('[matrix] Installing harness dependencies (npm ci)');
    const r = await run('npm', ['ci'], { cwd: root, logFile });
    if (r.exitCode !== 0) {
      throw new Error(`npm ci failed for --ref ${opts.ref} (see ${logFile})`);
    }
    fs.writeFileSync(stampFile, lockStamp);
  }
  console.error('[matrix] Building harness at ref (npm run build)');
  const r = await run('npm', ['run', 'build', '--silent'], {
    cwd: root,
    logFile
  });
  if (r.exitCode !== 0) {
    throw new Error(
      `Harness build failed for --ref ${opts.ref} (see ${logFile})`
    );
  }
  return {
    root,
    ref: isPr ? `PR #${opts.ref}` : opts.ref,
    sha: sha.slice(0, 12),
    version: readVersion(root)
  };
}

function simpleHash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

function readVersion(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'))
      .version;
  } catch {
    return undefined;
  }
}

function describeCheckout(root) {
  // Env overrides let a wrapper (the docker script) label a checkout whose
  // .git is not resolvable from where this runs.
  return {
    ref:
      process.env.SDK_MATRIX_HARNESS_REF ||
      tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], root) ||
      'unknown',
    sha:
      process.env.SDK_MATRIX_HARNESS_SHA ||
      tryGit(['rev-parse', '--short=12', 'HEAD'], root) ||
      'unknown',
    version: readVersion(root)
  };
}

// ---------------------------------------------------------------------------
// Running one SDK

/**
 * Classify a `conformance sdk` invocation from its combined output. The sdk
 * command logs `[sdk] <step>` progress lines and, on a thrown error, a final
 * `[sdk] <message>`; `[sdk] conformance <client|server> ...` is printed right
 * before scenarios start, so its absence means the run never got that far.
 */
export function classifyInvocation(output, exitCode) {
  if (/^\[sdk\] conformance (client|server)\b/m.test(output)) {
    return { phase: 'ran', exitCode };
  }
  const progress =
    /^(Fetching|Cloning|Checking out|HEAD is|Building:|No build command|Starting server|Server ready|Stopping server|conformance )/;
  let reason;
  for (const m of output.matchAll(/^\[sdk\] (.+)$/gm)) {
    if (!progress.test(m[1])) reason = m[1];
  }
  let phase = 'setup';
  if (/^\[sdk\] Starting server/m.test(output)) phase = 'server-start';
  else if (/^\[sdk\] Building:/m.test(output)) phase = 'build';
  else if (/^\[sdk\] (Cloning|Fetching|Checking out)/m.test(output)) {
    phase = 'checkout';
  }
  return {
    phase,
    exitCode,
    reason: reason ?? `exited with code ${exitCode} before running scenarios`,
    detail: firstErrorLine(output)
  };
}

/** First line that looks like a toolchain error, for the one-line summary. */
export function firstErrorLine(output) {
  const patterns = [
    /failed to select a version for the requirement.*$/m,
    /^error(\[E\d+\])?: .+$/m,
    /^npm (ERR!|error) .+$/m,
    /ERR_PNPM_[A-Z_]+.*$/m,
    /^.*error (CS|MSB|NU|NETSDK)\d+: .+$/m,
    /^.*(command not found|not found in PATH|No such file or directory).*$/m,
    /^.*Could not (find|locate) .+$/m,
    /^\s*(E|e)rror:? .+$/m
  ];
  for (const re of patterns) {
    const m = output.match(re);
    if (m) return m[0].trim().slice(0, 240);
  }
  return undefined;
}

export function tailLines(text, n) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.slice(-n).join('\n');
}

/**
 * Collect checks.json files written under one mode's output dir into
 * { scenarioName: { checks, resultDir } }. Result dirs are named
 * `<scenario>-<ISO timestamp>` (server mode: `server-<scenario>-<ts>`), and a
 * scenario name containing '/' nests directories. When a scenario ran more
 * than once the latest timestamp wins.
 */
export function collectModeResults(modeDir, mode) {
  const found = {};
  if (!fs.existsSync(modeDir)) return {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name !== 'checks.json') continue;
      let rel = path
        .relative(modeDir, path.dirname(full))
        .split(path.sep)
        .join('/');
      const ts = rel.match(/-(\d{4}-\d{2}-\d{2}T[\d-]+Z)$/);
      const stamp = ts ? ts[1] : '';
      if (ts) rel = rel.slice(0, -ts[0].length);
      if (mode === 'server' && rel.startsWith('server-')) {
        rel = rel.slice('server-'.length);
      }
      let checks;
      try {
        checks = JSON.parse(fs.readFileSync(full, 'utf-8'));
        if (!Array.isArray(checks)) throw new Error('not an array');
      } catch (err) {
        checks = [
          {
            id: rel,
            name: rel,
            status: 'FAILURE',
            description: 'checks.json could not be parsed',
            errorMessage: String(err)
          }
        ];
      }
      if (!found[rel] || found[rel].stamp < stamp) {
        found[rel] = { stamp, resultDir: path.dirname(full), checks };
      }
    }
  };
  walk(modeDir);
  const out = {};
  for (const [name, v] of Object.entries(found)) {
    out[name] = { resultDir: v.resultDir, checks: v.checks.map(slimCheck) };
  }
  return out;
}

function slimCheck(c) {
  const slim = {
    id: String(c.id ?? ''),
    status: String(c.status ?? 'UNKNOWN')
  };
  if (c.name && c.name !== c.id) slim.name = String(c.name);
  if (c.description) slim.description = String(c.description);
  if (c.errorMessage) slim.errorMessage = String(c.errorMessage);
  return slim;
}

function checkoutDirFromLog(output) {
  const m =
    output.match(/^\[sdk\] Cloning \S+ -> (.+)$/m) ||
    output.match(/^\[sdk\] Fetching \S+ \(cached at (.+)\)$/m);
  return m ? m[1].trim() : undefined;
}

function headFromLog(output) {
  const m = output.match(/^\[sdk\] HEAD is (\S+)/m);
  return m ? m[1] : undefined;
}

function expectedFailuresFromLog(output) {
  const m = output.match(
    /^\[sdk\] conformance (?:client|server) .*--expected-failures (\S+)/m
  );
  return m ? m[1] : undefined;
}

/**
 * Parse an expected-failures YAML file into { client: [...], server: [...] }
 * entry strings ('<scenario>' or '<scenario>:<check-id>'). Uses the `yaml`
 * package from the harness checkout when it is installed there, else a small
 * parser that covers the block-list shape these files use.
 */
export function parseBaselineYaml(text, yamlParse) {
  const norm = (list) =>
    Array.isArray(list)
      ? list
          .filter((e) => typeof e === 'string' && e.trim())
          .map((e) => e.trim())
      : [];
  if (yamlParse) {
    try {
      const doc = yamlParse(text) ?? {};
      if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
        return { client: norm(doc.client), server: norm(doc.server) };
      }
    } catch {
      // fall through to the minimal parser
    }
  }
  const out = { client: [], server: [] };
  let section = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '');
    if (!line.trim()) continue;
    const key = line.match(/^([A-Za-z_]+):\s*(\[(.*)\])?\s*$/);
    if (key) {
      section = key[1] in out ? key[1] : null;
      if (section && key[2]) {
        out[section].push(
          ...key[3]
            .split(',')
            .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
            .filter(Boolean)
        );
      }
      continue;
    }
    const item = line.match(/^\s*-\s+(.+?)\s*$/);
    if (item && section) {
      out[section].push(item[1].replace(/^['"]|['"]$/g, ''));
    }
  }
  return out;
}

function loadYamlParse(harnessRoot) {
  for (const base of [harnessRoot, REPO_ROOT]) {
    try {
      const req = createRequire(path.join(base, 'package.json'));
      return req('yaml').parse;
    } catch {
      // not installed there
    }
  }
  return undefined;
}

function readBaseline(file, mode, harnessRoot) {
  try {
    const text = fs.readFileSync(file, 'utf-8');
    const parsed = parseBaselineYaml(text, loadYamlParse(harnessRoot));
    return { file, entries: parsed[mode] ?? [] };
  } catch (err) {
    return { file, entries: [], error: String(err.message ?? err) };
  }
}

async function runSdk(sdk, ctx) {
  const { opts, harness, cacheDir, outDir, serverLock } = ctx;
  const sdkDir = path.join(outDir, 'sdks', safeName(sdk.spec));
  fs.mkdirSync(sdkDir, { recursive: true });
  const record = {
    spec: sdk.spec,
    name: sdk.name,
    requestedRef: sdk.ref ?? null,
    head: null,
    checkoutDir: null,
    toolchain: {},
    modes: {}
  };
  const modes = opts.mode === 'both' ? ['client', 'server'] : [opts.mode];
  let built = opts.skipBuild;
  let buildError = null;

  for (const mode of modes) {
    const modeOut = path.join(sdkDir, mode);
    const modeRec = {
      invocations: [],
      error: null,
      baseline: null,
      scenarios: {}
    };
    record.modes[mode] = modeRec;
    let baselineFile;
    if (buildError) {
      // The build already failed under the previous mode; don't repeat it.
      modeRec.error = { ...buildError, inherited: true };
      continue;
    }
    // `conformance sdk --scenario` takes one scenario, so a list means one
    // invocation each; everything after the first reuses the build.
    const selections = opts.scenario ? splitList(opts.scenario) : [null];
    for (const scenario of selections) {
      const args = [
        path.join(harness.root, 'dist', 'index.js'),
        'sdk',
        sdk.spec,
        '--mode',
        mode,
        '--cache-dir',
        cacheDir,
        '-o',
        modeOut
      ];
      if (scenario) args.push('--scenario', scenario);
      else if (opts.suite) args.push('--suite', opts.suite);
      else if (opts.requirements)
        args.push('--requirements', opts.requirements);
      if (opts.specVersion) args.push('--spec-version', opts.specVersion);
      if (opts.timeout) args.push('--timeout', opts.timeout);
      if (built) args.push('--skip-build');
      const label = scenario ?? opts.suite ?? opts.requirements ?? 'default';
      const logFile = path.join(sdkDir, `${mode}-${safeName(label)}.log`);
      console.error(`[matrix] ${sdk.spec} ${mode} ${label}: starting`);
      const exec = () =>
        run(process.execPath, args, {
          cwd: harness.root,
          logFile,
          prefix: `[${sdk.spec}] `,
          env: { COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' }
        });
      // Every SDK's conformance server binds port 3000, so server-mode runs
      // never overlap across SDKs; client-mode mock servers use ephemeral
      // ports and run concurrently.
      const r = mode === 'server' ? await serverLock(exec) : await exec();
      record.checkoutDir ??= checkoutDirFromLog(r.output) ?? null;
      record.head ??= headFromLog(r.output) ?? null;
      baselineFile ??= expectedFailuresFromLog(r.output);
      const cls = classifyInvocation(r.output, r.exitCode);
      const inv = {
        scenario: scenario ?? null,
        args: args.slice(1),
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        phase: cls.phase,
        logFile: path.relative(outDir, logFile)
      };
      if (cls.phase !== 'ran') {
        inv.reason = cls.reason;
        if (cls.detail) inv.detail = cls.detail;
        inv.tail = tailLines(r.output, 40);
        modeRec.error ??= {
          phase: cls.phase,
          reason: cls.reason,
          detail: cls.detail ?? null,
          logFile: inv.logFile,
          tail: inv.tail
        };
        if (cls.phase !== 'server-start') buildError = modeRec.error;
      } else {
        built = true;
      }
      modeRec.invocations.push(inv);
      console.error(
        `[matrix] ${sdk.spec} ${mode} ${label}: ${cls.phase} (exit ${r.exitCode}, ${Math.round(r.durationMs / 1000)}s)`
      );
      if (buildError) break;
    }
    modeRec.scenarios = collectModeResults(modeOut, mode);
    // The SDK's own expected-failures baseline (the file `conformance sdk`
    // passed as --expected-failures) is what separates "this change breaks
    // that SDK's CI" from "that SDK already knows it fails this".
    if (baselineFile) {
      modeRec.baseline = readBaseline(baselineFile, mode, harness.root);
      if (record.checkoutDir && modeRec.baseline) {
        modeRec.baseline.file = path.relative(record.checkoutDir, baselineFile);
      }
    }
    // A requested scenario that left no checks.json is an execution error
    // for that scenario, distinct from a check that was simply not emitted.
    if (opts.scenario) {
      for (const s of splitList(opts.scenario)) {
        if (modeRec.scenarios[s]) continue;
        const inv = modeRec.invocations.find((i) => i.scenario === s);
        modeRec.scenarios[s] = {
          resultDir: null,
          checks: [],
          missing: true,
          reason:
            inv?.detail ??
            inv?.reason ??
            modeRec.error?.reason ??
            (inv ? `no checks.json written (exit ${inv.exitCode})` : 'not run')
        };
      }
    }
  }
  record.toolchain = probeToolchain(sdk.name, record.checkoutDir ?? undefined);
  fs.writeFileSync(
    path.join(sdkDir, 'result.json'),
    JSON.stringify(record, null, 2)
  );
  return record;
}

// ---------------------------------------------------------------------------
// Aggregation + rendering

const STATUS_RANK = {
  FAILURE: 5,
  WARNING: 4,
  SUCCESS: 3,
  INFO: 2,
  SKIPPED: 1
};
const ICON = {
  SUCCESS: '✅',
  FAILURE: '❌',
  WARNING: '⚠️',
  SKIPPED: '⏭️',
  INFO: 'ℹ️',
  // Fails, but the SDK's own expected-failures baseline already lists it.
  BASELINED: '⭕',
  STALE: '\u{1F9F9}'
};
const DASH = '—';

export function worstStatus(statuses) {
  let worst;
  for (const s of statuses) {
    if (
      worst === undefined ||
      (STATUS_RANK[s] ?? 0) > (STATUS_RANK[worst] ?? 0)
    ) {
      worst = s;
    }
  }
  return worst;
}

export function summarizeChecks(checks) {
  const n = (s) => checks.filter((c) => c.status === s).length;
  // Denominator matches the harness's own summary: SUCCESS + FAILURE.
  // WARNING/INFO/SKIPPED are reported alongside, not scored.
  return {
    passed: n('SUCCESS'),
    failed: n('FAILURE'),
    warnings: n('WARNING'),
    total: n('SUCCESS') + n('FAILURE'),
    emitted: checks.length
  };
}

const isFailing = (status) => status === 'FAILURE' || status === 'WARNING';

/** Baseline lookup for one mode record ({ has, scenarios, checks }). */
function baselineIndex(modeRec) {
  const entries = modeRec?.baseline?.entries ?? [];
  const scenarios = new Set();
  const checks = new Set();
  for (const e of entries) {
    if (e.includes(':')) checks.add(e);
    else scenarios.add(e);
  }
  return { has: Boolean(modeRec?.baseline), scenarios, checks };
}

function isBaselined(idx, scenario, checkId) {
  return (
    idx.scenarios.has(scenario) || idx.checks.has(`${scenario}:${checkId}`)
  );
}

/**
 * Judge one scenario result against the SDK's own expected-failures baseline,
 * mirroring evaluateBaseline in src/expected-failures.ts (FAILURE and WARNING
 * both count as failing). `unexpected` are failing checks the baseline does not
 * excuse: those turn that SDK's CI red, i.e. regressions from its point of
 * view. `baselined` are failing checks it already expects. `stale` are baseline
 * entries for this scenario that no longer fail, which also turns its CI red
 * until the entry is removed.
 */
export function judgeScenario(modeRec, scenario) {
  const out = { unexpected: [], baselined: [], stale: [] };
  const r = modeRec?.scenarios?.[scenario];
  if (!r || r.missing) return out;
  const idx = baselineIndex(modeRec);
  const failing = r.checks.filter((c) => isFailing(c.status));
  for (const c of failing) {
    (isBaselined(idx, scenario, c.id) ? out.baselined : out.unexpected).push(c);
  }
  if (idx.scenarios.has(scenario) && failing.length === 0) {
    out.stale.push(scenario);
  }
  for (const e of idx.checks) {
    const i = e.indexOf(':');
    if (e.slice(0, i) !== scenario) continue;
    const id = e.slice(i + 1);
    const present = r.checks.filter((c) => c.id === id);
    if (present.length && !present.some((c) => isFailing(c.status))) {
      out.stale.push(e);
    }
  }
  return out;
}

/**
 * Everything in the matrix that would turn some SDK's own CI red (or could
 * not be determined): unexpected failures, stale baseline entries, and SDKs
 * that could not be built or run.
 */
export function findRegressions(matrix) {
  const unexpected = [];
  const stale = [];
  const errors = [];
  const noBaseline = [];
  for (const s of Object.values(matrix.sdks)) {
    for (const [mode, m] of Object.entries(s.modes)) {
      if (m.error) {
        errors.push({ sdk: s.spec, mode, error: m.error });
        if (m.error.inherited || Object.keys(m.scenarios).length === 0)
          continue;
      }
      const ran = Object.values(m.scenarios).some((sc) => !sc.missing);
      if (ran && !m.baseline) noBaseline.push({ sdk: s.spec, mode });
      for (const sc of Object.keys(m.scenarios).sort()) {
        if (m.scenarios[sc].missing) {
          errors.push({
            sdk: s.spec,
            mode,
            error: {
              phase: 'run',
              reason: m.scenarios[sc].reason,
              scenario: sc
            }
          });
          continue;
        }
        const j = judgeScenario(m, sc);
        for (const c of j.unexpected) {
          unexpected.push({ sdk: s.spec, mode, scenario: sc, check: c });
        }
        for (const e of j.stale) stale.push({ sdk: s.spec, mode, entry: e });
      }
    }
  }
  return { unexpected, stale, errors, noBaseline };
}

/**
 * Escape text for a markdown table cell. Everything rendered comes from SDK
 * output or check messages, so it is treated as data: no raw HTML, no pipes,
 * no line breaks, no link/image syntax, no @-mentions, bounded length.
 */
export function cell(text, max = 140) {
  let s = String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/`/g, "'")
    .replace(/@/g, '@​');
}

function code(text, max = 200) {
  const c = cell(text, max);
  return c ? `\`${c}\`` : DASH;
}

export function mergeMatrices(matrices) {
  if (matrices.length === 0) throw new Error('Nothing to merge');
  const base = structuredClone(matrices[0]);
  base.sdks = {};
  for (const m of matrices) {
    for (const [k, v] of Object.entries(m.sdks ?? {})) base.sdks[k] = v;
  }
  base.generatedAt = new Date().toISOString();
  return base;
}

/** matrix.json files directly in, or up to three levels under, each dir. */
export function findMatrixFiles(dirs) {
  const files = [];
  const walk = (dir, depth) => {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
    const direct = path.join(dir, 'matrix.json');
    if (fs.existsSync(direct)) {
      files.push(direct);
      return;
    }
    if (depth >= 3) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
    }
  };
  for (const d of dirs) walk(path.resolve(d), 0);
  return files;
}

export function errorLabel(err) {
  const what =
    err.phase === 'build'
      ? 'build failed'
      : err.phase === 'checkout'
        ? 'checkout failed'
        : err.phase === 'server-start'
          ? 'server failed to start'
          : 'failed before running';
  return `${what}: ${err.detail ?? err.reason}`;
}

function sdkStatusCell(s) {
  const modes = Object.entries(s.modes);
  const errors = modes
    .filter(([, m]) => m.error && !m.error.inherited)
    .map(
      ([mode, m]) =>
        `${modes.length > 1 ? `${mode}: ` : ''}${errorLabel(m.error)}`
    );
  if (errors.length) return `${ICON.FAILURE} ${cell(errors.join('; '), 220)}`;
  const missing = modes.flatMap(([, m]) =>
    Object.values(m.scenarios).filter((sc) => sc.missing)
  ).length;
  const all = modes.flatMap(([, m]) =>
    Object.values(m.scenarios).flatMap((sc) => sc.checks)
  );
  const sum = summarizeChecks(all);
  let unexpected = 0;
  let baselined = 0;
  let stale = 0;
  for (const [, m] of modes) {
    for (const sc of Object.keys(m.scenarios)) {
      const j = judgeScenario(m, sc);
      unexpected += j.unexpected.length;
      baselined += j.baselined.length;
      stale += j.stale.length;
    }
  }
  const parts = [];
  if (missing) parts.push(`${missing} scenario(s) produced no results`);
  if (unexpected) parts.push(`${unexpected} unexpected`);
  if (stale) parts.push(`${stale} stale baseline`);
  if (baselined) parts.push(`${baselined} baselined`);
  const head = parts.length ? `${parts.join(', ')}; ` : '';
  const icon =
    missing || unexpected ? ICON.FAILURE : stale ? ICON.WARNING : ICON.SUCCESS;
  return `${icon} ${head}${sum.passed}/${sum.total} checks pass`;
}

/** `go version go1.26.5 linux/amd64` -> `1.26.5`, `v22.1.0` -> `22.1.0`. */
export function shortVersion(text) {
  return String(text)
    .replace(
      /^(v|go version go|go version |cargo |rustc |ruby |Bundler version |Python |uv |openjdk version )/,
      ''
    )
    .replace(/ \(.*$/, '')
    .replace(/ (linux|darwin|windows)\/\S+$/, '')
    .replace(/^"(.*)"$/, '$1');
}

function toolchainCell(s) {
  const parts = Object.entries(s.toolchain ?? {}).map(
    ([k, v]) => `${k} ${v === null ? 'missing' : cell(shortVersion(v), 32)}`
  );
  return parts.length ? parts.join(', ') : DASH;
}

function scenarioCell(m, sc) {
  if (!m) return DASH;
  const r = m.scenarios[sc];
  if (m.error && (!r || r.missing || r.checks.length === 0)) {
    return `${ICON.FAILURE} ${cell(errorLabel(m.error), 90)}`;
  }
  if (!r) return DASH;
  if (r.missing)
    return `${ICON.FAILURE} no results: ${cell(r.reason ?? '', 80)}`;
  const sum = summarizeChecks(r.checks);
  if (sum.emitted === 0) return `${DASH} 0 checks`;
  const warn = sum.warnings ? ` (+${sum.warnings}${ICON.WARNING})` : '';
  const j = judgeScenario(m, sc);
  if (j.unexpected.length) {
    const icon = j.unexpected.some((c) => c.status === 'FAILURE')
      ? ICON.FAILURE
      : ICON.WARNING;
    return `${icon} ${sum.passed}/${sum.total}${warn}`;
  }
  if (j.baselined.length) {
    return `${ICON.BASELINED} ${sum.passed}/${sum.total}${warn} baselined`;
  }
  if (j.stale.length) {
    return `${ICON.SUCCESS} ${sum.passed}/${sum.total} ${ICON.STALE}stale baseline`;
  }
  return `${ICON.SUCCESS} ${sum.passed}/${sum.total}`;
}

/** Check ids across the given scenarios, in first-seen order. */
function checkIds(sdks, mode, scenarios) {
  const ids = [];
  const seen = new Set();
  for (const sc of scenarios) {
    for (const s of sdks) {
      const r = s.modes[mode]?.scenarios?.[sc];
      if (!r) continue;
      for (const c of r.checks) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        ids.push(c.id);
      }
    }
  }
  return ids;
}

/**
 * One SDK's statuses for a check id, per scenario that emitted it:
 * [{ scenario, status }] with status = worst within that scenario.
 */
function statusesByScenario(sdk, mode, scenarios, id) {
  const out = [];
  const m = sdk.modes[mode];
  const idx = baselineIndex(m);
  for (const sc of scenarios) {
    const r = m?.scenarios?.[sc];
    if (!r || r.missing) continue;
    const statuses = r.checks.filter((c) => c.id === id).map((c) => c.status);
    if (statuses.length) {
      const status = worstStatus(statuses);
      out.push({
        scenario: sc,
        status,
        baselined: isFailing(status) && isBaselined(idx, sc, id)
      });
    }
  }
  return out;
}

/** Icon for a (status, baselined) pair in the check table. */
function statusIcon(status, baselined) {
  if (baselined && isFailing(status)) return ICON.BASELINED;
  return ICON[status] ?? cell(status, 12);
}

export function renderMarkdown(matrix) {
  const sdks = Object.values(matrix.sdks);
  const lines = [];
  lines.push(`## ${cell(matrix.title ?? 'SDK matrix', 200)}`, '');
  const h = matrix.harness ?? {};
  const sel = matrix.selection ?? {};
  const what = sel.scenario
    ? `scenario ${splitList(sel.scenario)
        .map((s) => code(s))
        .join(', ')}`
    : sel.suite
      ? `suite ${code(sel.suite)}`
      : sel.requirements
        ? `requirements ${code(sel.requirements)}`
        : 'default suites';
  const version = h.version ? `, v${cell(h.version, 40)}` : '';
  lines.push(
    `Conformance ${code(h.ref ?? 'unknown')} (${code(h.sha ?? 'unknown')}${version}), mode ${code(sel.mode ?? '?')}, ${what}. Generated ${cell(matrix.generatedAt, 40)}${matrix.host?.runner ? ` on ${cell(matrix.host.runner, 20)}` : ''}.`,
    ''
  );
  lines.push(
    `Legend: ${ICON.SUCCESS} SUCCESS, ${ICON.FAILURE} FAILURE and ${ICON.WARNING} WARNING not in the SDK's own expected-failures baseline (would turn its CI red), ${ICON.BASELINED} fails but baselined by the SDK (its CI stays green), ${ICON.STALE} baselined but now passes (stale entry, also turns its CI red), ${ICON.SKIPPED} SKIPPED, ${ICON.INFO} INFO, ${DASH} not emitted or not run. Summary cells are passed/(passed+failed) checks.`,
    ''
  );

  lines.push(
    '| SDK | SDK head | Status | Baseline | Toolchain |',
    '| --- | --- | --- | --- | --- |'
  );
  for (const s of sdks) {
    const files = [
      ...new Set(
        Object.values(s.modes)
          .map((m) => m.baseline?.file)
          .filter(Boolean)
      )
    ];
    const baseline = files.length
      ? files.map((f) => code(f, 80)).join(', ')
      : 'none';
    lines.push(
      `| ${code(s.spec)} | ${s.head ? code(s.head) : DASH} | ${sdkStatusCell(s)} | ${baseline} | ${toolchainCell(s)} |`
    );
  }
  lines.push('');

  // The question this report exists to answer: does the harness change turn
  // any SDK's own conformance CI red? That is every failing check the SDK's
  // expected-failures baseline does not already excuse, plus baseline
  // entries that now pass (stale), plus SDKs we could not run at all.
  const reg = findRegressions(matrix);
  lines.push('### Regressions', '');
  if (
    reg.unexpected.length === 0 &&
    reg.stale.length === 0 &&
    reg.errors.length === 0
  ) {
    lines.push(
      `${ICON.SUCCESS} None. Every failing check is already in that SDK's expected-failures baseline, and every SDK built and ran.`,
      ''
    );
  } else {
    if (reg.unexpected.length) {
      const cap = 60;
      lines.push(
        `${ICON.FAILURE} ${reg.unexpected.length} failing check(s) not covered by the SDK's baseline:`,
        '',
        '| SDK | Mode | Scenario | Check | Message |',
        '| --- | --- | --- | --- | --- |',
        ...reg.unexpected
          .slice(0, cap)
          .map(
            (u) =>
              `| ${code(u.sdk)} | ${u.mode} | ${code(u.scenario)} | ${ICON[u.check.status]} ${code(u.check.id)} | ${cell(u.check.errorMessage ?? u.check.description ?? '', 160) || DASH} |`
          )
      );
      if (reg.unexpected.length > cap) {
        lines.push(
          `| | | | | ${reg.unexpected.length - cap} more in matrix.json |`
        );
      }
      lines.push('');
    }
    if (reg.stale.length) {
      lines.push(
        `${ICON.STALE} ${reg.stale.length} stale baseline entr${reg.stale.length === 1 ? 'y' : 'ies'} (passes now; the SDK's CI fails until the entry is removed):`,
        '',
        ...reg.stale.map((s) => `- ${code(s.sdk)} ${s.mode}: ${code(s.entry)}`),
        ''
      );
    }
    if (reg.errors.length) {
      lines.push(
        `${ICON.FAILURE} Could not determine for:`,
        '',
        ...reg.errors.map(
          (e) =>
            `- ${code(e.sdk)} ${e.mode}${e.error.scenario ? ` ${code(e.error.scenario)}` : ''}: ${cell(e.error.inherited ? 'build failed (see above)' : errorLabel(e.error), 160)}`
        ),
        ''
      );
    }
  }
  if (reg.noBaseline.length) {
    lines.push(
      `No expected-failures baseline was applied for ${[...new Set(reg.noBaseline.map((n) => code(n.sdk)))].join(', ')} (none configured in KNOWN_SDKS, or a requirements run), so every failure there counts as unexpected.`,
      ''
    );
  }

  const header = `| ${sdks.map((s) => code(s.spec)).join(' | ')} |`;
  const rule = `|${' --- |'.repeat(sdks.length)}`;
  const modes = [...new Set(sdks.flatMap((s) => Object.keys(s.modes)))];
  for (const mode of modes) {
    lines.push(`### ${mode}`, '');
    const scenarioNames = [
      ...new Set(
        sdks.flatMap((s) => Object.keys(s.modes[mode]?.scenarios ?? {}))
      )
    ].sort();
    if (scenarioNames.length === 0) {
      const anyError = sdks.some((s) => s.modes[mode]?.error);
      lines.push(
        anyError
          ? '_No scenario results; see errors below._'
          : '_No scenario results._',
        ''
      );
      continue;
    }
    lines.push(`| Scenario ${header}`, `| --- ${rule}`);
    for (const sc of scenarioNames) {
      const cells = sdks.map((s) => scenarioCell(s.modes[mode], sc));
      lines.push(`| ${code(sc)} | ${cells.join(' | ')} |`);
    }
    lines.push('');

    // One SDK x check table per mode. Check ids are unioned across scenarios
    // (several scenarios usually emit the same ids, e.g. every auth/* flow);
    // a cell is the worst status across the scenarios that emitted it, and
    // any check whose result differs between scenarios is broken out below.
    const ids = checkIds(sdks, mode, scenarioNames);
    if (ids.length) {
      const open = ids.length <= 60 ? ' open' : '';
      const differs = [];
      const scope =
        scenarioNames.length === 1
          ? cell(scenarioNames[0])
          : `${scenarioNames.length} scenarios`;
      lines.push(
        `<details${open}><summary>${mode} checks: ${ids.length} (${scope})</summary>`,
        '',
        `| Check ${header}`,
        `| --- ${rule}`
      );
      for (const id of ids) {
        const cells = sdks.map((s) => {
          const per = statusesByScenario(s, mode, scenarioNames, id);
          if (per.length === 0) return DASH;
          const icons = per.map((p) => statusIcon(p.status, p.baselined));
          // Worst first: an unexcused failure anywhere wins over a baselined
          // one, which wins over a pass.
          const worst =
            per.find((p) => isFailing(p.status) && !p.baselined) ??
            per.find((p) => isFailing(p.status)) ??
            per.find((p) => p.status === worstStatus(per.map((q) => q.status)));
          const icon = statusIcon(worst.status, worst.baselined);
          if (new Set(icons).size > 1) {
            differs.push(
              `- ${code(s.spec)} ${code(id)}: ${per.map((p, i) => `${icons[i]} ${code(p.scenario)}`).join(', ')}`
            );
            return `${icon}\\*`;
          }
          return icon;
        });
        lines.push(`| ${code(id)} | ${cells.join(' | ')} |`);
      }
      lines.push('');
      if (differs.length) {
        lines.push(
          '\\* differs by scenario (cell shows the worst):',
          '',
          ...differs,
          ''
        );
      }
      lines.push('</details>', '');
    }

    // Unexcused failures are already listed under Regressions; this table is
    // the baselined remainder, for context.
    const failures = [];
    for (const s of sdks) {
      const m = s.modes[mode];
      for (const sc of scenarioNames) {
        for (const c of judgeScenario(m, sc).baselined) {
          failures.push(
            `| ${code(s.spec)} | ${code(sc)} | ${ICON.BASELINED} ${code(c.id)} | ${cell(c.errorMessage ?? c.description ?? '', 200) || DASH} |`
          );
        }
      }
    }
    if (failures.length) {
      const cap = 80;
      lines.push(
        `<details><summary>${mode} baselined failure messages (${failures.length})</summary>`,
        '',
        '| SDK | Scenario | Check | Message |',
        '| --- | --- | --- | --- |',
        ...failures.slice(0, cap)
      );
      if (failures.length > cap) {
        lines.push(`| | | | ${failures.length - cap} more in matrix.json |`);
      }
      lines.push('', '</details>', '');
    }
  }

  const errs = [];
  for (const s of sdks) {
    for (const [mode, m] of Object.entries(s.modes)) {
      if (m.error && !m.error.inherited) errs.push([s, mode, m.error]);
    }
  }
  if (errs.length) {
    lines.push('### Build and execution errors', '');
    for (const [s, mode, e] of errs) {
      const tail = tailLines(String(e.tail ?? ''), 25).replace(/```/g, "'''");
      lines.push(
        `<details><summary>${cell(s.spec)} (${mode}): ${cell(errorLabel(e), 160)}</summary>`,
        '',
        `${cell(e.reason ?? '', 300)} (log: ${code(e.logFile ?? 'n/a')})`,
        '',
        '```text',
        tail || '(no output captured)',
        '```',
        '',
        '</details>',
        ''
      );
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function hasErrors(matrix) {
  return Object.values(matrix.sdks).some((s) =>
    Object.values(s.modes).some(
      (m) => m.error || Object.values(m.scenarios).some((sc) => sc.missing)
    )
  );
}

function exitCodeFor(opts, matrix) {
  if (opts.strict && hasRed(matrix)) return 1;
  if (opts.strictErrors && hasErrors(matrix)) return 1;
  return 0;
}

/**
 * True when anything in the matrix would turn some SDK's own CI red, or could
 * not be determined: an unexcused failure, a stale baseline entry, or an SDK
 * that could not be built or run.
 */
export function hasRed(matrix) {
  const reg = findRegressions(matrix);
  return (
    reg.unexpected.length > 0 || reg.stale.length > 0 || reg.errors.length > 0
  );
}

function writeOutputs(matrix, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const md = renderMarkdown(matrix);
  fs.writeFileSync(
    path.join(outDir, 'matrix.json'),
    JSON.stringify(matrix, null, 2)
  );
  fs.writeFileSync(path.join(outDir, 'matrix.md'), md);
  process.stdout.write(md);
  console.error(
    `\n[matrix] Wrote ${path.join(outDir, 'matrix.json')} and matrix.md`
  );
}

// ---------------------------------------------------------------------------
// main

export async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`${err.message}\n\n${HELP}`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const outDir = path.resolve(opts.output);
  if (!opts.listSdks) fs.mkdirSync(outDir, { recursive: true });
  const cacheDir = path.resolve(
    opts.cacheDir ?? path.join(REPO_ROOT, '.sdk-under-test')
  );

  if (opts.merge.length) {
    const files = findMatrixFiles(opts.merge);
    if (files.length === 0) {
      console.error(
        `[matrix] No matrix.json found under: ${opts.merge.join(', ')}`
      );
      return 1;
    }
    console.error(`[matrix] Merging ${files.length} matrix.json file(s)`);
    const merged = mergeMatrices(
      files.map((f) => JSON.parse(fs.readFileSync(f, 'utf-8')))
    );
    if (opts.title) merged.title = opts.title;
    writeOutputs(merged, outDir);
    return exitCodeFor(opts, merged);
  }

  let harness;
  try {
    harness = await prepareHarness(
      opts.listSdks ? { ...opts, skipHarnessBuild: true } : opts,
      cacheDir,
      outDir
    );
  } catch (err) {
    console.error(`[matrix] ${err.message}`);
    return 1;
  }
  const known = listKnownSdks(harness.root);
  if (opts.listSdks) {
    process.stdout.write(
      opts.json ? `${JSON.stringify(known)}\n` : `${known.join('\n')}\n`
    );
    return 0;
  }
  const sdks = resolveSdkList(opts.sdks, known);
  for (const s of sdks) {
    if (!known.includes(sdkKey(s.name))) {
      console.error(
        `[matrix] warning: ${s.name} is not in KNOWN_SDKS at ${harness.ref} (known: ${known.join(', ')})`
      );
    }
  }
  console.error(
    `[matrix] Harness ${harness.ref} (${harness.sha}); SDKs: ${sdks.map((s) => s.spec).join(', ')}; mode ${opts.mode}; cache ${cacheDir}`
  );

  const ctx = { opts, harness, cacheDir, outDir, serverLock: createLock() };
  const records = await pool(sdks, opts.concurrency, async (sdk) => {
    try {
      return await runSdk(sdk, ctx);
    } catch (err) {
      // An orchestration bug for one SDK is recorded, never fatal.
      const mode = opts.mode === 'both' ? 'client' : opts.mode;
      return {
        spec: sdk.spec,
        name: sdk.name,
        requestedRef: sdk.ref ?? null,
        head: null,
        checkoutDir: null,
        toolchain: {},
        modes: {
          [mode]: {
            invocations: [],
            error: {
              phase: 'setup',
              reason: `sdk-matrix internal error: ${err.message}`,
              detail: null,
              logFile: null,
              tail: String(err.stack ?? err)
            },
            scenarios: {}
          }
        }
      };
    }
  });

  const matrix = {
    title: opts.title ?? `SDK matrix: conformance ${harness.ref}`,
    generatedAt: new Date().toISOString(),
    harness: { ref: harness.ref, sha: harness.sha, version: harness.version },
    selection: {
      mode: opts.mode,
      scenario: opts.scenario ?? null,
      suite: opts.suite ?? null,
      requirements: opts.requirements ?? null,
      specVersion: opts.specVersion ?? null
    },
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      runner: process.env.GITHUB_ACTIONS
        ? 'github-actions'
        : process.env.SDK_MATRIX_IN_DOCKER
          ? 'docker'
          : 'local'
    },
    sdks: Object.fromEntries(records.map((r) => [r.spec, r]))
  };
  writeOutputs(matrix, outDir);
  return exitCodeFor(opts, matrix);
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
}
