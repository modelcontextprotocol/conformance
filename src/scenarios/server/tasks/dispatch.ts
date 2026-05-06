/**
 * SEP-2663 Tasks Extension — dispatch + envelope conformance.
 *
 * Bundles a number of small, related checks under one scenario:
 *   - Removed v1 methods (tasks/result, tasks/list) reject as -32601.
 *   - Server-directed task creation works without a client `task` hint
 *     param; legacy v1 `task` param on tools/call is tolerated and
 *     ignored on sync tools.
 *   - Immediate-result shortcut: a fast operation MAY skip task creation
 *     and return a sync ToolResult.
 *   - SEP-2322 resultType:"complete" discriminator on every non-task
 *     response (sync tools/call, tasks/get, tasks/update, tasks/cancel).
 *   - Strong consistency: tasks/get immediately after CreateTaskResult
 *     MUST resolve.
 *   - tasks/get with an unknown taskId MUST return -32602.
 *
 * Required server fixtures:
 *   - greet           — sync-only
 *   - slow_compute    — task-supporting (seconds:0 = instant)
 *   - confirm_delete  — task-supporting, parks for elicitation
 *   - failing_job     — task-supporting, returns tool error
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  ClientScenario,
  ConformanceCheck,
  ScenarioSpecTag,
  DRAFT_PROTOCOL_VERSION
} from '../../../types';
import {
  TASKS_EXTENSION_ID,
  SEP_2322_REF,
  SEP_2663_REF,
  AnyResult,
  errMsg,
  failureCheck,
  waitForStatus,
  waitForTerminal
} from './helpers';

export class TasksDispatchScenario implements ClientScenario {
  name = 'tasks-dispatch-and-envelope';
  specVersions: ScenarioSpecTag[] = ['extension', DRAFT_PROTOCOL_VERSION];
  description = `Test SEP-2663 dispatch / envelope rules across the tasks surface.

**Server Implementation Requirements:**

**Removed v1 methods (SEP-2663):**
- \`tasks/result\` is removed in v2 — the result is inlined on
  \`tasks/get\`. Servers MUST reject the method with JSON-RPC \`-32601\`.
- \`tasks/list\` is removed in v2. Servers MUST reject it with
  \`-32601\`.

**Server-directed task creation (SEP-2663):**
- The client does NOT send a \`task\` hint param. The server alone
  decides whether to create a task. A \`tools/call\` against a
  task-supporting tool MUST produce \`CreateTaskResult\` even with no
  client hint.

**Legacy \`task\` param tolerated (SEP-2663):**
- A v1 client may still send \`task: { ttl, pollInterval }\` on
  \`tools/call\`. The server MUST tolerate it (no error) AND MUST NOT
  promote a sync-only tool to a task on its presence. The body
  arguments + tool registration are authoritative.

**Immediate-result shortcut (SEP-2663):**
- A server MAY return a sync \`ToolResult\` for task-supporting tools
  when the operation completes fast enough. Either return a
  \`CreateTaskResult\` (with \`resultType:"task"\`) or a sync
  \`ToolResult\` (with \`resultType:"complete"\`); both are valid.

**resultType:"complete" on non-task responses (SEP-2322):**
- Every JSON-RPC response on the tools+tasks surface other than a
  CreateTaskResult MUST carry \`resultType:"complete"\`. This applies
  to: sync \`tools/call\`, \`tasks/get\`, \`tasks/update\` ack,
  \`tasks/cancel\` ack.

**Strong consistency / durable create (SEP-2663):**
- A server MUST NOT return \`CreateTaskResult\` until the task is
  durably created — that is, until a \`tasks/get\` for the returned
  \`taskId\` would resolve. Issuing \`tasks/get\` immediately after the
  CreateTaskResult arrives MUST succeed, not -32602.

**Unknown taskId on tasks/get (SEP-2663):**
- \`tasks/get\` for a taskId the server doesn't recognize MUST return
  JSON-RPC \`-32602\` (InvalidParams). Mirrors the same rule for
  \`tasks/cancel\` (clarified upstream in spec commit d963ad0).`;

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

    // Check 1: tasks/result removed.
    {
      const id = 'tasks-removed-tasks-result';
      const name = 'TasksRemovedTasksResult';
      const description =
        'tasks/result is removed in v2 and MUST reject with -32601';
      try {
        await client.request(
          { method: 'tasks/result', params: { taskId: 'any' } },
          AnyResult
        );
        checks.push({
          id,
          name,
          description,
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: 'tasks/result returned a result instead of -32601',
          specReferences: [SEP_2663_REF]
        });
      } catch (e: any) {
        const errs: string[] = [];
        if (e.code !== -32601) {
          errs.push(`expected -32601; got ${e.code ?? '<missing>'}`);
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
      }
    }

    // Check 2: tasks/list removed.
    {
      const id = 'tasks-removed-tasks-list';
      const name = 'TasksRemovedTasksList';
      const description =
        'tasks/list is removed in v2 and MUST reject with -32601';
      try {
        await client.request({ method: 'tasks/list', params: {} }, AnyResult);
        checks.push({
          id,
          name,
          description,
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: 'tasks/list returned a result instead of -32601',
          specReferences: [SEP_2663_REF]
        });
      } catch (e: any) {
        const errs: string[] = [];
        if (e.code !== -32601) {
          errs.push(`expected -32601; got ${e.code ?? '<missing>'}`);
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
      }
    }

    // Check 3: server-directed task creation without client hint.
    {
      const id = 'tasks-server-directed-creation-no-hint';
      const name = 'TasksServerDirectedCreationNoHint';
      const description =
        'tools/call with no client `task` hint param MUST still produce CreateTaskResult for task-supporting tools';
      try {
        const result = (await client.request(
          {
            method: 'tools/call',
            params: { name: 'failing_job', arguments: {} }
          },
          AnyResult
        )) as any;
        const errs: string[] = [];
        if (result.resultType !== 'task' || !result.taskId) {
          errs.push(
            `expected CreateTaskResult; got resultType=${JSON.stringify(result.resultType)}, taskId=${JSON.stringify(result.taskId)}`
          );
        }
        // Best-effort wait so we don't leak.
        if (result.taskId) {
          try {
            await waitForTerminal(client, result.taskId);
          } catch {
            /* swallow */
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

    // Check 4: legacy `task` param tolerated + ignored on sync tool.
    {
      const id = 'tasks-legacy-task-param-ignored';
      const name = 'TasksLegacyTaskParamIgnored';
      const description =
        'tools/call with legacy `task` param against a sync tool MUST NOT error and MUST NOT be promoted to a task';
      try {
        const result = (await client.request(
          {
            method: 'tools/call',
            params: {
              name: 'greet',
              arguments: { name: 'legacy-hint' },
              // Legacy v1 hint that the server MUST ignore.
              task: { ttl: 60_000, pollInterval: 100 }
            }
          },
          AnyResult
        )) as any;
        const errs: string[] = [];
        if (result.resultType === 'task') {
          errs.push(
            'legacy `task` param MUST NOT promote a sync tool to a task'
          );
        }
        if (result.taskId) {
          errs.push(
            `sync tool with legacy hint MUST NOT carry top-level taskId; got ${result.taskId}`
          );
        }
        if (!Array.isArray(result.content) || result.content.length === 0) {
          errs.push('sync tool MUST still return content[]');
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

    // Check 5: immediate-result shortcut. Either CreateTaskResult OR
    // sync ToolResult is acceptable for an instant operation.
    {
      const id = 'tasks-immediate-result-shortcut';
      const name = 'TasksImmediateResultShortcut';
      const description =
        'For a fast operation, a task-supporting tool MAY skip task creation and return a sync ToolResult; either path is valid';
      try {
        const result = (await client.request(
          {
            method: 'tools/call',
            params: {
              name: 'slow_compute',
              arguments: { seconds: 0, label: 'instant' }
            }
          },
          AnyResult
        )) as any;
        const errs: string[] = [];
        if (result.resultType === 'task') {
          if (!result.taskId) {
            errs.push(
              'task-path response MUST carry top-level taskId on CreateTaskResult'
            );
          }
        } else {
          // Sync path
          if (!Array.isArray(result.content)) {
            errs.push(
              'sync-path response MUST carry content[] for the immediate ToolResult'
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
          specReferences: [SEP_2663_REF],
          details: { resultType: result.resultType }
        });
      } catch (error) {
        checks.push(failureCheck(id, name, description, error, [SEP_2663_REF]));
      }
    }

    // Check 6: resultType:"complete" on every non-task response.
    {
      const id = 'tasks-result-type-complete-on-non-task-responses';
      const name = 'TasksResultTypeCompleteOnNonTaskResponses';
      const description =
        'Sync tools/call, tasks/get, tasks/update ack, and tasks/cancel ack MUST all carry resultType:"complete"';
      const errs: string[] = [];
      try {
        // Sync tools/call.
        const sync = (await client.request(
          {
            method: 'tools/call',
            params: { name: 'greet', arguments: { name: 'rt' } }
          },
          AnyResult
        )) as any;
        if (sync.resultType !== 'complete') {
          errs.push(
            `sync tools/call resultType = ${JSON.stringify(sync.resultType)}, want "complete"`
          );
        }

        // tasks/get against a fresh task.
        const created = (await client.request(
          {
            method: 'tools/call',
            params: {
              name: 'slow_compute',
              arguments: { seconds: 0, label: 'rt-get' }
            }
          },
          AnyResult
        )) as any;
        const taskIdForGet = created.taskId;
        if (taskIdForGet) {
          await waitForTerminal(client, taskIdForGet);
          const got = (await client.request(
            { method: 'tasks/get', params: { taskId: taskIdForGet } },
            AnyResult
          )) as any;
          if (got.resultType !== 'complete') {
            errs.push(
              `tasks/get resultType = ${JSON.stringify(got.resultType)}, want "complete"`
            );
          }
        }

        // tasks/cancel ack on a fresh long-running task.
        const longLived = (await client.request(
          {
            method: 'tools/call',
            params: {
              name: 'slow_compute',
              arguments: { seconds: 60, label: 'rt-cancel' }
            }
          },
          AnyResult
        )) as any;
        if (longLived.taskId) {
          const cancelAck = (await client.request(
            { method: 'tasks/cancel', params: { taskId: longLived.taskId } },
            AnyResult
          )) as any;
          if (cancelAck.resultType !== 'complete') {
            errs.push(
              `tasks/cancel ack resultType = ${JSON.stringify(cancelAck.resultType)}, want "complete"`
            );
          }
        }

        // tasks/update ack on a parked elicitation task.
        const elicit = (await client.request(
          {
            method: 'tools/call',
            params: {
              name: 'confirm_delete',
              arguments: { filename: 'rt.txt' }
            }
          },
          AnyResult
        )) as any;
        const elicitTaskId = elicit.taskId;
        if (elicitTaskId) {
          await waitForStatus(client, elicitTaskId, 'input_required', 5_000);
          const updateAck = (await client.request(
            {
              method: 'tasks/update',
              params: {
                taskId: elicitTaskId,
                inputResponses: { 'unknown-key': { ignored: true } }
              }
            },
            AnyResult
          )) as any;
          if (updateAck.resultType !== 'complete') {
            errs.push(
              `tasks/update ack resultType = ${JSON.stringify(updateAck.resultType)}, want "complete"`
            );
          }
          try {
            await client.request(
              { method: 'tasks/cancel', params: { taskId: elicitTaskId } },
              AnyResult
            );
          } catch {
            /* swallow */
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
      } catch (error) {
        checks.push(failureCheck(id, name, description, error, [SEP_2322_REF]));
      }
    }

    // Check 7: strong consistency — immediate tasks/get after CreateTaskResult.
    {
      const id = 'tasks-strong-consistency-immediate-get';
      const name = 'TasksStrongConsistencyImmediateGet';
      const description =
        'tasks/get issued immediately after CreateTaskResult arrives MUST resolve (server MUST NOT return CreateTaskResult before the task is durably created)';
      try {
        const created = (await client.request(
          {
            method: 'tools/call',
            params: {
              name: 'slow_compute',
              arguments: { seconds: 60, label: 'consistency' }
            }
          },
          AnyResult
        )) as any;
        const taskId = created.taskId;
        if (!taskId) {
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
          // No await/sleep between create and get — codifies the
          // strong-consistency ordering.
          const got = (await client.request(
            { method: 'tasks/get', params: { taskId } },
            AnyResult
          )) as any;
          const errs: string[] = [];
          if (got.taskId !== taskId) {
            errs.push(
              `immediate tasks/get MUST resolve the same taskId; got ${got.taskId}`
            );
          }
          // Cleanup.
          try {
            await client.request(
              { method: 'tasks/cancel', params: { taskId } },
              AnyResult
            );
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
            specReferences: [SEP_2663_REF]
          });
        }
      } catch (error) {
        checks.push(failureCheck(id, name, description, error, [SEP_2663_REF]));
      }
    }

    // Check 8: tasks/get with unknown taskId returns -32602.
    {
      const id = 'tasks-get-unknown-task-id-rejected';
      const name = 'TasksGetUnknownTaskIdRejected';
      const description =
        'tasks/get for a taskId the server does not recognize MUST return -32602';
      try {
        await client.request(
          {
            method: 'tasks/get',
            params: { taskId: 'tasks-conformance-nonexistent-12345' }
          },
          AnyResult
        );
        checks.push({
          id,
          name,
          description,
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: 'tasks/get with unknown taskId returned a result',
          specReferences: [SEP_2663_REF]
        });
      } catch (e: any) {
        const errs: string[] = [];
        if (e.code !== -32602) {
          errs.push(`expected -32602; got ${e.code ?? '<missing>'}`);
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
      }
    }

    await client.close().catch(() => {});
    return checks;
  }
}
