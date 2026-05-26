/**
 * Stateless request helpers for server scenarios: stateless requests per
 * SEP-2575 plus the standard HTTP headers per SEP-2243.
 *
 * Every request the harness sends to a server under test has cross-cutting
 * obligations that are independent of whatever a scenario is actually testing:
 *
 * - `MCP-Protocol-Version` header on every POST, matching
 *   `_meta["io.modelcontextprotocol/protocolVersion"]` in the body
 * - `Mcp-Method` header mirroring the JSON-RPC `method`
 * - `Mcp-Name` header mirroring `params.name` (tools/call, prompts/get) or
 *   `params.uri` (resources/read)
 * - `_meta` carrying protocolVersion, clientInfo and clientCapabilities
 * - an `Accept` header listing both `application/json` and `text/event-stream`
 *
 * Scenarios that exercise these SEPs MUST build their requests through these
 * helpers so a strictly-conformant server never rejects harness traffic for
 * reasons unrelated to the behaviour under test (issues #311, #312, #315).
 * Negative tests can override or omit exactly the dimension they exercise via
 * the options. The advertised protocol version defaults to
 * `DRAFT_PROTOCOL_VERSION` and can be overridden per request.
 *
 * The harness's own conformance is enforced by
 * `src/scenarios/harness-traffic-conformance.test.ts`.
 */

import {
  DRAFT_PROTOCOL_VERSION,
  NEGOTIABLE_PROTOCOL_VERSIONS
} from '../../types';

// ─── JSON-RPC types ──────────────────────────────────────────────────────────

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

// ─── Defaults ────────────────────────────────────────────────────────────────

export const CONFORMANCE_CLIENT_INFO = {
  name: 'conformance-test-client',
  version: '1.0.0'
} as const;

export const DEFAULT_CLIENT_CAPABILITIES = {
  sampling: {},
  elicitation: {},
  roots: { listChanged: true }
} as const;

// ─── Options ─────────────────────────────────────────────────────────────────

export interface RequestHeaderOptions {
  /** Wire protocol version to advertise (header + _meta). */
  protocolVersion?: string;
  /** Extra or overriding headers (later wins; case preserved as given). */
  headers?: Record<string, string>;
  /** Default header names to drop entirely (case-insensitive). */
  omitHeaders?: string[];
}

export interface StatelessRequestOptions extends RequestHeaderOptions {
  /** JSON-RPC id; auto-incremented when omitted. */
  id?: number | string;
  /**
   * Extra `_meta` keys merged over the conformant defaults, or `false` to
   * omit `_meta` entirely (negative tests only). Keys already present in
   * `params._meta` also override the defaults.
   */
  meta?: Record<string, unknown> | false;
  /** Client capabilities advertised in `_meta`; defaults to all optional ones. */
  clientCapabilities?: Record<string, unknown>;
  /**
   * Retry once with a server-supported version when the request is rejected
   * as an unsupported protocol version (the spec SHOULD for clients).
   * Defaults to true.
   */
  retryOnUnsupportedVersion?: boolean;
  /** Abort the request after this many milliseconds. Defaults to 10s. */
  timeoutMs?: number;
}

export interface StatelessResponse {
  status: number;
  headers: Headers;
  contentType?: string;
  /**
   * The parsed JSON-RPC message: the JSON body, or — for `text/event-stream`
   * responses — the event matching the request id (falling back to the last
   * response-shaped event).
   */
  body?: JsonRpcResponse;
  /** All parsed events when the response was an SSE / chunked stream. */
  events?: unknown[];
  /** Raw response text when it could not be parsed as JSON. */
  text?: string;
  /** Populated when the request was retried after an unsupported-version 400. */
  versionRetry?: {
    rejectedStatus: number;
    rejectedError?: { code: number; message: string };
    retriedWith: string;
  };
}

let nextRequestId = 1;

// ─── Header construction ─────────────────────────────────────────────────────

/**
 * The `Mcp-Name` source field per SEP-2243: `params.name` for tools/call and
 * prompts/get, `params.uri` for resources/read; absent otherwise.
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
  return undefined;
}

/**
 * The protocol version a request's `_meta` would carry when the caller passes
 * an override via `options.meta` or `params._meta` (string overrides only).
 */
function metaProtocolVersionOverride(
  params?: Record<string, unknown>,
  meta?: Record<string, unknown> | false
): string | undefined {
  const fromOptions = meta
    ? meta['io.modelcontextprotocol/protocolVersion']
    : undefined;
  const fromParams = (params?._meta as Record<string, unknown> | undefined)?.[
    'io.modelcontextprotocol/protocolVersion'
  ];
  const override = fromOptions ?? fromParams;
  return typeof override === 'string' ? override : undefined;
}

/**
 * The single effective protocol version for a request: an explicit
 * `options.protocolVersion` wins, then a `_meta` override (from `options.meta`
 * or `params._meta`), then `DRAFT_PROTOCOL_VERSION`. The MCP-Protocol-Version
 * header and `_meta` are both built from this value so they always agree
 * unless the caller sets contradictory `headers`/`omitHeaders` overrides.
 */
function resolveProtocolVersion(
  params: Record<string, unknown> | undefined,
  options: StatelessRequestOptions
): string {
  return (
    options.protocolVersion ??
    metaProtocolVersionOverride(params, options.meta) ??
    DRAFT_PROTOCOL_VERSION
  );
}

/**
 * Build the conformant header set for a stateless request: Content-Type,
 * Accept (both content types), MCP-Protocol-Version, Mcp-Method and (when the
 * method carries one) Mcp-Name. Overrides win over defaults; omitHeaders
 * removes defaults entirely.
 */
export function buildStandardHeaders(
  method: string,
  params?: Record<string, unknown>,
  options: RequestHeaderOptions = {}
): Record<string, string> {
  const protocolVersion =
    options.protocolVersion ??
    metaProtocolVersionOverride(params) ??
    DRAFT_PROTOCOL_VERSION;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': protocolVersion,
    'Mcp-Method': method
  };
  const name = mcpNameForRequest(method, params);
  if (name !== undefined) {
    headers['Mcp-Name'] = name;
  }

  if (options.omitHeaders) {
    const omit = new Set(options.omitHeaders.map((h) => h.toLowerCase()));
    for (const key of Object.keys(headers)) {
      if (omit.has(key.toLowerCase())) delete headers[key];
    }
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

// ─── Body construction ───────────────────────────────────────────────────────

/** Build the conformant `_meta` object required on every stateless request. */
export function buildRequestMeta(
  overrides?: Record<string, unknown>,
  protocolVersion: string = DRAFT_PROTOCOL_VERSION,
  clientCapabilities: Record<string, unknown> = DEFAULT_CLIENT_CAPABILITIES
): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/protocolVersion': protocolVersion,
    'io.modelcontextprotocol/clientInfo': CONFORMANCE_CLIENT_INFO,
    'io.modelcontextprotocol/clientCapabilities': clientCapabilities,
    ...overrides
  };
}

/** Merge params with the conformant `_meta` (or omit it when meta === false). */
export function withRequestMeta(
  params: Record<string, unknown> | undefined,
  options: StatelessRequestOptions = {}
): Record<string, unknown> | undefined {
  if (options.meta === false) {
    return params;
  }
  const protocolVersion = resolveProtocolVersion(params, options);
  return {
    ...params,
    _meta: buildRequestMeta(
      {
        ...(params?._meta as Record<string, unknown> | undefined),
        ...(options.meta ?? undefined),
        // An explicit options.protocolVersion wins over any meta override so
        // the MCP-Protocol-Version header and `_meta` always agree.
        ...(options.protocolVersion !== undefined
          ? {
              'io.modelcontextprotocol/protocolVersion': options.protocolVersion
            }
          : {})
      },
      protocolVersion,
      options.clientCapabilities ?? DEFAULT_CLIENT_CAPABILITIES
    )
  };
}

// ─── Response parsing ────────────────────────────────────────────────────────

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
 * the JSON-RPC response matching `requestId` arrives — without waiting for the
 * server to close the stream. If the stream ends (or the request is aborted)
 * before a matching event is seen, returns whatever events were parsed, with
 * `body` set to the last response-shaped event if any.
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

// Error codes a server may use to reject an unsupported protocol version:
// -32004 is the dedicated UnsupportedProtocolVersionError code in the draft
// schema; -32001 and -32602 are tolerated for servers that predate it.
const UNSUPPORTED_VERSION_ERROR_CODES = new Set([-32004, -32001, -32602]);

function parseUnsupportedVersionRejection(
  status: number,
  body: JsonRpcResponse | undefined
): { supported: string[] } | undefined {
  if (status !== 400 || !body?.error) return undefined;
  if (!UNSUPPORTED_VERSION_ERROR_CODES.has(body.error.code)) return undefined;
  const data = body.error.data as { supported?: unknown } | undefined;
  if (!Array.isArray(data?.supported) || data.supported.length === 0) {
    return undefined;
  }
  const supported = data.supported.filter(
    (v): v is string => typeof v === 'string'
  );
  return supported.length > 0 ? { supported } : undefined;
}

/**
 * Pick the version to retry with after an unsupported-version rejection. Only
 * versions the harness recognizes are eligible; returns undefined (no retry)
 * when the server's supported list has no usable entry.
 */
function pickRetryVersion(
  requested: string,
  supported: string[]
): string | undefined {
  if (supported.includes(requested)) return requested;
  if (supported.includes(DRAFT_PROTOCOL_VERSION)) return DRAFT_PROTOCOL_VERSION;
  return supported.find((v) => NEGOTIABLE_PROTOCOL_VERSIONS.includes(v));
}

// ─── Requests ────────────────────────────────────────────────────────────────

/**
 * Send a single stateless JSON-RPC request with the full set of cross-cutting
 * headers and `_meta`. Handles both JSON and SSE responses and (by default)
 * retries once with a mutually supported version when the server rejects the
 * advertised protocol version.
 */
export async function sendStatelessRequest(
  serverUrl: string,
  method: string,
  params?: Record<string, unknown>,
  options: StatelessRequestOptions = {}
): Promise<StatelessResponse> {
  const id = options.id ?? nextRequestId++;
  const response = await sendOnce(serverUrl, method, params, options, id);

  if (options.retryOnUnsupportedVersion === false) {
    return response;
  }
  const rejection = parseUnsupportedVersionRejection(
    response.status,
    response.body
  );
  if (!rejection) {
    return response;
  }
  const requested = resolveProtocolVersion(params, options);
  const retryVersion = pickRetryVersion(requested, rejection.supported);
  if (!retryVersion) {
    // The server offered no version the harness recognizes — surface the
    // original rejection rather than guessing.
    return response;
  }
  const retried = await sendOnce(
    serverUrl,
    method,
    params,
    { ...options, protocolVersion: retryVersion },
    id
  );
  retried.versionRetry = {
    rejectedStatus: response.status,
    rejectedError: response.body?.error
      ? {
          code: response.body.error.code,
          message: response.body.error.message
        }
      : undefined,
    retriedWith: retryVersion
  };
  return retried;
}

async function sendOnce(
  serverUrl: string,
  method: string,
  params: Record<string, unknown> | undefined,
  options: StatelessRequestOptions,
  id: number | string
): Promise<StatelessResponse> {
  const protocolVersion = resolveProtocolVersion(params, options);
  const headers = buildStandardHeaders(method, params, {
    ...options,
    protocolVersion
  });
  const enrichedParams = withRequestMeta(params, options);
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    ...(enrichedParams !== undefined ? { params: enrichedParams } : {})
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
