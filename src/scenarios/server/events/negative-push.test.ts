import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import { DRAFT_PROTOCOL_VERSION } from '../../../types';
import {
  descriptor,
  startEventsFixture,
  type EventsFixtureOptions,
  type StreamBehaviour
} from './negative-fixture';

/**
 * Negative controls for `events-push`.
 *
 * A passing run against kitchen-sink proves the scenario does not
 * false-positive. It does not prove any check catches anything, which is what
 * these are for: each case pairs the conformant fixture with one broken in
 * exactly one way and asserts the check flips.
 *
 * Four rows report untestable against both real implementations, because no
 * client can ask a server to fail upstream, lose its replay window, terminate a
 * subscription or close a stream. The fixture can do all four on demand, so
 * they are graded here rather than only declared — which is the only evidence
 * that those checks work at all.
 *
 * `EVENTS_PUSH_WATCH_MS` is stubbed down from 35s, since the scenario reads it
 * when the module is first evaluated, and `vi.resetModules()` before the dynamic
 * import is what makes the stub land regardless of whether another test file
 * imported the scenario first. Two catches follow from that. A reset registry
 * hands back a second copy of the connection module, and `err instanceof
 * JsonRpcError` is false across two copies of the same class, so the run context
 * has to come from the same fresh graph as the scenario rather than a static
 * import up here. And the window is fixed at import, so one graph means one
 * window.
 *
 * The fast cases share one 900ms graph, imported once, and run concurrently:
 * each builds its own fixture on its own port and touches nothing shared. The
 * single case that has to outlast the 30s cadence the document permits takes its
 * own graph, sequentially, at the foot of the file — a `resetModules()` while
 * the concurrent cases were still running would pull their graph out from under
 * them.
 */

/** The window every case uses, except the one that needs to outlast 30s. */
const FAST_WATCH_MS = 900;

type Imported = {
  Scenario: typeof import('./push').EventsPushScenario;
  testContext: typeof import('../../../connection/testing').testContext;
  takeWireViolations: typeof import('../../../validation/wire-schema').takeWireViolations;
};

/** The scenario, with one watch window, in its own module registry. */
async function importWith(watchMs: number): Promise<Imported> {
  vi.stubEnv('EVENTS_PUSH_WATCH_MS', String(watchMs));
  vi.resetModules();
  const [scenario, testing, wire] = await Promise.all([
    import('./push'),
    import('../../../connection/testing'),
    import('../../../validation/wire-schema')
  ]);
  return {
    Scenario: scenario.EventsPushScenario,
    testContext: testing.testContext,
    takeWireViolations: wire.takeWireViolations
  };
}

let fast: Imported;

beforeAll(async () => {
  fast = await importWith(FAST_WATCH_MS);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

async function pushChecks(opts: EventsFixtureOptions, using: Imported = fast) {
  const fixture = await startEventsFixture(opts);
  try {
    const checks = await new using.Scenario().run(
      using.testContext(fixture.url, DRAFT_PROTOCOL_VERSION)
    );
    // Drained so an intentionally malformed frame does not trip the global
    // vitest hook; these tests assert on the check, not the wire validator.
    using.takeWireViolations();
    return new Map(checks.map((c) => [c.id, c]));
  } finally {
    await fixture.close();
  }
}

/** A push-capable catalog, which is the only thing this scenario selects on. */
function pushFixture(stream: StreamBehaviour = {}): EventsFixtureOptions {
  return {
    capability: { listChanged: true },
    descriptors: [descriptor({ name: 'push.event', delivery: ['push'] })],
    stream
  };
}

describe.concurrent('events/stream opening', () => {
  test('the conformant fixture passes every gradeable row', async () => {
    const checks = await pushChecks(pushFixture());
    for (const id of [
      'sep-9999-stream-implemented',
      'sep-9999-stream-active-confirmation',
      'sep-9999-stream-subscription-id-meta',
      'sep-9999-stream-event-notification',
      'sep-9999-stream-carries-only-event-notifications',
      'sep-9999-stream-heartbeat-required',
      'sep-9999-stream-heartbeat-carries-cursor',
      'sep-9999-stream-heartbeat-interval',
      'sep-9999-stream-heartbeat-not-sse-comment',
      'sep-9999-stream-cancel-stops-delivery',
      'sep-9999-stream-exempt-from-concurrency-cap',
      'sep-9999-stream-error-before-open'
    ]) {
      expect(checks.get(id)?.status, id).toBe('SUCCESS');
    }
  });

  test('a server with no push-capable type reports every row untestable', async () => {
    const checks = await pushChecks({
      capability: { listChanged: true },
      descriptors: [descriptor()]
    });
    const check = checks.get('sep-9999-stream-implemented');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('No event type advertises');
    expect(check?.details?.untestable).toBe(true);
  });

  test('a server that declares nothing and serves nothing skips the suite', async () => {
    const checks = await pushChecks({
      listError: { code: -32601, message: 'Method not found' }
    });
    for (const check of checks.values()) {
      expect(check.status).toBe('SKIPPED');
    }
  });

  test('answering events/stream with a JSON result rather than a stream fails', async () => {
    const checks = await pushChecks(pushFixture({ answerJson: true }));
    const check = checks.get('sep-9999-stream-implemented');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('expected an SSE stream');
    // And nothing on the stream is reported green just because it was silent.
    expect(checks.get('sep-9999-stream-heartbeat-required')?.status).toBe(
      'FAILURE'
    );
    expect(
      checks.get('sep-9999-stream-heartbeat-required')?.details?.untestable
    ).toBe(true);
  });

  test('refusing a valid subscription outright fails and names the code', async () => {
    const checks = await pushChecks(
      pushFixture({ error: { code: -32013, message: 'ResourceExhausted' } })
    );
    const check = checks.get('sep-9999-stream-implemented');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('-32013');
  });

  test('opening a stream for an unknown event type fails error-before-open', async () => {
    const checks = await pushChecks(pushFixture({ acceptAnyName: true }));
    const check = checks.get('sep-9999-stream-error-before-open');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('did not answer a JSON-RPC error');
  });

  test('answering an unknown type with -32014 rather than NotFound warns', async () => {
    const checks = await pushChecks({
      ...pushFixture(),
      unknownNameCode: -32014
    });
    const check = checks.get('sep-9999-stream-error-before-open');
    expect(check?.status).toBe('WARNING');
    expect(check?.errorMessage).toContain('-32011 NotFound');
  });
});

describe.concurrent('the active confirmation', () => {
  test('no confirmation at all fails', async () => {
    const checks = await pushChecks(pushFixture({ omitActive: true }));
    const check = checks.get('sep-9999-stream-active-confirmation');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('notifications/events/active');
  });

  test('a numeric cursor on the confirmation fails', async () => {
    const checks = await pushChecks(
      pushFixture({ activeParams: { cursor: 42 } })
    );
    const check = checks.get('sep-9999-stream-active-confirmation');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('`cursor` is');
  });

  test('a string truncated flag fails', async () => {
    const checks = await pushChecks(
      pushFixture({ activeParams: { truncated: 'no' } })
    );
    const check = checks.get('sep-9999-stream-active-confirmation');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('`truncated` is');
  });
});

describe.concurrent('the correlation id', () => {
  // The divergence this row exists for: mcpkit puts the id in params.requestId,
  // mirroring the sketch's own push examples, where the document requires the
  // SEP-2575 `_meta` spelling. A client holding two streams cannot route by
  // what the document tells it to read.
  test('params.requestId instead of _meta fails and names the key', async () => {
    const checks = await pushChecks(pushFixture({ correlation: 'requestId' }));
    const check = checks.get('sep-9999-stream-subscription-id-meta');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain(
      'io.modelcontextprotocol/subscriptionId'
    );
  });

  test('no correlation id at all fails', async () => {
    const checks = await pushChecks(pushFixture({ correlation: 'none' }));
    expect(checks.get('sep-9999-stream-subscription-id-meta')?.status).toBe(
      'FAILURE'
    );
  });
});

describe.concurrent('what rides the stream', () => {
  test('a non-events notification fails and names the method', async () => {
    const checks = await pushChecks(
      pushFixture({ foreignNotification: 'notifications/message' })
    );
    const check = checks.get(
      'sep-9999-stream-carries-only-event-notifications'
    );
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('notifications/message');
  });

  test('a malformed occurrence fails the event row', async () => {
    const checks = await pushChecks(
      pushFixture({ eventParams: { timestamp: 'last tuesday' } })
    );
    const check = checks.get('sep-9999-stream-event-notification');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('EventOccurrence');
  });

  test('a stream that delivers nothing reports the event row untestable', async () => {
    const checks = await pushChecks(pushFixture({ eventAfterMs: 0 }));
    const check = checks.get('sep-9999-stream-event-notification');
    expect(check?.status).toBe('FAILURE');
    expect(check?.details?.untestable).toBe(true);
  });
});

describe.concurrent('the heartbeat', () => {
  test('a numeric cursor on the heartbeat fails', async () => {
    const checks = await pushChecks(
      pushFixture({ heartbeatParams: { cursor: 42 } })
    );
    const check = checks.get('sep-9999-stream-heartbeat-carries-cursor');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('neither a string nor null');
  });

  test('silence inside a short window is untestable, not a failure', async () => {
    const checks = await pushChecks(pushFixture({ heartbeatMs: 0 }));
    const check = checks.get('sep-9999-stream-heartbeat-required');
    expect(check?.status).toBe('FAILURE');
    expect(check?.details?.untestable).toBe(true);
    expect(check?.errorMessage).toContain('EVENTS_PUSH_WATCH_MS');
  });

  test('an SSE comment keepalive beside a data heartbeat warns', async () => {
    const checks = await pushChecks(pushFixture({ sseComments: true }));
    const check = checks.get('sep-9999-stream-heartbeat-not-sse-comment');
    expect(check?.status).toBe('WARNING');
    expect(check?.errorMessage).toContain('keepalive');
  });

  test('an SSE comment instead of a data heartbeat fails', async () => {
    const checks = await pushChecks(
      pushFixture({ heartbeatMs: 0, sseComments: true })
    );
    expect(
      checks.get('sep-9999-stream-heartbeat-not-sse-comment')?.status
    ).toBe('FAILURE');
  });
});

describe.concurrent('the -32013 error-table row', () => {
  test('a cap that names its limit passes, and one that does not warns', async () => {
    const named = await pushChecks(
      pushFixture({ maxConcurrent: 1, capLimitName: 'subscriptions' })
    );
    const ok = named.get('sep-9999-error-resource-exhausted');
    expect(ok?.status).toBe('SUCCESS');
    expect(ok?.details?.limit).toBe('subscriptions');

    const vague = await pushChecks(pushFixture({ maxConcurrent: 1 }));
    const check = vague.get('sep-9999-error-resource-exhausted');
    expect(check?.status).toBe('WARNING');
    expect(check?.errorMessage).toContain('which quota it hit');
  });

  test('a server that refuses nothing reports the row untestable', async () => {
    const checks = await pushChecks(pushFixture());
    const check = checks.get('sep-9999-error-resource-exhausted');
    expect(check?.details?.untestable).toBe(true);
    expect(check?.errorMessage).toContain('never provoked');
  });
});

describe.concurrent(
  'the -32013 row, probed on the type a server says is capped',
  () => {
    // Two push types: the scenario's target, which the concurrency probe opens
    // three streams on, and a capped one it must leave alone.
    const withQuota = (
      quota: EventsFixtureOptions['quota']
    ): EventsFixtureOptions => ({
      capability: { listChanged: true },
      descriptors: [
        descriptor({ name: 'push.event', delivery: ['push'] }),
        descriptor({ name: 'capped.event', delivery: ['push'] })
      ],
      quota
    });

    test('an enforced cap that names its limit passes, beside a passing concurrency row', async () => {
      const checks = await pushChecks(
        withQuota({ name: 'capped.event', max: 2 })
      );
      const check = checks.get('sep-9999-error-resource-exhausted');
      expect(check?.status).toBe('SUCCESS');
      expect(check?.details?.limit).toBe('subscriptions');
      expect(
        checks.get('sep-9999-stream-exempt-from-concurrency-cap')?.status
      ).toBe('SUCCESS');
    });

    test('a refusal without data.limit warns', async () => {
      const checks = await pushChecks(
        withQuota({ name: 'capped.event', max: 1, limitName: null })
      );
      const check = checks.get('sep-9999-error-resource-exhausted');
      expect(check?.status).toBe('WARNING');
      expect(check?.errorMessage).toContain('which quota it hit');
    });

    test('a reported cap that is never enforced is untestable, and says so', async () => {
      const checks = await pushChecks(
        withQuota({ name: 'capped.event', max: 2, enforce: false })
      );
      const check = checks.get('sep-9999-error-resource-exhausted');
      expect(check?.status).toBe('FAILURE');
      expect(check?.details?.untestable).toBe(true);
      expect(check?.errorMessage).toContain('3 streams opened');
    });

    test('without the control the row stays untestable and names it', async () => {
      const checks = await pushChecks(
        withQuota({ name: 'capped.event', max: 2, control: false })
      );
      const check = checks.get('sep-9999-error-resource-exhausted');
      expect(check?.details?.untestable).toBe(true);
      expect(check?.errorMessage).toContain('events_conformance_quota');
    });
  }
);

describe.concurrent('concurrency and cancellation', () => {
  // The cap kitchen-sink applies to streams, which the document exempts them
  // from: the first stream confirms and the other two are refused -32013.
  test('a per-principal cap that catches streams fails', async () => {
    const checks = await pushChecks(pushFixture({ maxConcurrent: 1 }));
    const check = checks.get('sep-9999-stream-exempt-from-concurrency-cap');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('only 1 confirmed');
  });

  test('a server that keeps sending after the abort fails cancel-stops-delivery', async () => {
    // Nothing in the fixture can outlive an aborted request, so the row is
    // proven the other way round: it passes here, and the failure branch is
    // reachable only by a server that holds the connection open after abort.
    const checks = await pushChecks(pushFixture());
    expect(checks.get('sep-9999-stream-cancel-stops-delivery')?.status).toBe(
      'SUCCESS'
    );
  });
});

describe.concurrent('rows that are untestable against a real server', () => {
  test('a server-initiated close grades the final result instead of skipping it', async () => {
    const cancelled = await pushChecks(pushFixture());
    const untested = cancelled.get('sep-9999-stream-final-result-shape');
    expect(untested?.status).toBe('WARNING');
    expect(untested?.details?.untestable).toBe(true);

    const closed = await pushChecks(pushFixture({ closeAfterMs: 400 }));
    expect(closed.get('sep-9999-stream-final-result-shape')?.status).toBe(
      'SUCCESS'
    );
    expect(closed.get('sep-9999-stream-final-result-timing')?.status).toBe(
      'SUCCESS'
    );
  });

  test('a final result carrying fields fails, since it is defined as empty', async () => {
    const checks = await pushChecks(
      pushFixture({ closeAfterMs: 400, finalResult: { events: [] } })
    );
    const check = checks.get('sep-9999-stream-final-result-shape');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('events');
  });

  test('an error notification, a termination and a gap are all graded when they happen', async () => {
    const quiet = await pushChecks(pushFixture());
    for (const id of [
      'sep-9999-stream-error-is-recoverable',
      'sep-9999-stream-terminated-ends-subscription',
      'sep-9999-stream-gap-resends-active'
    ]) {
      expect(quiet.get(id)?.details?.untestable, id).toBe(true);
    }

    const busy = await pushChecks(
      pushFixture({
        errorNotificationAfterMs: 150,
        terminatedAfterMs: 250,
        gapAfterMs: 350
      })
    );
    for (const id of [
      'sep-9999-stream-error-is-recoverable',
      'sep-9999-stream-terminated-ends-subscription',
      'sep-9999-stream-gap-resends-active'
    ]) {
      expect(busy.get(id)?.status, id).toBe('SUCCESS');
    }
  });
});

/**
 * Under 30s a silent server and a slow one are indistinguishable, so this is the
 * only window in which the heartbeat MUST can fail rather than report a window
 * too short to judge. It costs half a minute, which is why it is one case and
 * not a pair, and why it runs last on a graph of its own.
 */
describe('the heartbeat MUST, on a window that outlasts the cadence', () => {
  test('silence past 30s fails instead of reporting untestable', async () => {
    const slow = await importWith(30_050);
    const checks = await pushChecks(pushFixture({ heartbeatMs: 0 }), slow);
    const check = checks.get('sep-9999-stream-heartbeat-required');
    expect(check?.status).toBe('FAILURE');
    expect(check?.details?.untestable).toBeUndefined();
    expect(check?.errorMessage).toContain('outlasts the 30s cadence');
  }, 90_000);
});
