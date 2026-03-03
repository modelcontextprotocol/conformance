import { describe, it, expect, beforeEach } from 'vitest';
import { InitializeScenario } from '../client/initialize.js';
import { ToolsCallScenario } from '../client/tools_call.js';
import { ElicitationClientDefaultsScenario } from '../client/elicitation-defaults.js';
import { SSERetryScenario } from '../client/sse-retry.js';

describe('Server Scenarios', () => {
  describe('Scenario Properties', () => {
    it('InitializeScenario has required properties', () => {
      const scenario = new InitializeScenario();

      expect(scenario.name).toBeDefined();
      expect(scenario.description).toBeDefined();
      expect(scenario.specVersions).toBeDefined();
      expect(Array.isArray(scenario.specVersions)).toBe(true);
      expect(scenario.specVersions.length).toBeGreaterThan(0);
    });

    it('ToolsCallScenario has required properties', () => {
      const scenario = new ToolsCallScenario();

      expect(scenario.name).toBe('tools_call');
      expect(scenario.description).toBeDefined();
      expect(scenario.specVersions).toBeDefined();
      expect(scenario.specVersions.length).toBeGreaterThan(0);
    });

    it('ElicitationClientDefaultsScenario has required properties', () => {
      const scenario = new ElicitationClientDefaultsScenario();

      expect(scenario.name).toBeDefined();
      expect(scenario.description).toBeDefined();
      expect(scenario.specVersions).toBeDefined();
    });

    it('SSERetryScenario has required properties', () => {
      const scenario = new SSERetryScenario();

      expect(scenario.name).toBeDefined();
      expect(scenario.description).toBeDefined();
      expect(scenario.specVersions).toBeDefined();
      expect(scenario.specVersions.length).toBeGreaterThan(0);
    });
  });

  describe('Scenario Lifecycle Methods', () => {
    it('InitializeScenario has start method', () => {
      const scenario = new InitializeScenario();
      expect(typeof scenario.start).toBe('function');
    });

    it('InitializeScenario has stop method', () => {
      const scenario = new InitializeScenario();
      expect(typeof scenario.stop).toBe('function');
    });

    it('InitializeScenario has getChecks method', () => {
      const scenario = new InitializeScenario();
      expect(typeof scenario.getChecks).toBe('function');
    });

    it('ToolsCallScenario has start method', () => {
      const scenario = new ToolsCallScenario();
      expect(typeof scenario.start).toBe('function');
    });

    it('ToolsCallScenario has stop method', () => {
      const scenario = new ToolsCallScenario();
      expect(typeof scenario.stop).toBe('function');
    });

    it('ToolsCallScenario has getChecks method', () => {
      const scenario = new ToolsCallScenario();
      expect(typeof scenario.getChecks).toBe('function');
    });

    it('SSERetryScenario has start method', () => {
      const scenario = new SSERetryScenario();
      expect(typeof scenario.start).toBe('function');
    });

    it('SSERetryScenario has stop method', () => {
      const scenario = new SSERetryScenario();
      expect(typeof scenario.stop).toBe('function');
    });

    it('SSERetryScenario has getChecks method', () => {
      const scenario = new SSERetryScenario();
      expect(typeof scenario.getChecks).toBe('function');
    });

    it('ElicitationClientDefaultsScenario has start method', () => {
      const scenario = new ElicitationClientDefaultsScenario();
      expect(typeof scenario.start).toBe('function');
    });

    it('ElicitationClientDefaultsScenario has stop method', () => {
      const scenario = new ElicitationClientDefaultsScenario();
      expect(typeof scenario.stop).toBe('function');
    });

    it('ElicitationClientDefaultsScenario has getChecks method', () => {
      const scenario = new ElicitationClientDefaultsScenario();
      expect(typeof scenario.getChecks).toBe('function');
    });
  });

  describe('Scenario Start/Stop Lifecycle', () => {
    let scenario: InitializeScenario;

    beforeEach(() => {
      scenario = new InitializeScenario();
    });

    it('can start and get server URLs', async () => {
      const urls = await scenario.start();

      expect(urls).toBeDefined();
      expect(urls.serverUrl).toBeDefined();
      expect(urls.serverUrl).toMatch(/^http:\/\/localhost:\d+$/);

      await scenario.stop();
    });

    it('returns different ports for separate instances', async () => {
      const scenario1 = new InitializeScenario();
      const scenario2 = new InitializeScenario();

      const urls1 = await scenario1.start();
      const urls2 = await scenario2.start();

      expect(urls1.serverUrl).not.toBe(urls2.serverUrl);

      await scenario1.stop();
      await scenario2.stop();
    });

    it('handles multiple start/stop cycles', async () => {
      for (let i = 0; i < 3; i++) {
        const urls = await scenario.start();
        expect(urls.serverUrl).toBeDefined();
        await scenario.stop();
      }
    });

    it('cleans up gracefully on stop', async () => {
      const urls = await scenario.start();
      expect(urls.serverUrl).toBeDefined();

      await scenario.stop();

      // After stop, should be able to start again
      const urls2 = await scenario.start();
      expect(urls2.serverUrl).toBeDefined();

      await scenario.stop();
    });
  });

  describe('Scenario Checks Collection', () => {
    it('InitializeScenario returns checks array', () => {
      const scenario = new InitializeScenario();
      const checks = scenario.getChecks();

      expect(Array.isArray(checks)).toBe(true);
      expect(checks.length).toBe(0); // Empty before any requests
    });

    it('ToolsCallScenario returns checks array', () => {
      const scenario = new ToolsCallScenario();
      const checks = scenario.getChecks();

      expect(Array.isArray(checks)).toBe(true);
    });

    it('SSERetryScenario returns checks array', () => {
      const scenario = new SSERetryScenario();
      const checks = scenario.getChecks();

      expect(Array.isArray(checks)).toBe(true);
    });

    it('ElicitationClientDefaultsScenario returns checks array', () => {
      const scenario = new ElicitationClientDefaultsScenario();
      const checks = scenario.getChecks();

      expect(Array.isArray(checks)).toBe(true);
    });
  });

  describe('Scenario Spec Version Support', () => {
    it('InitializeScenario supports valid spec versions', () => {
      const scenario = new InitializeScenario();

      expect(scenario.specVersions).toContain('2025-06-18');
      expect(scenario.specVersions).toContain('2025-11-25');
    });

    it('ToolsCallScenario declares spec versions', () => {
      const scenario = new ToolsCallScenario();

      expect(scenario.specVersions.length).toBeGreaterThan(0);
      expect(typeof scenario.specVersions[0]).toBe('string');
    });

    it('SSERetryScenario declares spec versions', () => {
      const scenario = new SSERetryScenario();

      expect(scenario.specVersions.length).toBeGreaterThan(0);
    });

    it('ElicitationClientDefaultsScenario declares spec versions', () => {
      const scenario = new ElicitationClientDefaultsScenario();

      expect(scenario.specVersions.length).toBeGreaterThan(0);
    });

    it('all spec versions are valid ISO date strings', () => {
      const scenarios = [
        new InitializeScenario(),
        new ToolsCallScenario(),
        new SSERetryScenario(),
        new ElicitationClientDefaultsScenario()
      ];

      for (const scenario of scenarios) {
        for (const version of scenario.specVersions) {
          // Should match YYYY-MM-DD format
          expect(version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
      }
    });
  });

  describe('Scenario Descriptions', () => {
    it('all scenarios have meaningful descriptions', () => {
      const scenarios = [
        new InitializeScenario(),
        new ToolsCallScenario(),
        new SSERetryScenario(),
        new ElicitationClientDefaultsScenario()
      ];

      for (const scenario of scenarios) {
        expect(scenario.description).toBeDefined();
        expect(scenario.description.length).toBeGreaterThan(10);
        expect(typeof scenario.description).toBe('string');
      }
    });

    it('InitializeScenario description mentions initialization', () => {
      const scenario = new InitializeScenario();
      expect(scenario.description.toLowerCase()).toContain('initializ');
    });

    it('ToolsCallScenario description mentions tools', () => {
      const scenario = new ToolsCallScenario();
      expect(scenario.description.toLowerCase()).toContain('tool');
    });

    it('SSERetryScenario description mentions SSE or retry', () => {
      const scenario = new SSERetryScenario();
      const desc = scenario.description.toLowerCase();
      expect(desc).toMatch(/sse|retry/);
    });
  });

  describe('Scenario Names', () => {
    it('all scenarios have unique names', () => {
      const scenarios = [
        new InitializeScenario(),
        new ToolsCallScenario(),
        new SSERetryScenario(),
        new ElicitationClientDefaultsScenario()
      ];

      const names = scenarios.map((s) => s.name);
      const uniqueNames = new Set(names);

      expect(uniqueNames.size).toBe(names.length);
    });

    it('scenario names are lowercase with underscores or hyphens', () => {
      const scenarios = [
        new InitializeScenario(),
        new ToolsCallScenario(),
        new SSERetryScenario(),
        new ElicitationClientDefaultsScenario()
      ];

      for (const scenario of scenarios) {
        expect(scenario.name).toMatch(/^[a-z0-9_-]+$/);
      }
    });

    it('InitializeScenario name is initialize', () => {
      const scenario = new InitializeScenario();
      expect(scenario.name).toBe('initialize');
    });

    it('ToolsCallScenario name is tools_call', () => {
      const scenario = new ToolsCallScenario();
      expect(scenario.name).toBe('tools_call');
    });
  });

  describe('Scenario Construction', () => {
    it('can construct InitializeScenario without errors', () => {
      expect(() => new InitializeScenario()).not.toThrow();
    });

    it('can construct ToolsCallScenario without errors', () => {
      expect(() => new ToolsCallScenario()).not.toThrow();
    });

    it('can construct SSERetryScenario without errors', () => {
      expect(() => new SSERetryScenario()).not.toThrow();
    });

    it('can construct ElicitationClientDefaultsScenario without errors', () => {
      expect(() => new ElicitationClientDefaultsScenario()).not.toThrow();
    });

    it('multiple instances are independent', () => {
      const scenario1 = new InitializeScenario();
      const scenario2 = new InitializeScenario();

      expect(scenario1).not.toBe(scenario2);
      expect(scenario1.getChecks()).not.toBe(scenario2.getChecks());
    });
  });
});
