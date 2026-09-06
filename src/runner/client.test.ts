/**
 * Tests for the client-conformance runner: spec-version applicability
 * skipping (an explicitly-requested version outside a scenario's window
 * skips rather than silently testing something else; --force overrides)
 * and version inference when --spec-version is omitted.
 */
import { describe, test, expect } from 'vitest';
import { runConformanceTest } from './client';
import {
  DRAFT_PROTOCOL_VERSION,
  DRAFT_SPEC_VERSION,
  LATEST_SPEC_VERSION
} from '../types';

const LAST_STATEFUL = '2025-11-25' as const;

// A "client" that just prints the protocol version handed to it, so tests
// can observe which version the runner resolved.
const PRINT_VERSION_COMMAND =
  'node -e "console.log(process.env.MCP_CONFORMANCE_PROTOCOL_VERSION)"';

describe('runConformanceTest spec-version applicability', () => {
  test('skips a 2026-07-28 scenario at an explicit earlier spec version', async () => {
    // http-custom-headers is introducedIn 2026-07-28, so an earlier version
    // contradicts it. The skip happens before the mock server starts and
    // before the client command is spawned.
    const result = await runConformanceTest(
      PRINT_VERSION_COMMAND,
      'http-custom-headers',
      5000,
      undefined,
      LAST_STATEFUL
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
      LAST_STATEFUL,
      true
    );
    expect(result.skipped).toBeUndefined();
    expect(result.clientOutput?.stdout).toContain(LAST_STATEFUL);
  }, 30000);

  test('hands the client the draft wire version, not the word "draft", under --spec-version draft', async () => {
    const result = await runConformanceTest(
      PRINT_VERSION_COMMAND,
      'http-custom-headers',
      10000,
      undefined,
      DRAFT_SPEC_VERSION
    );
    expect(result.skipped).toBeUndefined();
    expect(result.clientOutput?.stdout).toContain(DRAFT_PROTOCOL_VERSION);
    expect(result.clientOutput?.stdout).not.toContain(DRAFT_SPEC_VERSION);
  }, 30000);

  test('infers the latest release for a scenario that applies there when --spec-version is omitted', async () => {
    // tools_call is introducedIn 2025-06-18 and still applicable at the
    // latest release; omitting --spec-version runs it there.
    const result = await runConformanceTest(
      PRINT_VERSION_COMMAND,
      'tools_call',
      10000
    );
    expect(result.skipped).toBeUndefined();
    expect(result.clientOutput?.stdout).toContain(LATEST_SPEC_VERSION);
  }, 30000);

  test('infers the last release before removedIn for a removed scenario when --spec-version is omitted', async () => {
    // initialize is removedIn 2026-07-28; without --spec-version it runs at
    // the newest revision it still applies to rather than being handed a
    // stateless mock server it cannot handshake with.
    const result = await runConformanceTest(
      PRINT_VERSION_COMMAND,
      'initialize',
      10000
    );
    expect(result.skipped).toBeUndefined();
    expect(result.clientOutput?.stdout).toContain(LAST_STATEFUL);
  }, 30000);
});
