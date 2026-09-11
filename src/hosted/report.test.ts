import { describe, it, expect } from 'vitest';
import { buildMatrix } from './matrix';
import { buildReport, verdictFor } from './report';
import { cellId, type CellRef } from './session';
import { identityCheck } from './identity';
import type { ConformanceCheck } from '../types';

const check = (status: ConformanceCheck['status']): ConformanceCheck => ({
  id: 'c',
  name: 'c',
  description: '',
  status,
  timestamp: new Date().toISOString()
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

  it('scores a column over scored, startable cells and lists the rest apart', async () => {
    const matrix = buildMatrix({ exclude: { 'sse-retry': 'x' } });
    const rev = '2025-11-25';
    const results = new Map<string, ConformanceCheck[]>([
      [
        `r/${rev}/tools_call`,
        [check('SUCCESS'), identityCheck({ name: 'c1', protocolVersion: rev })]
      ],
      [`r/${rev}/initialize`, [check('FAILURE')]],
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
    const scoredStartable = matrix
      .cells()
      .filter(
        (c) => c.revision === rev && c.scoring === 'scored' && c.startable
      );
    expect(col.scored).toEqual({ passed: 1, total: scoredStartable.length });
    const by = (name: string) => col.cells.find((c) => c.scenario === name)!;
    expect(by('tools_call')).toMatchObject({
      verdict: 'pass',
      summary: { passed: 1, info: 1, total: 2 },
      identities: [{ name: 'c1', protocolVersion: rev }],
      resultsUrl: `http://x/results/r/${rev}/tools_call`
    });
    expect(by('initialize').verdict).toBe('fail');
    expect(by('elicitation-sep1034-client-defaults')).toMatchObject({
      verdict: 'incomplete',
      summary: { total: 0 }
    });
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
    expect(col.identities).toEqual([{ name: 'c1', protocolVersion: rev }]);
    expect(report.identities).toEqual([{ name: 'c1', protocolVersion: rev }]);

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
});
