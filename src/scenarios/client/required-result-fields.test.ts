import { describe, it, expect } from 'vitest';
import { testScenarioContext } from '../../mock-server/testing';
import { withRequiredResultFields } from '../../mock-server';
import { wireSchemaErrors } from '../../validation/wire-schema';
// Stateless-lifecycle tests pin the first stateless release.
const STATELESS = '2026-07-28' as const;
import { HttpStandardHeadersScenario } from './http-standard-headers';
import {
  HttpCustomHeadersScenario,
  HttpInvalidToolHeadersScenario
} from './http-custom-headers';
import type { BaseHttpScenario } from './http-base';
import { RequestMetadataScenario } from './request-metadata';
import { MRTRClientScenario } from './mrtr-client';
import { JsonSchemaRefDerefScenario } from './json-schema-ref-deref';

/**
 * Pins that the hand-rolled mock servers used by client-direction scenarios
 * at 2026-07-28 return spec-valid results: every result carries `resultType`,
 * and the cacheable list/read/discover results also carry `ttlMs` and
 * `cacheScope`. Without these, a strictly-conforming client is failed by the
 * suite's own non-conformant mock. The shared stateless mock is covered in
 * src/mock-server/mock-server.test.ts.
 */

const meta = {
  'io.modelcontextprotocol/protocolVersion': STATELESS,
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

const DISCOVER_FIELDS = {
  ...CACHEABLE_FIELDS,
  supportedVersions: [STATELESS]
};

describe('hand-rolled mock servers serve server/discover (2026-07-28)', () => {
  const cases = [
    {
      name: 'http-standard-headers',
      make: () => new HttpStandardHeadersScenario(),
      capabilities: { tools: {}, resources: {}, prompts: {} }
    },
    {
      name: 'http-custom-headers',
      make: () => new HttpCustomHeadersScenario(),
      capabilities: { tools: {} }
    },
    {
      name: 'http-invalid-tool-headers',
      make: () => new HttpInvalidToolHeadersScenario(),
      capabilities: { tools: {} }
    },
    {
      name: 'sep-2322-client-request-state',
      make: () => new MRTRClientScenario(),
      capabilities: { tools: {} }
    },
    {
      name: 'json-schema-ref-no-deref',
      make: () => new JsonSchemaRefDerefScenario(),
      capabilities: { tools: {} }
    }
  ];

  for (const c of cases) {
    it(`${c.name} returns a valid DiscoverResult`, async () => {
      const scenario = c.make();
      const { serverUrl } = await scenario.start(
        testScenarioContext(STATELESS)
      );
      try {
        const { status, body } = await post(
          serverUrl,
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'server/discover',
            params: { _meta: meta }
          },
          { 'mcp-protocol-version': STATELESS }
        );
        expect(status).toBe(200);
        expect(body.result).toMatchObject({
          ...DISCOVER_FIELDS,
          capabilities: c.capabilities
        });
        expect(body.result.serverInfo?.name).toBeTypeOf('string');
      } finally {
        await scenario.stop();
      }
    });
  }
});

describe('http-standard-headers mock results (2026-07-28)', () => {
  it('carries the 2026-07-28-required result members on every handled method', async () => {
    const scenario = new HttpStandardHeadersScenario();
    const { serverUrl } = await scenario.start(testScenarioContext(STATELESS));
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
        // generic fallback, which must still add the caching hints and the
        // required (empty) list member.
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

describe('generic fallback answers unrouted list methods schema-valid (#474)', () => {
  // http-standard-headers advertises `resources` but has no
  // resources/templates/list route; the request falls through to the generic
  // fallback in BaseHttpScenario. Before the fix the reply had no
  // `resourceTemplates` member, so strictly-validating clients (e.g.
  // cloudflare/agents MCPClientManager) dropped the connection before the
  // scenario's header checks ran.
  it('http-standard-headers answers resources/templates/list with a valid empty result', async () => {
    const scenario = new HttpStandardHeadersScenario();
    const { serverUrl } = await scenario.start(testScenarioContext(STATELESS));
    try {
      const { status, body } = await post(
        serverUrl,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'resources/templates/list',
          params: {}
        },
        { 'Mcp-Method': 'resources/templates/list' }
      );
      expect(status).toBe(200);
      expect(body.result).toEqual({
        ...CACHEABLE_FIELDS,
        resourceTemplates: []
      });
      expect(
        wireSchemaErrors(STATELESS, body, 'resources/templates/list')
      ).toEqual([]);
    } finally {
      await scenario.stop();
    }
  });

  // Every list-shaped method a scenario does not route must reach the
  // fallback and come back with its required (empty) list member, on all
  // three BaseHttpScenario subclasses. http-standard-headers routes the
  // tools/resources/prompts lists itself; the custom-headers scenarios route
  // only initialize and tools/*. tasks/list has no typed result in the draft
  // schema (2025-11-25 only), so it is additionally validated at 2025-11-25.
  const listMember = new Map([
    ['resources/list', 'resources'],
    ['resources/templates/list', 'resourceTemplates'],
    ['prompts/list', 'prompts'],
    ['roots/list', 'roots'],
    ['tasks/list', 'tasks']
  ]);
  const subclasses: Array<{
    name: string;
    make: () => BaseHttpScenario;
    unrouted: string[];
  }> = [
    {
      name: 'http-standard-headers',
      make: () => new HttpStandardHeadersScenario(),
      unrouted: ['resources/templates/list', 'roots/list', 'tasks/list']
    },
    {
      name: 'http-custom-headers',
      make: () => new HttpCustomHeadersScenario(),
      unrouted: [...listMember.keys()]
    },
    {
      name: 'http-invalid-tool-headers',
      make: () => new HttpInvalidToolHeadersScenario(),
      unrouted: [...listMember.keys()]
    }
  ];

  for (const s of subclasses) {
    it(`${s.name} answers unrouted list methods with valid empty results`, async () => {
      const scenario = s.make();
      const { serverUrl } = await scenario.start(
        testScenarioContext(STATELESS)
      );
      try {
        let id = 1;
        for (const method of s.unrouted) {
          const { status, body } = await post(
            serverUrl,
            { jsonrpc: '2.0', id: id++, method, params: {} },
            { 'Mcp-Method': method }
          );
          expect(status, method).toBe(200);
          expect(body.result[listMember.get(method)!], method).toEqual([]);
          expect(wireSchemaErrors(STATELESS, body, method), method).toEqual([]);
          if (method === 'tasks/list') {
            expect(wireSchemaErrors('2025-11-25', body, method)).toEqual([]);
          }
        }
      } finally {
        await scenario.stop();
      }
    });
  }

  // Method names that collide with Object.prototype must miss the empty-list
  // lookup and get the plain generic result — an object-literal map here once
  // returned Object.prototype functions, which JSON.stringify drops, leaving
  // a reply with neither result nor error.
  for (const s of subclasses) {
    it(`${s.name} answers Object.prototype-colliding method names with a valid generic result`, async () => {
      const scenario = s.make();
      const { serverUrl } = await scenario.start(
        testScenarioContext(STATELESS)
      );
      try {
        let id = 1;
        for (const method of [
          'constructor',
          'toString',
          'valueOf',
          'hasOwnProperty'
        ]) {
          const { status, body } = await post(
            serverUrl,
            { jsonrpc: '2.0', id: id++, method, params: {} },
            { 'Mcp-Method': method }
          );
          expect(status, method).toBe(200);
          expect(body.result, method).toEqual({ resultType: 'complete' });
          expect(wireSchemaErrors(STATELESS, body, method), method).toEqual([]);
        }
      } finally {
        await scenario.stop();
      }
    });
  }

  // Regression pin: the pre-fix fallback payload (required draft fields only,
  // no list member) is rejected by the spec schema — proves the assertions
  // above have teeth.
  it('rejects the pre-fix bare fallback result for resources/templates/list', () => {
    const preFix = {
      jsonrpc: '2.0',
      id: 1,
      result: withRequiredResultFields('resources/templates/list', {})
    };
    const errors = wireSchemaErrors(
      STATELESS,
      preFix,
      'resources/templates/list'
    );
    expect(errors.join('\n')).toContain(
      "must have required property 'resourceTemplates'"
    );
  });
});

describe('http-custom-headers mock results (2026-07-28)', () => {
  it('carries the 2026-07-28-required result members', async () => {
    const scenario = new HttpCustomHeadersScenario();
    const { serverUrl } = await scenario.start(testScenarioContext(STATELESS));
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
  it('carries the 2026-07-28-required result members', async () => {
    const scenario = new HttpInvalidToolHeadersScenario();
    const { serverUrl } = await scenario.start(testScenarioContext(STATELESS));
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
  it('carries the 2026-07-28-required result members after the simulated rejection', async () => {
    const scenario = new RequestMetadataScenario();
    const { serverUrl } = await scenario.start(testScenarioContext(STATELESS));
    const headers = { 'MCP-Protocol-Version': STATELESS };
    try {
      // The first request is always answered with the simulated -32022
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
  it('carries the 2026-07-28-required result members on conformant results and keeps the deliberate omission', async () => {
    const scenario = new MRTRClientScenario();
    const { serverUrl } = await scenario.start(testScenarioContext(STATELESS));
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
