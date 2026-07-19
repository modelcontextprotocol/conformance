/**
 * Tests for the client-conformance runner: spec-version applicability
 * skipping (an explicitly-requested version outside a scenario's window
 * skips rather than silently testing something else; --force overrides)
 * and version inference when --spec-version is omitted.
 */
import { describe, test, expect } from 'vitest';
import { runConformanceTest } from './client';
import { DRAFT_PROTOCOL_VERSION, LATEST_SPEC_VERSION } from '../types';

// A "client" that just prints the protocol version handed to it, so tests
// can observe which version the runner resolved.
const PRINT_VERSION_COMMAND =
  'node -e "console.log(process.env.MCP_CONFORMANCE_PROTOCOL_VERSION)"';

describe('runConformanceTest spec-version applicability', () => {
  test('skips a draft-only scenario at an explicit dated spec version', async () => {
    // http-custom-headers is introducedIn DRAFT, so a dated version
    // contradicts it. The skip happens before the mock server starts and
    // before the client command is spawned.
    const result = await runConformanceTest(
      PRINT_VERSION_COMMAND,
      'http-custom-headers',
      5000,
      undefined,
      LATEST_SPEC_VERSION
    );
    expect(result.skipped).toBe(true);
    expect(result.checks).toEqual([]);
    expect(result.clientOutput).toBeUndefined();
  });

  test('--force runs an inapplicable scenario at the requested version', async () => {
    const result = await runConformanceTest(
      PRINT_VERSION_COMMAND,
      'http-custom-headers',
      10000,
      undefined,
      LATEST_SPEC_VERSION,
      true
    );
    expect(result.skipped).toBeUndefined();
    expect(result.clientOutput?.stdout).toContain(LATEST_SPEC_VERSION);
  }, 30000);

  test('infers the draft version for a draft-only scenario when --spec-version is omitted', async () => {
    const result = await runConformanceTest(
      PRINT_VERSION_COMMAND,
      'http-custom-headers',
      10000
    );
    expect(result.skipped).toBeUndefined();
    expect(result.clientOutput?.stdout).toContain(DRAFT_PROTOCOL_VERSION);
  }, 30000);

  test('infers the latest dated version for a dual-version scenario when --spec-version is omitted', async () => {
    // tools_call is introducedIn 2025-06-18 and still applicable at draft;
    // omitting --spec-version must keep the latest dated default.
    const result = await runConformanceTest(
      PRINT_VERSION_COMMAND,
      'tools_call',
      10000
    );
    expect(result.skipped).toBeUndefined();
    expect(result.clientOutput?.stdout).toContain(LATEST_SPEC_VERSION);
  }, 30000);

  test('uses an extension baseSpecVersion when the scenario declares one', async () => {
    const result = await runConformanceTest(
      PRINT_VERSION_COMMAND,
      'tasks-client-create-handling',
      10000
    );
    expect(result.skipped).toBeUndefined();
    expect(result.clientOutput?.stdout).toContain(DRAFT_PROTOCOL_VERSION);
  }, 30000);
});
