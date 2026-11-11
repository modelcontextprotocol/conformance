import type { SpecVersion } from '../types';
import { DEFAULT_TEST_SPEC_VERSION } from '../mock-server/testing';
import { connectFor } from './select';
import type { ConnectOptions, RunContext } from './index';

/**
 * Build a RunContext for unit tests that drive a scenario directly.
 * Defaults to {@link DEFAULT_TEST_SPEC_VERSION} (the last stateful revision)
 * so tests that stand up an SDK-based fixture server keep working; pass
 * `'2026-07-28'` (or the draft) explicitly to exercise the stateless path.
 */
export function testContext(
  serverUrl: string,
  specVersion: SpecVersion = DEFAULT_TEST_SPEC_VERSION
): RunContext {
  return {
    serverUrl,
    specVersion,
    connect: (opts?: ConnectOptions) => connectFor(specVersion)(serverUrl, opts)
  };
}
