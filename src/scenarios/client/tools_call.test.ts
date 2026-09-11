import { testScenarioContext } from '../../mock-server/testing';
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolsCallScenario } from './tools_call';
import { DRAFT_PROTOCOL_VERSION } from '../../types';
import { finalizeChecks, rawChecksOf } from '../../hosted/session';

describe('tools_call scenario', () => {
  it('emits a single FAILURE check when the tool was never called', async () => {
    const scenario = new ToolsCallScenario();
    await scenario.start(testScenarioContext());
    try {
      const checks = scenario.getChecks();
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({
        id: 'tool-add-numbers',
        status: 'FAILURE'
      });
    } finally {
      await scenario.stop();
    }
  });

  it('serves spec-valid results at the draft (2026-07-28) version', async () => {
    const meta = {
      'io.modelcontextprotocol/protocolVersion': DRAFT_PROTOCOL_VERSION,
      'io.modelcontextprotocol/clientInfo': {
        name: 'test-client',
        version: '1.0.0'
      },
      'io.modelcontextprotocol/clientCapabilities': {}
    };
    async function post(url: string, body: object) {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mcp-protocol-version': DRAFT_PROTOCOL_VERSION
        },
        body: JSON.stringify(body)
      });
      return { status: r.status, body: await r.json() };
    }

    const scenario = new ToolsCallScenario();
    const { serverUrl } = await scenario.start(
      testScenarioContext(DRAFT_PROTOCOL_VERSION)
    );
    try {
      const list = await post(serverUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: meta }
      });
      expect(list.status).toBe(200);
      expect(list.body.result).toMatchObject({
        resultType: 'complete',
        ttlMs: 0,
        cacheScope: 'private'
      });

      const call = await post(serverUrl, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { _meta: meta, name: 'add_numbers', arguments: { a: 2, b: 3 } }
      });
      expect(call.status).toBe(200);
      expect(call.body.result.resultType).toBe('complete');

      const checks = scenario.getChecks();
      expect(checks).toHaveLength(1);
      expect(checks[0].status).toBe('SUCCESS');
    } finally {
      await scenario.stop();
    }
  });

  it('judges from a raw log a client split across two instances left behind', async () => {
    // The hosted server persists each process's raw log and judges the
    // merged log in a fresh instance; the mock's `recorded` never leaves
    // the process that saw the request.
    const meta = {
      'io.modelcontextprotocol/protocolVersion': DRAFT_PROTOCOL_VERSION,
      'io.modelcontextprotocol/clientCapabilities': {}
    };
    async function drive(body: object): Promise<ToolsCallScenario> {
      const scenario = new ToolsCallScenario();
      const { serverUrl } = await scenario.start(
        testScenarioContext(DRAFT_PROTOCOL_VERSION)
      );
      try {
        const r = await fetch(serverUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'mcp-protocol-version': DRAFT_PROTOCOL_VERSION
          },
          body: JSON.stringify(body)
        });
        expect(r.status).toBe(200);
        await r.text();
      } finally {
        await scenario.stop();
      }
      return scenario;
    }
    const a = await drive({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: meta }
    });
    const b = await drive({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { _meta: meta, name: 'add_numbers', arguments: { a: 2, b: 3 } }
    });
    expect(rawChecksOf(a).map((c) => c.id)).toEqual(['tools-list-requested']);
    expect(rawChecksOf(b).map((c) => c.id)).toEqual(['tools-call-requested']);
    // Each instance alone: A never saw the call.
    expect(a.getChecks()[0].status).toBe('FAILURE');
    expect(b.getChecks()[0].status).toBe('SUCCESS');
    // The merged log judged once: the CLI's single check, SUCCESS.
    const judged = finalizeChecks('tools_call', [
      ...rawChecksOf(a),
      ...rawChecksOf(b)
    ]);
    expect(judged).toHaveLength(1);
    expect(judged[0]).toMatchObject({
      id: 'tool-add-numbers',
      status: 'SUCCESS',
      details: { a: 2, b: 3, result: 5 }
    });
  });

  it('emits SUCCESS after a valid tools/call and getChecks() is idempotent', async () => {
    const scenario = new ToolsCallScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      const client = new Client(
        { name: 'test-client', version: '1.0.0' },
        { capabilities: {} }
      );
      const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
      await client.connect(transport);
      await client.callTool({ name: 'add_numbers', arguments: { a: 2, b: 3 } });
      await transport.close();

      const first = scenario.getChecks();
      expect(first).toHaveLength(1);
      expect(first[0].status).toBe('SUCCESS');

      // Repeated calls must not accumulate duplicate checks.
      const second = scenario.getChecks();
      expect(second).toHaveLength(1);
      expect(second[0].status).toBe('SUCCESS');
    } finally {
      await scenario.stop();
    }
  });
});
