import { LATEST_SPEC_VERSION, type SpecVersion } from '../types';
import { createServerFor } from './select';
import type { ScenarioContext } from './index';

/**
 * Build a ScenarioContext for unit tests that drive a Scenario directly.
 * Defaults to the latest dated spec version (stateful lifecycle) so existing
 * tests keep their pre-ScenarioContext behaviour.
 */
export function testScenarioContext(
  specVersion: SpecVersion = LATEST_SPEC_VERSION
): ScenarioContext {
  return {
    specVersion,
    createServer: (handlers, opts) =>
      createServerFor(specVersion)(handlers, opts)
  };
}
