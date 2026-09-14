import { describe, it, expect } from 'vitest';
import {
  mdCode,
  mdText,
  NOT_TRIED_WHY,
  reportMarkdown,
  reportText,
  UNAVAILABLE_WHY,
  utcMinute
} from './markdown';
import type { CellReport, RunReport } from './report';

const cell = (over: Partial<CellReport>): CellReport => ({
  scenario: 'tools_call',
  revision: '2025-11-25',
  scoring: 'scored',
  startable: true,
  verdict: 'pass',
  state: 'pass',
  resultsUrl: 'http://x/results/r/2025-11-25/tools_call',
  ...over
});

/** A startable cell nothing reached, as served (withNotTriedHints()). */
const notTried = cell({
  scenario: 'initialize',
  verdict: 'incomplete',
  state: 'not-tried',
  resultsUrl: 'http://x/results/r/2025-11-25/initialize',
  mcpUrl: 'http://x/s/r/2025-11-25/initialize/mcp',
  hint: 'connect, then list the tools'
});

/** A cell this deployment cannot start. */
const unavailable = cell({
  scenario: 'sse-retry',
  verdict: 'incomplete',
  state: 'not-startable',
  startable: false,
  startReason: 'needs a single-process host',
  resultsUrl: 'http://x/results/r/2025-11-25/sse-retry'
});

const report = (cells: CellReport[], over: Partial<RunReport> = {}) =>
  ({
    runId: 'r',
    generatedAt: '2026-09-13T21:47:05.123Z',
    columns: [
      {
        revision: '2025-11-25',
        scored: { passed: 1, total: 18, startable: 15 },
        cells,
        notScored: [],
        counts: { pass: 1, fail: 1, 'not-tried': 12 },
        identities: []
      }
    ],
    identities: [
      { name: 'VS Code', version: '1.137', protocolVersions: ['2025-11-25'] }
    ],
    causes: [],
    ...over
  }) as RunReport;

const LEGEND =
  '"client" failures were seen in the client’s traffic; "not seen" ones are the scenario’s own expectations that nothing has met yet.';

describe('markdown escaping', () => {
  it('keeps traffic-derived text from opening markup or a table cell', () => {
    expect(mdText('a <script>x</script> [l](u) *b* `c` d|e\\f\n g')).toBe(
      'a \\<script\\>x\\</script\\> \\[l\\](u) \\*b\\* \\`c\\` d\\|e\\\\f g'
    );
    expect(mdCode('id`x|y')).toBe('`id x\\|y`');
    expect(utcMinute('2026-09-13T21:47:05.123Z')).toBe('2026-09-13 21:47 UTC');
  });
});

describe('reportMarkdown', () => {
  it('lists each revision as fail, then not tried, then passes, with unavailable cells once at the bottom', () => {
    const md = reportMarkdown(
      report(
        [
          cell({
            summary: {
              passed: 17,
              failed: 0,
              notSeen: 0,
              warnings: 0,
              info: 1,
              skipped: 0,
              total: 18
            }
          }),
          notTried,
          unavailable,
          cell({
            scenario: 'auth/token-endpoint-auth-basic',
            verdict: 'fail',
            state: 'fail',
            summary: {
              passed: 16,
              failed: 1,
              notSeen: 0,
              warnings: 0,
              info: 0,
              skipped: 0,
              total: 17
            },
            findings: [
              {
                status: 'FAILURE',
                check: 'token-endpoint-auth-method',
                reason: 'Client used client_secret_post | <b>',
                by: 'client',
                cause: 'k'
              }
            ]
          })
        ],
        {
          causes: [
            {
              key: 'k',
              by: 'client',
              check: 'token-endpoint-auth-method',
              text: 'Client used client_secret_post | <b>',
              cells: ['2025-11-25/auth/token-endpoint-auth-basic']
            }
          ]
        }
      ),
      { live: 'http://x/results/r' }
    );
    expect(md).toBe(
      [
        '**MCP conformance: run `r`**',
        '',
        '- As of 2026-09-13 21:47 UTC: http://x/results/r',
        '- Client: VS Code 1.137 (protocol 2025-11-25)',
        // The score and the counts are as they were.
        '- 2025-11-25: 1 of 18 scored cells pass (15 startable here). Reached: 1 pass, 1 fail; 12 not tried.',
        '',
        '**What went wrong, by cause**',
        '1. Client: `token-endpoint-auth-method` Client used client_secret_post \\| \\<b\\> (2025-11-25/auth/token-endpoint-auth-basic)',
        '',
        '**2025-11-25**',
        '',
        '| Cell | Result | Pass / fail / warn | What happened |',
        '| --- | --- | --- | --- |',
        '| [2025-11-25 auth/token-endpoint-auth-basic](http://x/results/r/2025-11-25/tools_call) | fail | 16 / 1 / 0 | ' +
          'client: `token-endpoint-auth-method` Client used client_secret_post \\| \\<b\\> |',
        `| **Not tried yet (1): your client never connected to these** | | | ${NOT_TRIED_WHY} |`,
        '| [2025-11-25 initialize](http://x/results/r/2025-11-25/initialize) | not tried | – | ' +
          'MCP URL `http://x/s/r/2025-11-25/initialize/mcp`; the client must connect, then list the tools |',
        '| **Passed (1)** | | | |',
        '| [2025-11-25 tools_call](http://x/results/r/2025-11-25/tools_call) | pass | 17 / 0 / 0 | no failures or warnings |',
        '',
        LEGEND,
        '',
        '**Unavailable on this deployment (1)**',
        UNAVAILABLE_WHY,
        '- `sse-retry` (2025-11-25): needs a single-process host',
        ''
      ].join('\n')
    );
    expect(NOT_TRIED_WHY).toMatch(/not given the cell’s URL/);
    expect(NOT_TRIED_WHY).toMatch(/does not support/);
    expect(NOT_TRIED_WHY).toMatch(/auth cell, which needs a URL of its own/);
  });

  it('says in one line that a revision had nothing reached, and names an unavailable scenario once for all its revisions', () => {
    const later = (over: Partial<CellReport>) =>
      cell({
        revision: '2026-07-28',
        resultsUrl: 'http://x/results/r/2026-07-28/tools_call',
        ...over
      });
    const md = reportMarkdown(
      {
        ...report([
          cell({}),
          { ...unavailable, scenario: 'tools_x', startReason: 'excluded' }
        ]),
        columns: [
          report([
            cell({}),
            { ...unavailable, scenario: 'tools_x', startReason: 'excluded' }
          ]).columns[0],
          {
            revision: '2026-07-28',
            scored: { passed: 0, total: 20, startable: 12 },
            cells: [
              later({ verdict: 'incomplete', state: 'not-tried' }),
              later({
                scenario: 'ping',
                verdict: 'incomplete',
                state: 'not-tried'
              }),
              later({
                scenario: 'tools_x',
                verdict: 'incomplete',
                state: 'not-startable',
                startable: false,
                startReason: 'excluded'
              })
            ],
            notScored: [],
            counts: { 'not-tried': 2, 'not-startable': 1 },
            identities: []
          }
        ]
      },
      { live: 'http://x/results/r' }
    );
    expect(md).toContain(
      '- 2026-07-28: 0 of 20 scored cells pass (12 startable here). Reached: none; 2 not tried.'
    );
    expect(md).toContain(
      '\n**2026-07-28** — Not tried yet (2): your client never connected to any cell at this revision.\n'
    );
    expect(md).not.toContain('2026-07-28 ping');
    expect(md).toContain(
      '**Unavailable on this deployment (1)**\n' +
        `${UNAVAILABLE_WHY}\n` +
        '- `tools_x` (2025-11-25, 2026-07-28): excluded\n'
    );
    // Only in the bottom section, never in a revision's table.
    expect(md.match(/tools_x/g)).toHaveLength(1);
  });

  it('points a frozen copy at itself and at the live report', () => {
    const md = reportMarkdown(
      report([], { snapshotId: 's1', frozenAt: '2026-09-13T22:00:00.000Z' }),
      { live: 'http://x/results/r', snapshot: 'http://x/results/r/snapshot/s1' }
    );
    expect(md).toContain(
      'Frozen 2026-09-13 22:00 UTC: http://x/results/r/snapshot/s1 (live report: http://x/results/r)'
    );
    expect(md).toContain('No cell has been reached yet.');
  });
});

describe('reportText', () => {
  it('says the same as plain lines a chat without tables can show', () => {
    const text = reportText(
      report(
        [
          cell({}),
          notTried,
          unavailable,
          cell({
            scenario: 'auth/metadata-default',
            verdict: 'fail',
            state: 'waiting',
            note: 'waiting for the client or the person to finish the flow',
            summary: {
              passed: 1,
              failed: 0,
              notSeen: 2,
              warnings: 0,
              info: 3,
              skipped: 0,
              total: 6
            },
            findings: [
              {
                status: 'FAILURE',
                check: 'client-registration',
                reason: 'the flow did not reach this step',
                by: 'scenario'
              },
              {
                status: 'FAILURE',
                check: 'token-request',
                reason: 'the flow did not reach this step',
                by: 'scenario'
              }
            ]
          })
        ],
        {
          causes: [
            {
              key: 'k',
              by: 'client',
              check: 'c',
              text: 'a | <b>',
              cells: ['2025-11-25/tools_call']
            }
          ]
        }
      ),
      { live: 'http://x/results/r' }
    );
    expect(text).toBe(
      [
        'MCP conformance: run r',
        '• As of 2026-09-13 21:47 UTC: http://x/results/r',
        '• Client: VS Code 1.137 (protocol 2025-11-25)',
        '• 2025-11-25: 1 of 18 scored cells pass (15 startable here). Reached: 1 pass, 1 fail; 12 not tried.',
        '',
        'What went wrong, by cause',
        '1. Client: `c` a | <b> (2025-11-25/tools_call)',
        '',
        '2025-11-25 (pass / fail / warn)',
        '• 2025-11-25 auth/metadata-default: waiting, 1 / 0 / 0 — http://x/results/r/2025-11-25/tools_call',
        '    ◦ waiting for the client or the person to finish the flow; not seen yet: the flow has not reached `client-registration`, `token-request`',
        'Not tried yet (1): your client never connected to these',
        NOT_TRIED_WHY,
        '• 2025-11-25 initialize: not tried — http://x/results/r/2025-11-25/initialize',
        '    ◦ MCP URL `http://x/s/r/2025-11-25/initialize/mcp`; the client must connect, then list the tools',
        'Passed (1)',
        '• 2025-11-25 tools_call: pass, – — http://x/results/r/2025-11-25/tools_call',
        '    ◦ no failures or warnings',
        '',
        LEGEND,
        '',
        'Unavailable on this deployment (1)',
        UNAVAILABLE_WHY,
        '• `sse-retry` (2025-11-25): needs a single-process host',
        ''
      ].join('\n')
    );
    expect(text).not.toContain('| --- |');
  });
});
