/**
 * agents-wg#22 (MCP Agent Discovery Extension): roster changes over
 * `subscriptions/listen`.
 *
 * `notifications/agents/list_changed` reaches a client only on a listen
 * stream it opened with `agentsListChanged: true`, and the server's
 * acknowledgement says whether it will honor that. The rows hang off one
 * stream:
 *
 * - a server that did not declare `listChanged: true` must not acknowledge
 *   the key, since the proposal says such notifications are not supported;
 * - a server that did declare it acknowledges the key, and sends the
 *   notification when its roster changes. The harness cannot change a roster
 *   over the protocol, so it asks the server's `agents_conformance_add_agent`
 *   control to add one, waits for the notification, then re-lists.
 *
 * Check IDs carry the placeholder number 9998; see src/seps/sep-9998.yaml.
 */

import { ClientScenario, ConformanceCheck } from '../../../types';
import type { RunContext } from '../../../connection';
import { untestableCheck } from '../../untestable';
import { openListenStream } from './listen-stream';
import {
  AGENTS_CLIENT_CAPABILITIES,
  AGENTS_EXTENSION_ID,
  AGENTS_LIST_CHANGED_FILTER_KEY,
  AGENTS_LIST_CHANGED_NOTIFICATION,
  AGENTS_SPEC_REF,
  CONTROL_ADD_AGENT,
  SUBSCRIPTIONS_ACKNOWLEDGED_NOTIFICATION,
  SUBSCRIPTIONS_LISTEN_METHOD,
  agentsCheck,
  agentsListAll,
  askControl,
  declaredAgentsCapability,
  isObject,
  toolsListAll
} from './helpers';

const NOT_DECLARED_ID = 'sep-9998-list-changed-not-declared';
const ACK_ID = 'sep-9998-list-changed-acknowledged';
const NOTIFICATION_ID = 'sep-9998-list-changed-notification';
const ROSTER_ID = 'sep-9998-list-changed-roster-updated';

const ALL_IDS = [NOT_DECLARED_ID, ACK_ID, NOTIFICATION_ID, ROSTER_ID] as const;
type CheckId = (typeof ALL_IDS)[number];

const DESCRIPTIONS: Record<CheckId, string> = {
  [NOT_DECLARED_ID]:
    'A server that does not declare listChanged: true does not acknowledge agentsListChanged on subscriptions/listen.',
  [ACK_ID]:
    'A server declaring listChanged: true acknowledges agentsListChanged on subscriptions/listen.',
  [NOTIFICATION_ID]:
    'A server declaring listChanged: true sends notifications/agents/list_changed on the listen stream when its roster changes.',
  [ROSTER_ID]:
    'After the notification, agents/list shows the change it announced.'
};

const LISTEN_ACK_MS = 3000;
const LIST_CHANGED_MS = 5000;

function graded(
  id: CheckId,
  errs: string[],
  details?: Record<string, unknown>,
  failStatus: 'FAILURE' | 'WARNING' = 'FAILURE'
): ConformanceCheck {
  return agentsCheck(
    id,
    DESCRIPTIONS[id],
    errs.length === 0 ? 'SUCCESS' : failStatus,
    errs.length === 0
      ? details
        ? { details }
        : {}
      : { errorMessage: errs.join('; '), details }
  );
}

function skipped(id: CheckId, reason: string): ConformanceCheck {
  return agentsCheck(id, DESCRIPTIONS[id], 'SKIPPED', { errorMessage: reason });
}

function untestable(
  id: CheckId,
  reason: string,
  severity: 'FAILURE' | 'WARNING' = 'FAILURE'
): ConformanceCheck {
  return untestableCheck(
    id,
    id,
    DESCRIPTIONS[id],
    reason,
    [AGENTS_SPEC_REF],
    severity
  );
}

export class AgentsListChangedScenario implements ClientScenario {
  name = 'sep-9998-agents-list-changed';
  readonly source = { extensionId: AGENTS_EXTENSION_ID } as const;
  description = `agents-wg#22 MCP Agent Discovery Extension: \`notifications/agents/list_changed\` over \`subscriptions/listen\`.

**Requirements covered** (each check carries a verbatim quote of the proposal in src/seps/sep-9998.yaml; 9998 is a placeholder number):
- \`${NOT_DECLARED_ID}\`: without \`listChanged: true\`, the server does not acknowledge \`${AGENTS_LIST_CHANGED_FILTER_KEY}\`
- \`${ACK_ID}\`: with it, the server acknowledges the key
- \`${NOTIFICATION_ID}\`: a roster change, made through the \`${CONTROL_ADD_AGENT}\` control, sends the notification on the acknowledged stream
- \`${ROSTER_ID}\`: re-listing afterwards shows the added agent

Without the \`${CONTROL_ADD_AGENT}\` control the last two rows report untestable.`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const conn = await ctx.connect({
      capabilities: AGENTS_CLIENT_CAPABILITIES
    });
    try {
      const declaration = await declaredAgentsCapability(conn);
      if (!declaration.declared) {
        const reason = `The server did not declare ${AGENTS_EXTENSION_ID}; the extension is optional.`;
        return ALL_IDS.map((id) => skipped(id, reason));
      }
      const settings = isObject(declaration.value) ? declaration.value : {};
      const declaredTrue = settings.listChanged === true;

      const session = await openListenStream(
        ctx.serverUrl,
        ctx.specVersion,
        {
          notifications: { [AGENTS_LIST_CHANGED_FILTER_KEY]: true },
          _meta: {
            'io.modelcontextprotocol/clientCapabilities':
              AGENTS_CLIENT_CAPABILITIES
          }
        },
        { method: SUBSCRIPTIONS_LISTEN_METHOD, openTimeoutMs: LISTEN_ACK_MS }
      );
      try {
        const ack = session.contentType?.includes('text/event-stream')
          ? await session.waitFor(
              (n) => n.method === SUBSCRIPTIONS_ACKNOWLEDGED_NOTIFICATION,
              LISTEN_ACK_MS
            )
          : undefined;
        if (!ack) {
          const why = session.error
            ? `${SUBSCRIPTIONS_LISTEN_METHOD} failed: ${session.error.code} ${session.error.message}`
            : `${SUBSCRIPTIONS_LISTEN_METHOD} did not confirm with ${SUBSCRIPTIONS_ACKNOWLEDGED_NOTIFICATION} within ${LISTEN_ACK_MS}ms (HTTP ${session.status}, ${session.contentType ?? 'no content type'})`;
          if (!declaredTrue) {
            return [
              untestable(NOT_DECLARED_ID, why),
              skipped(ACK_ID, 'The server did not declare listChanged: true.'),
              skipped(
                NOTIFICATION_ID,
                'The server did not declare listChanged: true.'
              ),
              skipped(
                ROSTER_ID,
                'The server did not declare listChanged: true.'
              )
            ];
          }
          return [
            skipped(NOT_DECLARED_ID, 'The server declared listChanged: true.'),
            graded(ACK_ID, [why]),
            untestable(NOTIFICATION_ID, why),
            untestable(ROSTER_ID, why, 'WARNING')
          ];
        }

        const honored = isObject(ack.params.notifications)
          ? ack.params.notifications
          : {};
        const echoed = honored[AGENTS_LIST_CHANGED_FILTER_KEY] === true;

        if (!declaredTrue) {
          return [
            graded(
              NOT_DECLARED_ID,
              echoed
                ? [
                    `The server declared listChanged: ${JSON.stringify(settings.listChanged ?? false)} but acknowledged ${AGENTS_LIST_CHANGED_FILTER_KEY}, promising notifications it says it does not support.`
                  ]
                : [],
              { listChanged: settings.listChanged, honored }
            ),
            skipped(ACK_ID, 'The server did not declare listChanged: true.'),
            skipped(
              NOTIFICATION_ID,
              'The server did not declare listChanged: true.'
            ),
            skipped(ROSTER_ID, 'The server did not declare listChanged: true.')
          ];
        }

        const checks: ConformanceCheck[] = [
          skipped(
            NOT_DECLARED_ID,
            'The server declared listChanged: true; the rule covers servers that did not.'
          )
        ];
        if (!echoed) {
          const why = `The server declared listChanged: true but its acknowledgement does not honor ${AGENTS_LIST_CHANGED_FILTER_KEY}, which is the only channel the notification travels on.`;
          checks.push(graded(ACK_ID, [why], { honored }));
          checks.push(graded(NOTIFICATION_ID, [why], { honored }));
          checks.push(skipped(ROSTER_ID, 'No notification can arrive.'));
          return checks;
        }
        checks.push(graded(ACK_ID, [], { honored }));

        const tools = await toolsListAll(conn);
        const hasControl =
          Array.isArray(tools) &&
          tools.some((t) => t.name === CONTROL_ADD_AGENT);
        const name = `mcp-conformance-added-${Math.random().toString(36).slice(2, 10)}`;
        const added = hasControl
          ? await askControl(conn, CONTROL_ADD_AGENT, { name })
          : undefined;
        if (added === undefined) {
          const why = hasControl
            ? `The ${CONTROL_ADD_AGENT} control rejected {name: "${name}"}.`
            : `The server exposes no ${CONTROL_ADD_AGENT} control, and the harness has no other way to change its roster mid-run.`;
          checks.push(untestable(NOTIFICATION_ID, why));
          checks.push(untestable(ROSTER_ID, why, 'WARNING'));
          return checks;
        }

        const hit = await session.waitFor(
          (n) => n.method === AGENTS_LIST_CHANGED_NOTIFICATION,
          LIST_CHANGED_MS
        );
        checks.push(
          graded(
            NOTIFICATION_ID,
            hit
              ? []
              : [
                  `Added agent "${name}" through ${CONTROL_ADD_AGENT}, and no ${AGENTS_LIST_CHANGED_NOTIFICATION} arrived on the acknowledged listen stream within ${LIST_CHANGED_MS}ms.`
                ],
            hit ? { added: name, atMs: hit.atMs } : { added: name }
          )
        );

        const relisted = await agentsListAll(conn);
        const names =
          'error' in relisted
            ? undefined
            : relisted.pages
                .flatMap((p) => p.agents)
                .map((c) => (isObject(c) ? c.name : undefined));
        checks.push(
          graded(
            ROSTER_ID,
            names === undefined
              ? [
                  `agents/list failed after the change: ${'error' in relisted ? relisted.error.message : ''}`
                ]
              : names.includes(name)
                ? []
                : [
                    `agents/list does not list "${name}" after the server announced a roster change.`
                  ],
            { added: name },
            'WARNING'
          )
        );
        return checks;
      } finally {
        await session.cancel();
      }
    } finally {
      await conn.close();
    }
  }
}

export const AGENTS_LIST_CHANGED_CHECK_IDS = ALL_IDS;
