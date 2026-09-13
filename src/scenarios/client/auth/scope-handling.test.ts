import { describe, it, expect } from 'vitest';
import { finalizeChecks } from '../../../hosted/session';

/**
 * The hosted server re-judges a merged log in a fresh instance that never
 * ran authHandlers(); the revision the cell ran at is all it is told.
 */
describe('auth/scope-step-up judged from a log alone', () => {
  const union = 'sep-2350-scope-union-on-reauth';

  it('keeps the 2026-07-28 union check when the client never authorized', () => {
    const judged = finalizeChecks('auth/scope-step-up', [], '2026-07-28');
    expect(judged.find((c) => c.id === union)).toMatchObject({
      status: 'FAILURE'
    });
  });

  it('has no union check at 2025-11-25', () => {
    const judged = finalizeChecks('auth/scope-step-up', [], '2025-11-25');
    expect(judged.some((c) => c.id === union)).toBe(false);
    expect(
      judged.find((c) => c.id === 'scope-step-up-escalation')
    ).toMatchObject({ status: 'FAILURE' });
  });
});
