/**
 * SEP-2322 / SEP-2663 — MRTR input flow on the tasks surface.
 *
 * Tests the input_required → tasks/update → resume loop, including
 * partial inputResponses fulfillment when a tool fans out multiple
 * simultaneous input requests.
 *
 * Required server fixtures:
 *   - confirm_delete  — task-supporting, calls TaskElicit once
 *   - multi_input     — task-supporting, fans out two TaskElicits in
 *                       parallel so two keys are pending at once
 */

import { ClientScenario, ConformanceCheck } from '../../../types';
import type { Connection, RunContext } from '../../../connection';
import { SEP_2322_REF, SEP_2663_REF } from './mrtr-helpers';
import { errMsg, failureCheck } from './mrtr-helpers';
import { TASKS_EXTENSION_ID, waitForStatus, waitForTerminal } from './helpers';

export class TasksMRTRInputScenario implements ClientScenario {
  name = 'tasks-mrtr-input';
  readonly source = { extensionId: 'io.modelcontextprotocol/tasks' } as const;
  description = `Test SEP-2322 MRTR input flow on the tasks surface.

**Server Implementation Requirements:**

**Surfacing inputRequests (SEP-2322):**
- A task waiting on client input MUST report \`status:"input_required"\`
  on tasks/get and surface a non-empty \`inputRequests\` map keyed by
  server-minted opaque ids. Each entry carries the underlying request
  (\`elicitation/create\`, \`sampling/createMessage\`, etc.).

**Resuming via tasks/update (SEP-2663):**
- The client delivers responses through \`tasks/update\` with
  \`inputResponses\` keyed to match the server-emitted ids. The server
  MUST return an empty \`{resultType:"complete"}\` ack on the
  tasks/update response — the resulting task state is observed via the
  next tasks/get.
- After the response is delivered, the task MUST resume execution and
  proceed to a terminal state (or back to input_required for another
  round).

**Partial fulfillment (SEP-2663):**
- A tool that emits multiple simultaneous input requests parks the task
  with multiple keys in \`inputRequests\`. A client MAY answer them one
  at a time:
  - tasks/update with a subset of keys MUST be acked.
  - The task MUST stay in \`input_required\` until every pending request
    has been answered.
  - tasks/get after a partial update MUST surface only the still-pending
    keys; the answered key MUST be removed.

**Required server fixtures (\`tools/list\` MUST include all):**
- \`confirm_delete\` — task-supporting, emits a single
  \`elicitation/create\` inputRequest then completes when the response
  arrives.
- \`multi_input\` — task-supporting, fans out two \`elicitation/create\`
  inputRequests in parallel so two keys are pending at once (used by
  the partial-fulfillment check).`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    let conn: Connection;
    try {
      conn = await ctx.connect({
        capabilities: {
          elicitation: {},
          sampling: {},
          extensions: { [TASKS_EXTENSION_ID]: {} }
        }
      });
    } catch (error) {
      checks.push({
        id: 'tasks-mrtr-input-bootstrap',
        name: 'TasksMrtrInputBootstrap',
        description:
          'Initialize handshake declaring io.modelcontextprotocol/tasks extension succeeds',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed to initialize: ${errMsg(error)}`,
        specReferences: [SEP_2322_REF]
      });
      return checks;
    }

    // Check 1: tasks/get surfaces inputRequests when status=input_required.
    {
      const id = 'sep-2663-tasks-get-status-input-required';
      const name = 'TasksMRTRInputRequestsOnTasksGet';
      const description =
        'tasks/get on an input_required task MUST surface a non-empty inputRequests map';
      try {
        const created = (await conn.request('tools/call', {
          name: 'confirm_delete',
          arguments: { filename: 'mrtr-input.txt' }
        })) as any;
        const taskId = created.taskId;
        if (!taskId) {
          checks.push({
            id,
            name,
            description,
            status: 'FAILURE',
            timestamp: new Date().toISOString(),
            errorMessage: 'confirm_delete did not create a task',
            specReferences: [SEP_2322_REF]
          });
        } else {
          const task = await waitForStatus(
            conn,
            taskId,
            'input_required',
            5_000
          );
          const errs: string[] = [];
          if (task.status !== 'input_required') {
            errs.push(
              `expected status:"input_required"; got ${JSON.stringify(task.status)}`
            );
          }
          if (
            !task.inputRequests ||
            typeof task.inputRequests !== 'object' ||
            Array.isArray(task.inputRequests)
          ) {
            errs.push('inputRequests MUST be a non-null object (map)');
          } else {
            const keys = Object.keys(task.inputRequests);
            if (keys.length === 0) {
              errs.push('inputRequests MUST have at least one entry');
            } else {
              const firstReq = task.inputRequests[keys[0]];
              if (!firstReq?.method) {
                errs.push(
                  'each inputRequest MUST carry a `method` (e.g., elicitation/create)'
                );
              }
            }
          }
          // Cancel so we don't leave the task parked.
          try {
            await conn.request('tasks/cancel', { taskId });
          } catch {
            /* swallow */
          }
          checks.push({
            id,
            name,
            description,
            status: errs.length === 0 ? 'SUCCESS' : 'FAILURE',
            timestamp: new Date().toISOString(),
            errorMessage: errs.length > 0 ? errs.join('; ') : undefined,
            specReferences: [SEP_2322_REF, SEP_2663_REF]
          });
        }
      } catch (error) {
        checks.push(failureCheck(id, name, description, error, [SEP_2322_REF]));
      }
    }

    // Check 2: tasks/update delivers inputResponses + resumes the task.
    {
      const id = 'tasks-mrtr-tasks-update-resumes';
      const name = 'TasksMRTRTasksUpdateResumes';
      const description =
        'tasks/update with matching inputResponses MUST be acked with {resultType:"complete"} and resume the task to a terminal state';
      try {
        const created = (await conn.request('tools/call', {
          name: 'confirm_delete',
          arguments: { filename: 'mrtr-resume.txt' }
        })) as any;
        const taskId = created.taskId;
        if (!taskId) {
          checks.push({
            id,
            name,
            description,
            status: 'FAILURE',
            timestamp: new Date().toISOString(),
            errorMessage: 'confirm_delete did not create a task',
            specReferences: [SEP_2322_REF, SEP_2663_REF]
          });
        } else {
          const inputTask = await waitForStatus(
            conn,
            taskId,
            'input_required',
            5_000
          );
          const errs: string[] = [];
          const responses: Record<string, any> = {};
          for (const key of Object.keys(inputTask.inputRequests ?? {})) {
            responses[key] = {
              action: 'accept',
              content: { confirm: true }
            };
          }
          const ack = (await conn.request('tasks/update', {
            taskId,
            inputResponses: responses
          })) as any;
          if (ack?.resultType !== 'complete') {
            errs.push(
              `tasks/update ack MUST carry resultType:"complete"; got resultType=${ack?.resultType}`
            );
          }
          const updateAckOffenders = (
            ['taskId', 'status', 'result', 'error', 'inputRequests'] as const
          ).filter((f) => f in ack);
          if (updateAckOffenders.length > 0) {
            errs.push(
              `tasks/update ack MUST NOT carry task-envelope fields; got: ${updateAckOffenders.join(', ')}`
            );
          }
          const terminal = await waitForTerminal(conn, taskId);
          if (terminal.status !== 'completed') {
            errs.push(
              `task MUST resume to completed after tasks/update; got status ${JSON.stringify(terminal.status)}`
            );
          }
          checks.push({
            id,
            name,
            description,
            status: errs.length === 0 ? 'SUCCESS' : 'FAILURE',
            timestamp: new Date().toISOString(),
            errorMessage: errs.length > 0 ? errs.join('; ') : undefined,
            specReferences: [SEP_2322_REF, SEP_2663_REF]
          });
        }
      } catch (error) {
        checks.push(
          failureCheck(id, name, description, error, [
            SEP_2322_REF,
            SEP_2663_REF
          ])
        );
      }
    }

    // Check 3: partial inputResponses fulfillment leaves the rest pending.
    {
      const id = 'tasks-mrtr-partial-fulfillment';
      const name = 'TasksMRTRPartialFulfillment';
      const description =
        'tasks/update with a subset of keys MUST keep the task in input_required with only the unanswered key remaining';
      try {
        const created = (await conn.request('tools/call', {
          name: 'multi_input',
          arguments: {}
        })) as any;
        const taskId = created.taskId;
        if (!taskId) {
          checks.push({
            id,
            name,
            description,
            status: 'FAILURE',
            timestamp: new Date().toISOString(),
            errorMessage: 'multi_input did not create a task',
            specReferences: [SEP_2663_REF]
          });
        } else {
          // Wait until two keys are pending (the fan-out tool races two
          // TaskElicits, so we may briefly see one before the second).
          let inputTask: any;
          const start = Date.now();
          while (Date.now() - start < 5_000) {
            inputTask = (await conn.request('tasks/get', { taskId })) as any;
            if (
              inputTask.status === 'input_required' &&
              inputTask.inputRequests &&
              Object.keys(inputTask.inputRequests).length >= 2
            ) {
              break;
            }
            await new Promise((r) => setTimeout(r, 100));
          }
          const errs: string[] = [];
          if (inputTask.status !== 'input_required') {
            errs.push(
              `task with two parallel elicits MUST be input_required; got ${JSON.stringify(inputTask.status)}`
            );
          }
          const keys = Object.keys(inputTask.inputRequests ?? {});
          if (keys.length < 2) {
            errs.push(
              `multi_input MUST surface 2 inputRequests; got ${keys.length}`
            );
          } else {
            const [firstKey, secondKey] = keys;

            // Answer first key only.
            const firstAck = (await conn.request('tasks/update', {
              taskId,
              inputResponses: {
                [firstKey]: {
                  action: 'accept',
                  content: { name: 'partial-1', confirm: true }
                }
              }
            })) as any;
            if (firstAck.resultType !== 'complete') {
              errs.push(
                `partial tasks/update ack MUST carry resultType:"complete"; got ${JSON.stringify(firstAck)}`
              );
            }

            // Status MUST still be input_required with only the second
            // key remaining.
            const afterFirst = (await conn.request('tasks/get', {
              taskId
            })) as any;
            if (afterFirst.status !== 'input_required') {
              errs.push(
                `task MUST stay input_required while another input is still pending; got ${JSON.stringify(afterFirst.status)}`
              );
            }
            const remaining = Object.keys(afterFirst.inputRequests ?? {});
            if (!remaining.includes(secondKey)) {
              errs.push(
                `unanswered key MUST remain in inputRequests; got ${JSON.stringify(remaining)}`
              );
            }
            if (remaining.includes(firstKey)) {
              errs.push(
                `answered key MUST be removed from inputRequests; still saw ${firstKey}`
              );
            }

            // Answer second key — task resumes and finishes.
            await conn.request('tasks/update', {
              taskId,
              inputResponses: {
                [secondKey]: {
                  action: 'accept',
                  content: { name: 'partial-2', confirm: true }
                }
              }
            });
            const terminal = await waitForTerminal(conn, taskId);
            if (terminal.status !== 'completed') {
              errs.push(
                `task MUST complete after both inputs are satisfied; got ${JSON.stringify(terminal.status)}`
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
            specReferences: [SEP_2322_REF, SEP_2663_REF]
          });
        }
      } catch (error) {
        checks.push(
          failureCheck(id, name, description, error, [
            SEP_2322_REF,
            SEP_2663_REF
          ])
        );
      }
    }

    await conn.close().catch(() => {});
    return checks;
  }
}
