import { describe, test, expect, afterEach } from 'vitest';
import { testContext } from '../../../connection/testing';
import { TasksLifecycleScenario } from './lifecycle';
import { DRAFT_PROTOCOL_VERSION } from '../../../types';
import type { ConformanceCheck } from '../../../types';

/**
 * Pins the untestable-failure policy (issue #248) for the SEP-2663 lifecycle
 * scenario: when no task is ever created, the downstream task checks must
 * fail with a "Not testable:" cause instead of reporting SKIPPED.
 */

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

function mockServer() {
  global.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    let result: any;
    if (body.method === 'server/discover') {
      result = {
        supportedVersions: [DRAFT_PROTOCOL_VERSION],
        capabilities: { tools: {} },
        serverInfo: { name: 'taskless-server', version: '1.0.0' }
      };
    } else if (body.method === 'tools/list') {
      result = { tools: [] };
    } else if (body.method === 'tools/call') {
      // Always answers synchronously: never creates a task.
      result = {
        resultType: 'complete',
        content: [{ type: 'text', text: 'sync answer' }]
      };
    } else {
      return {
        status: 404,
        headers: { get: () => 'application/json' },
        json: async () => ({
          jsonrpc: '2.0',
          id: body.id ?? null,
          error: { code: -32601, message: 'Method not found' }
        }),
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id ?? null,
            error: { code: -32601, message: 'Method not found' }
          })
      } as unknown as Response;
    }
    const payload = { jsonrpc: '2.0', id: body.id, result };
    return {
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => payload,
      text: async () => JSON.stringify(payload)
    } as unknown as Response;
  }) as typeof fetch;
  return 'http://mock-taskless-server.local';
}

describe('tasks-lifecycle — no task created', () => {
  test('downstream task checks fail as untestable instead of SKIPPED', async () => {
    const mockUrl = mockServer();
    const scenario = new TasksLifecycleScenario();
    const checks: ConformanceCheck[] = await scenario.run(
      testContext(mockUrl, DRAFT_PROTOCOL_VERSION)
    );

    const gated = checks.filter((c) =>
      c.errorMessage?.startsWith('Not testable:')
    );
    expect(gated.length).toBeGreaterThan(0);
    for (const check of gated) {
      expect(check.status).toBe('FAILURE');
      expect(check.details).toMatchObject({ untestable: true });
    }
    expect(checks.every((c) => c.status !== 'SKIPPED')).toBe(true);
  });
});
