/**
 * The everything-client passes every events-client-* scenario, and each
 * broken client in events-broken-clients.ts turns exactly its own checks red.
 * "Exactly" is asserted rather than "at least", because a broken client that
 * also flips a neighbouring check would leave the two indistinguishable.
 */
import { describe, test, expect } from 'vitest';
import { testScenarioContext } from '../../../mock-server/testing';
import type { ConformanceCheck, SpecVersion } from '../../../types';
import { DRAFT_PROTOCOL_VERSION, LATEST_SPEC_VERSION } from '../../../types';
import { getHandler } from '../../../../examples/clients/typescript/everything-client';
import * as broken from '../../../../examples/clients/typescript/events-broken-clients';
import type { Scenario } from '../../../types';
import { EventsClientPollScenario } from './poll';
import { EventsClientPushScenario } from './push';
import { EventsClientWebhookScenario } from './webhook';
import { EventsClientNoExtensionScenario } from './no-extension';

type Client = (serverUrl: string) => Promise<void>;

/**
 * A fresh scenario per run, so the tests can share nothing and run
 * concurrently. The scenarios are timed (up to 10s each), and run one after
 * another the file takes minutes.
 */
const SCENARIOS: Record<string, () => Scenario> = {
  'events-client-poll': () => new EventsClientPollScenario(),
  'events-client-push': () => new EventsClientPushScenario(),
  'events-client-webhook': () => new EventsClientWebhookScenario(),
  'events-client-no-extension': () => new EventsClientNoExtensionScenario()
};

async function run(
  client: Client,
  name: string,
  specVersion?: SpecVersion
): Promise<ConformanceCheck[]> {
  const scenario = SCENARIOS[name]();
  const ctx = testScenarioContext(specVersion);
  const urls = await scenario.start(ctx);
  // Inline clients read the runner's env, which concurrent tests share. Every
  // scenario here sets the same keys, and durationMs is the only per-scenario
  // value, so it travels through the context the client reads at start.
  process.env.MCP_CONFORMANCE_PROTOCOL_VERSION = ctx.specVersion;
  process.env.MCP_CONFORMANCE_CONTEXT = JSON.stringify(urls.context ?? {});
  try {
    await client(urls.serverUrl);
    return scenario.getChecks();
  } finally {
    await scenario.stop();
  }
}

function red(checks: ConformanceCheck[]): string[] {
  return checks
    .filter((c) => c.status === 'FAILURE' || c.status === 'WARNING')
    .map((c) => c.id)
    .sort();
}

const TIMEOUT = 20000;

describe.concurrent('events client scenarios', () => {
  // Both lifecycles: a 2026-07-28 client connects with `server/discover`,
  // which the base class answers before the scenario's handler sees it.
  test.each(
    (
      [
        ['events-client-poll', 7],
        ['events-client-push', 2],
        ['events-client-webhook', 2],
        ['events-client-no-extension', 1]
      ] as const
    ).flatMap(([name, count]) =>
      [LATEST_SPEC_VERSION, DRAFT_PROTOCOL_VERSION].map(
        (v) => [name, v, count] as const
      )
    )
  )(
    'everything-client passes every check in %s at %s',
    async (name, version, count) => {
      const checks = await run(getHandler(name)!, name, version as SpecVersion);
      expect(checks.length).toBe(count);
      expect(red(checks)).toEqual([]);
    },
    TIMEOUT
  );

  test.each([
    [
      'noDrainOnHasMore',
      'events-client-poll',
      ['sep-9999-client-poll-drain-on-has-more']
    ],
    [
      'ignoresNextPollMs',
      'events-client-poll',
      ['sep-9999-client-poll-respects-next-poll-ms']
    ],
    ['noPollFloor', 'events-client-poll', ['sep-9999-client-poll-floor']],
    [
      'dropsTruncatedCursor',
      'events-client-poll',
      ['sep-9999-client-truncated-persists-fresh-cursor']
    ],
    [
      'replaysNullCursor',
      'events-client-poll',
      ['sep-9999-client-null-cursor-not-replayed']
    ],
    [
      'failsOnAbsentCursor',
      'events-client-poll',
      ['sep-9999-client-cursor-absent-tolerated']
    ],
    [
      'ignoresListChanged',
      'events-client-poll',
      ['sep-9999-client-relist-on-list-changed']
    ],
    [
      'refreshesAfterExpiry',
      'events-client-webhook',
      ['sep-9999-client-refresh-before-expiry']
    ],
    [
      'replaysNullCursor',
      'events-client-webhook',
      ['sep-9999-client-null-cursor-not-replayed']
    ],
    [
      'replaysNullCursor',
      'events-client-push',
      ['sep-9999-client-null-cursor-not-replayed']
    ],
    // A client that never reconnects also never sends a reconnect cursor, so
    // the null-cursor row reports untestable alongside the reconnect row.
    [
      'neverReconnects',
      'events-client-push',
      [
        'sep-9999-client-null-cursor-not-replayed',
        'sep-9999-client-stream-reconnect-with-cursor'
      ]
    ],
    [
      'ignoresExtensionGate',
      'events-client-no-extension',
      ['sep-9999-client-no-events-without-extension']
    ]
  ] as const)(
    '%s against %s turns exactly %j red',
    async (client, name, expected) => {
      const checks = await run(broken[client as keyof typeof broken], name);
      expect(red(checks)).toEqual([...expected].sort());
    },
    TIMEOUT
  );
});
