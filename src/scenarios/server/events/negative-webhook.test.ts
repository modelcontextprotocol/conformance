import { describe, test, expect } from 'vitest';
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

const ALL_ROWS = 27;

/** Rows every conformant run passes, which is the whole surface bar the seven
 * that need a second principal or a restart. */
const GRADEABLE = [
  'sep-9999-subscribe-webhook-only',
  'sep-9999-subscribe-secret-required',
  'sep-9999-subscribe-secret-format',
  'sep-9999-subscribe-secret-rejected',
  'sep-9999-subscribe-url-https-required',
  'sep-9999-subscribe-url-non-https-rejected',
  'sep-9999-subscribe-key-composition',
  'sep-9999-subscribe-key-immutable',
  'sep-9999-subscribe-idempotent-upsert',
  'sep-9999-subscribe-id-derived',
  'sep-9999-subscribe-id-not-an-input',
  'sep-9999-subscribe-response-cursor',
  'sep-9999-subscribe-response-truncated',
  'sep-9999-ttl-omitted-means-default',
  'sep-9999-ttl-null-only-when-requested',
  'sep-9999-ttl-refresh-before-lte-suggestion',
  'sep-9999-ttl-no-rejection-path',
  'sep-9999-unsubscribe-by-key',
  'sep-9999-unsubscribe-unknown-not-found',
  'sep-9999-error-unsupported'
] as const;

/** Rows no single-principal, single-process run can exercise. */
const ALWAYS_UNTESTABLE = [
  'sep-9999-subscribe-auth-required',
  'sep-9999-subscribe-cross-tenant-isolation',
  'sep-9999-subscribe-refresh-replaces-secret',
  'sep-9999-subscribe-refresh-reactivates',
  'sep-9999-ttl-long-grant-retained',
  'sep-9999-ttl-no-expiry-persisted',
  'sep-9999-ttl-no-expiry-gc-terminated'
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
 * decoration: `sep-9999-error-unsupported` needs a type whose `delivery` omits
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
  // scenario that held every probe open would grade -32013 instead of the rule
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
    const check = checks.get('sep-9999-subscribe-key-composition');
    expect(check?.details?.untestable).toBe(true);
    expect(check?.errorMessage).toContain('-32013');
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
    const check = checks.get('sep-9999-subscribe-webhook-only');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('advertises `webhook` delivery');
  });

  test('a refused subscribe warns and takes the rest with it as untestable', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ error: { code: -32012, message: 'Forbidden' } })
    );
    expect(checks.get('sep-9999-subscribe-webhook-only')?.status).toBe(
      'WARNING'
    );
    expect(checks.get('sep-9999-unsubscribe-by-key')?.details?.untestable).toBe(
      true
    );
  });
});

describe('the delivery secret', () => {
  test('accepting a subscribe with no secret fails', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ acceptMissingSecret: true })
    );
    const check = checks.get('sep-9999-subscribe-secret-required');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('-32602 InvalidParams');
  });

  test('accepting a secret without the whsec_ prefix fails', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ acceptBadPrefix: true })
    );
    expect(checks.get('sep-9999-subscribe-secret-format')?.status).toBe(
      'FAILURE'
    );
  });

  test('accepting a secret under the 24-byte floor fails', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ acceptShortSecret: true })
    );
    const check = checks.get('sep-9999-subscribe-secret-rejected');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('accepted');
  });

  test('rejecting with the wrong code warns and names -32602', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ rejectionCode: -32602 + 1 })
    );
    const check = checks.get('sep-9999-subscribe-secret-required');
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
    const rejected = checks.get('sep-9999-subscribe-url-non-https-rejected');
    expect(rejected?.status).toBe('FAILURE');
    expect(rejected?.errorMessage).toContain('`http://`');
    // The requirement and its enforcement are one probe by design, so the
    // second row carries the first's verdict rather than a second probe's.
    const required = checks.get('sep-9999-subscribe-url-https-required');
    expect(required?.status).toBe('FAILURE');
    expect(required?.details?.gradedBy).toBe(
      'sep-9999-subscribe-url-non-https-rejected'
    );
  });
});

describe('TTL negotiation', () => {
  test('no-expiry granted against a finite suggestion fails', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ nullRefreshAlways: true })
    );
    const check = checks.get('sep-9999-ttl-null-only-when-requested');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('no expiry');
    // With no finite grant there is nothing to compare to the suggestion.
    expect(
      checks.get('sep-9999-ttl-refresh-before-lte-suggestion')?.details
        ?.untestable
    ).toBe(true);
  });

  test('no-expiry for an omitted ttlMs fails the default rule', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ nullRefreshOnOmitted: true })
    );
    const check = checks.get('sep-9999-ttl-omitted-means-default');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('explicit `ttlMs: null`');
  });

  test('granting past the suggestion warns', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ grantBeyondSuggestion: true })
    );
    const check = checks.get('sep-9999-ttl-refresh-before-lte-suggestion');
    expect(check?.status).toBe('WARNING');
    expect(check?.errorMessage).toContain('past the suggested');
  });

  test('a refreshBefore that is not a timestamp fails', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ refreshBefore: 'next tuesday' })
    );
    const check = checks.get('sep-9999-ttl-refresh-before-lte-suggestion');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('ISO 8601');
  });

  test('rejecting a ttlMs instead of clamping it fails, and names which', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ rejectTtl: 'long' })
    );
    const check = checks.get('sep-9999-ttl-no-rejection-path');
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
    const check = checks.get('sep-9999-subscribe-idempotent-upsert');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('created a second subscription');
  });

  test('an id that ignores delivery.url fails composition and immutability', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ idIgnoresUrl: true })
    );
    const composition = checks.get('sep-9999-subscribe-key-composition');
    expect(composition?.status).toBe('FAILURE');
    expect(composition?.errorMessage).toContain('not part of the key');
    // Same probe, so the immutability row moves with it.
    expect(checks.get('sep-9999-subscribe-key-immutable')?.status).toBe(
      'FAILURE'
    );
  });

  test('honouring a caller-supplied id fails id-not-an-input', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ idIsAnInput: true })
    );
    const check = checks.get('sep-9999-subscribe-id-not-an-input');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('addressed the subscription');
  });

  test('omitting id fails its own row, and costs the comparison rows too', async () => {
    const { checks } = await webhookChecks(webhookFixture({ omitId: true }));
    const check = checks.get('sep-9999-subscribe-id-derived');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('expected a string');
    // Not an independent defect: with no id there is nothing to compare, so
    // the key rows fail alongside it rather than reporting green.
    expect(checks.get('sep-9999-subscribe-key-composition')?.status).toBe(
      'FAILURE'
    );
  });

  test('a numeric cursor on the subscribe response fails', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ result: { cursor: 42 } })
    );
    expect(checks.get('sep-9999-subscribe-response-cursor')?.status).toBe(
      'FAILURE'
    );
  });

  test('a string truncated on the subscribe response fails', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ result: { truncated: 'no' } })
    );
    expect(checks.get('sep-9999-subscribe-response-truncated')?.status).toBe(
      'FAILURE'
    );
  });
});

describe('unsubscribe', () => {
  test('refusing to tear down a key the server holds fails', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ unsubscribeHeldCode: -32603 })
    );
    const check = checks.get('sep-9999-unsubscribe-by-key');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('-32603');
    // The unknown-key rule is a separate probe and still passes.
    expect(checks.get('sep-9999-unsubscribe-unknown-not-found')?.status).toBe(
      'SUCCESS'
    );
  });

  // The divergence this row exists for: kitchen-sink answers success for a key
  // it never held, so a client cannot tell teardown from a typo.
  test('success for a key never held fails and says why it matters', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ unsubscribeUnknownOk: true })
    );
    const check = checks.get('sep-9999-unsubscribe-unknown-not-found');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('typo');
  });

  test('the wrong code for an unknown key warns and names -32011', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ unsubscribeUnknownCode: -32602 })
    );
    const check = checks.get('sep-9999-unsubscribe-unknown-not-found');
    expect(check?.status).toBe('WARNING');
    expect(check?.errorMessage).toContain('-32011 NotFound');
  });
});

describe('the unsupported delivery mode', () => {
  test('subscribing a poll-only type fails the unsupported row', async () => {
    const { checks } = await webhookChecks(
      webhookFixture({ acceptNonWebhookType: true })
    );
    const check = checks.get('sep-9999-error-unsupported');
    expect(check?.status).toBe('FAILURE');
    expect(check?.errorMessage).toContain('does not advertise');
  });

  test('a catalog where every type offers webhook reports it untestable', async () => {
    const { checks } = await webhookChecks({
      capability: { listChanged: true },
      descriptors: [descriptor({ name: 'hook.event', delivery: ['webhook'] })]
    });
    const check = checks.get('sep-9999-error-unsupported');
    expect(check?.details?.untestable).toBe(true);
    expect(check?.errorMessage).toContain('no type to probe');
  });
});
