/**
 * Tasks-specific helpers for SEP-2663 server-conformance scenarios.
 *
 *   - `TASKS_EXTENSION_ID`: the extension identifier scenarios assert
 *     when checking server capabilities.
 *   - `validTasksParams`: well-formed body shapes for negative-path
 *     checks that need to isolate a single failure dimension.
 *   - `waitForTerminal` / `waitForStatus`: tasks/get polling loops.
 */

import type { Connection } from '../../../connection';

export const TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks';

/**
 * Baseline "otherwise well-formed" params for a tasks-namespace
 * method, used by negative-path checks that need to isolate a single
 * failure dimension.
 *
 * When a check asserts a specific JSON-RPC error code (e.g. -32601
 * for a removed method, -32602 for an unknown taskId), the rest of
 * the request MUST be valid — otherwise a spec-compliant server can
 * reject for a different reason (missing routing headers, missing
 * `_meta`, malformed params) and the assertion fires on the wrong
 * dimension, producing misleading conformance results.
 *
 * The Connection already auto-populates SEP-2243 routing headers
 * and the SEP-2322 `_meta` envelope based on the method and params,
 * so this helper's job is to supply a sensible *body* — a params
 * object whose shape would be acceptable on the v1 surface — and
 * let the caller mutate exactly the field under test.
 *
 * Example:
 *
 *   // tasks/result is removed in v2; everything else is valid, so
 *   // -32601 is the only error that can fire on a compliant server.
 *   await conn.request('tasks/result', validTasksParams('tasks/result'));
 *
 *   // tasks/get with an unknown taskId — the taskId is the property
 *   // under test; the rest of the envelope is valid.
 *   await conn.request(
 *     'tasks/get',
 *     validTasksParams('tasks/get', { taskId: 'nonexistent-12345' })
 *   );
 */
export function validTasksParams(
  method: string,
  overrides?: Record<string, unknown>
): Record<string, unknown> {
  const probeTaskId = 'tasks-conformance-isolation-probe';
  let base: Record<string, unknown>;
  switch (method) {
    case 'tasks/result': // v1 shape: { taskId }
    case 'tasks/get':
    case 'tasks/cancel':
      base = { taskId: probeTaskId };
      break;
    case 'tasks/update':
      base = { taskId: probeTaskId, inputResponses: {} };
      break;
    case 'tasks/list': // v1 shape: optional { cursor? }
      base = {};
      break;
    default:
      base = {};
  }
  return { ...base, ...(overrides ?? {}) };
}

/** Poll tasks/get until the task reaches a terminal state. */
export async function waitForTerminal(
  conn: Connection,
  taskId: string,
  timeoutMs = 10_000
): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const task = (await conn.request('tasks/get', { taskId })) as any;
    if (['completed', 'failed', 'cancelled'].includes(task.status)) {
      return task;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `Task ${taskId} did not reach terminal state within ${timeoutMs}ms`
  );
}

/** Poll tasks/get until a specific status (or any terminal state). */
export async function waitForStatus(
  conn: Connection,
  taskId: string,
  status: string,
  timeoutMs = 10_000
): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const task = (await conn.request('tasks/get', { taskId })) as any;
    if (
      task.status === status ||
      ['completed', 'failed', 'cancelled'].includes(task.status)
    ) {
      return task;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `Task ${taskId} did not reach status ${status} within ${timeoutMs}ms`
  );
}
