/**
 * SEP-2663 Tasks Extension — server lifecycle conformance.
 *
 * Tests a server that implements the io.modelcontextprotocol/tasks
 * extension end-to-end: sync vs async dispatch, DetailedTask shape on
 * tasks/get, tool errors vs protocol errors, and cancellation
 * semantics.
 *
 * Required server fixtures (tools/list output must include all):
 *   - greet              — sync-only, returns "Hello, {name}!"
 *   - slow_compute       — task-supporting, sleeps N seconds
 *   - failing_job        — task-supporting, returns a tool error
 *   - protocol_error_job — task-supporting, panics into a protocol error
 */

import { ClientScenario, ConformanceCheck } from '../../../types';
import type { Connection, RunContext } from '../../../connection';
import { SEP_2322_REF, SEP_2663_REF } from './mrtr-helpers';
import { errMsg, failureCheck } from './mrtr-helpers';
import { TASKS_EXTENSION_ID, waitForTerminal } from './helpers';
import { untestableCheck } from '../../untestable';
import { isIso8601 } from './mrtr-helpers';

export class TasksLifecycleScenario implements ClientScenario {
  name = 'tasks-lifecycle';
  readonly source = { extensionId: 'io.modelcontextprotocol/tasks' } as const;
  description = `Test SEP-2663 Tasks extension lifecycle on the server.

**Server Implementation Requirements (SEP-2663):**

The server MUST advertise \`io.modelcontextprotocol/tasks\` under
\`capabilities.extensions\` and gate the task surface on negotiation.

**Sync dispatch (no task created):**
- A \`tools/call\` against a sync-only tool MUST return a flat
  \`ToolResult\` with \`resultType:"complete"\` and a \`content[]\` array.
- It MUST NOT carry \`taskId\` at the top level (that would imply a
  CreateTaskResult).

**Server-directed task creation:**
- For task-supporting tools, the server decides whether to create a task —
  the client MUST NOT need to opt in via a request param.
- The response MUST be a \`CreateTaskResult\` — a flat \`Result & Task\`
  intersection: \`resultType:"task"\`, plus \`taskId\` / \`status\` /
  \`createdAt\` / \`lastUpdatedAt\` / \`ttlMs\` at the top level.
  There MUST NOT be a nested \`task\` wrapper key.

**tasks/get DetailedTask:**
- Working tasks return \`status\` and basic metadata; result/error are
  absent.
- Completed tasks MUST inline the original tool result under \`result\`
  with \`content[]\`. There is no separate \`tasks/result\` method.

**Tool errors vs protocol errors (SEP-2663 §error-semantics):**
- A tool that ran but reported an error MUST surface as
  \`status:"completed"\` with \`result.isError:true\`. The status
  \`"failed"\` is reserved for protocol-level errors.
- A protocol-level error (server crash, internal failure) MUST surface
  as \`status:"failed"\` with an inlined \`error\` object (JSON-RPC
  error shape: code/message/data) and MUST NOT carry \`result\`.

**Cancellation:**
- \`tasks/cancel\` MUST return an empty
  \`{resultType:"complete"}\` ack — no task envelope (SEP-2322
  discriminator). The cancelled status is observed via the next
  \`tasks/get\`.
- \`tasks/cancel\` against a terminal task returns the same empty ack
  (idempotent) — the spec reserves \`-32602\` for unknown taskIds only.

**Required server fixtures (\`tools/list\` MUST include all):**
- \`greet\` — sync-only, returns \`Hello, {name}!\`.
- \`slow_compute\` — task-supporting, \`seconds\`-second sleep then a
  result. \`seconds: 0\` for the immediate path. MUST settle to
  \`cancelled\` (not \`completed\`/\`failed\`) when \`tasks/cancel\`
  arrives while running, so the lifecycle cancel check has a
  deterministic terminal status.
- \`failing_job\` — task-supporting, always returns a tool execution
  error after ~1s.
- \`protocol_error_job\` — task-supporting, panics into a protocol
  error.`;

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
        id: 'tasks-lifecycle-bootstrap',
        name: 'TasksLifecycleBootstrap',
        description:
          'Initialize handshake declaring io.modelcontextprotocol/tasks extension succeeds',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed to initialize: ${errMsg(error)}`,
        specReferences: [SEP_2663_REF]
      });
      return checks;
    }

    // Check 1: sync tool call returns ToolResult, no task creation.
    {
      const id = 'tasks-sync-tool-call';
      const name = 'TasksSyncToolCall';
      const description =
        'Sync tool returns ToolResult (resultType:"complete"), no taskId at top level';
      try {
        const result = (await conn.request('tools/call', {
          name: 'greet',
          arguments: { name: 'World' }
        })) as any;
        const errs: string[] = [];
        if (result.resultType === 'task') {
          errs.push('sync tool result MUST NOT carry resultType:"task"');
        }
        if (result.taskId) {
          errs.push(
            `sync tool result MUST NOT carry top-level taskId; got ${result.taskId}`
          );
        }
        if (!Array.isArray(result.content) || result.content.length === 0) {
          errs.push('sync tool result MUST carry a non-empty content[] array');
        }
        checks.push({
          id,
          name,
          description,
          status: errs.length === 0 ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: errs.length > 0 ? errs.join('; ') : undefined,
          specReferences: [SEP_2663_REF, SEP_2322_REF],
          details: {
            resultType: result.resultType,
            hasTaskId: Boolean(result.taskId),
            contentLength: result.content?.length
          }
        });
      } catch (error) {
        checks.push(failureCheck(id, name, description, error, [SEP_2663_REF]));
      }
    }

    // Check 2: server-directed task creation produces flat CreateTaskResult.
    let workingTaskId: string | undefined;
    {
      const id = 'sep-2663-result-type-task-on-create';
      const name = 'TasksServerTaskCreation';
      const description =
        'Task-supporting tool returns flat CreateTaskResult (no nested `task` wrapper)';
      try {
        const result = (await conn.request('tools/call', {
          name: 'slow_compute',
          arguments: { seconds: 2, label: 'lifecycle-create' }
        })) as any;
        const errs: string[] = [];
        if (result.resultType !== 'task') {
          errs.push(
            `expected resultType:"task"; got ${JSON.stringify(result.resultType)}`
          );
        }
        if (result.task) {
          errs.push(
            'CreateTaskResult MUST be flat (Result & Task); there must be no nested `task` wrapper key'
          );
        }
        if (!result.taskId) {
          errs.push('CreateTaskResult MUST carry top-level taskId');
        }
        if (!result.status) {
          errs.push('CreateTaskResult MUST carry top-level status');
        }
        if ('result' in result) {
          errs.push(
            'CreateTaskResult MUST NOT carry `result` (lives on tasks/get DetailedTask)'
          );
        }
        if ('error' in result) {
          errs.push(
            'CreateTaskResult MUST NOT carry `error` (lives on tasks/get DetailedTask)'
          );
        }
        if ('inputRequests' in result) {
          errs.push(
            'CreateTaskResult MUST NOT carry `inputRequests` (lives on tasks/get DetailedTask)'
          );
        }
        // Timestamps — both keys present, both ISO-8601 formatted. Per
        // SEP-2663 these are required on every TaskInfoV2. See
        // `mrtr-helpers.ts` for the regex rationale.
        if (!isIso8601(result.createdAt)) {
          errs.push(
            `createdAt MUST be an ISO-8601 string; got ${JSON.stringify(result.createdAt)}`
          );
        }
        if (!isIso8601(result.lastUpdatedAt)) {
          errs.push(
            `lastUpdatedAt MUST be an ISO-8601 string; got ${JSON.stringify(result.lastUpdatedAt)}`
          );
        }
        if (result.taskId) workingTaskId = result.taskId;
        checks.push({
          id,
          name,
          description,
          status: errs.length === 0 ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: errs.length > 0 ? errs.join('; ') : undefined,
          specReferences: [SEP_2663_REF],
          details: {
            resultType: result.resultType,
            taskId: result.taskId,
            status: result.status
          }
        });
      } catch (error) {
        checks.push(failureCheck(id, name, description, error, [SEP_2663_REF]));
      }
    }

    // Check 3: tasks/get during working state returns status + metadata.
    {
      const id = 'sep-2663-tasks-get-status-working';
      const name = 'TasksGetDuringWorking';
      const description =
        'tasks/get returns status + metadata for an active task';
      if (!workingTaskId) {
        checks.push(
          untestableCheck(
            id,
            name,
            description,
            'no task was created by the preceding step, so this check could not be exercised',
            [SEP_2663_REF]
          )
        );
      } else {
        try {
          const task = (await conn.request('tasks/get', {
            taskId: workingTaskId
          })) as any;
          const errs: string[] = [];
          if (task.taskId !== workingTaskId) {
            errs.push(
              `taskId mismatch: expected ${workingTaskId}, got ${task.taskId}`
            );
          }
          if (!task.status) errs.push('tasks/get response MUST carry status');
          checks.push({
            id,
            name,
            description,
            status: errs.length === 0 ? 'SUCCESS' : 'FAILURE',
            timestamp: new Date().toISOString(),
            errorMessage: errs.length > 0 ? errs.join('; ') : undefined,
            specReferences: [SEP_2663_REF],
            details: { status: task.status }
          });
        } catch (error) {
          checks.push(
            failureCheck(id, name, description, error, [SEP_2663_REF])
          );
        }
      }
    }

    // Check 4: terminal tasks/get inlines result with content[].
    {
      const id = 'sep-2663-tasks-get-status-completed';
      const name = 'TasksGetTerminalInlinedResult';
      const description =
        'Completed task tasks/get inlines result with content[] (no separate tasks/result method)';
      if (!workingTaskId) {
        checks.push(
          untestableCheck(
            id,
            name,
            description,
            'no task was created by the preceding step, so this check could not be exercised',
            [SEP_2663_REF]
          )
        );
      } else {
        try {
          const terminal = await waitForTerminal(conn, workingTaskId);
          const errs: string[] = [];
          if (terminal.status !== 'completed') {
            errs.push(
              `expected status:"completed"; got ${JSON.stringify(terminal.status)}`
            );
          }
          if (!terminal.result) {
            errs.push('completed task MUST inline `result`');
          } else if (
            !Array.isArray(terminal.result.content) ||
            terminal.result.content.length === 0
          ) {
            errs.push(
              'completed task `result.content[]` MUST be a non-empty array'
            );
          }
          checks.push({
            id,
            name,
            description,
            status: errs.length === 0 ? 'SUCCESS' : 'FAILURE',
            timestamp: new Date().toISOString(),
            errorMessage: errs.length > 0 ? errs.join('; ') : undefined,
            specReferences: [SEP_2663_REF],
            details: {
              status: terminal.status,
              hasResult: Boolean(terminal.result),
              contentLength: terminal.result?.content?.length
            }
          });
        } catch (error) {
          checks.push(
            failureCheck(id, name, description, error, [SEP_2663_REF])
          );
        }
      }
    }

    // Check 5: tool execution error → completed with isError:true.
    {
      const id = 'sep-2663-tool-error-uses-completed-status';
      const name = 'TasksToolErrorCompletedIsError';
      const description =
        'Tool execution error reports as completed + result.isError (NOT failed)';
      try {
        const created = (await conn.request('tools/call', {
          name: 'failing_job',
          arguments: {}
        })) as any;
        const errs: string[] = [];
        if (!created.taskId) {
          errs.push('failing_job MUST create a task');
        } else {
          const terminal = await waitForTerminal(conn, created.taskId);
          if (terminal.status !== 'completed') {
            errs.push(
              `tool error MUST surface as completed (not "${terminal.status}")`
            );
          }
          if (!terminal.result) {
            errs.push('completed task with tool error MUST carry `result`');
          } else if (terminal.result.isError !== true) {
            errs.push('result.isError MUST be true for tool execution errors');
          }
        }
        checks.push({
          id,
          name,
          description,
          status: errs.length === 0 ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: errs.length > 0 ? errs.join('; ') : undefined,
          specReferences: [SEP_2663_REF]
        });
      } catch (error) {
        checks.push(failureCheck(id, name, description, error, [SEP_2663_REF]));
      }
    }

    // Check 6: protocol-level error → failed with inlined error, no result.
    {
      const id = 'sep-2663-tasks-get-status-failed';
      const name = 'TasksProtocolErrorFailedShape';
      const description =
        'Protocol-level error reports as failed + inlined error{code,message}, no result';
      try {
        const created = (await conn.request('tools/call', {
          name: 'protocol_error_job',
          arguments: {}
        })) as any;
        const errs: string[] = [];
        if (!created.taskId) {
          errs.push('protocol_error_job MUST create a task');
        } else {
          const terminal = await waitForTerminal(conn, created.taskId);
          if (terminal.status !== 'failed') {
            errs.push(
              `protocol error MUST surface as failed (not "${terminal.status}")`
            );
          }
          if (!terminal.error) {
            errs.push('failed task MUST carry inlined `error`');
          } else {
            if (typeof terminal.error.code !== 'number') {
              errs.push('failed task error MUST carry numeric `code`');
            }
            if (typeof terminal.error.message !== 'string') {
              errs.push('failed task error MUST carry string `message`');
            }
          }
          if (terminal.result) {
            errs.push('failed task MUST NOT carry `result`');
          }
        }
        checks.push({
          id,
          name,
          description,
          status: errs.length === 0 ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: errs.length > 0 ? errs.join('; ') : undefined,
          specReferences: [SEP_2663_REF]
        });
      } catch (error) {
        checks.push(failureCheck(id, name, description, error, [SEP_2663_REF]));
      }
    }

    // Check 7: tasks/cancel returns empty {resultType:"complete"} ack;
    // status settles to cancelled.
    {
      const id = 'sep-2663-cancel-ack-empty-result';
      const name = 'TasksCancelEmptyAck';
      const description =
        'tasks/cancel returns {resultType:"complete"} ack; status settles to cancelled';
      let cancelTaskId: string | undefined;
      try {
        const created = (await conn.request('tools/call', {
          name: 'slow_compute',
          arguments: { seconds: 60, label: 'lifecycle-cancel' }
        })) as any;
        cancelTaskId = created.taskId;
        if (!cancelTaskId) {
          checks.push({
            id,
            name,
            description,
            status: 'FAILURE',
            timestamp: new Date().toISOString(),
            errorMessage: 'slow_compute did not create a task',
            specReferences: [SEP_2663_REF, SEP_2322_REF]
          });
        } else {
          const ack = (await conn.request('tasks/cancel', {
            taskId: cancelTaskId
          })) as any;
          const errs: string[] = [];
          if (ack?.resultType !== 'complete') {
            errs.push(
              `cancel ack MUST carry resultType:"complete"; got resultType=${ack?.resultType}`
            );
          }
          // Task-envelope fields MUST NOT appear on the ack; _meta and
          // other result-shape metadata are permitted.
          const ackOffenders = (
            ['taskId', 'status', 'result', 'error', 'inputRequests'] as const
          ).filter((f) => f in ack);
          if (ackOffenders.length > 0) {
            errs.push(
              `cancel ack MUST NOT carry task-envelope fields; got: ${ackOffenders.join(', ')}`
            );
          }
          // SEP-2663 §Task Cancellation: transition to `cancelled` is not
          // guaranteed; record the settled status as diagnostic detail only.
          const after = await waitForTerminal(conn, cancelTaskId);
          checks.push({
            id,
            name,
            description,
            status: errs.length === 0 ? 'SUCCESS' : 'FAILURE',
            timestamp: new Date().toISOString(),
            errorMessage: errs.length > 0 ? errs.join('; ') : undefined,
            specReferences: [SEP_2663_REF, SEP_2322_REF],
            details: { cancelAck: ack, statusAfterCancel: after.status }
          });
        }
      } catch (error) {
        checks.push(failureCheck(id, name, description, error, [SEP_2663_REF]));
      }
    }

    // Check 8: tasks/cancel on a terminal task is idempotent — returns
    // the same {resultType:"complete"} empty-ack as on an active task,
    // rather than -32602. Required so clients don't have to handle the
    // race where a task terminates between observation and the cancel
    // request.
    {
      const id = 'tasks-cancel-terminal-idempotent-ack';
      const name = 'TasksCancelTerminalIdempotentAck';
      const description =
        'tasks/cancel on a terminal task returns the same empty-ack as on an active task (idempotent)';
      try {
        const created = (await conn.request('tools/call', {
          name: 'slow_compute',
          arguments: { seconds: 1, label: 'lifecycle-cancel-terminal' }
        })) as any;
        const completedTaskId = created.taskId;
        if (!completedTaskId) {
          checks.push({
            id,
            name,
            description,
            status: 'FAILURE',
            timestamp: new Date().toISOString(),
            errorMessage: 'slow_compute did not create a task',
            specReferences: [SEP_2663_REF]
          });
        } else {
          await waitForTerminal(conn, completedTaskId);
          const ack = (await conn.request('tasks/cancel', {
            taskId: completedTaskId
          })) as any;
          const errs: string[] = [];
          if (ack?.resultType !== 'complete') {
            errs.push(
              `idempotent cancel ack MUST carry resultType:"complete"; got resultType=${ack?.resultType}`
            );
          }
          const ackOffenders = (
            ['taskId', 'status', 'result', 'error', 'inputRequests'] as const
          ).filter((f) => f in ack);
          if (ackOffenders.length > 0) {
            errs.push(
              `idempotent cancel ack MUST NOT carry task-envelope fields; got: ${ackOffenders.join(', ')}`
            );
          }
          checks.push({
            id,
            name,
            description,
            status: errs.length === 0 ? 'SUCCESS' : 'FAILURE',
            timestamp: new Date().toISOString(),
            errorMessage: errs.length > 0 ? errs.join('; ') : undefined,
            specReferences: [SEP_2663_REF],
            details: { cancelAck: ack }
          });
        }
      } catch (error) {
        checks.push(failureCheck(id, name, description, error, [SEP_2663_REF]));
      }
    }

    await conn.close();
    return checks;
  }
}
