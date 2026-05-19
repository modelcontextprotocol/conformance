import { describe, it, expect } from 'vitest';
import { computeTraceability, DeclaredSep } from './index';

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
