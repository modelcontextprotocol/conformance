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

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  ClientScenario,
  ConformanceCheck,
  ScenarioSource
} from '../../../types';
import {
  TASKS_EXTENSION_ID,
  SEP_2243_REF,
  AnyResult,
  errMsg,
  failureCheck
} from './helpers';

/**
 * Minimal raw POST that lets us inject SEP-2243 routing headers
 * (Mcp-Method, Mcp-Name) on a JSON-RPC call. The SDK's
 * StreamableHTTPClientTransport doesn't expose per-request HTTP
 * headers, and this whole scenario exists to verify the server tolerates
 * those headers — so we pin a single raw fetch helper to this file.
 *
 * Reuses the SDK transport's session via `transport.sessionId` so the
 * request lands on the same already-initialized session.
 */
async function rawJsonRpcWithHeaders(
  serverUrl: string,
  sessionId: string,
  method: string,
  params: any,
  extraHeaders: Record<string, string>
): Promise<any> {
  const resp = await fetch(serverUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId,
      ...extraHeaders
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `hdr-${Math.random().toString(36).slice(2, 10)}`,
      method,
      params
    })
  });
  const ct = resp.headers.get('content-type') || '';
  let body: any;
  if (ct.includes('text/event-stream')) {
    const text = await resp.text();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data:')) {
        const payload = trimmed.slice(5).trimStart();
        if (payload.startsWith('{')) {
          const parsed = JSON.parse(payload);
          if (parsed.id !== undefined && (parsed.result || parsed.error)) {
            body = parsed;
            break;
          }
        }
      }
    }
  } else {
    body = await resp.json();
  }
  if (!body) {
    throw new Error(`No JSON-RPC frame in response (status ${resp.status})`);
  }
  if (body.error) {
    const err: any = new Error(body.error.message || 'JSON-RPC error');
    err.code = body.error.code;
    err.data = body.error.data;
    throw err;
  }
  return body.result;
}

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

    let client: Client;
    let transport: StreamableHTTPClientTransport;
    try {
      client = new Client(
        { name: 'mcp-conformance', version: '1.0' },
        { capabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } } }
      );
      transport = new StreamableHTTPClientTransport(new URL(serverUrl));
      await client.connect(transport);
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
        const result = await rawJsonRpcWithHeaders(
          serverUrl,
          transport.sessionId!,
          'tools/call',
          { name: 'greet', arguments: { name: 'sep-2243' } },
          { 'Mcp-Method': 'tools/call' }
        );
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
        const created = (await client.request(
          {
            method: 'tools/call',
            params: {
              name: 'slow_compute',
              arguments: { seconds: 60, label: 'headers-tasks-get' }
            }
          },
          AnyResult
        )) as any;
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
          const got = await rawJsonRpcWithHeaders(
            serverUrl,
            transport.sessionId!,
            'tasks/get',
            { taskId: routingTaskId },
            {
              'Mcp-Method': 'tasks/get',
              'Mcp-Name': routingTaskId
            }
          );
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
        const result = await rawJsonRpcWithHeaders(
          serverUrl,
          transport.sessionId!,
          'tools/call',
          { name: 'greet', arguments: { name: 'header-mismatch' } },
          { 'Mcp-Method': 'tasks/get' }
        );
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
        await client.request(
          {
            method: 'tasks/cancel',
            params: { taskId: routingTaskId }
          },
          AnyResult
        );
      } catch {
        /* swallow */
      }
    }

    await client.close().catch(() => {});
    return checks;
  }
}
