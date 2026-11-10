import { describe, it, expect } from 'vitest';
import {
  addProtocolVersion,
  identitiesIn,
  identityCheck,
  identityChecksIn,
  identityFrom,
  identityOf,
  mergeIdentities
} from './identity';
import type { CapturedResponse } from './wire';

const ok = (
  body?: object,
  contentType = 'application/json'
): CapturedResponse =>
  ({
    status: 200,
    contentType,
    ...(body && { body: JSON.stringify(body) })
  }) as CapturedResponse;

describe('client identity capture', () => {
  const init = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      clientInfo: { name: 'sdk-client', version: '1.2.3' },
      capabilities: {}
    }
  });

  it('reads initialize params and the version the server answered with', () => {
    // JSON response: the negotiated version is result.protocolVersion, not
    // what the client asked for.
    expect(
      identityFrom(
        { 'user-agent': 'node' },
        init,
        ok({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25' } })
      )
    ).toEqual({
      name: 'sdk-client',
      version: '1.2.3',
      protocolVersion: '2025-11-25',
      userAgent: 'node'
    });
    // The SDK transport answers as SSE.
    const sse: CapturedResponse = {
      status: 200,
      contentType: 'text/event-stream',
      body: 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{}}}\n\n'
    };
    expect(identityFrom({}, init, sse)).toEqual({
      name: 'sdk-client',
      version: '1.2.3',
      protocolVersion: '2025-03-26'
    });
    // No usable response body: the requested version is the best we know.
    expect(identityFrom({}, init, { status: 200 })).toMatchObject({
      protocolVersion: '2025-06-18'
    });
  });

  it('reads per-request _meta on the 2026-07-28 wire, the accepted header being the version', () => {
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'stateless', version: '9' },
      'io.modelcontextprotocol/clientCapabilities': {}
    };
    const body = (params: object) =>
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params });
    expect(
      identityFrom(
        { 'mcp-protocol-version': '2026-07-28' },
        body({ _meta: meta }),
        ok()
      )
    ).toEqual({
      name: 'stateless',
      version: '9',
      protocolVersion: '2026-07-28'
    });
    // clientInfo is a SHOULD: version from _meta, no name.
    const noInfo = Object.fromEntries(
      Object.entries(meta).filter(
        ([k]) => k !== 'io.modelcontextprotocol/clientInfo'
      )
    );
    expect(identityFrom({}, body({ _meta: noInfo }), ok())).toEqual({
      protocolVersion: '2026-07-28'
    });
    // Batch: the first member speaks for the client.
    expect(
      identityFrom(
        {},
        JSON.stringify([JSON.parse(body({ _meta: meta })), { jsonrpc: '2.0' }]),
        ok()
      )
    ).toMatchObject({ name: 'stateless' });
  });

  it('records nothing from a rejected request or a header-only stateful request', () => {
    const call = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'x' }
    });
    // A later stateful request repeats what initialize established.
    expect(
      identityFrom({ 'mcp-protocol-version': '2025-11-25' }, call, ok())
    ).toBeUndefined();
    // Turned away: says nothing about who the client is.
    expect(identityFrom({}, init, { status: 400 })).toBeUndefined();
    expect(identityFrom({ 'user-agent': 'curl' }, call, ok())).toBeUndefined();
    expect(identityFrom({}, 'not json', ok())).toBeUndefined();
    expect(identityFrom({}, undefined, ok())).toBeUndefined();
  });

  it('is one INFO check per client, pooling the protocol versions it spoke', () => {
    const a = identityCheck(
      identityOf({ name: 'a', version: '1', protocolVersion: 'v1' })
    );
    expect(a).toMatchObject({
      id: 'hosted-client-identity',
      status: 'INFO',
      details: { name: 'a', version: '1', protocolVersions: ['v1'] }
    });
    expect(a.description).toContain('a 1 speaking protocol v1');
    expect(addProtocolVersion(a, 'v2')).toBe(true);
    expect(addProtocolVersion(a, 'v2')).toBe(false);
    expect(a.details?.protocolVersions).toEqual(['v1', 'v2']);
    expect(a.description).toContain('speaking protocol v1, v2');

    // Rows from two processes, each with its own view of the same client
    // (and a different User-Agent — not part of who the client is).
    const fromB = identityCheck(
      identityOf({
        name: 'a',
        version: '1',
        protocolVersion: 'v3',
        userAgent: 'ua'
      })
    );
    const anon = identityCheck(identityOf({ protocolVersion: 'v1' }));
    const merged = identityChecksIn([a, fromB, anon, { ...anon }]);
    expect(merged).toHaveLength(2);
    expect(merged[0].details).toEqual({
      name: 'a',
      version: '1',
      protocolVersions: ['v1', 'v2', 'v3']
    });
    expect(identitiesIn([a, fromB, anon])).toEqual([
      { name: 'a', version: '1', protocolVersions: ['v1', 'v2', 'v3'] },
      { protocolVersions: ['v1'] }
    ]);

    const into = new Map();
    mergeIdentities(into, identitiesIn([a]));
    mergeIdentities(into, identitiesIn([fromB]));
    expect(Array.from(into.values())).toEqual([
      { name: 'a', version: '1', protocolVersions: ['v1', 'v2', 'v3'] }
    ]);
  });
});
