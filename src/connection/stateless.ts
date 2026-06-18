/**
 * Stateless connection: 2026-x lifecycle (SEP-2575).
 *
 * No handshake. Every request carries `_meta` with protocolVersion, clientInfo,
 * and clientCapabilities, plus the standard headers (MCP-Protocol-Version,
 * Mcp-Method, Mcp-Name per SEP-2243). Implemented with raw fetch so the
 * conformance suite can test draft spec versions before the SDK supports them.
 *
 * Exports two layers:
 * - `sendStatelessRequest()` — low-level: returns `{status, headers, body,
 *   events}` and never throws on JSON-RPC errors. Scenarios that assert on
 *   HTTP status or error codes use this directly.
 * - `connectStateless()` — high-level: a `Connection` whose `request()` calls
 *   `sendStatelessRequest()` and throws `JsonRpcError` on error responses.
 *   The runner picks this via `connectFor()` for `--spec-version draft`.
 *
 * Both build their requests through `buildStandardHeaders()` and
 * `withRequestMeta()` so a strictly-conformant server never rejects harness
 * traffic for reasons unrelated to the behaviour under test
 * (issues #311, #312, #315).
 */

import { DRAFT_PROTOCOL_VERSION, type SpecVersion } from '../types';
import type { JSONRPCNotification } from '../spec-types/2025-11-25';
import { JsonRpcError, type Connection, type ConnectOptions } from './index';

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export const CONFORMANCE_CLIENT_INFO = {
  name: 'conformance-test-client',
  version: '1.0.0'
} as const;

export const DEFAULT_CLIENT_CAPABILITIES = {
  sampling: {},
  elicitation: {},
  roots: { listChanged: true }
} as const;

export interface StatelessResponse {
  status: number;
  headers: Headers;
  contentType?: string;
  /** The parsed JSON-RPC message (for SSE: the event matching the request id). */
  body?: JsonRpcResponse;
  /** All parsed events when the response was an SSE / chunked stream. */
  events?: unknown[];
  /** Raw response text when it could not be parsed as JSON. */
  text?: string;
}

let nextRequestId = 1;

/**
 * The `Mcp-Name` source field per SEP-2243: `params.name` for tools/call and
 * prompts/get, `params.uri` for resources/read, `params.taskId` for the
 * SEP-2663 tasks methods (`tasks/get`, `tasks/update`, `tasks/cancel`).
 * Absent otherwise.
 */
export function mcpNameForRequest(
  method: string,
  params?: Record<string, unknown>
): string | undefined {
  if (method === 'tools/call' || method === 'prompts/get') {
    return typeof params?.name === 'string' ? params.name : undefined;
  }
  if (method === 'resources/read') {
    return typeof params?.uri === 'string' ? params.uri : undefined;
  }
  if (
    method === 'tasks/get' ||
    method === 'tasks/update' ||
    method === 'tasks/cancel'
  ) {
    return typeof params?.taskId === 'string' ? params.taskId : undefined;
  }
  return undefined;
}

/**
 * Build the conformant header set for a stateless request: Content-Type,
 * Accept (both content types), MCP-Protocol-Version, Mcp-Method and (when the
 * method carries one) Mcp-Name. `options.headers` overrides or extends the
 * defaults, replacing any default whose name matches case-insensitively.
 * `options.specVersion` sets the MCP-Protocol-Version header (default: draft),
 * so scenarios can send the spec version the run was invoked with.
 */
export function buildStandardHeaders(
  method: string,
  params?: Record<string, unknown>,
  options: { headers?: Record<string, string>; specVersion?: SpecVersion } = {}
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': options.specVersion ?? DRAFT_PROTOCOL_VERSION,
    'Mcp-Method': method
  };
  const name = mcpNameForRequest(method, params);
  if (name !== undefined) {
    headers['Mcp-Name'] = name;
  }

  if (options.headers) {
    for (const [key, value] of Object.entries(options.headers)) {
      // Replace any default that differs only by case, then set the override.
      for (const existing of Object.keys(headers)) {
        if (existing.toLowerCase() === key.toLowerCase()) {
          delete headers[existing];
        }
      }
      headers[key] = value;
    }
  }

  return headers;
}

/**
 * Merge params with the conformant `_meta` required on every stateless
 * request. Keys already present in `params._meta` win over the defaults.
 * `specVersion` sets the declared protocolVersion (default: draft).
 */
export function withRequestMeta(
  params?: Record<string, unknown>,
  specVersion: SpecVersion = DRAFT_PROTOCOL_VERSION
): Record<string, unknown> {
  return {
    ...params,
    _meta: {
      'io.modelcontextprotocol/protocolVersion': specVersion,
      'io.modelcontextprotocol/clientInfo': CONFORMANCE_CLIENT_INFO,
      'io.modelcontextprotocol/clientCapabilities': DEFAULT_CLIENT_CAPABILITIES,
      ...(params?._meta as Record<string, unknown> | undefined)
    }
  };
}

function isJsonRpcResponseShaped(event: unknown): event is JsonRpcResponse {
  return (
    typeof event === 'object' &&
    event !== null &&
    ('result' in event || 'error' in event)
  );
}

function parseSseLineInto(events: unknown[], rawLine: string): void {
  const line = rawLine.trim();
  if (!line) return;
  const jsonText = line.startsWith('data:')
    ? line.replace(/^data:\s*/, '')
    : line;
  try {
    events.push(JSON.parse(jsonText));
  } catch {
    // Non-JSON line (comments, partial frames) — ignore.
  }
}

/**
 * Read an SSE / chunked-stream response incrementally and resolve as soon as
 * the JSON-RPC response matching `requestId` arrives, without waiting for the
 * stream to close. If the stream ends (or is aborted) first, returns whatever
 * events were parsed, with `body` set to the last response-shaped event.
 */
export async function readSseJsonRpcResponse(
  res: Response,
  requestId: number | string | null
): Promise<{ events: unknown[]; body?: JsonRpcResponse }> {
  const events: unknown[] = [];
  const matchesRequest = (event: unknown): event is JsonRpcResponse =>
    isJsonRpcResponseShaped(event) && event.id === requestId;
  const finish = (): { events: unknown[]; body?: JsonRpcResponse } => {
    const match = events.find(matchesRequest);
    const lastResponseShaped = [...events]
      .reverse()
      .find(isJsonRpcResponseShaped);
    return { events, body: match ?? lastResponseShaped };
  };

  if (!res.body) return finish();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      let value: Uint8Array | undefined;
      let done = false;
      try {
        ({ value, done } = await reader.read());
      } catch {
        // The stream was aborted (timeout) or dropped — return what arrived.
        break;
      }

      if (value) {
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) parseSseLineInto(events, line);

        if (events.some(matchesRequest)) {
          // The response we were waiting for arrived; stop reading the stream.
          await reader.cancel().catch(() => {});
          break;
        }
      }

      if (done) {
        parseSseLineInto(events, buffer);
        buffer = '';
        break;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Lock already released (e.g. after cancel) — nothing to do.
    }
  }

  return finish();
}

/**
 * Send a single stateless JSON-RPC request with the full set of cross-cutting
 * headers and `_meta`. Handles both JSON and SSE responses.
 */
export async function sendStatelessRequest(
  serverUrl: string,
  method: string,
  params?: Record<string, unknown>,
  options: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    specVersion?: SpecVersion;
  } = {}
): Promise<StatelessResponse> {
  const id = nextRequestId++;
  const headers = buildStandardHeaders(method, params, {
    headers: options.headers,
    specVersion: options.specVersion
  });
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params: withRequestMeta(params, options.specVersion)
  });

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 10000
  );
  try {
    const res = await fetch(serverUrl, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal
    });

    const contentType = res.headers.get('content-type') ?? undefined;

    if (contentType?.includes('text/event-stream')) {
      // Read the stream incrementally and resolve on the matching response —
      // a server that keeps the stream open must not stall the harness.
      const { events, body: matched } = await readSseJsonRpcResponse(res, id);
      return {
        status: res.status,
        headers: res.headers,
        contentType,
        events,
        body: matched
      };
    }

    const text = await res.text();
    try {
      return {
        status: res.status,
        headers: res.headers,
        contentType,
        body: text ? (JSON.parse(text) as JsonRpcResponse) : undefined
      };
    } catch {
      return { status: res.status, headers: res.headers, contentType, text };
    }
  } finally {
    clearTimeout(timeout);
    // Tear down any still-open SSE stream so sockets don't linger.
    controller.abort();
  }
}

/**
 * `Connection` impl for the 2026-x stateless lifecycle. Thin wrapper over
 * `sendStatelessRequest()`: classifies SSE-stream events into the notification
 * sink, surfaces server→client *requests* on the response stream as a spec
 * violation, and throws `JsonRpcError` on error responses.
 *
 * Session bootstrap on the stateless wire is `server/discover` (SEP-2575's
 * replacement for `initialize`). The result is exposed via
 * `connection.discover()` so scenarios can inspect server capabilities,
 * serverInfo, and supported protocol versions.
 */
export async function connectStateless(
  serverUrl: string,
  specVersion: SpecVersion = DRAFT_PROTOCOL_VERSION,
  opts: ConnectOptions = {}
): Promise<Connection> {
  const notifications: JSONRPCNotification[] = [];
  const capabilities = opts.capabilities ?? DEFAULT_CLIENT_CAPABILITIES;
  const clientInfo = opts.clientInfo ?? CONFORMANCE_CLIENT_INFO;

  // The Connection layer is the single place that knows about
  // connect-time capabilities / clientInfo. We fold them into the
  // request's `_meta` here (the trailing `params._meta` spread in
  // `withRequestMeta` lets us override its defaults) so that
  // `sendStatelessRequest` and `withRequestMeta` keep their upstream
  // signatures untouched.
  function withConnectMeta(
    params?: Record<string, unknown>
  ): Record<string, unknown> {
    return {
      ...params,
      _meta: {
        'io.modelcontextprotocol/clientCapabilities': capabilities,
        'io.modelcontextprotocol/clientInfo': clientInfo,
        ...(params?._meta as Record<string, unknown> | undefined)
      }
    };
  }

  async function send(
    method: string,
    params?: Record<string, unknown>,
    extraHeaders?: Record<string, string>
  ): Promise<StatelessResponse> {
    return sendStatelessRequest(serverUrl, method, withConnectMeta(params), {
      specVersion,
      headers: extraHeaders
    });
  }

  function drainEvents(response: StatelessResponse): void {
    for (const event of response.events ?? []) {
      if (typeof event !== 'object' || event === null) continue;
      if ('method' in event && !('id' in event)) {
        notifications.push(event as JSONRPCNotification);
      } else if ('method' in event && 'id' in event) {
        throw new JsonRpcError(
          -32600,
          `Server sent request '${(event as { method: string }).method}' on response stream; stateless lifecycle forbids this (use MRTR)`
        );
      }
    }
  }

  function unwrap<R>(method: string, response: StatelessResponse): R {
    const rpcError = response.body?.error;
    // Only a properly-shaped JSON-RPC error becomes a JsonRpcError; anything
    // else (e.g. a proxy's `{"error": "upstream timeout"}`) falls through so
    // the HTTP status and raw body are surfaced below.
    if (
      typeof rpcError === 'object' &&
      rpcError !== null &&
      typeof rpcError.code === 'number'
    ) {
      throw new JsonRpcError(rpcError.code, rpcError.message, rpcError.data);
    }
    if (response.body?.result === undefined) {
      throw new Error(
        `HTTP ${response.status}: ` +
          `expected a JSON-RPC result for '${method}', got ` +
          (response.text !== undefined
            ? `non-JSON body (content-type ${response.contentType ?? '(none)'})`
            : response.body !== undefined
              ? `unexpected body ${JSON.stringify(response.body)}`
              : 'no result in response body')
      );
    }
    return response.body.result as R;
  }

  // SEP-2575 has no required handshake. `_meta.clientCapabilities` on
  // every request is authoritative per spec, so `server/discover` is
  // strictly a client-side query ("what does the server advertise?").
  // We deliberately do NOT run it eagerly — a server that ignores
  // per-request `_meta` until a prior `server/discover` has registered
  // the session is non-conformant, and the conformance suite's job is
  // to surface that, not paper over it.
  let discoverPromise: Promise<Record<string, unknown>> | undefined;

  async function request<R>(
    method: string,
    params?: Record<string, unknown>,
    extraHeaders?: Record<string, string>
  ): Promise<R> {
    const response = await send(method, params, extraHeaders);
    drainEvents(response);
    return unwrap<R>(method, response);
  }

  return {
    notifications,
    discover(): Promise<Record<string, unknown>> {
      return (discoverPromise ??=
        request<Record<string, unknown>>('server/discover'));
    },
    request,
    close: async () => {}
  };
}
