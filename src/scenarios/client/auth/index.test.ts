import {
  authScenariosList,
  backcompatScenariosList,
  draftScenariosList,
  extensionScenariosList
} from './index';
import {
  runClientAgainstScenario,
  InlineClientRunner
} from './test_helpers/testClient';
import { runClient as badPrmClient } from '../../../../examples/clients/typescript/auth-test-bad-prm';
import {
  runWifJwtBearerWrongAudience,
  runWifJwtBearerMissingAssertion,
  runWifJwtBearerExpiredAssertion,
  runWifJwtBearerScopeRejected,
  runWifJwtBearerGrantFallback,
  runWifJwtBearerRetry
} from '../../../../examples/clients/typescript/wif-broken-clients';
import { runClient as noCimdClient } from '../../../../examples/clients/typescript/auth-test-no-cimd';
import { runClient as ignoreScopeClient } from '../../../../examples/clients/typescript/auth-test-ignore-scope';
import { runClient as partialScopesClient } from '../../../../examples/clients/typescript/auth-test-partial-scopes';
import { runClient as ignore403Client } from '../../../../examples/clients/typescript/auth-test-ignore-403';
import { runClient as noRetryLimitClient } from '../../../../examples/clients/typescript/auth-test-no-retry-limit';
import { runClient as noPkceClient } from '../../../../examples/clients/typescript/auth-test-no-pkce';
import { runClient as reuseCredsClient } from '../../../../examples/clients/typescript/auth-test-reuse-credentials';
import { runClient as noAppTypeClient } from '../../../../examples/clients/typescript/auth-test-no-application-type';
import { runClient as noIssValidationClient } from '../../../../examples/clients/typescript/auth-test';
import { runClient as issNormalizeClient } from '../../../../examples/clients/typescript/auth-test-iss-normalize';
import { runClient as echoScopeClient } from '../../../../examples/clients/typescript/auth-test-echo-scope';
import { getHandler } from '../../../../examples/clients/typescript/everything-client';
import { setLogLevel } from '../../../../examples/clients/typescript/helpers/logger';
import { DRAFT_PROTOCOL_VERSION } from '../../../types';

beforeAll(() => {
  setLogLevel('error');
});

const skipScenarios = new Set<string>([
  // Add scenarios that should be skipped here
]);

const allowClientErrorScenarios = new Set<string>([
  // Client is expected to give up (error) after limited retries, but check should pass
  'auth/scope-retry-limit',
  // Client is expected to error when PRM resource doesn't match server URL
  'auth/resource-mismatch',
  // The post-migration retry path may surface as a client error after
  // re-registering; the SEP-2352 checks are evaluated in getChecks()
  'auth/authorization-server-migration',
  // Client is expected to error when iss validation fails
  'auth/iss-supported-missing',
  'auth/iss-wrong-issuer',
  'auth/iss-unexpected',
  'auth/iss-normalized',
  // Client is expected to error when AS metadata issuer validation fails
  'auth/metadata-issuer-mismatch'
]);

describe('Client Auth Scenarios', () => {
  // Generate individual test for each auth scenario
  for (const scenario of authScenariosList) {
    test(`${scenario.name} passes`, async () => {
      if (skipScenarios.has(scenario.name)) {
        // TODO: skip in a native way?
        return;
      }
      const clientFn = getHandler(scenario.name);
      if (!clientFn) {
        throw new Error(`No handler registered for scenario: ${scenario.name}`);
      }
      const runner = new InlineClientRunner(clientFn);
      await runClientAgainstScenario(runner, scenario.name, {
        allowClientError: allowClientErrorScenarios.has(scenario.name)
      });
    });
  }
});

describe('Client Back-compat Scenarios', () => {
  for (const scenario of backcompatScenariosList) {
    test(`${scenario.name} passes`, async () => {
      const clientFn = getHandler(scenario.name);
      if (!clientFn) {
        throw new Error(`No handler registered for scenario: ${scenario.name}`);
      }
      const runner = new InlineClientRunner(clientFn);
      await runClientAgainstScenario(runner, scenario.name);
    });
  }
});

describe('Client Draft Scenarios', () => {
  for (const scenario of draftScenariosList) {
    test(`${scenario.name} passes`, async () => {
      const clientFn = getHandler(scenario.name);
      if (!clientFn) {
        throw new Error(`No handler registered for scenario: ${scenario.name}`);
      }
      const runner = new InlineClientRunner(clientFn);
      await runClientAgainstScenario(runner, scenario.name, {
        allowClientError: allowClientErrorScenarios.has(scenario.name)
      });
    });
  }
});

describe('Negative tests', () => {
  test('bad client requests root PRM location', async () => {
    const runner = new InlineClientRunner(badPrmClient);
    await runClientAgainstScenario(runner, 'auth/metadata-default', {
      expectedFailureSlugs: ['prm-priority-order']
    });
  });

  test('client ignores scope from WWW-Authenticate header', async () => {
    const runner = new InlineClientRunner(ignoreScopeClient);
    await runClientAgainstScenario(runner, 'auth/scope-from-www-authenticate', {
      expectedFailureSlugs: ['scope-from-www-authenticate']
    });
  });

  test('client only requests subset of scopes_supported', async () => {
    const runner = new InlineClientRunner(partialScopesClient);
    await runClientAgainstScenario(runner, 'auth/scope-from-scopes-supported', {
      expectedFailureSlugs: ['scope-from-scopes-supported']
    });
  });

  test('client requests scope even if scopes_supported is empty', async () => {
    const runner = new InlineClientRunner(partialScopesClient);
    await runClientAgainstScenario(
      runner,
      'auth/scope-omitted-when-undefined',
      {
        expectedFailureSlugs: ['scope-omitted-when-undefined']
      }
    );
  });

  test('client only responds to 401, not 403', async () => {
    // Run at draft so the SEP-2350 union check is also emitted: a client that
    // never makes the second authorization request fails both the escalation
    // check and the union check.
    const runner = new InlineClientRunner(ignore403Client);
    await runClientAgainstScenario(runner, 'auth/scope-step-up', {
      specVersion: DRAFT_PROTOCOL_VERSION,
      expectedFailureSlugs: [
        'scope-step-up-escalation',
        'sep-2350-scope-union-on-reauth'
      ]
    });
  });

  test('client echoes challenge scope without accumulating prior grant (SEP-2350) at draft', async () => {
    // The set-wise union requirement (SEP-2350) was added in the draft spec
    // (2026-07-28); a client that echoes only the challenged scope fails it.
    const runner = new InlineClientRunner(echoScopeClient);
    await runClientAgainstScenario(runner, 'auth/scope-step-up', {
      specVersion: DRAFT_PROTOCOL_VERSION,
      expectedFailureSlugs: ['sep-2350-scope-union-on-reauth']
    });
  });

  test('client echoes challenge scope without accumulating prior grant (SEP-2350) at 2025-11-25', async () => {
    // At dated spec versions that predate SEP-2350, the union check is not
    // emitted at all, so a client that drops the previously-granted scope on
    // re-auth passes cleanly.
    const runner = new InlineClientRunner(echoScopeClient);
    await runClientAgainstScenario(runner, 'auth/scope-step-up', {
      specVersion: '2025-11-25'
    });
  });

  test('client uses DCR instead of CIMD when server supports it', async () => {
    const runner = new InlineClientRunner(noCimdClient);
    await runClientAgainstScenario(runner, 'auth/basic-cimd', {
      expectedFailureSlugs: ['cimd-client-id-used']
    });
  });

  test('client retries auth infinitely without limit', async () => {
    const runner = new InlineClientRunner(noRetryLimitClient);
    await runClientAgainstScenario(runner, 'auth/scope-retry-limit', {
      expectedFailureSlugs: ['scope-retry-limit'],
      allowClientError: true
    });
  });

  test('client reuses credentials across authorization servers (SEP-2352)', async () => {
    const runner = new InlineClientRunner(reuseCredsClient);
    await runClientAgainstScenario(
      runner,
      'auth/authorization-server-migration',
      {
        allowClientError: true,
        expectedFailureSlugs: [
          'sep-2352-reregister-on-as-change',
          'sep-2352-no-reuse-on-as-change',
          'sep-2352-no-cross-as-credential-reuse'
        ]
      }
    );
  });

  test('client omits application_type during DCR (SEP-837) at draft', async () => {
    // SEP-837 is a draft-spec requirement, so the check is only enforced when
    // the run targets the draft version.
    const runner = new InlineClientRunner(noAppTypeClient);
    await runClientAgainstScenario(runner, 'auth/metadata-default', {
      specVersion: DRAFT_PROTOCOL_VERSION,
      expectedFailureSlugs: ['sep-837-application-type-present']
    });
  });

  test('client omits application_type during DCR (SEP-837) at 2025-11-25', async () => {
    // At dated spec versions that predate SEP-837 the check is not emitted at
    // all, so a client omitting application_type passes cleanly.
    const runner = new InlineClientRunner(noAppTypeClient);
    await runClientAgainstScenario(runner, 'auth/metadata-default', {
      specVersion: '2025-11-25'
    });
  });

  test('client does not use PKCE', async () => {
    const runner = new InlineClientRunner(noPkceClient);
    await runClientAgainstScenario(runner, 'auth/metadata-default', {
      expectedFailureSlugs: [
        'pkce-code-challenge-sent',
        'pkce-s256-method-used',
        'pkce-code-verifier-sent',
        'pkce-verifier-matches-challenge'
      ]
    });
  });

  test('client does not reject missing iss when server requires it', async () => {
    const runner = new InlineClientRunner(noIssValidationClient);
    await runClientAgainstScenario(runner, 'auth/iss-supported-missing', {
      expectedFailureSlugs: ['sep-2468-client-reject-missing-iss'],
      allowClientError: true
    });
  });

  test('client does not reject mismatched iss', async () => {
    const runner = new InlineClientRunner(noIssValidationClient);
    await runClientAgainstScenario(runner, 'auth/iss-wrong-issuer', {
      expectedFailureSlugs: ['sep-2468-client-compare-iss-supported'],
      allowClientError: true
    });
  });

  test('client does not reject unexpected iss', async () => {
    const runner = new InlineClientRunner(noIssValidationClient);
    await runClientAgainstScenario(runner, 'auth/iss-unexpected', {
      expectedFailureSlugs: ['sep-2468-client-compare-iss-unadvertised'],
      allowClientError: true
    });
  });

  test('client normalizes iss before comparison and accepts a trailing-slash variant', async () => {
    const runner = new InlineClientRunner(issNormalizeClient);
    await runClientAgainstScenario(runner, 'auth/iss-normalized', {
      expectedFailureSlugs: ['sep-2468-client-no-normalization'],
      allowClientError: true
    });
  });

  test('client uses AS metadata whose issuer does not match the well-known URL', async () => {
    const runner = new InlineClientRunner(noIssValidationClient);
    await runClientAgainstScenario(runner, 'auth/metadata-issuer-mismatch', {
      expectedFailureSlugs: ['sep-2468-client-validate-metadata-issuer'],
      allowClientError: true
    });
  });
});

describe('Client Extension Scenarios', () => {
  for (const scenario of extensionScenariosList) {
    test(`${scenario.name} passes`, async () => {
      const clientFn = getHandler(scenario.name);
      if (!clientFn) {
        throw new Error(`No handler registered for scenario: ${scenario.name}`);
      }
      const runner = new InlineClientRunner(clientFn);
      await runClientAgainstScenario(runner, scenario.name);
    });
  }
});

// allowClientError: true because broken clients receive an error response from
// the AS and will throw. The AS-side check is the authoritative conformance
// signal; client process exit behaviour is not asserted here.
describe('WIF JWT-bearer negative tests', () => {
  test('client presents JWT with wrong audience', async () => {
    const runner = new InlineClientRunner(runWifJwtBearerWrongAudience);
    await runClientAgainstScenario(runner, 'auth/wif-jwt-bearer', {
      expectedFailureSlugs: ['wif-assertion-audience'],
      allowClientError: true
    });
  });

  test('client omits assertion from JWT-bearer request', async () => {
    const runner = new InlineClientRunner(runWifJwtBearerMissingAssertion);
    await runClientAgainstScenario(runner, 'auth/wif-jwt-bearer', {
      expectedFailureSlugs: ['wif-assertion-missing'],
      allowClientError: true
    });
  });

  test('client presents expired JWT assertion', async () => {
    const runner = new InlineClientRunner(runWifJwtBearerExpiredAssertion);
    await runClientAgainstScenario(runner, 'auth/wif-jwt-bearer', {
      expectedFailureSlugs: ['wif-assertion-expired'],
      allowClientError: true
    });
  });

  test('client requests a scope the AS rejects for JWT-bearer grant', async () => {
    const runner = new InlineClientRunner(runWifJwtBearerScopeRejected);
    await runClientAgainstScenario(runner, 'auth/wif-jwt-bearer', {
      allowClientError: true
    });
  });

  test('client falls back to authorization_code after unauthorized_client', async () => {
    const runner = new InlineClientRunner(runWifJwtBearerGrantFallback);
    await runClientAgainstScenario(runner, 'auth/wif-jwt-bearer', {
      expectedFailureSlugs: ['wif-grant-fallback'],
      allowClientError: true
    });
  });

  test('client retries JWT-bearer after unauthorized_client', async () => {
    const runner = new InlineClientRunner(runWifJwtBearerRetry);
    await runClientAgainstScenario(runner, 'auth/wif-jwt-bearer', {
      expectedFailureSlugs: ['wif-no-retry'],
      allowClientError: true
    });
  });
});
