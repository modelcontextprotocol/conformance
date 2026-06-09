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

import { ClientScenario, ConformanceCheck } from '../../../types';
import type { Connection, RunContext } from '../../../connection';
import { SEP_2322_REF, SEP_2663_REF } from './mrtr-helpers';
import { errMsg, failureCheck } from './mrtr-helpers';
import {
  TASKS_EXTENSION_ID,
  validTasksParams,
  waitForStatus,
  waitForTerminal
} from './helpers';

/**
 * Diagnostic suffix for negative-path checks. When a server returns
 * the wrong JSON-RPC error code, the most common cause (per the
 * SEP-2663 review on conformance#262) is that the server validated
 * some other dimension of the request first — routing headers,
 * `_meta`, params shape — and short-circuited before reaching the
 * code path the check is actually probing. The check fixture
 * already sends an otherwise-valid envelope via `validTasksParams`
 * + raw-session auto-headers, so a wrong code here usually means
 * either the server has a different validation order than expected
 * or the fixture envelope is still missing something this server
 * requires. Mention both possibilities so the failure is debuggable.
 */
const ISOLATION_HINT =
  '(if the server is otherwise compliant, verify it does not validate other dimensions — routing headers, _meta, params shape — before method dispatch)';

export class TasksDispatchScenario implements ClientScenario {
  name = 'tasks-dispatch-and-envelope';
  readonly source = { extensionId: 'io.modelcontextprotocol/tasks' } as const;
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
  \`tasks/cancel\` (clarified upstream in spec commit d963ad0).

**Required server fixtures (\`tools/list\` MUST include all):**
- \`greet\` — sync-only.
- \`slow_compute\` — task-supporting (\`seconds: 0\` for the immediate
  shortcut path).
- \`confirm_delete\` — task-supporting, parks for elicitation.
- \`failing_job\` — task-supporting, returns a tool execution error.`;

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
        id: 'tasks-dispatch-bootstrap',
        name: 'TasksDispatchBootstrap',
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
    //
    // Isolation: the request body uses a v1-shaped { taskId } via
    // validTasksParams, and the raw-session emits Mcp-Method +
    // Mcp-Name routing headers and the standard _meta envelope. The
    // ONLY thing the server should object to is the method name.
    {
      const id = 'sep-2663-tasks-result-removed-method-not-found';
      const name = 'TasksRemovedTasksResult';
      const description =
        'tasks/result is removed in v2 and MUST reject with -32601';
      try {
        await conn.request('tasks/result', validTasksParams('tasks/result'));
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
          errs.push(
            `expected -32601; got ${e.code ?? '<missing>'} ${ISOLATION_HINT}`
          );
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
    //
    // Isolation: v1 tasks/list took no required params; the empty
    // body is fully valid. Routing headers + _meta come from raw-
    // conn. Only the method name itself is wrong.
    {
      const id = 'tasks-removed-tasks-list';
      const name = 'TasksRemovedTasksList';
      const description =
        'tasks/list is removed in v2 and MUST reject with -32601';
      try {
        await conn.request('tasks/list', validTasksParams('tasks/list'));
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
          errs.push(
            `expected -32601; got ${e.code ?? '<missing>'} ${ISOLATION_HINT}`
          );
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
        const result = (await conn.request('tools/call', {
          name: 'failing_job',
          arguments: {}
        })) as any;
        const errs: string[] = [];
        if (result.resultType !== 'task' || !result.taskId) {
          errs.push(
            `expected CreateTaskResult; got resultType=${JSON.stringify(result.resultType)}, taskId=${JSON.stringify(result.taskId)}`
          );
        }
        // Best-effort wait so we don't leak.
        if (result.taskId) {
          try {
            await waitForTerminal(conn, result.taskId);
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
      const id = 'sep-2663-legacy-task-param-ignored';
      const name = 'TasksLegacyTaskParamIgnored';
      const description =
        'tools/call with legacy `task` param against a sync tool MUST NOT error and MUST NOT be promoted to a task';
      try {
        const result = (await conn.request('tools/call', {
          name: 'greet',
          arguments: { name: 'legacy-hint' },
          // Legacy v1 hint that the server MUST ignore.
          task: { ttl: 60_000, pollInterval: 100 }
        })) as any;
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
        const result = (await conn.request('tools/call', {
          name: 'slow_compute',
          arguments: { seconds: 0, label: 'instant' }
        })) as any;
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
        const sync = (await conn.request('tools/call', {
          name: 'greet',
          arguments: { name: 'rt' }
        })) as any;
        if (sync.resultType !== 'complete') {
          errs.push(
            `sync tools/call resultType = ${JSON.stringify(sync.resultType)}, want "complete"`
          );
        }

        // tasks/get against a fresh task.
        const created = (await conn.request('tools/call', {
          name: 'slow_compute',
          arguments: { seconds: 0, label: 'rt-get' }
        })) as any;
        const taskIdForGet = created.taskId;
        if (taskIdForGet) {
          await waitForTerminal(conn, taskIdForGet);
          const got = (await conn.request('tasks/get', {
            taskId: taskIdForGet
          })) as any;
          if (got.resultType !== 'complete') {
            errs.push(
              `tasks/get resultType = ${JSON.stringify(got.resultType)}, want "complete"`
            );
          }
        }

        // tasks/cancel ack on a fresh long-running task.
        const longLived = (await conn.request('tools/call', {
          name: 'slow_compute',
          arguments: { seconds: 60, label: 'rt-cancel' }
        })) as any;
        if (longLived.taskId) {
          const cancelAck = (await conn.request('tasks/cancel', {
            taskId: longLived.taskId
          })) as any;
          if (cancelAck.resultType !== 'complete') {
            errs.push(
              `tasks/cancel ack resultType = ${JSON.stringify(cancelAck.resultType)}, want "complete"`
            );
          }
        }

        // tasks/update ack on a parked elicitation task.
        const elicit = (await conn.request('tools/call', {
          name: 'confirm_delete',
          arguments: { filename: 'rt.txt' }
        })) as any;
        const elicitTaskId = elicit.taskId;
        if (elicitTaskId) {
          await waitForStatus(conn, elicitTaskId, 'input_required', 5_000);
          const updateAck = (await conn.request('tasks/update', {
            taskId: elicitTaskId,
            inputResponses: { 'unknown-key': { ignored: true } }
          })) as any;
          if (updateAck.resultType !== 'complete') {
            errs.push(
              `tasks/update ack resultType = ${JSON.stringify(updateAck.resultType)}, want "complete"`
            );
          }
          try {
            await conn.request('tasks/cancel', { taskId: elicitTaskId });
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
      const id = 'sep-2663-durable-create-strong-consistency';
      const name = 'TasksStrongConsistencyImmediateGet';
      const description =
        'tasks/get issued immediately after CreateTaskResult arrives MUST resolve (server MUST NOT return CreateTaskResult before the task is durably created)';
      try {
        const created = (await conn.request('tools/call', {
          name: 'slow_compute',
          arguments: { seconds: 60, label: 'consistency' }
        })) as any;
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
          const got = (await conn.request('tasks/get', { taskId })) as any;
          const errs: string[] = [];
          if (got.taskId !== taskId) {
            errs.push(
              `immediate tasks/get MUST resolve the same taskId; got ${got.taskId}`
            );
          }
          // Cleanup.
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
            specReferences: [SEP_2663_REF]
          });
        }
      } catch (error) {
        checks.push(failureCheck(id, name, description, error, [SEP_2663_REF]));
      }
    }

    // Check 8: tasks/get with unknown taskId returns -32602.
    //
    // Isolation: tasks/get is a supported method; the taskId is the
    // single property under test. The unknown taskId appears in both
    // body and Mcp-Name header (raw-session mirrors it) so a server
    // that validates routing headers first will route to tasks/get
    // and reject for "unknown taskId" specifically — not for header
    // mismatch.
    {
      const id = 'sep-2663-tasks-get-invalid-task-id-32602';
      const name = 'TasksGetUnknownTaskIdRejected';
      const description =
        'tasks/get for a taskId the server does not recognize MUST return -32602';
      try {
        await conn.request(
          'tasks/get',
          validTasksParams('tasks/get', {
            taskId: 'tasks-conformance-nonexistent-12345'
          })
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
          errs.push(
            `expected -32602; got ${e.code ?? '<missing>'} ${ISOLATION_HINT}`
          );
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

    await conn.close().catch(() => {});
    return checks;
  }
}
