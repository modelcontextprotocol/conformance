import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

// Stage-only run of the deploy script (no --push, no token needed). Guards
// the val.town per-file cap and the generated JSON/spec-type modules so a
// deploy can never be rejected halfway through uploading a closure.
const REPO_ROOT = join(__dirname, '../..');
const STAGE = join(REPO_ROOT, '.valtown-stage/rs');
const MAX_FILE_CHARS = 80_000;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('deploy-valtown staging', () => {
  it('stages the rs closure with every file under the val.town size cap', async () => {
    const r = spawnSync(
      'npx',
      ['tsx', 'examples/hosted/deploy-valtown.ts', 'rs'],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 }
    );
    expect(r.status, r.stderr).toBe(0);

    const files = walk(STAGE);
    expect(files.length).toBeGreaterThan(50);
    const oversized = files.filter(
      (f) => readFileSync(f, 'utf8').length > MAX_FILE_CHARS
    );
    expect(oversized).toEqual([]);

    // JSON schema imports became generated TS modules that round-trip.
    for (const n of ['2025-03-26', '2025-06-18', '2025-11-25', 'draft']) {
      const orig = JSON.parse(
        readFileSync(join(REPO_ROOT, `src/spec-types/${n}.schema.json`), 'utf8')
      );
      const mod = await import(
        join(STAGE, `src/spec-types/${n}.schema.json.ts`)
      );
      expect(mod.default).toEqual(orig);
    }
    const wire = readFileSync(
      join(STAGE, 'src/validation/wire-schema.ts'),
      'utf8'
    );
    expect(wire).toContain("'../spec-types/draft.schema.json.ts'");
    expect(wire).not.toMatch(/schema\.json';/);

    // Comment-stripped spec-type module still exports its runtime constants.
    const draft = await import(join(STAGE, 'src/spec-types/draft.ts'));
    expect(draft.HEADER_MISMATCH).toBeDefined();
    expect(draft.MISSING_REQUIRED_CLIENT_CAPABILITY).toBeDefined();
  }, 150_000);
});
