import type { SpecVersion } from '../types';
import { createServerFor } from './select';
import type { ScenarioContext } from './index';

/**
 * Spec version unit tests run at when they do not name one: the last
 * revision with the stateful lifecycle, which is what the bundled SDK
 * `Client`/`Server` most tests drive scenarios with speak. Pass
 * `'2026-07-28'` (or the draft) explicitly to exercise the stateless path.
 */
export const DEFAULT_TEST_SPEC_VERSION: SpecVersion = '2025-11-25';

/**
 * Build a ScenarioContext for unit tests that drive a Scenario directly.
 * Defaults to {@link DEFAULT_TEST_SPEC_VERSION}.
 */
export function testScenarioContext(
  specVersion: SpecVersion = DEFAULT_TEST_SPEC_VERSION
): ScenarioContext {
  return {
    specVersion,
    createServer: (handlers) => createServerFor(specVersion)(handlers)
  };
}
