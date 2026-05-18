/**
 * Shared helpers for SEP-2663 Tasks server-conformance scenarios.
 *
 * Most of what scenarios need is already in the official MCP TS SDK:
 *   - new Client(...) + StreamableHTTPClientTransport for connection
 *   - client.request(req, schema) for typed JSON-RPC calls
 *   - McpError with .code / .data for JSON-RPC errors
 *
 * This file holds:
 *   - SEP reference constants used by every scenario's specReferences
 *   - Tiny check builders (errMsg / failureCheck / skipCheck) used by
 *     all scenarios for consistent FAILURE / SKIPPED reporting
 *   - Polling helpers (waitForTerminal / waitForStatus) wrapping
 *     `client.request('tasks/get', AnyResult)`
 *   - The `AnyResult` Zod passthrough schema — pair with
 *     `client.request(req, AnyResult)` to preserve fields the SDK's
 *     typed result schemas would strip (`resultType`, `taskId`,
 *     `requestState`, inlined `result`/`error`, etc.)
 *
 * Scenarios that need transport-level access (HTTP request-header
 * injection for SEP-2243; raw SSE event reading for status
 * notifications) keep their own inline raw fetch — SDK doesn't expose
 * those layers. See headers.ts / notifications.ts.
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';

import type { ConformanceCheck, SpecReference } from '../../../types';

export const TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks';

export const SEP_2663_REF: SpecReference = {
  id: 'SEP-2663',
  url: 'https://github.com/modelcontextprotocol/specification/pull/2663'
};
export const SEP_2322_REF: SpecReference = {
  id: 'SEP-2322',
  url: 'https://github.com/modelcontextprotocol/specification/pull/2322'
};
export const SEP_2243_REF: SpecReference = {
  id: 'SEP-2243',
  url: 'https://github.com/modelcontextprotocol/specification/pull/2243'
};
export const SEP_2575_REF: SpecReference = {
  id: 'SEP-2575',
  url: 'https://github.com/modelcontextprotocol/specification/pull/2575'
};

/**
 * Zod passthrough schema. Pair with `client.request(req, AnyResult)` to
 * preserve fields the SDK's typed result schemas would strip — every
 * SEP-2663 / SEP-2322 wire field falls into this bucket today.
 */
export const AnyResult = z.object({}).passthrough();

export function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Build a FAILURE check from a thrown error, preserving id/name/description. */
export function failureCheck(
  id: string,
  name: string,
  description: string,
  error: unknown,
  specReferences: SpecReference[]
): ConformanceCheck {
  return {
    id,
    name,
    description,
    status: 'FAILURE',
    timestamp: new Date().toISOString(),
    errorMessage: errMsg(error),
    specReferences
  };
}

/** Build a SKIPPED check (preserves id stability so Ctrl+F still finds it). */
export function skipCheck(
  id: string,
  name: string,
  description: string,
  reason: string,
  specReferences: SpecReference[] = [SEP_2663_REF]
): ConformanceCheck {
  return {
    id,
    name,
    description,
    status: 'SKIPPED',
    timestamp: new Date().toISOString(),
    errorMessage: `Skipped: ${reason}`,
    specReferences
  };
}

/** Poll tasks/get until the task reaches a terminal state. */
export async function waitForTerminal(
  client: Client,
  taskId: string,
  timeoutMs = 10_000
): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const task = (await client.request(
      { method: 'tasks/get', params: { taskId } },
      AnyResult
    )) as any;
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
  client: Client,
  taskId: string,
  status: string,
  timeoutMs = 10_000
): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const task = (await client.request(
      { method: 'tasks/get', params: { taskId } },
      AnyResult
    )) as any;
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
