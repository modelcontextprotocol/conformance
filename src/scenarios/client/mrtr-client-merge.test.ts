import { describe, it, expect } from 'vitest';
import { finalizeChecks } from '../../hosted/session';
import type { ConformanceCheck } from '../../types';

const MRTR = 'sep-2322-client-request-state';
const REV = '2026-07-28';
const NO_STATE = 'sep-2322-client-no-state-omitted';

describe('MRTR judgement of a log merged from several processes', () => {
  const observed = (status: 'SUCCESS' | 'FAILURE'): ConformanceCheck => ({
    id: NO_STATE,
    name: 'MRTRClientNoStateOmitted',
    description: 'd',
    status,
    timestamp: '2026-09-13T23:17:40.000Z'
  });
  const judged = (log: ConformanceCheck[]) =>
    finalizeChecks(MRTR, log, REV).filter((c) => c.id === NO_STATE);

  it('never lets a "not observed" report outrank what another process saw', () => {
    // What getChecks() says of a check nothing has met yet, as if a judged
    // list had been persisted into a raw log.
    const reported = judged([])[0];
    expect(reported.status).toBe('FAILURE');
    const merged = judged([reported, observed('SUCCESS'), { ...reported }]);
    expect(merged.map((c) => c.status)).toEqual(['SUCCESS']);
  });

  it('still lets a FAILURE the client earned win over a SUCCESS', () => {
    expect(
      judged([observed('SUCCESS'), observed('FAILURE')]).map((c) => c.status)
    ).toEqual(['FAILURE']);
  });
});
