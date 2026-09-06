import { collapseDuplicateChecks } from './collapse';
import type { ConformanceCheck, CheckStatus } from '../types';

/** Minimal check factory for the dedupe unit tests. */
function chk(id: string, status: CheckStatus, tag?: string): ConformanceCheck {
  return {
    id,
    name: id,
    description: tag ?? id,
    status,
    timestamp: '2026-07-06T00:00:00.000Z',
    specReferences: []
  };
}

describe('collapseDuplicateChecks', () => {
  it('collapses duplicate SUCCESS ids to a single entry', () => {
    const out = collapseDuplicateChecks([
      chk('token-request', 'SUCCESS'),
      chk('pkce-code-verifier-sent', 'SUCCESS'),
      chk('token-request', 'SUCCESS')
    ]);
    expect(out.map((c) => c.id)).toEqual([
      'pkce-code-verifier-sent',
      'token-request'
    ]);
  });

  it('never masks a FAILURE — keeps the failing occurrence over a later SUCCESS', () => {
    // The regression this guards: a client that fails a check on the challenged
    // POST but passes on the nonce retry must still be reported FAILURE.
    const out = collapseDuplicateChecks([
      chk('pkce-verifier-matches-challenge', 'FAILURE', 'first attempt'),
      chk('pkce-verifier-matches-challenge', 'SUCCESS', 'retry')
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe('FAILURE');
    expect(out[0].description).toBe('first attempt');
  });

  it('keeps the failing occurrence regardless of order (SUCCESS then FAILURE)', () => {
    const out = collapseDuplicateChecks([
      chk('token-request', 'SUCCESS'),
      chk('token-request', 'FAILURE', 'later failure')
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe('FAILURE');
    expect(out[0].description).toBe('later failure');
  });

  it('prefers WARNING over SUCCESS but FAILURE over WARNING', () => {
    expect(
      collapseDuplicateChecks([chk('x', 'SUCCESS'), chk('x', 'WARNING')])[0]
        .status
    ).toBe('WARNING');
    expect(
      collapseDuplicateChecks([chk('x', 'WARNING'), chk('x', 'FAILURE')])[0]
        .status
    ).toBe('FAILURE');
  });

  it('keeps every INFO log entry, even duplicates', () => {
    const out = collapseDuplicateChecks([
      chk('incoming-request', 'INFO'),
      chk('incoming-request', 'INFO'),
      chk('incoming-request', 'INFO')
    ]);
    expect(out).toHaveLength(3);
  });

  it('preserves order and leaves a duplicate-free list untouched', () => {
    const input = [
      chk('a', 'SUCCESS'),
      chk('b', 'FAILURE'),
      chk('incoming', 'INFO'),
      chk('c', 'SUCCESS')
    ];
    expect(collapseDuplicateChecks(input).map((c) => c.id)).toEqual([
      'a',
      'b',
      'incoming',
      'c'
    ]);
  });
});
