import { describe, it, expect, beforeEach } from 'vitest';
import { InitializeScenario } from './initialize.js';
import { ToolsCallScenario } from './tools_call.js';
import { ElicitationClientDefaultsScenario } from './elicitation-defaults.js';
import { SSERetryScenario } from './sse-retry.js';
import { ServerSSEPollingScenario } from '../server/sse-polling.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

describe('Client Scenarios', () => {
  describe('InitializeScenario', () => {
    let scenario: InitializeScenario;

    beforeEach(() => {
      scenario = new InitializeScenario();
    });

    it('has correct name and description', () => {
      expect(scenario.name).toBe('initialize');
      expect(scenario.description).toBe('Tests MCP client initialization handshake');
    });

    it('supports required spec versions', () => {
      expect(scenario.specVersions).toContain('2025-06-18');
      expect(scenario.specVersions).toContain('2025-11-25');
    });

    it('can start and get a server URL', async () => {
      const urls = await scenario.start();

      expect(urls.serverUrl).toBeDefined();
      expect(urls.serverUrl).toMatch(/^http:\/\/localhost:\d+$/);

      await scenario.stop();
    });

    it('returns empty checks before any requests', () => {
      const checks = scenario.getChecks();
      expect(checks).toEqual([]);
    });

    it('can handle multiple start/stop cycles', async () => {
      const urls1 = await scenario.start();
      await scenario.stop();

      const urls2 = await scenario.start();
      expect(urls2.serverUrl).toBeDefined();
      await scenario.stop();
    });

    it('handles client initialization requests', async () => {
      const urls = await scenario.start();

      const client = new Client(
        {
          name: 'test-client',
          version: '1.0.0'
        },
        {
          capabilities: {}
        }
      );

      const transport = new StreamableHTTPClientTransport(
        new URL(urls.serverUrl)
      );
      await client.connect(transport);

      const checks = scenario.getChecks();
      expect(checks.length).toBeGreaterThan(0);
      // Checks should have valid structure
      expect(checks[0]).toHaveProperty('id');
      expect(checks[0]).toHaveProperty('name');
      expect(checks[0]).toHaveProperty('status');

      await client.close();
      await scenario.stop();
    });
  });

  describe('ToolsCallScenario', () => {
    let scenario: ToolsCallScenario;

    beforeEach(() => {
      scenario = new ToolsCallScenario();
    });

    it('has correct name', () => {
      expect(scenario.name).toBe('tools_call');
    });

    it('has description', () => {
      expect(scenario.description).toBeDefined();
    });

    it('supports required spec versions', () => {
      expect(scenario.specVersions.length).toBeGreaterThan(0);
    });

    it('can start and stop', async () => {
      const urls = await scenario.start();
      expect(urls.serverUrl).toBeDefined();
      await scenario.stop();
    });

    it('initializes with empty checks', () => {
      const checks = scenario.getChecks();
      expect(Array.isArray(checks)).toBe(true);
    });
  });

  describe('ElicitationClientDefaultsScenario', () => {
    let scenario: ElicitationClientDefaultsScenario;

    beforeEach(() => {
      scenario = new ElicitationClientDefaultsScenario();
    });

    it('has correct name', () => {
      expect(scenario.name).toContain('elicitation');
    });

    it('can start and stop', async () => {
      const urls = await scenario.start();
      expect(urls.serverUrl).toBeDefined();
      await scenario.stop();
    });

    it('has valid checks array', () => {
      const checks = scenario.getChecks();
      expect(Array.isArray(checks)).toBe(true);
    });
  });

  describe('SSERetryScenario', () => {
    let scenario: SSERetryScenario;

    beforeEach(() => {
      scenario = new SSERetryScenario();
    });

    it('has correct name', () => {
      expect(scenario.name).toContain('sse');
    });

    it('has valid spec versions', () => {
      expect(scenario.specVersions.length).toBeGreaterThan(0);
    });

    it('has description', () => {
      expect(scenario.description).toBeDefined();
    });

    it('has start and stop methods', async () => {
      // Test the start and stop methods exist
      expect(typeof scenario.start).toBe('function');
      expect(typeof scenario.stop).toBe('function');
      expect(typeof scenario.getChecks).toBe('function');
    });
  });

  describe('ServerSSEPollingScenario', () => {
    let scenario: ServerSSEPollingScenario;

    beforeEach(() => {
      scenario = new ServerSSEPollingScenario();
    });

    it('has correct name', () => {
      expect(scenario.name).toBe('server-sse-polling');
    });

    it('has valid spec versions', () => {
      expect(scenario.specVersions.length).toBeGreaterThan(0);
      expect(scenario.specVersions).toContain('2025-11-25');
    });

    it('has description', () => {
      expect(scenario.description).toBeDefined();
      expect(scenario.description.toLowerCase()).toContain('sse');
    });

    it('is a valid client scenario', () => {
      expect(typeof scenario.run).toBe('function');
      expect(scenario.name).toBeDefined();
      expect(scenario.specVersions).toBeDefined();
      expect(scenario.description).toBeDefined();
    });
  });

  describe('Scenario Interface Compliance', () => {
    it('all server scenarios implement Scenario interface', async () => {
      const scenario = new InitializeScenario();

      expect(scenario.name).toBeDefined();
      expect(scenario.specVersions).toBeDefined();
      expect(scenario.description).toBeDefined();
      expect(typeof scenario.start).toBe('function');
      expect(typeof scenario.stop).toBe('function');
      expect(typeof scenario.getChecks).toBe('function');

      await scenario.stop();
    });

    it('all client scenarios implement ClientScenario interface', () => {
      const scenarios = [
        new ServerSSEPollingScenario()
      ];

      for (const scenario of scenarios) {
        expect(scenario.name).toBeDefined();
        expect(scenario.specVersions).toBeDefined();
        expect(scenario.description).toBeDefined();
        expect(typeof scenario.run).toBe('function');
      }
    });
  });

  describe('Scenario Initialization', () => {
    it('can create all client scenarios without errors', () => {
      const scenarios = [
        new InitializeScenario(),
        new ToolsCallScenario(),
        new ElicitationClientDefaultsScenario(),
        new SSERetryScenario(),
        new ServerSSEPollingScenario()
      ];

      expect(scenarios.length).toBe(5);
      scenarios.forEach((s) => {
        expect(s.name).toBeDefined();
      });
    });
  });
});
