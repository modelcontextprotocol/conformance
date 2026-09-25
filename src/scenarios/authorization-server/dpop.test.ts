import { describe, it, expect, afterEach } from 'vitest';
import {
  createAuthServer,
  type AuthServerOptions
} from '../client/auth/helpers/createAuthServer';
import { ServerLifecycle } from '../client/auth/helpers/serverLifecycle';
import { testScenarioContext } from '../../mock-server/testing';
import type { AuthorizationServerOptions } from '../../schemas';
import type { CheckStatus, ConformanceCheck } from '../../types';
import {
  DPOP_NEGATIVE_PROBES_ENV,
  DPoPAuthorizationServerScenario,
  dpopNegativeProbesRequested,
  judgeInvalidDpopProofResponse,
  judgeWrongNonceRejection,
  negotiateProofAlg
} from './dpop';

/** Pretend the authorize step was an interactive login, even against the fixture AS. */
class LoginGatedDpopScenario extends DPoPAuthorizationServerScenario {
  protected negativeProbesAllowed(
    options: AuthorizationServerOptions
  ): boolean {
    return dpopNegativeProbesRequested(options);
  }
}

const ALL_IDS = [
  'sep-1932-as-metadata-alg-values',
  'sep-1932-as-no-none-alg',
  'sep-1932-as-token-binding'
] as const;

const statusOf = (
  checks: ConformanceCheck[],
  id: string
): CheckStatus | undefined => checks.find((c) => c.id === id)?.status;

const named = (checks: ConformanceCheck[], name: string) =>
  checks.find((c) => c.name === name);

/**
 * Start an in-process test AS (real Express app, no mocks) with the given DPoP
 * options, run the scenario against its live URL, and return the emitted checks.
 * The AS 302s straight to the redirect_uri, so the scenario auto-follows headless.
 */
async function runAgainst(
  dpopOptions: Partial<AuthServerOptions>,
  // `false` means "send no client_id" — a plain `undefined` would re-trigger the
  // default via JS default-parameter semantics.
  clientId: string | false = 'test-client-id',
  scenario: DPoPAuthorizationServerScenario = new DPoPAuthorizationServerScenario(),
  scenarioOptions: { dpopNegativeProbes?: boolean } = {}
): Promise<ConformanceCheck[]> {
  const lifecycle = new ServerLifecycle();
  const app = createAuthServer(testScenarioContext(), [], lifecycle.getUrl, {
    loggingEnabled: false,
    grantTypesSupported: ['authorization_code', 'refresh_token'],
    ...dpopOptions
  });
  await lifecycle.start(app);
  try {
    return await scenario.run(
      {
        url: lifecycle.getUrl(),
        port: 45678,
        clientId: clientId || undefined,
        ...scenarioOptions
      },
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
  it('emits the metadata, binding, and invalid-proof checks as SUCCESS', async () => {
    const checks = await runAgainst(COMPLIANT);
    for (const id of ALL_IDS) {
      expect(statusOf(checks, id)).toBe('SUCCESS');
    }
    expect(named(checks, 'RejectsTamperedSignature')?.status).toBe('SUCCESS');
    expect(named(checks, 'RejectsWrongHtu')?.status).toBe('SUCCESS');
    // Nonce is optional (RFC 9449 §8 MAY). A server that does not challenge
    // does not emit sep-1932-as-nonce.
    expect(checks.filter((c) => c.id === 'sep-1932-as-nonce')).toHaveLength(0);
    expect(checks.filter((c) => c.status === 'FAILURE')).toHaveLength(0);
  });

  it('records a nonce challenge, a successful retry, and a rejected wrong nonce', async () => {
    const checks = await runAgainst({
      ...COMPLIANT,
      dpopRequireNonce: true
    });
    for (const id of ALL_IDS) {
      expect(statusOf(checks, id)).toBe('SUCCESS');
    }
    expect(named(checks, 'RejectsTamperedSignature')?.status).toBe('SUCCESS');
    expect(named(checks, 'RejectsWrongHtu')?.status).toBe('SUCCESS');
    expect(named(checks, 'NonceChallengeHeader')?.status).toBe('SUCCESS');
    expect(named(checks, 'NonceRetryAccepted')?.status).toBe('SUCCESS');
    expect(named(checks, 'NonceRejectsWrongValue')?.status).toBe('SUCCESS');
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
    it(`misbehaving AS (${misbehavior}) fails ${target} and leaves the other original checks SUCCESS`, async () => {
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
    expect(statusOf(checks, 'sep-1932-as-rejects-invalid-proof')).toBe(
      'SKIPPED'
    );
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
    expect(statusOf(checks, 'sep-1932-as-rejects-invalid-proof')).toBe(
      'SKIPPED'
    );
  });

  it('skips the whole scenario when the AS does not advertise DPoP support', async () => {
    // No dpop_signing_alg_values_supported → not a DPoP AS (RFC 9449 §5.1), so
    // the DPoP requirements do not apply: every check SKIPs rather than fails.
    const checks = await runAgainst({ dpopMisbehavior: 'omit-alg-values' });
    for (const id of ALL_IDS) {
      expect(statusOf(checks, id)).toBe('SKIPPED');
    }
    expect(statusOf(checks, 'sep-1932-as-rejects-invalid-proof')).toBe(
      'SKIPPED'
    );
    expect(checks.filter((c) => c.id === 'sep-1932-as-nonce')).toHaveLength(0);
    expect(checks.filter((c) => c.status === 'FAILURE')).toHaveLength(0);
  });
});

describe('DPoPAuthorizationServerScenario — negative probes', () => {
  it('accept-any-proof fails both invalid-proof probes and leaves binding SUCCESS', async () => {
    const checks = await runAgainst({
      ...COMPLIANT,
      dpopMisbehavior: 'accept-any-proof'
    });
    expect(statusOf(checks, 'sep-1932-as-token-binding')).toBe('SUCCESS');
    expect(statusOf(checks, 'sep-1932-as-metadata-alg-values')).toBe('SUCCESS');
    for (const name of ['RejectsTamperedSignature', 'RejectsWrongHtu']) {
      const check = named(checks, name);
      expect(check?.status).toBe('FAILURE');
      expect(check?.details).not.toMatchObject({ untestable: true });
      expect(check?.errorMessage).toContain('issued an access token');
    }
  });

  it('does not run invalid-proof probes when binding did not succeed', async () => {
    const checks = await runAgainst({
      ...COMPLIANT,
      dpopMisbehavior: 'unbound-token'
    });
    expect(statusOf(checks, 'sep-1932-as-token-binding')).toBe('FAILURE');
    for (const name of ['RejectsTamperedSignature', 'RejectsWrongHtu']) {
      const check = named(checks, name);
      expect(check?.status).toBe('FAILURE');
      expect(check?.details).toMatchObject({ untestable: true });
      expect(check?.errorMessage).toContain('Not testable:');
      expect(check?.errorMessage).toContain('rejects everything');
    }
  });

  it('nonce-without-header fails the header check and does not skip it onto binding', async () => {
    const checks = await runAgainst({
      ...COMPLIANT,
      dpopMisbehavior: 'nonce-without-header'
    });
    const header = named(checks, 'NonceChallengeHeader');
    expect(header?.id).toBe('sep-1932-as-nonce');
    expect(header?.status).toBe('FAILURE');
    expect(header?.errorMessage).toContain('without a DPoP-Nonce header');
    // No nonce was supplied, so there is no retry and no wrong-nonce probe.
    expect(named(checks, 'NonceRetryAccepted')).toBeUndefined();
    expect(named(checks, 'NonceRejectsWrongValue')).toBeUndefined();
    // Binding stays the existing inconclusive result: use_dpop_nonce is not
    // invalid_dpop_proof. The header check is the failure.
    expect(statusOf(checks, 'sep-1932-as-token-binding')).toBe('SKIPPED');
    expect(
      checks.find((c) => c.id === 'sep-1932-as-token-binding')?.errorMessage
    ).toContain('use_dpop_nonce');
    for (const name of ['RejectsTamperedSignature', 'RejectsWrongHtu']) {
      expect(named(checks, name)?.details).toMatchObject({ untestable: true });
    }
  });

  it('nonce-accept-any accepts a wrong nonce and still rejects invalid proofs', async () => {
    const checks = await runAgainst({
      ...COMPLIANT,
      dpopMisbehavior: 'nonce-accept-any'
    });
    expect(statusOf(checks, 'sep-1932-as-token-binding')).toBe('SUCCESS');
    expect(named(checks, 'NonceChallengeHeader')?.status).toBe('SUCCESS');
    expect(named(checks, 'NonceRetryAccepted')?.status).toBe('SUCCESS');
    expect(named(checks, 'NonceRejectsWrongValue')?.status).toBe('FAILURE');
    expect(named(checks, 'NonceRejectsWrongValue')?.errorMessage).toContain(
      'wrong nonce'
    );
    expect(named(checks, 'RejectsTamperedSignature')?.status).toBe('SUCCESS');
    expect(named(checks, 'RejectsWrongHtu')?.status).toBe('SUCCESS');
  });

  it('withholds negative probes on a login-gated AS unless opted in', async () => {
    const previous = process.env[DPOP_NEGATIVE_PROBES_ENV];
    delete process.env[DPOP_NEGATIVE_PROBES_ENV];
    try {
      const checks = await runAgainst(
        COMPLIANT,
        'test-client-id',
        new LoginGatedDpopScenario()
      );
      expect(statusOf(checks, 'sep-1932-as-token-binding')).toBe('SUCCESS');
      for (const name of ['RejectsTamperedSignature', 'RejectsWrongHtu']) {
        const check = named(checks, name);
        expect(check?.status).toBe('FAILURE');
        expect(check?.details).toMatchObject({ untestable: true });
        expect(check?.errorMessage).toContain('--dpop-negative-probes');
        expect(check?.errorMessage).toContain(DPOP_NEGATIVE_PROBES_ENV);
      }
    } finally {
      if (previous === undefined) delete process.env[DPOP_NEGATIVE_PROBES_ENV];
      else process.env[DPOP_NEGATIVE_PROBES_ENV] = previous;
    }
  });

  it('runs negative probes on a login-gated AS when the flag or env opts in', async () => {
    const previous = process.env[DPOP_NEGATIVE_PROBES_ENV];
    delete process.env[DPOP_NEGATIVE_PROBES_ENV];
    try {
      const flagged = await runAgainst(
        COMPLIANT,
        'test-client-id',
        new LoginGatedDpopScenario(),
        { dpopNegativeProbes: true }
      );
      expect(named(flagged, 'RejectsTamperedSignature')?.status).toBe(
        'SUCCESS'
      );
      expect(named(flagged, 'RejectsWrongHtu')?.status).toBe('SUCCESS');

      process.env[DPOP_NEGATIVE_PROBES_ENV] = '1';
      const fromEnv = await runAgainst(
        COMPLIANT,
        'test-client-id',
        new LoginGatedDpopScenario()
      );
      expect(named(fromEnv, 'RejectsTamperedSignature')?.status).toBe(
        'SUCCESS'
      );
    } finally {
      if (previous === undefined) delete process.env[DPOP_NEGATIVE_PROBES_ENV];
      else process.env[DPOP_NEGATIVE_PROBES_ENV] = previous;
    }
  });
});

describe('invalid-proof and wrong-nonce grading', () => {
  it('grades invalid proofs by the RFC 9449 §5 response', () => {
    expect(
      judgeInvalidDpopProofResponse(
        { statusCode: 400, body: { error: 'invalid_dpop_proof' } },
        'tampered-signature'
      ).status
    ).toBe('SUCCESS');
    expect(
      judgeInvalidDpopProofResponse(
        { statusCode: 200, body: { access_token: 'tok' } },
        'tampered-signature'
      ).status
    ).toBe('FAILURE');
    expect(
      judgeInvalidDpopProofResponse(
        { statusCode: 400, body: { error: 'invalid_request' } },
        'wrong-htu'
      ).status
    ).toBe('WARNING');
    expect(
      judgeInvalidDpopProofResponse(
        { statusCode: 401, body: { error: 'invalid_dpop_proof' } },
        'wrong-htu'
      ).status
    ).toBe('SKIPPED');
    expect(
      judgeInvalidDpopProofResponse({ statusCode: 500 }, 'wrong-htu').status
    ).toBe('SKIPPED');
  });

  it('treats any token-less 4xx as a wrong-nonce rejection', () => {
    expect(
      judgeWrongNonceRejection({
        statusCode: 400,
        body: { error: 'use_dpop_nonce' }
      }).status
    ).toBe('SUCCESS');
    expect(
      judgeWrongNonceRejection({
        statusCode: 400,
        body: { error: 'invalid_dpop_proof' }
      }).status
    ).toBe('SUCCESS');
    expect(
      judgeWrongNonceRejection({
        statusCode: 200,
        body: { access_token: 'tok' }
      }).status
    ).toBe('FAILURE');
    expect(judgeWrongNonceRejection({ statusCode: 500 }).status).toBe(
      'SKIPPED'
    );
  });

  afterEach(() => {
    delete process.env[DPOP_NEGATIVE_PROBES_ENV];
  });

  it('reads the negative-probe opt-in from the flag or the env var', () => {
    expect(dpopNegativeProbesRequested({})).toBe(false);
    expect(dpopNegativeProbesRequested({ dpopNegativeProbes: true })).toBe(
      true
    );
    process.env[DPOP_NEGATIVE_PROBES_ENV] = 'true';
    expect(dpopNegativeProbesRequested({})).toBe(true);
    process.env[DPOP_NEGATIVE_PROBES_ENV] = '0';
    expect(dpopNegativeProbesRequested({})).toBe(false);
  });
});

describe('negotiateProofAlg (dpop_signing_alg_values_supported shapes)', () => {
  it('picks the first supported alg from a non-empty array', () => {
    expect(negotiateProofAlg(['ES256'])).toBe('ES256');
    expect(negotiateProofAlg(['RS256', 'ES256'])).toBe('RS256');
  });

  it('returns null for a non-empty array with no supported alg (→ SKIP)', () => {
    expect(negotiateProofAlg(['ES256K'])).toBeNull();
  });

  it('falls back to ES256 only for an empty array or an absent field', () => {
    expect(negotiateProofAlg([])).toBe('ES256');
    // Absent never reaches here in the scenario (the support gate SKIPs upstream),
    // but the contract still treats undefined as the empty/best-effort case.
    expect(negotiateProofAlg(undefined)).toBe('ES256');
  });

  it('returns null for a present-but-non-array (malformed) value (→ SKIP)', () => {
    // Regression guard: a string or JSON null must NOT fall through to the
    // ES256 fallback, which would mis-score token binding.
    expect(negotiateProofAlg('RS256')).toBeNull();
    expect(negotiateProofAlg(null)).toBeNull();
    expect(negotiateProofAlg(42)).toBeNull();
    expect(negotiateProofAlg({ 0: 'ES256' })).toBeNull();
  });
});
