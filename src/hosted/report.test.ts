import { beforeAll, describe, it, expect } from 'vitest';
import { buildMatrix } from './matrix';
import {
  buildReport,
  groupColumn,
  incompleteNote,
  notTriedHint,
  reportJson,
  summarize,
  unavailableScenarios,
  verdictFor,
  viewCell,
  WAITING_NOTE,
  withNotTriedHints,
  type RunReport
} from './report';
import { shownChecks } from './shown';
import { reportMarkdown } from './markdown';
import { cellId, finalizeChecks, type CellRef } from './session';
import { describeStep } from '../steps';
import { identityCheck, identityOf } from './identity';
import { legacyProbeCheck } from './wire';
import type { ConformanceCheck } from '../types';
import { hostedScenarios } from './catalog';

// Judged without the HTTP layer, which loads the scenarios a request needs.
beforeAll(() => hostedScenarios.loadAll());

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

describe('grouping', () => {
  const sourcesFor = (results: Map<string, ConformanceCheck[]>) => ({
    listCells: async () =>
      Array.from(results.keys()).map((id) => {
        const [runId, revision, ...rest] = id.split('/');
        return {
          runId,
          revision: revision as CellRef['revision'],
          scenarioName: rest.join('/')
        };
      }),
    results: async (id: string) => {
      const checks = results.get(id);
      return checks ? { checks, recorded: checks.length } : undefined;
    },
    resultsUrl: (ref: CellRef) => `http://x/results/${cellId(ref)}`
  });
  const rev = '2025-11-25';
  // tools_call is refused here at every revision; auth/* cells have no
  // relay origin, so this deployment cannot start them either.
  const matrix = buildMatrix({ exclude: { tools_call: 'excluded here' } });
  let report: RunReport;
  beforeAll(async () => {
    report = await buildReport(
      matrix,
      'r',
      undefined,
      sourcesFor(
        new Map([
          [`r/${rev}/initialize`, [check('SUCCESS')]],
          [`r/${rev}/elicitation-sep1034-client-defaults`, []],
          [`r/${rev}/sse-retry`, [check('FAILURE')]]
        ])
      )
    );
  });

  it('lists what needs a look, then not tried, then passes, and unavailable cells apart, with every count as it was', () => {
    const col = report.columns[0];
    const groups = groupColumn(col);
    // Failures before what is still going, whatever the matrix order.
    expect(groups.problems.map((c) => [c.scenario, c.state])).toEqual([
      ['sse-retry', 'fail'],
      ['elicitation-sep1034-client-defaults', 'in-progress']
    ]);
    expect(groups.passed.map((c) => c.scenario)).toEqual(['initialize']);
    expect(groups.unavailable.map((c) => c.scenario)).toEqual(
      expect.arrayContaining(['tools_call', 'auth/metadata-default'])
    );
    // Nothing reached 2026-07-28: its startable cells are all not tried.
    const later = groupColumn(report.columns[1]);
    expect(later.notTried.length).toBeGreaterThan(0);
    expect(later.problems).toEqual([]);
    for (const [i, c] of report.columns.entries()) {
      const g = groupColumn(c);
      for (const cell of g.notTried) {
        expect(cell).toMatchObject({ state: 'not-tried', startable: true });
      }
      for (const cell of g.unavailable) expect(cell.startable).toBe(false);
      // Every cell but n/a is in exactly one group.
      const grouped = [
        ...g.problems,
        ...g.notTried,
        ...g.passed,
        ...g.unavailable
      ];
      expect(new Set(grouped.map((x) => x.scenario)).size, `${i}`).toBe(
        grouped.length
      );
      expect(grouped).toHaveLength(
        c.cells.filter((x) => x.state !== 'n/a').length
      );
      // The counts are untouched by the grouping.
      expect(c.counts['not-tried'] ?? 0).toBe(g.notTried.length);
      expect(c.counts['not-startable'] ?? 0).toBe(g.unavailable.length);
    }
    expect(col.scored.total).toBe(
      matrix.cells().filter((c) => c.revision === rev && c.scoring === 'scored')
        .length
    );
    // One line per scenario, with every revision it is unavailable at.
    expect(
      unavailableScenarios(report).find((u) => u.scenario === 'tools_call')
    ).toEqual({
      scenario: 'tools_call',
      revisions: [rev, '2026-07-28'],
      reason: 'excluded here'
    });
  });

  it('gives JSON a notTried and an unavailable list per revision, and keeps every cell in cells', () => {
    const json = reportJson(report);
    for (const [i, col] of json.columns.entries()) {
      const groups = groupColumn(report.columns[i]);
      expect(col.cells).toHaveLength(report.columns[i].cells.length);
      expect(col.notTried.map((c) => c.scenario)).toEqual(
        groups.notTried.map((c) => c.scenario)
      );
      expect(col.unavailable.map((c) => c.scenario)).toEqual(
        groups.unavailable.map((c) => c.scenario)
      );
      expect(col.counts).toEqual(report.columns[i].counts);
    }
  });

  it('adds each not-tried cell its MCP URL and what the client must do, on a copy', () => {
    const served = withNotTriedHints(
      report,
      matrix,
      (ref) => `http://x/s/${cellId(ref)}`,
      describeStep
    );
    for (const [i, col] of served.columns.entries()) {
      for (const c of col.cells) {
        if (c.state !== 'not-tried') {
          expect(c.mcpUrl).toBeUndefined();
          continue;
        }
        expect(c.mcpUrl).toBe(`http://x/s/r/${c.revision}/${c.scenario}/mcp`);
        const steps = matrix.cell(c.scenario, c.revision)!.steps;
        if (steps) {
          expect(c.hint).toMatch(
            new RegExp(`^connect, then ${describeStep(steps[0])}`)
          );
        } else {
          expect(c.hint).toMatch(/^connect/);
        }
      }
      // The report it was given is left as it is (a frozen copy's form).
      expect(report.columns[i].cells.some((c) => c.mcpUrl)).toBe(false);
    }
    // A copy stored before the groups existed groups the same way.
    const stored = JSON.parse(JSON.stringify(report)) as RunReport;
    expect(groupColumn(stored.columns[0])).toEqual(
      groupColumn(report.columns[0])
    );
  });

  it('says what the client must do from the steps, the sign-in or the description', () => {
    const tools = matrix.cell('tools_call', rev)!;
    expect(notTriedHint(tools, '', describeStep)).toBe(
      'connect, then list the tools, then call add_numbers with a=2 and b=3'
    );
    expect(
      notTriedHint(
        {
          scenario: 'x',
          steps: [
            { op: 'tools/list' },
            { op: 'wait', ms: 1 },
            { op: 'wait', ms: 2 },
            { op: 'disconnect' }
          ]
        },
        '',
        describeStep
      )
    ).toBe(
      'connect, then list the tools, then wait 1 ms, then wait 2 ms, and 1 more step'
    );
    // A call whose arguments would fill the line names the tool only.
    expect(
      notTriedHint(
        {
          scenario: 'x',
          steps: [
            {
              op: 'tools/call',
              name: 'big',
              arguments: { a: 'x'.repeat(80) }
            },
            { op: 'tools/call', name: 'small', arguments: { a: 1 } }
          ]
        },
        '',
        describeStep
      )
    ).toBe(
      'connect, then call big with the arguments on the cell’s page, then call small with a=1'
    );
    expect(
      notTriedHint({ scenario: 'auth/metadata-default' }, '', describeStep)
    ).toMatch(/^connect and approve the sign-in/);
    expect(
      notTriedHint(
        { scenario: 'sse-retry' },
        'Tests that client respects SSE retry field timing',
        describeStep
      )
    ).toBe(
      'connect; the cell tests that client respects SSE retry field timing'
    );
  });
});

describe('stopped', () => {
  const rev = '2026-07-28' as CellRef['revision'];
  const at = '2026-09-14T06:44:40.000Z';
  const T = Date.parse(at);
  const MIN = 60_000;
  // tools_call after the client listed the tools and went quiet: its only
  // failure is "Tool was not called by client", not seen yet.
  const listed: ConformanceCheck = {
    id: 'tools-list-requested',
    name: 'ToolsListRequested',
    description: 'Client requested tools/list',
    status: 'INFO',
    timestamp: at
  };
  const cell = buildMatrix().cell('tools_call', rev)!;
  const results = (extra: { awaitingInput?: true } = {}) => ({
    checks: finalizeChecks('tools_call', [listed], rev),
    recorded: 1,
    lastRequestAt: at,
    ...extra
  });

  it('reads a waiting cell stopped once its client is quiet for a minute, verdict unchanged', () => {
    expect(viewCell(cell, results(), T + MIN - 1_000)).toMatchObject({
      state: 'waiting',
      verdict: 'incomplete',
      note: WAITING_NOTE
    });
    expect(viewCell(cell, results(), T + MIN)).toMatchObject({
      state: 'stopped',
      verdict: 'incomplete',
      note: 'stopped: no request from your client for 1 minute; re-run it'
    });
    expect(viewCell(cell, results(), T + 3 * MIN + 5_000)).toMatchObject({
      state: 'stopped',
      verdict: 'incomplete',
      note: 'stopped: no request from your client for 3 minutes; re-run it'
    });
    // No request time known: nothing says it stopped.
    const untimed = { checks: results().checks, recorded: 1 };
    expect(viewCell(cell, untimed, T + 60 * MIN).state).toBe('waiting');
  });

  it('keeps waiting while a person has a form or a sign-in page open', () => {
    expect(
      viewCell(cell, results({ awaitingInput: true }), T + 30 * MIN).state
    ).toBe('waiting');
    const authorize: ConformanceCheck = {
      id: 'authorization-request',
      name: 'AuthorizationRequest',
      description: 'Client made authorization request',
      status: 'SUCCESS',
      timestamp: at
    };
    const signingIn = results();
    signingIn.checks = [...signingIn.checks, authorize];
    expect(viewCell(cell, signingIn, T + 30 * MIN).state).toBe('waiting');
    // Once the token was asked for the sign-in is over: quiet means stopped.
    signingIn.checks = [
      ...signingIn.checks,
      { ...authorize, id: 'token-request', name: 'TokenRequest' }
    ];
    expect(viewCell(cell, signingIn, T + 30 * MIN).state).toBe('stopped');
  });

  it("says so in the report, its groups and its Markdown, at the report's clock", async () => {
    const id = `r/${rev}/tools_call`;
    const report = await buildReport(buildMatrix(), 'r', rev, {
      listCells: async () => [
        { runId: 'r', revision: rev, scenarioName: 'tools_call' }
      ],
      results: async (x) => (x === id ? results() : undefined),
      resultsUrl: (ref) => `http://x/results/${cellId(ref)}`,
      now: () => T + 5 * MIN
    });
    const col = report.columns[0];
    const note =
      'stopped: no request from your client for 5 minutes; re-run it';
    expect(col.cells.find((c) => c.scenario === 'tools_call')).toMatchObject({
      state: 'stopped',
      verdict: 'incomplete',
      note
    });
    expect(col.counts.stopped).toBe(1);
    expect(groupColumn(col).problems.map((c) => c.scenario)).toContain(
      'tools_call'
    );
    expect(reportMarkdown(report, { live: 'http://x/results/r' })).toContain(
      note
    );
  });
});

describe('passed counts', () => {
  const logRow = (id: string): ConformanceCheck => ({
    id,
    name: id,
    description: `${id} for POST /mcp`,
    status: 'INFO',
    timestamp: new Date().toISOString(),
    details: { method: 'POST', path: '/mcp' }
  });

  it('count only SUCCESS checks: request and response log rows count toward nothing', () => {
    const rows = shownChecks('tools_call', '2026-07-28', [
      logRow('incoming-request'),
      logRow('outgoing-response'),
      identityCheck(identityOf({ name: 'c1', protocolVersion: '2026-07-28' })),
      check('SUCCESS')
    ]);
    expect(summarize(rows)).toMatchObject({ passed: 1, failed: 0, info: 3 });
  });

  it('a client that never listed the tools earns no passes on the invalid-tool cell', () => {
    // The cell a refused legacy initialize reached: nothing listed, nothing
    // called. Its MUST NOT checks are not exercised, not passed.
    const judged = finalizeChecks(
      'http-invalid-tool-headers',
      [],
      '2026-07-28'
    );
    const summary = summarize(
      shownChecks('http-invalid-tool-headers', '2026-07-28', judged)
    );
    expect(summary.passed).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.skipped).toBeGreaterThan(0);
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
    // Nothing the client did failed: incomplete, not fail.
    expect(by('tools_call')).toMatchObject({
      verdict: 'incomplete',
      state: 'waiting',
      note: 'waiting for the client or the person to finish the flow',
      summary: { failed: 0, notSeen: 1 }
    });
    expect(by('initialize')).toMatchObject({ verdict: 'fail', state: 'fail' });
    // The JSON gives a not-seen finding as NOT_SEEN and leaves the client's
    // FAILURE; the report the HTML and Markdown are built from is untouched.
    const before = JSON.stringify(report);
    const markdown = reportMarkdown(report, { live: '' });
    const json = reportJson(report);
    expect(JSON.stringify(report)).toBe(before);
    expect(reportMarkdown(report, { live: '' })).toBe(markdown);
    expect(markdown).not.toContain('NOT_SEEN');
    const jsonBy = (name: string) =>
      json.columns[0].cells.find((c) => c.scenario === name)!;
    expect(by('tools_call').findings).toEqual([
      expect.objectContaining({ status: 'FAILURE', by: 'scenario' })
    ]);
    expect(jsonBy('tools_call').findings).toEqual([
      expect.objectContaining({ status: 'NOT_SEEN', by: 'scenario' })
    ]);
    expect(jsonBy('tools_call').summary).toEqual(by('tools_call').summary);
    expect(jsonBy('initialize').findings).toContainEqual(
      expect.objectContaining({ status: 'FAILURE', by: 'client' })
    );
    expect(
      jsonBy('initialize').findings!.filter((f) => f.by === 'scenario')
    ).toEqual(
      by('initialize')
        .findings!.filter((f) => f.by === 'scenario')
        .map((f) => ({ ...f, status: 'NOT_SEEN' }))
    );
    // What a waiting cell waits for is on its row, not a cause: only the
    // client's own failure (and what initialize still expects) are causes.
    expect(report.causes.flatMap((c) => c.cells)).not.toContain(
      `${rev}/tools_call`
    );
    expect(report.causes.some((c) => c.by === 'client')).toBe(true);
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
    // Request logs (INFO) around them never count as passes.
    const again = [
      check('INFO'),
      check('SUCCESS'),
      check('INFO'),
      check('SUCCESS'),
      check('SUCCESS')
    ];
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
    expect(cell.summary).toMatchObject({ passed: 1, failed: 0 });
    expect(cell.summary!.info).toBeGreaterThan(0);
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
