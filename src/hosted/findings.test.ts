import { beforeAll, describe, it, expect } from 'vitest';
import {
  findingsOf,
  groupCauses,
  legacyCauseKey,
  legacyCauseText,
  legacyStop,
  notSeenIn,
  oneLineReason
} from './findings';
import { finalizeChecks } from './session';
import { untestableCheck } from '../scenarios/untestable';
import { identityCheck, identityOf } from './identity';
import { getOnMcpCheck, legacyProbeCheck, wrongRevisionCheck } from './wire';
import type { ConformanceCheck } from '../types';
import { hostedScenarios } from './catalog';

// Judged without the HTTP layer, which loads the scenarios a request needs.
beforeAll(() => hostedScenarios.loadAll());

const check = (over: Partial<ConformanceCheck>): ConformanceCheck => ({
  id: 'c',
  name: 'Name',
  description: 'what the check is about',
  status: 'FAILURE',
  timestamp: new Date().toISOString(),
  ...over
});

const probe = (asked = '2025-11-25') =>
  legacyProbeCheck(
    '2026-07-28',
    asked,
    { status: 400, code: -32022, message: 'Unsupported protocol version' },
    asked
  );

describe('oneLineReason', () => {
  it('prefers errorMessage, then details.message, then the description', () => {
    expect(oneLineReason(check({ errorMessage: 'broke' }))).toBe('broke');
    expect(
      oneLineReason(check({ details: { message: 'Tool was not called' } }))
    ).toBe('Tool was not called');
    expect(
      oneLineReason(
        check({
          description:
            'Client used client_secret_post but server only supports client_secret_basic',
          details: {
            expectedAuthMethod: 'client_secret_basic',
            actualAuthMethod: 'client_secret_post'
          }
        })
      )
    ).toBe(
      'Client used client_secret_post but server only supports client_secret_basic'
    );
  });

  it('adds an expected/actual pair and a stop reason the text does not say', () => {
    expect(
      oneLineReason(
        check({
          description: 'Client SHOULD use a URL-based client ID',
          details: {
            expectedClientId: 'https://a.example/meta.json',
            actualClientId: 'plain-id'
          }
        })
      )
    ).toBe(
      'Client SHOULD use a URL-based client ID (expected https://a.example/meta.json, got plain-id)'
    );
    expect(
      oneLineReason(
        check({
          description: 'Client MUST reject a mismatched iss',
          details: { stopReason: 'transmitted-code-to-token-endpoint' }
        })
      )
    ).toBe(
      'Client MUST reject a mismatched iss (transmitted-code-to-token-endpoint)'
    );
  });

  it('says which method a requirement was missed on, but never splits a message', () => {
    expect(
      oneLineReason(
        check({
          description: 'Client populates _meta on every request',
          details: { method: 'tools/list' }
        })
      )
    ).toBe('Client populates _meta on every request (on tools/list)');
    expect(
      oneLineReason(
        check({ errorMessage: 'no header', details: { method: 'tools/list' } })
      )
    ).toBe('no header');
  });

  it('keeps to one line', () => {
    expect(oneLineReason(check({ errorMessage: 'a\n  b\tc' }))).toBe('a b c');
    const long = oneLineReason(check({ errorMessage: 'x'.repeat(500) }));
    expect(long).toHaveLength(240);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('legacyStop', () => {
  it('is a legacy initialize the client never followed at the served revision', () => {
    expect(legacyStop([probe()])).toEqual({
      asked: '2025-11-25',
      served: '2026-07-28',
      code: -32022,
      status: 400,
      fellBack: false
    });
    expect(legacyStop([probe(), getOnMcpCheck('2026-07-28')])).toMatchObject({
      fellBack: true
    });
    const retried = identityCheck(
      identityOf({ name: 'c', protocolVersion: '2026-07-28' })
    );
    expect(legacyStop([probe(), retried])).toBeUndefined();
    expect(legacyStop([check({})])).toBeUndefined();
  });

  it('says what the cell answered, preferring its version answer', () => {
    // An auth cell answers 401 before it looks at the protocol.
    const challenged = legacyProbeCheck(
      '2026-07-28',
      undefined,
      { status: 401 },
      '2025-11-25'
    );
    expect(challenged.description).toContain(
      'the cell answered HTTP 401, asking the client to sign in first'
    );
    const stop = legacyStop([challenged]);
    expect(stop).toMatchObject({ status: 401 });
    expect(stop?.code).toBeUndefined();
    expect(legacyCauseText([stop!])).toContain(
      'the cell asked it to sign in first (HTTP 401)'
    );
    expect(legacyCauseText([stop!])).not.toContain('accepted');
    // Two processes' notes: the one that drew the -32022 wins.
    expect(legacyStop([challenged, probe()])).toMatchObject({
      code: -32022,
      status: 400
    });
  });
});

describe('findingsOf', () => {
  // What tools_call reports when it has seen nothing: its own expectation.
  let waiting: ConformanceCheck;
  beforeAll(() => {
    waiting = finalizeChecks('tools_call', [], '2025-11-25').find(
      (c) => c.status === 'FAILURE'
    )!;
  });
  const wrong = wrongRevisionCheck(
    '2026-07-28',
    'tools/list',
    undefined,
    'sent no MCP-Protocol-Version header'
  );

  it("marks the scenario's unmet expectations apart from what the client did", () => {
    const findings = findingsOf(
      'tools_call',
      '2025-11-25',
      [waiting, wrong, { ...wrong }, check({ status: 'SUCCESS' })],
      undefined,
      true
    );
    expect(findings).toEqual([
      {
        status: 'FAILURE',
        check: waiting.id,
        reason: 'Tool was not called by client',
        by: 'scenario',
        cause: `check FAILURE ${waiting.id} Tool was not called by client`
      },
      {
        status: 'FAILURE',
        check: 'hosted-wrong-revision',
        reason:
          'cell is served on 2026-07-28; client sent no MCP-Protocol-Version header',
        by: 'client',
        cause:
          'check FAILURE hosted-wrong-revision cell is served on 2026-07-28; client sent no MCP-Protocol-Version header'
      }
    ]);
    // Not grouped: a cell still in progress lists what it waits for only.
    expect(
      findingsOf('tools_call', '2025-11-25', [waiting], undefined, false)
    ).toEqual([
      {
        status: 'FAILURE',
        check: waiting.id,
        reason: 'Tool was not called by client',
        by: 'scenario'
      }
    ]);
  });

  it('says a step the flow never reached in words, and a skipped parameter is the client’s once it was', () => {
    const scenario = 'auth/metadata-default';
    const unreached = finalizeChecks(scenario, [], '2025-11-25');
    const findings = findingsOf(
      scenario,
      '2025-11-25',
      unreached,
      undefined,
      false
    );
    expect(findings.every((f) => f.by === 'scenario')).toBe(true);
    expect(new Set(findings.map((f) => f.reason))).toEqual(
      new Set(['the flow did not reach this step'])
    );
    // The client reached /authorize and left the resource parameter out.
    const authorize = check({
      id: 'incoming-auth-request',
      status: 'INFO',
      details: { path: '/authorize', query: {} }
    });
    const reached = findingsOf(
      scenario,
      '2025-11-25',
      finalizeChecks(scenario, [authorize], '2025-11-25'),
      undefined,
      false
    );
    expect(
      reached.find((f) => f.check === 'resource-parameter-in-authorization')
    ).toMatchObject({ by: 'client' });
  });

  it('keys what the legacy handshake explains to that one cause', () => {
    const stop = legacyStop([probe()])!;
    const own = check({ id: 'sep-2468-client-compare-iss', errorMessage: 'x' });
    const eraRejected = check({
      id: 'stateless-request-rejected',
      errorMessage: 'Unsupported protocol version'
    });
    const findings = findingsOf(
      'tools_call',
      '2026-07-28',
      [probe(), eraRejected, own],
      stop,
      true
    );
    expect(findings.map((f) => [f.check, f.cause])).toEqual([
      ['stateless-request-rejected', legacyCauseKey(stop)],
      [
        'sep-2468-client-compare-iss',
        'check FAILURE sep-2468-client-compare-iss x'
      ]
    ]);
  });
});

describe('groupCauses', () => {
  it('says each cause once, with the cells it covers, client causes first', () => {
    const stop = legacyStop([probe()])!;
    const fellBack = legacyStop([probe(), getOnMcpCheck('2026-07-28')])!;
    const auth = {
      status: 'FAILURE' as const,
      check: 'token-endpoint-auth-method',
      reason: 'used client_secret_post',
      by: 'client' as const,
      cause: 'check FAILURE token-endpoint-auth-method used client_secret_post'
    };
    const waitingFinding = {
      status: 'FAILURE' as const,
      check: 'tool-add-numbers',
      reason: 'Tool was not called by client',
      by: 'scenario' as const,
      cause: 'check FAILURE tool-add-numbers Tool was not called by client'
    };
    const causes = groupCauses([
      { cell: '2025-11-25/tools_call', findings: [waitingFinding] },
      { cell: '2025-11-25/auth/a', findings: [auth] },
      { cell: '2026-07-28/auth/a', findings: [auth] },
      // Stopped before anything was tested: no finding of its own needed.
      {
        cell: '2026-07-28/tools_call',
        findings: [],
        stop,
        stoppedBy: legacyCauseKey(stop)
      },
      {
        cell: '2026-07-28/request-metadata',
        findings: [],
        stop: fellBack,
        stoppedBy: legacyCauseKey(fellBack)
      },
      {
        cell: '2026-07-28/auth/b',
        findings: [
          {
            status: 'FAILURE',
            check: 'stateless-request-rejected',
            reason: 'Unsupported protocol version',
            by: 'client',
            cause: legacyCauseKey(stop)
          }
        ],
        stop
      }
    ]);
    expect(causes).toEqual([
      {
        key: legacyCauseKey(stop),
        by: 'client',
        text:
          'The client spoke 2025-11-25 only: it opened with initialize, the cell answered -32022 ' +
          '(supported: 2026-07-28), and the client did not retry at 2026-07-28. On 1 of these ' +
          'cells it then sent GET, falling back to the old HTTP+SSE transport.',
        cells: [
          '2026-07-28/tools_call',
          '2026-07-28/request-metadata',
          '2026-07-28/auth/b'
        ]
      },
      {
        key: auth.cause,
        by: 'client',
        check: auth.check,
        text: auth.reason,
        cells: ['2025-11-25/auth/a', '2026-07-28/auth/a']
      },
      {
        key: waitingFinding.cause,
        by: 'scenario',
        check: waitingFinding.check,
        text: waitingFinding.reason,
        cells: ['2025-11-25/tools_call']
      }
    ]);
  });
});

describe('not seen', () => {
  it('counts a requirement the flow never reached as not seen, not the client’s', () => {
    // What the iss scenarios record when a client only fetched metadata.
    const unreached = untestableCheck(
      'sep-2468-client-rejects-missing-iss',
      'Name',
      'Client MUST reject an authorization response without iss',
      'client never reached the authorization endpoint, so it never received an authorization response to validate',
      []
    );
    const scenario = 'auth/iss-supported-missing';
    const notSeen = notSeenIn(scenario, '2026-07-28', [unreached]);
    expect(notSeen(unreached)).toBe(true);
    // A failure seen in the traffic stays the client's.
    expect(notSeen(check({ id: 'sep-2468-client-rejects-missing-iss' }))).toBe(
      false
    );
    expect(
      findingsOf(scenario, '2026-07-28', [unreached], undefined, true)
    ).toMatchObject([
      {
        by: 'scenario',
        reason: expect.stringContaining('Not testable: client never reached')
      }
    ]);
  });
});
