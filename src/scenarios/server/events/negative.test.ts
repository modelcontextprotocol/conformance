import { describe, test, expect } from 'vitest';
import { testContext } from '../../../connection/testing';
import { DRAFT_PROTOCOL_VERSION } from '../../../types';
import { takeWireViolations } from '../../../validation/wire-schema';
import { EventsDiscoveryScenario } from './discovery';
import { EventsPollScenario } from './poll';
import {
  descriptor,
  occurrence,
  pollResult,
  startEventsFixture,
  type EventsFixtureOptions
} from './negative-fixture';

/**
 * Negative controls for the MCP Events scenarios.
 *
 * A passing run against a conformant fixture proves a check does not
 * false-positive. It does not prove the check catches anything, which is what
 * these tests are for: every assertion below pairs a conformant server with a
 * server broken in exactly one way, and asserts the check flips.
 *
 * The three divergences the suite is expected to find in mcpkit each get a
 * test here, so the checks that will report them are known to work before
 * anyone reads a red run and wonders whether the harness is wrong:
 * `nextPollSeconds` (gap G31), and the two error-code paths behind event-type
 * removal (gap G30).
 *
 * The fixture is a minimal SEP-2575 stateless server built per test rather
 * than a checked-in example file, matching the SEP-2640 negative tests. It
 * lives in negative-fixture.ts, shared with the controls for the other three
 * scenarios: negative-push.test.ts, negative-webhook.test.ts and
 * negative-delivery.test.ts.
 */

type Scenario = EventsDiscoveryScenario | EventsPollScenario;

async function checksFor(scenario: Scenario, opts: EventsFixtureOptions) {
  const fixture = await startEventsFixture(opts);
  try {
    const checks = await scenario.run(
      testContext(fixture.url, DRAFT_PROTOCOL_VERSION)
    );
    // Drained so an intentionally malformed response does not trip the global
    // vitest hook; these tests assert on the check, not the wire validator.
    takeWireViolations();
    return new Map(checks.map((c) => [c.id, c]));
  } finally {
    await fixture.close();
  }
}

const discovery = () => new EventsDiscoveryScenario();
const poll = () => new EventsPollScenario();

/** The baseline every negative case is compared against. */
const CONFORMANT: EventsFixtureOptions = {
  capability: { listChanged: true },
  descriptors: [descriptor()],
  pollResponses: [pollResult()]
};

describe('events capability declaration', () => {
  test('an object declaration passes; a boolean one fails rather than skipping', async () => {
    const ok = await checksFor(discovery(), CONFORMANT);
    expect(ok.get('sep-9999-capability-events-object')?.status).toBe('SUCCESS');

    const broken = await checksFor(discovery(), {
      ...CONFORMANT,
      capability: true
    });
    const check = broken.get('sep-9999-capability-events-object');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('a boolean');
  });

  test('a server that declares nothing and serves nothing skips all but the fallback row', async () => {
    const checks = await checksFor(discovery(), {
      listError: { code: -32601, message: 'Method not found' }
    });
    // Every events rule is inapplicable to a server that does not do events,
    // except the one saying what such a server answers. It answered it.
    expect(checks.get('sep-9999-fallback-method-not-found')?.status).toBe(
      'SUCCESS'
    );
    for (const check of checks.values()) {
      if (check.id === 'sep-9999-fallback-method-not-found') continue;
      expect(check.status, check.id).toBe('SKIPPED');
    }
  });

  test('the fallback row is emitted even when it cannot apply', async () => {
    // A row that vanishes on some servers makes pass counts incomparable
    // between them, which is why every path emits the whole set.
    const checks = await checksFor(discovery(), CONFORMANT);
    const check = checks.get('sep-9999-fallback-method-not-found');
    expect(check).toBeDefined();
    expect(check?.status).toBe('SKIPPED');
    expect(check?.errorMessage).toContain('declares the extension');
  });

  test('answering something other than -32601 fails the fallback row', async () => {
    const checks = await checksFor(discovery(), {
      listError: { code: -32000, message: 'nope' }
    });
    const check = checks.get('sep-9999-fallback-method-not-found');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('-32601 MethodNotFound');
  });

  test('empty settings pass, and declared settings make the rule inapplicable', async () => {
    const empty = await checksFor(discovery(), {
      ...CONFORMANT,
      capability: {}
    });
    expect(empty.get('sep-9999-capability-empty-settings')?.status).toBe(
      'SUCCESS'
    );

    const populated = await checksFor(discovery(), CONFORMANT);
    const check = populated.get('sep-9999-capability-empty-settings');
    expect(check?.status).toBe('SKIPPED');
    expect(check?.errorMessage).toContain('listChanged');
  });

  // The case mcpkit is actually in: events/list answers, but nothing is
  // declared, so a client that reads capabilities first never calls it. A
  // plain SKIP here would report that as a clean run.
  test('serving events/list while declaring nothing fails rather than skipping', async () => {
    const checks = await checksFor(discovery(), {
      descriptors: [descriptor()]
    });
    const cap = checks.get('sep-9999-capability-events-object');
    expect(cap?.status).toBe('FAILURE');
    expect(cap?.errorMessage).toContain('declares no `capabilities.extensions');
    expect(cap?.errorMessage).toContain('unreachable');

    // And the rest of the scenario is still graded, not abandoned.
    expect(checks.get('sep-9999-list-implemented')?.status).toBe('SUCCESS');
    expect(checks.get('sep-9999-descriptor-name')?.status).toBe('SUCCESS');
  });

  test('the poll scenario likewise grades an undeclared-but-serving server', async () => {
    const checks = await checksFor(poll(), { descriptors: [descriptor()] });
    expect(checks.get('sep-9999-poll-implemented')?.status).toBe('SUCCESS');

    const skipped = await checksFor(poll(), {
      listError: { code: -32601, message: 'Method not found' }
    });
    expect(skipped.get('sep-9999-poll-implemented')?.status).toBe('SKIPPED');
  });

  test('a non-boolean listChanged fails', async () => {
    const checks = await checksFor(discovery(), {
      ...CONFORMANT,
      capability: { listChanged: 'yes' }
    });
    const check = checks.get('sep-9999-capability-list-changed-flag');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('a string');
  });
});

describe('events/list descriptors', () => {
  test('a descriptor missing name fails', async () => {
    const checks = await checksFor(discovery(), {
      ...CONFORMANT,
      descriptors: [descriptor({ name: undefined })]
    });
    expect(checks.get('sep-9999-descriptor-name')?.status).toBe('FAILURE');
  });

  test('an empty delivery array fails; a valid subset passes', async () => {
    const ok = await checksFor(discovery(), CONFORMANT);
    expect(ok.get('sep-9999-descriptor-delivery-subset')?.status).toBe(
      'SUCCESS'
    );

    const broken = await checksFor(discovery(), {
      ...CONFORMANT,
      descriptors: [descriptor({ delivery: [] })]
    });
    const check = broken.get('sep-9999-descriptor-delivery-subset');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('non-empty');
  });

  test('a delivery mode outside poll/push/webhook fails', async () => {
    const checks = await checksFor(discovery(), {
      ...CONFORMANT,
      descriptors: [descriptor({ delivery: ['poll', 'carrier-pigeon'] })]
    });
    const check = checks.get('sep-9999-descriptor-delivery-subset');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('carrier-pigeon');
  });

  test('a missing payloadSchema fails', async () => {
    const checks = await checksFor(discovery(), {
      ...CONFORMANT,
      descriptors: [descriptor({ payloadSchema: undefined })]
    });
    expect(checks.get('sep-9999-descriptor-payload-schema')?.status).toBe(
      'FAILURE'
    );
  });

  test('an empty catalog reports descriptor checks untestable, never green', async () => {
    const checks = await checksFor(discovery(), {
      ...CONFORMANT,
      descriptors: []
    });
    const check = checks.get('sep-9999-descriptor-name');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('Not testable');
    expect(check?.details?.untestable).toBe(true);
  });

  test('an unimplemented events/list fails and names the capability mismatch', async () => {
    const checks = await checksFor(discovery(), {
      ...CONFORMANT,
      listError: { code: -32601, message: 'Method not found' }
    });
    const check = checks.get('sep-9999-list-implemented');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('declares `capabilities.extensions');
  });
});

describe('events error codes', () => {
  test('an unknown event name answering -32011 passes, -32014 fails', async () => {
    const ok = await checksFor(discovery(), CONFORMANT);
    expect(ok.get('sep-9999-error-not-found')?.status).toBe('SUCCESS');

    const broken = await checksFor(discovery(), {
      ...CONFORMANT,
      unknownNameCode: -32014
    });
    const check = broken.get('sep-9999-error-not-found');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('-32014 Unsupported` is for');
  });

  test('a code outside the server range fails the range check', async () => {
    const checks = await checksFor(discovery(), {
      ...CONFORMANT,
      unknownNameCode: -1
    });
    const check = checks.get('sep-9999-error-server-range');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('outside');
  });
});

describe('events/poll response shape', () => {
  test('nextPollSeconds is caught and named as the pre-rename field', async () => {
    const ok = await checksFor(poll(), CONFORMANT);
    expect(ok.get('sep-9999-poll-next-poll-ms')?.status).toBe('SUCCESS');

    // Gap G31: mcpkit still ships this. The check has to name the rename, or a
    // reader of the red run cannot tell it from a server that omits the field.
    const legacy = await checksFor(poll(), {
      ...CONFORMANT,
      pollResponses: [
        pollResult({ nextPollMs: undefined, nextPollSeconds: 30 })
      ]
    });
    const check = legacy.get('sep-9999-poll-next-poll-ms');
    expect(check?.status).toBe('WARNING');
    expect(check?.errorMessage).toContain('nextPollSeconds');
    expect(check?.errorMessage).toContain('197c32b4');
  });

  test('a non-array events field fails', async () => {
    const checks = await checksFor(poll(), {
      ...CONFORMANT,
      pollResponses: [pollResult({ events: null })]
    });
    expect(checks.get('sep-9999-poll-events-array')?.status).toBe('FAILURE');
  });

  test('a numeric cursor fails the opaque-string check', async () => {
    const checks = await checksFor(poll(), {
      ...CONFORMANT,
      pollResponses: [pollResult({ cursor: 42 })]
    });
    expect(checks.get('sep-9999-poll-response-cursor')?.status).toBe('FAILURE');
    expect(checks.get('sep-9999-cursor-opaque')?.status).toBe('FAILURE');
  });

  test('replaying history for a null cursor fails start-from-now', async () => {
    const checks = await checksFor(poll(), {
      ...CONFORMANT,
      pollResponses: [pollResult({ events: [occurrence()] })]
    });
    const check = checks.get('sep-9999-cursor-null-starts-from-now');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('start from now');
  });
});

describe('events/poll cursor lifecycle', () => {
  test('a quiet poll that drops the cursor fails advancement', async () => {
    const ok = await checksFor(poll(), CONFORMANT);
    expect(ok.get('sep-9999-cursor-advances-when-quiet')?.status).toBe(
      'SUCCESS'
    );

    const broken = await checksFor(poll(), {
      ...CONFORMANT,
      pollResponses: [pollResult(), pollResult({ cursor: 7 })]
    });
    expect(broken.get('sep-9999-cursor-advances-when-quiet')?.status).toBe(
      'FAILURE'
    );
  });

  test('a type that flips between a cursor and null warns on consistency', async () => {
    const checks = await checksFor(poll(), {
      ...CONFORMANT,
      pollResponses: [pollResult(), pollResult({ cursor: null })]
    });
    const check = checks.get('sep-9999-cursor-consistency');
    expect(check?.status).toBe('WARNING');
    expect(check?.errorMessage).toContain('branch once');
  });

  test('rejecting a poll that omits cursor fails absent-means-null', async () => {
    const checks = await checksFor(poll(), {
      ...CONFORMANT,
      // Poll order: 1 bootstraps, 2 carries the cursor forward, 3 is the one
      // that omits `cursor` entirely. Only the third may fail here.
      pollResponses: [
        pollResult(),
        pollResult(),
        { error: { code: -32602, message: 'InvalidParams: cursor required' } }
      ]
    });
    const check = checks.get('sep-9999-cursor-absent-equals-null');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('absent cursor means');
  });

  test('truncated true with no fresh cursor fails', async () => {
    const checks = await checksFor(poll(), {
      ...CONFORMANT,
      pollResponses: [
        pollResult(),
        pollResult(),
        pollResult(),
        pollResult({ truncated: true, cursor: null })
      ]
    });
    const check = checks.get('sep-9999-truncated-returns-fresh-cursor');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('no fresh position');
  });
});

describe('events/poll error contract', () => {
  test('a poll omitting name must not return a result', async () => {
    const ok = await checksFor(poll(), CONFORMANT);
    expect(ok.get('sep-9999-poll-one-subscription-per-request')?.status).toBe(
      'SUCCESS'
    );
  });

  test('the -32602 error-table row carries the same verdict as the rule', async () => {
    const ok = await checksFor(poll(), CONFORMANT);
    const row = ok.get('sep-9999-error-invalid-params');
    expect(row?.status).toBe('SUCCESS');
    expect(row?.details?.gradedBy).toBe('sep-9999-poll-invalid-arguments');

    const broken = await checksFor(poll(), {
      ...CONFORMANT,
      invalidArgsCode: -32011
    });
    expect(broken.get('sep-9999-error-invalid-params')?.status).toBe('FAILURE');
  });

  test('wrong-typed arguments answering -32011 fails the invalid-params check', async () => {
    const ok = await checksFor(poll(), CONFORMANT);
    expect(ok.get('sep-9999-poll-invalid-arguments')?.status).toBe('SUCCESS');

    const broken = await checksFor(poll(), {
      ...CONFORMANT,
      invalidArgsCode: -32011
    });
    const check = broken.get('sep-9999-poll-invalid-arguments');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('expected -32602');
  });

  test('polling a push-only type must answer -32014, not a result', async () => {
    const pushOnly = descriptor({ name: 'push.only', delivery: ['push'] });
    const broken = await checksFor(poll(), {
      ...CONFORMANT,
      descriptors: [descriptor(), pushOnly],
      pollByName: { 'push.only': pollResult() }
    });
    const check = broken.get('sep-9999-poll-mode-unsupported');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('does not advertise');

    const ok = await checksFor(poll(), {
      ...CONFORMANT,
      descriptors: [descriptor(), pushOnly],
      pollByName: {
        'push.only': { error: { code: -32014, message: 'Unsupported' } }
      }
    });
    expect(ok.get('sep-9999-poll-mode-unsupported')?.status).toBe('SUCCESS');
  });

  test('every type offering poll reports the unsupported-mode check untestable', async () => {
    const checks = await checksFor(poll(), CONFORMANT);
    const check = checks.get('sep-9999-poll-mode-unsupported');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('Not testable');
  });
});

describe('EventOccurrence shape', () => {
  test('a quiet server reports the occurrence checks untestable, never green', async () => {
    const checks = await checksFor(poll(), CONFORMANT);
    const check = checks.get('sep-9999-occurrence-event-id');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('Not testable');
  });

  test('a non-ISO timestamp fails', async () => {
    const checks = await checksFor(poll(), {
      ...CONFORMANT,
      pollResponses: [
        pollResult({
          events: [occurrence({ timestamp: 'last tuesday' })],
          cursor: null
        })
      ]
    });
    expect(checks.get('sep-9999-occurrence-timestamp')?.status).toBe('FAILURE');
  });

  test('a repeated eventId within one batch warns', async () => {
    const checks = await checksFor(poll(), {
      ...CONFORMANT,
      pollResponses: [
        pollResult({
          events: [occurrence(), occurrence()],
          cursor: null
        })
      ]
    });
    const check = checks.get('sep-9999-occurrence-event-id-from-upstream');
    expect(check?.status).toBe('WARNING');
    expect(check?.errorMessage).toContain('dedup');
  });

  test('a missing data object fails', async () => {
    const checks = await checksFor(poll(), {
      ...CONFORMANT,
      pollResponses: [
        pollResult({
          events: [occurrence({ data: undefined })],
          cursor: null
        })
      ]
    });
    expect(checks.get('sep-9999-occurrence-data')?.status).toBe('FAILURE');
  });
});
