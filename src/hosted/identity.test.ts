import { describe, it, expect } from 'vitest';
import { identitiesIn, identityCheck, identityFrom } from './identity';

describe('client identity capture', () => {
  it('reads initialize params on the stateful wire', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        clientInfo: { name: 'sdk-client', version: '1.2.3' },
        capabilities: {}
      }
    });
    expect(identityFrom({ 'user-agent': 'node' }, body)).toEqual({
      name: 'sdk-client',
      version: '1.2.3',
      protocolVersion: '2025-11-25',
      userAgent: 'node'
    });
  });

  it('reads per-request _meta on the 2026-07-28 wire, header as fallback', () => {
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
        body({ _meta: meta })
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
    expect(
      identityFrom(
        { 'mcp-protocol-version': '2026-07-28' },
        body({ _meta: noInfo })
      )
    ).toEqual({ protocolVersion: '2026-07-28' });
    // Batch: the first member speaks for the client.
    expect(
      identityFrom(
        {},
        JSON.stringify([JSON.parse(body({ _meta: meta })), { jsonrpc: '2.0' }])
      )
    ).toMatchObject({ name: 'stateless' });
  });

  it('falls back to the header on later stateful requests and gives up without one', () => {
    const call = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'x' }
    });
    expect(
      identityFrom({ 'mcp-protocol-version': '2025-11-25' }, call)
    ).toEqual({ protocolVersion: '2025-11-25' });
    expect(identityFrom({ 'user-agent': 'curl' }, call)).toBeUndefined();
    expect(identityFrom({}, 'not json')).toBeUndefined();
    expect(identityFrom({}, undefined)).toBeUndefined();
  });

  it('turns identities into one INFO check each and reads them back', () => {
    const a = identityCheck({ name: 'a', version: '1', protocolVersion: 'v' });
    expect(a).toMatchObject({
      id: 'hosted-client-identity',
      status: 'INFO',
      details: { name: 'a', version: '1', protocolVersion: 'v' }
    });
    expect(a.description).toContain('a 1 speaking protocol v');
    const b = identityCheck({ protocolVersion: 'v' });
    expect(identitiesIn([a, b, { ...a }, b])).toEqual([
      { name: 'a', version: '1', protocolVersion: 'v' },
      { protocolVersion: 'v' }
    ]);
  });
});
