import { beforeAll, describe, it, expect } from 'vitest';
import type { ConformanceCheck } from '../../../types';
import { finalizeChecks } from '../../../hosted/session';
import { hostedScenarios } from '../../../hosted/catalog';

// Judged without the HTTP layer, which loads the scenarios a request needs.
beforeAll(() => hostedScenarios.loadAll());

const NAME = 'auth/authorization-server-migration';
const REUSE_IDS = [
  'sep-2352-no-reuse-on-as-change',
  'sep-2352-no-cross-as-credential-reuse'
];

const atNewAs = (
  endpoint: 'register' | 'authorize' | 'token',
  clientId?: string
): ConformanceCheck => ({
  id: 'new-authorization-server-request',
  name: 'NewAuthorizationServerRequest',
  description: `Request to the new authorization server's ${endpoint} endpoint`,
  status: 'INFO',
  timestamp: '2026-01-01T00:00:00.000Z',
  details: { endpoint, ...(clientId && { clientId }) }
});

const statusOf = (checks: ConformanceCheck[], id: string) =>
  checks.find((c) => c.id === id)?.status;

describe('auth/authorization-server-migration no-reuse checks', () => {
  it('are not passed when the client never reached the new AS', () => {
    const judged = finalizeChecks(NAME, []);
    expect(statusOf(judged, 'sep-2352-reregister-on-as-change')).toBe(
      'FAILURE'
    );
    for (const id of REUSE_IDS) {
      expect(statusOf(judged, id), id).toBe('SKIPPED');
      expect(judged.find((c) => c.id === id)?.errorMessage).toMatch(
        /^Not exercised/
      );
    }
  });

  it('pass once the client presented fresh credentials at the new AS', () => {
    const judged = finalizeChecks(NAME, [
      atNewAs('register'),
      atNewAs('authorize', 'fresh-client')
    ]);
    for (const id of REUSE_IDS)
      expect(statusOf(judged, id), id).toBe('SUCCESS');
  });
});
