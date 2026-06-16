import { describe, it, expect } from 'vitest';
import { testScenarioContext } from '../../mock-server/testing';
import { DRAFT_PROTOCOL_VERSION } from '../../types';
import { HttpStandardHeadersScenario } from './http-standard-headers';
import {
  HttpCustomHeadersScenario,
  HttpInvalidToolHeadersScenario
} from './http-custom-headers';
import { RequestMetadataScenario } from './request-metadata';
import { MRTRClientScenario } from './mrtr-client';

/**
 * Pins that the hand-rolled mock servers used by client-direction scenarios
 * at 2026-07-28 return spec-valid results: every result carries `resultType`,
 * and the cacheable list/read/discover results also carry `ttlMs` and
 * `cacheScope`. Without these, a strictly-conforming client is failed by the
 * suite's own non-conformant mock. The shared stateless mock is covered in
 * src/mock-server/mock-server.test.ts.
 */

const meta = {
  'io.modelcontextprotocol/protocolVersion': DRAFT_PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0' },
  'io.modelcontextprotocol/clientCapabilities': {}
};

async function post(
  url: string,
  body: object,
  headers: Record<string, string> = {}
) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  return { status: r.status, body: await r.json() };
}

const CACHEABLE_FIELDS = {
  resultType: 'complete',
  ttlMs: 0,
  cacheScope: 'private'
};

describe('http-standard-headers mock results (2026-07-28)', () => {
  it('carries the draft-required result members on every handled method', async () => {
    const scenario = new HttpStandardHeadersScenario();
    const { serverUrl } = await scenario.start(
      testScenarioContext(DRAFT_PROTOCOL_VERSION)
    );
    try {
      const cases: Array<{
        method: string;
        params?: object;
        cacheable: boolean;
      }> = [
        { method: 'initialize', cacheable: false },
        { method: 'tools/list', cacheable: true },
        {
          method: 'tools/call',
          params: { name: 'test_headers', arguments: {} },
          cacheable: false
        },
        { method: 'resources/list', cacheable: true },
        {
          method: 'resources/read',
          params: { uri: 'file:///path/to/file%20name.txt' },
          cacheable: true
        },
        // Not explicitly handled by the scenario — exercises the method-aware
        // generic fallback, which must still add the caching hints.
        { method: 'resources/templates/list', cacheable: true },
        { method: 'prompts/list', cacheable: true },
        {
          method: 'prompts/get',
          params: { name: 'test_prompt' },
          cacheable: false
        },
        { method: 'unknown/method', cacheable: false }
      ];
      let id = 1;
      for (const c of cases) {
        const { status, body } = await post(
          serverUrl,
          {
            jsonrpc: '2.0',
            id: id++,
            method: c.method,
            params: c.params ?? {}
          },
          { 'Mcp-Method': c.method }
        );
        expect(status, c.method).toBe(200);
        expect(body.result.resultType, c.method).toBe('complete');
        if (c.cacheable) {
          expect(body.result, c.method).toMatchObject({
            ttlMs: 0,
            cacheScope: 'private'
          });
        }
      }
    } finally {
      await scenario.stop();
    }
  });
});

describe('http-custom-headers mock results (2026-07-28)', () => {
  it('carries the draft-required result members', async () => {
    const scenario = new HttpCustomHeadersScenario();
    const { serverUrl } = await scenario.start(
      testScenarioContext(DRAFT_PROTOCOL_VERSION)
    );
    try {
      const list = await post(serverUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {}
      });
      expect(list.body.result).toMatchObject(CACHEABLE_FIELDS);

      const call = await post(serverUrl, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'test_custom_headers',
          arguments: { region: 'us-east', priority: 1, query: 'q' }
        }
      });
      expect(call.body.result.resultType).toBe('complete');
    } finally {
      await scenario.stop();
    }
  });
});

describe('http-invalid-tool-headers mock results (2026-07-28)', () => {
  it('carries the draft-required result members', async () => {
    const scenario = new HttpInvalidToolHeadersScenario();
    const { serverUrl } = await scenario.start(
      testScenarioContext(DRAFT_PROTOCOL_VERSION)
    );
    try {
      const list = await post(serverUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {}
      });
      expect(list.body.result).toMatchObject(CACHEABLE_FIELDS);

      const call = await post(serverUrl, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'valid_tool', arguments: { region: 'us-east' } }
      });
      expect(call.body.result.resultType).toBe('complete');
    } finally {
      await scenario.stop();
    }
  });
});

describe('request-metadata mock results (2026-07-28)', () => {
  it('carries the draft-required result members after the simulated rejection', async () => {
    const scenario = new RequestMetadataScenario();
    const { serverUrl } = await scenario.start(
      testScenarioContext(DRAFT_PROTOCOL_VERSION)
    );
    const headers = { 'MCP-Protocol-Version': DRAFT_PROTOCOL_VERSION };
    try {
      // The first request is always answered with the simulated -32004
      // rejection (retry probe); results are served from the second on.
      const first = await post(
        serverUrl,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: { _meta: meta }
        },
        headers
      );
      expect(first.status).toBe(400);

      const discover = await post(
        serverUrl,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'server/discover',
          params: { _meta: meta }
        },
        headers
      );
      expect(discover.body.result).toMatchObject(CACHEABLE_FIELDS);

      const list = await post(
        serverUrl,
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/list',
          params: { _meta: meta }
        },
        headers
      );
      expect(list.body.result).toMatchObject(CACHEABLE_FIELDS);

      const call = await post(
        serverUrl,
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { _meta: meta, name: 'x' }
        },
        headers
      );
      expect(call.body.result.resultType).toBe('complete');

      const other = await post(
        serverUrl,
        { jsonrpc: '2.0', id: 5, method: 'ping', params: { _meta: meta } },
        headers
      );
      expect(other.body.result.resultType).toBe('complete');
    } finally {
      await scenario.stop();
    }
  });
});

describe('sep-2322-client-request-state mock results (2026-07-28)', () => {
  it('carries the draft-required result members on conformant results and keeps the deliberate omission', async () => {
    const scenario = new MRTRClientScenario();
    const { serverUrl } = await scenario.start(
      testScenarioContext(DRAFT_PROTOCOL_VERSION)
    );
    try {
      const list = await post(serverUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {}
      });
      expect(list.body.result).toMatchObject(CACHEABLE_FIELDS);

      const initial = await post(serverUrl, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'test_mrtr_echo_state', arguments: {} }
      });
      expect(initial.body.result.resultType).toBe('input_required');

      const retry = await post(serverUrl, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'test_mrtr_echo_state',
          arguments: {},
          inputResponses: { confirm: { action: 'accept' } },
          requestState: initial.body.result.requestState
        }
      });
      expect(retry.body.result.resultType).toBe('complete');

      const unrelated = await post(serverUrl, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'test_mrtr_unrelated', arguments: {} }
      });
      expect(unrelated.body.result.resultType).toBe('complete');

      // The default-resultType probe deliberately omits resultType — that is
      // the check's stimulus and must not be "fixed".
      const noResultType = await post(serverUrl, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'test_mrtr_no_result_type', arguments: {} }
      });
      expect(noResultType.body.result.content).toBeDefined();
      expect(noResultType.body.result).not.toHaveProperty('resultType');
    } finally {
      await scenario.stop();
    }
  });
});
