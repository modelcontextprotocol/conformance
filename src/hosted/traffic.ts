/**
 * A cell's traffic: each request the client sent it — to its MCP endpoint,
 * to the metadata the cell serves at its own origin, and to its sign-in
 * server through the relay — with the cell's answer, as the cell page lists
 * it and `/results/<cell>/traffic.jsonl` hands it out.
 *
 * Each process keeps, per build of a cell, one row of exchanges and writes
 * it to the run store beside its checks (see SessionManager.write()), so a
 * page served by any process lists what every process saw. A row is capped
 * (TRAFFIC_ROW_EXCHANGES, TRAFFIC_ROW_BYTES), and so is each body
 * (TRAFFIC_BODY_CAP), with the cut said; a store refuses a row that would
 * take one cell's traffic over TRAFFIC_CELL_BYTES.
 *
 * What is never kept: the value of an Authorization or DPoP header (only
 * whether one was sent), nor a credential's value in a body (see
 * redacted()). A credential the cell issued (a registered
 * client_id, an authorization code, an access or refresh token) is kept as
 * a keyed hash in `issued`, so that after a reset the cell can refuse one
 * handed out before it (see refusedCredential()).
 */

import { createHash, randomBytes } from 'crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'http';

/** Which origin an exchange went to, as the page's gutter shows it. */
export type Lane = 'mcp' | 'metadata' | 'sign-in';

/** Request and response bodies are kept up to this many bytes each. */
export const TRAFFIC_BODY_CAP = 8 * 1024;

/** Exchanges one process keeps per cell and attempt; later ones are counted. */
export const TRAFFIC_ROW_EXCHANGES = 150;

/** …and bytes: whichever comes first. */
export const TRAFFIC_ROW_BYTES = 192 * 1024;

/**
 * One cell's traffic across processes, at most: a store refuses a row that
 * would take the cell over it (see RunStore.saveTraffic()).
 */
export const TRAFFIC_CELL_BYTES = 1024 * 1024;

/** A JSON-RPC message the request carried: its method and id. */
export interface RpcSummary {
  method?: string;
  id?: string | number | null;
}

export interface Exchange {
  /** When the request arrived (ISO 8601, with milliseconds). */
  at: string;
  /** How long the cell took to answer, when it has. */
  ms?: number;
  lane: Lane;
  /** On the sign-in lane: which relay (`as`, `as2`, `idp`). */
  role?: string;
  method: string;
  /** The path at the cell's origin, with its query. */
  path: string;
  rpc?: RpcSummary[];
  /** The request headers that matter (see keptRequestHeaders()). */
  headers: Record<string, string>;
  /** Whether the request carried an Authorization header; never its value. */
  authorization: 'present' | 'absent';
  /**
   * The credential the client presented was issued before the cell was
   * last reset, so the cell treated it as unknown (see refusedCredential()).
   */
  refused?: CredentialKind;
  /** The request body as text, cut at TRAFFIC_BODY_CAP. */
  body?: string;
  /** The body's full size in bytes, when it was cut. */
  bodyBytes?: number;
  /** Absent while a stream the cell answered with is still open. */
  status?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  responseBytes?: number;
  /**
   * Which connection carried it: `s:<MCP session id>` on the stateful wire,
   * else `t:<process>.<socket>` when the host shows the socket; absent when
   * it cannot be told (a fetch-style host sees no sockets).
   */
  conn?: string;
  /** The same exchange again right after, this many more times. */
  repeats?: number;
}

/** One process's traffic for one build of a cell, as stored. */
export interface TrafficRow {
  exchanges: Exchange[];
  /** Exchanges not kept because the row reached its cap. */
  omitted: number;
  /** Keyed hashes of the credentials the cell issued (see issuedBy()). */
  issued: string[];
}

export function emptyRow(): TrafficRow {
  return { exchanges: [], omitted: 0, issued: [] };
}

const KEPT_HEADERS = new Set([
  'user-agent',
  'content-type',
  'accept',
  'last-event-id',
  'origin'
]);

/**
 * The request headers an exchange keeps: every `Mcp-*` header, and
 * User-Agent, Content-Type, Accept, Last-Event-ID and Origin. A DPoP proof,
 * like Authorization, is kept only as present.
 */
export function keptRequestHeaders(
  headers: IncomingHttpHeaders
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const text = Array.isArray(value) ? value.join(', ') : value;
    if (name.startsWith('mcp-') || KEPT_HEADERS.has(name)) out[name] = text;
    else if (name === 'dpop') out[name] = '(present)';
  }
  return out;
}

const KEPT_RESPONSE_HEADERS = new Set([
  'content-type',
  'www-authenticate',
  'location',
  'allow'
]);

export function keptResponseHeaders(
  get: (name: string) => unknown,
  names: readonly string[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const n = name.toLowerCase();
    if (!n.startsWith('mcp-') && !KEPT_RESPONSE_HEADERS.has(n)) continue;
    const value = get(n);
    if (typeof value === 'string') out[n] = value;
    else if (typeof value === 'number') out[n] = String(value);
    else if (Array.isArray(value)) out[n] = value.join(', ');
  }
  return out;
}

/** `text` cut at TRAFFIC_BODY_CAP bytes, with its full size when cut. */
export function capped(
  text: string | undefined,
  size = text === undefined ? 0 : Buffer.byteLength(text)
): { text?: string; bytes?: number } {
  if (text === undefined || text === '') return {};
  if (size <= TRAFFIC_BODY_CAP && Buffer.byteLength(text) <= TRAFFIC_BODY_CAP)
    return { text };
  const cut = Buffer.from(text).subarray(0, TRAFFIC_BODY_CAP).toString('utf8');
  return { text: cut.replace(/�$/, ''), bytes: size };
}

/**
 * Fields whose values are credentials a client could present: an access
 * token is what an Authorization header carries, so it is no more kept in
 * a body than in the header. What the flow needs to be read (a code, a
 * PKCE verifier, a client_id) stays.
 */
const SECRET_FIELDS = new Set([
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'client_assertion',
  'assertion',
  'subject_token',
  'actor_token'
]);

/** What a credential's value reads as in a kept body. */
export const REDACTED = '(not kept)';

const SECRET_PAIR = new RegExp(
  `"(${Array.from(SECRET_FIELDS).join('|')})"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*"`,
  'g'
);

/**
 * A JSON or form body with each credential's value (SECRET_FIELDS, at any
 * depth of a JSON body) replaced by REDACTED. Anything else is returned as
 * it is.
 */
export function redacted(text: string | undefined): string | undefined {
  if (!text) return text;
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Cut short, say: each "field": "value" pair is found by pattern.
      return text.replace(
        SECRET_PAIR,
        (_m, k: string) => `"${k}":"${REDACTED}"`
      );
    }
    let hit = false;
    const walk = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(walk);
      if (typeof v !== 'object' || v === null) return v;
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => {
          if (SECRET_FIELDS.has(k) && typeof x === 'string') {
            hit = true;
            return [k, REDACTED];
          }
          return [k, walk(x)];
        })
      );
    };
    const out = walk(parsed);
    return hit ? JSON.stringify(out) : text;
  }
  if (/^[\w.~%-]+=/.test(trimmed)) {
    const params = new URLSearchParams(text);
    let hit = false;
    for (const key of params.keys()) {
      if (SECRET_FIELDS.has(key)) {
        params.set(key, REDACTED);
        hit = true;
      }
    }
    return hit ? params.toString() : text;
  }
  return text;
}

/** The JSON-RPC messages in a body: each one's method and id. */
export function rpcOf(body: string | undefined): RpcSummary[] | undefined {
  if (!body) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const out: RpcSummary[] = [];
  for (const m of list) {
    if (typeof m !== 'object' || m === null) continue;
    const r = m as Record<string, unknown>;
    if (r.jsonrpc === undefined && r.method === undefined) continue;
    const id = r.id;
    out.push({
      ...(typeof r.method === 'string' && { method: r.method }),
      ...((typeof id === 'string' || typeof id === 'number' || id === null) && {
        id
      })
    });
  }
  return out.length ? out : undefined;
}

/** Without the JSON-RPC ids, so two otherwise equal messages compare equal. */
function withoutIds(body: string | undefined): string {
  if (!body) return '';
  try {
    const parsed: unknown = JSON.parse(body);
    const strip = (m: unknown) => {
      if (typeof m !== 'object' || m === null || Array.isArray(m)) return m;
      const rest = { ...(m as Record<string, unknown>) };
      delete rest.id;
      return rest;
    };
    return JSON.stringify(
      Array.isArray(parsed) ? parsed.map(strip) : strip(parsed)
    );
  } catch {
    return body;
  }
}

/**
 * The same request with the same answer, but for JSON-RPC ids and times: a
 * client asking again and again (a server/discover on every reconnect, a
 * poll) makes one row with `repeats`, and a row whose only change is a
 * repeat is not written on its own (see substance()).
 */
export function sameExchange(a: Exchange, b: Exchange): boolean {
  return (
    a.lane === b.lane &&
    a.method === b.method &&
    a.path === b.path &&
    a.status === b.status &&
    a.conn === b.conn &&
    a.authorization === b.authorization &&
    a.refused === b.refused &&
    JSON.stringify(a.headers) === JSON.stringify(b.headers) &&
    withoutIds(a.body) === withoutIds(b.body) &&
    withoutIds(a.responseBody) === withoutIds(b.responseBody)
  );
}

/**
 * The row as it is compared with what was last written: without repeat
 * counts, so asking the same thing again sends no write of its own.
 */
export function substance(row: TrafficRow): string {
  return JSON.stringify({
    ...row,
    exchanges: row.exchanges.map((e) => ({ ...e, repeats: undefined }))
  });
}

/** What kind of credential a request presented or a response issued. */
export type CredentialKind = 'token' | 'code' | 'client_id' | 'refresh_token';

/**
 * A credential's keyed hash, as `issued` keeps it: enough to know one again,
 * never enough to use it.
 */
export function credentialHash(value: string): string {
  return createHash('sha256')
    .update('hosted-credential\n')
    .update(value)
    .digest('base64url')
    .slice(0, 22);
}

function parseJson(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * The credentials a response hands the client, hashed: a registration's
 * client_id, the code in an authorization redirect, and the access and
 * refresh tokens of a token response.
 */
export function issuedBy(
  path: string,
  status: number,
  location: string | undefined,
  body: string | undefined
): string[] {
  const out: string[] = [];
  if (status >= 200 && status < 300) {
    const json = parseJson(body);
    for (const key of ['access_token', 'refresh_token']) {
      const v = json[key];
      if (typeof v === 'string' && v) out.push(credentialHash(v));
    }
    const route = path.split('?')[0];
    if (route.endsWith('/register') && typeof json.client_id === 'string')
      out.push(credentialHash(json.client_id));
  }
  if (location && status >= 300 && status < 400) {
    try {
      const code = new URL(location, 'http://x').searchParams.get('code');
      if (code) out.push(credentialHash(code));
    } catch {
      // not a URL
    }
  }
  return out;
}

/** The bearer or DPoP token in an Authorization header. */
export function presentedToken(
  authorization: string | undefined
): string | undefined {
  const m = /^(?:Bearer|DPoP)\s+(\S+)/i.exec(authorization ?? '');
  return m?.[1];
}

/**
 * The first credential in a request that the cell issued before its last
 * reset (`refused` holds their hashes), with its kind: a token in the
 * Authorization header, or a code, refresh token or client_id in the query
 * or the (JSON or form) body. A client_id is refused only where it names the
 * client (the authorization and token endpoints), not in a registration.
 */
export function refusedCredential(
  refused: ReadonlySet<string>,
  authorization: string | undefined,
  path: string,
  body: string | undefined,
  contentType: string | undefined
): CredentialKind | undefined {
  if (!refused.size) return undefined;
  const token = presentedToken(authorization);
  if (token && refused.has(credentialHash(token))) return 'token';
  const q = path.indexOf('?');
  const params = new URLSearchParams(q === -1 ? '' : path.slice(q + 1));
  let fields: Record<string, unknown> = Object.fromEntries(params);
  if (body) {
    if (/json/i.test(contentType ?? ''))
      fields = { ...fields, ...parseJson(body) };
    else if (/x-www-form-urlencoded/i.test(contentType ?? ''))
      fields = { ...fields, ...Object.fromEntries(new URLSearchParams(body)) };
  }
  const route = (q === -1 ? path : path.slice(0, q)).replace(/\/+$/, '');
  const kinds: CredentialKind[] = ['code', 'refresh_token'];
  if (!route.endsWith('/register')) kinds.push('client_id');
  for (const kind of kinds) {
    const v = fields[kind];
    if (typeof v === 'string' && v && refused.has(credentialHash(v)))
      return kind;
  }
  return undefined;
}

/** What a refused credential is called on the page. */
export const REFUSED_TEXT: Record<CredentialKind, string> = {
  token: 'an access token',
  code: 'an authorization code',
  refresh_token: 'a refresh token',
  client_id: 'a client registration'
};

/**
 * The OAuth error the sign-in server answers a refused code, refresh token
 * or client_id with (a token is refused by withholding it from the cell,
 * which then answers its normal 401).
 */
export function refusalBody(kind: CredentialKind): {
  error: string;
  error_description: string;
} {
  const what = REFUSED_TEXT[kind];
  return {
    error: kind === 'client_id' ? 'invalid_client' : 'invalid_grant',
    error_description: `${what} issued before this test cell was reset; start the sign-in again${
      kind === 'client_id' ? ' and register again' : ''
    }`
  };
}

/**
 * Add `exchange` to `row`: as a repeat of the row's last exchange when it is
 * the same (sameExchange()), else as a new one, unless the row is at its
 * cap, when it is only counted. Returns the exchange the row now holds for
 * it (the earlier one on a repeat), or undefined when it was not kept.
 */
export function addExchange(
  row: TrafficRow,
  exchange: Exchange,
  size: { bytes: number }
): Exchange | undefined {
  const last = row.exchanges[row.exchanges.length - 1];
  if (last && sameExchange(last, exchange)) {
    last.repeats = (last.repeats ?? 0) + 1;
    return last;
  }
  const bytes = JSON.stringify(exchange).length;
  if (
    row.exchanges.length >= TRAFFIC_ROW_EXCHANGES ||
    size.bytes + bytes > TRAFFIC_ROW_BYTES
  ) {
    row.omitted++;
    return undefined;
  }
  size.bytes += bytes;
  row.exchanges.push(exchange);
  return exchange;
}

/** Note what a response issued in the row, once each. */
export function addIssued(row: TrafficRow, hashes: readonly string[]): void {
  for (const h of hashes) if (!row.issued.includes(h)) row.issued.push(h);
}

/** Every row's exchanges in time order, each said once. */
export function mergeRows(rows: Iterable<TrafficRow>): {
  exchanges: Exchange[];
  omitted: number;
} {
  const seen = new Set<string>();
  const exchanges: Exchange[] = [];
  let omitted = 0;
  for (const row of rows) {
    omitted += row.omitted;
    for (const e of row.exchanges) {
      const key = JSON.stringify(e);
      if (seen.has(key)) continue;
      seen.add(key);
      exchanges.push(e);
    }
  }
  exchanges.sort((a, b) => a.at.localeCompare(b.at));
  return { exchanges, omitted };
}

/** How long after an exchange's answer a check it decided may be stamped. */
const LINK_SLACK_MS = 250;

/** How far a check may trail an exchange it is tied to by time alone. */
const LINK_WINDOW_MS = 2_000;

/**
 * The exchange that decided a check stamped `timestamp`: the latest one
 * under way at that moment (arrived at or before it, answered no more than
 * LINK_SLACK_MS before it), else the latest one that arrived within
 * LINK_WINDOW_MS before it. Scenarios record a check while they handle the
 * request it is about, and the hosted layer as the answer goes out, so the
 * time ties each to its exchange. Returns an index into `exchanges`, which
 * are in time order.
 */
export function exchangeFor(
  timestamp: string | undefined,
  exchanges: readonly Exchange[]
): number | undefined {
  const t = Date.parse(timestamp ?? '');
  if (Number.isNaN(t)) return undefined;
  let fallback: number | undefined;
  for (let i = exchanges.length - 1; i >= 0; i--) {
    const start = Date.parse(exchanges[i].at);
    if (start > t + 2) continue;
    const end = start + (exchanges[i].ms ?? 0);
    if (exchanges[i].ms === undefined || t <= end + LINK_SLACK_MS) return i;
    if (fallback === undefined && t - start <= LINK_WINDOW_MS) fallback = i;
  }
  return fallback;
}

/** An exchange as one line of `traffic.jsonl`. */
export function jsonLine(
  e: Exchange,
  attempt: number,
  n: number,
  conns: ReadonlyMap<string, number>
): string {
  const { conn, ...rest } = e;
  return JSON.stringify({
    attempt,
    n,
    ...rest,
    ...(conn !== undefined && { connection: conns.get(conn) })
  });
}

/** This process, in the connection keys it makes. */
const PROCESS = randomBytes(3).toString('hex');

/**
 * Set on a request the hosted layer makes from another (a composite's copy
 * for each of its cells): the connection the original came over.
 */
export const CONNECTION = Symbol.for('mcp-conformance.hosted.connection');

const sockets = new WeakMap<object, string>();
let socketSeq = 0;

/**
 * The connection a request came over, as Exchange.conn keeps it: on the
 * stateful wire, its MCP session when it names one (or `opened`, the one
 * its answer opened); else the socket, when the host has a real one (the
 * stateless wire's session header names no session). Undefined when
 * neither can be told, as behind a fetch-style host.
 */
export function connectionOf(
  req: IncomingMessage,
  session?: { stateful: boolean; opened?: string }
): string | undefined {
  if (session?.stateful) {
    const named = req.headers['mcp-session-id'];
    const id = typeof named === 'string' ? named : session.opened;
    if (id) return `s:${id}`;
  }
  const carried = (req as IncomingMessage & { [CONNECTION]?: string })[
    CONNECTION
  ];
  if (typeof carried === 'string') return carried;
  const socket = req.socket as IncomingMessage['socket'] | undefined;
  if (!socket || socket.remotePort === undefined) return undefined;
  let id = sockets.get(socket);
  if (!id) sockets.set(socket, (id = `t:${PROCESS}.${++socketSeq}`));
  return id;
}

/** Each connection key numbered 1, 2, … in the order it first appears. */
export function connectionNumbers(
  exchanges: readonly Exchange[]
): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of exchanges) {
    if (e.conn !== undefined && !out.has(e.conn)) out.set(e.conn, out.size + 1);
  }
  return out;
}
