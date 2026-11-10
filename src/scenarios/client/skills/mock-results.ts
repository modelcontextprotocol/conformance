/**
 * Results for the hand-rolled SEP-2640 client-scenario mocks, shaped like a
 * conformant server's so a strict client is graded on its skills behaviour
 * rather than turned away by the harness.
 */

import {
  DRAFT_PROTOCOL_VERSION,
  NEGOTIABLE_PROTOCOL_VERSIONS
} from '../../../types.js';
import { withRequiredDraftResultFields } from '../../../mock-server/index.js';

/**
 * `ListSkillsResult` is cacheable like `resources/list`, but `skills/list` is
 * an extension method and not in the shared cacheable set, so the caching
 * members are stamped here.
 */
export function skillsListResult(skills: object[]): object {
  return { resultType: 'complete', ttlMs: 0, cacheScope: 'private', skills };
}

export function readResult(uri: unknown, text: string): unknown {
  return withRequiredDraftResultFields('resources/read', {
    contents: [{ uri, mimeType: 'text/markdown', text }]
  });
}

/**
 * The `initialize` result at the version the client asked for, when the suite
 * can speak it. The extension has no 2026-07-28 dependency, and the runner
 * hands these scenarios' clients 2025-11-25 unless `--spec-version` says
 * otherwise, so a fixed 2026-07-28 reply would turn a correct stateful client
 * away before it ever lists.
 */
export function initializeResult(
  name: string,
  request: { params?: { protocolVersion?: unknown } },
  capabilities: object
): object {
  const requested = request.params?.protocolVersion;
  const protocolVersion =
    typeof requested === 'string' &&
    NEGOTIABLE_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : DRAFT_PROTOCOL_VERSION;
  return {
    resultType: 'complete',
    protocolVersion,
    serverInfo: { name: `${name}-server`, version: '1.0.0' },
    capabilities
  };
}
