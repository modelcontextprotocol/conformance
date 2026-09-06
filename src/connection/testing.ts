import { LATEST_SPEC_VERSION, type SpecVersion } from '../types';
import { connectFor } from './select';
import type { ConnectOptions, RunContext } from './index';

/**
 * Build a RunContext for unit tests that drive a scenario directly.
 * Defaults to the latest dated spec version (stateful lifecycle) so existing
 * tests keep their pre-RunContext behaviour.
 */
export function testContext(
  serverUrl: string,
  specVersion: SpecVersion = LATEST_SPEC_VERSION
): RunContext {
  return {
    serverUrl,
    specVersion,
    connect: (opts?: ConnectOptions) => connectFor(specVersion)(serverUrl, opts)
  };
}
