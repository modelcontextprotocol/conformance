import { describe, expect, test } from 'vitest';
import { getHandler } from '../../../examples/clients/typescript/everything-client';
import {
  runClient,
  type PaginationDefect
} from '../../../examples/clients/typescript/pagination-broken-client';
import { getScenario, listCoreScenarios } from '../index';
import { testScenarioContext } from '../../mock-server/testing';
import { DRAFT_PROTOCOL_VERSION, LATEST_SPEC_VERSION } from '../../types';
import { PaginationScenario } from './pagination';
import {
  InlineClientRunner,
  runClientAgainstScenario
} from './auth/test_helpers/testClient';

const EMPTY = 'pagination-empty-cursor';
const OPAQUE = 'pagination-opaque-cursor';
const TOOL = 'pagination-tool-discovered';
const END = 'pagination-stops-at-end';
const CHECK_IDS = [EMPTY, OPAQUE, TOOL, END];

test('client-pagination is registered in the core suite', () => {
  expect(getScenario('client-pagination')).toBeInstanceOf(PaginationScenario);
  expect(listCoreScenarios()).toContain('client-pagination');
});

describe.each([LATEST_SPEC_VERSION, DRAFT_PROTOCOL_VERSION] as const)(
  'client-pagination at %s',
  (specVersion) => {
    test('everything-client completes the traversal with no skipped checks', async () => {
      const handler = getHandler('client-pagination');
      if (!handler) throw new Error('Missing client-pagination handler');
      const checks = await runClientAgainstScenario(
        new InlineClientRunner(handler),
        'client-pagination',
        { specVersion }
      );
      expect(checks.map((check) => check.id)).toEqual(CHECK_IDS);
      expect(checks.every((check) => check.status === 'SUCCESS')).toBe(true);
    });

    const faults: Array<{
      defect: PaginationDefect;
      failures: string[];
      successes: string[];
    }> = [
      {
        defect: 'truthy-cursor',
        failures: CHECK_IDS,
        successes: []
      },
      {
        defect: 'trim-cursor',
        failures: [OPAQUE, TOOL, END],
        successes: [EMPTY]
      },
      {
        defect: 'recover-trim',
        failures: [OPAQUE],
        successes: [EMPTY, TOOL, END]
      },
      {
        defect: 'empty-page',
        failures: [OPAQUE, TOOL, END],
        successes: [EMPTY]
      },
      {
        defect: 'past-end',
        failures: [END],
        successes: [EMPTY, OPAQUE, TOOL]
      }
    ];
    for (const { defect, failures, successes } of faults) {
      test(`detects the ${defect} control`, async () => {
        const checks = await runClientAgainstScenario(
          new InlineClientRunner((url) => runClient(url, defect)),
          'client-pagination',
          {
            specVersion,
            expectedFailureSlugs: failures,
            expectedSuccessSlugs: successes
          }
        );
        expect(
          checks
            .filter((check) => check.status !== 'SUCCESS')
            .map((check) => check.id)
        ).toEqual(failures);
        if (defect === 'past-end') {
          expect(checks.find((check) => check.id === END)?.status).toBe(
            'WARNING'
          );
        }
      });
    }

    test('an inert client cannot pass any unexercised check', async () => {
      const checks = await runClientAgainstScenario(
        new InlineClientRunner((url) => runClient(url, 'inert')),
        'client-pagination',
        { specVersion, expectedFailureSlugs: CHECK_IDS }
      );
      expect(checks.map((check) => check.id)).toEqual(CHECK_IDS);
      expect(checks.every((check) => check.details?.untestable === true)).toBe(
        true
      );
      expect(checks.map((check) => check.status)).toEqual([
        'FAILURE',
        'FAILURE',
        'FAILURE',
        'WARNING'
      ]);
    });

    test('allows a new discovery after the requested traversal and tool call', async () => {
      await runClientAgainstScenario(
        new InlineClientRunner((url) => runClient(url, 'rediscover')),
        'client-pagination',
        { specVersion }
      );
    });
  }
);

test('getChecks is idempotent and the same scenario starts without old evidence', async () => {
  const scenario = new PaginationScenario();
  const urls = await scenario.start(testScenarioContext());
  try {
    const handler = getHandler('client-pagination');
    if (!handler) throw new Error('Missing client-pagination handler');
    await handler(urls.serverUrl);
    const first = scenario.getChecks();
    const second = scenario.getChecks();
    expect(first.map((check) => [check.id, check.status])).toEqual(
      second.map((check) => [check.id, check.status])
    );
    expect(first).toHaveLength(4);
    expect(first.every((check) => check.status === 'SUCCESS')).toBe(true);
  } finally {
    await scenario.stop();
  }
  await scenario.start(testScenarioContext());
  try {
    expect(
      scenario.getChecks().every((check) => check.details?.untestable)
    ).toBe(true);
  } finally {
    await scenario.stop();
  }
});
