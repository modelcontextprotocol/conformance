import { describe, expect, test } from 'vitest';
import { SSERetryScenario } from './sse-retry';

describe('SSERetryScenario diagnostics', () => {
  test('reports an acceptable late reconnect as INFO', () => {
    const scenario = new SSERetryScenario();
    Reflect.set(scenario, 'toolStreamCloseTime', 1_000);
    Reflect.set(scenario, 'getReconnectionTime', 1_800);
    Reflect.set(scenario, 'getConnectionCount', 1);
    Reflect.set(scenario, 'lastEventIds', ['event-1']);

    const timing = scenario
      .getChecks()
      .find((check) => check.id === 'client-sse-retry-timing');

    expect(timing).toMatchObject({
      status: 'INFO',
      details: {
        slightlyLate: true,
        veryLate: false
      }
    });
    expect(timing?.errorMessage).toBeUndefined();
  });
});
