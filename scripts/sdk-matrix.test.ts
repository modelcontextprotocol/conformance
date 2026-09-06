import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KNOWN_SDKS } from '../src/sdk-runner/known-sdks';
import {
  REPO_ROOT,
  cell,
  classifyInvocation,
  collectModeResults,
  findMatrixFiles,
  hasRed,
  listKnownSdks,
  mergeMatrices,
  parseArgs,
  parseSdkSpec,
  renderMarkdown,
  resolveSdkList,
  summarizeChecks,
  worstStatus
  // @ts-expect-error untyped .mjs script
} from './sdk-matrix.mjs';

// Canned result dirs mirror what `conformance client|server -o <dir>` writes:
// <dir>/<scenario>-<ISO ts>/checks.json, nested when the scenario name has a
// '/', and prefixed `server-` in server mode.
let tmp: string;

function writeChecks(rel: string, checks: unknown) {
  const dir = path.join(tmp, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'checks.json'), JSON.stringify(checks));
}

const check = (id: string, status: string, extra = {}) => ({
  id,
  name: id,
  description: `desc of ${id}`,
  status,
  timestamp: '2026-09-06T00:00:00.000Z',
  ...extra
});

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-matrix-test-'));
  // ts-sdk client: auth/metadata-default ran twice (older run failed, newer
  // passed) plus initialize.
  writeChecks('ts/client/auth/metadata-default-2026-09-06T10-00-00-000Z', [
    check('prm-discovery', 'FAILURE', { errorMessage: 'old run' })
  ]);
  writeChecks('ts/client/auth/metadata-default-2026-09-06T11-00-00-000Z', [
    check('prm-discovery', 'SUCCESS'),
    check('resource-parameter-matches-prm', 'SUCCESS'),
    check('token-request', 'SUCCESS'),
    check('token-request', 'SUCCESS')
  ]);
  // Same check id with a different outcome in a sibling scenario, to
  // exercise the "differs by scenario" breakout of the combined check table.
  writeChecks('ts/client/auth/metadata-var2-2026-09-06T11-00-02-000Z', [
    check('prm-discovery', 'FAILURE', { errorMessage: 'var2 only' })
  ]);
  writeChecks('ts/client/initialize-2026-09-06T11-00-01-000Z', [
    check('mcp-client-initialization', 'SUCCESS'),
    check('server-info', 'INFO')
  ]);
  // go-sdk client: one warning, one failure with a message containing
  // markdown-hostile characters.
  writeChecks('go/client/auth/metadata-default-2026-09-06T11-00-00-000Z', [
    check('prm-discovery', 'SUCCESS'),
    check('resource-parameter-matches-prm', 'FAILURE', {
      errorMessage:
        'resource=http://a|b <script>x</script> @octocat\nsecond line'
    }),
    check('token-request', 'WARNING', { errorMessage: 'slow' })
  ]);
  // server mode naming
  writeChecks('go/server/server-tools-list-2026-09-06T12-00-00-000Z', [
    check('tools-list', 'SUCCESS')
  ]);
  writeChecks('go/server/server-server-initialize-2026-09-06T12-00-00-000Z', [
    check('server-initialize', 'SUCCESS')
  ]);
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('parseArgs', () => {
  it('defaults to all SDKs, client mode', () => {
    const o = parseArgs([]);
    expect(o.sdks).toBe('all');
    expect(o.mode).toBe('client');
    expect(o.concurrency).toBe(2);
  });

  it('accepts --key=value and repeated --merge', () => {
    const o = parseArgs([
      '--mode=server',
      '--merge',
      'a,b',
      '--merge=c',
      '--strict'
    ]);
    expect(o.mode).toBe('server');
    expect(o.merge).toEqual(['a', 'b', 'c']);
    expect(o.strict).toBe(true);
  });

  it('treats an empty value as not given (unset workflow inputs)', () => {
    const o = parseArgs(['--scenario', '', '--suite', 'auth', '--ref', '']);
    expect(o.scenario).toBeUndefined();
    expect(o.suite).toBe('auth');
    expect(o.ref).toBeUndefined();
  });

  it('rejects conflicting selections and bad modes', () => {
    expect(() => parseArgs(['--scenario', 'a', '--suite', 'b'])).toThrow();
    expect(() => parseArgs(['--mode', 'sideways'])).toThrow();
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown argument/);
  });
});

describe('KNOWN_SDKS discovery', () => {
  it('parses the same keys the module exports', () => {
    expect(listKnownSdks(REPO_ROOT)).toEqual(Object.keys(KNOWN_SDKS));
  });

  it('resolves all / explicit lists with refs', () => {
    const known = ['typescript-sdk', 'go-sdk'];
    expect(resolveSdkList('all', known).map((s: any) => s.spec)).toEqual(known);
    expect(resolveSdkList('go-sdk@v1.2.0, someone/rust-sdk', known)).toEqual([
      { spec: 'go-sdk@v1.2.0', name: 'go-sdk', ref: 'v1.2.0' },
      { spec: 'someone/rust-sdk', name: 'someone/rust-sdk', ref: undefined }
    ]);
    expect(parseSdkSpec('typescript-sdk@')).toEqual({
      spec: 'typescript-sdk@',
      name: 'typescript-sdk',
      ref: undefined
    });
  });
});

describe('classifyInvocation', () => {
  it('recognises a run that reached the scenarios', () => {
    const out = [
      '[sdk] Fetching go-sdk (cached at /x)',
      '[sdk] Building: go build ./...',
      '',
      '[sdk] conformance client --command ./c --scenario initialize',
      'Passed: 1/1'
    ].join('\n');
    expect(classifyInvocation(out, 1)).toEqual({ phase: 'ran', exitCode: 1 });
  });

  it('classifies a build failure and surfaces the toolchain error', () => {
    const out = [
      '[sdk] Cloning https://github.com/modelcontextprotocol/rust-sdk.git -> /c/rust-sdk/main',
      '[sdk] HEAD is 3023198',
      '[sdk] Building: cargo build -p mcp-conformance',
      '    Updating index',
      'error: failed to select a version for the requirement `process-wrap = "^10.0"`',
      '[sdk] Command failed (exit 101): cargo build -p mcp-conformance'
    ].join('\n');
    const c = classifyInvocation(out, 1);
    expect(c.phase).toBe('build');
    expect(c.reason).toBe(
      'Command failed (exit 101): cargo build -p mcp-conformance'
    );
    expect(c.detail).toMatch(/process-wrap/);
  });

  it('classifies a missing toolchain as a build failure', () => {
    const out = [
      '[sdk] Fetching ruby-sdk (cached at /c/ruby-sdk/main)',
      '[sdk] Building: bundle install',
      '/bin/sh: 1: bundle: not found',
      '[sdk] Command failed (exit 127): bundle install'
    ].join('\n');
    const c = classifyInvocation(out, 1);
    expect(c.phase).toBe('build');
    expect(c.reason).toMatch(/exit 127/);
  });

  it('classifies a server that never became ready', () => {
    const out = [
      '[sdk] Fetching go-sdk (cached at /x)',
      '[sdk] Building: go build',
      '[sdk] Starting server: ./server',
      '[sdk] Stopping server',
      '[sdk] Server at http://localhost:3000 did not become ready within 15000ms: fetch failed'
    ].join('\n');
    const c = classifyInvocation(out, 1);
    expect(c.phase).toBe('server-start');
    expect(c.reason).toMatch(/did not become ready/);
  });

  it('classifies a checkout failure', () => {
    const out =
      "[sdk] Cloning https://github.com/x/y.git -> /c\n[sdk] Ref 'nope' not found in y (tried origin/nope, nope)";
    expect(classifyInvocation(out, 1).phase).toBe('checkout');
  });
});

describe('collectModeResults', () => {
  it('keys by scenario name, strips timestamps, keeps the latest run', () => {
    const r = collectModeResults(path.join(tmp, 'ts/client'), 'client');
    expect(Object.keys(r).sort()).toEqual([
      'auth/metadata-default',
      'auth/metadata-var2',
      'initialize'
    ]);
    expect(r['auth/metadata-default'].checks.map((c: any) => c.status)).toEqual(
      ['SUCCESS', 'SUCCESS', 'SUCCESS', 'SUCCESS']
    );
  });

  it('strips exactly one server- prefix in server mode', () => {
    const r = collectModeResults(path.join(tmp, 'go/server'), 'server');
    expect(Object.keys(r).sort()).toEqual(['server-initialize', 'tools-list']);
  });

  it('returns {} for a missing dir', () => {
    expect(collectModeResults(path.join(tmp, 'nope'), 'client')).toEqual({});
  });
});

describe('aggregation helpers', () => {
  it('worstStatus ranks FAILURE > WARNING > SUCCESS > INFO > SKIPPED', () => {
    expect(worstStatus(['SUCCESS', 'INFO'])).toBe('SUCCESS');
    expect(worstStatus(['SUCCESS', 'WARNING', 'SKIPPED'])).toBe('WARNING');
    expect(worstStatus(['WARNING', 'FAILURE'])).toBe('FAILURE');
  });

  it('summarizeChecks scores SUCCESS+FAILURE only', () => {
    expect(
      summarizeChecks([
        { status: 'SUCCESS' },
        { status: 'FAILURE' },
        { status: 'WARNING' },
        { status: 'INFO' }
      ])
    ).toEqual({ passed: 1, failed: 1, warnings: 1, total: 2, emitted: 4 });
  });

  it('cell() neutralises markdown/HTML/mentions and bounds length', () => {
    const c = cell('a|b <img src=x> @octocat\nnext `tick` [l](http://x)', 200);
    expect(c).not.toMatch(/[<>\n]/);
    expect(c).toContain('a\\|b');
    expect(c).toContain('&lt;img');
    expect(c).toContain('@​octocat');
    expect(c).not.toContain('`');
    expect(c).toContain('\\[l\\](http://x)');
    expect(cell('x'.repeat(500), 20)).toHaveLength(20);
  });
});

function matrixFrom(sdks: Record<string, unknown>) {
  return {
    title: 'SDK matrix: conformance PR #488',
    generatedAt: '2026-09-06T12:00:00.000Z',
    harness: { ref: 'PR #488', sha: 'abc123def456', version: '0.2.0' },
    selection: {
      mode: 'client',
      scenario: 'auth/metadata-default',
      suite: null,
      requirements: null
    },
    host: { runner: 'local' },
    sdks
  };
}

describe('renderMarkdown', () => {
  it('renders SDK x check cells, build-failed cells, and escapes data', () => {
    const ts = {
      spec: 'typescript-sdk',
      name: 'typescript-sdk',
      head: 'aaaaaaa',
      toolchain: { node: 'v22.1.0', pnpm: '10.26.1', npm: '10.9.0' },
      modes: {
        client: {
          invocations: [],
          error: null,
          scenarios: collectModeResults(path.join(tmp, 'ts/client'), 'client')
        }
      }
    };
    const go = {
      spec: 'go-sdk',
      name: 'go-sdk',
      head: 'bbbbbbb',
      toolchain: { go: 'go version go1.26.5 linux/amd64' },
      modes: {
        client: {
          invocations: [],
          error: null,
          scenarios: collectModeResults(path.join(tmp, 'go/client'), 'client')
        }
      }
    };
    const rust = {
      spec: 'rust-sdk',
      name: 'rust-sdk',
      head: 'ccccccc',
      toolchain: { cargo: 'cargo 1.96.1 (abc 2026-01-01)', rustc: null },
      modes: {
        client: {
          invocations: [],
          error: {
            phase: 'build',
            reason: 'Command failed (exit 101): cargo build -p mcp-conformance',
            detail:
              'failed to select a version for the requirement `process-wrap = "^10.0"`',
            logFile: 'sdks/rust-sdk/client-auth_metadata-default.log',
            tail: 'error: failed to select a version\n```injected fence```'
          },
          scenarios: {
            'auth/metadata-default': {
              resultDir: null,
              checks: [],
              missing: true,
              reason: 'x'
            }
          }
        }
      }
    };
    const md: string = renderMarkdown(
      matrixFrom({ 'typescript-sdk': ts, 'go-sdk': go, 'rust-sdk': rust })
    );

    // Overview rows. INFO is not scored: 4 SUCCESS in metadata-default + 1 in
    // initialize, 1 FAILURE in metadata-var2.
    expect(md).toContain(
      '| `typescript-sdk` | `aaaaaaa` | ❌ 1 failed, 0 warnings / 6 checks |'
    );
    expect(md).toMatch(
      /\| `go-sdk` \| `bbbbbbb` \| ❌ 1 failed, 1 warnings \/ 2 checks \| go 1\.26\.5 \|/
    );
    expect(md).toContain(
      "❌ build failed: failed to select a version for the requirement 'process-wrap"
    );
    expect(md).toContain('rustc missing');
    // Scenario summary: initialize only ran for ts; go shows a dash.
    expect(md).toMatch(/\| `initialize` \| ✅ 1\/1 \| — \| ❌ build failed/);
    expect(md).toMatch(
      /\| `auth\/metadata-default` \| ✅ 4\/4 \| ❌ 1\/2 \(\+1⚠️\) \|/
    );
    expect(md).toMatch(
      /\| `auth\/metadata-var2` \| ❌ 0\/1 \| — \| ❌ build failed/
    );
    // One combined SDK x check table per mode: ids are unioned across the
    // three scenarios, a repeated id collapses to one row, worst status wins.
    expect(md).toContain('<summary>client checks: 5 (3 scenarios)</summary>');
    expect(md.match(/\| Check \|/g)?.length).toBe(1);
    const rows = md
      .split('\n')
      .filter((l) => l.startsWith('| `token-request` |'));
    expect(rows).toEqual(['| `token-request` | ✅ | ⚠️ | — |']);
    expect(md).toContain('| `resource-parameter-matches-prm` | ✅ | ❌ | — |');
    expect(md).toContain('| `mcp-client-initialization` | ✅ | — | — |');
    // A check whose outcome differs between scenarios is starred and listed.
    expect(md).toContain('| `prm-discovery` | ❌\\* | ✅ | — |');
    expect(md).toContain(
      '- `typescript-sdk` `prm-discovery`: ✅ `auth/metadata-default`, ❌ `auth/metadata-var2`'
    );
    // Failure messages are escaped data.
    expect(md).not.toContain('<script>');
    expect(md).toContain('&lt;script&gt;');
    expect(md).toContain('a\\|b');
    expect(md).toContain('@​octocat');
    // Error tail is fenced and cannot close the fence early.
    expect(md).toContain("'''injected fence'''");
    expect(md.match(/```/g)?.length).toBe(2);
    // No table row has an unescaped newline inside a cell: every table line
    // starts and ends with a pipe.
    for (const line of md.split('\n')) {
      if (line.startsWith('|')) expect(line.trimEnd().endsWith('|')).toBe(true);
    }
  });

  it('hasRed is false for an all-green matrix and true otherwise', () => {
    const green = matrixFrom({
      ts: {
        spec: 'ts',
        modes: {
          client: {
            error: null,
            scenarios: { a: { checks: [{ id: 'x', status: 'SUCCESS' }] } }
          }
        }
      }
    });
    expect(hasRed(green)).toBe(false);
    const red = structuredClone(green) as any;
    red.sdks.ts.modes.client.scenarios.a.checks[0].status = 'FAILURE';
    expect(hasRed(red)).toBe(true);
  });
});

describe('merge', () => {
  it('finds matrix.json under artifact-style subdirs and unions SDKs', () => {
    const a = matrixFrom({ 'go-sdk': { spec: 'go-sdk', modes: {} } });
    const b = matrixFrom({ 'rust-sdk': { spec: 'rust-sdk', modes: {} } });
    const root = path.join(tmp, 'artifacts');
    for (const [name, m] of Object.entries({ a, b })) {
      const d = path.join(root, `sdk-matrix-${name}`, 'nested');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'matrix.json'), JSON.stringify(m));
    }
    const files: string[] = findMatrixFiles([root]);
    expect(files).toHaveLength(2);
    const merged = mergeMatrices(
      files.map((f) => JSON.parse(fs.readFileSync(f, 'utf-8')))
    );
    expect(Object.keys(merged.sdks).sort()).toEqual(['go-sdk', 'rust-sdk']);
    expect(merged.harness.ref).toBe('PR #488');
  });
});
