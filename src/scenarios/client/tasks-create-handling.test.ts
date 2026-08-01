import { describe, expect, test } from 'vitest';
import { getHandler } from '../../../examples/clients/typescript/everything-client';
import { runClient as noPollClient } from '../../../examples/clients/typescript/tasks-client-no-poll';
import { DRAFT_PROTOCOL_VERSION } from '../../types';
import { listExtensionScenarios } from '../index';
import { extensionScenariosList } from './auth/index';
import {
  InlineClientRunner,
  runClientAgainstScenario
} from './auth/test_helpers/testClient';

const SCENARIO = 'tasks-client-create-handling';

describe('SEP-2663 Tasks client handling', () => {
  test('everything-client handles CreateTaskResult and retrieves the result', async () => {
    const handler = getHandler(SCENARIO);
    expect(handler).toBeDefined();

    const checks = await runClientAgainstScenario(
      new InlineClientRunner(handler!),
      SCENARIO,
      { specVersion: DRAFT_PROTOCOL_VERSION }
    );

    expect(checks).toEqual([
      expect.objectContaining({
        id: 'sep-2663-client-handles-polymorphic-result',
        status: 'SUCCESS'
      })
    ]);
  });

  test('detects a client that ignores CreateTaskResult', async () => {
    const checks = await runClientAgainstScenario(
      new InlineClientRunner(noPollClient),
      SCENARIO,
      {
        specVersion: DRAFT_PROTOCOL_VERSION,
        expectedFailureSlugs: ['sep-2663-client-handles-polymorphic-result']
      }
    );

    expect(checks[0]).toMatchObject({
      status: 'FAILURE',
      errorMessage:
        'Client received CreateTaskResult but did not retrieve it with tasks/get.'
    });
  });

  test('is selected without dropping existing extension scenarios', () => {
    const listed = listExtensionScenarios();
    expect(listed).toContain(SCENARIO);
    expect(listed).toEqual(
      expect.arrayContaining(
        extensionScenariosList.map((scenario) => scenario.name)
      )
    );
  });
});
