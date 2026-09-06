/**
 * SEP-2663 + SEP-2322 — MRTR → Tasks composition.
 *
 * Tests the composition path made normative by SEP-2663 commit 451f5e1:
 * a tool gathers input via the SEP-2322 MRTR loop on `tools/call`, then
 * the handler escalates to async on the final round and the server
 * returns a `CreateTaskResult`. The inlined result of the eventual task
 * MUST reflect the answer gathered during the MRTR phase, so an
 * implementation that wires MRTR and tasks as independent surfaces
 * fails this end-to-end check.
 *
 * The SEP-2322 ephemeral-MRTR contract (round 1 InputRequiredResult →
 * round 2 ToolResult) is covered exhaustively by the `input-required-*`
 * scenarios; only the composition with `CreateTaskResult` on the final
 * round is SEP-2663-specific, which is why this is the only check in
 * the tasks suite that drives the MRTR loop end-to-end.
 */

import { ClientScenario, ConformanceCheck } from '../../../types';
import type { Connection, RunContext } from '../../../connection';
import { SEP_2322_REF, SEP_2663_REF, failureCheck } from './mrtr-helpers';
import {
  isInputRequiredResult,
  mockElicitResponse
} from '../input-required-result-helpers';
import { TASKS_EXTENSION_ID, waitForTerminal } from './helpers';

const MRTR_INPUT_REQUIRED_RESULT_TYPE = 'input_required';

export class TasksMrtrCompositionScenario implements ClientScenario {
  name = 'tasks-mrtr-composition';
  readonly source = { extensionId: 'io.modelcontextprotocol/tasks' } as const;
  description = `Test SEP-2663 MRTR → Tasks composition (SEP-2663 commit 451f5e1).

**Server Implementation Requirements:**

A tool that gathers input via the SEP-2322 MRTR loop and then escalates
to async on the final round MUST return a \`CreateTaskResult\` on that
final round, NOT a sync \`ToolResult\`. The composition is what makes
the two surfaces interoperate — clients should not need to choose one
or the other up front.

**Spec separation that MUST stay observable:**

1. Round 1 (MRTR) carries \`inputRequests\` + (optionally) \`requestState\`
   and MUST NOT carry \`taskId\`.
2. Round 2 (CreateTaskResult) carries \`taskId\` + \`status\` and MUST
   NOT carry \`requestState\` — SEP-2663 removed it from the v2 wire
   shape, so the MRTR phase's \`requestState\` does not leak into the
   task envelope and clients don't have to deduplicate across flows.
3. The final task \`result\` (inlined on \`tasks/get\` once terminal)
   MUST reflect the answer gathered during the MRTR phase, end-to-end.

**Required server fixtures (\`tools/list\` MUST include all):**
- \`test_tool_with_task\` — registered with \`taskSupport=required\`.
  Round 1: returns \`InputRequiredResult\` asking for \`user_name\`.
  Round 2: with the elicit response echoed back, escalates to async
  and returns \`CreateTaskResult\`. The task's eventual result text MUST
  contain the gathered \`user_name\` so the round-trip is observable.`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    const id = 'sep-2663-mrtr-synchronous-before-task-creation';
    const name = 'Sep2663MrtrSynchronousBeforeTaskCreation';
    const description =
      'MRTR loop gathers input then escalates to a task on the final round (SEP-2322 + SEP-2663 451f5e1).';
    const specRefs = [SEP_2322_REF, SEP_2663_REF];

    let conn: Connection | undefined;
    try {
      // Round 2's CreateTaskResult requires the client to declare
      // io.modelcontextprotocol/tasks (SEP-2663) at session bootstrap;
      // elicitation is needed for the MRTR round.
      conn = await ctx.connect({
        capabilities: {
          elicitation: {},
          extensions: { [TASKS_EXTENSION_ID]: {} }
        }
      });

      // Round 1: MRTR — no inputResponses. Expect InputRequiredResult.
      const r1 = (await conn.request('tools/call', {
        name: 'test_tool_with_task',
        arguments: {}
      })) as any;
      const errs: string[] = [];
      if (!isInputRequiredResult(r1)) {
        errs.push(
          `round 1 MUST be InputRequiredResult; got ${JSON.stringify(r1)}`
        );
      }
      if (r1?.resultType !== MRTR_INPUT_REQUIRED_RESULT_TYPE) {
        errs.push(
          `round 1 resultType MUST be "${MRTR_INPUT_REQUIRED_RESULT_TYPE}"; got ${JSON.stringify(r1?.resultType)}`
        );
      }
      if (r1 && 'taskId' in r1) {
        errs.push(
          'round 1 (MRTR) MUST NOT carry taskId — task is only minted on the final round'
        );
      }
      const key = Object.keys(r1?.inputRequests ?? {})[0];
      if (!key) {
        errs.push('round 1 missing inputRequests; cannot drive round 2');
      }

      // Round 2: MRTR retry with the elicit response. The handler now
      // returns GoAsync, so the server MUST return CreateTaskResult.
      let taskId: string | undefined;
      let r2: any;
      if (key) {
        r2 = (await conn.request('tools/call', {
          name: 'test_tool_with_task',
          arguments: {},
          inputResponses: {
            [key]: mockElicitResponse({ name: 'Alice' })
          },
          ...(r1.requestState !== undefined
            ? { requestState: r1.requestState }
            : {})
        })) as any;
        if (r2?.resultType !== 'task') {
          errs.push(
            `round 2 MUST be CreateTaskResult (resultType:"task"); got ${JSON.stringify(r2?.resultType)}`
          );
        }
        if (!r2?.taskId) {
          errs.push('round 2 CreateTaskResult MUST carry top-level taskId');
        } else {
          taskId = r2.taskId;
        }
        if (r2 && 'requestState' in r2) {
          errs.push(
            'round 2 CreateTaskResult MUST NOT carry requestState (SEP-2663 spec separation — MRTR requestState does not leak into the task envelope)'
          );
        }
        if (r2 && 'inputRequests' in r2) {
          errs.push(
            'round 2 CreateTaskResult MUST NOT carry inputRequests (those belong on DetailedTask returned by tasks/get)'
          );
        }
      }

      // Round 3: poll tasks/get until terminal; assert the inlined result
      // reflects the answer gathered in the MRTR phase.
      if (taskId) {
        const terminal = await waitForTerminal(conn, taskId);
        if (terminal.status !== 'completed') {
          errs.push(
            `final task status MUST be "completed"; got ${JSON.stringify(terminal.status)}`
          );
        }
        const text = terminal?.result?.content?.[0]?.text ?? '';
        if (!/Alice/.test(text)) {
          errs.push(
            `final task result MUST reflect the user_name gathered during the MRTR phase (expected "Alice"); got ${JSON.stringify(text)}`
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
        specReferences: specRefs
      });
    } catch (error) {
      checks.push(failureCheck(id, name, description, error, specRefs));
    } finally {
      await conn?.close().catch(() => {});
    }

    return checks;
  }
}
