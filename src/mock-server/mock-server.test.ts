import { describe, it, expect } from 'vitest';
import { createServerFor } from './select';
import { createServerStateful } from './stateful';
import { createServerStateless } from './stateless';
import { DRAFT_PROTOCOL_VERSION } from '../types';

describe('createServerFor', () => {
  it('returns stateful for dated 2025-x versions', () => {
    expect(createServerFor('2025-06-18')).toBe(createServerStateful);
    expect(createServerFor('2025-11-25')).toBe(createServerStateful);
  });
  it('returns stateless for the draft version', () => {
    expect(createServerFor(DRAFT_PROTOCOL_VERSION)).toBe(createServerStateless);
  });
});

describe('createServerStateless', () => {
  const meta = {
    'io.modelcontextprotocol/protocolVersion': DRAFT_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientInfo': { name: 't', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': {}
  };

  async function post(url: string, body: object, headers: object = {}) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    });
    return { status: r.status, body: await r.json() };
  }

  it('rejects requests missing the version header', async () => {
    const srv = await createServerStateless({});
    try {
      const { status, body } = await post(srv.url, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: meta }
      });
      expect(status).toBe(400);
      expect(body.error.code).toBe(-32001);
    } finally {
      await srv.close();
    }
  });

  it('rejects requests missing required _meta keys', async () => {
    const srv = await createServerStateless({});
    try {
      const { status, body } = await post(
        srv.url,
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        { 'mcp-protocol-version': DRAFT_PROTOCOL_VERSION }
      );
      expect(status).toBe(400);
      expect(body.error.code).toBe(-32602);
    } finally {
      await srv.close();
    }
  });

  it('serves server/discover', async () => {
    const srv = await createServerStateless({});
    try {
      const { status, body } = await post(
        srv.url,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'server/discover',
          params: { _meta: meta }
        },
        { 'mcp-protocol-version': DRAFT_PROTOCOL_VERSION }
      );
      expect(status).toBe(200);
      expect(body.result.supportedVersions).toEqual([DRAFT_PROTOCOL_VERSION]);
      expect(body.result.serverInfo.name).toBe('conformance-mock-server');
    } finally {
      await srv.close();
    }
  });

  it('routes to handlers and records requests', async () => {
    const srv = await createServerStateless({
      'tools/list': () => ({ tools: [{ name: 'x' }] })
    });
    try {
      const { body } = await post(
        srv.url,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: { _meta: meta }
        },
        { 'mcp-protocol-version': DRAFT_PROTOCOL_VERSION }
      );
      expect(body.result.tools[0].name).toBe('x');
      expect(srv.recorded).toHaveLength(1);
      expect(srv.recorded[0].method).toBe('tools/list');
    } finally {
      await srv.close();
    }
  });

  it('returns -32601 for unknown methods', async () => {
    const srv = await createServerStateless({});
    try {
      const { status, body } = await post(
        srv.url,
        { jsonrpc: '2.0', id: 1, method: 'nope', params: { _meta: meta } },
        { 'mcp-protocol-version': DRAFT_PROTOCOL_VERSION }
      );
      expect(status).toBe(404);
      expect(body.error.code).toBe(-32601);
    } finally {
      await srv.close();
    }
  });
});

describe('createServerStateful', () => {
  it('accepts initialize and routes to handlers, recording non-preamble', async () => {
    const srv = await createServerStateful({
      'tools/list': () => ({ tools: [] })
    });
    try {
      // SDK transport in sessionless mode handles initialize internally; we
      // can drive it via the SDK Client.
      const { Client } =
        await import('@modelcontextprotocol/sdk/client/index.js');
      const { StreamableHTTPClientTransport } =
        await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      const client = new Client(
        { name: 't', version: '1' },
        { capabilities: {} }
      );
      await client.connect(new StreamableHTTPClientTransport(new URL(srv.url)));
      await client.listTools();
      await client.close();
      expect(srv.recorded.map((r) => r.method)).toEqual(['tools/list']);
    } finally {
      await srv.close();
    }
  });
});
