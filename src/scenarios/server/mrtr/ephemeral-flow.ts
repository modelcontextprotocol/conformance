/**
 * SEP-2322 MRTR ephemeral InputRequiredResult flow.
 *
 * Tests the multi-round-trip-request contract end-to-end against any
 * server that implements SEP-2322's ephemeral path: tools/call returns
 * `InputRequiredResult` to gather input, the client retries the SAME
 * tools/call with `inputResponses` (and echoed `requestState`), and
 * the server eventually returns a normal `ToolResult`. No task
 * envelope, no separate methods.
 *
 * Required server fixtures (tools/list output must include all):
 *   - test_tool_with_elicitation              — single elicitation/create round
 *   - test_incomplete_result_sampling         — single sampling/createMessage round
 *   - test_incomplete_result_list_roots       — single roots/list round
 *   - test_incomplete_result_request_state    — exercises requestState validation
 *   - test_incomplete_result_multiple_inputs  — emits 3+ inputRequests in one round
 *   - test_incomplete_result_multi_round      — drives 2+ MRTR rounds
 *   - test_incomplete_result_elicitation      — emits inputRequest for "user_name";
 *                                               server re-requests on wrong key
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  ClientScenario,
  ConformanceCheck,
  ScenarioSpecTag,
  DRAFT_PROTOCOL_VERSION
} from '../../../types';
import { AnyResult } from '../tasks/helpers';
import {
  MRTR_INPUT_REQUIRED_RESULT_TYPE,
  SEP_2322_REF,
  errMsg,
  failureCheck,
  isCompleteResult,
  isInputRequiredResult,
  mockElicitResponse,
  mockListRootsResponse,
  mockSamplingResponse
} from './helpers';

export class MrtrEphemeralFlowScenario implements ClientScenario {
  name = 'mrtr-ephemeral-flow';
  // MRTR is in draft alongside SEP-2322; tagged 'extension' because it
  // introduces an ephemeral resultType discriminator that's not on the
  // dated-spec timeline yet.
  specVersions: ScenarioSpecTag[] = ['extension', DRAFT_PROTOCOL_VERSION];
  description = `Test SEP-2322 ephemeral MRTR (Multi Round-Trip Request) flow.

**Server Implementation Requirements:**

Every \`tools/call\` response in the MRTR contract is one of:
- \`resultType:"${MRTR_INPUT_REQUIRED_RESULT_TYPE}"\` — server is asking for
  more input; carries an \`inputRequests\` map keyed by server-minted
  opaque ids and (optionally) a \`requestState\` token to echo on the
  next round.
- \`resultType:"complete"\` (or absent — current SDKs may strip the
  discriminator on responses without one) — the tools/call has finished;
  the body is a normal \`ToolResult\` with \`content[]\`.

**Round-trip rules (SEP-2322):**
- Round 1 with no \`inputResponses\` MUST return \`InputRequiredResult\`
  with \`inputRequests\`.
- The client retries the SAME tools/call (same name + arguments) with
  \`inputResponses\` keyed against the previously-emitted ids, plus the
  echoed \`requestState\` if one was provided.
- The server MUST validate the echoed \`requestState\` and complete on
  the next round.

**Multi-method support:**
- A single \`InputRequiredResult\` can carry \`inputRequests\` for
  \`elicitation/create\`, \`sampling/createMessage\`, and \`roots/list\`
  in any combination.

**Multi-round + state accumulation:**
- A handler MAY take more than two rounds. Each MRTR round mints a
  fresh \`requestState\`; the prior token MUST NOT be reused. Answers
  from prior rounds MUST be available to the handler on the final
  round (server forwards them via \`requestState\`).

**Wrong-key tolerance:**
- When a client retries with an \`inputResponses\` key the server did
  not emit, the server SHOULD re-request via \`InputRequiredResult\`
  rather than erroring. (The spec is soft here; this scenario asserts
  the re-request path.)`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    let client: Client;
    try {
      client = new Client(
        { name: 'mcp-conformance', version: '1.0' },
        {
          capabilities: {
            elicitation: {},
            sampling: {},
            roots: {}
          }
        }
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL(serverUrl))
      );
    } catch (error) {
      checks.push({
        id: 'mrtr-session-bootstrap',
        name: 'MrtrSessionBootstrap',
        description:
          'Initialize handshake declaring elicitation/sampling/roots capabilities succeeds',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed to initialize: ${errMsg(error)}`,
        specReferences: [SEP_2322_REF]
      });
      return checks;
    }

    // Check 1: basic elicitation round-trip.
    {
      const id = 'mrtr-basic-elicitation-round-trip';
      const name = 'MrtrBasicElicitationRoundTrip';
      const description =
        'tools/call returns InputRequiredResult on round 1 (elicitation/create); completes on round 2 with the answer reflected in the result';
      try {
        const r1 = (await client.request(
          {
            method: 'tools/call',
            params: { name: 'test_tool_with_elicitation', arguments: {} }
          },
          AnyResult
        )) as any;
        const errs: string[] = [];
        if (!isInputRequiredResult(r1)) {
          errs.push(
            `round 1 MUST be InputRequiredResult; got ${JSON.stringify(r1)}`
          );
        }
        if (r1.resultType !== MRTR_INPUT_REQUIRED_RESULT_TYPE) {
          errs.push(
            `resultType MUST be "${MRTR_INPUT_REQUIRED_RESULT_TYPE}"; got ${JSON.stringify(r1.resultType)}`
          );
        }
        if (!r1.inputRequests || !r1.inputRequests.user_name) {
          errs.push(
            'InputRequiredResult MUST carry inputRequests with the "user_name" key'
          );
        } else if (r1.inputRequests.user_name.method !== 'elicitation/create') {
          errs.push(
            `inputRequest method MUST be "elicitation/create"; got ${JSON.stringify(r1.inputRequests.user_name.method)}`
          );
        }

        const r2 = (await client.request(
          {
            method: 'tools/call',
            params: {
              name: 'test_tool_with_elicitation',
              arguments: {},
              inputResponses: {
                user_name: mockElicitResponse({ name: 'Alice' })
              },
              ...(r1.requestState !== undefined
                ? { requestState: r1.requestState }
                : {})
            }
          },
          AnyResult
        )) as any;
        if (!isCompleteResult(r2)) {
          errs.push(`round 2 MUST be complete; got ${JSON.stringify(r2)}`);
        }
        const text = r2.content?.[0]?.text ?? '';
        if (!/Alice/.test(text)) {
          errs.push(
            'response text SHOULD reference the answered name ("Alice")'
          );
        }
        checks.push({
          id,
          name,
          description,
          status: errs.length === 0 ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: errs.length > 0 ? errs.join('; ') : undefined,
          specReferences: [SEP_2322_REF]
        });
      } catch (error) {
        checks.push(failureCheck(id, name, description, error));
      }
    }

    // Check 2: sampling round-trip.
    {
      const id = 'mrtr-sampling-round-trip';
      const name = 'MrtrSamplingRoundTrip';
      const description =
        'InputRequiredResult with sampling/createMessage round-trips through the inputResponses retry';
      try {
        const r1 = (await client.request(
          {
            method: 'tools/call',
            params: { name: 'test_incomplete_result_sampling', arguments: {} }
          },
          AnyResult
        )) as any;
        const errs: string[] = [];
        if (!isInputRequiredResult(r1)) {
          errs.push('round 1 MUST be InputRequiredResult');
        } else {
          const key = Object.keys(r1.inputRequests)[0];
          if (r1.inputRequests[key].method !== 'sampling/createMessage') {
            errs.push(
              `inputRequest method MUST be "sampling/createMessage"; got ${JSON.stringify(r1.inputRequests[key].method)}`
            );
          }
          const r2 = (await client.request(
            {
              method: 'tools/call',
              params: {
                name: 'test_incomplete_result_sampling',
                arguments: {},
                inputResponses: { [key]: mockSamplingResponse('Paris') },
                ...(r1.requestState !== undefined
                  ? { requestState: r1.requestState }
                  : {})
              }
            },
            AnyResult
          )) as any;
          if (!isCompleteResult(r2)) {
            errs.push('round 2 MUST be complete');
          }
        }
        checks.push({
          id,
          name,
          description,
          status: errs.length === 0 ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: errs.length > 0 ? errs.join('; ') : undefined,
          specReferences: [SEP_2322_REF]
        });
      } catch (error) {
        checks.push(failureCheck(id, name, description, error));
      }
    }

    // Check 3: roots/list round-trip.
    {
      const id = 'mrtr-roots-list-round-trip';
      const name = 'MrtrRootsListRoundTrip';
      const description =
        'InputRequiredResult with roots/list round-trips through the inputResponses retry';
      try {
        const r1 = (await client.request(
          {
            method: 'tools/call',
            params: { name: 'test_incomplete_result_list_roots', arguments: {} }
          },
          AnyResult
        )) as any;
        const errs: string[] = [];
        if (!isInputRequiredResult(r1)) {
          errs.push('round 1 MUST be InputRequiredResult');
        } else {
          const key = Object.keys(r1.inputRequests)[0];
          if (r1.inputRequests[key].method !== 'roots/list') {
            errs.push(
              `inputRequest method MUST be "roots/list"; got ${JSON.stringify(r1.inputRequests[key].method)}`
            );
          }
          const r2 = (await client.request(
            {
              method: 'tools/call',
              params: {
                name: 'test_incomplete_result_list_roots',
                arguments: {},
                inputResponses: { [key]: mockListRootsResponse() },
                ...(r1.requestState !== undefined
                  ? { requestState: r1.requestState }
                  : {})
              }
            },
            AnyResult
          )) as any;
          if (!isCompleteResult(r2)) {
            errs.push('round 2 MUST be complete');
          }
        }
        checks.push({
          id,
          name,
          description,
          status: errs.length === 0 ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: errs.length > 0 ? errs.join('; ') : undefined,
          specReferences: [SEP_2322_REF]
        });
      } catch (error) {
        checks.push(failureCheck(id, name, description, error));
      }
    }

    // Check 4: requestState round-trip validation.
    {
      const id = 'mrtr-request-state-round-trip';
      const name = 'MrtrRequestStateRoundTrip';
      const description =
        'When server emits requestState on round 1, it MUST be a non-empty string and the server MUST validate the echo on round 2';
      try {
        const r1 = (await client.request(
          {
            method: 'tools/call',
            params: {
              name: 'test_incomplete_result_request_state',
              arguments: {}
            }
          },
          AnyResult
        )) as any;
        const errs: string[] = [];
        if (!isInputRequiredResult(r1)) {
          errs.push('round 1 MUST be InputRequiredResult');
        }
        if (typeof r1.requestState !== 'string') {
          errs.push(
            `requestState MUST be a string when emitted; got ${typeof r1.requestState}`
          );
        } else if (r1.requestState.length === 0) {
          errs.push(
            'requestState MUST be non-empty when emitted (omit instead of "")'
          );
        }
        const key = Object.keys(r1.inputRequests ?? {})[0];
        if (key) {
          const r2 = (await client.request(
            {
              method: 'tools/call',
              params: {
                name: 'test_incomplete_result_request_state',
                arguments: {},
                inputResponses: { [key]: mockElicitResponse({ ok: true }) },
                requestState: r1.requestState
              }
            },
            AnyResult
          )) as any;
          if (!isCompleteResult(r2)) {
            errs.push('round 2 MUST be complete after valid requestState echo');
          }
          const text =
            r2.content?.find((c: any) => c.type === 'text')?.text ?? '';
          if (!/state-ok/.test(text)) {
            errs.push(
              'final response SHOULD include "state-ok" to confirm the server validated requestState'
            );
          }
        }
        checks.push({
          id,
          name,
          description,
          status: errs.length === 0 ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: errs.length > 0 ? errs.join('; ') : undefined,
          specReferences: [SEP_2322_REF]
        });
      } catch (error) {
        checks.push(failureCheck(id, name, description, error));
      }
    }

    // Check 5: multiple inputRequests of different methods in one round.
    {
      const id = 'mrtr-multiple-input-requests-one-round';
      const name = 'MrtrMultipleInputRequestsOneRound';
      const description =
        'A single InputRequiredResult MAY carry inputRequests for elicitation/create + sampling/createMessage + roots/list together';
      try {
        const r1 = (await client.request(
          {
            method: 'tools/call',
            params: {
              name: 'test_incomplete_result_multiple_inputs',
              arguments: {}
            }
          },
          AnyResult
        )) as any;
        const errs: string[] = [];
        if (!isInputRequiredResult(r1)) {
          errs.push('round 1 MUST be InputRequiredResult');
        } else {
          const keys = Object.keys(r1.inputRequests);
          if (keys.length < 3) {
            errs.push(
              `expected at least 3 inputRequests in one round; got ${keys.length}`
            );
          }
          const methods = new Set(keys.map((k) => r1.inputRequests[k].method));
          for (const expected of [
            'elicitation/create',
            'sampling/createMessage',
            'roots/list'
          ]) {
            if (!methods.has(expected)) {
              errs.push(`inputRequests MUST include method "${expected}"`);
            }
          }
          const inputResponses: Record<string, unknown> = {};
          for (const [key, req] of Object.entries(r1.inputRequests) as Array<
            [string, any]
          >) {
            if (req.method === 'elicitation/create')
              inputResponses[key] = mockElicitResponse({ name: 'Alice' });
            else if (req.method === 'sampling/createMessage')
              inputResponses[key] = mockSamplingResponse('hi');
            else if (req.method === 'roots/list')
              inputResponses[key] = mockListRootsResponse();
          }
          const r2 = (await client.request(
            {
              method: 'tools/call',
              params: {
                name: 'test_incomplete_result_multiple_inputs',
                arguments: {},
                inputResponses,
                ...(r1.requestState !== undefined
                  ? { requestState: r1.requestState }
                  : {})
              }
            },
            AnyResult
          )) as any;
          if (!isCompleteResult(r2)) {
            errs.push('round 2 MUST be complete with all three answers');
          }
        }
        checks.push({
          id,
          name,
          description,
          status: errs.length === 0 ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: errs.length > 0 ? errs.join('; ') : undefined,
          specReferences: [SEP_2322_REF]
        });
      } catch (error) {
        checks.push(failureCheck(id, name, description, error));
      }
    }

    // Check 6: multi-round flow accumulates answers via requestState.
    {
      const id = 'mrtr-multi-round-flow';
      const name = 'MrtrMultiRoundFlow';
      const description =
        'A handler may take 2+ MRTR rounds; each round mints a fresh requestState; final result MUST reflect answers from every round';
      try {
        const r1 = (await client.request(
          {
            method: 'tools/call',
            params: {
              name: 'test_incomplete_result_multi_round',
              arguments: {}
            }
          },
          AnyResult
        )) as any;
        const errs: string[] = [];
        if (!isInputRequiredResult(r1)) {
          errs.push('round 1 MUST be InputRequiredResult');
        }
        if (!r1.requestState) {
          errs.push('round 1 MUST mint requestState for multi-round flow');
        }
        const k1 = Object.keys(r1.inputRequests ?? {})[0];

        const r2 = (await client.request(
          {
            method: 'tools/call',
            params: {
              name: 'test_incomplete_result_multi_round',
              arguments: {},
              inputResponses: { [k1]: mockElicitResponse({ name: 'Alice' }) },
              requestState: r1.requestState
            }
          },
          AnyResult
        )) as any;
        if (!isInputRequiredResult(r2)) {
          errs.push(
            'round 2 MUST still be InputRequiredResult (asks for step2)'
          );
        }
        if (!r2.requestState) {
          errs.push('round 2 MUST mint a fresh requestState');
        }
        if (r2.requestState === r1.requestState) {
          errs.push(
            'round 2 requestState MUST differ from round 1 (each round mints a fresh token)'
          );
        }
        const k2 = Object.keys(r2.inputRequests ?? {})[0];

        const r3 = (await client.request(
          {
            method: 'tools/call',
            params: {
              name: 'test_incomplete_result_multi_round',
              arguments: {},
              inputResponses: { [k2]: mockElicitResponse({ color: 'blue' }) },
              requestState: r2.requestState
            }
          },
          AnyResult
        )) as any;
        if (!isCompleteResult(r3)) {
          errs.push('round 3 MUST be complete');
        }
        const text = r3.content?.[0]?.text ?? '';
        if (!/Alice/.test(text)) {
          errs.push(
            'final result MUST reflect round 1 answer (server forwards via requestState)'
          );
        }
        if (!/blue/.test(text)) {
          errs.push('final result MUST reflect round 2 answer');
        }
        checks.push({
          id,
          name,
          description,
          status: errs.length === 0 ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: errs.length > 0 ? errs.join('; ') : undefined,
          specReferences: [SEP_2322_REF]
        });
      } catch (error) {
        checks.push(failureCheck(id, name, description, error));
      }
    }

    // Check 7: wrong-key inputResponses → server re-requests.
    {
      const id = 'mrtr-wrong-input-key-rerequests';
      const name = 'MrtrWrongInputKeyRerequests';
      const description =
        'When the client sends inputResponses with a key the server did not emit, the server SHOULD re-request via InputRequiredResult';
      try {
        const r1 = (await client.request(
          {
            method: 'tools/call',
            params: {
              name: 'test_incomplete_result_elicitation',
              arguments: {},
              inputResponses: {
                wrong_key: mockElicitResponse({ data: 'wrong' })
              }
            }
          },
          AnyResult
        )) as any;
        const errs: string[] = [];
        if (!isInputRequiredResult(r1)) {
          errs.push(
            `expected InputRequiredResult re-request when inputResponses key is wrong; got ${JSON.stringify(r1)}`
          );
        }
        checks.push({
          id,
          name,
          description,
          status: errs.length === 0 ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: errs.length > 0 ? errs.join('; ') : undefined,
          specReferences: [SEP_2322_REF]
        });
      } catch (error) {
        checks.push(failureCheck(id, name, description, error));
      }
    }

    // Check 8: SKIPPED — MRTR → Tasks composition.
    // Tracking placeholder; spec made this normative in commit 451f5e1
    // (Apr 30). Blocker: reference servers need a middleware that
    // observes the handler's InputRequiredResult signal BEFORE creating
    // a task — the natural implementation pattern (create task up-front,
    // run handler in goroutine) doesn't expose the signal in time, so
    // round 1 of an MRTR-composing tools/call ends up emitting
    // CreateTaskResult instead of InputRequiredResult. Tracked in
    // https://github.com/panyam/mcpkit/issues/347 as one example impl
    // that hits this; SDKs in any language will need an equivalent fix.
    //
    // (An earlier version of this skip also tracked a discriminator
    // value blocker on "incomplete" vs "input_required". SEP-2322
    // merged on 2026-05-06 with "input_required" (commit de6d76fb).
    // SEP-2663's mdx hasn't yet caught up but every server emitting
    // the merged 2322 literal is interoperable, so the blocker is
    // effectively resolved for conformance purposes.)
    {
      checks.push({
        id: 'mrtr-tasks-composition',
        name: 'MrtrTasksComposition',
        description:
          'MRTR loop gathers input then final round returns CreateTaskResult (SEP-2663 451f5e1). Deferred on the reference-impl middleware refactor — the eager-task-creation pattern emits CreateTaskResult before the handler runs, so the handler\'s IsInputRequired signal can\'t be surfaced as InputRequiredResult on round 1. Tracked at panyam/mcpkit issue 347.',
        status: 'SKIPPED',
        timestamp: new Date().toISOString(),
        errorMessage:
          "Skipped: deferred on the reference-impl middleware refactor (panyam/mcpkit issue 347). The current eager-task-creation pattern emits CreateTaskResult before the handler runs, so the handler's IsInputRequired signal can't be surfaced as InputRequiredResult on round 1.",
        specReferences: [
          SEP_2322_REF,
          {
            id: 'SEP-2663',
            url: 'https://github.com/modelcontextprotocol/specification/pull/2663'
          }
        ]
      });
    }

    await client.close().catch(() => {});
    return checks;
  }
}
