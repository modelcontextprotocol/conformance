import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { testContext } from '../../../connection/testing';
import { DRAFT_PROTOCOL_VERSION } from '../../../types';
import { takeWireViolations } from '../../../validation/wire-schema';
import { EventsWebhookScenario } from './webhook';
import {
  descriptor,
  startEventsFixture,
  type EventsFixtureOptions,
  type SubscribeBehaviour
} from './negative-fixture';

/**
 * Negative controls for `events-webhook`.
 *
 * Each case pairs the conformant fixture with one broken in exactly one way.
 * Where a single defect costs more than one row, the test says so rather than
 * pretending the rows are independent: a server that returns no `id` at all
 * takes the key-composition rows down with it, because there is nothing left to
 * compare.
 *
 * Two of these are divergences the suite found in a real implementation, and
 * both are here so a red run can be trusted: an `http://` callback accepted at
 * subscribe, and an unsubscribe of a key the server never held answering
 * success.
 */

const ALL_ROWS = 30;

// The durability rows poll for a restart and for a GC drop; the defaults are
// sized for a real server and would make this file crawl.
beforeAll(() => {
  vi.stubEnv('EVENTS_RESTART_WAIT_MS', '1500');
  vi.stubEnv('EVENTS_GC_WAIT_MS', '2000');
});
afterAll(() => {
  vi.unstubAllEnvs();
});

/** Rows every conformant run passes, which is the whole surface bar the five
 * that need a second principal or a restart. */
const GRADEABLE = [
  'sep-3415-result-type-complete',
  'sep-3415-mcp-name-missing-rejected',
  'sep-3415-mcp-name-mismatch-rejected',
  'sep-3415-subscribe-webhook-only',
  'sep-3415-subscribe-secret-required',
  'sep-3415-subscribe-secret-format',
  'sep-3415-subscribe-secret-rejected',
  'sep-3415-subscribe-url-https-required',
  'sep-3415-subscribe-url-non-https-rejected',
  'sep-3415-subscribe-key-composition',
  'sep-3415-subscribe-key-immutable',
  'sep-3415-subscribe-idempotent-upsert',
  'sep-3415-subscribe-id-derived',
  'sep-3415-subscribe-id-not-an-input',
  'sep-3415-subscribe-response-cursor',
  'sep-3415-subscribe-response-truncated',
  'sep-3415-subscribe-refresh-before-present',
  'sep-3415-ttl-omitted-means-default',
  'sep-3415-ttl-null-only-when-requested',
  'sep-3415-ttl-refresh-before-lte-suggestion',
  'sep-3415-ttl-no-rejection-path',
  'sep-3415-unsubscribe-by-key',
  'sep-3415-unsubscribe-empty-result',
  'sep-3415-unsubscribe-unknown-not-found',
  'sep-3415-error-unsupported'
] as const;

/** Rows no single-principal, single-process run can exercise. */
const ALWAYS_UNTESTABLE = [
  'sep-3415-subscribe-cross-tenant-isolation',
  'sep-3415-subscribe-refresh-reactivates',
  'sep-3415-ttl-long-grant-retained',
  'sep-3415-ttl-no-expiry-persisted',
  'sep-3415-ttl-no-expiry-gc-terminated'
] as const;

async function webhookChecks(opts: EventsFixtureOptions) {
  const fixture = await startEventsFixture(opts);
  try {
    const checks = await new EventsWebhookScenario().run(
      testContext(fixture.url, DRAFT_PROTOCOL_VERSION)
    );
    // Drained so an intentionally malformed response does not trip the global
    // vitest hook; these tests assert on the check, not the wire validator.
    takeWireViolations();
    return {
      checks: new Map(checks.map((c) => [c.id, c])),
      /** What the fixture still holds, which is how cleanup is graded. */
      leaked: fixture.liveSubscriptions()
    };
  } finally {
    await fixture.close();
  }
}

/**
 * A catalog with one webhook type and one that only polls. The second is not
 * decoration: `sep-3415-error-unsupported` needs a type whose `delivery` omits
 * webhook, and without one it reports untestable.
 */
function webhookFixture(
  subscribe: SubscribeBehaviour = {}
): EventsFixtureOptions {
  return {
    capability: { listChanged: true },
    descriptors: [
      descriptor({ name: 'hook.event', delivery: ['webhook'] }),
      descriptor({ name: 'poll.only', delivery: ['poll'] })
    ],
    subscribe
  };
}

describe('the conformant baseline', () => {
  test('every gradeable row passes and the untestable ones never read green', async () => {
    const { checks, leaked } = await webhookChecks(webhookFixture());
    expect(checks.size).toBe(ALL_ROWS);
    for (const id of GRADEABLE) {
      expect(checks.get(id)?.status, id).toBe('SUCCESS');
    }
    for (const id of ALWAYS_UNTESTABLE) {
      expect(checks.get(id)?.details?.untestable, id).toBe(true);
      expect(checks.get(id)?.status, id).not.toBe('SKIPPED');
    }
    // The scenario promises to leave nothing behind, including on a public
    // server. This is the only place that promise is actually checked.
    expect(leaked).toEqual([]);
  });

  // kitchen-sink allows two subscriptions per principal per event type, and a
  // scenario that held every probe open would grade -32025 instead of the rule
  // it was probing. The release-as-you-go discipline is what prevents that, and
  // this is the regression test for it.
  test('a two-subscription cap changes nothing, because probes are released', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ maxSubscriptions: 2 })
    );
    for (const id of GRADEABLE) {
      expect(checks.get(id)?.status, id).toBe('SUCCESS');
    }
  });

  test('a cap of one reports the rows it starves as untestable, not passed', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ maxSubscriptions: 1 })
    );
    const check = checks.get('sep-3415-subscribe-key-composition');
    expect(check?.details?.untestable).toBe(true);
    expect(check?.errorMessage).toContain('-32025');
  });

  test('a server with no webhook-capable type reports every row untestable', async () => {
    const { checks } = await webhookChecks({
      capability: { listChanged: true },
      descriptors: [descriptor()]
    });
    expect(checks.size).toBe(ALL_ROWS);
    for (const check of checks.values()) {
      expect(check.details?.untestable, check.id).toBe(true);
    }
  });

  test('a server that declares nothing and serves nothing skips the suite', async () => {
    const { checks } = await webhookChecks({
      listError: { code: -32601, message: 'Method not found' }
    });
    for (const check of checks.values()) {
      expect(check.status).toBe('SKIPPED');
    }
  });

  test('an unimplemented events/subscribe fails rather than warns', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({
        error: { code: -32601, message: 'Method not found' }
      })
    );
    const check = checks.get('sep-3415-subscribe-webhook-only');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('advertises `webhook` delivery');
  });

  test('a refused subscribe warns and takes the rest with it as untestable', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ error: { code: -32024, message: 'Forbidden' } })
    );
    expect(checks.get('sep-3415-subscribe-webhook-only')?.status).toBe(
      'WARNING'
    );
    expect(checks.get('sep-3415-unsubscribe-by-key')?.details?.untestable).toBe(
      true
    );
  });
});

describe('the delivery secret', () => {
  test('accepting a subscribe with no secret fails', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ acceptMissingSecret: true })
    );
    const check = checks.get('sep-3415-subscribe-secret-required');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('-32602 InvalidParams');
  });

  test('accepting a secret without the whsec_ prefix fails', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ acceptBadPrefix: true })
    );
    expect(checks.get('sep-3415-subscribe-secret-format')?.status).toBe(
      'FAILURE'
    );
  });

  test('accepting a secret under the 24-byte floor fails', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ acceptShortSecret: true })
    );
    const check = checks.get('sep-3415-subscribe-secret-rejected');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('accepted');
  });

  test('rejecting with the wrong code warns and names -32602', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ rejectionCode: -32602 + 1 })
    );
    const check = checks.get('sep-3415-subscribe-secret-required');
    expect(check?.status).toBe('WARNING');
    expect(check?.errorMessage).toContain('-32602 InvalidParams');
  });
});

describe('the callback URL', () => {
  // The divergence this row exists for: kitchen-sink accepts `http://` at
  // subscribe, deliberately, for demo ergonomics.
  test('accepting an http:// callback fails both URL rows off one probe', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ acceptHttpUrl: true })
    );
    const rejected = checks.get('sep-3415-subscribe-url-non-https-rejected');
    expect(rejected?.status).toBe('FAILURE');
    expect(rejected?.errorMessage).toContain('`http://`');
    // The requirement and its enforcement are one probe by design, so the
    // second row carries the first's verdict rather than a second probe's.
    const required = checks.get('sep-3415-subscribe-url-https-required');
    expect(required?.status).toBe('FAILURE');
    expect(required?.details?.gradedBy).toBe(
      'sep-3415-subscribe-url-non-https-rejected'
    );
  });
});

describe('TTL negotiation', () => {
  test('no-expiry granted against a finite suggestion fails', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ nullRefreshAlways: true })
    );
    const check = checks.get('sep-3415-ttl-null-only-when-requested');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('no expiry');
    // With no finite grant there is nothing to compare to the suggestion.
    expect(
      checks.get('sep-3415-ttl-refresh-before-lte-suggestion')?.details
        ?.untestable
    ).toBe(true);
  });

  test('no-expiry for an omitted ttlMs fails the default rule', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ nullRefreshOnOmitted: true })
    );
    const check = checks.get('sep-3415-ttl-omitted-means-default');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('explicit `ttlMs: null`');
  });

  test('granting past the suggestion warns', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ grantBeyondSuggestion: true })
    );
    const check = checks.get('sep-3415-ttl-refresh-before-lte-suggestion');
    expect(check?.status).toBe('WARNING');
    expect(check?.errorMessage).toContain('past the suggested');
  });

  test('a refreshBefore that is not a timestamp fails', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ refreshBefore: 'next tuesday' })
    );
    const check = checks.get('sep-3415-ttl-refresh-before-lte-suggestion');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('ISO 8601');
  });

  test('rejecting a ttlMs instead of clamping it fails, and names which', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ rejectTtl: 'long' })
    );
    const check = checks.get('sep-3415-ttl-no-rejection-path');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('30 days');
    expect(check?.errorMessage).not.toContain('1000ms');
  });
});

describe('the subscription key and its id', () => {
  test('a fresh id per call fails the idempotent upsert', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ nonIdempotentId: true })
    );
    const check = checks.get('sep-3415-subscribe-idempotent-upsert');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('created a second subscription');
  });

  test('an id that ignores delivery.url fails composition and immutability', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ idIgnoresUrl: true })
    );
    const composition = checks.get('sep-3415-subscribe-key-composition');
    expect(composition?.status).toBe('FAILURE');
    expect(composition?.errorMessage).toContain('not part of the key');
    // Same probe, so the immutability row moves with it.
    expect(checks.get('sep-3415-subscribe-key-immutable')?.status).toBe(
      'FAILURE'
    );
  });

  test('honouring a caller-supplied id fails id-not-an-input', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ idIsAnInput: true })
    );
    const check = checks.get('sep-3415-subscribe-id-not-an-input');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('addressed the subscription');
  });

  test('omitting id fails its own row, and costs the comparison rows too', async () => {
    const { checks } = await webhookChecks(webhookFixture({ omitId: true }));
    const check = checks.get('sep-3415-subscribe-id-derived');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('expected a string');
    // Not an independent defect: with no id there is nothing to compare, so
    // the key rows fail alongside it rather than reporting green.
    expect(checks.get('sep-3415-subscribe-key-composition')?.status).toBe(
      'FAILURE'
    );
  });

  test('a numeric cursor on the subscribe response fails', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ result: { cursor: 42 } })
    );
    expect(checks.get('sep-3415-subscribe-response-cursor')?.status).toBe(
      'FAILURE'
    );
  });

  test('a subscribe response with no refreshBefore fails its own row', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ omitRefreshBefore: true })
    );
    const check = checks.get('sep-3415-subscribe-refresh-before-present');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('no `refreshBefore` member');
    // The grant row fails too: an absent grant is not a timestamp. Nothing else
    // moves.
    const failed = GRADEABLE.filter(
      (id) => checks.get(id)?.status !== 'SUCCESS'
    );
    expect(failed.sort()).toEqual([
      'sep-3415-subscribe-refresh-before-present',
      'sep-3415-ttl-refresh-before-lte-suggestion'
    ]);
    // An explicit null is a grant, not an omission.
    const nulled = await webhookChecks(
      webhookFixture({ nullRefreshAlways: true })
    );
    expect(
      nulled.checks.get('sep-3415-subscribe-refresh-before-present')?.status
    ).toBe('SUCCESS');
  });

  test('a string truncated on the subscribe response fails', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ result: { truncated: 'no' } })
    );
    expect(checks.get('sep-3415-subscribe-response-truncated')?.status).toBe(
      'FAILURE'
    );
  });
});

describe('unsubscribe', () => {
  test('refusing to tear down a key the server holds fails', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ unsubscribeHeldCode: -32603 })
    );
    const check = checks.get('sep-3415-unsubscribe-by-key');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('-32603');
    // The unknown-key rule is a separate probe and still passes.
    expect(checks.get('sep-3415-unsubscribe-unknown-not-found')?.status).toBe(
      'SUCCESS'
    );
  });

  // The divergence this row exists for: kitchen-sink answers success for a key
  // it never held, so a client cannot tell teardown from a typo.
  test('success for a key never held fails and says why it matters', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ unsubscribeUnknownOk: true })
    );
    const check = checks.get('sep-3415-unsubscribe-unknown-not-found');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('typo');
  });

  test('an unsubscribe result with a stray member fails its own row', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ unsubscribeResult: { removed: true } })
    );
    const check = checks.get('sep-3415-unsubscribe-empty-result');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('`removed`');
    expect(
      GRADEABLE.filter((id) => checks.get(id)?.status !== 'SUCCESS')
    ).toEqual(['sep-3415-unsubscribe-empty-result']);
    // resultType and _meta are allowed on an empty Result.
    const meta = await webhookChecks(
      webhookFixture({
        unsubscribeResult: { resultType: 'complete', _meta: { x: 1 } }
      })
    );
    expect(meta.checks.get('sep-3415-unsubscribe-empty-result')?.status).toBe(
      'SUCCESS'
    );
  });

  test('the wrong code for an unknown key warns and names -32023', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ unsubscribeUnknownCode: -32602 })
    );
    const check = checks.get('sep-3415-unsubscribe-unknown-not-found');
    expect(check?.status).toBe('WARNING');
    expect(check?.errorMessage).toContain('-32023 NotFound');
  });
});

describe('two tenants', () => {
  const ROW = 'sep-3415-subscribe-cross-tenant-isolation';

  test('distinct, independent subscriptions pass', async () => {
    const { checks } = await webhookChecks({
      ...webhookFixture(),
      tenants: {}
    });
    expect(checks.get(ROW)?.status).toBe('SUCCESS');
  });

  test('a key without the principal fails on the shared id', async () => {
    const { checks } = await webhookChecks({
      ...webhookFixture(),
      tenants: { keyIgnoresPrincipal: true }
    });
    expect(checks.get(ROW)?.status).toBe('FAILURE');
    expect(checks.get(ROW)?.errorMessage).toContain('same subscription id');
  });

  // The defect the row exists for, and the one it could not see while it
  // cleaned up by id: a conformant server refuses `id` as input, so nothing
  // was removed and the other tenant always "survived".
  test('an unsubscribe that removes the other tenant too fails', async () => {
    const { checks } = await webhookChecks({
      ...webhookFixture(),
      tenants: { unsubscribeIgnoresPrincipal: true }
    });
    expect(checks.get(ROW)?.status).toBe('FAILURE');
    expect(checks.get(ROW)?.errorMessage).toContain('also removed');
  });

  test('an own unsubscribe that fails is untestable, not a pass', async () => {
    const { checks } = await webhookChecks({
      ...webhookFixture({ unsubscribeHeldCode: -32603 }),
      tenants: { unsubscribeIgnoresPrincipal: true }
    });
    expect(checks.get(ROW)?.details?.untestable).toBe(true);
  });
});

describe('SEP-3415 codes and resultType', () => {
  test('subscribe and unsubscribe without resultType fail only the resultType row', async () => {
    const { checks: ok } = await webhookChecks(webhookFixture());
    const { checks: bare } = await webhookChecks({
      ...webhookFixture(),
      omitResultType: true
    });
    const check = bare.get('sep-3415-result-type-complete');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('events/subscribe');
    for (const [id, c] of ok) {
      if (id === 'sep-3415-result-type-complete') continue;
      expect(bare.get(id)?.status, id).toBe(c.status);
    }
  });

  test("an unknown unsubscribe key answered with the sketch's -32011 is not NotFound", async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ unsubscribeUnknownCode: -32011 })
    );
    const check = checks.get('sep-3415-unsubscribe-unknown-not-found');
    expect(check?.status).not.toBe('SUCCESS');
    expect(check?.errorMessage).toContain('-32023 NotFound');
  });
});

describe('the unsupported delivery mode', () => {
  test('subscribing a poll-only type fails the unsupported row', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ acceptNonWebhookType: true })
    );
    const check = checks.get('sep-3415-error-unsupported');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('does not advertise');
  });

  test('a catalog where every type offers webhook reports it untestable', async () => {
    const { checks } = await webhookChecks({
      capability: { listChanged: true },
      descriptors: [descriptor({ name: 'hook.event', delivery: ['webhook'] })]
    });
    const check = checks.get('sep-3415-error-unsupported');
    expect(check?.details?.untestable).toBe(true);
    expect(check?.errorMessage).toContain('no type to probe');
  });
});

/**
 * The durability rows, through a fixture exposing the restart, generation
 * and subscription-state controls. The fixture is stateless, so a restart
 * leaves the connection working; the generation control is what tells the
 * scenario the restart happened.
 */
describe.concurrent('durability across a restart', () => {
  const durable = (
    durability: NonNullable<EventsFixtureOptions['durability']>
  ): EventsFixtureOptions => ({ ...webhookFixture(), durability });

  test('a store that keeps both grants and GCs the failing one passes all three', async () => {
    const { checks, leaked } = await webhookChecks(durable({ gcAfterMs: 300 }));
    for (const id of [
      'sep-3415-ttl-long-grant-retained',
      'sep-3415-ttl-no-expiry-persisted',
      'sep-3415-ttl-no-expiry-gc-terminated'
    ]) {
      expect(
        checks.get(id)?.status,
        `${id}: ${checks.get(id)?.errorMessage}`
      ).toBe('SUCCESS');
    }
    expect(leaked).toEqual([]);
  });

  test('losing the no-expiry subscription on restart fails the persisted row', async () => {
    const { checks } = await webhookChecks(
      durable({ dropNoExpiryOnRestart: true, gcAfterMs: 300 })
    );
    const check = checks.get('sep-3415-ttl-no-expiry-persisted');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('never refreshes');
    expect(check?.errorMessage).toContain('`absent`');
    const gc = checks.get('sep-3415-ttl-no-expiry-gc-terminated');
    expect(gc?.details?.untestable, gc?.errorMessage).toBe(true);
  });

  test('losing a long finite grant on restart fails the retained row', async () => {
    const { checks } = await webhookChecks(
      durable({ dropFiniteOnRestart: true })
    );
    expect(checks.get('sep-3415-ttl-long-grant-retained')?.status).toBe(
      'FAILURE'
    );
  });

  test('never dropping a failing no-expiry subscription is a WARNING, since dropping is a MAY', async () => {
    const { checks } = await webhookChecks(durable({}));
    const check = checks.get('sep-3415-ttl-no-expiry-gc-terminated');
    expect(check?.status).toBe('WARNING');
    expect(check?.errorMessage).toContain('MAY');
  });

  test('a restart control that changes nothing leaves the rows untestable', async () => {
    const { checks } = await webhookChecks(durable({ restartNoop: true }));
    const check = checks.get('sep-3415-ttl-no-expiry-persisted');
    expect(check?.details?.untestable).toBe(true);
    expect(check?.errorMessage).toContain('no evidence a restart happened');
  });
});

describe('the Mcp-Name routing header', () => {
  const MCP_NAME = [
    'sep-3415-mcp-name-missing-rejected',
    'sep-3415-mcp-name-mismatch-rejected'
  ];

  test('a server that ignores the header fails both rows on subscribe and unsubscribe, and nothing else', async () => {
    const ok = await webhookChecks(webhookFixture());
    const broken = await webhookChecks({
      ...webhookFixture(),
      mcpName: 'ignore'
    });
    const flipped = [...ok.checks.keys()].filter(
      (id) => ok.checks.get(id)?.status !== broken.checks.get(id)?.status
    );
    expect(flipped.sort()).toEqual([...MCP_NAME].sort());
    for (const id of MCP_NAME) {
      const msg = broken.checks.get(id)?.errorMessage;
      expect(msg, id).toContain('events/subscribe');
      expect(msg, id).toContain('events/unsubscribe');
    }
    expect(broken.leaked).toEqual([]);
  });
});
