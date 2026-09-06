import { describe, it, expect } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from './spec-types/draft';
import { DATED_SPEC_VERSIONS, DRAFT_PROTOCOL_VERSION } from './types';

describe('DRAFT_PROTOCOL_VERSION', () => {
  it('mirrors LATEST_PROTOCOL_VERSION from the vendored draft schema', () => {
    // DRAFT_PROTOCOL_VERSION is the wire protocolVersion the harness asserts
    // for draft-spec scenarios. It must match what the spec's draft schema
    // declares, or SDKs implementing the draft cannot pass the draft suite.
    expect(DRAFT_PROTOCOL_VERSION).toBe(LATEST_PROTOCOL_VERSION);
  });

  it('is distinct from every dated spec version', () => {
    // Scenario applicability (introducedIn/removedIn) and --spec-version
    // resolution rely on the draft identifier not colliding with a released
    // version.
    expect(DATED_SPEC_VERSIONS).not.toContain(DRAFT_PROTOCOL_VERSION);
  });
});
