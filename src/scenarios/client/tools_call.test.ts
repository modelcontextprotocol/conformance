import { testScenarioContext } from '../../mock-server/testing';
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolsCallScenario } from './tools_call';

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
