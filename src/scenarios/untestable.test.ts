import { describe, it, expect } from 'vitest';
import { notTestable, untestableCheck } from './untestable';

describe('untestable helpers', () => {
  it('notTestable formats the stable prefix', () => {
    expect(notTestable('server lacks tool X')).toBe(
      'Not testable: server lacks tool X'
    );
  });

  it('untestableCheck defaults to FAILURE and marks details.untestable', () => {
    const check = untestableCheck(
      'some-check-id',
      'SomeCheck',
      'A MUST requirement',
      'server lacks the diagnostic tool',
      [{ id: 'SEP-0000', url: 'https://example.com' }]
    );
    expect(check).toMatchObject({
      id: 'some-check-id',
      status: 'FAILURE',
      errorMessage: 'Not testable: server lacks the diagnostic tool',
      details: { untestable: true }
    });
  });

  it('untestableCheck supports WARNING severity for SHOULD requirements', () => {
    const check = untestableCheck(
      'should-check-id',
      'ShouldCheck',
      'A SHOULD requirement',
      'missing hook',
      [{ id: 'SEP-0000', url: 'https://example.com' }],
      'WARNING'
    );
    expect(check.status).toBe('WARNING');
    expect(check.errorMessage).toBe('Not testable: missing hook');
  });
});
