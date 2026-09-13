import { describe, it, expect } from 'vitest';
import { finalizeChecks } from '../../../hosted/session';
import { testScenarioContext } from '../../../mock-server/testing';
import { DRAFT_PROTOCOL_VERSION } from '../../../types';
import {
  IssParameterNormalizedVariantScenario,
  MetadataIssuerMismatchScenario
} from './issuer-parameter';

/**
 * The observed issuers come from the log. When it holds none (the client
 * never fetched the documents), the checks leave them out rather than
 * report an issuer nobody saw.
 */
describe('issuer-parameter observations', () => {
  it('auth/iss-normalized reports no issuer the log does not hold', () => {
    const check = finalizeChecks('auth/iss-normalized', []).find(
      (c) => c.id === 'sep-2468-client-no-normalization'
    );
    expect(check?.details).not.toHaveProperty('recordedIssuer');
    expect(check?.details).not.toHaveProperty('issSentInRedirect');
  });

  it('auth/metadata-issuer-mismatch reports no expected issuer the log does not hold', () => {
    const check = finalizeChecks('auth/metadata-issuer-mismatch', []).find(
      (c) => c.id === 'sep-2468-client-validate-metadata-issuer'
    );
    expect(check?.details).not.toHaveProperty('expectedIssuer');
  });

  it('judges after stop() without reaching for the stopped server', async () => {
    for (const scenario of [
      new IssParameterNormalizedVariantScenario(),
      new MetadataIssuerMismatchScenario()
    ]) {
      await scenario.start(testScenarioContext(DRAFT_PROTOCOL_VERSION));
      await scenario.stop();
      expect(() => scenario.getChecks()).not.toThrow();
    }
  });
});
