/**
 * SEP-2243 Mcp-Method / Mcp-Name request-header validation, tasks
 * surface.
 *
 * SEP-2243 defines Mcp-Method and Mcp-Name as REQUEST headers (client →
 * server) used by HTTP infrastructure (proxies, gateways, observability)
 * to route or shape JSON-RPC traffic without parsing the body. The
 * server MUST reject requests where the routing headers disagree with
 * (or are missing for a name-carrying body) the JSON-RPC envelope, with
 * HTTP 400 + JSON-RPC `-32001 HeaderMismatch`.
 *
 * This scenario exercises the validation on the tasks surface
 * specifically — the upstream `http-header-validation` scenario covers
 * the general case; here we verify mcpkit's tasks/* methods route
 * through the same validator (matched headers → success; mismatched
 * header → -32001).
 *
 * Required server fixtures:
 *   - greet         — sync-only, returns "Hello, {name}!"
 *   - slow_compute  — task-supporting, sleeps N seconds
 */

import { McpError } from '@modelcontextprotocol/sdk/types.js';

import {
  ClientScenario,
  ConformanceCheck,
  ScenarioSource,
  ScenarioRunOptions
} from '../../../types';
import {
  SEP_2243_REF,
  TASKS_EXTENSION_ID,
  errMsg,
  failureCheck,
  initRawSession,
  type RawSession
} from './helpers';

const HEADER_MISMATCH_ERROR_CODE = -32001;

export class TasksRequestHeadersScenario implements ClientScenario {
  name = 'tasks-request-headers';
  source: ScenarioSource = { extensionId: 'io.modelcontextprotocol/tasks' };
  description = `Test SEP-2243 Mcp-Method / Mcp-Name request-header tolerance.

**Server Implementation Requirements:**

SEP-2243 defines two informational request headers used by HTTP
infrastructure (proxies, gateways, observability) to route or shape
JSON-RPC traffic without parsing the body:

- \`Mcp-Method: <jsonrpc-method>\` — set on every JSON-RPC request.
- \`Mcp-Name: <task-id>\` — set on resume operations (\`tasks/get\`,
  \`tasks/update\`, \`tasks/cancel\`).

The JSON-RPC body is authoritative. The server MUST tolerate the
headers, MUST NOT require them, and MUST NOT change dispatch behavior
based on them — including when the headers disagree with the body.`;

  async run(
    serverUrl: string,
    opts?: ScenarioRunOptions
  ): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    let session: RawSession;
    try {
      session = await initRawSession(serverUrl, {
        stateless: opts?.stateless,
        capabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } }
      });
    } catch (error) {
      checks.push({
        id: 'tasks-session-bootstrap',
        name: 'TasksSessionBootstrap',
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
        const result = (await session.request(
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
    // so we have a real taskId to route on).
    let routingTaskId: string | undefined;
    {
      const id = 'tasks-headers-tolerate-routing-headers-on-tasks-get';
      const name = 'TasksHeadersTolerateRoutingHeadersOnTasksGet';
      const description =
        'Server tolerates Mcp-Method + Mcp-Name request headers on tasks/get (body taskId resolves regardless of routing headers)';
      try {
        const created = (await session.request('tools/call', {
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
          const got = (await session.request(
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
      const description =
        'When Mcp-Method header disagrees with body on a tools/call, server MUST reject with -32001 HeaderMismatch (SEP-2243 §Server Validation)';
      try {
        await session.request(
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
          errorMessage:
            'tools/call with Mcp-Method: tasks/get returned a successful response; SEP-2243 requires -32001 rejection',
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
            errorMessage: `expected -32001 HeaderMismatch; got ${code ?? errMsg(error)}`,
            specReferences: [SEP_2243_REF]
          });
        }
      }
    }

    // Cleanup the long-lived task.
    if (routingTaskId) {
      try {
        await session.request('tasks/cancel', { taskId: routingTaskId });
      } catch {
        /* swallow */
      }
    }

    await session.close().catch(() => {});
    return checks;
  }
}
