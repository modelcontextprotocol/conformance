import { describe, test, expect, vi, afterEach } from 'vitest';
import { testContext } from '../../../connection/testing';
import { DRAFT_PROTOCOL_VERSION } from '../../../types';
import { takeWireViolations } from '../../../validation/wire-schema';
import { EventsPollScenario, EVENTS_POLL_CHECK_IDS } from './poll';
import {
  descriptor,
  startEventsFixture,
  type EventsFixtureOptions
} from './negative-fixture';

// A server that dies mid-scenario (#1535: metronome-mcp crashed on
// `arguments: {}`), and the EVENTS_ARGUMENTS knob that grades past it.

async function pollChecks(opts: EventsFixtureOptions) {
  const fixture = await startEventsFixture(opts);
  try {
    const checks = await new EventsPollScenario().run(
      testContext(fixture.url, DRAFT_PROTOCOL_VERSION)
    );
    takeWireViolations();
    return new Map(checks.map((c) => [c.id, c]));
  } finally {
    await fixture.close();
  }
}

const crashing: EventsFixtureOptions = {
  descriptors: [
    descriptor({
      name: 'tick.event',
      delivery: ['poll'],
      inputSchema: {
        type: 'object',
        properties: { periodSeconds: { type: 'integer', minimum: 1 } }
      }
    })
  ],
  crashOnEmptyArguments: ['events/poll']
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a server that stops answering mid-scenario', () => {
  test('reports every row red, naming the failure, instead of aborting', async () => {
    const checks = await pollChecks(crashing);
    expect(checks.size).toBe(EVENTS_POLL_CHECK_IDS.length);
    for (const id of EVENTS_POLL_CHECK_IDS) {
      const c = checks.get(id);
      expect(c?.status, id).toBe('FAILURE');
      expect(c?.details?.untestable, id).toBe(true);
      expect(c?.errorMessage, id).toContain('HTTP 502');
    }
  });

  test('EVENTS_ARGUMENTS supplies arguments the server survives', async () => {
    vi.stubEnv(
      'EVENTS_ARGUMENTS',
      JSON.stringify({ 'tick.event': { periodSeconds: 1 } })
    );
    const checks = await pollChecks(crashing);
    expect(
      checks.get('sep-3415-poll-implemented')?.status,
      checks.get('sep-3415-poll-implemented')?.errorMessage
    ).toBe('SUCCESS');
  });

  test('a malformed EVENTS_ARGUMENTS says so in the report', async () => {
    vi.stubEnv('EVENTS_ARGUMENTS', 'not json');
    const checks = await pollChecks(crashing);
    expect(checks.get('sep-3415-poll-implemented')?.errorMessage).toContain(
      'EVENTS_ARGUMENTS must be'
    );
  });
});
