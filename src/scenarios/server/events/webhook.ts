/**
 * MCP Events: webhook subscription management — `events/subscribe`,
 * TTL negotiation, and `events/unsubscribe`.
 *
 * Scored against the merged design sketch on `main` of
 * modelcontextprotocol/experimental-ext-triggers-events. Each check's verbatim
 * excerpt lives beside its id in src/seps/sep-9999.yaml, where 9999 is a
 * placeholder SEP number.
 *
 * This scenario deliberately stops at the subscription surface. Everything
 * about what the server then POSTs — signatures, headers, the verification
 * handshake, control envelopes — belongs to events-webhook-delivery, which
 * needs a callback URL the server can reach. Here the callback is a URL that
 * exists only to be a distinct key, so a server may well suspend delivery to
 * it; that is not this scenario's business.
 *
 * Rows the principal owns are the awkward ones. The subscription key is
 * `(principal, delivery.url, name, arguments)`, and a run holds exactly one
 * principal: whatever credential the harness was pointed at, or none. So the
 * three components the harness can vary are graded, and the principal
 * component is reported untestable with the reason named, rather than passing
 * a cross-tenant isolation row that was never exercised across two tenants.
 *
 * Every subscription this scenario creates is unsubscribed before it returns.
 * Against a public server a leaked subscription is a server holding state for
 * a callback nobody reads, so cleanup is part of the scenario rather than an
 * afterthought.
 */

import { ClientScenario, ConformanceCheck } from '../../../types';
import type { Connection, RunContext } from '../../../connection';
import { JsonRpcError } from '../../../connection';
import { untestableCheck } from '../../untestable';
import {
  EVENTS_CAPABILITY,
  EVENTS_EXTENSION_ID,
  EVENTS_NOT_FOUND,
  EVENTS_SPEC_REF,
  EVENTS_SUBSCRIBE_METHOD,
  EVENTS_UNSUBSCRIBE_METHOD,
  EVENTS_UNSUPPORTED,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_METHOD_NOT_FOUND,
  describeValue,
  descriptorName,
  eventsCheck,
  eventsListAll,
  firstSupporting,
  isObject,
  isValidCursor,
  minimalArguments,
  type EventDescriptor
} from './helpers';

/** A callback URL that is syntactically valid and points nowhere in use. */
const CALLBACK_BASE = 'https://conformance.invalid/mcp-events';

/** A suggestion the server can plausibly grant, for the TTL rows. */
const TTL_SUGGESTION_MS = 3600_000;

const SUBSCRIBE_IDS = [
  'sep-9999-subscribe-webhook-only',
  'sep-9999-subscribe-secret-required',
  'sep-9999-subscribe-secret-format',
  'sep-9999-subscribe-secret-rejected',
  'sep-9999-subscribe-url-https-required',
  'sep-9999-subscribe-url-non-https-rejected',
  'sep-9999-subscribe-auth-required',
  'sep-9999-subscribe-key-composition',
  'sep-9999-subscribe-key-immutable',
  'sep-9999-subscribe-idempotent-upsert',
  'sep-9999-subscribe-id-derived',
  'sep-9999-subscribe-id-not-an-input',
  'sep-9999-subscribe-refresh-replaces-secret',
  'sep-9999-subscribe-refresh-reactivates',
  'sep-9999-subscribe-response-cursor',
  'sep-9999-subscribe-response-truncated',
  'sep-9999-subscribe-cross-tenant-isolation'
] as const;

const TTL_IDS = [
  'sep-9999-ttl-refresh-before-lte-suggestion',
  'sep-9999-ttl-no-rejection-path',
  'sep-9999-ttl-null-only-when-requested',
  'sep-9999-ttl-omitted-means-default',
  'sep-9999-ttl-long-grant-retained',
  'sep-9999-ttl-no-expiry-persisted',
  'sep-9999-ttl-no-expiry-gc-terminated'
] as const;

const UNSUBSCRIBE_IDS = [
  'sep-9999-unsubscribe-by-key',
  'sep-9999-unsubscribe-unknown-not-found'
] as const;

/**
 * The error-table row this scenario claims. It lives outside the three groups
 * above because those name their own probes, and it has to be in `ALL_IDS` or a
 * server this scenario bails on early emits 26 rows where a gradeable one emits
 * 27 — which reads as a shorter suite rather than a prerequisite that was
 * missing.
 */
const ERROR_IDS = ['sep-9999-error-unsupported'] as const;

const ALL_IDS = [
  ...SUBSCRIBE_IDS,
  ...TTL_IDS,
  ...UNSUBSCRIBE_IDS,
  ...ERROR_IDS
];

interface SubscribeResult {
  id?: unknown;
  refreshBefore?: unknown;
  cursor?: unknown;
  truncated?: unknown;
  deliveryStatus?: unknown;
}

/** A Standard Webhooks secret: `whsec_` plus base64 of 32 random bytes. */
function freshSecret(): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return `whsec_${Buffer.from(bytes).toString('base64')}`;
}

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

export class EventsWebhookScenario implements ClientScenario {
  name = 'events-webhook';
  readonly source = { extensionId: EVENTS_EXTENSION_ID } as const;
  description = `MCP Events: webhook subscription management.

**Methods**: \`events/subscribe\`, \`events/unsubscribe\`, plus \`events/list\` to discover an event type advertising \`webhook\` delivery

**Requirements covered** (each check carries a verbatim spec excerpt in src/seps/sep-9999.yaml):

- \`sep-9999-subscribe-secret-*\` — the \`whsec_\` Standard Webhooks secret is required, and a malformed one is rejected with \`InvalidParams\`
- \`sep-9999-subscribe-url-*\` — callback URLs must be https, and a non-https one is rejected
- \`sep-9999-subscribe-key-*\` / \`sep-9999-subscribe-id-*\` — the compound key, its immutability, the derived \`id\`, and that \`id\` is not an input
- \`sep-9999-subscribe-idempotent-upsert\` / \`sep-9999-subscribe-response-*\` — a repeat subscribe refreshes in place and returns \`cursor\` and \`truncated\`
- \`sep-9999-ttl-*\` — the grant is at or under the suggestion, there is no rejection path, and \`null\` comes back only when asked for
- \`sep-9999-unsubscribe-*\` — teardown by key, and \`-32011 NotFound\` for a key the server does not hold

**Scope**: subscription management only. Signatures, the verification handshake and control envelopes belong to events-webhook-delivery, which needs a reachable callback.

**The principal is one row's blind spot**: the key is \`(principal, delivery.url, name, arguments)\` and a run holds one principal, so cross-tenant isolation and the auth requirement report untestable rather than passing unexercised.

**Cleanup**: every subscription created here is unsubscribed before the scenario returns.`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const conn = await ctx.connect();
    try {
      const capabilities = await conn.discover();
      const caps = isObject(capabilities.capabilities)
        ? capabilities.capabilities
        : {};
      const declared = caps[EVENTS_CAPABILITY] !== undefined;

      const listed = await eventsListAll(conn);
      if ('error' in listed) {
        if (!declared && listed.error.code === JSONRPC_METHOD_NOT_FOUND) {
          return skipAll(
            'Server does not declare the `events` capability and does not implement `events/list`; the extension is optional.'
          );
        }
        return untestableAll(
          ALL_IDS,
          `\`events/list\` failed (${listed.error.code} ${listed.error.message}), so no webhook-capable event type could be discovered. See the events-discovery scenario.`
        );
      }

      const target = firstSupporting(listed.descriptors, 'webhook');
      const name = target ? descriptorName(target) : undefined;
      if (!target || !name) {
        return untestableAll(
          ALL_IDS,
          listed.descriptors.length === 0
            ? '`events/list` returned an empty catalog, so no webhook-capable event type could be exercised.'
            : 'No event type advertises `webhook` delivery, so `events/subscribe` could not be exercised. Webhook is optional per event type.'
        );
      }

      const args = minimalArguments(target);
      if (args === undefined) {
        return untestableAll(
          ALL_IDS,
          `Event type \`${name}\` declares required \`inputSchema\` properties the harness cannot satisfy from the schema, so no subscription could be created.`
        );
      }

      return await this.webhookChecks(conn, listed.descriptors, name, args);
    } finally {
      await conn.close();
    }
  }

  private async webhookChecks(
    conn: Connection,
    descriptors: EventDescriptor[],
    name: string,
    args: Record<string, unknown>
  ): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const created: Array<{ url: string; name: string }> = [];
    const url = `${CALLBACK_BASE}/${Date.now()}`;

    // A server may cap concurrent subscriptions per principal — kitchen-sink
    // allows two per event type — and a run that holds every probe's
    // subscription open hits that cap and then grades the cap error instead of
    // the rule it was probing. So each throwaway subscription is released as
    // soon as its check is graded, and only the one the later checks build on
    // is held.
    const release = async (url: string, subName: string): Promise<void> => {
      try {
        await conn.request(EVENTS_UNSUBSCRIBE_METHOD, {
          name: subName,
          arguments: args,
          delivery: { mode: 'webhook', url }
        });
      } catch {
        // Never created, or already gone.
      }
      const at = created.findIndex((c) => c.url === url && c.name === subName);
      if (at >= 0) created.splice(at, 1);
    };

    const subscribe = async (
      params: Record<string, unknown>
    ): Promise<{ result: SubscribeResult } | { error: JsonRpcError }> => {
      try {
        const result = await conn.request<SubscribeResult>(
          EVENTS_SUBSCRIBE_METHOD,
          params
        );
        const delivery = isObject(params.delivery) ? params.delivery : {};
        if (typeof delivery.url === 'string') {
          created.push({ url: delivery.url, name: String(params.name) });
        }
        return { result: result ?? {} };
      } catch (err) {
        if (err instanceof JsonRpcError) return { error: err };
        throw err;
      }
    };

    try {
      // --- A subscription the rest of the scenario builds on ----------------
      const first = await subscribe({
        name,
        arguments: args,
        delivery: { mode: 'webhook', url, secret: freshSecret() },
        cursor: null,
        ttlMs: TTL_SUGGESTION_MS
      });

      if ('error' in first) {
        const err = first.error;
        checks.push(
          eventsCheck(
            'sep-9999-subscribe-webhook-only',
            '`events/subscribe` is ONLY used for webhook delivery. Poll and push do not need it.',
            err.code === JSONRPC_METHOD_NOT_FOUND ? 'FAILURE' : 'WARNING',
            {
              errorMessage: `Event type \`${name}\` advertises \`webhook\` delivery but a well-formed \`${EVENTS_SUBSCRIBE_METHOD}\` answered ${err.code} ${err.message}.`,
              details: { code: err.code, message: err.message, data: err.data }
            }
          )
        );
        checks.push(
          ...untestableAll(
            ALL_IDS.filter((id) => id !== 'sep-9999-subscribe-webhook-only'),
            `No subscription could be created for \`${name}\` (${err.code} ${err.message}), so the subscription surface could not be exercised.`
          )
        );
        return dedupe(checks);
      }

      checks.push(
        eventsCheck(
          'sep-9999-subscribe-webhook-only',
          '`events/subscribe` is ONLY used for webhook delivery. Poll and push do not need it.',
          'SUCCESS',
          { details: { name } }
        )
      );

      checks.push(...this.responseChecks(first.result));
      checks.push(...this.ttlChecks(first.result));
      checks.push(
        ...(await this.ttlNegotiationChecks(
          subscribe,
          release,
          name,
          args,
          url
        ))
      );
      checks.push(
        ...(await this.rejectionChecks(
          subscribe,
          release,
          name,
          args,
          descriptors
        ))
      );
      checks.push(
        ...(await this.identityChecks(
          subscribe,
          release,
          first.result,
          name,
          args,
          url
        ))
      );
      checks.push(
        ...(await this.unsubscribeChecks(conn, first.result, name, args, url))
      );
      return dedupe(checks);
    } finally {
      // Leave nothing behind, including on a public server.
      for (const sub of created) {
        try {
          await conn.request(EVENTS_UNSUBSCRIBE_METHOD, {
            name: sub.name,
            arguments: args,
            delivery: { mode: 'webhook', url: sub.url }
          });
        } catch {
          // Already gone, or never created. Nothing to do.
        }
      }
    }
  }

  /** `cursor` and `truncated` on the subscribe response. */
  private responseChecks(result: SubscribeResult): ConformanceCheck[] {
    const out: ConformanceCheck[] = [];
    out.push(
      isValidCursor(result.cursor)
        ? eventsCheck(
            'sep-9999-subscribe-response-cursor',
            "The subscribe response carries `cursor`, a safe-to-persist watermark that advances the client's cursor even if no events arrive before next refresh.",
            'SUCCESS',
            { details: { cursor: result.cursor } }
          )
        : eventsCheck(
            'sep-9999-subscribe-response-cursor',
            "The subscribe response carries `cursor`, a safe-to-persist watermark that advances the client's cursor even if no events arrive before next refresh.",
            'FAILURE',
            {
              errorMessage: `\`cursor\` is ${describeValue(result.cursor)}, expected a string or null.`
            }
          )
    );
    out.push(
      result.truncated === undefined || typeof result.truncated === 'boolean'
        ? eventsCheck(
            'sep-9999-subscribe-response-truncated',
            'The subscribe response carries `truncated`, true if delivery started later than the supplied cursor.',
            'SUCCESS',
            { details: { truncated: result.truncated ?? false } }
          )
        : eventsCheck(
            'sep-9999-subscribe-response-truncated',
            'The subscribe response carries `truncated`, true if delivery started later than the supplied cursor.',
            'FAILURE',
            {
              errorMessage: `\`truncated\` is ${describeValue(result.truncated)}, expected a boolean.`
            }
          )
    );
    return out;
  }

  /** The grant on the subscription the scenario opened with a suggestion. */
  private ttlChecks(result: SubscribeResult): ConformanceCheck[] {
    const out: ConformanceCheck[] = [];
    const grant = result.refreshBefore;
    const description =
      '`refreshBefore` (response) is the grant. It SHOULD be less than or equal to the suggestion.';

    if (grant === null) {
      out.push(
        eventsCheck(
          'sep-9999-ttl-null-only-when-requested',
          'A server MUST NOT return `null` unless the client suggested `ttlMs: null` — no expiry exceeds every finite suggestion.',
          'FAILURE',
          {
            errorMessage: `The subscribe carried \`ttlMs: ${TTL_SUGGESTION_MS}\` and the server granted \`refreshBefore: null\`, which is no expiry.`
          }
        )
      );
      out.push(
        untestableCheck(
          'sep-9999-ttl-refresh-before-lte-suggestion',
          'sep-9999-ttl-refresh-before-lte-suggestion',
          description,
          'The server granted no expiry, so there is no finite grant to compare against the suggestion.',
          [EVENTS_SPEC_REF],
          'WARNING'
        )
      );
      return out;
    }

    out.push(
      eventsCheck(
        'sep-9999-ttl-null-only-when-requested',
        'A server MUST NOT return `null` unless the client suggested `ttlMs: null` — no expiry exceeds every finite suggestion.',
        'SUCCESS',
        { details: { refreshBefore: grant } }
      )
    );

    const grantedAt = typeof grant === 'string' ? Date.parse(grant) : NaN;
    if (!Number.isFinite(grantedAt)) {
      out.push(
        eventsCheck(
          'sep-9999-ttl-refresh-before-lte-suggestion',
          description,
          'FAILURE',
          {
            errorMessage: `\`refreshBefore\` is ${describeValue(grant)}, expected an ISO 8601 timestamp or null.`
          }
        )
      );
      return out;
    }

    // A minute of slack: the suggestion is measured from when the harness
    // sent the request, the grant from when the server handled it.
    const ceiling = Date.now() + TTL_SUGGESTION_MS + 60_000;
    out.push(
      grantedAt <= ceiling
        ? eventsCheck(
            'sep-9999-ttl-refresh-before-lte-suggestion',
            description,
            'SUCCESS',
            {
              details: { refreshBefore: grant, suggestedMs: TTL_SUGGESTION_MS }
            }
          )
        : eventsCheck(
            'sep-9999-ttl-refresh-before-lte-suggestion',
            description,
            'WARNING',
            {
              errorMessage: `Granted \`refreshBefore\` is ${grant}, about ${Math.round((grantedAt - Date.now()) / 1000)}s out, past the suggested ${TTL_SUGGESTION_MS / 1000}s.`
            }
          )
    );
    return out;
  }

  /** Omitted, absurd and no-expiry TTL suggestions. */
  private async ttlNegotiationChecks(
    subscribe: (
      p: Record<string, unknown>
    ) => Promise<{ result: SubscribeResult } | { error: JsonRpcError }>,
    release: (url: string, name: string) => Promise<void>,
    name: string,
    args: Record<string, unknown>,
    baseUrl: string
  ): Promise<ConformanceCheck[]> {
    const out: ConformanceCheck[] = [];

    // Omitting ttlMs means "server default", which is still a grant.
    const omitted = await subscribe({
      name,
      arguments: args,
      delivery: {
        mode: 'webhook',
        url: `${baseUrl}-ttl-default`,
        secret: freshSecret()
      },
      cursor: null
    });
    await release(`${baseUrl}-ttl-default`, name);
    out.push(
      'error' in omitted
        ? eventsCheck(
            'sep-9999-ttl-omitted-means-default',
            'Omitting `ttlMs` means "server default."',
            'FAILURE',
            {
              errorMessage: `A subscribe with no \`ttlMs\` answered ${omitted.error.code} ${omitted.error.message}; omitting it is defined as asking for the server default.`
            }
          )
        : omitted.result.refreshBefore === null
          ? eventsCheck(
              'sep-9999-ttl-omitted-means-default',
              'Omitting `ttlMs` means "server default." An explicit `ttlMs: null` requests a subscription with no expiry.',
              'FAILURE',
              {
                errorMessage:
                  'A subscribe with no `ttlMs` was granted `refreshBefore: null`, which only an explicit `ttlMs: null` may request.'
              }
            )
          : eventsCheck(
              'sep-9999-ttl-omitted-means-default',
              'Omitting `ttlMs` means "server default."',
              'SUCCESS',
              { details: { refreshBefore: omitted.result.refreshBefore } }
            )
    );

    // Clamping is self-announcing in both directions, so neither an
    // impractically short nor a very long suggestion is an error.
    const short = await subscribe({
      name,
      arguments: args,
      delivery: {
        mode: 'webhook',
        url: `${baseUrl}-ttl-short`,
        secret: freshSecret()
      },
      cursor: null,
      ttlMs: 1000
    });
    // Released before the next one is opened: a server may cap concurrent
    // subscriptions per principal, and the primary subscription holds a slot.
    await release(`${baseUrl}-ttl-short`, name);
    const long = await subscribe({
      name,
      arguments: args,
      delivery: {
        mode: 'webhook',
        url: `${baseUrl}-ttl-long`,
        secret: freshSecret()
      },
      cursor: null,
      ttlMs: 30 * 24 * 3600_000
    });
    await release(`${baseUrl}-ttl-long`, name);
    const rejected = [
      ['1000ms', short],
      ['30 days', long]
    ].filter(([, r]) => 'error' in (r as object)) as Array<
      [string, { error: JsonRpcError }]
    >;
    out.push(
      rejected.length === 0
        ? eventsCheck(
            'sep-9999-ttl-no-rejection-path',
            'Clamping in either direction is self-announcing, so a clamped grant is not an error and there is no rejection path for TTL values.',
            'SUCCESS',
            {
              details: {
                short:
                  'error' in short ? undefined : short.result.refreshBefore,
                long: 'error' in long ? undefined : long.result.refreshBefore
              }
            }
          )
        : eventsCheck(
            'sep-9999-ttl-no-rejection-path',
            'Clamping in either direction is self-announcing, so a clamped grant is not an error and there is no rejection path for TTL values.',
            'FAILURE',
            {
              errorMessage: rejected
                .map(
                  ([label, r]) =>
                    `\`ttlMs\` of ${label} was rejected with ${r.error.code} ${r.error.message}`
                )
                .join('; ')
            }
          )
    );

    // The durability rows need a restart, which the harness cannot ask for.
    out.push(
      ...untestableAll(
        [
          'sep-9999-ttl-long-grant-retained',
          'sep-9999-ttl-no-expiry-persisted',
          'sep-9999-ttl-no-expiry-gc-terminated'
        ],
        'Grading retention across a restart needs the server under test to be restarted mid-run, which the harness cannot do over the wire.',
        'WARNING'
      )
    );

    return out;
  }

  /** What a malformed subscribe must be rejected with. */
  private async rejectionChecks(
    subscribe: (
      p: Record<string, unknown>
    ) => Promise<{ result: SubscribeResult } | { error: JsonRpcError }>,
    release: (url: string, name: string) => Promise<void>,
    name: string,
    args: Record<string, unknown>,
    descriptors: EventDescriptor[]
  ): Promise<ConformanceCheck[]> {
    const out: ConformanceCheck[] = [];

    const expectInvalidParams = async (
      id: string,
      description: string,
      params: Record<string, unknown>,
      what: string
    ): Promise<ConformanceCheck> => {
      const res = await subscribe(params);
      if (!('error' in res)) {
        // A probe the server was supposed to reject but accepted has just
        // taken a subscription slot, and holding it would make the next probe
        // grade a cap error instead of its own rule.
        const delivery = isObject(params.delivery) ? params.delivery : {};
        if (typeof delivery.url === 'string') {
          await release(delivery.url, String(params.name));
        }
        return eventsCheck(id, description, 'FAILURE', {
          errorMessage: `${what} was accepted; the document requires \`-32602 InvalidParams\`.`,
          details: { result: res.result }
        });
      }
      return res.error.code === JSONRPC_INVALID_PARAMS
        ? eventsCheck(id, description, 'SUCCESS', {
            details: { code: res.error.code }
          })
        : eventsCheck(id, description, 'WARNING', {
            errorMessage: `${what} was rejected with ${res.error.code} ${res.error.message}, where the document names \`-32602 InvalidParams\`.`,
            details: { error: res.error }
          });
    };

    const base = {
      name,
      arguments: args,
      cursor: null
    };

    out.push(
      await expectInvalidParams(
        'sep-9999-subscribe-secret-required',
        '`delivery.secret` is REQUIRED. The client supplies the HMAC signing secret; the server never generates one.',
        {
          ...base,
          delivery: { mode: 'webhook', url: `${CALLBACK_BASE}/no-secret` }
        },
        'A subscribe with no `delivery.secret`'
      )
    );

    out.push(
      await expectInvalidParams(
        'sep-9999-subscribe-secret-format',
        'The value MUST be a Standard Webhooks symmetric secret: the literal prefix `whsec_` followed by base64 of 24–64 random bytes.',
        {
          ...base,
          delivery: {
            mode: 'webhook',
            url: `${CALLBACK_BASE}/bad-prefix`,
            secret: 'not-a-standard-webhooks-secret'
          }
        },
        'A `delivery.secret` without the `whsec_` prefix'
      )
    );

    // Right prefix, too few bytes: 8 decoded, where the floor is 24.
    out.push(
      await expectInvalidParams(
        'sep-9999-subscribe-secret-rejected',
        'Servers MUST reject a `delivery.secret` that is not `whsec_` followed by base64 decoding to 24–64 bytes with `InvalidParams`.',
        {
          ...base,
          delivery: {
            mode: 'webhook',
            url: `${CALLBACK_BASE}/short-secret`,
            secret: `whsec_${Buffer.from(new Uint8Array(8)).toString('base64')}`
          }
        },
        'A `whsec_` secret decoding to 8 bytes, under the 24-byte floor,'
      )
    );

    const nonHttps = await expectInvalidParams(
      'sep-9999-subscribe-url-non-https-rejected',
      'Servers MUST reject `events/subscribe` with a non-`https` `delivery.url` (`-32602 InvalidParams`).',
      {
        ...base,
        delivery: {
          mode: 'webhook',
          url: 'http://conformance.invalid/insecure',
          secret: freshSecret()
        }
      },
      'A subscribe with an `http://` `delivery.url`'
    );
    out.push(nonHttps);
    // The requirement and its enforcement are one probe; report both so the
    // manifest does not carry an untested row for the rule itself.
    out.push(
      eventsCheck(
        'sep-9999-subscribe-url-https-required',
        'Callback URLs MUST use `https://`.',
        nonHttps.status,
        {
          errorMessage: nonHttps.errorMessage,
          details: { gradedBy: 'sep-9999-subscribe-url-non-https-rejected' }
        }
      )
    );

    // A type that does not offer webhook, when the catalog has one.
    const nonWebhook = descriptors.find((d) => {
      const modes = Array.isArray(d.delivery) ? d.delivery : [];
      return modes.length > 0 && !modes.includes('webhook');
    });
    const nonWebhookName = nonWebhook ? descriptorName(nonWebhook) : undefined;
    if (!nonWebhookName) {
      out.push(
        untestableCheck(
          'sep-9999-error-unsupported',
          'sep-9999-error-unsupported',
          '`-32014 Unsupported` — the request is well-formed but a requested capability or option is not supported here.',
          'Every event type the server offers advertises `webhook` delivery, so there is no type to probe the unsupported-mode path with.',
          [EVENTS_SPEC_REF]
        )
      );
    } else {
      const res = await subscribe({
        name: nonWebhookName,
        arguments: {},
        delivery: {
          mode: 'webhook',
          url: `${CALLBACK_BASE}/unsupported`,
          secret: freshSecret()
        },
        cursor: null
      });
      out.push(
        !('error' in res)
          ? eventsCheck(
              'sep-9999-error-unsupported',
              '`-32014 Unsupported` — the request is well-formed but a requested capability or option is not supported here.',
              'FAILURE',
              {
                errorMessage: `Event type \`${nonWebhookName}\` does not advertise \`webhook\` delivery but \`${EVENTS_SUBSCRIBE_METHOD}\` returned a subscription.`
              }
            )
          : res.error.code === EVENTS_UNSUPPORTED
            ? eventsCheck(
                'sep-9999-error-unsupported',
                '`-32014 Unsupported` — the request is well-formed but a requested capability or option is not supported here.',
                'SUCCESS',
                { details: { code: res.error.code } }
              )
            : eventsCheck(
                'sep-9999-error-unsupported',
                '`-32014 Unsupported` — the request is well-formed but a requested capability or option is not supported here.',
                'WARNING',
                {
                  errorMessage: `Subscribing to \`${nonWebhookName}\`, which offers ${JSON.stringify(nonWebhook?.delivery)}, answered ${res.error.code} ${res.error.message} rather than \`-32014 Unsupported\`.`
                }
              )
      );
    }

    // The principal half of the surface. One run, one credential.
    out.push(
      untestableCheck(
        'sep-9999-subscribe-auth-required',
        'sep-9999-subscribe-auth-required',
        '`events/subscribe` and `events/unsubscribe` MUST be called with an authenticated principal; servers MUST reject calls without one with `-32012 Forbidden`.',
        'The harness sends whatever credential it was pointed at, on every request, and has no way to make the same call as an anonymous caller. Grading this needs a runner that can drop its own auth for one probe.',
        [EVENTS_SPEC_REF]
      )
    );

    return out;
  }

  /** The compound key, the derived id, and what a refresh does. */
  private async identityChecks(
    subscribe: (
      p: Record<string, unknown>
    ) => Promise<{ result: SubscribeResult } | { error: JsonRpcError }>,
    release: (url: string, name: string) => Promise<void>,
    first: SubscribeResult,
    name: string,
    args: Record<string, unknown>,
    url: string
  ): Promise<ConformanceCheck[]> {
    const out: ConformanceCheck[] = [];
    const firstId = first.id;

    out.push(
      typeof firstId === 'string' && firstId.length > 0
        ? eventsCheck(
            'sep-9999-subscribe-id-derived',
            'The server computes a deterministic `id` over the key and returns it in the subscribe response. It is stable across refreshes and server restarts.',
            'SUCCESS',
            { details: { id: firstId } }
          )
        : eventsCheck(
            'sep-9999-subscribe-id-derived',
            'The server computes a deterministic `id` over the key and returns it in the subscribe response.',
            'FAILURE',
            {
              errorMessage: `The subscribe response carried \`id\` ${describeValue(firstId)}, expected a string.`
            }
          )
    );

    // Same key again: same id, and the TTL is re-granted in place.
    const again = await subscribe({
      name,
      arguments: args,
      delivery: { mode: 'webhook', url, secret: freshSecret() },
      cursor: null,
      ttlMs: TTL_SUGGESTION_MS
    });
    if ('error' in again) {
      out.push(
        eventsCheck(
          'sep-9999-subscribe-idempotent-upsert',
          '`events/subscribe` is idempotent — calling it again with the same subscription key refreshes the TTL and updates mutable fields.',
          'FAILURE',
          {
            errorMessage: `A second subscribe with the same key answered ${again.error.code} ${again.error.message}; the call is defined as an idempotent upsert.`
          }
        )
      );
      out.push(
        ...untestableAll(
          [
            'sep-9999-subscribe-key-composition',
            'sep-9999-subscribe-key-immutable',
            'sep-9999-subscribe-refresh-replaces-secret'
          ],
          'The repeat subscribe failed, so nothing about key identity could be compared.'
        )
      );
    } else {
      out.push(
        again.result.id === firstId
          ? eventsCheck(
              'sep-9999-subscribe-idempotent-upsert',
              '`events/subscribe` is idempotent — calling it again with the same subscription key refreshes the TTL and updates mutable fields in place.',
              'SUCCESS',
              { details: { id: firstId } }
            )
          : eventsCheck(
              'sep-9999-subscribe-idempotent-upsert',
              '`events/subscribe` is idempotent — calling it again with the same subscription key refreshes the TTL and updates mutable fields in place.',
              'FAILURE',
              {
                errorMessage: `The same key produced a different \`id\` (${describeValue(firstId)} then ${describeValue(again.result.id)}), so the second call created a second subscription.`
              }
            )
      );

      // A refresh carrying a new secret is accepted; whether the next delivery
      // is signed with it belongs to events-webhook-delivery.
      out.push(
        untestableCheck(
          'sep-9999-subscribe-refresh-replaces-secret',
          'sep-9999-subscribe-refresh-replaces-secret',
          'On an idempotent subscribe against an existing key, `delivery.secret` is replaced.',
          'The refresh carrying a new secret was accepted, but confirming the replacement needs a delivery signed with it, which events-webhook-delivery covers.',
          [EVENTS_SPEC_REF],
          'WARNING'
        )
      );
    }

    // Vary one component at a time: a different url, then different arguments.
    const otherUrl = await subscribe({
      name,
      arguments: args,
      delivery: { mode: 'webhook', url: `${url}-other`, secret: freshSecret() },
      cursor: null
    });
    await release(`${url}-other`, name);
    const distinctIds =
      !('error' in otherUrl) &&
      typeof otherUrl.result.id === 'string' &&
      otherUrl.result.id !== firstId;
    out.push(
      'error' in otherUrl
        ? untestableCheck(
            'sep-9999-subscribe-key-composition',
            'sep-9999-subscribe-key-composition',
            'The subscription key is `(principal, delivery.url, name, arguments)`.',
            `A subscribe differing only in \`delivery.url\` answered ${otherUrl.error.code} ${otherUrl.error.message}, so the two keys could not be compared.`,
            [EVENTS_SPEC_REF]
          )
        : distinctIds
          ? eventsCheck(
              'sep-9999-subscribe-key-composition',
              'The subscription key is `(principal, delivery.url, name, arguments)`; a call differing in any component addresses a different subscription.',
              'SUCCESS',
              {
                details: {
                  note: 'Graded on `delivery.url`; the `principal` component needs a second tenant.',
                  ids: [firstId, otherUrl.result.id]
                }
              }
            )
          : eventsCheck(
              'sep-9999-subscribe-key-composition',
              'The subscription key is `(principal, delivery.url, name, arguments)`; a call differing in any component addresses a different subscription.',
              'FAILURE',
              {
                errorMessage: `Two subscriptions differing in \`delivery.url\` share the id ${describeValue(otherUrl.result.id)}, so the URL is not part of the key.`
              }
            )
    );
    out.push(
      'error' in otherUrl
        ? untestableCheck(
            'sep-9999-subscribe-key-immutable',
            'sep-9999-subscribe-key-immutable',
            "All four key components are immutable for the subscription's lifetime.",
            'The second subscription could not be created, so immutability could not be observed.',
            [EVENTS_SPEC_REF]
          )
        : eventsCheck(
            'sep-9999-subscribe-key-immutable',
            "All four components are immutable for the subscription's lifetime: a subscribe call with a different value for any of them addresses a different subscription.",
            distinctIds ? 'SUCCESS' : 'FAILURE',
            {
              errorMessage: distinctIds
                ? undefined
                : 'Changing `delivery.url` did not address a different subscription, so a key component was mutated in place.'
            }
          )
    );

    // `id` is a routing handle, never an input.
    const byId = await subscribe({
      name,
      arguments: args,
      id: firstId,
      delivery: { mode: 'webhook', url: `${url}-by-id`, secret: freshSecret() },
      cursor: null
    });
    await release(`${url}-by-id`, name);
    out.push(
      'error' in byId
        ? eventsCheck(
            'sep-9999-subscribe-id-not-an-input',
            "A caller who learns another tenant's derived `id` gains nothing — `id` is not accepted as input to any method.",
            'SUCCESS',
            {
              details: {
                note: 'The server rejected a subscribe carrying `id`.',
                code: byId.error.code
              }
            }
          )
        : byId.result.id === firstId
          ? eventsCheck(
              'sep-9999-subscribe-id-not-an-input',
              "A caller who learns another tenant's derived `id` gains nothing — `id` is not accepted as input to any method.",
              'FAILURE',
              {
                errorMessage: `A subscribe carrying \`id: ${String(firstId)}\` with a different \`delivery.url\` returned that same id, so \`id\` addressed the subscription instead of the key.`
              }
            )
          : eventsCheck(
              'sep-9999-subscribe-id-not-an-input',
              "A caller who learns another tenant's derived `id` gains nothing — `id` is not accepted as input to any method.",
              'SUCCESS',
              {
                details: {
                  note: 'The supplied `id` was ignored; the key decided the subscription.',
                  ids: [firstId, byId.result.id]
                }
              }
            )
    );

    out.push(
      untestableCheck(
        'sep-9999-subscribe-cross-tenant-isolation',
        'sep-9999-subscribe-cross-tenant-isolation',
        'Because the key includes `principal` and `delivery.url`, two distinct tenants subscribing to the same `(name, arguments)` get distinct subscriptions.',
        'A run holds one principal, so the two-tenant case cannot be constructed. The `delivery.url` half of the same rule is graded by sep-9999-subscribe-key-composition.',
        [EVENTS_SPEC_REF]
      )
    );

    out.push(
      untestableCheck(
        'sep-9999-subscribe-refresh-reactivates',
        'sep-9999-subscribe-refresh-reactivates',
        'On an idempotent subscribe against an existing key, `active` is set to `true` and suspended delivery resumes.',
        'Suspension is observable only through the OPTIONAL `deliveryStatus` object, and reaching it needs sustained delivery failure against a callback the harness controls.',
        [EVENTS_SPEC_REF],
        'WARNING'
      )
    );

    return out;
  }

  /** Teardown by key, and what an unknown key answers. */
  private async unsubscribeChecks(
    conn: Connection,
    first: SubscribeResult,
    name: string,
    args: Record<string, unknown>,
    url: string
  ): Promise<ConformanceCheck[]> {
    const out: ConformanceCheck[] = [];
    const unsubscribe = async (
      params: Record<string, unknown>
    ): Promise<{ ok: true } | { error: JsonRpcError }> => {
      try {
        await conn.request(EVENTS_UNSUBSCRIBE_METHOD, params);
        return { ok: true };
      } catch (err) {
        if (err instanceof JsonRpcError) return { error: err };
        throw err;
      }
    };

    const byKey = await unsubscribe({
      name,
      arguments: args,
      delivery: { mode: 'webhook', url }
    });
    out.push(
      'error' in byKey
        ? eventsCheck(
            'sep-9999-unsubscribe-by-key',
            '`events/unsubscribe` is eager cleanup; the server looks the subscription up by the same compound key used for idempotent upsert on subscribe.',
            'FAILURE',
            {
              errorMessage: `Unsubscribing the subscription just created (id ${describeValue(first.id)}) by its key answered ${byKey.error.code} ${byKey.error.message}.`
            }
          )
        : eventsCheck(
            'sep-9999-unsubscribe-by-key',
            '`events/unsubscribe` is eager cleanup; the server looks the subscription up by the same compound key used for idempotent upsert on subscribe.',
            'SUCCESS',
            { details: { id: first.id } }
          )
    );

    // A key the server cannot hold: never subscribed, and now also the key
    // that was just torn down.
    const unknown = await unsubscribe({
      name,
      arguments: args,
      delivery: { mode: 'webhook', url: `${CALLBACK_BASE}/never-subscribed` }
    });
    out.push(
      'error' in unknown
        ? unknown.error.code === EVENTS_NOT_FOUND
          ? eventsCheck(
              'sep-9999-unsubscribe-unknown-not-found',
              'No subscription matching the key on `events/unsubscribe` returns `-32011 NotFound`.',
              'SUCCESS',
              { details: { code: unknown.error.code } }
            )
          : eventsCheck(
              'sep-9999-unsubscribe-unknown-not-found',
              'No subscription matching the key on `events/unsubscribe` returns `-32011 NotFound`.',
              'WARNING',
              {
                errorMessage: `An unknown subscription key answered ${unknown.error.code} ${unknown.error.message}, where the document names \`-32011 NotFound\`.`
              }
            )
        : eventsCheck(
            'sep-9999-unsubscribe-unknown-not-found',
            'No subscription matching the key on `events/unsubscribe` returns `-32011 NotFound`.',
            'FAILURE',
            {
              errorMessage:
                'Unsubscribing a key that was never subscribed succeeded. A client cannot tell teardown from a no-op, and a typo in the key reads as success.'
            }
          )
    );

    return out;
  }
}

/** Keep the first check emitted per id, so a fallback path cannot double-report. */
function dedupe(checks: ConformanceCheck[]): ConformanceCheck[] {
  const seen = new Set<string>();
  return checks.filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
}
