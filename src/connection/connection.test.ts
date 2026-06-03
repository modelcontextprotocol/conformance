import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  connectFor,
  isStatefulVersion,
  lifecycleFor,
  STATELESS_SPEC_VERSIONS
} from './select';
import { connectStateful } from './stateful';
import { connectStateless } from './stateless';
import { JsonRpcError } from './index';
import { DRAFT_PROTOCOL_VERSION } from '../types';

describe('connectFor', () => {
  it('returns stateful for dated 2025-x versions', () => {
    expect(connectFor('2025-03-26')).toBe(connectStateful);
    expect(connectFor('2025-06-18')).toBe(connectStateful);
    expect(connectFor('2025-11-25')).toBe(connectStateful);
  });
  it('returns stateless for the draft version', () => {
    // connectFor wraps connectStateless in a closure (to pass the spec
    // version through), so identity with connectStateless no longer holds;
    // assert it did not select the stateful implementation. The wire-level
    // behaviour of the wrapper is covered in stateless.test.ts.
    expect(connectFor('DRAFT-2026-v1')).not.toBe(connectStateful);
    expect(connectFor('DRAFT-2026-v1')).not.toBe(connectStateless);
  });
});

describe('lifecycleFor', () => {
  it('maps dated 2025-x versions to stateful and the draft to stateless', () => {
    expect(lifecycleFor('2025-03-26')).toBe('stateful');
    expect(lifecycleFor('2025-11-25')).toBe('stateful');
    expect(lifecycleFor(DRAFT_PROTOCOL_VERSION)).toBe('stateless');
  });
});

describe('STATELESS_SPEC_VERSIONS', () => {
  it('contains exactly the versions isStatefulVersion rejects', () => {
    expect(STATELESS_SPEC_VERSIONS.length).toBeGreaterThan(0);
    for (const v of STATELESS_SPEC_VERSIONS) {
      expect(isStatefulVersion(v)).toBe(false);
    }
  });
  it('currently contains only the draft version', () => {
    expect(STATELESS_SPEC_VERSIONS).toEqual([DRAFT_PROTOCOL_VERSION]);
  });
});

describe('connectStateless', () => {
  const mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
  afterEach(() => mockFetch.mockReset());

  function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    });
  }

  function sseResponse(events: string[]) {
    return new Response(events.join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    });
  }

  it('injects required _meta keys and MCP-Protocol-Version header', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ jsonrpc: '2.0', id: 1, result: { ok: true } })
    );
    const conn = await connectStateless('http://test/mcp');
    await conn.request('tools/list');

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers['MCP-Protocol-Version']).toBe('DRAFT-2026-v1');
    const sent = JSON.parse(init.body);
    expect(sent.params._meta['io.modelcontextprotocol/protocolVersion']).toBe(
      'DRAFT-2026-v1'
    );
    expect(
      sent.params._meta['io.modelcontextprotocol/clientInfo']
    ).toBeDefined();
    expect(
      sent.params._meta['io.modelcontextprotocol/clientCapabilities']
    ).toBeDefined();
  });

  it('throws JsonRpcError on JSON-RPC error responses', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32601, message: 'Method not found' }
      })
    );
    const conn = await connectStateless('http://test/mcp');
    await expect(conn.request('nope')).rejects.toSatisfy(
      (e) => e instanceof JsonRpcError && e.code === -32601
    );
  });

  it('throws on non-2xx JSON without a JSON-RPC error envelope', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ detail: 'gateway rejected' }, 502)
    );
    const conn = await connectStateless('http://test/mcp');
    await expect(conn.request('tools/list')).rejects.toThrow(/HTTP 502/);
  });

  it('throws a useful error for non-JSON non-SSE responses', async () => {
    mockFetch.mockResolvedValue(
      new Response('<html>500</html>', {
        status: 500,
        headers: { 'content-type': 'text/html' }
      })
    );
    const conn = await connectStateless('http://test/mcp');
    await expect(conn.request('tools/list')).rejects.toThrow(/HTTP 500/);
  });

  it('parses SSE: collects notifications and returns final result (LF)', async () => {
    mockFetch.mockResolvedValue(
      sseResponse([
        'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n\n',
        'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"done":true}}\n\n'
      ])
    );
    const conn = await connectStateless('http://test/mcp');
    const result = await conn.request<{ done: boolean }>('tools/call', {});
    expect(result.done).toBe(true);
    expect(conn.notifications).toHaveLength(1);
    expect(conn.notifications[0].method).toBe('notifications/progress');
  });

  it('parses SSE with CRLF line endings', async () => {
    mockFetch.mockResolvedValue(
      sseResponse([
        'event: message\r\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\r\n\r\n'
      ])
    );
    const conn = await connectStateless('http://test/mcp');
    const result = await conn.request<{ ok: boolean }>('tools/call', {});
    expect(result.ok).toBe(true);
  });

  it('rejects server-to-client requests on the SSE stream', async () => {
    mockFetch.mockResolvedValue(
      sseResponse([
        'event: message\ndata: {"jsonrpc":"2.0","id":99,"method":"elicitation/create","params":{}}\n\n'
      ])
    );
    const conn = await connectStateless('http://test/mcp');
    await expect(conn.request('tools/call', {})).rejects.toThrow(/MRTR/);
  });
});
