/**
 * SEP-2243 Mcp-Method / Mcp-Name request-header tolerance.
 *
 * SEP-2243 defines Mcp-Method and Mcp-Name as REQUEST headers (client →
 * server) used by HTTP infrastructure (proxies, gateways, observability)
 * to route or shape JSON-RPC traffic without parsing the body. They are
 * informational; the JSON-RPC body is authoritative. A conformant
 * server MUST tolerate the headers without changing dispatch.
 *
 * Whether the server *also* echoes these headers on responses for
 * downstream observability is implementation-defined and out of scope
 * for SEP-2243 conformance.
 *
 * Required server fixtures:
 *   - greet         — sync-only, returns "Hello, {name}!"
 *   - slow_compute  — task-supporting, sleeps N seconds
 */

import {
  ClientScenario,
  ConformanceCheck,
  ScenarioSource
} from '../../../types';
import {
  SEP_2243_REF,
  TASKS_EXTENSION_ID,
  errMsg,
  failureCheck,
  initRawSession,
  type RawSession
} from './helpers';

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

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    let session: RawSession;
    try {
      session = await initRawSession(serverUrl, {
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

    // Check 3: Body method is authoritative when Mcp-Method header
    // disagrees with body.
    {
      const id = 'tasks-headers-body-method-authoritative';
      const name = 'TasksHeadersBodyMethodAuthoritative';
      const description =
        'When Mcp-Method header disagrees with body, server MUST dispatch on body method (header is informational)';
      try {
        const result = (await session.request(
          'tools/call',
          { name: 'greet', arguments: { name: 'header-mismatch' } },
          { 'Mcp-Method': 'tasks/get' }
        )) as any;
        const errs: string[] = [];
        if (result.resultType !== 'complete') {
          errs.push(
            `server MUST dispatch on body method (tools/call → resultType:"complete"); got ${JSON.stringify(result.resultType)}`
          );
        }
        if (
          !Array.isArray(result.content) ||
          result.content[0]?.text !== 'Hello, header-mismatch!'
        ) {
          errs.push(
            'tool result MUST reflect the body method, not the header claim'
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
