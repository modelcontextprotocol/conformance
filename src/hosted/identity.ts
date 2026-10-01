/**
 * Who is talking to a cell. The hosted report's header names the client and
 * the protocol version(s) it negotiated, read off accepted exchanges the way
 * the mock servers see them: on the stateful wire the `initialize` request's
 * `params.clientInfo` with the version the server answered in
 * `result.protocolVersion`; on the stateless wire every request's
 * `_meta['io.modelcontextprotocol/clientInfo']` with the accepted request's
 * `MCP-Protocol-Version` header. A request the cell turned away (4xx) says
 * nothing about who the client is, and a later stateful request that only
 * carries the header repeats what `initialize` already established, so
 * neither is recorded. One client (name, version) is one identity, however
 * many protocol versions it spoke.
 */

import type { IncomingHttpHeaders } from 'http';
import type { ConformanceCheck } from '../types';
import { jsonRpcMessages, type CapturedResponse } from './wire';

export const IDENTITY_CHECK_ID = 'hosted-client-identity';

/** One client as the report shows it. */
export interface ClientIdentity {
  name?: string;
  version?: string;
  /** Protocol versions negotiated with this client, first seen first. */
  protocolVersions: string[];
  userAgent?: string;
}

/** What one accepted exchange said about the client. */
export interface IdentityObservation {
  name?: string;
  version?: string;
  protocolVersion?: string;
  userAgent?: string;
}

const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * The identity one accepted exchange establishes, or undefined when it
 * establishes nothing new: the request was turned away, carries neither
 * `initialize` params nor `_meta`, or is not JSON.
 */
export function identityFrom(
  headers: IncomingHttpHeaders,
  body: Buffer | string | undefined,
  response: CapturedResponse
): IdentityObservation | undefined {
  if (response.status >= 400 || body === undefined) return undefined;
  const header = str(headers['mcp-protocol-version']);
  const userAgent = str(headers['user-agent']);

  let message: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(body.toString());
    // A JSON-RPC batch: any member carries the same identity.
    message = asRecord(Array.isArray(parsed) ? parsed[0] : parsed);
  } catch {
    return undefined;
  }
  const params = asRecord(message?.params);
  const meta = asRecord(params?._meta);

  let info: Record<string, unknown> | undefined;
  let protocolVersion: string | undefined;
  if (meta && (meta[META_CLIENT_INFO] || meta[META_PROTOCOL_VERSION])) {
    // Stateless wire: the header the cell accepted is the negotiated version.
    info = asRecord(meta[META_CLIENT_INFO]);
    protocolVersion = header ?? str(meta[META_PROTOCOL_VERSION]);
  } else if (message?.method === 'initialize') {
    // Stateful wire: the version the server answered with is the one
    // negotiated — the SDK transport may answer as SSE, hence both parsers.
    info = asRecord(params?.clientInfo);
    protocolVersion =
      negotiatedVersion(response) ?? str(params?.protocolVersion) ?? header;
  } else {
    return undefined;
  }

  return {
    ...(str(info?.name) && { name: str(info?.name) }),
    ...(str(info?.version) && { version: str(info?.version) }),
    ...(protocolVersion && { protocolVersion }),
    ...(userAgent && { userAgent })
  };
}

/** `result.protocolVersion` of the initialize response, JSON or SSE body. */
function negotiatedVersion(response: CapturedResponse): string | undefined {
  for (const m of jsonRpcMessages(response.body, response.contentType)) {
    const v = str(asRecord(m.result)?.protocolVersion);
    if (v) return v;
  }
  return undefined;
}

/** One client is one (name, version); the versions it spoke accumulate. */
export function identityKey(
  identity: Pick<ClientIdentity, 'name' | 'version'>
): string {
  return JSON.stringify([identity.name, identity.version]);
}

function describe(identity: ClientIdentity): string {
  const who = identity.name
    ? `${identity.name}${identity.version ? ` ${identity.version}` : ''}`
    : 'unnamed client';
  const spoke = identity.protocolVersions.length
    ? ` speaking protocol ${identity.protocolVersions.join(', ')}`
    : '';
  return `${who}${spoke} — as the client under test identified itself to this cell`;
}

export function identityCheck(identity: ClientIdentity): ConformanceCheck {
  return {
    id: IDENTITY_CHECK_ID,
    name: 'Client identity',
    description: describe(identity),
    status: 'INFO',
    timestamp: new Date().toISOString(),
    details: { ...identity, protocolVersions: [...identity.protocolVersions] }
  };
}

/** The identity one observation establishes on its own. */
export function identityOf(observation: IdentityObservation): ClientIdentity {
  const { protocolVersion, ...rest } = observation;
  return {
    ...rest,
    protocolVersions: protocolVersion ? [protocolVersion] : []
  };
}

/**
 * Fold a protocol version into a recorded identity check: appended to its
 * `protocolVersions` (once) and reflected in its description. Returns
 * whether the check changed.
 */
export function addProtocolVersion(
  check: ConformanceCheck,
  protocolVersion: string | undefined
): boolean {
  const identity = identityIn(check);
  if (!identity || !protocolVersion) return false;
  if (identity.protocolVersions.includes(protocolVersion)) return false;
  identity.protocolVersions.push(protocolVersion);
  check.details = { ...identity };
  check.description = describe(identity);
  return true;
}

function identityIn(check: ConformanceCheck): ClientIdentity | undefined {
  if (check.id !== IDENTITY_CHECK_ID || !check.details) return undefined;
  const d = check.details as Partial<ClientIdentity>;
  return {
    ...(d.name !== undefined && { name: d.name }),
    ...(d.version !== undefined && { version: d.version }),
    ...(d.userAgent !== undefined && { userAgent: d.userAgent }),
    protocolVersions: Array.isArray(d.protocolVersions)
      ? [...d.protocolVersions]
      : []
  };
}

/**
 * The identity checks in a list collapsed to one per client, in order of
 * first appearance, each carrying every protocol version any of them saw.
 * Rows from several processes each hold their own view of a client; this
 * is what the results view shows instead.
 */
export function identityChecksIn(
  checks: ConformanceCheck[]
): ConformanceCheck[] {
  const byKey = new Map<string, ConformanceCheck>();
  for (const c of checks) {
    const identity = identityIn(c);
    if (!identity) continue;
    const key = identityKey(identity);
    const kept = byKey.get(key);
    if (!kept) {
      byKey.set(key, { ...c, details: { ...identity } });
      continue;
    }
    for (const v of identity.protocolVersions) addProtocolVersion(kept, v);
  }
  return Array.from(byKey.values());
}

/** The clients a check list names, one per (name, version). */
export function identitiesIn(checks: ConformanceCheck[]): ClientIdentity[] {
  return identityChecksIn(checks).map((c) => identityIn(c) as ClientIdentity);
}

/** Merge `seen` into `into` by client, accumulating protocol versions. */
export function mergeIdentities(
  into: Map<string, ClientIdentity>,
  seen: ClientIdentity[]
): void {
  for (const i of seen) {
    const key = identityKey(i);
    const kept = into.get(key);
    if (!kept) {
      into.set(key, { ...i, protocolVersions: [...i.protocolVersions] });
      continue;
    }
    for (const v of i.protocolVersions) {
      if (!kept.protocolVersions.includes(v)) kept.protocolVersions.push(v);
    }
  }
}
