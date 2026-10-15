/**
 * agents-wg#22 (MCP Agent Discovery Extension): the capability, the roster
 * (`agents/list`), the details (`agents/get`), tool parity with `tools/list`,
 * and the two error reasons.
 *
 * One scenario, many checks (per AGENTS.md "fewer scenarios, more checks").
 * Each check's verbatim quote of the proposal lives next to its check ID in
 * src/seps/sep-9998.yaml. 9998 is a placeholder number; the yaml header says
 * why.
 *
 * Discovery is dynamic. The scenario lists whatever roster the server serves
 * and opens every agent in it, hardcoding no agent name. Two rows need agents
 * the harness cannot find by listing: one hidden from this caller and one
 * whose membership names a missing tool. It asks the server's
 * `agents_conformance_fixture` control for their names, and reports those rows
 * untestable when the control is absent.
 *
 * The capability gate is two-sided, as in the skills and events suites. A
 * server that neither declares the extension nor answers `agents/list` skips
 * the scenario, since the extension is optional. A server that answers
 * `agents/list` while declaring nothing fails the capability row, because a
 * client following the proposal would never call it.
 */

import { isDeepStrictEqual } from 'util';
import { ClientScenario, ConformanceCheck } from '../../../types';
import type { RunContext } from '../../../connection';
import { untestableCheck } from '../../untestable';
import {
  AGENTS_CLIENT_CAPABILITIES,
  AGENTS_EXTENSION_ID,
  AGENTS_LIST_METHOD,
  AGENTS_SPEC_REF,
  CONTROL_FIXTURE,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  MODEL_ROLES,
  REASON_AGENT_NOT_FOUND,
  REASON_INVALID_AGENT_DEFINITION,
  UNKNOWN_AGENT_NAME,
  agentsCheck,
  agentsGet,
  agentsListAll,
  cacheableResultErrors,
  declaredAgentsCapability,
  describeValue,
  errorReason,
  fixtureNames,
  isObject,
  joinErrs,
  toolsListAll,
  type RpcFailure
} from './helpers';

const CAPABILITY_IDS = [
  'sep-9998-capability-declared',
  'sep-9998-capability-list-changed-boolean',
  'sep-9998-core-without-extension'
] as const;

const LIST_IDS = [
  'sep-9998-list-implemented',
  'sep-9998-list-result-shape',
  'sep-9998-list-pagination',
  'sep-9998-list-cacheable',
  'sep-9998-card-name',
  'sep-9998-card-description-type',
  'sep-9998-card-capabilities',
  'sep-9998-list-cards-only',
  'sep-9998-name-unique'
] as const;

const GET_IDS = [
  'sep-9998-get-implemented',
  'sep-9998-get-result-shape',
  'sep-9998-get-agent-name',
  'sep-9998-get-cacheable',
  'sep-9998-hint-role',
  'sep-9998-hint-vision'
] as const;

const PARITY_IDS = [
  'sep-9998-get-tools-in-tools-list',
  'sep-9998-get-tools-intersection',
  'sep-9998-tools-list-not-omitted',
  'sep-9998-get-tools-fields-match',
  'sep-9998-shared-tool-same-definition'
] as const;

const ERROR_IDS = [
  'sep-9998-agent-not-found',
  'sep-9998-hidden-indistinguishable',
  'sep-9998-roster-filtered',
  'sep-9998-invalid-agent-definition'
] as const;

const ALL_IDS = [
  ...CAPABILITY_IDS,
  ...LIST_IDS,
  ...GET_IDS,
  ...PARITY_IDS,
  ...ERROR_IDS
];

/** One-line descriptions, keyed by check ID, used on every status. */
const DESCRIPTIONS: Record<(typeof ALL_IDS)[number], string> = {
  'sep-9998-capability-declared':
    'The server declares io.modelcontextprotocol/agents under capabilities.extensions with a settings object.',
  'sep-9998-capability-list-changed-boolean':
    'The optional listChanged setting, when present, is a boolean.',
  'sep-9998-core-without-extension':
    'A client that does not declare the extension can still use core MCP functionality (tools/list).',
  'sep-9998-list-implemented':
    'agents/list returns the roster visible to the requesting client.',
  'sep-9998-list-result-shape':
    'Every agents/list page carries resultType "complete" and an agents array.',
  'sep-9998-list-pagination':
    'Following nextCursor from the first page reaches a page without one.',
  'sep-9998-list-cacheable':
    'Every agents/list page follows CacheableResult: ttlMs is a non-negative number and cacheScope is "public" or "private".',
  'sep-9998-card-name': 'Every agent card carries a string name.',
  'sep-9998-card-description-type':
    'An agent card description, when present, is a string.',
  'sep-9998-card-capabilities':
    'Every agent card carries capabilities as an array of strings.',
  'sep-9998-list-cards-only':
    'The roster carries compact cards only, without instructions, tools or modelRoutingHint.',
  'sep-9998-name-unique':
    'Agent names are unique within the roster visible to the caller, across every page.',
  'sep-9998-get-implemented':
    'agents/get returns details for every agent the roster lists.',
  'sep-9998-get-result-shape':
    'agents/get results carry resultType "complete", a tools array, and instructions as a string when present.',
  'sep-9998-get-agent-name':
    'agents/get result.agent names the agent that was requested.',
  'sep-9998-get-cacheable':
    'Every agents/get result follows CacheableResult: ttlMs is a non-negative number and cacheScope is "public" or "private".',
  'sep-9998-hint-role':
    'modelRoutingHint.role, when present, is "small", "medium" or "large".',
  'sep-9998-hint-vision':
    'modelRoutingHint, when present, is an object carrying a boolean vision.',
  'sep-9998-get-tools-in-tools-list':
    'Every tool agents/get returns is also listed by tools/list.',
  'sep-9998-get-tools-intersection':
    "agents/get includes no tool absent from the caller's tools/list.",
  'sep-9998-tools-list-not-omitted':
    'tools/list does not omit a tool because an agent includes it.',
  'sep-9998-get-tools-fields-match':
    'A tool returned by both agents/get and tools/list has identical fields in both.',
  'sep-9998-shared-tool-same-definition':
    'A tool name that appears under several agents identifies the same tool in each.',
  'sep-9998-agent-not-found':
    'agents/get for an unknown agent fails with -32602 and data.reason "agent_not_found".',
  'sep-9998-hidden-indistinguishable':
    'agents/get for an agent hidden from the caller fails exactly as it does for a nonexistent name.',
  'sep-9998-roster-filtered':
    'An agent hidden from the caller is absent from its agents/list roster.',
  'sep-9998-invalid-agent-definition':
    'agents/get for an agent whose membership names a missing tool fails with -32603 and data.reason "invalid_agent_definition".'
};

/** Card members that belong to agents/get, never to the roster. */
const DETAIL_MEMBERS = ['instructions', 'tools', 'modelRoutingHint', 'agent'];

type CheckId = (typeof ALL_IDS)[number];

function check(
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
      : { errorMessage: joinErrs(errs), details }
  );
}

function skipped(id: CheckId, reason: string): ConformanceCheck {
  return agentsCheck(id, DESCRIPTIONS[id], 'SKIPPED', {
    errorMessage: reason
  });
}

function untestable(id: CheckId, reason: string): ConformanceCheck {
  return untestableCheck(id, id, DESCRIPTIONS[id], reason, [AGENTS_SPEC_REF]);
}

function describeFailure(f: RpcFailure): string {
  return `${f.code} ${JSON.stringify(f.message)}${f.data === undefined ? '' : ` data=${JSON.stringify(f.data)}`}`;
}

export class AgentsDiscoveryScenario implements ClientScenario {
  name = 'sep-9998-agents-discovery';
  readonly source = { extensionId: AGENTS_EXTENSION_ID } as const;
  description = `agents-wg#22 MCP Agent Discovery Extension: the capability, \`agents/list\`, \`agents/get\`, tool parity with \`tools/list\`, and the error reasons.

**Methods**: \`agents/list\`, \`agents/get\` (for a server declaring \`${AGENTS_EXTENSION_ID}\`)

**Requirements covered** (each check carries a verbatim quote of the proposal in src/seps/sep-9998.yaml; 9998 is a placeholder number):
- \`sep-9998-capability-*\`, \`sep-9998-core-without-extension\`: the declaration, and that core functionality does not depend on it
- \`sep-9998-list-*\`, \`sep-9998-card-*\`, \`sep-9998-name-unique\`: the roster's shape, paging and cache hints
- \`sep-9998-get-*\`, \`sep-9998-hint-*\`: the flat details result and its optional routing hint
- \`sep-9998-get-tools-*\`, \`sep-9998-tools-list-not-omitted\`, \`sep-9998-shared-tool-same-definition\`: every returned tool matches \`tools/list\`
- \`sep-9998-agent-not-found\`, \`sep-9998-hidden-indistinguishable\`, \`sep-9998-roster-filtered\`, \`sep-9998-invalid-agent-definition\`: the error reasons and visibility

The hidden-agent and broken-agent rows need the server's \`${CONTROL_FIXTURE}\` control; without it they report untestable.`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const conn = await ctx.connect({
      capabilities: AGENTS_CLIENT_CAPABILITIES
    });
    try {
      const declaration = await declaredAgentsCapability(conn);
      const listed = await agentsListAll(conn);

      if (!declaration.declared) {
        if ('error' in listed) {
          const reason = `The server did not declare ${AGENTS_EXTENSION_ID}, and ${AGENTS_LIST_METHOD} failed (${describeFailure(listed.error)}); the extension is optional.`;
          return ALL_IDS.map((id) => skipped(id, reason));
        }
        const reason = `The server answers ${AGENTS_LIST_METHOD} but does not declare ${AGENTS_EXTENSION_ID} under capabilities.extensions, so a client following the proposal never calls it.`;
        return ALL_IDS.map((id) =>
          id === 'sep-9998-capability-declared'
            ? check(id, [reason])
            : skipped(
                id,
                'The extension is not declared; see sep-9998-capability-declared.'
              )
        );
      }

      const checks: ConformanceCheck[] = [];
      const settings = declaration.value;

      // === capability ===
      checks.push(
        check(
          'sep-9998-capability-declared',
          isObject(settings)
            ? []
            : [
                `capabilities.extensions["${AGENTS_EXTENSION_ID}"] is ${describeValue(settings)}, not a settings object`
              ],
          { settings }
        )
      );
      if (isObject(settings) && 'listChanged' in settings) {
        checks.push(
          check(
            'sep-9998-capability-list-changed-boolean',
            typeof settings.listChanged === 'boolean'
              ? []
              : [
                  `listChanged is ${describeValue(settings.listChanged)}, not a boolean`
                ],
            { listChanged: settings.listChanged }
          )
        );
      } else {
        checks.push(
          skipped(
            'sep-9998-capability-list-changed-boolean',
            'The optional listChanged setting is absent.'
          )
        );
      }

      // A second connection that does not declare the extension.
      const plain = await ctx.connect();
      let coreTools: Record<string, unknown>[] | RpcFailure;
      try {
        coreTools = await toolsListAll(plain);
      } finally {
        await plain.close();
      }
      checks.push(
        check(
          'sep-9998-core-without-extension',
          Array.isArray(coreTools)
            ? []
            : [
                `tools/list failed for a client that did not declare the extension: ${describeFailure(coreTools)}`
              ]
        )
      );

      // === roster ===
      if ('error' in listed) {
        const reason = `${AGENTS_LIST_METHOD} failed: ${describeFailure(listed.error)}`;
        checks.push(check('sep-9998-list-implemented', [reason]));
        for (const id of ALL_IDS) {
          if (!checks.some((c) => c.id === id)) {
            checks.push(skipped(id, `${AGENTS_LIST_METHOD} is unavailable.`));
          }
        }
        return checks;
      }
      const { pages, truncated } = listed;
      checks.push(
        check('sep-9998-list-implemented', [], { pages: pages.length })
      );

      const shapeErrs: string[] = [];
      const cacheErrs: string[] = [];
      pages.forEach((page, i) => {
        if (page.result.resultType !== 'complete') {
          shapeErrs.push(
            `page ${i + 1}: resultType is ${JSON.stringify(page.result.resultType)}`
          );
        }
        if (!Array.isArray(page.result.agents)) {
          shapeErrs.push(
            `page ${i + 1}: agents is ${describeValue(page.result.agents)}`
          );
        }
        for (const e of cacheableResultErrors(page.result)) {
          cacheErrs.push(`page ${i + 1}: ${e}`);
        }
      });
      checks.push(check('sep-9998-list-result-shape', shapeErrs));
      checks.push(
        check(
          'sep-9998-list-pagination',
          truncated
            ? [
                `${AGENTS_LIST_METHOD} did not terminate: the server kept returning a nextCursor, or repeated one, across ${pages.length} pages`
              ]
            : [],
          { pages: pages.length }
        )
      );
      checks.push(check('sep-9998-list-cacheable', cacheErrs));

      const cards = pages.flatMap((p) => p.agents);
      const nameErrs: string[] = [];
      const descErrs: string[] = [];
      const capErrs: string[] = [];
      const cardsOnlyErrs: string[] = [];
      const names: string[] = [];
      cards.forEach((card, i) => {
        if (!isObject(card)) {
          nameErrs.push(`card ${i} is ${describeValue(card)}`);
          return;
        }
        const label =
          typeof card.name === 'string' ? `"${card.name}"` : `card ${i}`;
        if (typeof card.name !== 'string' || card.name === '') {
          nameErrs.push(`${label}: name is ${describeValue(card.name)}`);
        } else {
          names.push(card.name);
        }
        if ('description' in card && typeof card.description !== 'string') {
          descErrs.push(
            `${label}: description is ${describeValue(card.description)}`
          );
        }
        if (
          !Array.isArray(card.capabilities) ||
          card.capabilities.some((c) => typeof c !== 'string')
        ) {
          capErrs.push(
            `${label}: capabilities is ${Array.isArray(card.capabilities) ? 'an array with a non-string entry' : describeValue(card.capabilities)}`
          );
        }
        const leaked = DETAIL_MEMBERS.filter((m) => m in card);
        if (leaked.length > 0) {
          cardsOnlyErrs.push(`${label} carries ${leaked.join(', ')}`);
        }
      });
      checks.push(
        check('sep-9998-card-name', nameErrs, { cards: cards.length })
      );
      checks.push(check('sep-9998-card-description-type', descErrs));
      checks.push(check('sep-9998-card-capabilities', capErrs));
      checks.push(
        check('sep-9998-list-cards-only', cardsOnlyErrs, undefined, 'WARNING')
      );
      const dupes = names.filter((n, i) => names.indexOf(n) !== i);
      checks.push(
        check(
          'sep-9998-name-unique',
          dupes.length > 0
            ? [
                `name(s) listed more than once: ${[...new Set(dupes)].join(', ')}`
              ]
            : [],
          { names }
        )
      );

      // === details ===
      const tools = await toolsListAll(conn);
      const toolList = Array.isArray(tools) ? tools : [];
      const fixture = await fixtureNames(conn, toolList);
      const broken = fixture?.brokenAgent;
      const toOpen = [...new Set(names)].filter((n) => n !== broken);

      const details: Array<{ name: string; result: Record<string, unknown> }> =
        [];
      const getErrs: string[] = [];
      for (const name of toOpen) {
        const got = await agentsGet(conn, name);
        if ('error' in got) {
          getErrs.push(`"${name}": ${describeFailure(got.error)}`);
        } else {
          details.push({ name, result: got.result });
        }
      }

      if (toOpen.length === 0) {
        const reason =
          'The roster lists no agent to open, so there are no details to grade.';
        for (const id of [...GET_IDS, ...PARITY_IDS]) {
          checks.push(skipped(id, reason));
        }
      } else {
        checks.push(
          check('sep-9998-get-implemented', getErrs, { opened: toOpen.length })
        );
        const resultErrs: string[] = [];
        const agentNameErrs: string[] = [];
        const getCacheErrs: string[] = [];
        const roleErrs: string[] = [];
        const visionErrs: string[] = [];
        let hinted = 0;
        for (const { name, result } of details) {
          if (result.resultType !== 'complete') {
            resultErrs.push(
              `"${name}": resultType is ${JSON.stringify(result.resultType)}`
            );
          }
          if (!Array.isArray(result.tools)) {
            resultErrs.push(
              `"${name}": tools is ${describeValue(result.tools)}`
            );
          }
          if (
            'instructions' in result &&
            typeof result.instructions !== 'string'
          ) {
            resultErrs.push(
              `"${name}": instructions is ${describeValue(result.instructions)}`
            );
          }
          if ('agent' in result === false || result.agent !== name) {
            agentNameErrs.push(
              `requested "${name}", result.agent is ${JSON.stringify(result.agent)}`
            );
          }
          for (const e of cacheableResultErrors(result)) {
            getCacheErrs.push(`"${name}": ${e}`);
          }
          if ('modelRoutingHint' in result) {
            hinted++;
            const hint = result.modelRoutingHint;
            if (!isObject(hint)) {
              visionErrs.push(
                `"${name}": modelRoutingHint is ${describeValue(hint)}`
              );
              continue;
            }
            if (typeof hint.vision !== 'boolean') {
              visionErrs.push(
                `"${name}": vision is ${describeValue(hint.vision)}`
              );
            }
            if (
              'role' in hint &&
              !(MODEL_ROLES as readonly unknown[]).includes(hint.role)
            ) {
              roleErrs.push(`"${name}": role is ${JSON.stringify(hint.role)}`);
            }
          }
        }
        checks.push(check('sep-9998-get-result-shape', resultErrs));
        checks.push(check('sep-9998-get-agent-name', agentNameErrs));
        checks.push(check('sep-9998-get-cacheable', getCacheErrs));
        if (hinted === 0) {
          const reason =
            'No agent returned the optional modelRoutingHint, so there is no hint to grade.';
          checks.push(skipped('sep-9998-hint-role', reason));
          checks.push(skipped('sep-9998-hint-vision', reason));
        } else {
          checks.push(check('sep-9998-hint-role', roleErrs, { hinted }));
          checks.push(check('sep-9998-hint-vision', visionErrs, { hinted }));
        }

        // === parity with tools/list ===
        if (!Array.isArray(tools)) {
          const reason = `tools/list failed (${describeFailure(tools)}), so returned tools cannot be compared with it.`;
          for (const id of PARITY_IDS) checks.push(untestable(id, reason));
        } else {
          const listedByName = new Map(
            tools.map((t) => [String(t.name), t] as const)
          );
          const missing: string[] = [];
          const differ: string[] = [];
          const byToolName = new Map<
            string,
            { agent: string; def: unknown }[]
          >();
          for (const { name, result } of details) {
            for (const t of Array.isArray(result.tools) ? result.tools : []) {
              const tn = isObject(t) ? String(t.name) : String(t);
              const seen = byToolName.get(tn) ?? [];
              seen.push({ agent: name, def: t });
              byToolName.set(tn, seen);
              const listedDef = listedByName.get(tn);
              if (!listedDef) {
                missing.push(`"${name}" returns "${tn}"`);
              } else if (!isDeepStrictEqual(listedDef, t)) {
                differ.push(`"${tn}" under "${name}"`);
              }
            }
          }
          const missingErrs = missing.map(
            (m) => `${m}, which tools/list does not list`
          );
          checks.push(check('sep-9998-get-tools-in-tools-list', missingErrs));
          checks.push(check('sep-9998-get-tools-intersection', missingErrs));
          checks.push(check('sep-9998-tools-list-not-omitted', missingErrs));
          checks.push(
            check(
              'sep-9998-get-tools-fields-match',
              differ.map((d) => `${d} differs from its tools/list entry`)
            )
          );
          const shared = [...byToolName.entries()].filter(
            ([, uses]) => new Set(uses.map((u) => u.agent)).size > 1
          );
          if (shared.length === 0) {
            checks.push(
              skipped(
                'sep-9998-shared-tool-same-definition',
                'No tool name appears under more than one agent.'
              )
            );
          } else {
            const sharedErrs = shared
              .filter(([, uses]) =>
                uses.some((u) => !isDeepStrictEqual(u.def, uses[0].def))
              )
              .map(
                ([tn, uses]) =>
                  `"${tn}" differs between ${uses.map((u) => `"${u.agent}"`).join(' and ')}`
              );
            checks.push(
              check('sep-9998-shared-tool-same-definition', sharedErrs, {
                shared: shared.map(([tn]) => tn)
              })
            );
          }
        }
      }

      // === errors and visibility ===
      const unknown = await agentsGet(conn, UNKNOWN_AGENT_NAME);
      const unknownFailure = 'error' in unknown ? unknown.error : undefined;
      checks.push(
        check(
          'sep-9998-agent-not-found',
          unknownFailure === undefined
            ? [`agents/get "${UNKNOWN_AGENT_NAME}" succeeded`]
            : unknownFailure.code !== JSONRPC_INVALID_PARAMS ||
                errorReason(unknownFailure) !== REASON_AGENT_NOT_FOUND
              ? [
                  `agents/get for an unknown name failed with ${describeFailure(unknownFailure)}`
                ]
              : [],
          unknownFailure ? { error: unknownFailure } : undefined
        )
      );

      const noControl = `The server exposes no ${CONTROL_FIXTURE} control naming the agent this row needs, and an agent hidden from this caller cannot be found any other way.`;
      const hidden = fixture?.hiddenAgent;
      if (!hidden) {
        checks.push(untestable('sep-9998-hidden-indistinguishable', noControl));
        checks.push(untestable('sep-9998-roster-filtered', noControl));
      } else {
        const got = await agentsGet(conn, hidden);
        const errs: string[] = [];
        if (!('error' in got)) {
          errs.push(
            `agents/get "${hidden}" succeeded for an agent the server reports as hidden from this caller`
          );
        } else if (unknownFailure === undefined) {
          errs.push(
            'the unknown-name probe did not fail, so there is no not-found response to compare with'
          );
        } else {
          if (got.error.code !== unknownFailure.code) {
            errs.push(
              `code ${got.error.code} for the hidden agent, ${unknownFailure.code} for an unknown name`
            );
          }
          if (got.error.message !== unknownFailure.message) {
            errs.push(
              `message ${JSON.stringify(got.error.message)} for the hidden agent, ${JSON.stringify(unknownFailure.message)} for an unknown name`
            );
          }
          if (!isDeepStrictEqual(got.error.data, unknownFailure.data)) {
            errs.push(
              `data ${JSON.stringify(got.error.data)} for the hidden agent, ${JSON.stringify(unknownFailure.data)} for an unknown name`
            );
          }
        }
        checks.push(
          check('sep-9998-hidden-indistinguishable', errs, { hidden })
        );
        checks.push(
          check(
            'sep-9998-roster-filtered',
            names.includes(hidden)
              ? [
                  `agents/list lists "${hidden}", which the server reports as hidden from this caller`
                ]
              : [],
            { hidden }
          )
        );
      }

      if (!broken) {
        checks.push(
          untestable(
            'sep-9998-invalid-agent-definition',
            `The server exposes no ${CONTROL_FIXTURE} control naming an agent whose membership references a missing tool.`
          )
        );
      } else {
        const got = await agentsGet(conn, broken);
        checks.push(
          check(
            'sep-9998-invalid-agent-definition',
            !('error' in got)
              ? [
                  `agents/get "${broken}" succeeded for an agent whose membership names a missing tool`
                ]
              : got.error.code !== JSONRPC_INTERNAL_ERROR ||
                  errorReason(got.error) !== REASON_INVALID_AGENT_DEFINITION
                ? [
                    `agents/get "${broken}" failed with ${describeFailure(got.error)}`
                  ]
                : [],
            { broken }
          )
        );
      }

      return checks;
    } finally {
      await conn.close();
    }
  }
}

export const AGENTS_DISCOVERY_CHECK_IDS = ALL_IDS;
