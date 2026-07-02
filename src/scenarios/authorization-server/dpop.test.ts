import { describe, it, expect } from 'vitest';
import {
  createAuthServer,
  type AuthServerOptions
} from '../client/auth/helpers/createAuthServer';
import { ServerLifecycle } from '../client/auth/helpers/serverLifecycle';
import { testScenarioContext } from '../../mock-server/testing';
import type { CheckStatus, ConformanceCheck } from '../../types';
import { DPoPAuthorizationServerScenario } from './dpop';

const ALL_IDS = [
  'sep-1932-as-metadata-alg-values',
  'sep-1932-as-no-none-alg',
  'sep-1932-as-token-binding'
] as const;

const statusOf = (
  checks: ConformanceCheck[],
  id: string
): CheckStatus | undefined => checks.find((c) => c.id === id)?.status;

/**
 * Start an in-process test AS (real Express app, no mocks) with the given DPoP
 * options, run the scenario against its live URL, and return the emitted checks.
 * The AS 302s straight to the redirect_uri, so the scenario auto-follows headless.
 */
async function runAgainst(
  dpopOptions: Partial<AuthServerOptions>,
  // `false` means "send no client_id" — a plain `undefined` would re-trigger the
  // default via JS default-parameter semantics.
  clientId: string | false = 'test-client-id'
): Promise<ConformanceCheck[]> {
  const lifecycle = new ServerLifecycle();
  const app = createAuthServer(testScenarioContext(), [], lifecycle.getUrl, {
    loggingEnabled: false,
    grantTypesSupported: ['authorization_code', 'refresh_token'],
    ...dpopOptions
  });
  await lifecycle.start(app);
  try {
    return await new DPoPAuthorizationServerScenario().run(
      { url: lifecycle.getUrl(), port: 45678, clientId: clientId || undefined },
      {}
    );
  } finally {
    await lifecycle.stop();
  }
}

// A DPoP-capable AS: advertises an asymmetric alg and issues bound tokens.
// (`dpop_bound_access_tokens` is per-client registration metadata, RFC 9449
// §5.2 — not an AS option — so it is deliberately not set here.)
const COMPLIANT: Partial<AuthServerOptions> = {
  dpopSigningAlgValuesSupported: ['ES256']
};

describe('DPoPAuthorizationServerScenario — compliant AS', () => {
  it('emits all three sep-1932-as-* checks as SUCCESS', async () => {
    const checks = await runAgainst(COMPLIANT);
    for (const id of ALL_IDS) {
      expect(statusOf(checks, id)).toBe('SUCCESS');
    }
    expect(checks.filter((c) => c.status === 'FAILURE')).toHaveLength(0);
  });

  it('binds the issued token to the presented proof key (cnf.jkt matches)', async () => {
    const checks = await runAgainst(COMPLIANT);
    const binding = checks.find((c) => c.id === 'sep-1932-as-token-binding');
    expect(binding?.status).toBe('SUCCESS');
    const details = binding?.details as {
      tokenType: string;
      cnfJkt: string;
      expectedJkt: string;
    };
    expect(details.tokenType).toBe('DPoP');
    expect(details.cnfJkt).toBe(details.expectedJkt);
  });
});

// Isolation matrix: each defect fails EXACTLY its target check, the rest stay
// SUCCESS. (`omit-alg-values` is not here — dropping the field means "not a DPoP
// AS", which SKIPs the whole scenario; see the support-gate tests below.)
describe('DPoPAuthorizationServerScenario — one-defect isolation', () => {
  const CASES = [
    {
      misbehavior: 'empty-alg-values',
      target: 'sep-1932-as-metadata-alg-values'
    },
    { misbehavior: 'include-none', target: 'sep-1932-as-no-none-alg' },
    { misbehavior: 'unbound-token', target: 'sep-1932-as-token-binding' }
  ] as const;

  for (const { misbehavior, target } of CASES) {
    it(`misbehaving AS (${misbehavior}) fails only ${target}`, async () => {
      const checks = await runAgainst({
        ...COMPLIANT,
        dpopMisbehavior: misbehavior
      });
      expect(statusOf(checks, target)).toBe('FAILURE');
      for (const id of ALL_IDS.filter((c) => c !== target)) {
        expect(statusOf(checks, id)).toBe('SUCCESS');
      }
    });
  }

  it('fails the no-none-alg check when a symmetric algorithm is advertised', async () => {
    const checks = await runAgainst({
      dpopSigningAlgValuesSupported: ['ES256', 'HS256']
    });
    expect(statusOf(checks, 'sep-1932-as-metadata-alg-values')).toBe('SUCCESS');
    expect(statusOf(checks, 'sep-1932-as-no-none-alg')).toBe('FAILURE');
  });
});

describe('DPoPAuthorizationServerScenario — skip conditions', () => {
  it('skips the token-binding check when no client_id is supplied', async () => {
    const checks = await runAgainst(COMPLIANT, false);
    expect(statusOf(checks, 'sep-1932-as-metadata-alg-values')).toBe('SUCCESS');
    expect(statusOf(checks, 'sep-1932-as-no-none-alg')).toBe('SUCCESS');
    expect(statusOf(checks, 'sep-1932-as-token-binding')).toBe('SKIPPED');
  });

  it('skips token binding when no advertised proof alg is supported (no ES256 fallback)', async () => {
    // ES256K is asymmetric (passes no-none-alg) but not one the harness can
    // produce; the scenario must SKIP rather than send an unadvertised ES256
    // proof the AS would reject and mis-score as a binding failure.
    const checks = await runAgainst({
      dpopSigningAlgValuesSupported: ['ES256K']
    });
    expect(statusOf(checks, 'sep-1932-as-metadata-alg-values')).toBe('SUCCESS');
    expect(statusOf(checks, 'sep-1932-as-no-none-alg')).toBe('SUCCESS');
    expect(statusOf(checks, 'sep-1932-as-token-binding')).toBe('SKIPPED');
  });

  it('skips the whole scenario when the AS does not advertise DPoP support', async () => {
    // No dpop_signing_alg_values_supported → not a DPoP AS (RFC 9449 §5.1), so
    // the DPoP requirements do not apply: every check SKIPs rather than fails.
    const checks = await runAgainst({ dpopMisbehavior: 'omit-alg-values' });
    for (const id of ALL_IDS) {
      expect(statusOf(checks, id)).toBe('SKIPPED');
    }
    expect(checks.filter((c) => c.status === 'FAILURE')).toHaveLength(0);
  });
});
