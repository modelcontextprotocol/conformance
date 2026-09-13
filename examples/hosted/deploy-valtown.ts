/**
 * Deploy the hosted conformance server to val.town as readable source.
 *
 * val.town's runtime (Deno) needs import specifiers the repo's Node toolchain
 * doesn't use: `npm:` prefixes for packages, `node:` prefixes for builtins,
 * and explicit `.ts` extensions on relative imports. Rather than fork the
 * source, this script stages a copy of the import closure of
 * examples/hosted/valtown.ts with those specifiers rewritten, then uploads
 * the files via the val.town v2 API (same approach as a plain
 * "create val + upsert files" deploy script).
 *
 * Two vals are deployed:
 *   rs    — the conformance resource server (entry: examples/hosted/valtown.ts)
 *   relay — the second-origin auth relay (entry: examples/hosted/valtown-relay.ts)
 *
 * Usage:
 *   npx tsx examples/hosted/deploy-valtown.ts                # stage only (.valtown-stage/)
 *   npx tsx examples/hosted/deploy-valtown.ts --push         # stage + upload both vals
 *   npx tsx examples/hosted/deploy-valtown.ts --push rs      # upload a single val
 *
 * Token: VAL_TOWN_TOKEN env var (or a .env file next to this script / repo root).
 * Val ids are persisted to examples/hosted/valtown-manifest.json on first push.
 *
 * After the first push, set env vars on the vals (val.town UI → val → Environment):
 *   rs val:    CONFORMANCE_AS_ORIGIN=<relay val URL>, CONFORMANCE_RELAY_SECRET=<secret>
 *   relay val: CONFORMANCE_RS_ORIGIN=<rs val URL>, CONFORMANCE_RELAY_SECRET=<secret>,
 *              CONFORMANCE_RELAY_ROLE=as
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '../..');
const STAGE_ROOT = join(REPO_ROOT, '.valtown-stage');
const MANIFEST_PATH = join(SCRIPT_DIR, 'valtown-manifest.json');
const API = 'https://api.val.town/v2';
/** val.town rejects a file body over this many characters (HTTP 400). */
const MAX_FILE_CHARS = 80_000;
/** Chunk budget for generated JSON part modules, leaving escaping headroom. */
const CHUNK_TARGET_CHARS = 70_000;

const NODE_BUILTINS = new Set([
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'crypto',
  'dns',
  'events',
  'fs',
  'http',
  'https',
  'net',
  'os',
  'path',
  'process',
  'querystring',
  'stream',
  'string_decoder',
  'timers',
  'tls',
  'url',
  'util',
  'zlib'
]);

interface ValInfo {
  id?: string;
  name: string;
  entry: string;
  privacy: 'public' | 'unlisted' | 'private';
}
interface Manifest {
  vals: Record<string, ValInfo>;
}

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
const versions: Record<string, string> = {
  ...pkg.devDependencies,
  ...pkg.dependencies
};

// ---------------------------------------------------------------------------
// Specifier rewriting
// ---------------------------------------------------------------------------

/** Resolve a relative specifier from `fromFile` to an existing repo file. */
function resolveRelative(fromFile: string, spec: string): string {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    base.replace(/\.js$/, '.ts'),
    join(base, 'index.ts')
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  throw new Error(
    `cannot resolve '${spec}' from ${relative(REPO_ROOT, fromFile)}`
  );
}

/** Rewrite one specifier to a val.town/Deno-compatible form. */
function rewriteSpec(
  fromFile: string,
  spec: string,
  discovered: Set<string>
): string {
  if (
    spec.startsWith('node:') ||
    spec.startsWith('npm:') ||
    spec.startsWith('http://') ||
    spec.startsWith('https://')
  ) {
    return spec;
  }
  if (spec.startsWith('.')) {
    const target = resolveRelative(fromFile, spec);
    discovered.add(target);
    let rel = relative(dirname(fromFile), target).replace(/\\/g, '/');
    if (!rel.startsWith('.')) rel = `./${rel}`;
    // JSON modules are staged as generated TS (see stageJsonModule): no import
    // attribute needed, and oversized schemas can be split across files.
    return target.endsWith('.json') ? `${rel}.ts` : rel;
  }
  if (NODE_BUILTINS.has(spec.split('/')[0])) return `node:${spec}`;
  // npm package (possibly scoped, possibly with a subpath)
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const subpath = spec.slice(name.length); // '' or '/server/index.js'
  const version = versions[name];
  if (!version)
    throw new Error(
      `no version for '${name}' in package.json (imported by ${relative(REPO_ROOT, fromFile)})`
    );
  return `npm:${name}@${version}${subpath}`;
}

/** Collect the string-literal module specifiers of a source file via the TS AST. */
function collectSpecifiers(sourceFile: ts.SourceFile): ts.StringLiteral[] {
  const specs: ts.StringLiteral[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specs.push(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specs;
}

/** Rewrite all import/export specifiers in a file; returns new source. */
function rewriteFile(file: string, discovered: Set<string>): string {
  const src = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  // Replace back-to-front so earlier positions stay valid.
  const specs = collectSpecifiers(sourceFile).sort(
    (a, b) => b.getStart(sourceFile) - a.getStart(sourceFile)
  );
  let out = src;
  for (const lit of specs) {
    const rewritten = rewriteSpec(file, lit.text, discovered);
    if (rewritten === lit.text) continue;
    // getStart()/getEnd() include the quotes; keep them as-is.
    const start = lit.getStart(sourceFile) + 1;
    const end = lit.getEnd() - 1;
    out = out.slice(0, start) + rewritten + out.slice(end);
  }
  return out;
}

/**
 * Keep a rewritten TS module under val.town's per-file size cap. The generated
 * spec-type modules (src/spec-types/*.ts) are ~80% JSDoc, so dropping comments
 * is enough; anything still over the cap is a hard error rather than a partial
 * upload later.
 */
function fitTsModule(path: string, content: string): string {
  if (content.length <= MAX_FILE_CHARS) return content;
  const sourceFile = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const stripped = ts
    .createPrinter({ removeComments: true })
    .printFile(sourceFile);
  if (stripped.length > MAX_FILE_CHARS) {
    throw new Error(
      `${path} is ${stripped.length} chars even without comments; val.town caps files at ${MAX_FILE_CHARS}`
    );
  }
  console.log(
    `  (stripped comments from ${path}: ${content.length} → ${stripped.length} chars)`
  );
  return stripped;
}

/**
 * Stage a .json import as `<path>.json.ts`. Small documents become a literal
 * default export; large ones (the spec JSON schemas are 90–180K) are split
 * into `<path>.json.part<n>.ts` string chunks that the main module
 * reassembles with JSON.parse.
 */
function stageJsonModule(
  repoRelPath: string,
  raw: string,
  staged: Map<string, string>
): void {
  const minified = JSON.stringify(JSON.parse(raw));
  const modulePath = `${repoRelPath}.ts`;
  const literal = `export default ${minified};\n`;
  if (literal.length <= MAX_FILE_CHARS) {
    staged.set(modulePath, literal);
    return;
  }
  const parts: string[] = [];
  let start = 0;
  while (start < minified.length) {
    // Grow the chunk until its escaped form would exceed the budget.
    let end = Math.min(minified.length, start + CHUNK_TARGET_CHARS);
    while (
      end > start + 1 &&
      JSON.stringify(minified.slice(start, end)).length > CHUNK_TARGET_CHARS
    ) {
      end -= 1000;
    }
    parts.push(minified.slice(start, end));
    start = end;
  }
  const base = repoRelPath.split('/').pop()!;
  const imports: string[] = [];
  const names: string[] = [];
  parts.forEach((chunk, i) => {
    const name = `p${i}`;
    names.push(name);
    imports.push(`import ${name} from './${base}.part${i}.ts';`);
    staged.set(
      `${repoRelPath}.part${i}.ts`,
      `export default ${JSON.stringify(chunk)};\n`
    );
  });
  staged.set(
    modulePath,
    `${imports.join('\n')}\nexport default JSON.parse(${names.join(' + ')});\n`
  );
  console.log(
    `  (split ${repoRelPath}: ${minified.length} chars → ${parts.length} parts)`
  );
}

/** Crawl the import closure of `entry`, rewriting as we go. */
function stageVal(key: string, entry: string): Map<string, string> {
  const staged = new Map<string, string>(); // repo-relative path -> content
  const queue = [resolve(REPO_ROOT, entry)];
  const seen = new Set<string>(queue);

  while (queue.length > 0) {
    const file = queue.shift()!;
    const repoRel = relative(REPO_ROOT, file).replace(/\\/g, '/');
    if (file.endsWith('.json')) {
      stageJsonModule(repoRel, readFileSync(file, 'utf8'), staged);
      continue;
    }
    const discovered = new Set<string>();
    const content = fitTsModule(repoRel, rewriteFile(file, discovered));
    staged.set(repoRel, content);
    for (const dep of discovered) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }

  // Entry point: val.town serves the root http.ts as the HTTP handler.
  staged.set('http.ts', `export { default } from './${entry}';\n`);

  // Write the staging dir for inspection / local Deno testing.
  const dir = join(STAGE_ROOT, key);
  rmSync(dir, { recursive: true, force: true });
  for (const [path, content] of staged) {
    const out = join(dir, path);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, content);
  }
  console.log(
    `staged ${key}: ${staged.size} files → ${relative(REPO_ROOT, dir)}/`
  );
  return staged;
}

// ---------------------------------------------------------------------------
// val.town v2 API
// ---------------------------------------------------------------------------

function getToken(): string {
  if (process.env.VAL_TOWN_TOKEN) return process.env.VAL_TOWN_TOKEN;
  for (const envPath of [join(SCRIPT_DIR, '.env'), join(REPO_ROOT, '.env')]) {
    if (existsSync(envPath)) {
      const m = readFileSync(envPath, 'utf8').match(/VAL_TOWN_TOKEN=(.+)/);
      if (m) return m[1].trim();
    }
  }
  throw new Error('VAL_TOWN_TOKEN not set (env var or .env file)');
}

async function api(
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  return fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

async function createVal(token: string, info: ValInfo): Promise<string> {
  const res = await api(token, 'POST', '/vals', {
    name: info.name,
    privacy: info.privacy
  });
  if (!res.ok) {
    throw new Error(
      `create ${info.name}: HTTP ${res.status} ${await res.text()}`
    );
  }
  const { id } = (await res.json()) as { id: string };
  return id;
}

async function upsertFile(
  token: string,
  valId: string,
  path: string,
  content: string,
  type: 'http' | 'script'
): Promise<void> {
  const q = `/vals/${valId}/files?path=${encodeURIComponent(path)}`;
  let res = await api(token, 'PUT', q, { content, type });
  if (res.status === 404) {
    res = await api(token, 'POST', q, { content, type });
  }
  if (!res.ok) {
    throw new Error(`upsert ${path}: HTTP ${res.status} ${await res.text()}`);
  }
}

async function pushVal(
  token: string,
  key: string,
  info: ValInfo,
  staged: Map<string, string>
): Promise<boolean> {
  console.log(`\n── ${key} (${info.name}) ──`);
  let created = false;
  if (!info.id) {
    info.id = await createVal(token, info);
    created = true;
    console.log(`  created: ${info.id}`);
  }
  for (const [path, content] of staged) {
    const type = path === 'http.ts' ? 'http' : 'script';
    await upsertFile(token, info.id, path, content, type);
    console.log(`  ↑ ${path} (${content.length} bytes)`);
  }
  return created;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const push = args.includes('--push');
  const targets = args.filter((a) => !a.startsWith('--'));

  const manifest: Manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const keys = targets.length > 0 ? targets : Object.keys(manifest.vals);

  const stagedByKey = new Map<string, Map<string, string>>();
  for (const key of keys) {
    const info = manifest.vals[key];
    if (!info)
      throw new Error(
        `unknown val '${key}' (manifest has: ${Object.keys(manifest.vals).join(', ')})`
      );
    stagedByKey.set(key, stageVal(key, info.entry));
  }

  // Check every file of every val *before* the first upload: a mid-closure
  // rejection would leave the live val half old, half new.
  const oversized: string[] = [];
  for (const [key, files] of stagedByKey) {
    for (const [path, content] of files) {
      if (content.length > MAX_FILE_CHARS)
        oversized.push(`${key}:${path} (${content.length} chars)`);
    }
  }
  if (oversized.length) {
    throw new Error(
      `staged files exceed val.town's ${MAX_FILE_CHARS}-char cap:\n  ${oversized.join('\n  ')}`
    );
  }

  if (!push) {
    console.log('\nstage only (pass --push to upload). Local check, e.g.:');
    console.log(
      '  deno serve --port 3203 --allow-net --allow-env .valtown-stage/rs/http.ts'
    );
    return;
  }

  const token = getToken();
  let dirty = false;
  for (const key of keys) {
    const created = await pushVal(
      token,
      key,
      manifest.vals[key],
      stagedByKey.get(key)!
    );
    dirty = dirty || created;
  }
  if (dirty) {
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
    console.log('\nvaltown-manifest.json updated with new val ids');
  }
  console.log(
    '\n✓ done — remember the env vars (see header comment) if this was the first push.'
  );
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
