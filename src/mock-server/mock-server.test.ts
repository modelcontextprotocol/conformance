import { describe, it, expect } from 'vitest';
import { createServerFor } from './select';
import { createServerStateful } from './stateful';
import {
  createServerStateless,
  validateStatelessRequest,
  withRequiredDraftResultFields,
  CACHEABLE_RESULT_METHODS
} from './stateless';
import { STATELESS_SPEC_VERSIONS } from '../connection/select';
import { DRAFT_PROTOCOL_VERSION } from '../types';

const meta = {
  'io.modelcontextprotocol/protocolVersion': DRAFT_PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 't', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {}
};
const headers = { 'mcp-protocol-version': DRAFT_PROTOCOL_VERSION };

async function post(url: string, body: object, headers: object = {}) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  return { status: r.status, body: await r.json() };
}

describe('validateStatelessRequest', () => {
  it('returns reject for invalid requests', () => {
    const v = validateStatelessRequest(
      {
        headers: {},
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: { _meta: meta }
        }
      },
      {},
      [DRAFT_PROTOCOL_VERSION]
    );
    expect(v).toMatchObject({ kind: 'reject', status: 400 });
  });

  it('returns handled for server/discover', () => {
    const v = validateStatelessRequest(
      {
        headers,
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'server/discover',
          params: { _meta: meta }
        }
      },
      {},
      [DRAFT_PROTOCOL_VERSION]
    );
    expect(v).toMatchObject({ kind: 'handled', status: 200 });
  });

  it('returns route for valid non-discover requests', () => {
    const v = validateStatelessRequest(
      {
        headers,
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: { _meta: meta }
        }
      },
      {},
      [DRAFT_PROTOCOL_VERSION]
    );
    expect(v).toMatchObject({ kind: 'route', id: 1, method: 'tools/list' });
  });

  it('includes the draft-required result members on the server/discover result', () => {
    const v = validateStatelessRequest(
      {
        headers,
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'server/discover',
          params: { _meta: meta }
        }
      },
      {},
      [DRAFT_PROTOCOL_VERSION]
    );
    expect(v).toMatchObject({
      kind: 'handled',
      body: {
        result: { resultType: 'complete', ttlMs: 0, cacheScope: 'private' }
      }
    });
  });

  it('rejects versions outside the supported list with -32022 and echoes it', () => {
    const v = validateStatelessRequest(
      {
        headers: { 'mcp-protocol-version': '2099-01-01' },
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {
            _meta: {
              ...meta,
              'io.modelcontextprotocol/protocolVersion': '2099-01-01'
            }
          }
        }
      },
      {},
      [DRAFT_PROTOCOL_VERSION]
    );
    expect(v).toMatchObject({
      kind: 'reject',
      status: 400,
      body: {
        error: {
          code: -32022,
          data: { supported: [DRAFT_PROTOCOL_VERSION], requested: '2099-01-01' }
        }
      }
    });
  });
});

describe('withRequiredDraftResultFields', () => {
  it('stamps resultType "complete" when the handler omitted it', () => {
    expect(
      withRequiredDraftResultFields('tools/call', { content: [] })
    ).toEqual({ resultType: 'complete', content: [] });
  });

  it('adds ttlMs and cacheScope for every cacheable method', () => {
    for (const method of CACHEABLE_RESULT_METHODS) {
      expect(withRequiredDraftResultFields(method, {})).toEqual({
        resultType: 'complete',
        ttlMs: 0,
        cacheScope: 'private'
      });
    }
  });

  it('does not add caching hints to non-cacheable results', () => {
    const result = withRequiredDraftResultFields('tools/call', {
      content: []
    });
    expect(result).not.toHaveProperty('ttlMs');
    expect(result).not.toHaveProperty('cacheScope');
  });

  it('preserves members the handler set itself', () => {
    expect(
      withRequiredDraftResultFields('tools/call', {
        resultType: 'input_required',
        inputRequests: {}
      })
    ).toMatchObject({ resultType: 'input_required' });
    expect(
      withRequiredDraftResultFields('tools/list', {
        ttlMs: 5000,
        cacheScope: 'public',
        tools: []
      })
    ).toMatchObject({ ttlMs: 5000, cacheScope: 'public' });
  });

  it('passes non-object results through untouched', () => {
    expect(withRequiredDraftResultFields('tools/call', null)).toBeNull();
    expect(withRequiredDraftResultFields('tools/call', [1])).toEqual([1]);
  });
});

describe('createServerFor', () => {
  it('returns stateful for dated 2025-x versions', () => {
    expect(createServerFor('2025-06-18')).toBe(createServerStateful);
    expect(createServerFor('2025-11-25')).toBe(createServerStateful);
  });
  it('returns a stateless factory bound to the requested version', async () => {
    const srv = await createServerFor(DRAFT_PROTOCOL_VERSION)({});
    try {
      const { status, body } = await post(
        srv.url,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'server/discover',
          params: { _meta: meta }
        },
        headers
      );
      expect(status).toBe(200);
      expect(body.result.supportedVersions).toEqual([DRAFT_PROTOCOL_VERSION]);
    } finally {
      await srv.close();
    }
  });
});

describe('createServerStateless', () => {
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
      expect(body.error.code).toBe(-32020);
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

  it('serves server/discover, defaulting to every known stateless version', async () => {
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
      expect(body.result.supportedVersions).toEqual(STATELESS_SPEC_VERSIONS);
      expect(body.result.serverInfo.name).toBe('conformance-mock-server');
    } finally {
      await srv.close();
    }
  });

  it('accepts the version it was created for and rejects others with -32022', async () => {
    const srv = await createServerStateless(
      { 'tools/list': () => ({ tools: [] }) },
      DRAFT_PROTOCOL_VERSION
    );
    try {
      const accepted = await post(
        srv.url,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: { _meta: meta }
        },
        headers
      );
      expect(accepted.status).toBe(200);

      const rejected = await post(
        srv.url,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {
            _meta: {
              ...meta,
              'io.modelcontextprotocol/protocolVersion': '2099-01-01'
            }
          }
        },
        { 'mcp-protocol-version': '2099-01-01' }
      );
      expect(rejected.status).toBe(400);
      expect(rejected.body.error.code).toBe(-32022);
      expect(rejected.body.error.data.supported).toEqual([
        DRAFT_PROTOCOL_VERSION
      ]);
      expect(rejected.body.error.data.requested).toBe('2099-01-01');
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

  it('records requests rejected by validation (missing _meta)', async () => {
    const srv = await createServerStateless({});
    try {
      const { status } = await post(
        srv.url,
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        { 'mcp-protocol-version': DRAFT_PROTOCOL_VERSION }
      );
      expect(status).toBe(400);
      expect(srv.recorded.map((r) => r.method)).toEqual(['tools/list']);
    } finally {
      await srv.close();
    }
  });

  it('does not record the server/discover preamble', async () => {
    const srv = await createServerStateless({});
    try {
      const { status } = await post(
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
      expect(srv.recorded).toHaveLength(0);
    } finally {
      await srv.close();
    }
  });

  it('stamps the draft-required result members onto handler results', async () => {
    const srv = await createServerStateless({
      'tools/list': () => ({ tools: [{ name: 'x' }] }),
      'tools/call': () => ({ content: [{ type: 'text', text: 'ok' }] })
    });
    try {
      const list = await post(
        srv.url,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: { _meta: meta }
        },
        headers
      );
      expect(list.body.result).toMatchObject({
        resultType: 'complete',
        ttlMs: 0,
        cacheScope: 'private',
        tools: [{ name: 'x' }]
      });

      const call = await post(
        srv.url,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { _meta: meta, name: 'x' }
        },
        headers
      );
      expect(call.body.result).toMatchObject({ resultType: 'complete' });
      expect(call.body.result).not.toHaveProperty('ttlMs');
      expect(call.body.result).not.toHaveProperty('cacheScope');
    } finally {
      await srv.close();
    }
  });

  it('preserves a resultType the handler set itself', async () => {
    const srv = await createServerStateless({
      'tools/call': () => ({ resultType: 'input_required', inputRequests: {} })
    });
    try {
      const { body } = await post(
        srv.url,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { _meta: meta }
        },
        headers
      );
      expect(body.result.resultType).toBe('input_required');
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
  async function postInit(url: string) {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 't', version: '1' }
        }
      })
    });
    return {
      status: r.status,
      contentType: r.headers.get('content-type') ?? ''
    };
  }

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

  it('derives capabilities from handler keys; non-tools handler does not 500 initialize', async () => {
    const srv = await createServerStateful({
      'prompts/list': () => ({ prompts: [] })
    });
    try {
      const { status, contentType } = await postInit(srv.url);
      expect(status).toBe(200);
      expect(contentType).not.toContain('text/html');
    } finally {
      await srv.close();
    }
  });

  it('records requests for unregistered methods (parity with stateless)', async () => {
    const srv = await createServerStateful({
      'tools/list': () => ({ tools: [] })
    });
    try {
      const { Client } =
        await import('@modelcontextprotocol/sdk/client/index.js');
      const { StreamableHTTPClientTransport } =
        await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      const { ResultSchema } =
        await import('@modelcontextprotocol/sdk/types.js');
      const client = new Client(
        { name: 't', version: '1' },
        { capabilities: {} }
      );
      await client.connect(new StreamableHTTPClientTransport(new URL(srv.url)));
      await client
        .request(
          { method: 'tools/call', params: { name: 'nope' } },
          ResultSchema
        )
        .catch(() => {});
      await client.close();
      expect(srv.recorded.map((r) => r.method)).toContain('tools/call');
    } finally {
      await srv.close();
    }
  });
});
