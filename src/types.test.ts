import { describe, it, expect } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from './spec-types/draft';
import {
  DATED_SPEC_VERSIONS,
  DRAFT_PROTOCOL_VERSION,
  DRAFT_SPEC_VERSION,
  LATEST_SPEC_VERSION,
  SPEC_VERSION_TIMELINE,
  protocolVersionFor,
  specVersionAtLeast
} from './types';

describe('DRAFT_PROTOCOL_VERSION', () => {
  it('mirrors LATEST_PROTOCOL_VERSION from the vendored draft schema', () => {
    // DRAFT_PROTOCOL_VERSION is the wire protocolVersion the harness sends for
    // `--spec-version draft`. It must match what the spec's draft schema
    // declares, or SDKs implementing the draft cannot pass a draft run.
    expect(DRAFT_PROTOCOL_VERSION).toBe(LATEST_PROTOCOL_VERSION);
  });
});

describe('DRAFT_SPEC_VERSION', () => {
  it('is distinct from every dated spec version and last on the timeline', () => {
    // Scenario applicability (introducedIn/removedIn) and --spec-version
    // resolution rely on the draft identifier not colliding with a released
    // version, even while its wire string does.
    expect(DATED_SPEC_VERSIONS).not.toContain(DRAFT_SPEC_VERSION);
    expect(SPEC_VERSION_TIMELINE[SPEC_VERSION_TIMELINE.length - 1]).toBe(
      DRAFT_SPEC_VERSION
    );
    expect(specVersionAtLeast(DRAFT_SPEC_VERSION, LATEST_SPEC_VERSION)).toBe(
      true
    );
    expect(specVersionAtLeast(LATEST_SPEC_VERSION, DRAFT_SPEC_VERSION)).toBe(
      false
    );
  });

  it('maps to the draft wire version; dated versions map to themselves', () => {
    expect(protocolVersionFor(DRAFT_SPEC_VERSION)).toBe(DRAFT_PROTOCOL_VERSION);
    for (const v of DATED_SPEC_VERSIONS) {
      expect(protocolVersionFor(v)).toBe(v);
    }
  });
});

describe('LATEST_SPEC_VERSION', () => {
  it('is the last dated spec version', () => {
    expect(DATED_SPEC_VERSIONS[DATED_SPEC_VERSIONS.length - 1]).toBe(
      LATEST_SPEC_VERSION
    );
  });
});
