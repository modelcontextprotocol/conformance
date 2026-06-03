/**
 * Tests for the server-conformance runner: spec-version applicability
 * skipping (an explicitly-requested version outside a scenario's window
 * skips rather than silently testing something else; --force overrides).
 */
import { describe, test, expect } from 'vitest';
import { runServerConformanceTest } from './server';
import { DRAFT_PROTOCOL_VERSION, LATEST_SPEC_VERSION } from '../types';

// The skip decision happens before any network request, so an unreachable
// URL proves the scenario was not run.
const UNREACHABLE_URL = 'http://127.0.0.1:9/mcp';

describe('runServerConformanceTest spec-version applicability', () => {
  test('skips a draft-only scenario at an explicit dated spec version', async () => {
    const result = await runServerConformanceTest(
      UNREACHABLE_URL,
      'server-stateless',
      undefined,
      LATEST_SPEC_VERSION
    );
    expect(result.skipped).toBe(true);
    expect(result.checks).toEqual([]);
  });

  test('skips a removed-in-draft scenario at the draft spec version', async () => {
    // server-initialize tests the stateful handshake, which the draft
    // (stateless) lifecycle removed.
    const result = await runServerConformanceTest(
      UNREACHABLE_URL,
      'server-initialize',
      undefined,
      DRAFT_PROTOCOL_VERSION
    );
    expect(result.skipped).toBe(true);
    expect(result.checks).toEqual([]);
  });

  test('does not skip an applicable scenario/spec-version combination', async () => {
    // server-stateless at draft is applicable; the runner proceeds to run it
    // (against an unreachable server, so checks exist and report failures —
    // the point is only that it was not skipped).
    const result = await runServerConformanceTest(
      UNREACHABLE_URL,
      'server-stateless',
      undefined,
      DRAFT_PROTOCOL_VERSION
    );
    expect(result.skipped).toBeUndefined();
    expect(result.checks.length).toBeGreaterThan(0);
  }, 60000);
});
