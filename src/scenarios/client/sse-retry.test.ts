import { describe, expect, test } from 'vitest';
import { SSERetryScenario } from './sse-retry';

describe('SSERetryScenario retry timing', () => {
  test.each([
    [449, 'FAILURE'],
    [450, 'SUCCESS'],
    [500, 'SUCCESS'],
    [800, 'SUCCESS'],
    [5_000, 'SUCCESS']
  ])('reports a %ims reconnect as %s', (delay, status) => {
    const scenario = new SSERetryScenario();
    Reflect.set(scenario, 'toolStreamCloseTime', 1_000);
    Reflect.set(scenario, 'getReconnectionTime', 1_000 + delay);
    Reflect.set(scenario, 'getConnectionCount', 1);
    Reflect.set(scenario, 'lastEventIds', ['event-1']);

    const timing = scenario
      .getChecks()
      .find((check) => check.id === 'client-sse-retry-timing');

    expect(timing).toMatchObject({
      status,
      details: {
        actualDelayMs: delay,
        minAcceptableMs: 450
      }
    });
    if (status === 'FAILURE') {
      expect(timing?.errorMessage).toContain('reconnected too early');
    } else {
      expect(timing?.errorMessage).toBeUndefined();
    }
  });

  test('reports missing timing data as INFO', () => {
    const scenario = new SSERetryScenario();
    Reflect.set(scenario, 'getConnectionCount', 1);

    const timing = scenario
      .getChecks()
      .find((check) => check.id === 'client-sse-retry-timing');

    expect(timing?.status).toBe('INFO');
    expect(timing?.errorMessage).toContain('Could not measure timing');
  });
});
