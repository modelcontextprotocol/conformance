/**
 * Shared helpers for SEP-2663 Tasks server-conformance scenarios.
 *
 * The SDK's `Client.connect()` pins `protocolVersion` to the package
 * constant `LATEST_PROTOCOL_VERSION` on the initialize body, which means
 * scenarios tagged `DRAFT_PROTOCOL_VERSION` would still negotiate the
 * previous stable on the wire — a draft-only server rejects with
 * `unsupported protocol version`. `initRawSession` below is the
 * SDK-free path: a raw fetch initialize that carries the draft version,
 * captures the session ID, sends `notifications/initialized`, and
 * exposes a small `RawSession` surface (request / requestFull /
 * notification / close) that's everything these scenarios actually use.
 *
 * Errors come back as `McpError` instances so existing `instanceof
 * McpError` and `.code` checks keep working unchanged.
 *
 * The `AnyResult` Zod schema is retained as an export for ad-hoc
 * passthrough validation; the raw session does not depend on it.
 */

import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
  DRAFT_PROTOCOL_VERSION,
  type ConformanceCheck,
  type SpecReference
} from '../../../types';

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
  session: RawSession,
  taskId: string,
  timeoutMs = 10_000
): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const task = (await session.request('tasks/get', { taskId })) as any;
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
  session: RawSession,
  taskId: string,
  status: string,
  timeoutMs = 10_000
): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const task = (await session.request('tasks/get', { taskId })) as any;
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

// ─── Raw session helper (initRawSession) ──────────────────────────────────────
//
// The SDK's Client.connect() posts initialize with a hardcoded
// LATEST_PROTOCOL_VERSION from the package. For scenarios tagged
// DRAFT_PROTOCOL_VERSION the SDK pin is wrong on the wire: strict
// draft-only servers reject the handshake with "unsupported protocol
// version". The raw helper below sidesteps the SDK: it lets scenarios
// negotiate any protocolVersion (default DRAFT_PROTOCOL_VERSION) and
// exposes the same minimal surface scenarios actually need —
// request, requestFull, notification, close — without dragging the
// SDK's typed-schema stripping into the picture (every SEP-2663 wire
// field already goes through AnyResult anyway).

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export interface RawSession {
  /** The session ID issued by the server on initialize (Mcp-Session-Id). */
  sessionId: string;

  /** The protocolVersion the server returned on initialize. */
  protocolVersion: string;

  /** The full initialize result (capabilities, serverInfo, instructions, ...). */
  initializeResult: Record<string, unknown>;

  /**
   * Send a JSON-RPC request and return the parsed `result` field. Throws
   * an McpError when the server returns an `error` frame, so existing
   * `if (e instanceof McpError) ...` and `if (e.code === ...)` checks
   * keep working unchanged.
   */
  request(
    method: string,
    params?: Record<string, unknown>,
    extraHeaders?: Record<string, string>
  ): Promise<Record<string, unknown>>;

  /**
   * Send a JSON-RPC request and return the full response (`result` OR
   * `error`). Use when a scenario needs to assert on the error shape
   * without throwing.
   */
  requestFull(
    method: string,
    params?: Record<string, unknown>,
    extraHeaders?: Record<string, string>
  ): Promise<JsonRpcResponse>;

  /** Send a JSON-RPC notification (no id, no response expected). */
  notification(method: string, params?: Record<string, unknown>): Promise<void>;

  /** Best-effort teardown: DELETE the session if the server supports it. */
  close(): Promise<void>;
}

export interface InitRawOptions {
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  clientInfo?: { name: string; version: string };
}

/**
 * Open a Streamable HTTP MCP session via raw fetch instead of the SDK's
 * Client.connect(). Scenarios tagged DRAFT_PROTOCOL_VERSION should use
 * this so the initialize body carries the draft version on the wire
 * rather than the SDK's pinned LATEST_PROTOCOL_VERSION.
 */
export async function initRawSession(
  serverUrl: string,
  opts: InitRawOptions = {}
): Promise<RawSession> {
  const protocolVersion = opts.protocolVersion ?? DRAFT_PROTOCOL_VERSION;
  const capabilities = opts.capabilities ?? {};
  const clientInfo = opts.clientInfo ?? {
    name: 'mcp-conformance',
    version: '1.0'
  };

  const initId = nextRawId();
  const initResp = await fetch(serverUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: initId,
      method: 'initialize',
      params: { protocolVersion, capabilities, clientInfo }
    })
  });

  const initBody = await readJsonRpcResponse(initResp, initId);
  if (initBody.error) {
    throw new McpError(
      initBody.error.code,
      initBody.error.message,
      initBody.error.data
    );
  }
  const initializeResult = initBody.result ?? {};

  // Streamable HTTP MUST issue Mcp-Session-Id on the initialize response.
  // Without it subsequent requests have nowhere to land.
  const sessionId = initResp.headers.get('mcp-session-id') || '';
  if (!sessionId) {
    throw new Error(
      'Server did not return Mcp-Session-Id on initialize response'
    );
  }

  const negotiated =
    typeof initializeResult.protocolVersion === 'string'
      ? (initializeResult.protocolVersion as string)
      : protocolVersion;

  const sessionHeaders = (): Record<string, string> => ({
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'Mcp-Session-Id': sessionId,
    'MCP-Protocol-Version': negotiated
  });

  const session: RawSession = {
    sessionId,
    protocolVersion: negotiated,
    initializeResult,

    async requestFull(method, params, extraHeaders) {
      const id = nextRawId();
      const resp = await fetch(serverUrl, {
        method: 'POST',
        headers: { ...sessionHeaders(), ...(extraHeaders ?? {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
      });
      return readJsonRpcResponse(resp, id);
    },

    async request(method, params, extraHeaders) {
      const body = await session.requestFull(method, params, extraHeaders);
      if (body.error) {
        throw new McpError(
          body.error.code,
          body.error.message,
          body.error.data
        );
      }
      return body.result ?? {};
    },

    async notification(method, params) {
      const resp = await fetch(serverUrl, {
        method: 'POST',
        headers: sessionHeaders(),
        body: JSON.stringify({ jsonrpc: '2.0', method, params })
      });
      // Notifications get 202 Accepted (no body) per spec. Drain to free
      // the socket; don't parse.
      try {
        await resp.text();
      } catch {
        /* swallow */
      }
    },

    async close() {
      try {
        await fetch(serverUrl, {
          method: 'DELETE',
          headers: {
            'Mcp-Session-Id': sessionId,
            'MCP-Protocol-Version': negotiated
          }
        });
      } catch {
        /* best-effort */
      }
    }
  };

  // Per spec, the client SHOULD send notifications/initialized after the
  // initialize result is observed. Servers that gate session-active state
  // on this notification (mcpkit does) need it before the first request.
  await session.notification('notifications/initialized');

  return session;
}

let rawIdCounter = 0;
function nextRawId(): number {
  rawIdCounter += 1;
  return rawIdCounter;
}

/**
 * Parse a JSON-RPC response from a Streamable HTTP response. Handles
 * both application/json and text/event-stream content types; in the SSE
 * case scans events until it finds the frame whose id matches the
 * expected id. Throws on malformed or empty responses.
 */
async function readJsonRpcResponse(
  resp: Response,
  expectedId: number | string
): Promise<JsonRpcResponse> {
  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/event-stream')) {
    const text = await resp.text();
    for (const block of text.split(/\n\n+/)) {
      const dataLines: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
      }
      if (dataLines.length === 0) continue;
      const payload = dataLines.join('\n');
      if (!payload.startsWith('{')) continue;
      const parsed = JSON.parse(payload) as JsonRpcResponse;
      if (parsed.id === expectedId && (parsed.result || parsed.error)) {
        return parsed;
      }
    }
    throw new Error(
      `No JSON-RPC frame with id=${expectedId} in SSE response (status ${resp.status})`
    );
  }
  // application/json (or anything else that yielded a JSON body)
  const body = (await resp.json()) as JsonRpcResponse;
  if (body.id !== expectedId) {
    throw new Error(
      `JSON-RPC id mismatch: expected ${expectedId}, got ${String(body.id)}`
    );
  }
  return body;
}
