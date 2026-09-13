/**
 * What the wire said about a dispatched MCP request: the client's request as
 * a JSON-RPC message (method, requested version), the response the cell gave
 * it (status, body), and the two judgements the hosted layer records from
 * them so a cell cannot read green when every request was turned away:
 *
 *   hosted-wire-rejected   a 4xx whose body is one of the lifecycle
 *                          rejections (missing header / _meta, unsupported
 *                          protocol version) — the scenario never saw a
 *                          request it could judge;
 *   hosted-wrong-revision  the client spoke a revision other than the one
 *                          the cell is served on (a stateful `initialize` on
 *                          the stateless wire, a header naming another
 *                          revision).
 *
 * Both are FAILUREs, so they decide the cell's verdict (see report.ts). A
 * request that is both is one mistake and records only the wrong revision,
 * with the rejection folded in. Probing for a revision is negotiation, not
 * a mistake, and is noted as INFO in both directions, judged from the
 * request itself so that neither its timing nor which process saw it
 * matters: on a dated cell a `server/discover`, or another 2026-07-28-shaped
 * request the cell turned away, is a modern probe (see isModernProbe()); on
 * the stateless wire an `initialize` is a legacy probe (see isLegacyProbe()).
 */

import type { ServerResponse } from 'http';
import { isStatefulVersion } from '../connection/select';
import type { ConformanceCheck, SpecVersion } from '../types';

export const WIRE_REJECTED_CHECK_ID = 'hosted-wire-rejected';
export const WRONG_REVISION_CHECK_ID = 'hosted-wrong-revision';

/** Response bodies above this are not captured (a rejection is small). */
export const RESPONSE_CAP = 64 * 1024;

const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Whether a request body is not JSON at all: empty, or malformed. */
export function isUnparseable(body: Buffer | string | undefined): boolean {
  if (body === undefined) return false;
  try {
    JSON.parse(body.toString());
    return false;
  } catch {
    return true;
  }
}

/** The JSON-RPC message(s) of a body: one object, or a batch. */
function messagesOfJson(text: string): Record<string, unknown>[] {
  try {
    const parsed: unknown = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map(asRecord).filter((m): m is Record<string, unknown> => !!m);
  } catch {
    return [];
  }
}

/**
 * JSON-RPC messages in a response body: a JSON object or batch, or the
 * `data:` lines of an SSE stream (the SDK transport answers a POST that
 * way — `event: message\ndata: {...}\n\n`).
 */
export function jsonRpcMessages(
  body: string | undefined,
  contentType: string | undefined
): Record<string, unknown>[] {
  if (body === undefined) return [];
  if (/^text\/event-stream\b/i.test(contentType ?? '')) {
    const out: Record<string, unknown>[] = [];
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).replace(/^ /, ''))
        .join('\n');
      if (data) out.push(...messagesOfJson(data));
    }
    return out;
  }
  return messagesOfJson(body);
}

/** What one request says about itself, read from its JSON-RPC body. */
export interface RequestInfo {
  /** JSON-RPC methods carried (one per batch member with a `method`). */
  methods: string[];
  /**
   * The protocol version the client asked for in the body: `initialize`
   * params on the stateful wire, `_meta` on the stateless one.
   */
  bodyVersion?: string;
  /**
   * The protocol version in a message's per-request `_meta`: the shape of a
   * 2026-07-28 (stateless) request, which a dated revision never uses.
   */
  metaVersion?: string;
}

export function describeRequest(
  body: Buffer | string | undefined
): RequestInfo {
  const messages = body === undefined ? [] : messagesOfJson(body.toString());
  const methods: string[] = [];
  let bodyVersion: string | undefined;
  let metaVersion: string | undefined;
  for (const m of messages) {
    const method = str(m.method);
    if (method) methods.push(method);
    const params = asRecord(m.params);
    metaVersion ??= str(asRecord(params?._meta)?.[META_PROTOCOL_VERSION]);
    bodyVersion ??=
      metaVersion ??
      (method === 'initialize' ? str(params?.protocolVersion) : undefined);
  }
  return {
    methods,
    ...(bodyVersion && { bodyVersion }),
    ...(metaVersion && { metaVersion })
  };
}

/** The response a cell gave, as captured by tapResponse(). */
export interface CapturedResponse {
  status: number;
  contentType?: string;
  /** Undefined when the body was over RESPONSE_CAP. */
  body?: string;
}

/**
 * Wrap `res.write`/`res.end` so `onEnd` sees the status and (up to
 * RESPONSE_CAP) the body once the response is complete. `onEnd` runs after
 * the original `end`, synchronously, so a bridge that resolves its Response
 * from `end` still sees whatever `onEnd` records before it flushes.
 */
export function tapResponse(
  res: ServerResponse,
  onEnd: (captured: CapturedResponse) => void
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  let ended = false;
  const capture = (chunk: unknown, encoding?: unknown) => {
    if (overflow) return;
    let buf: Buffer;
    if (Buffer.isBuffer(chunk)) buf = chunk;
    else if (chunk instanceof Uint8Array)
      buf = Buffer.from(chunk); // hono/node-server
    else if (typeof chunk === 'string')
      buf = Buffer.from(
        chunk,
        typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8'
      );
    else return; // end(cb), end()
    size += buf.length;
    if (size > RESPONSE_CAP) overflow = true;
    else chunks.push(buf);
  };
  const write = res.write;
  const end = res.end;
  res.write = function (this: ServerResponse, ...args: unknown[]) {
    capture(args[0], args[1]);
    return (write as (...a: unknown[]) => boolean).apply(this, args);
  } as ServerResponse['write'];
  res.end = function (this: ServerResponse, ...args: unknown[]) {
    capture(args[0], args[1]);
    const out = (end as (...a: unknown[]) => ServerResponse).apply(this, args);
    if (!ended) {
      ended = true;
      const contentType = res.getHeader('content-type');
      onEnd({
        status: res.statusCode,
        ...(typeof contentType === 'string' && { contentType }),
        ...(!overflow && { body: Buffer.concat(chunks).toString('utf8') })
      });
    }
    return out;
  } as ServerResponse['end'];
}

export interface WireRejection {
  status: number;
  code: number;
  message: string;
}

/**
 * The lifecycle rejection in a 4xx response, if that is what it is: a
 * JSON-RPC error with code -32020 / -32022 (protocol-version header), -32602
 * naming `_meta`, or -32000 saying "Unsupported protocol version" (the SDK
 * transport's stateful negotiation failure).
 *
 * An unsupported-version rejection of a request whose header already names
 * the cell's revision `served` is not the client's doing — it is a
 * scenario's deliberate probe (request-metadata rejects a run's first
 * request to exercise the client's retry) — and is not one.
 */
export function wireRejection(
  response: CapturedResponse,
  served: SpecVersion,
  headerVersion: string | undefined
): WireRejection | undefined {
  if (response.status < 400 || response.status >= 500) return undefined;
  for (const m of jsonRpcMessages(response.body, response.contentType)) {
    const error = asRecord(m.error);
    if (!error || typeof error.code !== 'number') continue;
    const code = error.code;
    const message = str(error.message) ?? '';
    const unsupportedVersion =
      code === -32022 ||
      (code === -32000 && message.includes('Unsupported protocol version'));
    if (unsupportedVersion && headerVersion === served) continue;
    if (
      unsupportedVersion ||
      code === -32020 ||
      (code === -32602 && message.includes('_meta'))
    ) {
      return { status: response.status, code, message };
    }
  }
  return undefined;
}

export const MODERN_PROBE_CHECK_ID = 'hosted-modern-probe';

/** How a cell turned a request away: its status, and any JSON-RPC error. */
export interface Refusal {
  status: number;
  code?: number;
  message?: string;
}

export const DISCOVER_METHOD = 'server/discover';

/** Whether revision `a` is later than `b` (both are dates, YYYY-MM-DD). */
function isNewer(a: string, b: string): boolean {
  return a > b;
}

/**
 * Whether a request to a dated cell is a modern probe — era detection
 * rather than a client at the wrong revision — judged from the request and
 * the answer it drew alone, never from what came before it (2026-07-28
 * basic/versioning, "Backward Compatibility with Initialization-Based
 * Versions"):
 *
 *   - a `server/discover`, whenever it arrives and however often: a dual-era
 *     client may send one on every connect, and a dated cell
 *     always turns it away (see discoverReply());
 *   - any other request in the 2026-07-28 shape — per-request `_meta` naming
 *     a revision newer than `served` — that the cell turned away (a 4xx: the
 *     transport's 400, or the 401 an auth cell answers first). On HTTP a
 *     dual-era client may probe with any modern request, and it may re-probe
 *     whenever it reconnects.
 *
 * Either is noted (modernProbeCheck()), never failed. `initialize`
 * negotiates on this wire and is never judged. A foreign-revision request
 * the cell accepted, or one in the dated shape (no per-request `_meta`)
 * whose header names another revision, is the client carrying on at the
 * wrong revision. On the stateless wire nothing is a modern probe (see
 * isLegacyProbe() for the mirror case there).
 */
export function isModernProbe(
  served: SpecVersion,
  request: RequestInfo,
  headerVersion: string | undefined,
  response: CapturedResponse
): boolean {
  if (!isStatefulVersion(served)) return false;
  if (request.methods.includes('initialize')) return false;
  if (request.methods.includes(DISCOVER_METHOD)) return true;
  const version = headerVersion ?? request.metaVersion;
  if (!request.metaVersion || !version || !isNewer(version, served))
    return false;
  return response.status >= 400 && response.status < 500;
}

/**
 * The answer every dated cell gives a `server/discover`, or undefined when
 * `body` is not one (or the cell is on the stateless wire): HTTP 400 with a
 * JSON-RPC -32000 "Unsupported protocol version", what the 2025-11-25 SDK
 * transport answers a header it does not know. That is how a server without
 * 2026-07-28 support turns a modern request away on HTTP: a 4xx whose body
 * is not a recognized modern error, so a dual-era client falls back to
 * `initialize` (2026-07-28 basic/transports/streamable-http, "Backward
 * Compatibility"). A 404 with -32601 would not do: that is a modern server
 * saying it lacks the method, and a client may take it as a modern server.
 * The hosted layer sends it before the scenario sees the request, so every
 * dated cell and composite agrees; the bundled servers answered 400, 404 or
 * even a DiscoverResult.
 */
export function discoverReply(
  served: SpecVersion,
  body: Buffer | undefined,
  headerVersion: string | undefined
): { status: number; body: Record<string, unknown> } | undefined {
  if (!isStatefulVersion(served) || body === undefined) return undefined;
  const message = messagesOfJson(body.toString());
  if (message.length !== 1 || message[0].method !== DISCOVER_METHOD)
    return undefined;
  const requested = headerVersion ?? describeRequest(body).metaVersion;
  return {
    status: 400,
    body: {
      jsonrpc: '2.0',
      id: message[0].id ?? null,
      error: {
        code: -32000,
        message:
          requested && requested !== served
            ? `Bad Request: Unsupported protocol version: ${requested} (supported versions: ${served})`
            : `Bad Request: ${DISCOVER_METHOD} is not part of ${served}; open a session with initialize`
      }
    }
  };
}

export const UNPARSEABLE_BODY_CHECK_ID = 'hosted-unparseable-body';

/** The answer to a POST whose body is not JSON: a plain -32700. */
export const PARSE_ERROR_REPLY = {
  jsonrpc: '2.0',
  id: null,
  error: { code: -32700, message: 'Parse error' }
} as const;

/**
 * A POST to the MCP endpoint whose body is empty or not JSON. The hosted
 * layer answers it with PARSE_ERROR_REPLY before the scenario sees it (the
 * bundled servers quoted their parser's exception), and notes it so the
 * client's author sees what was sent.
 */
export function unparseableBodyCheck(
  served: SpecVersion,
  empty: boolean,
  headerVersion: string | undefined
): ConformanceCheck {
  return {
    id: UNPARSEABLE_BODY_CHECK_ID,
    name: 'UnparseableBody',
    description:
      `The client sent a POST to the MCP endpoint ${empty ? 'with an empty body' : 'whose body is not valid JSON'}, ` +
      'so the cell answered HTTP 400 with JSON-RPC error -32700 (Parse error)',
    status: 'INFO',
    timestamp: new Date().toISOString(),
    details: {
      served,
      body: empty ? 'empty' : 'malformed',
      headerVersion: headerVersion ?? null,
      status: 400,
      code: -32700
    }
  };
}

/**
 * The cell's answer to a request at a revision it does not serve, or
 * undefined when the response is not one: a 4xx lifecycle rejection (see
 * wireRejection()) or -32601 method-not-found. Either tells a probing
 * client to fall back; a 401 does not (it says to sign in first, and the
 * probe is repeated with a token).
 */
export function versionAnswer(
  served: SpecVersion,
  headerVersion: string | undefined,
  response: CapturedResponse
): Refusal | undefined {
  const rejection = wireRejection(response, served, headerVersion);
  if (rejection) return rejection;
  if (response.status < 400 || response.status >= 500) return undefined;
  for (const m of jsonRpcMessages(response.body, response.contentType)) {
    const error = asRecord(m.error);
    if (error?.code === -32601)
      return {
        status: response.status,
        code: -32601,
        message: str(error.message) ?? ''
      };
  }
  return undefined;
}

/**
 * How `response` turned a request away, for a modern probe's details: its
 * status and the JSON-RPC error it carried, if any (a 401's OAuth body
 * carries none).
 */
export function refusalOf(response: CapturedResponse): Refusal {
  for (const m of jsonRpcMessages(response.body, response.contentType)) {
    const error = asRecord(m.error);
    if (error && typeof error.code === 'number')
      return {
        status: response.status,
        code: error.code,
        message: str(error.message) ?? ''
      };
  }
  return { status: response.status };
}

/**
 * Whether the exchange was an accepted `initialize`: the cell negotiated a
 * revision with the client, so every later request's header has had its
 * answer.
 */
export function isAcceptedInitialize(
  request: RequestInfo,
  response: CapturedResponse
): boolean {
  if (!request.methods.includes('initialize')) return false;
  if (response.status < 200 || response.status >= 300) return false;
  return jsonRpcMessages(response.body, response.contentType).some(
    (m) => asRecord(m.result) !== undefined
  );
}

export const VERSION_OFFERED_CHECK_ID = 'hosted-version-offered';

/** The `protocolVersion` field of a JSON-RPC result, as it is on the wire. */
const PROTOCOL_VERSION_FIELD = /("protocolVersion"\s*:\s*")([^"\\]*)(")/;

/**
 * Make the `initialize` result a dated cell sends state the cell's revision
 * `served`, whatever the scenario negotiated. A cell tests exactly its
 * column's revision, but the bundled servers echo any version they support
 * (the SDK's, 2025-06-18 among them; the raw `initialize` scenario's), and a
 * client that then speaks the version it was given would be failed for it.
 * Told `served`, a client that cannot speak it declines, as the lifecycle
 * says it should. Wraps `res.write`/`res.end` and rewrites the first
 * `"protocolVersion":"…"` of a 2xx response once `isInitialize()` says the
 * request was one (the scenario has read the body by the time it answers).
 * Bytes are rewritten in place (latin1 keeps them 1:1), and a declared
 * Content-Length not yet sent is kept right. Hosted only: the CLI runner
 * still sees what the scenario answers.
 */
export function pinInitializeVersion(
  res: ServerResponse,
  served: SpecVersion,
  isInitialize: () => boolean
): void {
  let pinned = false;
  const rewrite = (chunk: unknown): unknown => {
    if (pinned || res.statusCode < 200 || res.statusCode >= 300) return chunk;
    const bytes = Buffer.isBuffer(chunk) || chunk instanceof Uint8Array;
    if (!bytes && typeof chunk !== 'string') return chunk;
    if (!isInitialize()) return chunk;
    const text = bytes ? Buffer.from(chunk).toString('latin1') : chunk;
    const match = PROTOCOL_VERSION_FIELD.exec(text);
    if (!match) return chunk;
    pinned = true;
    if (match[2] === served) return chunk;
    const out =
      text.slice(0, match.index) +
      match[1] +
      served +
      match[3] +
      text.slice(match.index + match[0].length);
    const delta = served.length - match[2].length;
    const declared = res.getHeader('content-length');
    if (delta !== 0 && !res.headersSent && declared !== undefined)
      res.setHeader('content-length', String(Number(declared) + delta));
    return bytes ? Buffer.from(out, 'latin1') : out;
  };
  const write = res.write;
  const end = res.end;
  res.write = function (this: ServerResponse, ...args: unknown[]) {
    args[0] = rewrite(args[0]);
    return (write as (...a: unknown[]) => boolean).apply(this, args);
  } as ServerResponse['write'];
  res.end = function (this: ServerResponse, ...args: unknown[]) {
    if (typeof args[0] !== 'function') args[0] = rewrite(args[0]);
    return (end as (...a: unknown[]) => ServerResponse).apply(this, args);
  } as ServerResponse['end'];
}

/** The `protocolVersion` an accepted `initialize` answered with, if any. */
export function answeredVersion(
  response: CapturedResponse
): string | undefined {
  if (response.status < 200 || response.status >= 300) return undefined;
  for (const m of jsonRpcMessages(response.body, response.contentType)) {
    const version = str(asRecord(m.result)?.protocolVersion);
    if (version) return version;
  }
  return undefined;
}

/**
 * The client's `initialize` asked a dated cell for a revision other than the
 * one it serves, and was told the cell's (see pinInitializeVersion()). Noted
 * so the results page can explain a client that then declined or went quiet;
 * one that carries on at the version it asked for is at the wrong revision.
 */
export function versionOfferedCheck(
  served: SpecVersion,
  requestedVersion: string,
  answered: string | undefined
): ConformanceCheck {
  return {
    id: VERSION_OFFERED_CHECK_ID,
    name: 'VersionOffered',
    description:
      `The client asked for ${requestedVersion} in initialize; this cell tests ${served} only, ` +
      `so it answered ${answered ?? served}. A client that cannot speak ${served} may disconnect; ` +
      `one that carries on at ${requestedVersion} is at the wrong revision`,
    status: 'INFO',
    timestamp: new Date().toISOString(),
    details: {
      served,
      requestedVersion,
      ...(answered && { answeredVersion: answered })
    }
  };
}

/**
 * `version` is the revision the probe asked for (its header, else its
 * `_meta`); `refusal` is how the cell turned it away.
 */
export function modernProbeCheck(
  served: SpecVersion,
  method: string | undefined,
  version: string | undefined,
  refusal: Refusal
): ConformanceCheck {
  const asked = version ? `asked for ${version}` : 'probed';
  return {
    id: MODERN_PROBE_CHECK_ID,
    name: 'ModernProbe',
    description:
      `The client ${asked}${method ? ` with ${method}` : ''} on a cell served on ${served}, ` +
      `and the cell answered ${refusalText(refusal)}. ` +
      `That is version negotiation, not a failure, however often the client repeats it: ` +
      `the client is judged on the requests it makes at ${served}`,
    status: 'INFO',
    timestamp: new Date().toISOString(),
    details: {
      served,
      ...(method && { method }),
      headerVersion: version ?? null,
      rejected: { ...refusal }
    }
  };
}

function refusalText(r: Refusal): string {
  if (r.code === undefined) {
    return r.status === 401
      ? 'HTTP 401, asking the client to sign in first'
      : `HTTP ${r.status}`;
  }
  return `HTTP ${r.status}, JSON-RPC error ${r.code}${r.message ? `: ${r.message}` : ''}`;
}

/**
 * Why a request is not one the cell's revision `served` should receive, or
 * undefined when it is. On the stateless wire every request must carry the
 * cell's revision in the header and `initialize` does not exist; on a dated
 * (stateful) revision `initialize` negotiates and is exempt, and every later
 * request's header, when present, must name the cell's revision — unless
 * it was a modern probe (isModernProbe()), which the caller decides from
 * the request and the response.
 */
export function wrongRevision(
  served: SpecVersion,
  method: string,
  headerVersion: string | undefined
): string | undefined {
  if (isStatefulVersion(served)) {
    if (method === 'initialize') return undefined;
    if (headerVersion !== undefined && headerVersion !== served)
      return `sent ${headerVersion}`;
    return undefined;
  }
  if (method === 'initialize') return 'sent initialize';
  if (headerVersion !== served)
    return headerVersion === undefined
      ? 'sent no MCP-Protocol-Version header'
      : `sent ${headerVersion}`;
  return undefined;
}

export const LEGACY_PROBE_CHECK_ID = 'hosted-legacy-probe';

/**
 * Whether `method` on a cell served at `served` is a legacy probe: an
 * `initialize` on the stateless wire. A dual-era client may open that way to
 * learn the server's era, and a modern-only server answers it with an error
 * naming its versions (2026-07-28 basic/versioning, "Backward Compatibility
 * with Initialization-Based Versions"), so it is negotiation, not a wrong
 * revision — and it explains any rejection it drew.
 */
export function isLegacyProbe(served: SpecVersion, method: string): boolean {
  return method === 'initialize' && !isStatefulVersion(served);
}

/**
 * The answer every cell on the stateless wire gives a legacy `initialize`,
 * or undefined when `body` is not one (or the cell is on a dated revision):
 * HTTP 400 with -32022 naming the revision the cell serves, as a modern-only
 * server should (2026-07-28 basic/versioning). The hosted layer sends it
 * before the scenario sees the request, so every cell of the column agrees —
 * a scenario whose bundled SDK server would complete the handshake (the CLI
 * runner's SDK clients rely on json-schema-ref-no-deref doing so) cannot
 * accept it here and then fail the client for following that answer.
 */
export function legacyInitializeReply(
  served: SpecVersion,
  body: Buffer | undefined,
  headerVersion: string | undefined
): { status: number; body: Record<string, unknown> } | undefined {
  if (isStatefulVersion(served) || body === undefined) return undefined;
  let message: Record<string, unknown> | undefined;
  try {
    message = asRecord(JSON.parse(body.toString()));
  } catch {
    return undefined;
  }
  if (message?.method !== 'initialize') return undefined;
  const params = asRecord(message.params);
  return {
    status: 400,
    body: {
      jsonrpc: '2.0',
      id: message.id ?? null,
      error: {
        code: -32022,
        message: 'Unsupported protocol version',
        data: {
          supported: [served],
          requested: String(params?.protocolVersion ?? headerVersion ?? '')
        }
      }
    }
  };
}

/**
 * What the cell answered a legacy `initialize`, for its note: its version
 * answer (a -32022 naming the revisions it serves), another refusal (the
 * 401 an auth cell answers before it looks at the protocol), or undefined
 * when it accepted the request.
 */
export function legacyAnswer(
  served: SpecVersion,
  response: CapturedResponse
): Refusal | undefined {
  if (response.status < 400) return undefined;
  // Looked up without the header: a -32022 to an initialize that happened
  // to name the cell's revision is still the answer.
  return wireRejection(response, served, undefined) ?? refusalOf(response);
}

export function legacyProbeCheck(
  served: SpecVersion,
  headerVersion: string | undefined,
  answer?: Refusal,
  requestedVersion?: string
): ConformanceCheck {
  return {
    id: LEGACY_PROBE_CHECK_ID,
    name: 'LegacyProbe',
    description:
      `The client opened with initialize, the legacy handshake, on a cell served on ${served}. ` +
      'On this revision that is era detection, not a failure' +
      (answer
        ? `; the cell answered ${refusalText(answer)}`
        : '; the cell accepted it'),
    status: 'INFO',
    timestamp: new Date().toISOString(),
    details: {
      served,
      headerVersion: headerVersion ?? null,
      ...(requestedVersion && { requestedVersion }),
      ...(answer && { rejected: { ...answer } })
    }
  };
}

export const GET_ON_MCP_CHECK_ID = 'hosted-get-on-mcp-path';

/**
 * The 405 a cell answers a GET on its MCP endpoint with when its scenario
 * serves no GET stream there, shaped like the SDK transport's own.
 */
export const GET_ON_MCP_REPLY = {
  jsonrpc: '2.0',
  error: { code: -32000, message: 'Method not allowed.' },
  id: null
} as const;

/**
 * A GET to the MCP endpoint of a cell that serves no stream there: a client
 * opening a standalone SSE stream, or falling back to the old HTTP+SSE
 * transport after a POST was turned away. Noted so the client's author sees
 * it; the spec allows either, so it never decides the verdict.
 */
export function getOnMcpCheck(served: SpecVersion): ConformanceCheck {
  return {
    id: GET_ON_MCP_CHECK_ID,
    name: 'GetOnMcpPath',
    description:
      'The client sent GET to the MCP endpoint — to open a server-sent event stream, ' +
      'or to fall back to the old HTTP+SSE transport after a POST was turned away. ' +
      'This cell serves no such stream, so it answered 405 Method Not Allowed; ' +
      'a client should carry on with POST',
    status: 'INFO',
    timestamp: new Date().toISOString(),
    details: { served, status: 405 }
  };
}

export function wireRejectedCheck(
  rejection: WireRejection,
  request: RequestInfo,
  headerVersion: string | undefined
): ConformanceCheck {
  const method = request.methods[0];
  return {
    id: WIRE_REJECTED_CHECK_ID,
    name: 'WireRejected',
    description:
      'The cell turned a request away before the scenario could judge it',
    status: 'FAILURE',
    timestamp: new Date().toISOString(),
    errorMessage: `${response(rejection)}${method ? ` to ${method}` : ''}: ${rejection.message}`,
    details: {
      status: rejection.status,
      code: rejection.code,
      message: rejection.message,
      ...(method && { method }),
      requestedVersion: headerVersion ?? request.bodyVersion ?? null
    }
  };
}

function response(r: WireRejection): string {
  return `HTTP ${r.status}, JSON-RPC error ${r.code}`;
}

/**
 * `rejection` is the wire turning the same request away: one mistake, so it
 * is folded into this check rather than recorded as hosted-wire-rejected too.
 */
export function wrongRevisionCheck(
  served: SpecVersion,
  method: string,
  headerVersion: string | undefined,
  reason: string,
  rejection?: WireRejection
): ConformanceCheck {
  return {
    id: WRONG_REVISION_CHECK_ID,
    name: 'WrongRevision',
    description: `The client spoke a revision other than the one this cell is served on`,
    status: 'FAILURE',
    timestamp: new Date().toISOString(),
    errorMessage:
      `cell is served on ${served}; client ${reason}` +
      (rejection
        ? ` (turned away: ${response(rejection)}: ${rejection.message})`
        : ''),
    details: {
      served,
      method,
      headerVersion: headerVersion ?? null,
      ...(rejection && {
        rejected: {
          status: rejection.status,
          code: rejection.code,
          message: rejection.message
        }
      })
    }
  };
}
