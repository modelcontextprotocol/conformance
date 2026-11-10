import { describe, expect, test } from 'vitest';
import { getHandler } from '../../../examples/clients/typescript/everything-client';
import { DRAFT_PROTOCOL_VERSION } from '../../types';
import {
  MAX_COMPAT_MESSAGE_BYTES,
  modernProbeRequestInit
} from '../../version-compat';
import type { ScenarioContext } from '../../mock-server';
import { VersionBackcompatScenario } from './version-backcompat';
import {
  InlineClientRunner,
  runClientAgainstScenario
} from './auth/test_helpers/testClient';

const SCENARIO = 'version-backcompat';

async function modernOnlyClient(serverUrl: string): Promise<void> {
  await fetch(serverUrl, modernProbeRequestInit(1));
}

async function wrongVersionFallbackClient(serverUrl: string): Promise<void> {
  await fetch(serverUrl, modernProbeRequestInit(1));
  await fetch(serverUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: {
        protocolVersion: DRAFT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'broken-client', version: '1.0.0' }
      }
    })
  });
  await fetch(serverUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    })
  });
  await fetch(serverUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
      params: {}
    })
  });
}

describe('version backward-compatibility client scenario', () => {
  test('the reference dual-era client falls back to initialize', async () => {
    const handler = getHandler(SCENARIO);
    expect(handler).toBeDefined();

    const checks = await runClientAgainstScenario(
      new InlineClientRunner(handler!),
      SCENARIO,
      { specVersion: DRAFT_PROTOCOL_VERSION }
    );

    expect(checks.map(({ id, status }) => ({ id, status }))).toEqual([
      {
        id: 'version-backcompat-client-modern-probe',
        status: 'SUCCESS'
      },
      {
        id: 'version-backcompat-client-legacy-initialize',
        status: 'SUCCESS'
      },
      {
        id: 'version-backcompat-client-legacy-request',
        status: 'SUCCESS'
      }
    ]);
  });

  test('a modern-only client fails the fallback checks', async () => {
    await runClientAgainstScenario(
      new InlineClientRunner(modernOnlyClient),
      SCENARIO,
      {
        specVersion: DRAFT_PROTOCOL_VERSION,
        expectedSuccessSlugs: ['version-backcompat-client-modern-probe'],
        expectedFailureSlugs: [
          'version-backcompat-client-legacy-initialize',
          'version-backcompat-client-legacy-request'
        ]
      }
    );
  });

  test('a client that initializes with the modern version fails legacy checks', async () => {
    await runClientAgainstScenario(
      new InlineClientRunner(wrongVersionFallbackClient),
      SCENARIO,
      {
        specVersion: DRAFT_PROTOCOL_VERSION,
        expectedSuccessSlugs: ['version-backcompat-client-modern-probe'],
        expectedFailureSlugs: [
          'version-backcompat-client-legacy-initialize',
          'version-backcompat-client-legacy-request'
        ]
      }
    );
  });
  test('rejects scalar JSON and oversized bodies without crashing the scenario', async () => {
    const scenario = new VersionBackcompatScenario();
    const { serverUrl } = await scenario.start({} as ScenarioContext);
    try {
      const scalar = await fetch(serverUrl, { method: 'POST', body: 'null' });
      expect(scalar.status).toBe(400);

      const oversized = await fetch(serverUrl, {
        method: 'POST',
        body: 'x'.repeat(MAX_COMPAT_MESSAGE_BYTES + 1)
      });
      expect(oversized.status).toBe(413);
    } finally {
      await scenario.stop();
    }
  });
});
