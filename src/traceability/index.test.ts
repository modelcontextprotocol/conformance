import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  collectScenarioBaselines,
  computeTraceability,
  DeclaredSep,
  scenarioKeyForResultDir
} from './index';

const decl = (
  sep: number,
  requirements: DeclaredSep['requirements'],
  yaml = `src/seps/sep-${sep}.yaml`,
  specUrl: string | null = `https://modelcontextprotocol.io/sep-${sep}`
): DeclaredSep => ({ sep, yaml, specUrl, requirements });

describe('computeTraceability', () => {
  it('marks a declared check tested when its ID was emitted', () => {
    const m = computeTraceability({
      declared: [decl(2164, [{ check: 'sep-2164-error-code', text: 'x' }])],
      emitted: new Set(['sep-2164-error-code'])
    });
    expect(m.seps['2164'].requirements[0]).toEqual({
      check: 'sep-2164-error-code',
      text: 'x',
      status: 'tested'
    });
    expect(m.seps['2164'].summary.tested).toBe(1);
  });

  it('marks a declared check untested when its ID was not emitted', () => {
    const m = computeTraceability({
      declared: [decl(2164, [{ check: 'sep-2164-missing' }])],
      emitted: new Set()
    });
    expect(m.seps['2164'].requirements[0].status).toBe('untested');
    expect(m.seps['2164'].summary.untested).toBe(1);
  });

  it('propagates text, url, and issue onto requirement rows', () => {
    const m = computeTraceability({
      declared: [
        decl(2243, [
          {
            check: 'sep-2243-x',
            text: 'The client MUST do X',
            url: 'https://spec/x#y',
            issue: 'https://gh/1'
          }
        ])
      ],
      emitted: new Set(['sep-2243-x'])
    });
    expect(m.seps['2243'].requirements[0]).toEqual({
      check: 'sep-2243-x',
      text: 'The client MUST do X',
      url: 'https://spec/x#y',
      issue: 'https://gh/1',
      status: 'tested'
    });
  });

  it('collects excluded rows with reasons and issue links', () => {
    const m = computeTraceability({
      declared: [
        decl(2243, [
          {
            text: 'intermediary rule',
            excluded: 'not tested',
            issue: 'https://x/1'
          }
        ])
      ],
      emitted: new Set()
    });
    expect(m.seps['2243'].excluded).toEqual([
      { text: 'intermediary rule', reason: 'not tested', issue: 'https://x/1' }
    ]);
    expect(m.seps['2243'].requirements).toEqual([]);
  });

  it('lists rows with neither check nor excluded as unkeyed', () => {
    const m = computeTraceability({
      declared: [decl(2243, [{ text: 'orphan row' }])],
      emitted: new Set()
    });
    expect(m.seps['2243'].unkeyed).toEqual([{ text: 'orphan row' }]);
    expect(m.seps['2243'].summary.unkeyed).toBe(1);
  });

  it('reports emitted IDs with no yaml row as untracked', () => {
    const m = computeTraceability({
      declared: [decl(2164, [{ check: 'sep-2164-error-code' }])],
      emitted: new Set(['sep-2164-error-code', 'sep-2164-extra-check'])
    });
    expect(m.seps['2164'].untracked).toEqual(['sep-2164-extra-check']);
  });

  it('includes SEPs with emitted IDs but no yaml (tests without traceability)', () => {
    const m = computeTraceability({
      declared: [],
      emitted: new Set(['sep-2207-offline-access-requested'])
    });
    expect(m.seps['2207'].yaml).toBeNull();
    expect(m.seps['2207'].requirements).toEqual([]);
    expect(m.seps['2207'].untracked).toEqual([
      'sep-2207-offline-access-requested'
    ]);
  });

  it('sorts SEP keys numerically and stamps schema/meaning/source', () => {
    const m = computeTraceability({
      declared: [
        decl(2243, [{ check: 'sep-2243-a' }]),
        decl(414, [{ check: 'sep-414-a' }])
      ],
      emitted: new Set(),
      source: 'typescript-sdk@abc123'
    });
    expect(Object.keys(m.seps)).toEqual(['414', '2243']);
    expect(m.schemaVersion).toBe(1);
    expect(m.docs).toMatch(/^https?:\/\//);
    expect(m.source).toBe('typescript-sdk@abc123');
  });

  it('defaults source to null', () => {
    const m = computeTraceability({ declared: [], emitted: new Set() });
    expect(m.source).toBeNull();
  });
});

describe('scenario baselines', () => {
  const client = new Set(['initialize', 'auth/dpop', 'server-ish']);
  const server = new Set(['tools-list', 'server-stateless']);

  it('maps result dirs to scenario keys', () => {
    const ts = '-2026-11-13T20-00-00-000Z';
    expect(
      scenarioKeyForResultDir(`server-tools-list${ts}`, client, server)
    ).toBe('server:tools-list');
    expect(
      scenarioKeyForResultDir(`server-server-stateless${ts}`, client, server)
    ).toBe('server:server-stateless');
    expect(
      scenarioKeyForResultDir(path.join('auth', `dpop${ts}`), client, server)
    ).toBe('client:auth/dpop');
    // A client scenario whose name starts with server- is not a server run.
    expect(scenarioKeyForResultDir(`server-ish${ts}`, client, server)).toBe(
      'client:server-ish'
    );
    expect(
      scenarioKeyForResultDir(`authorization-server-x${ts}`, client, server)
    ).toBeNull();
  });

  it('collects counted check IDs per scenario from a results dir', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'trace-'));
    try {
      const write = (rel: string, checks: object[]) => {
        mkdirSync(path.join(dir, rel), { recursive: true });
        writeFileSync(
          path.join(dir, rel, 'checks.json'),
          JSON.stringify(checks)
        );
      };
      write('server-tools-list-2026-11-13T20-00-00-000Z', [
        { id: 'tools-list', status: 'SUCCESS' },
        { id: 'incoming-request', status: 'INFO' },
        { id: 'wire-schema-valid', status: 'SUCCESS' }
      ]);
      write(path.join('auth', 'dpop-2026-11-13T20-00-00-000Z'), [
        { id: 'sep-1932-proof', status: 'FAILURE' },
        { id: 'sep-1932-skip', status: 'SKIPPED' }
      ]);
      const got = collectScenarioBaselines(dir, client, server);
      const m = computeTraceability({
        declared: [],
        emitted: new Set(),
        scenarios: got
      });
      expect(m.scenarios).toEqual({
        'client:auth/dpop': { expected: ['sep-1932-proof'] },
        'server:tools-list': { expected: ['tools-list', 'wire-schema-valid'] }
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits scenarios when none were collected', () => {
    const m = computeTraceability({ declared: [], emitted: new Set() });
    expect(m.scenarios).toBeUndefined();
  });
});
