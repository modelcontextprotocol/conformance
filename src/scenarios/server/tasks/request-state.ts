/**
 * SEP-2663 Tasks Extension — `requestState` absence on the tasks-v2 wire.
 *
 * SEP-2663 does not define a `requestState` field on the tasks-v2 wire.
 * This scenario asserts the absence on the two task-bearing message
 * shapes that a server can populate at task creation and during polling:
 *
 *   - `CreateTaskResult` MUST NOT carry `requestState`.
 *   - `DetailedTask` (tasks/get response) MUST NOT carry `requestState`,
 *     regardless of status.
 *
 * Why a negative test exists for a field the spec never defines:
 * SEP-2322 (MRTR) places `requestState` on `InputRequiredResult` — the
 * same JSON shape slot a fresh implementer might also reach for on the
 * tasks-v2 `DetailedTask` while reading the two SEPs together. The
 * absence-assert here catches that cross-SEP confusion. SEP-2322's
 * `InputRequiredResult.requestState` is unrelated to the tasks-v2 wire
 * and is exercised by mrtr-input.ts.
 *
 * Required server fixtures:
 *   - slow_compute  — task-supporting, sleeps N seconds
 */

import { ClientScenario, ConformanceCheck } from '../../../types';
import type { Connection, RunContext } from '../../../connection';
import { SEP_2663_REF } from './mrtr-helpers';
import { errMsg, failureCheck } from './mrtr-helpers';
import { TASKS_EXTENSION_ID } from './helpers';

export class TasksRequestStateRemovalScenario implements ClientScenario {
  name = 'tasks-request-state-removal';
  readonly source = { extensionId: 'io.modelcontextprotocol/tasks' } as const;
  description = `Verify the absence of \`requestState\` on the tasks-v2 wire.

**Server Implementation Requirements:**

SEP-2663 does not define a \`requestState\` field on the \`Task\` base
interface, so:

- \`CreateTaskResult\` MUST NOT carry \`requestState\` on the
  \`tools/call\` response that creates a task.
- The \`tasks/get\` response (DetailedTask) MUST NOT carry
  \`requestState\` for any status (\`working\` / \`input_required\` /
  \`completed\` / \`cancelled\` / \`failed\`).

SEP-2322's \`InputRequiredResult\` does carry \`requestState\` — that is
the MRTR multi-round-trip surface, unrelated to the tasks-v2 wire, and
is exercised by mrtr-input.ts. This scenario exists because the two
SEPs put \`requestState\` in lexically adjacent positions, making
accidental copy-paste from the MRTR shape into the tasks-v2 shape a
foreseeable mistake for fresh implementations.

**Required server fixtures (\`tools/list\` MUST include all):**
- \`slow_compute\` — task-supporting, \`seconds\`-second sleep then a
  result.`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    let conn: Connection;
    try {
      conn = await ctx.connect({
        capabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } }
      });
    } catch (error) {
      checks.push({
        id: 'tasks-request-state-bootstrap',
        name: 'TasksRequestStateBootstrap',
        description:
          'Initialize handshake declaring io.modelcontextprotocol/tasks extension succeeds',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed to initialize: ${errMsg(error)}`,
        specReferences: [SEP_2663_REF]
      });
      return checks;
    }

    // Drive a long-running task so we can interrogate `tasks/get` while
    // the task is still in `working`. A terminal-only sample would miss
    // any field a server populated only during the in-flight window.
    let taskId: string | undefined;
    let createdTask: any;
    try {
      createdTask = (await conn.request('tools/call', {
        name: 'slow_compute',
        arguments: { seconds: 60, label: 'request-state-removal' }
      })) as any;
      taskId = createdTask?.taskId;
    } catch (error) {
      checks.push(
        failureCheck(
          'tasks-request-state-removal-setup',
          'TasksRequestStateRemovalSetup',
          'Failed to create a long-running task to exercise the absence-asserts',
          error,
          [SEP_2663_REF]
        )
      );
      await conn.close().catch(() => {});
      return checks;
    }
    if (!taskId) {
      checks.push({
        id: 'tasks-request-state-removal-setup',
        name: 'TasksRequestStateRemovalSetup',
        description:
          'slow_compute did not return a CreateTaskResult; cannot exercise absence-asserts',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: 'no taskId in tools/call response',
        specReferences: [SEP_2663_REF]
      });
      await conn.close().catch(() => {});
      return checks;
    }

    // Check 1: CreateTaskResult MUST NOT carry requestState.
    {
      const id = 'tasks-create-result-no-request-state';
      const name = 'TasksCreateResultNoRequestState';
      const description =
        'CreateTaskResult MUST NOT carry `requestState` (SEP-2663 does not define the field on the Task base interface)';
      const has = Object.prototype.hasOwnProperty.call(
        createdTask,
        'requestState'
      );
      checks.push({
        id,
        name,
        description,
        status: has ? 'FAILURE' : 'SUCCESS',
        timestamp: new Date().toISOString(),
        errorMessage: has
          ? `CreateTaskResult carries requestState = ${JSON.stringify(createdTask.requestState)}; SEP-2663 does not define this field on the tasks-v2 wire.`
          : undefined,
        specReferences: [SEP_2663_REF]
      });
    }

    // Check 2: tasks/get response (DetailedTask) MUST NOT carry requestState.
    {
      const id = 'tasks-get-detailed-no-request-state';
      const name = 'TasksGetDetailedNoRequestState';
      const description =
        'tasks/get response (DetailedTask) MUST NOT carry `requestState` for any status (per SEP-2663)';
      try {
        const detailed = (await conn.request('tasks/get', {
          taskId
        })) as any;
        const has = Object.prototype.hasOwnProperty.call(
          detailed,
          'requestState'
        );
        checks.push({
          id,
          name,
          description,
          status: has ? 'FAILURE' : 'SUCCESS',
          timestamp: new Date().toISOString(),
          errorMessage: has
            ? `DetailedTask carries requestState = ${JSON.stringify(detailed.requestState)} (status=${detailed.status}); SEP-2663 does not define this field on the tasks-v2 wire.`
            : undefined,
          specReferences: [SEP_2663_REF],
          details: { observedStatus: detailed.status }
        });
      } catch (error) {
        checks.push(failureCheck(id, name, description, error, [SEP_2663_REF]));
      }
    }

    try {
      await conn.request('tasks/cancel', { taskId });
    } catch {
      /* swallow */
    }

    await conn.close().catch(() => {});
    return checks;
  }
}
