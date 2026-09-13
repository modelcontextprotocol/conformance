/**
 * Every scenario that exists only at 2026-07-28 answers the dated revisions'
 * initialize handshake the way that revision asks of a modern-only server
 * (basic/versioning, "Backward Compatibility with Initialization-Based
 * Versions"): with the unsupported-version error, -32022, naming the
 * versions it supports, so a dual-era client that opens this way can retry
 * with 2026-07-28. Each scenario is asked twice, because some treat their
 * first request specially.
 */
import { describe, test, expect } from 'vitest';
import { getScenario } from '../index';
import { freshScenario } from '../../hosted/session';
import { testScenarioContext } from '../../mock-server/testing';
import { DRAFT_PROTOCOL_VERSION } from '../../types';

// json-schema-ref-no-deref is left out on purpose: its bundled SDK server
// still completes a legacy handshake, which the SDK conformance clients that
// run it rely on today.
const MODERN_ONLY = [
  'http-standard-headers',
  'http-custom-headers',
  'http-invalid-tool-headers',
  'sep-2322-client-request-state',
  'request-metadata'
];

const LEGACY = '2025-11-25';

describe('a legacy initialize to a 2026-07-28-only scenario', () => {
  test.each(MODERN_ONLY)('%s names the version it supports', async (name) => {
    const proto = getScenario(name);
    expect(proto, `scenario ${name} is registered`).toBeDefined();
    const scenario = freshScenario(proto!);
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      for (const id of [1, 2]) {
        const r = await fetch(serverUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': LEGACY
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'initialize',
            params: {
              protocolVersion: LEGACY,
              capabilities: {},
              clientInfo: { name: 'legacy-client', version: '1.0.0' }
            }
          })
        });
        expect(r.status).toBe(400);
        const body = (await r.json()) as {
          id: unknown;
          error?: { code: number; data?: unknown };
        };
        expect(body.id).toBe(id);
        expect(body.error).toMatchObject({
          code: -32022,
          data: { supported: [DRAFT_PROTOCOL_VERSION], requested: LEGACY }
        });
      }
    } finally {
      await scenario.stop();
    }
  });
});
