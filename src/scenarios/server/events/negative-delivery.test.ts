import { describe, test, expect, vi, afterEach } from 'vitest';
import { DRAFT_PROTOCOL_VERSION } from '../../../types';
import {
  descriptor,
  startEventsFixture,
  type DeliveryBehaviour,
  type EventsFixtureOptions
} from './negative-fixture';

/**
 * Negative controls for `events-webhook-delivery`.
 *
 * This is the only scenario where the harness is the server's client *and* its
 * callback endpoint, so the fixture has to POST for real. It does: a
 * verification challenge, then a signed event, retried on 5xx and not retried
 * after 410 or 413.
 *
 * Two shapes of run matter and both are here. A fixture that accepts an
 * `http://` loopback callback delivers, which fails the two SSRF rows and makes
 * every other row gradeable — the state a demo fixture with its private-network
 * guard off is in. A fixture that refuses it passes the SSRF rows and reports
 * the delivery rows untestable, which is what a hardened server does and what
 * the second implementation the suite was run against actually did.
 *
 * Timings are stubbed down hard. `EVENTS_DELIVERY_WAIT_MS` bounds how long the
 * scenario waits for a first POST and `EVENTS_DELIVERY_SETTLE_MS` how long it
 * lets retries play out; at their defaults one run of this scenario is about
 * twenty seconds of mostly sleeping. As in the push controls, the run context
 * has to come from the same freshly-imported module graph as the scenario, or
 * `instanceof JsonRpcError` fails across two copies of the class.
 */

async function deliveryChecks(opts: EventsFixtureOptions) {
  vi.resetModules();
  vi.stubEnv('EVENTS_DELIVERY_WAIT_MS', '1500');
  // Comfortably over the fixture's 1.1s retry spacing, which is itself over a
  // second because `webhook-timestamp` is in whole seconds and two attempts
  // inside one second would share a stamp the fixture did freshen.
  vi.stubEnv('EVENTS_DELIVERY_SETTLE_MS', '2000');
  // Never inherit a real tunnel from the environment: these tests are about the
  // loopback receiver, which is also the SSRF probe.
  vi.stubEnv('EVENTS_WEBHOOK_CALLBACK_BASE', '');
  const { EventsWebhookDeliveryScenario } = await import('./webhook-delivery');
  const { testContext } = await import('../../../connection/testing');
  const { takeWireViolations } =
    await import('../../../validation/wire-schema');
  const fixture = await startEventsFixture(opts);
  try {
    const checks = await new EventsWebhookDeliveryScenario().run(
      testContext(fixture.url, DRAFT_PROTOCOL_VERSION)
    );
    takeWireViolations();
    return new Map(checks.map((c) => [c.id, c]));
  } finally {
    await fixture.close();
  }
}

/**
 * A server that delivers to the loopback receiver. `acceptHttpUrl` is not a
 * detail: the receiver is `http://127.0.0.1`, so a server that enforces https
 * never delivers at all, and the delivery rows are only reachable through a
 * fixture that has its guard off.
 */
function delivering(delivery: DeliveryBehaviour = {}): EventsFixtureOptions {
  return {
    capability: { listChanged: true },
    descriptors: [descriptor({ name: 'hook.event', delivery: ['webhook'] })],
    subscribe: { acceptHttpUrl: true },
    delivery
  };
}

const TIMEOUT = 40_000;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a server that delivers to loopback', () => {
  test(
    'every row but the SSRF pair grades, and the SSRF pair fails',
    async () => {
      const checks = await deliveryChecks(delivering());

      // Delivered to 127.0.0.1, which is the whole point of the probe.
      const validate = checks.get('sep-9999-ssrf-validate-callback-url');
      expect(validate?.status).toBe('FAILURE');
      expect(validate?.errorMessage).toContain('loopback');
      expect(checks.get('sep-9999-ssrf-reject-non-routable')?.status).toBe(
        'FAILURE'
      );

      for (const id of [
        'sep-9999-verification-required-before-delivery',
        'sep-9999-verification-challenge-echo',
        'sep-9999-delivery-post-json',
        'sep-9999-delivery-standard-webhooks-headers',
        'sep-9999-delivery-subscription-id-header',
        'sep-9999-delivery-signature-formula',
        'sep-9999-delivery-body-size',
        'sep-9999-delivery-410-non-retryable',
        'sep-9999-delivery-413-non-retryable',
        'sep-9999-delivery-retry-regenerates-signature',
        'sep-9999-delivery-retries-bounded',
        'sep-9999-envelope-type-discriminator',
        'sep-9999-envelope-signed-like-deliveries',
        'sep-9999-envelope-webhook-id-format',
        'sep-9999-ssrf-no-redirects'
      ]) {
        expect(checks.get(id)?.status, id).toBe('SUCCESS');
      }
    },
    TIMEOUT
  );

  // The shape a hardened server is in, and the shape the second implementation
  // the suite was run against was in.
  test(
    'refusing the loopback callback passes the SSRF rows and grades nothing else green',
    async () => {
      const checks = await deliveryChecks({
        capability: { listChanged: true },
        descriptors: [descriptor({ name: 'hook.event', delivery: ['webhook'] })]
      });
      expect(checks.get('sep-9999-ssrf-validate-callback-url')?.status).toBe(
        'SUCCESS'
      );
      expect(checks.get('sep-9999-ssrf-reject-non-routable')?.status).toBe(
        'SUCCESS'
      );
      const signature = checks.get('sep-9999-delivery-signature-formula');
      expect(signature?.details?.untestable).toBe(true);
      expect(signature?.errorMessage).toContain('EVENTS_WEBHOOK_CALLBACK_BASE');
    },
    TIMEOUT
  );

  test(
    'accepting the callback and then never delivering fails nothing it cannot see',
    async () => {
      // Subscribe accepted, nothing POSTed: the SSRF row says so rather than
      // claiming the server passed a check it was never put to.
      const checks = await deliveryChecks({
        capability: { listChanged: true },
        descriptors: [
          descriptor({ name: 'hook.event', delivery: ['webhook'] })
        ],
        subscribe: { acceptHttpUrl: true }
      });
      const validate = checks.get('sep-9999-ssrf-validate-callback-url');
      expect(validate?.status).toBe('WARNING');
      expect(validate?.errorMessage).toContain('nothing was delivered');
      expect(
        checks.get('sep-9999-ssrf-reject-non-routable')?.errorMessage
      ).toContain('delivery-time validation');
      expect(
        checks.get('sep-9999-delivery-post-json')?.details?.untestable
      ).toBe(true);
    },
    TIMEOUT
  );
});

describe('the verification handshake', () => {
  // The divergence this row exists for: kitchen-sink delivers with no handshake
  // at all, because the handshake does not exist yet.
  test(
    'delivering with no challenge fails, and says what it lets an attacker do',
    async () => {
      const checks = await deliveryChecks(delivering({ verify: false }));
      const check = checks.get(
        'sep-9999-verification-required-before-delivery'
      );
      expect(check?.status).toBe('FAILURE');
      expect(check?.errorMessage).toContain('third party');
      expect(
        checks.get('sep-9999-verification-challenge-echo')?.details?.untestable
      ).toBe(true);
    },
    TIMEOUT
  );

  test(
    'delivering an event before the challenge fails',
    async () => {
      const checks = await deliveryChecks(
        delivering({ eventBeforeVerification: true })
      );
      const check = checks.get(
        'sep-9999-verification-required-before-delivery'
      );
      expect(check?.status).toBe('FAILURE');
      expect(check?.errorMessage).toContain('before the verification');
    },
    TIMEOUT
  );
});

describe('signing', () => {
  // The divergence this row exists for: kitchen-sink keys the HMAC on the
  // literal `whsec_…` string, where the document says the key is the
  // base64-decoded bytes after the prefix. No Standard Webhooks receiver
  // verifies those signatures.
  test(
    'keying the HMAC on the literal whsec_ string fails',
    async () => {
      const checks = await deliveryChecks(
        delivering({ literalKeySignature: true })
      );
      const check = checks.get('sep-9999-delivery-signature-formula');
      expect(check?.status).toBe('FAILURE');
      expect(check?.errorMessage).toContain('did not verify over the raw body');
      // Freshness is graded separately, so a wrong formula must not be
      // reported as reusing timestamps it plainly did freshen.
      expect(
        checks.get('sep-9999-delivery-retry-regenerates-signature')?.status
      ).toBe('SUCCESS');
    },
    TIMEOUT
  );

  test(
    'omitting webhook-signature fails the header row and un-grades the formula',
    async () => {
      const checks = await deliveryChecks(
        delivering({ omitHeaders: ['webhook-signature'] })
      );
      const headers = checks.get('sep-9999-delivery-standard-webhooks-headers');
      expect(headers?.status).toBe('FAILURE');
      expect(headers?.errorMessage).toContain('webhook-signature');
      expect(
        checks.get('sep-9999-delivery-signature-formula')?.details?.untestable
      ).toBe(true);
    },
    TIMEOUT
  );

  test(
    'omitting the subscription id header fails, and says why it matters',
    async () => {
      const checks = await deliveryChecks(
        delivering({ omitSubscriptionIdHeader: true })
      );
      const check = checks.get('sep-9999-delivery-subscription-id-header');
      expect(check?.status).toBe('FAILURE');
      expect(check?.errorMessage).toContain('pick a secret');
    },
    TIMEOUT
  );

  test(
    'a subscription id header for another subscription fails',
    async () => {
      const checks = await deliveryChecks(
        delivering({ wrongSubscriptionIdHeader: true })
      );
      const check = checks.get('sep-9999-delivery-subscription-id-header');
      expect(check?.status).toBe('FAILURE');
      expect(check?.errorMessage).toContain('other than the subscribe');
    },
    TIMEOUT
  );
});

describe('transport and body', () => {
  test(
    'delivering as text/plain fails the POST-and-JSON row',
    async () => {
      const checks = await deliveryChecks(
        delivering({ contentType: 'text/plain' })
      );
      const check = checks.get('sep-9999-delivery-post-json');
      expect(check?.status).toBe('FAILURE');
      expect(check?.errorMessage).toContain('text/plain');
    },
    TIMEOUT
  );

  test(
    'a body past 256 KiB warns rather than fails',
    async () => {
      const checks = await deliveryChecks(delivering({ oversizedBody: true }));
      const check = checks.get('sep-9999-delivery-body-size');
      expect(check?.status).toBe('WARNING');
      expect(check?.errorMessage).toContain('256 KiB');
    },
    TIMEOUT
  );
});

describe('retries and redirects', () => {
  test(
    'reusing the timestamp across retries fails the freshness row',
    async () => {
      const checks = await deliveryChecks(
        delivering({ staleRetrySignature: true })
      );
      const check = checks.get('sep-9999-delivery-retry-regenerates-signature');
      expect(check?.status).toBe('FAILURE');
      expect(check?.errorMessage).toContain('freshness window');
    },
    TIMEOUT
  );

  test(
    'retrying after 410 and 413 fails both non-retryable rows',
    async () => {
      const checks = await deliveryChecks(
        delivering({ retryNonRetryable: true, attempts: 3 })
      );
      const gone = checks.get('sep-9999-delivery-410-non-retryable');
      expect(gone?.status).toBe('FAILURE');
      expect(gone?.errorMessage).toContain('non-retryable');
      expect(checks.get('sep-9999-delivery-413-non-retryable')?.status).toBe(
        'FAILURE'
      );
    },
    TIMEOUT
  );

  test(
    'following a 302 fails the no-redirects row',
    async () => {
      const checks = await deliveryChecks(
        delivering({ followRedirects: true })
      );
      const check = checks.get('sep-9999-ssrf-no-redirects');
      expect(check?.status).toBe('FAILURE');
      expect(check?.errorMessage).toContain('followed a 302');
    },
    TIMEOUT
  );
});

describe('control envelopes', () => {
  test(
    'an unsigned envelope fails, since a receiver cannot verify it',
    async () => {
      const checks = await deliveryChecks(delivering({ signEnvelopes: false }));
      const check = checks.get('sep-9999-envelope-signed-like-deliveries');
      expect(check?.status).toBe('FAILURE');
      expect(check?.errorMessage).toContain('cannot verify it');
    },
    TIMEOUT
  );

  test(
    'a webhook-id outside msg_<type>_<random> warns',
    async () => {
      const checks = await deliveryChecks(
        delivering({ envelopeIdFormat: 'plain' })
      );
      const check = checks.get('sep-9999-envelope-webhook-id-format');
      expect(check?.status).toBe('WARNING');
      expect(check?.errorMessage).toContain('outside the documented form');
    },
    TIMEOUT
  );

  // These two normally report untestable, because no client can ask a server
  // for a retention gap or a revocation. A server that sends one unasked is
  // graded on it, which is the only evidence these checks work.
  test(
    'gap and terminated envelopes are graded when they arrive',
    async () => {
      const quiet = await deliveryChecks(delivering());
      expect(quiet.get('sep-9999-envelope-gap')?.details?.untestable).toBe(
        true
      );
      expect(
        quiet.get('sep-9999-envelope-terminated')?.details?.untestable
      ).toBe(true);

      const sent = await deliveryChecks(
        delivering({ gapEnvelope: true, terminatedEnvelope: true })
      );
      expect(sent.get('sep-9999-envelope-gap')?.status).toBe('SUCCESS');
      expect(sent.get('sep-9999-envelope-terminated')?.status).toBe('SUCCESS');
    },
    TIMEOUT * 2
  );

  test(
    'a gap envelope with no fresh cursor warns',
    async () => {
      const checks = await deliveryChecks(
        delivering({ gapEnvelope: { cursor: null } })
      );
      const check = checks.get('sep-9999-envelope-gap');
      expect(check?.status).toBe('WARNING');
      expect(check?.errorMessage).toContain('nothing to persist');
    },
    TIMEOUT
  );
});
