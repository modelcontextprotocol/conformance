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
 * Both are FAILUREs, so they decide the cell's verdict (see report.ts). On a
 * dated cell a request at a foreign revision that the wire turned away is
 * version negotiation and records neither (see isNegotiation()).
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
}

export function describeRequest(
  body: Buffer | string | undefined
): RequestInfo {
  const messages = body === undefined ? [] : messagesOfJson(body.toString());
  const methods: string[] = [];
  let bodyVersion: string | undefined;
  for (const m of messages) {
    const method = str(m.method);
    if (method) methods.push(method);
    const params = asRecord(m.params);
    const meta = asRecord(params?._meta);
    bodyVersion ??=
      str(meta?.[META_PROTOCOL_VERSION]) ??
      (method === 'initialize' ? str(params?.protocolVersion) : undefined);
  }
  return { methods, ...(bodyVersion && { bodyVersion }) };
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

/**
 * Whether a request to a dated cell was version negotiation rather than a
 * client at the wrong revision: its header named a revision `served` does
 * not serve and the wire turned it away for it — a 4xx whose body is a
 * lifecycle rejection (see wireRejection()) or a -32601 method-not-found
 * (the probe method does not exist on the dated wire). A dual-era client
 * opens a dated cell that way — `server/discover` at 2026-07-28 is
 * rejected, then it falls back to `initialize` — so neither judgement
 * applies to the rejected request. A foreign-revision request the wire
 * accepted is still the client carrying on at the wrong revision, and on
 * the stateless wire nothing is negotiation.
 */
export function isNegotiation(
  served: SpecVersion,
  headerVersion: string | undefined,
  response: CapturedResponse
): boolean {
  if (!isStatefulVersion(served)) return false;
  if (headerVersion === undefined || headerVersion === served) return false;
  if (response.status < 400 || response.status >= 500) return false;
  if (wireRejection(response, served, headerVersion)) return true;
  return jsonRpcMessages(response.body, response.contentType).some(
    (m) => asRecord(m.error)?.code === -32601
  );
}

/**
 * Why a request is not one the cell's revision `served` should receive, or
 * undefined when it is. On the stateless wire every request must carry the
 * cell's revision in the header and `initialize` does not exist; on a dated
 * (stateful) revision `initialize` negotiates and is exempt, and every later
 * request's header, when present, must name the cell's revision — unless
 * the wire rejected it as negotiation (isNegotiation()), which the caller
 * decides from the response.
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

export function wrongRevisionCheck(
  served: SpecVersion,
  method: string,
  headerVersion: string | undefined,
  reason: string
): ConformanceCheck {
  return {
    id: WRONG_REVISION_CHECK_ID,
    name: 'WrongRevision',
    description: `The client spoke a revision other than the one this cell is served on`,
    status: 'FAILURE',
    timestamp: new Date().toISOString(),
    errorMessage: `cell is served on ${served}; client ${reason}`,
    details: {
      served,
      method,
      headerVersion: headerVersion ?? null
    }
  };
}
