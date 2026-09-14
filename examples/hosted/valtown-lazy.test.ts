/**
 * A cold val.town isolate evaluates valtown.ts before it can answer, and a
 * client may give `server/discover` only a second before it falls back to an
 * older handshake. So importing the entry constructs no scenario and
 * compiles no wire schema, the matrix pages load none, and a request loads
 * its own cell's scenario and nothing else (see src/hosted/catalog.ts).
 */

import { describe, it, expect } from 'vitest';
import handler from './valtown';
import { hostedScenarios } from '../../src/hosted/catalog';
import { compiledSpecVersions } from '../../src/validation/wire-schema';

const STATELESS = '2026-07-28';

function discover(url: string): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': STATELESS
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': STATELESS,
          'io.modelcontextprotocol/clientInfo': { name: 'lazy', version: '1' },
          'io.modelcontextprotocol/clientCapabilities': {}
        }
      }
    })
  });
}

describe('val.town entry, cold', () => {
  it('constructs no scenario and compiles no schema at import', () => {
    expect(hostedScenarios.loadedNames()).toEqual([]);
    expect(compiledSpecVersions()).toEqual([]);
  });

  it('serves the matrix without loading a scenario', async () => {
    const list = await handler(new Request('http://test/scenarios')).then((r) =>
      r.json()
    );
    expect(list).toHaveLength(hostedScenarios.names.length);
    const landing = await handler(
      new Request('http://test/', { headers: { accept: 'text/html' } })
    );
    expect(landing.status).toBe(200);
    expect(hostedScenarios.loadedNames()).toEqual([]);
  });

  it("loads only the cell's own scenario to answer a discover", async () => {
    const r = await handler(
      discover(`http://test/s/lazy1/${STATELESS}/tools_call/mcp`)
    );
    expect(r.status).toBe(200);
    expect((await r.json()).result.supportedVersions).toEqual([STATELESS]);
    expect(hostedScenarios.loadedNames()).toEqual(['tools_call']);
  });
});
