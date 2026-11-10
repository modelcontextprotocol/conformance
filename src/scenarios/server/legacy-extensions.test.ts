import { describe, it, expect } from 'vitest';
import { ServerLegacyExtensionsScenario } from './legacy-extensions';
import { startBrokenLegacyServer } from '../../../examples/servers/typescript/legacy-extensions-broken';
import { testContext } from '../../connection/testing';
import {
  listActiveClientScenarios,
  listExtensionClientScenarios,
  listClientScenariosForSpec
} from '../index';
import { DATED_SPEC_VERSIONS, DRAFT_PROTOCOL_VERSION } from '../../types';

describe('legacy server extensions', () => {
  it.each([
    'advertisement',
    'reception',
    'settings',
    'missing-report'
  ] as const)('detects %s loss', async (mode) => {
    const server = await startBrokenLegacyServer(mode);
    try {
      const checks = await new ServerLegacyExtensionsScenario().run(
        testContext(server.url)
      );
      const id =
        mode === 'missing-report'
          ? 'legacy-extensions-server-report'
          : `legacy-extensions-server-${mode === 'advertisement' ? 'advertisement' : 'reception'}-conformance`;
      expect(checks.find((c) => c.id === id)?.status).toBe('FAILURE');
      if (mode === 'advertisement') {
        // The Python-style response serialization regression must fail even
        // though the server still exposes received client capabilities correctly.
        expect(
          checks
            .filter((c) => c.id.includes('server-reception'))
            .every((c) => c.status === 'SUCCESS')
        ).toBe(true);
      }
      if (mode === 'missing-report')
        expect(checks.find((c) => c.id === id)?.details?.untestable).toBe(true);
    } finally {
      await server.close();
    }
  });
  it('fails rather than silently testing another negotiated version', async () => {
    const server = await startBrokenLegacyServer('wrong-version');
    try {
      const checks = await new ServerLegacyExtensionsScenario().run(
        testContext(server.url)
      );
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({
        id: 'legacy-extensions-server-handshake',
        status: 'FAILURE'
      });
    } finally {
      await server.close();
    }
  });
  it('is opt-in and outside all core protocol selections', () => {
    expect(listExtensionClientScenarios()).toContain(
      'server-legacy-extensions'
    );
    expect(listActiveClientScenarios()).not.toContain(
      'server-legacy-extensions'
    );
    for (const version of [
      ...DATED_SPEC_VERSIONS,
      DRAFT_PROTOCOL_VERSION
    ] as const) {
      expect(listClientScenariosForSpec(version)).not.toContain(
        'server-legacy-extensions'
      );
    }
  });
});
