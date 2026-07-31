/**
 * SEP-2663 Tasks Extension — capability negotiation conformance.
 *
 * Tests that the server advertises the io.modelcontextprotocol/tasks
 * extension correctly, gates the v2 task surface on negotiation, and
 * supports SEP-2575 per-request capability overrides.
 *
 * Required server fixtures:
 *   - greet         — sync-only, returns "Hello, {name}!"
 *   - slow_compute  — task-supporting, sleeps N seconds
 */

import { ClientScenario, ConformanceCheck } from '../../../types';
import type { Connection, RunContext } from '../../../connection';
import { MISSING_REQUIRED_CLIENT_CAPABILITY } from '../../../spec-types/draft';
import { SEP_2575_REF, SEP_2663_REF } from './mrtr-helpers';
import { errMsg, failureCheck } from './mrtr-helpers';
import { TASKS_EXTENSION_ID } from './helpers';

export class TasksCapabilityNegotiationScenario implements ClientScenario {
  name = 'tasks-capability-negotiation';
  readonly source = { extensionId: 'io.modelcontextprotocol/tasks' } as const;
  description = `Test SEP-2663 capability negotiation for the tasks extension.

**Server Implementation Requirements:**

**Capability advertisement (SEP-2663):**
- The server MUST advertise \`io.modelcontextprotocol/tasks\` under
  \`capabilities.extensions\` in its \`server/discover\` response.
- It MUST NOT use a v1-style \`capabilities.tasks\` slot (the v1 surface
  is replaced by the extension).

**Gating without negotiation (SEP-2663):**
- For requests that do NOT carry the \`io.modelcontextprotocol/tasks\`
  extension in \`_meta.clientCapabilities\`, the server MUST reject
  \`tasks/get\`, \`tasks/update\`, and \`tasks/cancel\` with a
  \`MissingRequiredClientCapability\` error.
- A \`tools/call\` from such a session MUST NOT return
  \`CreateTaskResult\`. Task-supporting tools fall through to synchronous
  execution and return a plain \`ToolResult\` with
  \`resultType:"complete"\`.

**Per-request opt-in (SEP-2575):**
- A session that did not declare the extension at session level can
  opt into task creation for a single \`tools/call\` by including the
  extension under \`_meta.io.modelcontextprotocol/clientCapabilities.extensions\`.
  The server MUST honor the per-request opt-in and produce a
  \`CreateTaskResult\` for that call.

**Required server fixtures (\`tools/list\` MUST include all):**
- \`greet\` — sync-only, returns \`Hello, {name}!\`.
- \`slow_compute\` — task-supporting, \`seconds\`-second sleep then a
  result.`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    // Two parallel sessions: one declares the extension, one does NOT.
    let withExt: Connection;
    let withoutExt: Connection;
    try {
      withExt = await ctx.connect({
        capabilities: {
          elicitation: {},
          sampling: {},
          extensions: { [TASKS_EXTENSION_ID]: {} }
        }
      });
      withoutExt = await ctx.connect({
        capabilities: {}
      });
    } catch (error) {
      checks.push({
        id: 'tasks-capability-bootstrap',
        name: 'TasksCapabilityBootstrap',
        description: 'Initialize handshakes (with + without extension) succeed',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed to initialize: ${errMsg(error)}`,
        specReferences: [SEP_2663_REF]
      });
      return checks;
    }

    // Check 1: server advertises extension under capabilities.extensions.
    {
      const id = 'tasks-extension-advertised';
      const name = 'TasksExtensionAdvertised';
      const description = `Server advertises ${TASKS_EXTENSION_ID} under capabilities.extensions (and not capabilities.tasks)`;
      const discovered = await withExt.discover();
      const caps: any = (discovered.capabilities as any) ?? {};
      const errs: string[] = [];
      if (caps.tasks) {
        errs.push(
          'v1-style capabilities.tasks slot MUST NOT be used; tasks lives under capabilities.extensions'
        );
      }
      if (!caps.extensions) {
        errs.push('capabilities.extensions MUST be advertised');
      } else if (!caps.extensions[TASKS_EXTENSION_ID]) {
        errs.push(
          `capabilities.extensions["${TASKS_EXTENSION_ID}"] MUST be present`
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
          hasExtensions: Boolean(caps.extensions),
          hasTasksExtension: Boolean(caps.extensions?.[TASKS_EXTENSION_ID]),
          hasV1TasksSlot: Boolean(caps.tasks)
        }
      });
    }

    // Check 2: tasks/* methods rejected with the
    // MissingRequiredClientCapability error when the client did not
    // negotiate the tasks extension. Follows the SEP-2575 §"Missing
    // Required Capabilities" pattern — same code path as the
    // required-task-error scenario and (when implemented)
    // subscriptions/listen for tasks.
    {
      const id = 'sep-2663-tasks-methods-non-declaring';
      const name = 'TasksMethodsGatedWithoutExtension';
      const description = `tasks/get, tasks/update, tasks/cancel return ${MISSING_REQUIRED_CLIENT_CAPABILITY} when the client did not negotiate the tasks extension (SEP-2575 Missing Required Capabilities)`;
      const cases: Array<{ method: string; params: any }> = [
        { method: 'tasks/get', params: { taskId: 'gate-test' } },
        {
          method: 'tasks/update',
          params: { taskId: 'gate-test', inputResponses: {} }
        },
        { method: 'tasks/cancel', params: { taskId: 'gate-test' } }
      ];
      const errs: string[] = [];
      for (const tc of cases) {
        try {
          await withoutExt.request(tc.method, tc.params);
          errs.push(`${tc.method} MUST reject (it returned a result)`);
        } catch (e: any) {
          if (e.code !== MISSING_REQUIRED_CLIENT_CAPABILITY) {
            errs.push(
              `${tc.method} MUST return ${MISSING_REQUIRED_CLIENT_CAPABILITY}; got ${e.code ?? '<missing>'}`
            );
          }
        }
      }
      checks.push({
        id,
        name,
        description,
        status: errs.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: errs.length > 0 ? errs.join('; ') : undefined,
        specReferences: [SEP_2575_REF, SEP_2663_REF]
      });
    }

    // Check 3: tools/call without extension returns sync ToolResult, not task.
    {
      const id = 'sep-2663-server-rejects-undeclared-client';
      const name = 'TasksToolsCallWithoutExtensionSync';
      const description =
        'tools/call from a session without the extension MUST fall through to sync (no CreateTaskResult, even for task-supporting tools)';
      try {
        const result = (await withoutExt.request('tools/call', {
          name: 'slow_compute',
          arguments: { seconds: 0, label: 'capability-no-ext' }
        })) as any;
        const errs: string[] = [];
        if (result.resultType === 'task') {
          errs.push(
            'tools/call without extension MUST NOT return resultType:"task"'
          );
        }
        if (result.taskId) {
          errs.push(
            `tools/call without extension MUST NOT carry top-level taskId; got ${result.taskId}`
          );
        }
        if (result.task) {
          errs.push(
            'tools/call without extension MUST NOT carry the v1-style nested `task` envelope'
          );
        }
        if (!result.content) {
          errs.push(
            'tools/call without extension MUST return sync ToolResult with content[]'
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
            resultType: result.resultType,
            hasTaskId: Boolean(result.taskId)
          }
        });
      } catch (error) {
        checks.push(failureCheck(id, name, description, error, [SEP_2663_REF]));
      }
    }

    // Check 4: SEP-2575 per-request _meta opt-in produces CreateTaskResult.
    {
      const id = 'tasks-per-request-meta-opt-in';
      const name = 'TasksPerRequestMetaOptIn';
      const description =
        'tools/call with extension declared in _meta.io.modelcontextprotocol/clientCapabilities produces a CreateTaskResult even when the session did not negotiate the extension';
      try {
        const result = (await withoutExt.request('tools/call', {
          name: 'slow_compute',
          arguments: { seconds: 1, label: 'capability-meta-opt' },
          _meta: {
            'io.modelcontextprotocol/clientCapabilities': {
              extensions: { [TASKS_EXTENSION_ID]: {} }
            }
          }
        })) as any;
        const errs: string[] = [];
        if (result.resultType !== 'task') {
          errs.push(
            `expected resultType:"task" via per-request opt-in; got ${JSON.stringify(result.resultType)}`
          );
        }
        if (!result.taskId) {
          errs.push(
            'per-request opt-in MUST produce a CreateTaskResult with top-level taskId'
          );
        }
        if (result.task) {
          errs.push(
            'CreateTaskResult MUST be flat (no nested `task` wrapper) even on per-request opt-in path'
          );
        }
        // Best-effort cleanup: cancel the task so we don't leak a 1s
        // background goroutine on the server.
        if (result.taskId) {
          try {
            await withExt.request('tasks/cancel', { taskId: result.taskId });
          } catch {
            /* swallow — cleanup best-effort */
          }
        }
        checks.push({
          id,
          name,
          description,
          status: errs.length === 0 ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: errs.length > 0 ? errs.join('; ') : undefined,
          specReferences: [SEP_2575_REF, SEP_2663_REF],
          details: {
            resultType: result.resultType,
            taskId: result.taskId
          }
        });
      } catch (error) {
        checks.push(failureCheck(id, name, description, error, [SEP_2575_REF]));
      }
    }

    await withExt.close().catch(() => {});
    await withoutExt.close().catch(() => {});
    return checks;
  }
}
