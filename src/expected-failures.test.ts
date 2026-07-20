import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
  loadExpectedFailures,
  evaluateBaseline,
  type BaselineEntry
} from './expected-failures';
import { ConformanceCheck } from './types';

/** A baseline entry allowing a whole scenario to fail. */
function whole(scenario: string): BaselineEntry {
  return { scenario };
}

/** A baseline entry allowing one check of a scenario to fail. */
function only(scenario: string, checkId: string): BaselineEntry {
  return { scenario, checkId };
}

function makeCheck(
  id: string,
  status: 'SUCCESS' | 'FAILURE' | 'WARNING' | 'SKIPPED' | 'INFO'
): ConformanceCheck {
  return {
    id,
    name: id,
    description: `Check ${id}`,
    status,
    timestamp: new Date().toISOString()
  };
}

describe('loadExpectedFailures', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'conformance-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  it('loads a valid YAML file with both server and client entries', async () => {
    const filePath = path.join(tmpDir, 'baseline.yml');
    await fs.writeFile(
      filePath,
      `server:
  - tools-call-with-progress
  - resources-subscribe
client:
  - sse-retry
  - auth/basic-dcr
`
    );

    const result = await loadExpectedFailures(filePath);
    expect(result.server).toEqual([
      whole('tools-call-with-progress'),
      whole('resources-subscribe')
    ]);
    expect(result.client).toEqual([
      whole('sse-retry'),
      whole('auth/basic-dcr')
    ]);
  });

  it('loads a file with only server entries', async () => {
    const filePath = path.join(tmpDir, 'baseline.yml');
    await fs.writeFile(
      filePath,
      `server:
  - tools-call-with-progress
`
    );

    const result = await loadExpectedFailures(filePath);
    expect(result.server).toEqual([whole('tools-call-with-progress')]);
    expect(result.client).toBeUndefined();
  });

  it('handles an empty file', async () => {
    const filePath = path.join(tmpDir, 'baseline.yml');
    await fs.writeFile(filePath, '');

    const result = await loadExpectedFailures(filePath);
    expect(result).toEqual({});
  });

  it('throws on invalid structure (array at top level)', async () => {
    const filePath = path.join(tmpDir, 'baseline.yml');
    await fs.writeFile(filePath, '- foo\n- bar\n');

    await expect(loadExpectedFailures(filePath)).rejects.toThrow(
      'expected an object'
    );
  });

  it('throws if server is not an array', async () => {
    const filePath = path.join(tmpDir, 'baseline.yml');
    await fs.writeFile(filePath, 'server: not-an-array\n');

    await expect(loadExpectedFailures(filePath)).rejects.toThrow(
      "'server' must be an array"
    );
  });

  it('throws if client is not an array', async () => {
    const filePath = path.join(tmpDir, 'baseline.yml');
    await fs.writeFile(filePath, 'client: 123\n');

    await expect(loadExpectedFailures(filePath)).rejects.toThrow(
      "'client' must be an array"
    );
  });

  it('names the mistake when a colon entry is written with a space', async () => {
    // `- s: c` is a YAML mapping, not the string `- s:c`. Without a guard this
    // stringifies to '[object Object]' and silently matches nothing.
    const filePath = path.join(tmpDir, 'baseline.yml');
    await fs.writeFile(
      filePath,
      `server:
  - server-stateless: sep-2575-server-implements-discover
`
    );
    await expect(loadExpectedFailures(filePath)).rejects.toThrow(
      /Remove the space after the colon: '- server-stateless:sep-2575-server-implements-discover'/
    );
  });

  it('loads a per-check entry as a plain string', async () => {
    const filePath = path.join(tmpDir, 'baseline.yml');
    await fs.writeFile(
      filePath,
      `server:
  - server-stateless:sep-2575-server-implements-discover
  - tasks-lifecycle
`
    );
    const result = await loadExpectedFailures(filePath);
    expect(result.server).toEqual([
      only('server-stateless', 'sep-2575-server-implements-discover'),
      whole('tasks-lifecycle')
    ]);
  });

  it('does not invent a check id for a trailing-colon entry', async () => {
    // '- s:' parses to {s: null}. Advising '- s:null' would produce a check id
    // named 'null' that matches nothing — the exact silent no-op this guard exists to stop.
    const filePath = path.join(tmpDir, 'baseline.yml');
    await fs.writeFile(filePath, `server:\n  - server-stateless:\n`);
    await expect(loadExpectedFailures(filePath)).rejects.toThrow(
      /takes no space after the colon/
    );
    await expect(loadExpectedFailures(filePath)).rejects.not.toThrow(/null'/);
  });

  it("rejects an empty list entry rather than coercing it to 'null'", async () => {
    const filePath = path.join(tmpDir, 'baseline.yml');
    await fs.writeFile(filePath, `server:\n  -\n`);
    await expect(loadExpectedFailures(filePath)).rejects.toThrow(
      /This one is empty/
    );
  });

  it('rejects a scenario baselined both wholesale and per-check', async () => {
    const filePath = path.join(tmpDir, 'baseline.yml');
    await fs.writeFile(
      filePath,
      `server:\n  - server-stateless\n  - server-stateless:some-check\n`
    );
    await expect(loadExpectedFailures(filePath)).rejects.toThrow(/redundant/);
  });

  it('rejects an entry with an empty side of the colon', async () => {
    const filePath = path.join(tmpDir, 'baseline.yml');
    await fs.writeFile(filePath, `server:\n  - ':some-check'\n`);
    await expect(loadExpectedFailures(filePath)).rejects.toThrow(
      /Both sides of the colon are required/
    );
  });

  it('throws on missing file', async () => {
    await expect(
      loadExpectedFailures('/nonexistent/path.yml')
    ).rejects.toThrow();
  });
});

describe('evaluateBaseline', () => {
  it('returns exit 0 when all failures are expected', () => {
    const results = [
      {
        scenario: 'scenario-a',
        checks: [makeCheck('check1', 'SUCCESS'), makeCheck('check2', 'FAILURE')]
      },
      {
        scenario: 'scenario-b',
        checks: [makeCheck('check3', 'FAILURE')]
      }
    ];

    const result = evaluateBaseline(results, [
      whole('scenario-a'),
      whole('scenario-b')
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.expectedFailures).toEqual(['scenario-a', 'scenario-b']);
    expect(result.unexpectedFailures).toEqual([]);
    expect(result.staleEntries).toEqual([]);
  });

  it('returns exit 0 when no failures at all and no baseline', () => {
    const results = [
      {
        scenario: 'scenario-a',
        checks: [makeCheck('check1', 'SUCCESS')]
      }
    ];

    const result = evaluateBaseline(results, []);
    expect(result.exitCode).toBe(0);
    expect(result.expectedFailures).toEqual([]);
    expect(result.unexpectedFailures).toEqual([]);
    expect(result.staleEntries).toEqual([]);
  });

  it('returns exit 1 for unexpected failures', () => {
    const results = [
      {
        scenario: 'scenario-a',
        checks: [makeCheck('check1', 'FAILURE')]
      }
    ];

    const result = evaluateBaseline(results, []);
    expect(result.exitCode).toBe(1);
    expect(result.unexpectedFailures).toEqual(['scenario-a']);
  });

  it('returns exit 1 for stale baseline entries (scenario now passes)', () => {
    const results = [
      {
        scenario: 'scenario-a',
        checks: [makeCheck('check1', 'SUCCESS')]
      }
    ];

    const result = evaluateBaseline(results, [whole('scenario-a')]);
    expect(result.exitCode).toBe(1);
    expect(result.staleEntries).toEqual(['scenario-a']);
  });

  it('returns exit 1 when both stale and unexpected failures exist', () => {
    const results = [
      {
        scenario: 'scenario-a',
        checks: [makeCheck('check1', 'SUCCESS')] // was expected to fail but passes
      },
      {
        scenario: 'scenario-b',
        checks: [makeCheck('check2', 'FAILURE')] // unexpected failure
      }
    ];

    const result = evaluateBaseline(results, [whole('scenario-a')]);
    expect(result.exitCode).toBe(1);
    expect(result.staleEntries).toEqual(['scenario-a']);
    expect(result.unexpectedFailures).toEqual(['scenario-b']);
  });

  it('handles warnings as failures', () => {
    const results = [
      {
        scenario: 'scenario-a',
        checks: [makeCheck('check1', 'WARNING')]
      }
    ];

    // Not in baseline → unexpected
    const result1 = evaluateBaseline(results, []);
    expect(result1.exitCode).toBe(1);
    expect(result1.unexpectedFailures).toEqual(['scenario-a']);

    // In baseline → expected
    const result2 = evaluateBaseline(results, [whole('scenario-a')]);
    expect(result2.exitCode).toBe(0);
    expect(result2.expectedFailures).toEqual(['scenario-a']);
  });

  it('ignores baseline entries for scenarios not in the run', () => {
    const results = [
      {
        scenario: 'scenario-a',
        checks: [makeCheck('check1', 'SUCCESS')]
      }
    ];

    // scenario-z is in baseline but not in the results - should not be stale
    const result = evaluateBaseline(results, [whole('scenario-z')]);
    expect(result.exitCode).toBe(0);
    expect(result.staleEntries).toEqual([]);
  });

  it('handles mixed expected/unexpected/passing scenarios', () => {
    const results = [
      {
        scenario: 'expected-fail',
        checks: [makeCheck('c1', 'FAILURE')]
      },
      {
        scenario: 'unexpected-fail',
        checks: [makeCheck('c2', 'FAILURE')]
      },
      {
        scenario: 'normal-pass',
        checks: [makeCheck('c3', 'SUCCESS')]
      }
    ];

    const result = evaluateBaseline(results, [whole('expected-fail')]);
    expect(result.exitCode).toBe(1);
    expect(result.expectedFailures).toEqual(['expected-fail']);
    expect(result.unexpectedFailures).toEqual(['unexpected-fail']);
    expect(result.staleEntries).toEqual([]);
  });

  it('skipped and info checks do not count as failures', () => {
    const results = [
      {
        scenario: 'scenario-a',
        checks: [
          makeCheck('c1', 'SUCCESS'),
          makeCheck('c2', 'SKIPPED'),
          makeCheck('c3', 'INFO')
        ]
      }
    ];

    // In baseline but passes (only SUCCESS/SKIPPED/INFO) → stale
    const result = evaluateBaseline(results, [whole('scenario-a')]);
    expect(result.exitCode).toBe(1);
    expect(result.staleEntries).toEqual(['scenario-a']);
  });
});

describe('per-check baseline entries (scenario:check-id)', () => {
  it('excuses only the named check, leaving its siblings enforced', () => {
    const result = evaluateBaseline(
      [
        {
          scenario: 'server-stateless',
          checks: [
            makeCheck('sep-2575-server-implements-discover', 'FAILURE'),
            makeCheck('sep-2575-server-tags-subscription-id', 'SUCCESS')
          ]
        }
      ],
      [only('server-stateless', 'sep-2575-server-implements-discover')]
    );
    expect(result.exitCode).toBe(0);
    expect(result.expectedFailures).toEqual([
      'server-stateless:sep-2575-server-implements-discover'
    ]);
    expect(result.unexpectedFailures).toEqual([]);
  });

  it('is the whole point: an unbaselined sibling failure still fails the run', () => {
    const result = evaluateBaseline(
      [
        {
          scenario: 'server-stateless',
          checks: [
            makeCheck('sep-2575-server-implements-discover', 'FAILURE'),
            makeCheck('sep-2575-server-tags-subscription-id', 'FAILURE')
          ]
        }
      ],
      [only('server-stateless', 'sep-2575-server-implements-discover')]
    );
    expect(result.exitCode).toBe(1);
    expect(result.unexpectedFailures).toEqual([
      'server-stateless:sep-2575-server-tags-subscription-id'
    ]);
  });

  it('flags a baselined check that now passes as stale', () => {
    const result = evaluateBaseline(
      [
        {
          scenario: 'server-stateless',
          checks: [makeCheck('sep-2575-server-implements-discover', 'SUCCESS')]
        }
      ],
      [only('server-stateless', 'sep-2575-server-implements-discover')]
    );
    expect(result.exitCode).toBe(1);
    expect(result.staleEntries).toEqual([
      'server-stateless:sep-2575-server-implements-discover'
    ]);
  });

  it('tolerates a baselined check that was not emitted (prerequisite bailed)', () => {
    const result = evaluateBaseline(
      [
        {
          scenario: 'server-stateless',
          checks: [makeCheck('other', 'SUCCESS')]
        }
      ],
      [only('server-stateless', 'sep-2575-server-implements-discover')]
    );
    expect(result.exitCode).toBe(0);
    expect(result.staleEntries).toEqual([]);
  });

  it('treats a WARNING check as an expected failure, matching scenario-level semantics', () => {
    const result = evaluateBaseline(
      [
        {
          scenario: 'server-stateless',
          checks: [
            makeCheck('sep-2575-request-meta-client-info-optional', 'WARNING')
          ]
        }
      ],
      [only('server-stateless', 'sep-2575-request-meta-client-info-optional')]
    );
    expect(result.exitCode).toBe(0);
    expect(result.expectedFailures).toEqual([
      'server-stateless:sep-2575-request-meta-client-info-optional'
    ]);
  });

  it('excuses every occurrence of a repeated id, and a failure on any of them wins', () => {
    // sep-2575-http-server-meta-invalid-400 is emitted once per _meta test case.
    const result = evaluateBaseline(
      [
        {
          scenario: 'server-stateless',
          checks: [
            makeCheck('sep-2575-http-server-meta-invalid-400', 'SUCCESS'),
            makeCheck('sep-2575-http-server-meta-invalid-400', 'FAILURE'),
            makeCheck('sep-2575-http-server-meta-invalid-400', 'SUCCESS')
          ]
        }
      ],
      [only('server-stateless', 'sep-2575-http-server-meta-invalid-400')]
    );
    expect(result.exitCode).toBe(0);
    expect(result.expectedFailures).toEqual([
      'server-stateless:sep-2575-http-server-meta-invalid-400'
    ]);
  });

  it('reports a repeated failing id once, not once per occurrence', () => {
    const result = evaluateBaseline(
      [
        {
          scenario: 'server-stateless',
          checks: [
            makeCheck('sep-2575-http-server-meta-invalid-400', 'FAILURE'),
            makeCheck('sep-2575-http-server-meta-invalid-400', 'FAILURE')
          ]
        }
      ],
      [only('server-stateless', 'sep-2575-http-server-meta-invalid-400')]
    );
    expect(result.expectedFailures).toEqual([
      'server-stateless:sep-2575-http-server-meta-invalid-400'
    ]);
  });

  it('judges staleness on the most-severe occurrence, not the first', () => {
    // A SKIPPED occurrence ordered ahead of a SUCCESS must not mask the pass:
    // the check demonstrably succeeded, so the baseline entry is stale.
    const result = evaluateBaseline(
      [
        {
          scenario: 'server-stateless',
          checks: [
            makeCheck('repeated', 'SKIPPED'),
            makeCheck('repeated', 'SUCCESS')
          ]
        }
      ],
      [only('server-stateless', 'repeated')]
    );
    expect(result.exitCode).toBe(1);
    expect(result.staleEntries).toEqual(['server-stateless:repeated']);
  });

  it('does not let a repeated id hide a failure when it is NOT baselined', () => {
    const result = evaluateBaseline(
      [
        {
          scenario: 'server-stateless',
          checks: [
            makeCheck('repeated', 'SUCCESS'),
            makeCheck('repeated', 'FAILURE')
          ]
        }
      ],
      []
    );
    expect(result.exitCode).toBe(1);
    expect(result.unexpectedFailures).toEqual(['server-stateless']);
  });

  it('keeps whole-scenario entries working alongside per-check ones', () => {
    const result = evaluateBaseline(
      [
        {
          scenario: 'tasks-lifecycle',
          checks: [makeCheck('a', 'FAILURE'), makeCheck('b', 'FAILURE')]
        },
        {
          scenario: 'server-stateless',
          checks: [makeCheck('c', 'FAILURE'), makeCheck('d', 'SUCCESS')]
        }
      ],
      [whole('tasks-lifecycle'), only('server-stateless', 'c')]
    );
    expect(result.exitCode).toBe(0);
    expect(result.expectedFailures).toEqual([
      'tasks-lifecycle',
      'server-stateless:c'
    ]);
  });

  it('splits on the first colon so slashed scenario names survive', () => {
    const result = evaluateBaseline(
      [
        {
          scenario: 'auth/basic-dcr',
          checks: [makeCheck('wif-grant-type', 'FAILURE')]
        }
      ],
      [only('auth/basic-dcr', 'wif-grant-type')]
    );
    expect(result.exitCode).toBe(0);
    expect(result.expectedFailures).toEqual(['auth/basic-dcr:wif-grant-type']);
  });

  it('judges staleness past an INFO entry sharing the id', () => {
    // collapseDuplicateChecks keeps every INFO, so an INFO can sit ahead of the
    // real verdict for that id. It reports nothing, and must not mask the pass.
    const result = evaluateBaseline(
      [
        {
          scenario: 'server-stateless',
          checks: [
            makeCheck('repeated', 'INFO'),
            makeCheck('repeated', 'SUCCESS')
          ]
        }
      ],
      [only('server-stateless', 'repeated')]
    );
    expect(result.exitCode).toBe(1);
    expect(result.staleEntries).toEqual(['server-stateless:repeated']);
  });
});
