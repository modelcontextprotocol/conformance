import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LegacyExtensionsScenario } from './legacy-extensions';
import { CLIENT_EXTENSIONS, EXTENSIONS_ECHO_TOOL } from '../legacy-extensions';
import { runBrokenLegacyClient } from '../../../examples/clients/typescript/legacy-extensions-broken';
import {
  listCoreScenarios,
  listExtensionScenarios,
  listScenariosForSpec
} from '../index';
import { DATED_SPEC_VERSIONS, DRAFT_PROTOCOL_VERSION } from '../../types';

describe('legacy client extensions', () => {
  it('round-trips both directions through the real SDK', async () => {
    const scenario = new LegacyExtensionsScenario();
    const { serverUrl } = await scenario.start();
    const client = new Client(
      { name: 'extensions-test', version: '1.0.0' },
      { capabilities: { extensions: CLIENT_EXTENSIONS } }
    );
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(serverUrl))
      );
      await client.callTool({
        name: EXTENSIONS_ECHO_TOOL,
        arguments: { extensions: client.getServerCapabilities()?.extensions }
      });
      expect(scenario.getChecks()).toHaveLength(7);
      expect(scenario.getChecks().every((c) => c.status === 'SUCCESS')).toBe(
        true
      );
      expect(new Set(scenario.getChecks().map((c) => c.id)).size).toBe(7);
    } finally {
      await client.close();
      await scenario.stop();
    }
  });
  it.each([
    'advertisement',
    'reception',
    'settings',
    'missing-report'
  ] as const)('detects %s loss', async (mode) => {
    const scenario = new LegacyExtensionsScenario();
    const { serverUrl } = await scenario.start();
    try {
      await runBrokenLegacyClient(serverUrl, mode);
      const checks = scenario.getChecks();
      const id =
        mode === 'missing-report'
          ? 'legacy-extensions-client-report'
          : `legacy-extensions-client-${mode === 'advertisement' ? 'advertisement' : 'reception'}-conformance`;
      expect(checks.find((c) => c.id === id)?.status).toBe('FAILURE');
      if (mode === 'missing-report')
        expect(checks.find((c) => c.id === id)?.details?.untestable).toBe(true);
    } finally {
      await scenario.stop();
    }
  });
  it('fails if no client connects and resets between runs', async () => {
    const scenario = new LegacyExtensionsScenario();
    await scenario.start();
    try {
      expect(scenario.getChecks().every((c) => c.status === 'FAILURE')).toBe(
        true
      );
    } finally {
      await scenario.stop();
    }
    await scenario.start();
    try {
      expect(scenario.getChecks().every((c) => c.status === 'FAILURE')).toBe(
        true
      );
    } finally {
      await scenario.stop();
    }
  });
  it('is opt-in and outside all core protocol selections', () => {
    expect(listExtensionScenarios()).toContain('legacy-extensions');
    expect(listCoreScenarios()).not.toContain('legacy-extensions');
    for (const version of [
      ...DATED_SPEC_VERSIONS,
      DRAFT_PROTOCOL_VERSION
    ] as const) {
      expect(listScenariosForSpec(version)).not.toContain('legacy-extensions');
    }
  });
});
