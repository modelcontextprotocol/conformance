import { describe, it, expect } from 'vitest';
import { shownChecks } from './shown';
import type { ConformanceCheck } from '../types';

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
    const shown = shownChecks(log);
    const rows = shown.filter((c) => c.id === 'prm-pathbased-requested');
    // The latest of equal rows stands for all of them.
    expect(rows).toEqual([
      expect.objectContaining({ details: { n: 3 }, repeats: 3 })
    ]);
    // Request logs are kept, each one.
    expect(shown.filter((c) => c.status === 'INFO')).toHaveLength(2);
  });

  it('keeps the worst of a repeated check, so a failure is never hidden', () => {
    const token = (status: ConformanceCheck['status']) =>
      check({ id: 'token-request', description: 'Token request', status });
    const shown = shownChecks([
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
    const shown = shownChecks([
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
      shownChecks([wrong('tools/list'), wrong('tools/call')])
    ).toHaveLength(2);
  });
});
