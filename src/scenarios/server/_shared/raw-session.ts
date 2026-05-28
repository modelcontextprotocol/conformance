/**
 * Raw HTTP session helper for server-conformance scenarios.
 *
 * The MCP TS SDK's `Client.connect()` pins `protocolVersion` to the
 * package constant `LATEST_PROTOCOL_VERSION` on the initialize body,
 * which means scenarios tagged `DRAFT_PROTOCOL_VERSION` would still
 * negotiate the previous stable on the wire — a draft-only server
 * rejects with `unsupported protocol version`. `initRawSession` below
 * is the SDK-free path: a raw fetch initialize that carries the draft
 * version, captures the session ID, sends `notifications/initialized`,
 * and exposes a small `RawSession` surface (request / requestFull /
 * notification / close) that's everything these scenarios actually
 * use. Errors come back as `McpError` instances so existing
 * `instanceof McpError` and `.code` checks keep working unchanged.
 *
 * Two wires:
 *   - legacy: POST initialize → capture `Mcp-Session-Id` → send
 *     follow-ups with the session header + `MCP-Protocol-Version`
 *   - stateless (SEP-2575): no initialize, no session id, every body
 *     carries a `_meta.io.modelcontextprotocol/{protocolVersion,
 *     clientInfo, clientCapabilities}` envelope and every request
 *     emits the `MCP-Protocol-Version` HTTP header.
 *
 * Lives in `_shared/` so any server suite (tasks, mrtr, ...) can
 * import the same primitives.
 */

import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { createParser } from 'eventsource-parser';

import { DRAFT_PROTOCOL_VERSION } from '../../../types';

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export interface RawSession {
  /**
   * The wire mode this session speaks. `legacy` uses the
   * initialize+Mcp-Session-Id handshake; `stateless` uses the SEP-2575
   * per-request `_meta` envelope. Most scenarios are wire-agnostic,
   * but a handful (capability negotiation, request headers) need to
   * branch on this flag.
   */
  wire: 'legacy' | 'stateless';

  /**
   * The session ID issued by the server on initialize (legacy wire).
   * Empty on the stateless wire — there is no session id.
   */
  sessionId: string;

  /** The protocolVersion negotiated (legacy) or pinned (stateless). */
  protocolVersion: string;

  /**
   * Server-advertised capabilities. On the legacy wire this comes from
   * the `initialize` response; on the stateless wire from
   * `server/discover`. Scenarios that want to inspect what the server
   * declares should read this regardless of mode.
   */
  serverCapabilities: Record<string, unknown>;

  /**
   * The full handshake result. Legacy: `initialize` response. Stateless:
   * `server/discover` response. Kept as a raw object so scenarios can
   * inspect serverInfo / instructions / extensions / etc.
   */
  initializeResult: Record<string, unknown>;

  /**
   * Cache of `tool name → inputSchema` populated by an initial
   * `tools/list` call after the handshake. Drives SEP-2243
   * §"Custom Headers from Tool Parameters" — when the schema marks a
   * property with `x-mcp-header`, the corresponding `tools/call`
   * argument value is mirrored as an `Mcp-Param-*` HTTP header. Empty
   * when the server has no tools or rejects `tools/list`.
   */
  toolSchemas: Map<string, unknown>;

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

  /**
   * When true, use the SEP-2575 stateless wire: no initialize handshake,
   * no Mcp-Session-Id, every request body carries the
   * `_meta.io.modelcontextprotocol/{protocolVersion, clientInfo,
   * clientCapabilities}` envelope. The handshake step is replaced by an
   * initial `server/discover` call so scenarios that inspect
   * server-advertised capabilities still have a populated
   * `serverCapabilities`.
   *
   * When false (default), use the legacy session wire: initialize +
   * notifications/initialized + Mcp-Session-Id on follow-up calls. No
   * `_meta` injection.
   *
   * Independent of wire mode, the `MCP-Protocol-Version` HTTP header is
   * sent on every post-initialize request — MCP 2025-11-25 mandates it
   * on every subsequent POST/GET regardless of wire.
   *
   * Both wires are required to pass the same SEP-2663 / SEP-2322 tasks
   * scenarios since tasks behavior is wire-independent. The default
   * harness loops over both modes per scenario.
   */
  stateless?: boolean;
}

/**
 * Open a session against one of two MCP wires. With `stateless: false`
 * (default), use the legacy session wire — POST `initialize`, capture
 * `Mcp-Session-Id`, send follow-ups with only the session header.
 * With `stateless: true`, use the SEP-2575 wire — no initialize, no
 * session id, every body carries a
 * `_meta.io.modelcontextprotocol/{protocolVersion,clientInfo,
 * clientCapabilities}` envelope plus the `MCP-Protocol-Version` HTTP
 * header on every call.
 *
 * Tasks and MRTR scenarios are wire-independent in spec, so each
 * harness runs every scenario twice (once per wire) against any
 * server that speaks both.
 *
 * Both modes pin `protocolVersion` to `DRAFT_PROTOCOL_VERSION` by
 * default; the SDK's `Client.connect()` would otherwise pin the
 * package-level `LATEST_PROTOCOL_VERSION` and prevent draft-only
 * servers (or the SEP-2575 wire) from handshaking.
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
  const stateless = opts.stateless === true;
  return stateless
    ? initStatelessSession(serverUrl, protocolVersion, capabilities, clientInfo)
    : initLegacySession(serverUrl, protocolVersion, capabilities, clientInfo);
}

async function initLegacySession(
  serverUrl: string,
  protocolVersion: string,
  capabilities: Record<string, unknown>,
  clientInfo: { name: string; version: string }
): Promise<RawSession> {
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

  const serverCapabilities =
    typeof initializeResult.capabilities === 'object' &&
    initializeResult.capabilities !== null
      ? (initializeResult.capabilities as Record<string, unknown>)
      : {};

  // MCP 2025-11-25 §Protocol-Version Header: the client MUST include
  // the `MCP-Protocol-Version` HTTP header on every subsequent HTTP
  // request (POST or GET) after initialize. Universal post-initialize
  // requirement; applies to legacy session traffic just as much as
  // SEP-2575 stateless traffic. See:
  // https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#protocol-version-header
  const sessionHeaders = (): Record<string, string> => ({
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'Mcp-Session-Id': sessionId,
    'MCP-Protocol-Version': negotiated
  });

  const toolSchemas = new Map<string, unknown>();

  const session: RawSession = {
    wire: 'legacy',
    sessionId,
    protocolVersion: negotiated,
    serverCapabilities,
    initializeResult,
    toolSchemas,

    async requestFull(method, params, extraHeaders) {
      const id = nextRawId();
      const resp = await fetch(serverUrl, {
        method: 'POST',
        headers: {
          ...sessionHeaders(),
          ...routingHeaders(method, params, negotiated, toolSchemas),
          ...(extraHeaders ?? {})
        },
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
        headers: {
          ...sessionHeaders(),
          ...routingHeaders(method, params, negotiated, toolSchemas)
        },
        body: JSON.stringify({ jsonrpc: '2.0', method, params })
      });
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

  await session.notification('notifications/initialized');
  await primeToolSchemas(session);
  return session;
}

async function initStatelessSession(
  serverUrl: string,
  protocolVersion: string,
  capabilities: Record<string, unknown>,
  clientInfo: { name: string; version: string }
): Promise<RawSession> {
  // SEP-2575 has no initialize handshake. The closest equivalent is
  // server/discover, which surfaces serverInfo + advertised
  // capabilities + supported protocol versions. Scenarios that inspect
  // serverCapabilities still get a populated value via discover.
  const meta = {
    'io.modelcontextprotocol/protocolVersion': protocolVersion,
    'io.modelcontextprotocol/clientInfo': clientInfo,
    'io.modelcontextprotocol/clientCapabilities': capabilities
  };

  const baseHeaders = (): Record<string, string> => ({
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': protocolVersion
  });

  const injectMeta = (
    params: Record<string, unknown> | undefined
  ): Record<string, unknown> => {
    const base = params ?? {};
    const callerMeta = (base._meta ?? {}) as Record<string, unknown>;
    return { ...base, _meta: { ...meta, ...callerMeta } };
  };

  const discoverId = nextRawId();
  const discoverResp = await fetch(serverUrl, {
    method: 'POST',
    headers: {
      ...baseHeaders(),
      ...routingHeaders('server/discover', {}, protocolVersion)
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: discoverId,
      method: 'server/discover',
      params: injectMeta({})
    })
  });
  const discoverBody = await readJsonRpcResponse(discoverResp, discoverId);
  if (discoverBody.error) {
    throw new McpError(
      discoverBody.error.code,
      discoverBody.error.message,
      discoverBody.error.data
    );
  }
  const discoverResult = discoverBody.result ?? {};
  const serverCapabilities =
    typeof discoverResult.capabilities === 'object' &&
    discoverResult.capabilities !== null
      ? (discoverResult.capabilities as Record<string, unknown>)
      : {};

  const toolSchemas = new Map<string, unknown>();

  const session: RawSession = {
    wire: 'stateless',
    sessionId: '',
    protocolVersion,
    serverCapabilities,
    initializeResult: discoverResult,
    toolSchemas,

    async requestFull(method, params, extraHeaders) {
      const id = nextRawId();
      const resp = await fetch(serverUrl, {
        method: 'POST',
        headers: {
          ...baseHeaders(),
          ...routingHeaders(method, params, protocolVersion, toolSchemas),
          ...(extraHeaders ?? {})
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method,
          params: injectMeta(params)
        })
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
        headers: {
          ...baseHeaders(),
          ...routingHeaders(method, params, protocolVersion, toolSchemas)
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method,
          params: injectMeta(params)
        })
      });
      try {
        await resp.text();
      } catch {
        /* swallow */
      }
    },

    async close() {
      // SEP-2575 has no session to close.
    }
  };

  await primeToolSchemas(session);
  return session;
}

/**
 * Best-effort initial `tools/list` to populate `session.toolSchemas`.
 * Swallows any failure (server may not advertise tools at all, or may
 * reject the call before the session has negotiated something the
 * server requires) so the session is still usable for tasks/* and
 * other non-tool methods. Scenarios that need `Mcp-Param-*` headers
 * inherit a populated cache; scenarios that don't aren't affected by
 * the failure.
 */
async function primeToolSchemas(session: RawSession): Promise<void> {
  try {
    const result = (await session.request('tools/list')) as {
      tools?: Array<{ name?: unknown; inputSchema?: unknown }>;
    };
    if (!Array.isArray(result.tools)) return;
    for (const tool of result.tools) {
      if (typeof tool?.name !== 'string') continue;
      if (tool.inputSchema === undefined) continue;
      session.toolSchemas.set(tool.name, tool.inputSchema);
    }
  } catch {
    // Empty cache is the safe default — `routingHeaders` simply skips
    // Mcp-Param-* emission when no schema is cached for the tool.
  }
}

let rawIdCounter = 0;
export function nextRawId(): number {
  rawIdCounter += 1;
  return rawIdCounter;
}

/**
 * Protocol versions that mandate SEP-2243 routing headers.
 * `DRAFT-2026-v1` is the only version today that ships with
 * SEP-2243; dated releases (2025-11-25 and earlier) predate the SEP.
 * Widen this set when a future dated release picks SEP-2243 up.
 */
export const SEP_2243_ENFORCED_VERSIONS: ReadonlySet<string> = new Set([
  DRAFT_PROTOCOL_VERSION
]);

/**
 * SEP-2243 routing headers (Mcp-Method, Mcp-Name, and per-tool
 * `Mcp-Param-*`) the server expects on every request to an
 * SEP-2243-enforcing protocol version.
 *
 * Conformant servers reject with `-32001 HeaderMismatch` when
 * Mcp-Method is missing / mismatched, and likewise for Mcp-Name on
 * any method whose body-side identifier doesn't match the header.
 *
 * `Mcp-Name` surfaces (per SEP-2243 §Standard Headers + SEP-2663
 * §Streamable HTTP routing headers):
 *
 *   - tools/call      → params.name        (tool name)
 *   - resources/read  → params.uri         (resource URI)
 *   - prompts/get     → params.name        (prompt name)
 *   - tasks/get       → params.taskId      (SEP-2663)
 *   - tasks/update    → params.taskId      (SEP-2663)
 *   - tasks/cancel    → params.taskId      (SEP-2663)
 *
 * `Mcp-Param-<Suffix>` headers (per SEP-2243 §Custom Headers from Tool
 * Parameters) are emitted on `tools/call` when the tool's input schema
 * marks a primitive-typed property with `x-mcp-header: "<Suffix>"`.
 * The argument value is encoded per SEP-2243 §value-encoding —
 * printable ASCII passes through verbatim; anything else (non-ASCII,
 * control chars, leading/trailing whitespace) gets wrapped as
 * `=?base64?{base64-utf8}?=`. The `toolSchemas` cache is populated by
 * an initial `tools/list` during session init; calls against tools the
 * cache doesn't know about emit `Mcp-Method` + `Mcp-Name` only.
 *
 * Scenarios that deliberately probe the mismatch path supply
 * `extraHeaders` that override these auto-populated values.
 *
 * Returns an empty record for protocol versions that predate SEP-2243
 * so the helper doesn't put noise on the wire when the spec doesn't
 * require it.
 */
export function routingHeaders(
  method: string,
  params: Record<string, unknown> | undefined,
  protocolVersion: string,
  toolSchemas?: Map<string, unknown>
): Record<string, string> {
  if (!SEP_2243_ENFORCED_VERSIONS.has(protocolVersion)) {
    return {};
  }
  const headers: Record<string, string> = { 'Mcp-Method': method };
  switch (method) {
    case 'tools/call':
    case 'prompts/get':
      if (typeof params?.name === 'string') {
        headers['Mcp-Name'] = params.name;
      }
      break;
    case 'resources/read':
      if (typeof params?.uri === 'string') {
        headers['Mcp-Name'] = params.uri;
      }
      break;
    case 'tasks/get':
    case 'tasks/update':
    case 'tasks/cancel':
      if (typeof params?.taskId === 'string') {
        headers['Mcp-Name'] = params.taskId;
      }
      break;
  }
  if (
    method === 'tools/call' &&
    toolSchemas &&
    typeof params?.name === 'string'
  ) {
    const schema = toolSchemas.get(params.name);
    const args = params.arguments;
    if (schema && args && typeof args === 'object') {
      Object.assign(
        headers,
        mcpParamHeaders(schema, args as Record<string, unknown>)
      );
    }
  }
  return headers;
}

/**
 * Build the `Mcp-Param-*` header set for a tools/call based on the
 * tool's inputSchema (SEP-2243 §Custom Headers from Tool Parameters).
 * Walks `properties` for primitive-typed entries marked with the
 * `x-mcp-header` keyword and mirrors the matching argument value via
 * an `Mcp-Param-<Suffix>` header. Schemas without annotations yield
 * an empty record.
 */
function mcpParamHeaders(
  inputSchema: unknown,
  args: Record<string, unknown>
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!inputSchema || typeof inputSchema !== 'object') return out;
  const props = (inputSchema as { properties?: unknown }).properties;
  if (!props || typeof props !== 'object') return out;
  for (const [propName, raw] of Object.entries(
    props as Record<string, unknown>
  )) {
    if (!raw || typeof raw !== 'object') continue;
    const propMap = raw as Record<string, unknown>;
    const headerSuffix = propMap['x-mcp-header'];
    if (typeof headerSuffix !== 'string' || headerSuffix === '') continue;
    const propType = propMap.type;
    if (
      propType !== 'string' &&
      propType !== 'number' &&
      propType !== 'integer' &&
      propType !== 'boolean'
    ) {
      continue;
    }
    if (!(propName in args)) continue;
    const encoded = encodeMcpParamValue(args[propName]);
    if (encoded === null) continue;
    out[`Mcp-Param-${headerSuffix}`] = encoded;
  }
  return out;
}

/**
 * SEP-2243 §value-encoding. Null/undefined → header omitted (returns
 * null sentinel). Plain ASCII strings (no leading/trailing whitespace,
 * no tab/control chars, no non-ASCII) pass through verbatim. Anything
 * else gets wrapped as `=?base64?{base64-utf8}?=`. Numbers serialize
 * to their shortest round-trip form; booleans to "true"/"false".
 */
function encodeMcpParamValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return encodeMcpParamString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return String(value);
    return value.toString();
  }
  return String(value);
}

function encodeMcpParamString(s: string): string {
  if (s.length === 0) return s;
  if (s.trim() !== s) return wrapBase64(s);
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0x09 || code < 0x20 || code > 0x7e) {
      return wrapBase64(s);
    }
  }
  return s;
}

function wrapBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  // btoa wants a binary string; pack each byte as a code unit.
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `=?base64?${btoa(bin)}?=`;
}

/**
 * Parse a JSON-RPC response from a Streamable HTTP response. Handles
 * both application/json and text/event-stream content types; in the
 * SSE case scans events until it finds the frame whose id matches the
 * expected id. Throws on malformed or empty responses.
 *
 * SSE parsing delegates to `eventsource-parser` (the same parser the
 * official TS SDK uses) so we inherit spec-compliant handling of
 * multi-line `data:` continuations, CRLF/CR line endings, comments,
 * and the `event:`/`id:`/`retry:` fields the WHATWG SSE spec defines.
 */
export async function readJsonRpcResponse(
  resp: Response,
  expectedId: number | string
): Promise<JsonRpcResponse> {
  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/event-stream')) {
    const text = await resp.text();
    let match: JsonRpcResponse | undefined;
    const parser = createParser({
      onEvent(evt) {
        if (match) return;
        const data = evt.data;
        if (!data || !data.startsWith('{')) return;
        const parsed = JSON.parse(data) as JsonRpcResponse;
        if (parsed.id === expectedId && (parsed.result || parsed.error)) {
          match = parsed;
        }
      }
    });
    parser.feed(text);
    parser.reset({ consume: true });
    if (!match) {
      throw new Error(
        `No JSON-RPC frame with id=${expectedId} in SSE response (status ${resp.status})`
      );
    }
    return match;
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
