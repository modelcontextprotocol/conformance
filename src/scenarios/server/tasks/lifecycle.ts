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

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  ClientScenario,
  ConformanceCheck,
  ScenarioSource
} from '../../../types';
import {
  TASKS_EXTENSION_ID,
  SEP_2663_REF,
  SEP_2322_REF,
  AnyResult,
  errMsg,
  failureCheck,
  skipCheck,
  waitForTerminal
} from './helpers';
import { isIso8601 } from '../_shared/wire-format';

export class TasksLifecycleScenario implements ClientScenario {
  name = 'tasks-lifecycle';
  source: ScenarioSource = { extensionId: 'io.modelcontextprotocol/tasks' };
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
- \`tasks/cancel\` against a terminal task MUST return JSON-RPC
  \`-32602\` (InvalidParams). Clarified upstream in spec commit d963ad0.`;

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
            extensions: { [TASKS_EXTENSION_ID]: {} }
          }
        }
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL(serverUrl))
      );
    } catch (error) {
      checks.push({
        id: 'tasks-session-bootstrap',
        name: 'TasksSessionBootstrap',
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
        const result = (await client.request(
          {
            method: 'tools/call',
            params: { name: 'greet', arguments: { name: 'World' } }
          },
          AnyResult
        )) as any;
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
      const id = 'tasks-server-task-creation';
      const name = 'TasksServerTaskCreation';
      const description =
        'Task-supporting tool returns flat CreateTaskResult (no nested `task` wrapper)';
      try {
        const result = (await client.request(
          {
            method: 'tools/call',
            params: {
              name: 'slow_compute',
              arguments: { seconds: 2, label: 'lifecycle-create' }
            }
          },
          AnyResult
        )) as any;
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
        // `_shared/wire-format.ts` for the regex rationale.
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
      const id = 'tasks-get-during-working';
      const name = 'TasksGetDuringWorking';
      const description =
        'tasks/get returns status + metadata for an active task';
      if (!workingTaskId) {
        checks.push(skipCheck(id, name, description, 'no task created'));
      } else {
        try {
          const task = (await client.request(
            { method: 'tasks/get', params: { taskId: workingTaskId } },
            AnyResult
          )) as any;
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
      const id = 'tasks-get-terminal-inlined-result';
      const name = 'TasksGetTerminalInlinedResult';
      const description =
        'Completed task tasks/get inlines result with content[] (no separate tasks/result method)';
      if (!workingTaskId) {
        checks.push(skipCheck(id, name, description, 'no task created'));
      } else {
        try {
          const terminal = await waitForTerminal(client, workingTaskId);
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
      const id = 'tasks-tool-error-completed-iserror';
      const name = 'TasksToolErrorCompletedIsError';
      const description =
        'Tool execution error reports as completed + result.isError (NOT failed)';
      try {
        const created = (await client.request(
          {
            method: 'tools/call',
            params: { name: 'failing_job', arguments: {} }
          },
          AnyResult
        )) as any;
        const errs: string[] = [];
        if (!created.taskId) {
          errs.push('failing_job MUST create a task');
        } else {
          const terminal = await waitForTerminal(client, created.taskId);
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
      const id = 'tasks-protocol-error-failed-shape';
      const name = 'TasksProtocolErrorFailedShape';
      const description =
        'Protocol-level error reports as failed + inlined error{code,message}, no result';
      try {
        const created = (await client.request(
          {
            method: 'tools/call',
            params: { name: 'protocol_error_job', arguments: {} }
          },
          AnyResult
        )) as any;
        const errs: string[] = [];
        if (!created.taskId) {
          errs.push('protocol_error_job MUST create a task');
        } else {
          const terminal = await waitForTerminal(client, created.taskId);
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
      const id = 'tasks-cancel-empty-ack';
      const name = 'TasksCancelEmptyAck';
      const description =
        'tasks/cancel returns {resultType:"complete"} ack; status settles to cancelled';
      let cancelTaskId: string | undefined;
      try {
        const created = (await client.request(
          {
            method: 'tools/call',
            params: {
              name: 'slow_compute',
              arguments: { seconds: 60, label: 'lifecycle-cancel' }
            }
          },
          AnyResult
        )) as any;
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
          const ack = (await client.request(
            { method: 'tasks/cancel', params: { taskId: cancelTaskId } },
            AnyResult
          )) as any;
          const errs: string[] = [];
          // Ack carries only the SEP-2322 discriminator — no task envelope.
          if (
            JSON.stringify(ack) !== JSON.stringify({ resultType: 'complete' })
          ) {
            errs.push(
              `cancel ack MUST be {resultType:"complete"}; got ${JSON.stringify(ack)}`
            );
          }
          // Status settles to cancelled — observe via tasks/get.
          const after = (await client.request(
            { method: 'tasks/get', params: { taskId: cancelTaskId } },
            AnyResult
          )) as any;
          if (after.status !== 'cancelled') {
            errs.push(
              `tasks/get after cancel MUST report cancelled; got ${after.status}`
            );
          }
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

    // Check 8: tasks/cancel on a terminal task MUST return -32602.
    {
      const id = 'tasks-cancel-terminal-rejected';
      const name = 'TasksCancelTerminalRejected';
      const description =
        'tasks/cancel on a terminal task returns -32602 (per spec commit d963ad0)';
      try {
        const created = (await client.request(
          {
            method: 'tools/call',
            params: {
              name: 'slow_compute',
              arguments: { seconds: 1, label: 'lifecycle-cancel-terminal' }
            }
          },
          AnyResult
        )) as any;
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
          await waitForTerminal(client, completedTaskId);
          // Now cancel — must throw -32602.
          let thrown: any;
          try {
            await client.request(
              { method: 'tasks/cancel', params: { taskId: completedTaskId } },
              AnyResult
            );
          } catch (e) {
            thrown = e;
          }
          const errs: string[] = [];
          if (!thrown) {
            errs.push(
              'tasks/cancel on terminal task MUST return JSON-RPC error'
            );
          } else if (thrown.code !== -32602) {
            errs.push(
              `expected error code -32602; got ${thrown.code ?? '<missing>'}`
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
            details: { observedCode: thrown?.code }
          });
        }
      } catch (error) {
        checks.push(failureCheck(id, name, description, error, [SEP_2663_REF]));
      }
    }

    await client.close();
    return checks;
  }
}
