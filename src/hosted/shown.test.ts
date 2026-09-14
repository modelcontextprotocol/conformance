import { beforeAll, describe, it, expect } from 'vitest';
import { jsonRows, shownChecks } from './shown';
import { summarize } from './report';
import { finalizeChecks } from './session';
import type { ConformanceCheck } from '../types';
import { hostedScenarios } from './catalog';

// Judged without the HTTP layer, which loads the scenarios a request needs.
beforeAll(() => hostedScenarios.loadAll());

const S = 'tools_call';
const R = '2025-11-25';

let clock = 0;
const check = (over: Partial<ConformanceCheck>): ConformanceCheck => ({
  id: 'c',
  name: 'Name',
  description: 'what the check is about',
  status: 'SUCCESS',
  timestamp: new Date(Date.UTC(2026, 8, 13, 0, 0, clock++)).toISOString(),
  ...over
});

describe('shownChecks: one row per check', () => {
  it('folds a check recorded again into one row that says how often', () => {
    const prm = (n: number) =>
      check({
        id: 'prm-pathbased-requested',
        description: 'Client requested PRM metadata at path-based location',
        details: { n }
      });
    const log = [
      check({ id: 'incoming-request', status: 'INFO' }),
      prm(1),
      check({ id: 'incoming-request', status: 'INFO' }),
      prm(2),
      prm(3)
    ];
    const shown = shownChecks(S, R, log);
    const rows = shown.filter((c) => c.id === 'prm-pathbased-requested');
    // The latest of equal rows stands for all of them.
    expect(rows).toEqual([
      expect.objectContaining({ details: { n: 3 }, repeats: 3 })
    ]);
    // Request logs are kept, each one.
    expect(shown.filter((c) => c.status === 'INFO')).toHaveLength(2);
  });

  it('does not count one record persisted twice as a repeat', () => {
    const once = check({ id: 'valid-bearer-token', description: 'Bearer' });
    const shown = shownChecks(S, R, [once, { ...once }, { ...once }]);
    expect(shown).toHaveLength(1);
    expect(shown[0].repeats).toBeUndefined();
  });

  it('keeps the worst of a repeated check, so a failure is never hidden', () => {
    const token = (status: ConformanceCheck['status']) =>
      check({ id: 'token-request', description: 'Token request', status });
    const shown = shownChecks(S, R, [
      token('SUCCESS'),
      token('FAILURE'),
      token('SUCCESS')
    ]);
    expect(shown).toEqual([
      expect.objectContaining({ status: 'FAILURE', repeats: 3 })
    ]);
  });

  it('keeps checks that share an id but check different things apart', () => {
    const header = (method: string, status: ConformanceCheck['status']) =>
      check({
        id: 'sep-2243-client-includes-standard-headers',
        description: `Client sends correct Mcp-Method header on ${method} request`,
        status
      });
    const shown = shownChecks(S, R, [
      header('tools/list', 'SUCCESS'),
      header('tools/call', 'SUCCESS'),
      header('prompts/list', 'SKIPPED')
    ]);
    expect(shown).toHaveLength(3);
    expect(shown.some((c) => c.repeats)).toBe(false);
    // One wording, judged per method: a row per method.
    const wrong = (method: string) =>
      check({
        id: 'hosted-wrong-revision',
        status: 'FAILURE',
        details: { method }
      });
    expect(
      shownChecks(S, R, [wrong('tools/list'), wrong('tools/call')])
    ).toHaveLength(2);
  });
});

describe('shownChecks: skipped rows', () => {
  it('always say why they were skipped', () => {
    const [said, unsaid] = shownChecks('http-standard-headers', '2026-07-28', [
      check({
        id: 'a',
        status: 'SKIPPED',
        errorMessage: 'Client did not send a prompts/list request',
        details: null as unknown as undefined
      }),
      check({
        id: 'b',
        status: 'SKIPPED',
        details: null as unknown as undefined
      })
    ]);
    expect(said).toMatchObject({
      reason: 'Client did not send a prompts/list request'
    });
    expect(unsaid.reason).toBe(
      'skipped: the client did nothing this check covers'
    );
    expect('details' in unsaid).toBe(false);
  });
});

describe('shownChecks: steps the flow never reached', () => {
  const AUTH = 'auth/metadata-default';
  // What a client that fetched the metadata and stopped leaves behind.
  const stuck = (extra: ConformanceCheck[] = []) =>
    finalizeChecks(
      AUTH,
      [
        check({
          id: 'prm-pathbased-requested',
          description: 'Client requested PRM metadata at path-based location',
          details: { path: '/.well-known/oauth-protected-resource/mcp' }
        }),
        ...extra
      ],
      R
    ).map((c) => ({ ...c, details: c.details ?? null }) as ConformanceCheck);

  it('marks them not seen, says so in words and never shows null details', () => {
    const shown = shownChecks(AUTH, R, stuck());
    const failures = shown.filter((c) => c.status === 'FAILURE');
    expect(failures.map((c) => c.id)).toEqual([
      'authorization-server-metadata',
      'client-registration',
      'authorization-request',
      'token-request',
      'resource-parameter-in-authorization',
      'resource-parameter-in-token'
    ]);
    for (const c of failures) {
      expect(c).toMatchObject({
        notSeen: true,
        reason: 'the flow did not reach this step'
      });
    }
    expect(shown.some((c) => 'details' in c && c.details == null)).toBe(false);
    expect(JSON.stringify(shown)).not.toContain('null');
  });

  it("keeps the scenario's own words when it gives some", () => {
    const [tool] = shownChecks(S, R, finalizeChecks(S, [], R));
    expect(tool).toMatchObject({
      notSeen: true,
      reason: 'Tool was not called by client'
    });
  });

  it("calls a missing resource parameter the client's once the step was reached", () => {
    const authorize = check({
      id: 'incoming-auth-request',
      status: 'INFO',
      details: { path: '/authorize', query: {} }
    });
    const shown = shownChecks(AUTH, R, stuck([authorize]));
    const resource = shown.find(
      (c) => c.id === 'resource-parameter-in-authorization'
    )!;
    expect(resource.status).toBe('FAILURE');
    expect(resource.notSeen).toBeUndefined();
    expect(resource.reason).toMatch(/resource parameter/);
    // The token step was still never reached.
    expect(
      shown.find((c) => c.id === 'resource-parameter-in-token')!.notSeen
    ).toBe(true);
  });

  it('gives them as NOT_SEEN in the JSON, so the rows count as the summary does', () => {
    const authorize = check({
      id: 'incoming-auth-request',
      status: 'INFO',
      details: { path: '/authorize', query: {} }
    });
    const shown = shownChecks(AUTH, R, stuck([authorize]));
    const rows = jsonRows(shown);
    const status = (id: string) => rows.find((c) => c.id === id)!.status;
    // The client's own failure stays a FAILURE; the step never reached
    // reads NOT_SEEN and keeps notSeen.
    expect(status('resource-parameter-in-authorization')).toBe('FAILURE');
    expect(status('resource-parameter-in-token')).toBe('NOT_SEEN');
    for (const c of rows.filter((r) => r.status === 'NOT_SEEN')) {
      expect(c.notSeen).toBe(true);
    }
    // Presentation only: the rows given in, and their counts, are unchanged.
    expect(
      shown.filter((c) => c.notSeen).every((c) => c.status === 'FAILURE')
    ).toBe(true);
    const count = (s: string) => rows.filter((c) => c.status === s).length;
    expect({
      passed: count('SUCCESS'),
      failed: count('FAILURE'),
      notSeen: count('NOT_SEEN'),
      warnings: count('WARNING'),
      info: count('INFO'),
      skipped: count('SKIPPED'),
      total: rows.length
    }).toEqual(summarize(shown));
  });
});
