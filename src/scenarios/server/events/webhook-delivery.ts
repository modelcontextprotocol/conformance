/**
 * MCP Events: what the server POSTs to a webhook callback — the verification
 * handshake, Standard Webhooks signing, retry behaviour, control envelopes and
 * the SSRF rules.
 *
 * Scored against the merged design sketch on `main` of
 * modelcontextprotocol/experimental-ext-triggers-events. Each check's verbatim
 * excerpt lives beside its id in src/seps/sep-9999.yaml, where 9999 is a
 * placeholder SEP number.
 *
 * **This scenario needs a callback the server under test can reach.** Set
 * `EVENTS_WEBHOOK_CALLBACK_BASE` to a public https base URL forwarding to this
 * harness (a tunnel, say), and the receiver binds to `0.0.0.0` behind it.
 *
 * With no such URL the scenario still runs, pointed at a loopback receiver,
 * and that is not a degraded mode so much as a different question. The
 * document requires a server to refuse a callback whose resolved IP is not
 * globally routable, so a loopback URL is exactly the SSRF probe: a server
 * that refuses it passes the SSRF rows and reports the delivery rows as
 * untestable, while one that happily POSTs to 127.0.0.1 fails the SSRF rows
 * and hands the harness real deliveries to grade everything else against. Both
 * outcomes are informative, and neither is a false green.
 *
 * The signature is verified over the raw bytes, per the document's own
 * instruction to receivers, so the scenario cannot accidentally pass a server
 * that signs a re-serialization of its own JSON.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { ClientScenario, ConformanceCheck } from '../../../types';
import type { Connection, RunContext } from '../../../connection';
import { JsonRpcError } from '../../../connection';
import { untestableCheck } from '../../untestable';
import {
  EVENTS_CALLBACK_ENDPOINT_ERROR,
  EVENTS_EXTENSION_ID,
  extensionsOf,
  EVENTS_SPEC_REF,
  EVENTS_SUBSCRIBE_METHOD,
  EVENTS_UNSUBSCRIBE_METHOD,
  JSONRPC_METHOD_NOT_FOUND,
  describeValue,
  descriptorName,
  eventsCheck,
  eventsListAll,
  EVENTS_CONTROL_ALLOW_CALLBACK_ORIGIN,
  EVENTS_CONTROL_WEBHOOK_GAP,
  EVENTS_CONTROL_WEBHOOK_TERMINATE,
  askControl,
  hasControl,
  firstSupporting,
  isIso8601,
  isObject,
  minimalArguments
} from './helpers';
import {
  RECEIVER_WELL_KNOWN_PATH,
  WRONG_CHALLENGE_ECHO,
  startCanary,
  startReceiver,
  type ReceivedDelivery,
  type Receiver
} from './receiver';

/** How long to wait for the server to deliver something. */
const DELIVERY_WAIT_MS = Number(process.env.EVENTS_DELIVERY_WAIT_MS ?? 20000);

/**
 * How long to let retries and the two non-retryable probes play out after the
 * first attempt arrives. Retry backoff is the server's to choose, so this is a
 * guess at "long enough to see a second attempt"; against a fast local fixture
 * it is most of the scenario's wall time, which is why it is a knob.
 */
const SETTLE_MS = Number(process.env.EVENTS_DELIVERY_SETTLE_MS ?? 5000);

/**
 * How long an accepted routability probe is watched for a connection. A server
 * that verifies inside events/subscribe has already dialled by the time it
 * answers; this covers one that verifies or delivers just after.
 */
const CANARY_WAIT_MS = Math.min(DELIVERY_WAIT_MS, 3000);

/** How long to wait for a gap or terminated envelope a control asked for. */
const ENVELOPE_WAIT_MS = Math.min(DELIVERY_WAIT_MS, 5000);

/** A public base URL forwarding to this harness, when one exists. */
const PUBLIC_BASE = process.env.EVENTS_WEBHOOK_CALLBACK_BASE;

/**
 * Whether the receiver publishes `/.well-known/mcp-webhook-receiver.json`.
 *
 * The document is the fourth way the spec lets a server confirm a callback's
 * intent, and an origin that serves it needs no challenge POST. Publishing it by
 * default costs nothing against a server that only implements the handshake, and
 * stops one that implements the document from failing a rule it satisfies. Set
 * `EVENTS_RECEIVER_WELL_KNOWN=0` to withhold it and force the handshake path.
 */
const PUBLISH_WELL_KNOWN = process.env.EVENTS_RECEIVER_WELL_KNOWN !== '0';

/**
 * The one path prefix the well-known document declares.
 *
 * Deliberately not `/`: the probe paths sit outside it so they still take the
 * handshake. The document is also honoured only on an `https` origin, so against
 * a loopback receiver this path is never taken and the handshake decides
 * everything, the same way the SSRF rows only mean something over a tunnel.
 */
const WELL_KNOWN_PREFIX = '/wk/';

/**
 * The `lastError` categories the document names for `-32015`. A server may have
 * more, so an unlisted one warns rather than fails: the rule is that the reason
 * is a category, not a raw response.
 */
const LAST_ERROR_CATEGORIES = [
  'challenge_failed',
  'connection_refused',
  'timeout',
  'tls_error'
];

/** 256 KiB, the body-size ceiling the document asks servers to respect. */
const BODY_CEILING_BYTES = 256 * 1024;

const DELIVERY_IDS = [
  'sep-9999-delivery-post-json',
  'sep-9999-delivery-standard-webhooks-headers',
  'sep-9999-delivery-subscription-id-header',
  'sep-9999-delivery-signature-formula',
  'sep-9999-delivery-retry-regenerates-signature',
  'sep-9999-delivery-dual-sign-on-rotation',
  'sep-9999-delivery-body-size',
  'sep-9999-delivery-413-non-retryable',
  'sep-9999-delivery-410-non-retryable',
  'sep-9999-delivery-retries-bounded',
  'sep-9999-delivery-status-last-error-category'
] as const;

const VERIFICATION_IDS = [
  'sep-9999-verification-required-before-delivery',
  'sep-9999-verification-challenge-echo',
  'sep-9999-verification-failure-error',
  'sep-9999-verification-cached-per-principal-url',
  'sep-9999-verification-persisted-for-no-expiry',
  'sep-9999-verification-uses-ssrf-hardened-path',
  'sep-9999-verification-no-raw-endpoint-responses',
  'sep-9999-server-identity-key-discovery'
] as const;

const SSRF_IDS = [
  'sep-9999-ssrf-validate-callback-url',
  'sep-9999-ssrf-reject-non-routable',
  'sep-9999-ssrf-validate-at-delivery-time',
  'sep-9999-ssrf-no-redirects'
] as const;

const ENVELOPE_IDS = [
  'sep-9999-envelope-type-discriminator',
  'sep-9999-envelope-signed-like-deliveries',
  'sep-9999-envelope-webhook-id-format',
  'sep-9999-envelope-gap',
  'sep-9999-envelope-terminated'
] as const;

/**
 * The error-table row this scenario claims. `-32015` is webhook-only and the
 * wrong-challenge probe is the only place the suite provokes it, so the row is
 * graded there and listed here for the same reason the others are: a path that
 * bails early must still report it, rather than emit one row fewer.
 */
const ERROR_IDS = ['sep-9999-error-callback-endpoint-error'] as const;

const ALL_IDS = [
  ...DELIVERY_IDS,
  ...VERIFICATION_IDS,
  ...SSRF_IDS,
  ...ENVELOPE_IDS,
  ...ERROR_IDS
];

function untestableAll(
  ids: readonly string[],
  reason: string,
  severity: 'FAILURE' | 'WARNING' = 'FAILURE'
): ConformanceCheck[] {
  return ids.map((id) =>
    untestableCheck(id, id, id, reason, [EVENTS_SPEC_REF], severity)
  );
}

function skipAll(reason: string): ConformanceCheck[] {
  return ALL_IDS.map((id) =>
    eventsCheck(id, id, 'SKIPPED', { errorMessage: reason })
  );
}

function freshSecret(): { value: string; bytes: Buffer } {
  const bytes = Buffer.alloc(32);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return { value: `whsec_${bytes.toString('base64')}`, bytes };
}

/** `HMAC-SHA256(secret, id + "." + timestamp + "." + body)`, base64, `v1,`. */
function expectedSignature(
  secret: Buffer,
  webhookId: string,
  timestamp: string,
  rawBody: string
): string {
  const mac = createHmac('sha256', secret)
    .update(`${webhookId}.${timestamp}.${rawBody}`)
    .digest('base64');
  return `v1,${mac}`;
}

function signatureMatches(header: string, expected: string): boolean {
  // The header may carry several space-delimited signatures during rotation.
  return header
    .split(/\s+/)
    .filter(Boolean)
    .some((candidate) => {
      const a = Buffer.from(candidate);
      const b = Buffer.from(expected);
      return a.length === b.length && timingSafeEqual(a, b);
    });
}

export class EventsWebhookDeliveryScenario implements ClientScenario {
  name = 'events-webhook-delivery';
  readonly source = { extensionId: EVENTS_EXTENSION_ID } as const;
  description = `MCP Events: webhook delivery, signing, verification and the SSRF rules.

**Methods**: \`events/subscribe\` and \`events/unsubscribe\`, plus an HTTP receiver the harness runs and the server POSTs to

**Requirements covered** (each check carries a verbatim spec excerpt in src/seps/sep-9999.yaml):

- \`sep-9999-verification-*\` — the challenge handshake that must precede delivery, and what a failed one reports
- \`sep-9999-delivery-*\` — POST with JSON, the Standard Webhooks headers plus \`X-MCP-Subscription-Id\`, the signature formula over the raw body, retries and their bounds
- \`sep-9999-envelope-*\` — the \`type\` discriminator, \`msg_<type>_<random>\` ids, and the gap and terminated envelopes
- \`sep-9999-ssrf-*\` — callback URLs are validated, non-routable addresses refused, and redirects not followed

**Needs a reachable callback**: set \`EVENTS_WEBHOOK_CALLBACK_BASE\` to a public https base URL that forwards to this harness.

**Without one, the loopback receiver is the SSRF probe.** A server that refuses \`http://127.0.0.1\` passes \`validate-callback-url\` and reports the delivery rows untestable; a server that delivers there fails it and supplies real deliveries for everything else. \`reject-non-routable\` is graded separately in either mode, from an \`https://127.0.0.1\` callback aimed at a listener that records whether the server connected, since the scheme rule alone refuses the http probe.`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const conn = await ctx.connect();
    let receiver: Receiver | undefined;
    try {
      const capabilities = await conn.discover();
      const caps = isObject(capabilities.capabilities)
        ? capabilities.capabilities
        : {};
      const declared = extensionsOf(caps)[EVENTS_EXTENSION_ID] !== undefined;

      const listed = await eventsListAll(conn);
      if ('error' in listed) {
        if (!declared && listed.error.code === JSONRPC_METHOD_NOT_FOUND) {
          return skipAll(
            'Server does not declare the `events` capability and does not implement `events/list`; the extension is optional.'
          );
        }
        return untestableAll(
          ALL_IDS,
          `\`events/list\` failed (${listed.error.code} ${listed.error.message}), so no webhook-capable event type could be discovered.`
        );
      }

      const target = firstSupporting(listed.descriptors, 'webhook');
      const name = target ? descriptorName(target) : undefined;
      if (!target || !name) {
        return untestableAll(
          ALL_IDS,
          'No event type advertises `webhook` delivery, so nothing could be delivered.'
        );
      }
      const args = minimalArguments(target);
      if (args === undefined) {
        return untestableAll(
          ALL_IDS,
          `Event type \`${name}\` declares required \`inputSchema\` properties the harness cannot satisfy from the schema.`
        );
      }

      receiver = await startReceiver(PUBLIC_BASE ? '0.0.0.0' : '127.0.0.1');
      // Only the main delivery path is declared, never the probe paths. A
      // server that reads the document verifies that one without a challenge,
      // and still has to handshake for everything under a prefix the document
      // does not name, so one run exercises both consent paths instead of
      // whichever the server happens to prefer.
      if (PUBLISH_WELL_KNOWN) receiver.publishWellKnown([WELL_KNOWN_PREFIX]);
      return await this.deliveryChecks(conn, receiver, name, args);
    } finally {
      await receiver?.close();
      await conn.close();
    }
  }

  private callbackFor(receiver: Receiver, path: string): string {
    return PUBLIC_BASE
      ? `${PUBLIC_BASE.replace(/\/$/, '')}${path}`
      : `${receiver.url}${path}`;
  }

  private async deliveryChecks(
    conn: Connection,
    receiver: Receiver,
    name: string,
    args: Record<string, unknown>
  ): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const path = `${WELL_KNOWN_PREFIX}hook-${Date.now()}`;
    const url = this.callbackFor(receiver, path);
    const secret = freshSecret();

    const subscribe = async (
      callbackUrl: string
    ): Promise<{ id?: unknown } | { error: JsonRpcError }> => {
      try {
        const result = await conn.request<{ id?: unknown }>(
          EVENTS_SUBSCRIBE_METHOD,
          {
            name,
            arguments: args,
            delivery: {
              mode: 'webhook',
              url: callbackUrl,
              secret: secret.value
            },
            cursor: null,
            ttlMs: 3600_000
          }
        );
        return result ?? {};
      } catch (err) {
        if (err instanceof JsonRpcError) return { error: err };
        throw err;
      }
    };
    const release = async (callbackUrl: string): Promise<void> => {
      try {
        await conn.request(EVENTS_UNSUBSCRIBE_METHOD, {
          name,
          arguments: args,
          delivery: { mode: 'webhook', url: callbackUrl }
        });
      } catch {
        // Already gone.
      }
    };

    // Routability first, on its own probe, before anything below can lift a
    // guard. dedupe keeps the first row per id, so this one is authoritative.
    checks.push(await this.nonRoutableCheck(subscribe, release));

    let subscribed = await subscribe(url);

    // --- The SSRF rows, which a loopback callback answers directly ---------
    const loopback = !PUBLIC_BASE;
    let guardLifted = false;
    if ('error' in subscribed && loopback) {
      // Graded here, before anything is lifted, so the verdict is about the
      // server as configured rather than as persuaded.
      checks.push(...this.ssrfRefusedChecks(subscribed.error));
      guardLifted = await this.liftCallbackGuard(conn, receiver);
      if (guardLifted) subscribed = await subscribe(url);
    }
    if ('error' in subscribed) {
      const refused = subscribed.error;
      if (loopback) {
        checks.push(
          ...untestableAll(
            [
              ...DELIVERY_IDS,
              ...VERIFICATION_IDS,
              ...ENVELOPE_IDS,
              ...ERROR_IDS,
              // The two SSRF rows the refusal does not answer by itself: one
              // needs a delivery to revalidate, the other a redirect to refuse.
              'sep-9999-ssrf-validate-at-delivery-time',
              'sep-9999-ssrf-no-redirects'
            ],
            guardLifted
              ? `The server still refused ${url} after \`${EVENTS_CONTROL_ALLOW_CALLBACK_ORIGIN}\` was called for its origin (${refused.code} ${refused.message}), so nothing could be delivered.`
              : `The server refused a loopback callback (${refused.code} ${refused.message}), which is what the SSRF rules ask of it. Grading delivery needs a callback it will accept: set EVENTS_WEBHOOK_CALLBACK_BASE to a public https URL forwarding to this harness, or expose the \`${EVENTS_CONTROL_ALLOW_CALLBACK_ORIGIN}\` control so this one origin is permitted after the SSRF rows are graded.`
          )
        );
        return dedupe(checks);
      }
      checks.push(
        eventsCheck(
          'sep-9999-delivery-post-json',
          'Deliveries are HTTP `POST` only, with Content-Type `application/json`.',
          'FAILURE',
          {
            errorMessage: `Subscribing with the configured callback ${url} answered ${refused.code} ${refused.message}, so nothing could be delivered.`
          }
        )
      );
      checks.push(
        ...untestableAll(
          ALL_IDS.filter((id) => id !== 'sep-9999-delivery-post-json'),
          `No subscription could be created against ${url}.`
        )
      );
      return dedupe(checks);
    }

    try {
      const subscriptionId = subscribed.id;

      // Wait for whatever the server sends: the verification challenge first,
      // then events.
      const first = await receiver.waitFor(path, () => true, DELIVERY_WAIT_MS);
      // One delivery is a thin sample for the header and signature rows, so
      // give a server emitting on a cadence a moment to send a few more.
      if (first)
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(3000, SETTLE_MS))
        );
      const all = receiver.on(path);

      if (loopback && !guardLifted) {
        checks.push(...this.ssrfDeliveredChecks(all.length > 0, url));
      } else if (loopback) {
        // Already graded above, against the default configuration. Deliveries
        // here happened because this origin was permitted on purpose, so they
        // say nothing about the rule.
        checks.push(
          eventsCheck(
            'sep-9999-ssrf-validate-at-delivery-time',
            'To prevent DNS rebinding, validation MUST be performed at delivery time, not only at subscribe time.',
            'SKIPPED',
            {
              errorMessage: `This origin was permitted through \`${EVENTS_CONTROL_ALLOW_CALLBACK_ORIGIN}\`, so a delivery to it is not evidence either way. Proving revalidation needs a hostname whose DNS answer changes between subscribe and delivery.`
            }
          )
        );
      } else {
        checks.push(
          ...untestableAll(
            ['sep-9999-ssrf-validate-callback-url'],
            'The configured callback is routable, so the refusal path was not exercised. Run without EVENTS_WEBHOOK_CALLBACK_BASE to probe it with a loopback URL.',
            'WARNING'
          )
        );
      }
      checks.push(
        untestableCheck(
          'sep-9999-ssrf-validate-at-delivery-time',
          'sep-9999-ssrf-validate-at-delivery-time',
          'To prevent DNS rebinding, validation MUST be performed at delivery time, not only at subscribe time.',
          'Proving delivery-time revalidation needs a hostname whose DNS answer changes between subscribe and delivery, which the harness cannot serve.',
          [EVENTS_SPEC_REF]
        )
      );

      if (!first) {
        checks.push(
          ...untestableAll(
            [
              ...DELIVERY_IDS,
              ...VERIFICATION_IDS,
              ...ENVELOPE_IDS,
              ...ERROR_IDS
            ].filter(
              (id) => id !== 'sep-9999-delivery-status-last-error-category'
            ),
            `Nothing arrived at ${url} within ${DELIVERY_WAIT_MS}ms of subscribing, so no delivery could be graded.`
          )
        );
        checks.push(
          untestableCheck(
            'sep-9999-delivery-status-last-error-category',
            'sep-9999-delivery-status-last-error-category',
            '`lastError` MUST be a server-generated category string and MUST NOT include raw response bodies.',
            'No delivery was attempted, so no `deliveryStatus.lastError` could be observed. The field is OPTIONAL in any case.',
            [EVENTS_SPEC_REF],
            'WARNING'
          )
        );
        checks.push(
          untestableCheck(
            'sep-9999-ssrf-no-redirects',
            'sep-9999-ssrf-no-redirects',
            'Webhook delivery requests MUST NOT follow HTTP redirects.',
            'No delivery was attempted, so the redirect probe had nothing to redirect.',
            [EVENTS_SPEC_REF]
          )
        );
        return dedupe(checks);
      }

      checks.push(
        ...this.verificationChecks(
          all,
          subscriptionId,
          receiver.wellKnownFetches()
        )
      );
      // The residual rows come last because one of them grades what the server
      // said when the handshake failed, which only the probe below produces.
      let endpointFailure: JsonRpcError | undefined;
      if (all.some(isVerificationEnvelope)) {
        const failed = await this.verificationFailureCheck(
          receiver,
          subscribe,
          release
        );
        checks.push(failed.check);
        endpointFailure = failed.serverError;
      }
      checks.push(
        ...this.verificationResidualChecks(subscriptionId, endpointFailure)
      );
      checks.push(this.callbackEndpointErrorCheck(endpointFailure));
      checks.push(...this.transportChecks(all, subscriptionId));
      checks.push(...this.signatureChecks(all, secret.bytes));
      checks.push(...(await this.redirectChecks(receiver, subscribe, release)));
      checks.push(...(await this.retryChecks(receiver, subscribe, release)));
      // Last, because terminating ends the subscription everything above
      // delivered to. The envelope rows grade from what arrived after, so the
      // signalled gap and terminated envelopes count toward the discriminator,
      // signing and id rows too.
      const signalled = await this.signalEnvelopes(
        conn,
        receiver,
        path,
        subscriptionId
      );
      checks.push(...this.envelopeChecks(receiver.on(path), signalled));
      return dedupe(checks);
    } finally {
      await release(url);
    }
  }

  /**
   * Ask the server to permit this receiver's origin, after the SSRF rows have
   * been graded against its default configuration.
   *
   * Absent control means no override, which is the normal case and never an
   * error: the delivery rows then report untestable and name both ways out.
   * Returns whether the server acknowledged, not whether the next subscribe will
   * succeed, because a server may decline for its own reasons.
   */
  private async liftCallbackGuard(
    conn: Connection,
    receiver: Receiver
  ): Promise<boolean> {
    if (!(await hasControl(conn, EVENTS_CONTROL_ALLOW_CALLBACK_ORIGIN))) {
      return false;
    }
    const origin = new URL(receiver.url).origin;
    const answer = await askControl(
      conn,
      EVENTS_CONTROL_ALLOW_CALLBACK_ORIGIN,
      { origin }
    );
    return answer !== undefined;
  }

  /**
   * The server refused the loopback http callback. Either the scheme rule or
   * routability can do that, so it answers "validates callback URLs" and
   * nothing narrower; nonRoutableCheck grades routability on a URL the scheme
   * rule cannot refuse.
   */
  private ssrfRefusedChecks(error: JsonRpcError): ConformanceCheck[] {
    return [
      eventsCheck(
        'sep-9999-ssrf-validate-callback-url',
        'The server MUST validate callback URLs.',
        'SUCCESS',
        { details: { code: error.code, message: error.message } }
      )
    ];
  }

  /**
   * `reject-non-routable`, graded from an `https://127.0.0.1` callback aimed at
   * a canary listener. The https scheme takes the scheme rule out of the
   * question, and the canary says whether the server dialled, which is what
   * separates "refused because the address is not routable" from "tried it and
   * the handshake failed".
   */
  private async nonRoutableCheck(
    subscribe: (
      callbackUrl: string
    ) => Promise<{ id?: unknown } | { error: JsonRpcError }>,
    release: (callbackUrl: string) => Promise<void>
  ): Promise<ConformanceCheck> {
    const id = 'sep-9999-ssrf-reject-non-routable';
    const description =
      'Servers SHOULD reject URLs whose resolved IP is not globally routable per the IANA Special-Purpose Address Registries.';
    const canary = await startCanary();
    const probe = `https://127.0.0.1:${canary.port}/ssrf-probe-${Date.now()}`;
    try {
      const answered = await subscribe(probe);
      const refused = 'error' in answered ? answered.error : undefined;
      if (!refused) {
        const deadline = Date.now() + CANARY_WAIT_MS;
        while (canary.connections() === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        await release(probe);
      }
      const dialled = canary.connections();

      if (dialled > 0) {
        return eventsCheck(id, description, 'FAILURE', {
          errorMessage: refused
            ? `The server answered ${refused.code} ${refused.message} for ${probe}, but only after connecting to it (${dialled} connection(s)). A callback on 127.0.0.0/8 was dialled rather than refused, so the error came from the connection failing, not from the address check.`
            : `The server accepted ${probe} and connected to it (${dialled} connection(s)). 127.0.0.0/8 is not globally routable, so a caller can aim requests at services the server can reach and the caller cannot.`,
          details: { url: probe, connections: dialled, code: refused?.code }
        });
      }
      if (!refused) {
        return eventsCheck(id, description, 'WARNING', {
          errorMessage: `${probe} was accepted at subscribe time and nothing connected to it within ${CANARY_WAIT_MS}ms. That may be delivery-time validation rather than a missing check, and an idle event type looks the same.`,
          details: { url: probe }
        });
      }
      // Over a tunnel the server may not share this host, so its dial to
      // 127.0.0.1 would never reach the canary. Only a parameter error is
      // unambiguous then.
      if (PUBLIC_BASE && refused.code !== -32602) {
        return eventsCheck(id, description, 'WARNING', {
          errorMessage: `${probe} was refused with ${refused.code} ${refused.message}. With EVENTS_WEBHOOK_CALLBACK_BASE set the server may be on another host, where a failed connection and an address refusal look the same from here; only -32602 settles it.`,
          details: { url: probe, code: refused.code, message: refused.message }
        });
      }
      return eventsCheck(id, description, 'SUCCESS', {
        details: {
          url: probe,
          code: refused.code,
          message: refused.message,
          connections: 0
        }
      });
    } finally {
      await canary.close();
    }
  }

  /**
   * The server accepted a loopback callback. Did it also deliver there? Only
   * `validate-callback-url` is graded here; routability has its own probe.
   */
  private ssrfDeliveredChecks(
    delivered: boolean,
    url: string
  ): ConformanceCheck[] {
    if (!delivered) {
      return [
        eventsCheck(
          'sep-9999-ssrf-validate-callback-url',
          'The server MUST validate callback URLs.',
          'WARNING',
          {
            errorMessage: `The subscribe for ${url} was accepted, but nothing was delivered, so the harness cannot tell delivery-time hardening from an idle event type.`
          }
        )
      ];
    }
    return [
      eventsCheck(
        'sep-9999-ssrf-validate-callback-url',
        'The server MUST validate callback URLs.',
        'FAILURE',
        {
          errorMessage: `The server POSTed to ${url}, a loopback address. A callback URL pointing inside the server's own network was neither refused at subscribe time nor at delivery time.`
        }
      )
    ];
  }

  /** The challenge handshake that must precede any event delivery. */
  private verificationChecks(
    all: ReceivedDelivery[],
    subscriptionId: unknown,
    wellKnownFetches: number
  ): ConformanceCheck[] {
    const out: ConformanceCheck[] = [];
    const verification = all.find(isVerificationEnvelope);
    const events = all.filter((d) => typeof d.json?.eventId === 'string');

    // The document names four ways to confirm intent, and two of them are
    // invisible from here: a server-configured allowlist and prior out-of-band
    // verification. Neither can apply to these callbacks, because the path is
    // minted fresh for the run and no operator has ever seen it, so a server
    // that delivers to it has either handshaken, read the well-known document,
    // or skipped consent. That is what keeps the failure below honest.
    if (!verification && wellKnownFetches > 0) {
      out.push(
        eventsCheck(
          'sep-9999-verification-required-before-delivery',
          "A server MUST NOT begin delivering to a callback URL until the endpoint's intent to receive deliveries is confirmed, by one of: a verification handshake, a server-configured allowlist, prior out-of-band verification, or a receiver-published well-known document.",
          'SUCCESS',
          {
            details: {
              via: RECEIVER_WELL_KNOWN_PATH,
              fetches: wellKnownFetches,
              note: 'The origin published its consent, so no challenge POST is required.'
            }
          }
        )
      );
      out.push(
        ...untestableAll(
          [
            'sep-9999-verification-challenge-echo',
            'sep-9999-verification-failure-error'
          ],
          `The server confirmed intent by fetching ${RECEIVER_WELL_KNOWN_PATH} and sent no challenge, so the echo path was not exercised. Re-run with EVENTS_RECEIVER_WELL_KNOWN=0 to withhold the document and force the handshake.`,
          'WARNING'
        )
      );
      return out;
    }

    if (!verification) {
      out.push(
        eventsCheck(
          'sep-9999-verification-required-before-delivery',
          "A server MUST NOT begin delivering to a callback URL until the endpoint's intent to receive deliveries is confirmed.",
          events.length > 0 ? 'FAILURE' : 'WARNING',
          {
            errorMessage:
              events.length > 0
                ? `${events.length} event(s) were delivered to a callback that was never asked to prove intent. An attacker can aim a subscription at a third party and the server will POST to it.`
                : 'No verification envelope and no events arrived, so intent confirmation could not be observed.',
            details: { deliveries: all.length }
          }
        )
      );
      out.push(
        ...untestableAll(
          [
            'sep-9999-verification-challenge-echo',
            'sep-9999-verification-failure-error'
          ],
          'The server sent no verification challenge, so the echo path could not be exercised.'
        )
      );
    } else {
      out.push(
        eventsCheck(
          'sep-9999-verification-required-before-delivery',
          "A server MUST NOT begin delivering to a callback URL until the endpoint's intent to receive deliveries is confirmed.",
          events.length === 0 ||
            verification.atMs <= (events[0]?.atMs ?? Infinity)
            ? 'SUCCESS'
            : 'FAILURE',
          {
            errorMessage:
              events.length > 0 &&
              verification.atMs > (events[0]?.atMs ?? Infinity)
                ? 'An event was delivered before the verification challenge.'
                : undefined,
            details: { verificationAtMs: verification.atMs }
          }
        )
      );
      out.push(
        eventsCheck(
          'sep-9999-verification-challenge-echo',
          'Before activating, the server POSTs a `verification` control envelope carrying a single-use, short-lived `challenge` nonce, and the endpoint proves intent by echoing it in a 2xx body.',
          typeof verification.json?.challenge === 'string'
            ? 'SUCCESS'
            : 'FAILURE',
          {
            errorMessage:
              typeof verification.json?.challenge === 'string'
                ? undefined
                : `The verification envelope carried \`challenge\` ${describeValue(verification.json?.challenge)}, expected a string nonce.`,
            details: { body: verification.json }
          }
        )
      );
    }

    return out;
  }

  /**
   * The verification rows that do not depend on which consent path the server
   * took, kept in one place so every branch above emits the same row set. A
   * branch that emitted fewer would read as a shorter suite rather than as a
   * prerequisite that was missing.
   */
  private verificationResidualChecks(
    subscriptionId: unknown,
    endpointFailure?: JsonRpcError
  ): ConformanceCheck[] {
    const out: ConformanceCheck[] = [];
    out.push(
      untestableCheck(
        'sep-9999-verification-uses-ssrf-hardened-path',
        'sep-9999-verification-uses-ssrf-hardened-path',
        'The verification POST MUST use the same SSRF-hardened path as deliveries.',
        'Both the verification POST and the deliveries are observed from the receiver, so they cannot be distinguished as using the same internal code path. The SSRF rows grade the outcome the rule protects.',
        [EVENTS_SPEC_REF],
        'WARNING'
      )
    );
    out.push(
      ...untestableAll(
        [
          'sep-9999-verification-cached-per-principal-url',
          'sep-9999-verification-persisted-for-no-expiry',
          'sep-9999-server-identity-key-discovery'
        ],
        'Needs a second principal, a server restart, or a key-discovery origin the harness does not control.',
        'WARNING'
      )
    );
    out.push(this.noRawEndpointResponsesCheck(subscriptionId, endpointFailure));
    return out;
  }

  /**
   * The `-32015` row from the error table, graded off the same probe as
   * sep-9999-verification-failure-error rather than a second failing callback.
   * That row grades the rule; this one grades the code and the `data.reason`
   * category the table requires of it.
   */
  private callbackEndpointErrorCheck(
    endpointFailure?: JsonRpcError
  ): ConformanceCheck {
    const id = 'sep-9999-error-callback-endpoint-error';
    const description =
      '`-32015 CallbackEndpointError` — a client-supplied callback endpoint failed verification or could not be reached (webhook mode only). `data.reason` is one of the `lastError` categories.';
    if (!endpointFailure) {
      return untestableCheck(
        id,
        id,
        description,
        'No callback failed verification or connection during this run, so the code was never provoked. A server that implements the verification handshake answers it for the wrong-challenge probe.',
        [EVENTS_SPEC_REF]
      );
    }
    const reason = isObject(endpointFailure.data)
      ? endpointFailure.data.reason
      : undefined;
    if (endpointFailure.code !== EVENTS_CALLBACK_ENDPOINT_ERROR) {
      return eventsCheck(id, description, 'FAILURE', {
        errorMessage: `A callback that failed verification answered ${endpointFailure.code} ${endpointFailure.message}, where the table names ${EVENTS_CALLBACK_ENDPOINT_ERROR} CallbackEndpointError.`,
        details: { code: endpointFailure.code, data: endpointFailure.data }
      });
    }
    return LAST_ERROR_CATEGORIES.includes(String(reason))
      ? eventsCheck(id, description, 'SUCCESS', {
          details: {
            code: endpointFailure.code,
            reason,
            gradedBy: 'sep-9999-verification-failure-error'
          }
        })
      : eventsCheck(id, description, 'WARNING', {
          errorMessage: `\`${EVENTS_CALLBACK_ENDPOINT_ERROR}\` carried \`data.reason\` ${describeValue(reason)}, which is not one of the documented \`lastError\` categories (${LAST_ERROR_CATEGORIES.join(', ')}).`,
          details: { reason }
        });
  }

  /**
   * Whether a failed handshake leaked the endpoint's own response.
   *
   * Only gradeable when something actually failed, which is why it waits for the
   * wrong-challenge probe rather than passing on the strength of a quiet run.
   * The receiver echoes a distinctive string, so finding it in the server's
   * error is proof the body was passed through to the subscriber.
   */
  private noRawEndpointResponsesCheck(
    subscriptionId: unknown,
    endpointFailure?: JsonRpcError
  ): ConformanceCheck {
    const id = 'sep-9999-verification-no-raw-endpoint-responses';
    const description =
      'Failures surface only via the `lastError` category `challenge_failed`, never raw endpoint responses.';
    if (!endpointFailure) {
      return untestableCheck(
        id,
        id,
        description,
        'No endpoint failed verification during this run, so nothing could have carried its response body back. The wrong-challenge probe supplies one against a server that implements the handshake.',
        [EVENTS_SPEC_REF],
        'WARNING'
      );
    }
    const reported = JSON.stringify({
      message: endpointFailure.message,
      data: endpointFailure.data
    });
    return reported.includes(WRONG_CHALLENGE_ECHO)
      ? eventsCheck(id, description, 'FAILURE', {
          errorMessage: `The error for a failed handshake carried the endpoint's own response (${JSON.stringify(WRONG_CHALLENGE_ECHO)}). A subscriber learns what an arbitrary third-party URL answered, which is the reflection the category exists to avoid.`,
          details: { reported }
        })
      : eventsCheck(id, description, 'SUCCESS', {
          details: { subscriptionId, code: endpointFailure.code }
        });
  }

  /** POST, content type, and the headers every delivery must carry. */
  private transportChecks(
    all: ReceivedDelivery[],
    subscriptionId: unknown
  ): ConformanceCheck[] {
    const out: ConformanceCheck[] = [];
    const graded = all.filter((d) => d.respondedStatus !== 302);

    const badMethod = graded.filter((d) => d.method !== 'POST');
    const badType = graded.filter(
      (d) => !(d.headers['content-type'] ?? '').includes('application/json')
    );
    out.push(
      badMethod.length === 0 && badType.length === 0
        ? eventsCheck(
            'sep-9999-delivery-post-json',
            'Deliveries are HTTP `POST` only, with Content-Type `application/json`.',
            'SUCCESS',
            { details: { deliveries: graded.length } }
          )
        : eventsCheck(
            'sep-9999-delivery-post-json',
            'Deliveries are HTTP `POST` only, with Content-Type `application/json`.',
            'FAILURE',
            {
              errorMessage: [
                badMethod.length
                  ? `${badMethod.length} delivery(ies) used ${[...new Set(badMethod.map((d) => d.method))].join(', ')}`
                  : undefined,
                badType.length
                  ? `${badType.length} carried content-type ${[...new Set(badType.map((d) => d.headers['content-type'] ?? 'absent'))].join(', ')}`
                  : undefined
              ]
                .filter(Boolean)
                .join('; ')
            }
          )
    );

    const missingHeaders = graded
      .map((d) => ({
        d,
        missing: [
          'webhook-id',
          'webhook-timestamp',
          'webhook-signature'
        ].filter((h) => !d.headers[h])
      }))
      .filter((x) => x.missing.length > 0);
    out.push(
      missingHeaders.length === 0
        ? eventsCheck(
            'sep-9999-delivery-standard-webhooks-headers',
            'Every delivery MUST include `webhook-id`, `webhook-timestamp` (Unix seconds), and `webhook-signature`.',
            'SUCCESS',
            { details: { deliveries: graded.length } }
          )
        : eventsCheck(
            'sep-9999-delivery-standard-webhooks-headers',
            'Every delivery MUST include `webhook-id`, `webhook-timestamp` (Unix seconds), and `webhook-signature`.',
            'FAILURE',
            {
              errorMessage: `${missingHeaders.length} of ${graded.length} delivery(ies) were missing ${[...new Set(missingHeaders.flatMap((x) => x.missing))].join(', ')}.`
            }
          )
    );

    const missingSubId = graded.filter(
      (d) => !d.headers['x-mcp-subscription-id']
    );
    const wrongSubId =
      typeof subscriptionId === 'string'
        ? graded.filter(
            (d) =>
              d.headers['x-mcp-subscription-id'] &&
              d.headers['x-mcp-subscription-id'] !== subscriptionId
          )
        : [];
    out.push(
      missingSubId.length === 0 && wrongSubId.length === 0
        ? eventsCheck(
            'sep-9999-delivery-subscription-id-header',
            'Deliveries MUST include `X-MCP-Subscription-Id` so the receiver can select the correct secret without parsing the body.',
            'SUCCESS',
            { details: { subscriptionId } }
          )
        : eventsCheck(
            'sep-9999-delivery-subscription-id-header',
            'Deliveries MUST include `X-MCP-Subscription-Id` so the receiver can select the correct secret without parsing the body.',
            'FAILURE',
            {
              errorMessage:
                missingSubId.length > 0
                  ? `${missingSubId.length} of ${graded.length} delivery(ies) carried no \`X-MCP-Subscription-Id\`; a receiver holding several subscriptions must parse the body to pick a secret.`
                  : `${wrongSubId.length} delivery(ies) carried an \`X-MCP-Subscription-Id\` other than the subscribe response's \`id\` (${String(subscriptionId)}).`
            }
          )
    );

    const oversized = graded.filter(
      (d) => Buffer.byteLength(d.rawBody, 'utf8') > BODY_CEILING_BYTES
    );
    out.push(
      oversized.length === 0
        ? eventsCheck(
            'sep-9999-delivery-body-size',
            'Servers SHOULD keep delivery bodies at or under 256 KiB, consistent with Payload Minimality.',
            'SUCCESS',
            {
              details: {
                largestBytes: Math.max(
                  0,
                  ...graded.map((d) => Buffer.byteLength(d.rawBody, 'utf8'))
                )
              }
            }
          )
        : eventsCheck(
            'sep-9999-delivery-body-size',
            'Servers SHOULD keep delivery bodies at or under 256 KiB, consistent with Payload Minimality.',
            'WARNING',
            {
              errorMessage: `${oversized.length} delivery(ies) exceeded 256 KiB (largest ${Math.max(...oversized.map((d) => Buffer.byteLength(d.rawBody, 'utf8')))} bytes).`
            }
          )
    );

    out.push(
      untestableCheck(
        'sep-9999-delivery-status-last-error-category',
        'sep-9999-delivery-status-last-error-category',
        '`lastError` MUST be a server-generated category string and MUST NOT include raw response bodies.',
        '`deliveryStatus` is OPTIONAL and no refresh in this run carried one, so there was no `lastError` to inspect.',
        [EVENTS_SPEC_REF],
        'WARNING'
      )
    );
    out.push(
      untestableCheck(
        'sep-9999-delivery-dual-sign-on-rotation',
        'sep-9999-delivery-dual-sign-on-rotation',
        'The server SHOULD dual-sign deliveries with both the old and new secrets for a short grace window.',
        'Observing it needs a secret rotated while a delivery is in flight, which the harness cannot time reliably.',
        [EVENTS_SPEC_REF],
        'WARNING'
      )
    );
    return out;
  }

  /** The signature, computed over the raw bytes exactly as they arrived. */
  private signatureChecks(
    all: ReceivedDelivery[],
    secret: Buffer
  ): ConformanceCheck[] {
    const signed = all.filter(
      (d) => d.headers['webhook-signature'] && d.headers['webhook-id']
    );
    if (signed.length === 0) {
      return untestableAll(
        ['sep-9999-delivery-signature-formula'],
        'No delivery carried both `webhook-id` and `webhook-signature`, so the formula could not be checked.'
      );
    }
    const bad = signed.filter(
      (d) =>
        !signatureMatches(
          d.headers['webhook-signature'],
          expectedSignature(
            secret,
            d.headers['webhook-id'],
            d.headers['webhook-timestamp'] ?? '',
            d.rawBody
          )
        )
    );
    const description =
      'The signature is `HMAC-SHA256(secret, webhook-id + "." + webhook-timestamp + "." + body)` encoded as base64 with a `v1,` prefix, over the raw body bytes.';
    return [
      bad.length === 0
        ? eventsCheck(
            'sep-9999-delivery-signature-formula',
            description,
            'SUCCESS',
            { details: { verified: signed.length } }
          )
        : eventsCheck(
            'sep-9999-delivery-signature-formula',
            description,
            'FAILURE',
            {
              errorMessage: `${bad.length} of ${signed.length} delivery(ies) carried a signature that did not verify over the raw body with the subscription's secret.`,
              details: {
                firstHeader: bad[0]?.headers['webhook-signature'],
                firstId: bad[0]?.headers['webhook-id'],
                firstTimestamp: bad[0]?.headers['webhook-timestamp']
              }
            }
          )
    ];
  }

  /** Control envelopes versus event bodies. */
  /**
   * Ask the server to send this subscription a gap, then to end it, and wait
   * for each envelope. Absent controls are the normal case; the rows then fall
   * back to whatever the server sent unasked.
   */
  private async signalEnvelopes(
    conn: Connection,
    receiver: Receiver,
    path: string,
    subscriptionId: unknown
  ): Promise<SignalledEnvelopes> {
    const signal = async (
      tool: string,
      type: string
    ): Promise<SignalOutcome> => {
      if (!(await hasControl(conn, tool))) return 'absent';
      if (typeof subscriptionId !== 'string') return 'refused';
      if ((await askControl(conn, tool, { id: subscriptionId })) === undefined)
        return 'refused';
      await receiver.waitFor(
        path,
        (d) => d.json?.type === type,
        ENVELOPE_WAIT_MS
      );
      return 'sent';
    };
    const gap = await signal(EVENTS_CONTROL_WEBHOOK_GAP, 'gap');
    const terminate = await signal(
      EVENTS_CONTROL_WEBHOOK_TERMINATE,
      'terminated'
    );
    return { gap, terminate };
  }

  private envelopeChecks(
    all: ReceivedDelivery[],
    signalled: SignalledEnvelopes
  ): ConformanceCheck[] {
    const out: ConformanceCheck[] = [];
    const envelopes = all.filter((d) => typeof d.json?.type === 'string');
    const events = all.filter(
      (d) =>
        d.json &&
        d.json.type === undefined &&
        typeof d.json.eventId === 'string'
    );

    out.push(
      envelopes.length > 0 || events.length > 0
        ? eventsCheck(
            'sep-9999-envelope-type-discriminator',
            'A body with a top-level `type` field is a control envelope; a body without one is an `EventOccurrence`.',
            events.every((d) => isIso8601(d.json?.timestamp))
              ? 'SUCCESS'
              : 'FAILURE',
            {
              errorMessage: events.every((d) => isIso8601(d.json?.timestamp))
                ? undefined
                : 'A body with no `type` was not a well-formed `EventOccurrence` (its `timestamp` is not ISO 8601).',
              details: { envelopes: envelopes.length, events: events.length }
            }
          )
        : untestableCheck(
            'sep-9999-envelope-type-discriminator',
            'sep-9999-envelope-type-discriminator',
            'A body with a top-level `type` field is a control envelope; a body without one is an `EventOccurrence`.',
            'Nothing with a JSON body arrived, so neither shape was seen.',
            [EVENTS_SPEC_REF]
          )
    );

    if (envelopes.length === 0) {
      out.push(
        ...untestableAll(
          [
            'sep-9999-envelope-signed-like-deliveries',
            'sep-9999-envelope-webhook-id-format'
          ],
          'No control envelope arrived during the run.'
        )
      );
    } else {
      out.push(
        envelopes.every(
          (d) =>
            d.headers['webhook-signature'] && d.headers['x-mcp-subscription-id']
        )
          ? eventsCheck(
              'sep-9999-envelope-signed-like-deliveries',
              'Control envelopes are signed and headed exactly like event deliveries.',
              'SUCCESS',
              { details: { envelopes: envelopes.length } }
            )
          : eventsCheck(
              'sep-9999-envelope-signed-like-deliveries',
              'Control envelopes are signed and headed exactly like event deliveries.',
              'FAILURE',
              {
                errorMessage:
                  'A control envelope arrived without the full Standard Webhooks header set plus `X-MCP-Subscription-Id`, so a receiver cannot verify it the way it verifies events.'
              }
            )
      );
      const badIds = envelopes.filter((d) => {
        const id = d.headers['webhook-id'] ?? '';
        return !/^msg_[a-z]+_.+/i.test(id);
      });
      out.push(
        badIds.length === 0
          ? eventsCheck(
              'sep-9999-envelope-webhook-id-format',
              '`webhook-id` for control envelopes is a per-message identifier of the form `msg_<type>_<random>` so receivers can dedup retries.',
              'SUCCESS',
              {
                details: { ids: envelopes.map((d) => d.headers['webhook-id']) }
              }
            )
          : eventsCheck(
              'sep-9999-envelope-webhook-id-format',
              '`webhook-id` for control envelopes is a per-message identifier of the form `msg_<type>_<random>`.',
              'WARNING',
              {
                errorMessage: `${badIds.length} control envelope(s) carried a \`webhook-id\` outside the documented form (e.g. ${describeValue(badIds[0]?.headers['webhook-id'])}).`
              }
            )
      );
    }

    // A gap and a termination cannot be provoked from the client side. The
    // webhook controls provoke one each on this subscription; without them the
    // rows are still graded when a server sends one unasked.
    const gapDesc =
      'A `gap` envelope `{"type":"gap","cursor":"<fresh>"}` is sent when a gap is detected between refreshes. The client persists `cursor` and treats it as `truncated: true`.';
    const gap = all.find((d) => d.json?.type === 'gap');
    out.push(
      !gap
        ? signalled.gap === 'sent'
          ? eventsCheck('sep-9999-envelope-gap', gapDesc, 'WARNING', {
              errorMessage: `\`${EVENTS_CONTROL_WEBHOOK_GAP}\` acknowledged, and no \`gap\` envelope arrived within ${ENVELOPE_WAIT_MS}ms.`
            })
          : untestableCheck(
              'sep-9999-envelope-gap',
              'sep-9999-envelope-gap',
              gapDesc,
              signalled.gap === 'refused'
                ? `No retention gap occurred during the run, and \`${EVENTS_CONTROL_WEBHOOK_GAP}\` declined to signal one.`
                : `No retention gap occurred during the run, and the harness cannot force one from the client side. Needs a fixture exposing the \`${EVENTS_CONTROL_WEBHOOK_GAP}\` control.`,
              [EVENTS_SPEC_REF],
              'WARNING'
            )
        : eventsCheck(
            'sep-9999-envelope-gap',
            gapDesc,
            typeof gap.json?.cursor === 'string' ? 'SUCCESS' : 'WARNING',
            {
              errorMessage:
                typeof gap.json?.cursor === 'string'
                  ? undefined
                  : `A \`gap\` envelope carried \`cursor\` ${describeValue(gap.json?.cursor)}; without a fresh position the client has nothing to persist.`,
              details: { body: gap.json }
            }
          )
    );

    const terminatedDesc =
      'A `terminated` envelope `{"type":"terminated","error":{...}}` is sent when the subscription has ended (e.g., authorization revoked). The subscription no longer exists server-side.';
    const terminated = all.find((d) => d.json?.type === 'terminated');
    out.push(
      !terminated
        ? signalled.terminate === 'sent'
          ? eventsCheck(
              'sep-9999-envelope-terminated',
              terminatedDesc,
              'FAILURE',
              {
                errorMessage: `\`${EVENTS_CONTROL_WEBHOOK_TERMINATE}\` acknowledged ending the subscription, and no \`terminated\` envelope arrived within ${ENVELOPE_WAIT_MS}ms, so the receiver was never told.`
              }
            )
          : untestableCheck(
              'sep-9999-envelope-terminated',
              'sep-9999-envelope-terminated',
              terminatedDesc,
              signalled.terminate === 'refused'
                ? `The subscription was not terminated during the run, and \`${EVENTS_CONTROL_WEBHOOK_TERMINATE}\` declined to end it.`
                : `The subscription was not terminated during the run. Needs a server that can revoke authorization or remove an event type mid-run, or a fixture exposing the \`${EVENTS_CONTROL_WEBHOOK_TERMINATE}\` control.`,
              [EVENTS_SPEC_REF],
              'WARNING'
            )
        : eventsCheck(
            'sep-9999-envelope-terminated',
            terminatedDesc,
            isObject(terminated.json?.error) ? 'SUCCESS' : 'WARNING',
            {
              errorMessage: isObject(terminated.json?.error)
                ? undefined
                : `A \`terminated\` envelope carried \`error\` ${describeValue(terminated.json?.error)}; without it the client cannot tell revocation from removal.`,
              details: { body: terminated.json }
            }
          )
    );
    return out;
  }

  /**
   * A callback that answers the challenge with the wrong nonce. The document
   * has the failure come back from events/subscribe itself as -32015 with
   * `data.reason: "challenge_failed"`. A server that accepts instead and then
   * delivers there has sent events to an endpoint that never consented; one
   * that accepts and withholds delivery verified asynchronously, which keeps
   * the endpoint safe but reports nothing to the subscriber.
   */
  private async verificationFailureCheck(
    receiver: Receiver,
    subscribe: (
      url: string
    ) => Promise<{ id?: unknown } | { error: JsonRpcError }>,
    release: (url: string) => Promise<void>
  ): Promise<{ check: ConformanceCheck; serverError?: JsonRpcError }> {
    const id = 'sep-9999-verification-failure-error';
    const description =
      'A reachable endpoint that fails to echo yields `-32015 CallbackEndpointError` with `data.reason: "challenge_failed"`.';
    const path = `/wrong-challenge-${Date.now()}`;
    receiver.behave(path, { kind: 'wrong-challenge' });
    const url = this.callbackFor(receiver, path);
    const probe = await subscribe(url);

    if ('error' in probe) {
      const { code, message, data } = probe.error;
      const reason = isObject(data) ? data.reason : undefined;
      if (
        code === EVENTS_CALLBACK_ENDPOINT_ERROR &&
        reason === 'challenge_failed'
      ) {
        return {
          check: eventsCheck(id, description, 'SUCCESS', {
            details: { code, reason }
          }),
          serverError: probe.error
        };
      }
      return {
        check: eventsCheck(id, description, 'FAILURE', {
          errorMessage: `Subscribing a callback that echoed the wrong nonce answered ${code} ${message} with data.reason ${describeValue(reason)}, expected ${EVENTS_CALLBACK_ENDPOINT_ERROR} with "challenge_failed".`,
          details: { code, data }
        }),
        serverError: probe.error
      };
    }

    try {
      const delivered = await receiver.waitFor(
        path,
        (d) => typeof d.json?.eventId === 'string',
        DELIVERY_WAIT_MS
      );
      if (delivered) {
        return {
          check: eventsCheck(id, description, 'FAILURE', {
            errorMessage: `The subscribe succeeded although the callback echoed the wrong nonce, and an event was then delivered to it. The document has this refused with ${EVENTS_CALLBACK_ENDPOINT_ERROR} "challenge_failed" from events/subscribe, and no delivery to an endpoint that did not consent.`
          })
        };
      }
      return {
        check: eventsCheck(id, description, 'WARNING', {
          errorMessage: `The subscribe succeeded although the callback echoed the wrong nonce. Nothing was delivered to it, so the endpoint is safe, but the subscriber was never told: the document returns ${EVENTS_CALLBACK_ENDPOINT_ERROR} "challenge_failed" synchronously from events/subscribe.`
        })
      };
    } finally {
      await release(url);
    }
  }

  /** A callback that redirects: the server must not follow it. */
  private async redirectChecks(
    receiver: Receiver,
    subscribe: (
      url: string
    ) => Promise<{ id?: unknown } | { error: JsonRpcError }>,
    release: (url: string) => Promise<void>
  ): Promise<ConformanceCheck[]> {
    const from = `/redirect-${Date.now()}`;
    const to = `/redirect-target-${Date.now()}`;
    receiver.behave(from, {
      kind: 'redirect',
      to: this.callbackFor(receiver, to)
    });
    const url = this.callbackFor(receiver, from);
    const description =
      'Webhook delivery requests MUST NOT follow HTTP redirects, since a redirect can target an internal address that bypasses the blocklist.';

    const sub = await subscribe(url);
    if ('error' in sub) {
      return [
        untestableCheck(
          'sep-9999-ssrf-no-redirects',
          'sep-9999-ssrf-no-redirects',
          description,
          `The redirecting callback could not be subscribed (${sub.error.code} ${sub.error.message}).`,
          [EVENTS_SPEC_REF]
        )
      ];
    }
    try {
      const redirected = await receiver.waitFor(
        from,
        (d) => d.respondedStatus === 302,
        DELIVERY_WAIT_MS
      );
      if (!redirected) {
        return [
          untestableCheck(
            'sep-9999-ssrf-no-redirects',
            'sep-9999-ssrf-no-redirects',
            description,
            `Nothing was delivered to the redirecting callback within ${DELIVERY_WAIT_MS}ms, so no redirect was offered.`,
            [EVENTS_SPEC_REF]
          )
        ];
      }
      // Give a server that does follow redirects time to arrive at the target.
      const followed = await receiver.waitFor(
        to,
        () => true,
        Math.min(3000, SETTLE_MS)
      );
      return [
        followed
          ? eventsCheck('sep-9999-ssrf-no-redirects', description, 'FAILURE', {
              errorMessage: `The server followed a 302 from ${from} to ${to}. A redirect can point at an internal address, which is exactly what the delivery-time IP check is meant to stop.`
            })
          : eventsCheck('sep-9999-ssrf-no-redirects', description, 'SUCCESS', {
              details: { offered: from, notFollowed: to }
            })
      ];
    } finally {
      await release(url);
    }
  }

  /** Retries: fresh signatures, a bound, and the two non-retryable statuses. */
  private async retryChecks(
    receiver: Receiver,
    subscribe: (
      url: string
    ) => Promise<{ id?: unknown } | { error: JsonRpcError }>,
    release: (url: string) => Promise<void>
  ): Promise<ConformanceCheck[]> {
    const out: ConformanceCheck[] = [];
    const flaky = `/flaky-${Date.now()}`;
    receiver.behave(flaky, {
      kind: 'fail-then-accept',
      failures: 2,
      status: 503
    });
    const flakyUrl = this.callbackFor(receiver, flaky);

    const sub = await subscribe(flakyUrl);
    if ('error' in sub) {
      out.push(
        ...untestableAll(
          [
            'sep-9999-delivery-retry-regenerates-signature',
            'sep-9999-delivery-retries-bounded'
          ],
          `The retry probe could not be subscribed (${sub.error.code} ${sub.error.message}).`
        )
      );
    } else {
      try {
        await receiver.waitFor(
          flaky,
          (d) => !isVerificationEnvelope(d),
          DELIVERY_WAIT_MS
        );
        // Let the retries play out.
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
        const attempts = receiver.on(flaky);
        const byId = new Map<string, ReceivedDelivery[]>();
        for (const a of attempts) {
          const id = a.headers['webhook-id'] ?? '';
          byId.set(id, [...(byId.get(id) ?? []), a]);
        }
        const retried = [...byId.values()].find((group) => group.length > 1);

        if (!retried) {
          out.push(
            ...untestableAll(
              [
                'sep-9999-delivery-retry-regenerates-signature',
                'sep-9999-delivery-retries-bounded'
              ],
              `A callback answering 503 received ${attempts.length} attempt(s), none of them a retry of the same \`webhook-id\`, so retry behaviour could not be observed.`,
              'WARNING'
            )
          );
        } else {
          const stamps = retried.map(
            (a) => a.headers['webhook-timestamp'] ?? ''
          );
          // Freshness only: whether the signature verifies at all belongs to
          // sep-9999-delivery-signature-formula, and folding the two together
          // reports a server with a wrong formula as reusing timestamps it
          // plainly did not reuse.
          //
          // webhook-timestamp is whole seconds, so two attempts inside one
          // second share a stamp whether or not it was regenerated. Only a
          // stamp that stays put across attempts a second or more apart is
          // provably reused.
          const pairs = retried
            .slice(1)
            .map((a, i) => ({ prev: retried[i], next: a }));
          const spaced = pairs.filter(
            ({ prev, next }) => next.atMs - prev.atMs >= 1000
          );
          const reused = spaced.filter(
            ({ prev, next }) =>
              (prev.headers['webhook-timestamp'] ?? '') ===
              (next.headers['webhook-timestamp'] ?? '')
          );
          const description =
            "Each retry attempt MUST regenerate the timestamp and signature so retries are not rejected by the receiver's freshness window.";
          if (reused.length > 0) {
            out.push(
              eventsCheck(
                'sep-9999-delivery-retry-regenerates-signature',
                description,
                'FAILURE',
                {
                  errorMessage: `Retries of the same \`webhook-id\` reused a timestamp or signature (timestamps ${stamps.join(', ')}, the repeat at least a second apart), so a receiver enforcing the 5-minute freshness window would reject them.`
                }
              )
            );
          } else if (
            spaced.length > 0 ||
            new Set(stamps).size === stamps.length
          ) {
            out.push(
              eventsCheck(
                'sep-9999-delivery-retry-regenerates-signature',
                description,
                'SUCCESS',
                { details: { attempts: retried.length, stamps } }
              )
            );
          } else {
            out.push(
              eventsCheck(
                'sep-9999-delivery-retry-regenerates-signature',
                description,
                'WARNING',
                {
                  errorMessage: `Every retry arrived within a second of the one before (timestamps ${stamps.join(', ')}), and webhook-timestamp is in whole seconds, so a regenerated stamp and a reused one look the same.`,
                  details: { attempts: retried.length, stamps }
                }
              )
            );
          }
          out.push(
            retried.length <= 6
              ? eventsCheck(
                  'sep-9999-delivery-retries-bounded',
                  'Retries are bounded: servers SHOULD cap both the attempt count and the elapsed retry window.',
                  'SUCCESS',
                  { details: { attempts: retried.length } }
                )
              : eventsCheck(
                  'sep-9999-delivery-retries-bounded',
                  'Retries are bounded: servers SHOULD cap both the attempt count and the elapsed retry window (for example, 3–5 attempts over no more than 10–15 minutes).',
                  'WARNING',
                  {
                    errorMessage: `One event was attempted ${retried.length} times within the observation window, past the 3–5 the document suggests.`
                  }
                )
          );
        }
      } finally {
        await release(flakyUrl);
      }
    }

    // 410 Gone and 413 Payload Too Large are both non-retryable.
    for (const [id, kind, status, description] of [
      [
        'sep-9999-delivery-410-non-retryable',
        'gone' as const,
        410,
        'A receiver that intentionally rejects a delivery and does not want it retried responds `410 Gone`; the server MUST treat it as non-retryable.'
      ],
      [
        'sep-9999-delivery-413-non-retryable',
        'too-large' as const,
        413,
        'Receivers and intermediaries MAY reject larger bodies with `413 Payload Too Large`; servers MUST treat `413` as a non-retryable failure for that event.'
      ]
    ] as const) {
      const path = `/${kind}-${Date.now()}`;
      receiver.behave(path, { kind });
      const url = this.callbackFor(receiver, path);
      const probe = await subscribe(url);
      if ('error' in probe) {
        out.push(
          untestableCheck(
            id,
            id,
            description,
            `The ${status} probe could not be subscribed (${probe.error.code} ${probe.error.message}).`,
            [EVENTS_SPEC_REF]
          )
        );
        continue;
      }
      try {
        // The challenge on this path is answered 200 and never retried, so
        // grading it would pass any server; the probe is about the event.
        const first = await receiver.waitFor(
          path,
          (d) => !isVerificationEnvelope(d),
          DELIVERY_WAIT_MS
        );
        if (!first) {
          out.push(
            untestableCheck(
              id,
              id,
              description,
              `Nothing was delivered to the ${status} probe within ${DELIVERY_WAIT_MS}ms.`,
              [EVENTS_SPEC_REF]
            )
          );
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
        const repeats = receiver
          .on(path)
          .filter(
            (d) => d.headers['webhook-id'] === first.headers['webhook-id']
          );
        out.push(
          repeats.length <= 1
            ? eventsCheck(id, description, 'SUCCESS', {
                details: { attempts: repeats.length }
              })
            : eventsCheck(id, description, 'FAILURE', {
                errorMessage: `The same \`webhook-id\` was delivered ${repeats.length} times after a ${status}, which the document defines as non-retryable.`
              })
        );
      } finally {
        await release(url);
      }
    }

    return out;
  }
}

function isVerificationEnvelope(d: ReceivedDelivery): boolean {
  return (
    d.json?.type === 'verification' || typeof d.json?.challenge === 'string'
  );
}

/** Keep the first check emitted per id, so a fallback path cannot double-report. */
/**
 * What became of asking for each control envelope: no control, a control that
 * declined, or a control that acknowledged (whether or not anything arrived).
 */
type SignalOutcome = 'absent' | 'refused' | 'sent';
type SignalledEnvelopes = { gap: SignalOutcome; terminate: SignalOutcome };

function dedupe(checks: ConformanceCheck[]): ConformanceCheck[] {
  const seen = new Set<string>();
  return checks.filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
}
