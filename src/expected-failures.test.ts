import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { loadExpectedFailures, evaluateBaseline } from './expected-failures';
import { ConformanceCheck } from './types';

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
      'tools-call-with-progress',
      'resources-subscribe'
    ]);
    expect(result.client).toEqual(['sse-retry', 'auth/basic-dcr']);
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
    expect(result.server).toEqual(['tools-call-with-progress']);
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

    const result = evaluateBaseline(results, ['scenario-a', 'scenario-b']);
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

    const result = evaluateBaseline(results, ['scenario-a']);
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

    const result = evaluateBaseline(results, ['scenario-a']);
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
    const result2 = evaluateBaseline(results, ['scenario-a']);
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
    const result = evaluateBaseline(results, ['scenario-z']);
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

    const result = evaluateBaseline(results, ['expected-fail']);
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
    const result = evaluateBaseline(results, ['scenario-a']);
    expect(result.exitCode).toBe(1);
    expect(result.staleEntries).toEqual(['scenario-a']);
  });
});
