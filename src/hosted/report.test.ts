import { describe, it, expect } from 'vitest';
import { buildMatrix } from './matrix';
import { buildReport, incompleteNote, verdictFor } from './report';
import { cellId, finalizeChecks, type CellRef } from './session';
import { identityCheck, identityOf } from './identity';
import { legacyProbeCheck } from './wire';
import type { ConformanceCheck } from '../types';

const check = (status: ConformanceCheck['status']): ConformanceCheck => ({
  id: 'c',
  name: 'c',
  description: '',
  status,
  timestamp: new Date().toISOString()
});

describe('incomplete notes', () => {
  it('says what an incomplete cell is still waiting for, never "nothing recorded" over checks', () => {
    expect(incompleteNote([])).toBe(
      'nothing recorded yet — point the client at the MCP endpoint'
    );
    expect(incompleteNote([check('INFO')])).toBe(
      'the client has not yet done anything this scenario tests'
    );
    expect(incompleteNote([check('FAILURE'), check('INFO')])).toBe(
      'the client has not yet done anything this scenario tests; the failure listed is what it is still waiting for'
    );
    const probe = legacyProbeCheck(
      '2026-07-28',
      '2025-11-25',
      { status: 400, code: -32022, message: 'Unsupported protocol version' },
      '2025-11-25'
    );
    expect(incompleteNote([probe, check('FAILURE'), check('FAILURE')])).toBe(
      'the client spoke 2025-11-25 only (it opened with initialize) and did not retry at 2026-07-28; the 2 failures listed are what it is still waiting for'
    );
    // Once the client has spoken the cell's revision, the probe is history.
    const retried = identityCheck(
      identityOf({ name: 'c1', protocolVersion: '2026-07-28' })
    );
    expect(incompleteNote([probe, retried])).toBe(
      'the client has not yet done anything this scenario tests'
    );
  });
});

describe('verdicts', () => {
  it('follows FAILURE only', () => {
    expect(verdictFor({ scoring: 'scored' }, undefined)).toBe('incomplete');
    expect(verdictFor({ scoring: 'scored' }, [])).toBe('incomplete');
    expect(verdictFor({ scoring: 'scored' }, [check('SUCCESS')])).toBe('pass');
    expect(
      verdictFor({ scoring: 'scored' }, [check('WARNING'), check('INFO')])
    ).toBe('pass');
    expect(
      verdictFor({ scoring: 'not_scored' }, [
        check('SUCCESS'),
        check('FAILURE')
      ])
    ).toBe('fail');
    expect(verdictFor({ scoring: 'n/a' }, [check('FAILURE')])).toBe('n/a');
    // Judgement-added failures on a cell that recorded nothing.
    expect(verdictFor({ scoring: 'scored' }, [check('FAILURE')], 0)).toBe(
      'incomplete'
    );
  });

  it("scores a column over the requirement set's cells and lists the rest apart", async () => {
    const matrix = buildMatrix({ exclude: { 'sse-retry': 'x' } });
    const rev = '2025-11-25';
    const results = new Map<string, ConformanceCheck[]>([
      [
        `r/${rev}/tools_call`,
        [
          check('SUCCESS'),
          identityCheck(identityOf({ name: 'c1', protocolVersion: rev }))
        ]
      ],
      [
        `r/${rev}/initialize`,
        [
          check('FAILURE'),
          // Same client, another negotiated version: one identity.
          identityCheck(
            identityOf({ name: 'c1', protocolVersion: '2025-06-18' })
          )
        ]
      ],
      [`r/2026-07-28/tools_call`, [check('SUCCESS')]],
      [`r/${rev}/json-schema-2020-12-preservation`, [check('SUCCESS')]], // not_scored; not startable but exercised
      [`r/${rev}/elicitation-sep1034-client-defaults`, []] // created, nothing recorded
    ]);
    const report = await buildReport(matrix, 'r', undefined, {
      listCells: async () =>
        Array.from(results.keys()).map((id) => {
          const [runId, revision, ...rest] = id.split('/');
          return {
            runId,
            revision: revision as CellRef['revision'],
            scenarioName: rest.join('/')
          };
        }),
      results: async (id) => {
        const checks = results.get(id);
        return checks ? { checks, recorded: checks.length } : undefined;
      },
      resultsUrl: (ref) => `http://x/results/${cellId(ref)}`
    });

    expect(report.columns.map((c) => c.revision)).toEqual([rev, '2026-07-28']);
    const col = report.columns[0];
    // N is the yaml's count — every scored cell, startable here or not
    // (auth/* cells are not, with no relay origin); the startable subset is
    // reported alongside.
    const scored = matrix
      .cells()
      .filter((c) => c.revision === rev && c.scoring === 'scored');
    const startable = scored.filter((c) => c.startable).length;
    expect(startable).toBeLessThan(scored.length);
    expect(col.scored).toEqual({
      passed: 1,
      total: scored.length,
      startable
    });
    const by = (name: string) => col.cells.find((c) => c.scenario === name)!;
    expect(by('tools_call')).toMatchObject({
      verdict: 'pass',
      summary: { passed: 1, info: 1, total: 2 },
      identities: [{ name: 'c1', protocolVersions: [rev] }],
      resultsUrl: `http://x/results/r/${rev}/tools_call`
    });
    expect(by('initialize').verdict).toBe('fail');
    expect(by('elicitation-sep1034-client-defaults')).toMatchObject({
      verdict: 'incomplete',
      state: 'in-progress',
      summary: { total: 0 }
    });
    // The state splits incomplete by whether the client got there at all.
    expect(by('tools_call').state).toBe('pass');
    expect(by('initialize').state).toBe('fail');
    expect(by('sse-retry').state).toBe('not-startable');
    expect(by('request-metadata').state).toBe('n/a');
    expect(col.counts).toMatchObject({ pass: 2, fail: 1, 'in-progress': 1 });
    expect(report.columns[1].counts['not-tried']).toBeGreaterThan(0);
    expect(col.counts['n/a']).toBeUndefined();
    // The failure is on its row, one line, and said once as a cause.
    expect(by('initialize').findings).toEqual([
      expect.objectContaining({ status: 'FAILURE', check: 'c', by: 'client' })
    ]);
    expect(report.causes.map((c) => [c.check, c.cells])).toEqual([
      ['c', [`${rev}/initialize`]]
    ]);
    expect(Date.parse(report.generatedAt)).not.toBeNaN();
    expect(by('request-metadata')).toMatchObject({ verdict: 'n/a' });
    expect(by('request-metadata').summary).toBeUndefined();
    expect(by('sse-retry')).toMatchObject({
      verdict: 'incomplete',
      startable: false,
      startReason: 'x'
    });
    // Exercised not_scored cell reported next to the score, not in it.
    expect(col.notScored.map((c) => c.scenario)).toEqual([
      'json-schema-2020-12-preservation'
    ]);
    expect(col.notScored[0].verdict).toBe('pass');
    // One line per client across the column and the run, versions pooled
    // in row order (the initialize row precedes tools_call).
    expect(col.identities).toEqual([
      { name: 'c1', protocolVersions: ['2025-06-18', rev] }
    ]);
    expect(report.identities).toEqual([
      { name: 'c1', protocolVersions: ['2025-06-18', rev] }
    ]);

    const column = await buildReport(matrix, 'r', '2026-07-28', {
      listCells: async () => [],
      results: async () => undefined,
      resultsUrl: () => ''
    });
    expect(column.revision).toBe('2026-07-28');
    expect(column.columns).toHaveLength(1);
    expect(column.columns[0].scored.passed).toBe(0);
    expect(
      column.columns[0].cells.find((c) => c.scenario === 'initialize')!.verdict
    ).toBe('n/a');
  });

  it('reads a failed cell whose failures are all not seen as waiting, and accounts for every cell', async () => {
    const matrix = buildMatrix({});
    const rev = '2025-11-25';
    // tools_call: the client initialized, the tool is not called yet.
    const connected = finalizeChecks('tools_call', [check('SUCCESS')], rev);
    // initialize: the same, plus a failure of the client's own.
    const broken = [...connected, check('FAILURE')];
    const logs = new Map([
      ['tools_call', connected],
      ['initialize', broken]
    ]);
    const report = await buildReport(matrix, 'r', rev, {
      listCells: async () =>
        [...logs.keys()].map((scenarioName) => ({
          runId: 'r',
          revision: rev,
          scenarioName
        })),
      results: async (id) => {
        const checks = logs.get(id.split('/').slice(2).join('/'))!;
        return { checks, recorded: checks.length };
      },
      resultsUrl: () => ''
    });
    const col = report.columns[0];
    const by = (name: string) => col.cells.find((c) => c.scenario === name)!;
    expect(by('tools_call')).toMatchObject({
      verdict: 'fail',
      state: 'waiting',
      note: 'waiting for the client or the person to finish the flow',
      summary: { failed: 0, notSeen: 1 }
    });
    expect(by('initialize')).toMatchObject({ verdict: 'fail', state: 'fail' });
    // The score is the verdict's: neither cell passes.
    expect(col.scored.passed).toBe(0);
    // Every cell is counted in exactly one state, n/a cells left out; the
    // startable ones are the reached and the not tried.
    const applicable = col.cells.filter((c) => c.state !== 'n/a');
    const counted = Object.values(col.counts).reduce((a, b) => a + b, 0);
    expect(counted).toBe(applicable.length);
    const startable = applicable.filter((c) => c.startable).length;
    const reachedOrNot = [
      'pass',
      'fail',
      'waiting',
      'in-progress',
      'incomplete',
      'not-tried'
    ] as const;
    expect(reachedOrNot.reduce((sum, s) => sum + (col.counts[s] ?? 0), 0)).toBe(
      startable
    );
  });

  it('counts a check recorded again once', async () => {
    const matrix = buildMatrix({});
    const rev = '2025-11-25';
    const again = [check('SUCCESS'), check('SUCCESS'), check('SUCCESS')];
    const report = await buildReport(matrix, 'r', rev, {
      listCells: async () => [
        { runId: 'r', revision: rev, scenarioName: 'initialize' }
      ],
      results: async () => ({ checks: again, recorded: again.length }),
      resultsUrl: () => ''
    });
    const cell = report.columns[0].cells.find(
      (c) => c.scenario === 'initialize'
    )!;
    expect(cell.summary).toMatchObject({ passed: 1, total: 1 });
  });

  it('says once that a legacy-only client stopped every cell it reached', async () => {
    const matrix = buildMatrix({});
    const served = '2026-07-28';
    const probe = legacyProbeCheck(
      served,
      '2025-11-25',
      { status: 400, code: -32022, message: 'Unsupported protocol version' },
      '2025-11-25'
    );
    const ids = [`r/${served}/tools_call`, `r/${served}/request-metadata`];
    const report = await buildReport(matrix, 'r', served, {
      listCells: async () =>
        ids.map((id) => {
          const [runId, revision, ...rest] = id.split('/');
          return {
            runId,
            revision: revision as CellRef['revision'],
            scenarioName: rest.join('/')
          };
        }),
      // INFO only: nothing the scenario tests was recorded.
      results: async (id) =>
        ids.includes(id) ? { checks: [probe], recorded: 0 } : undefined,
      resultsUrl: () => ''
    });
    const cells = report.columns[0].cells.filter((c) =>
      ['tools_call', 'request-metadata'].includes(c.scenario)
    );
    expect(cells.map((c) => [c.verdict, c.state])).toEqual([
      ['incomplete', 'incomplete'],
      ['incomplete', 'incomplete']
    ]);
    expect(report.causes).toHaveLength(1);
    expect(report.causes[0]).toMatchObject({
      by: 'client',
      cells: [`${served}/tools_call`, `${served}/request-metadata`]
    });
    expect(report.causes[0].text).toMatch(
      /^The client spoke 2025-11-25 only: it opened with initialize/
    );
    expect(cells.every((c) => c.cause === report.causes[0].key)).toBe(true);
  });
});
