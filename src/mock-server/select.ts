import type { SpecVersion } from '../types';
import type { MockServer, MockServerOptions, RequestHandlers } from './index';
import { createServerStateful } from './stateful';
import { createServerStateless } from './stateless';

/**
 * Spec versions that use the stateful lifecycle (initialize handshake).
 * Kept identical to `connection/select.ts`.
 */
const STATEFUL_VERSIONS: ReadonlySet<string> = new Set([
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25'
]);

export function createServerFor(
  specVersion: SpecVersion
): (
  handlers: RequestHandlers,
  opts?: MockServerOptions
) => Promise<MockServer> {
  return STATEFUL_VERSIONS.has(specVersion)
    ? createServerStateful
    : createServerStateless;
}
