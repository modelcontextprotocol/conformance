#!/usr/bin/env -S npx tsx
/**
 * Vendor schema/{version}/schema.ts and schema/{version}/schema.json from the
 * modelcontextprotocol spec repo into src/spec-types/{version}.ts and
 * src/spec-types/{version}.schema.json at a pinned SHA.
 *
 * Usage: npm run sync-schema -- <sha-or-ref>
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const VERSIONS = ['2025-03-26', '2025-06-18', '2025-11-25', 'draft'] as const;
const SPEC_REPO =
  'https://github.com/modelcontextprotocol/modelcontextprotocol.git';
const OUT_DIR = join(process.cwd(), 'src', 'spec-types');

const ref = process.argv[2];
if (!ref) {
  console.error('Usage: npm run sync-schema -- <sha-or-ref>');
  process.exit(1);
}

const tmp = join(process.cwd(), '.sync-schema-tmp');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const git = (args: string[]) =>
  execFileSync('git', args, { cwd: tmp, encoding: 'utf8' });

try {
  console.log(`Fetching ${SPEC_REPO} @ ${ref} ...`);
  git(['init', '-q']);
  git(['remote', 'add', 'origin', SPEC_REPO]);
  git(['fetch', '-q', '--depth', '1', 'origin', ref]);
  git(['checkout', '-q', 'FETCH_HEAD']);
  const sha = git(['rev-parse', 'HEAD']).trim();

  for (const v of VERSIONS) {
    copyFileSync(join(tmp, 'schema', v, 'schema.ts'), join(OUT_DIR, `${v}.ts`));
    console.log(`  ${v} -> src/spec-types/${v}.ts`);
    copyFileSync(
      join(tmp, 'schema', v, 'schema.json'),
      join(OUT_DIR, `${v}.schema.json`)
    );
    console.log(`  ${v} -> src/spec-types/${v}.schema.json`);
  }

  writeFileSync(
    join(OUT_DIR, 'SOURCE'),
    `modelcontextprotocol@${sha}\n`,
    'utf8'
  );
  console.log(`Pinned: modelcontextprotocol@${sha}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
