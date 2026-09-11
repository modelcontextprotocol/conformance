/**
 * Who is talking to a cell. The hosted report's header names the client and
 * the protocol version it negotiated, read off the wire the same way the
 * mock servers do: the `MCP-Protocol-Version` header plus, on the stateless
 * wire, `_meta['io.modelcontextprotocol/clientInfo']` /
 * `_meta['io.modelcontextprotocol/protocolVersion']` on every request, and on
 * the stateful wire the `initialize` request's `params.clientInfo` /
 * `params.protocolVersion`.
 */

import type { IncomingHttpHeaders } from 'http';
import type { ConformanceCheck } from '../types';

export const IDENTITY_CHECK_ID = 'hosted-client-identity';

export interface ClientIdentity {
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
 * Identity carried by one request, or undefined when the request says
 * nothing about the client (a bare notification with no header, say).
 */
export function identityFrom(
  headers: IncomingHttpHeaders,
  body: Buffer | string | undefined
): ClientIdentity | undefined {
  const header = str(headers['mcp-protocol-version']);
  const userAgent = str(headers['user-agent']);

  let message: Record<string, unknown> | undefined;
  if (body !== undefined) {
    try {
      const parsed: unknown = JSON.parse(body.toString());
      // A JSON-RPC batch: any member carries the same identity.
      message = asRecord(Array.isArray(parsed) ? parsed[0] : parsed);
    } catch {
      message = undefined;
    }
  }
  const params = asRecord(message?.params);
  const meta = asRecord(params?._meta);

  let info: Record<string, unknown> | undefined;
  let protocolVersion: string | undefined;
  if (meta && (meta[META_CLIENT_INFO] || meta[META_PROTOCOL_VERSION])) {
    info = asRecord(meta[META_CLIENT_INFO]);
    protocolVersion = str(meta[META_PROTOCOL_VERSION]) ?? header;
  } else if (message?.method === 'initialize') {
    info = asRecord(params?.clientInfo);
    protocolVersion = str(params?.protocolVersion) ?? header;
  } else {
    protocolVersion = header;
  }

  const identity: ClientIdentity = {
    ...(str(info?.name) && { name: str(info?.name) }),
    ...(str(info?.version) && { version: str(info?.version) }),
    ...(protocolVersion && { protocolVersion }),
    ...(userAgent && { userAgent })
  };
  // A request that names neither the client nor a protocol version tells
  // us nothing worth a check (User-Agent alone is not an identity).
  if (!identity.name && !identity.protocolVersion) return undefined;
  return identity;
}

export function identityKey(identity: ClientIdentity): string {
  return JSON.stringify([
    identity.name,
    identity.version,
    identity.protocolVersion,
    identity.userAgent
  ]);
}

export function identityCheck(identity: ClientIdentity): ConformanceCheck {
  const who = identity.name
    ? `${identity.name}${identity.version ? ` ${identity.version}` : ''}`
    : 'unnamed client';
  return {
    id: IDENTITY_CHECK_ID,
    name: 'Client identity',
    description: `${who}${
      identity.protocolVersion
        ? ` speaking protocol ${identity.protocolVersion}`
        : ''
    } — as the client under test identified itself to this cell`,
    status: 'INFO',
    timestamp: new Date().toISOString(),
    details: { ...identity }
  };
}

/** The identities recorded in a check list, in order of first appearance. */
export function identitiesIn(checks: ConformanceCheck[]): ClientIdentity[] {
  const seen = new Set<string>();
  const out: ClientIdentity[] = [];
  for (const c of checks) {
    if (c.id !== IDENTITY_CHECK_ID || !c.details) continue;
    const identity = c.details as ClientIdentity;
    const key = identityKey(identity);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(identity);
  }
  return out;
}
