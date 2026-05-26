/**
 * Stateless draft-spec request helpers for server scenarios.
 *
 * The draft spec makes the protocol stateless (SEP-2575) and standardizes the
 * HTTP header layer (SEP-2243). Every request the harness sends to a server
 * under test therefore has cross-cutting obligations that are independent of
 * whatever a scenario is actually testing:
 *
 * - `MCP-Protocol-Version` header on every POST, matching
 *   `_meta["io.modelcontextprotocol/protocolVersion"]` in the body
 * - `Mcp-Method` header mirroring the JSON-RPC `method`
 * - `Mcp-Name` header mirroring `params.name` (tools/call, prompts/get) or
 *   `params.uri` (resources/read)
 * - `_meta` carrying protocolVersion, clientInfo and clientCapabilities
 * - an `Accept` header listing both `application/json` and `text/event-stream`
 *
 * Draft scenarios MUST build their requests through these helpers so a
 * strictly-conformant server never rejects harness traffic for reasons
 * unrelated to the behaviour under test (issues #311, #312, #315). Negative
 * tests can override or omit exactly the dimension they exercise via the
 * options.
 *
 * The harness's own conformance is enforced by
 * `src/scenarios/draft-self-conformance.test.ts`.
 */

import { DRAFT_PROTOCOL_VERSION } from '../../types';

// ─── JSON-RPC types ──────────────────────────────────────────────────────────

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DRAFT_CLIENT_INFO = {
  name: 'conformance-test-client',
  version: '1.0.0'
} as const;

export const DRAFT_CLIENT_CAPABILITIES = {
  sampling: {},
  elicitation: {},
  roots: { listChanged: true }
} as const;

// ─── Options ─────────────────────────────────────────────────────────────────

export interface DraftHeaderOptions {
  /** Wire protocol version to advertise (header + _meta). */
  protocolVersion?: string;
  /** Extra or overriding headers (later wins; case preserved as given). */
  headers?: Record<string, string>;
  /** Default header names to drop entirely (case-insensitive). */
  omitHeaders?: string[];
}

export interface DraftRequestOptions extends DraftHeaderOptions {
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

export interface DraftResponse {
  status: number;
  headers: Headers;
  contentType?: string;
  /**
   * The parsed JSON-RPC message: the JSON body, or — for `text/event-stream`
   * responses — the event matching the request id (falling back to the last
   * parsed event).
   */
  body?: JsonRpcResponse;
  /** All parsed events when the response was an SSE / chunked stream. */
  events?: unknown[];
  /** Raw response text when it could not be parsed as JSON. */
  text?: string;
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
 * Build the conformant header set for a draft request: Content-Type, Accept
 * (both content types), MCP-Protocol-Version, Mcp-Method and (when the method
 * carries one) Mcp-Name. Overrides win over defaults; omitHeaders removes
 * defaults entirely.
 */
export function buildDraftHeaders(
  method: string,
  params?: Record<string, unknown>,
  options: DraftHeaderOptions = {}
): Record<string, string> {
  const protocolVersion = options.protocolVersion ?? DRAFT_PROTOCOL_VERSION;
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

/** Build the conformant `_meta` object required on every draft request. */
export function buildDraftMeta(
  overrides?: Record<string, unknown>,
  protocolVersion: string = DRAFT_PROTOCOL_VERSION,
  clientCapabilities: Record<string, unknown> = DRAFT_CLIENT_CAPABILITIES
): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/protocolVersion': protocolVersion,
    'io.modelcontextprotocol/clientInfo': DRAFT_CLIENT_INFO,
    'io.modelcontextprotocol/clientCapabilities': clientCapabilities,
    ...overrides
  };
}

/** Merge params with the conformant `_meta` (or omit it when meta === false). */
export function buildDraftParams(
  params: Record<string, unknown> | undefined,
  options: DraftRequestOptions = {}
): Record<string, unknown> | undefined {
  if (options.meta === false) {
    return params;
  }
  const protocolVersion = options.protocolVersion ?? DRAFT_PROTOCOL_VERSION;
  return {
    ...params,
    _meta: buildDraftMeta(
      {
        ...(params?._meta as Record<string, unknown> | undefined),
        ...(options.meta ?? undefined)
      },
      protocolVersion,
      options.clientCapabilities ?? DRAFT_CLIENT_CAPABILITIES
    )
  };
}

// ─── Response parsing ────────────────────────────────────────────────────────

function parseSseEvents(text: string): unknown[] {
  const events: unknown[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const jsonText = line.startsWith('data:')
      ? line.replace(/^data:\s*/, '')
      : line;
    try {
      events.push(JSON.parse(jsonText));
    } catch {
      // Non-JSON line (comments, partial frames) — ignore.
    }
  }
  return events;
}

function isUnsupportedVersionRejection(
  status: number,
  body: JsonRpcResponse | undefined
): string[] | undefined {
  if (status !== 400 || !body?.error) return undefined;
  const data = body.error.data as { supported?: unknown } | undefined;
  if (Array.isArray(data?.supported) && data.supported.length > 0) {
    return data.supported.filter((v): v is string => typeof v === 'string');
  }
  return undefined;
}

// ─── Requests ────────────────────────────────────────────────────────────────

/**
 * Send a single stateless draft JSON-RPC request with the full set of
 * cross-cutting headers and `_meta`. Handles both JSON and SSE responses and
 * (by default) retries once with a mutually supported version when the server
 * rejects the advertised protocol version.
 */
export async function sendDraftRequest(
  serverUrl: string,
  method: string,
  params?: Record<string, unknown>,
  options: DraftRequestOptions = {}
): Promise<DraftResponse> {
  const id = options.id ?? nextRequestId++;
  const response = await sendOnce(serverUrl, method, params, options, id);

  if (options.retryOnUnsupportedVersion === false) {
    return response;
  }
  const supported = isUnsupportedVersionRejection(
    response.status,
    response.body
  );
  if (!supported) {
    return response;
  }
  const requested = options.protocolVersion ?? DRAFT_PROTOCOL_VERSION;
  const retryVersion = supported.includes(requested)
    ? requested
    : supported.includes(DRAFT_PROTOCOL_VERSION)
      ? DRAFT_PROTOCOL_VERSION
      : supported[0];
  return sendOnce(
    serverUrl,
    method,
    params,
    { ...options, protocolVersion: retryVersion },
    id
  );
}

async function sendOnce(
  serverUrl: string,
  method: string,
  params: Record<string, unknown> | undefined,
  options: DraftRequestOptions,
  id: number | string
): Promise<DraftResponse> {
  const headers = buildDraftHeaders(method, params, options);
  const enrichedParams = buildDraftParams(params, options);
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
    const text = await res.text();

    if (contentType?.includes('text/event-stream')) {
      const events = parseSseEvents(text);
      const match = events.find(
        (e): e is JsonRpcResponse =>
          typeof e === 'object' &&
          e !== null &&
          (e as JsonRpcResponse).id === id &&
          ('result' in e || 'error' in e)
      );
      const last = events.length > 0 ? events[events.length - 1] : undefined;
      return {
        status: res.status,
        headers: res.headers,
        contentType,
        events,
        body: (match ?? last) as JsonRpcResponse | undefined
      };
    }

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
  }
}
