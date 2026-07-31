/**
 * SEP-2243 Mcp-Method / Mcp-Name request-header validation, tasks
 * surface.
 *
 * SEP-2243 defines Mcp-Method and Mcp-Name as REQUEST headers (client →
 * server) used by HTTP infrastructure (proxies, gateways, observability)
 * to route or shape JSON-RPC traffic without parsing the body. The
 * server MUST reject requests where the routing headers disagree with
 * (or are missing for a name-carrying body) the JSON-RPC envelope, with
 * HTTP 400 + JSON-RPC `-32020 HeaderMismatch`.
 *
 * This scenario exercises the validation on the tasks surface
 * specifically — the upstream `http-header-validation` scenario covers
 * the general case; here we verify mcpkit's tasks/* methods route
 * through the same validator (matched headers → success; mismatched
 * header → -32020).
 *
 * Required server fixtures:
 *   - greet         — sync-only, returns "Hello, {name}!"
 *   - slow_compute  — task-supporting, sleeps N seconds
 */

import { McpError } from '@modelcontextprotocol/sdk/types.js';

import { ClientScenario, ConformanceCheck } from '../../../types';
import type { Connection, RunContext } from '../../../connection';
import { HEADER_MISMATCH } from '../../../spec-types/draft';
import { SEP_2243_REF, SEP_2663_REF } from './mrtr-helpers';
import { errMsg, failureCheck } from './mrtr-helpers';
import { TASKS_EXTENSION_ID } from './helpers';

const HEADER_MISMATCH_ERROR_CODE = HEADER_MISMATCH;

export class TasksRequestHeadersScenario implements ClientScenario {
  name = 'tasks-request-headers';
  readonly source = { extensionId: 'io.modelcontextprotocol/tasks' } as const;
  description = `Test SEP-2243 Mcp-Method / Mcp-Name request-header validation, tasks surface.

**Server Implementation Requirements:**

SEP-2243 defines two required request headers that mirror body fields
into the HTTP layer for routing intermediaries:

- \`Mcp-Method: <jsonrpc-method>\` — REQUIRED on every JSON-RPC request,
  matching the body \`method\`.
- \`Mcp-Name: <name-shaped-identifier>\` — REQUIRED on requests with a
  name-shaped body field. Per SEP-2243 §"Standard Headers" this covers
  \`tools/call\` (\`params.name\`), \`resources/read\` (\`params.uri\`), and
  \`prompts/get\` (\`params.name\`). SEP-2663 §"Streamable HTTP: Routing
  Headers" extends the requirement to tasks-namespace methods:
  \`tasks/get\`, \`tasks/update\`, and \`tasks/cancel\` MUST carry
  \`Mcp-Name: <taskId>\` matching \`params.taskId\`.

Per SEP-2243 §"Server Behavior", servers that process the request body
MUST validate that header values match the body. Per its "Validation
Failure Conditions", both missing required headers and mismatched
values trigger rejection with JSON-RPC error code \`-32020\`
(HeaderMismatch) and HTTP 400.

**Required server fixtures (\`tools/list\` MUST include all):**
- \`greet\` — sync-only, returns \`Hello, {name}!\`.
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
        id: 'tasks-headers-bootstrap',
        name: 'TasksHeadersBootstrap',
        description:
          'Initialize handshake declaring io.modelcontextprotocol/tasks extension succeeds',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed to initialize: ${errMsg(error)}`,
        specReferences: [SEP_2243_REF]
      });
      return checks;
    }

    // Check 1: Mcp-Method on tools/call against a sync tool.
    {
      const id = 'tasks-headers-tolerate-mcp-method-on-tools-call';
      const name = 'TasksHeadersTolerateMcpMethodOnToolsCall';
      const description =
        'Server tolerates Mcp-Method request header on tools/call (sync tool dispatch unaffected)';
      try {
        const result = (await conn.request(
          'tools/call',
          { name: 'greet', arguments: { name: 'sep-2243' } },
          { 'Mcp-Method': 'tools/call' }
        )) as any;
        const errs: string[] = [];
        if (result.resultType !== 'complete') {
          errs.push(
            `sync ToolResult.resultType MUST be "complete" regardless of routing header; got ${JSON.stringify(result.resultType)}`
          );
        }
        if (
          !Array.isArray(result.content) ||
          result.content.length === 0 ||
          result.content[0]?.text !== 'Hello, sep-2243!'
        ) {
          errs.push(
            'tool result content MUST be unaffected by the Mcp-Method header'
          );
        }
        checks.push({
          id,
          name,
          description,
          status: errs.length === 0 ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: errs.length > 0 ? errs.join('; ') : undefined,
          specReferences: [SEP_2243_REF]
        });
      } catch (error) {
        checks.push(failureCheck(id, name, description, error, [SEP_2243_REF]));
      }
    }

    // Check 2: Mcp-Method + Mcp-Name on tasks/get (drive a task first
    // so we have a real taskId to route on). With matched routing
    // headers the server MUST dispatch normally; this is the positive
    // case complementing the negative-path mismatch checks below.
    let routingTaskId: string | undefined;
    {
      const id = 'sep-2663-routing-headers-accepted-on-tasks-get';
      const name = 'Sep2663RoutingHeadersAcceptedOnTasksGet';
      const description =
        'Server accepts matched Mcp-Method + Mcp-Name request headers on tasks/get and dispatches normally';
      try {
        const created = (await conn.request('tools/call', {
          name: 'slow_compute',
          arguments: { seconds: 60, label: 'headers-tasks-get' }
        })) as any;
        routingTaskId = created.taskId;
        if (!routingTaskId) {
          checks.push({
            id,
            name,
            description,
            status: 'FAILURE',
            timestamp: new Date().toISOString(),
            errorMessage: 'slow_compute did not create a task',
            specReferences: [SEP_2243_REF]
          });
        } else {
          const got = (await conn.request(
            'tasks/get',
            { taskId: routingTaskId },
            {
              'Mcp-Method': 'tasks/get',
              'Mcp-Name': routingTaskId
            }
          )) as any;
          const errs: string[] = [];
          if (got.taskId !== routingTaskId) {
            errs.push(
              `tasks/get MUST resolve body taskId regardless of routing headers; got ${got.taskId}`
            );
          }
          if (!got.status) {
            errs.push(
              'tasks/get MUST still return status when routing headers are set'
            );
          }
          checks.push({
            id,
            name,
            description,
            status: errs.length === 0 ? 'SUCCESS' : 'FAILURE',
            timestamp: new Date().toISOString(),
            errorMessage: errs.length > 0 ? errs.join('; ') : undefined,
            specReferences: [SEP_2243_REF]
          });
        }
      } catch (error) {
        checks.push(failureCheck(id, name, description, error, [SEP_2243_REF]));
      }
    }

    // Check 3: Mismatched Mcp-Method header is rejected on the tasks
    // surface (SEP-2243 §Server Validation, tasks dispatch path).
    {
      const id = 'tasks-headers-reject-mismatched-method';
      const name = 'TasksHeadersRejectMismatchedMethod';
      const description = `When Mcp-Method header disagrees with body on a tools/call, server MUST reject with ${HEADER_MISMATCH_ERROR_CODE} HeaderMismatch (SEP-2243 §Server Validation)`;
      try {
        await conn.request(
          'tools/call',
          { name: 'greet', arguments: { name: 'header-mismatch' } },
          { 'Mcp-Method': 'tasks/get' }
        );
        checks.push({
          id,
          name,
          description,
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: `tools/call with Mcp-Method: tasks/get returned a successful response; SEP-2243 requires ${HEADER_MISMATCH_ERROR_CODE} rejection`,
          specReferences: [SEP_2243_REF]
        });
      } catch (error) {
        const code =
          error instanceof McpError ? error.code : (error as any)?.code;
        if (code === HEADER_MISMATCH_ERROR_CODE) {
          checks.push({
            id,
            name,
            description,
            status: 'SUCCESS',
            timestamp: new Date().toISOString(),
            specReferences: [SEP_2243_REF]
          });
        } else {
          checks.push({
            id,
            name,
            description,
            status: 'FAILURE',
            timestamp: new Date().toISOString(),
            errorMessage: `expected ${HEADER_MISMATCH_ERROR_CODE} HeaderMismatch; got ${code ?? errMsg(error)}`,
            specReferences: [SEP_2243_REF]
          });
        }
      }
    }

    // Check 4: Mismatched Mcp-Name header on tasks/get is rejected.
    // Per SEP-2663 §"Streamable HTTP: Routing Headers" the client MUST
    // set Mcp-Name to params.taskId on tasks/get / tasks/update /
    // tasks/cancel; per SEP-2243 §"Server Behavior" the server MUST
    // reject any header that disagrees with the body. tasks/get is the
    // representative probe — the same rule applies to update/cancel by
    // extension. Confirmed by SEP-2663 author on conformance#262.
    {
      const id = 'sep-2663-server-rejects-mismatched-mcp-name-on-tasks-get';
      const name = 'Sep2663ServerRejectsMismatchedMcpNameOnTasksGet';
      const description = `When Mcp-Name header disagrees with params.taskId on tasks/get, server MUST reject with ${HEADER_MISMATCH_ERROR_CODE} HeaderMismatch`;
      if (!routingTaskId) {
        checks.push({
          id,
          name,
          description,
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage:
            'routing-task fixture from Check 2 unavailable; cannot drive negative-path probe',
          specReferences: [SEP_2243_REF, SEP_2663_REF]
        });
      } else {
        try {
          await conn.request(
            'tasks/get',
            { taskId: routingTaskId },
            { 'Mcp-Name': 'sep-2663-wrong-task-id-for-routing-header-mismatch' }
          );
          checks.push({
            id,
            name,
            description,
            status: 'FAILURE',
            timestamp: new Date().toISOString(),
            errorMessage: `tasks/get with mismatched Mcp-Name returned a result; SEP-2243 requires ${HEADER_MISMATCH_ERROR_CODE} rejection`,
            specReferences: [SEP_2243_REF, SEP_2663_REF]
          });
        } catch (error) {
          const code =
            error instanceof McpError ? error.code : (error as any)?.code;
          if (code === HEADER_MISMATCH_ERROR_CODE) {
            checks.push({
              id,
              name,
              description,
              status: 'SUCCESS',
              timestamp: new Date().toISOString(),
              specReferences: [SEP_2243_REF, SEP_2663_REF]
            });
          } else {
            checks.push({
              id,
              name,
              description,
              status: 'FAILURE',
              timestamp: new Date().toISOString(),
              errorMessage: `expected ${HEADER_MISMATCH_ERROR_CODE} HeaderMismatch; got ${code ?? errMsg(error)}`,
              specReferences: [SEP_2243_REF, SEP_2663_REF]
            });
          }
        }
      }
    }

    // Cleanup the long-lived task.
    if (routingTaskId) {
      try {
        await conn.request('tasks/cancel', { taskId: routingTaskId });
      } catch {
        /* swallow */
      }
    }

    await conn.close().catch(() => {});
    return checks;
  }
}
