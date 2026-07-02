/**
 * SEP-2663 Tasks Extension — CLIENT conformance (issue #374).
 *
 * The harness acts as a task-capable MCP server and observes how the client
 * under test drives the io.modelcontextprotocol/tasks extension:
 *
 * - Polymorphic results: a `tools/call` the server task-augments returns a
 *   `CreateTaskResult`; the client must recognize `resultType:"task"` and
 *   drive `tasks/get` polling to the inlined result, while a plain
 *   `CallToolResult` on the same negotiated session is handled normally.
 *   > "A client that has negotiated this extension MUST be prepared to
 *   > handle either CallToolResult or CreateTaskResult in response to any
 *   > supported request it issues."
 * - Routing headers: every `tasks/get` / `tasks/update` / `tasks/cancel`
 *   POST must stamp `Mcp-Name` with `params.taskId`.
 *   > "When tasks/get, tasks/update, or tasks/cancel is sent over the
 *   > Streamable HTTP transport, the client MUST set the Mcp-Name header
 *   > (defined by SEP-2243) to the value of params.taskId."
 * - Poll cadence: `pollIntervalMs` is honored between consecutive polls
 *   (gated on the early side only, so slow CI cannot flake it).
 *   > "Clients SHOULD respect the pollIntervalMs provided in responses when
 *   > determining polling frequency."
 * - Terminal handling: a `failed` task (inlined JSON-RPC `error`) is
 *   surfaced and the flow continues instead of polling forever.
 * - Cancellation channel:
 *   > "The notifications/cancelled notification MUST NOT be used for task
 *   > cancellation." — cancellation must arrive as `tasks/cancel`.
 * - Invalid augmentation: a `CreateTaskResult` returned to a request type
 *   that does not support task augmentation (`ping`) must be rejected.
 *   > "A client that receives CreateTaskResult in response to an
 *   > unsupported request type MUST interpret this as an invalid response
 *   > to the request."
 *
 * A client that never declares the extension capability (neither in
 * `initialize` `capabilities.extensions` nor per-request in
 * `_meta["io.modelcontextprotocol/clientCapabilities"].extensions`) simply
 * has not opted into this optional extension: all checks report SKIPPED,
 * mirroring how optional capabilities are treated elsewhere. A client that
 * never sends any request at all is a failed run, not an opt-out.
 */

import http from 'http';
import {
  ConformanceCheck,
  ScenarioSource,
  SpecReference
} from '../../types.js';
import { BaseHttpScenario } from './http-base.js';
import {
  withRequiredDraftResultFields,
  type ScenarioContext
} from '../../mock-server';
import { SEP_2663_REF, SEP_2243_REF } from '../server/tasks/mrtr-helpers';
import { TASKS_EXTENSION_ID } from '../server/tasks/helpers';
import { untestableCheck } from '../untestable';

/** pollIntervalMs advertised on every non-terminal task response. */
export const TASKS_CLIENT_POLL_INTERVAL_MS = 300;
/**
 * Early-side tolerance: a poll is only flagged when it arrives more than
 * this many milliseconds before pollIntervalMs has elapsed. Late polls are
 * never flagged (slow CI must not flake the check), mirroring the sse-retry
 * scenario's early-side-only timing gate.
 */
export const TASKS_CLIENT_POLL_TOLERANCE_MS = 50;

const TASK_QUICK = 'task-quick-0001';
const TASK_FAIL = 'task-fail-0001';
const TASK_CANCEL = 'task-cancel-0001';
/** taskId of the invalid CreateTaskResult returned to `ping`. */
const TASK_BOGUS = 'task-bogus-0001';

const TASK_TTL_MS = 60_000;

/** Every check id this scenario emits, in a stable order. */
export const TASKS_CLIENT_DECLARED_CHECK_IDS = [
  'tasks-client-extension-declared',
  'sep-2663-client-handles-polymorphic-result',
  'sep-2663-client-emits-mcp-name-on-tasks-methods',
  'sep-2663-client-honors-poll-interval',
  'tasks-client-terminal-failed-surfaced',
  'sep-2663-cancel-not-via-cancelled-notification',
  'sep-2663-client-rejects-task-result-on-unsupported'
] as const;

const CHECK_META: Record<
  (typeof TASKS_CLIENT_DECLARED_CHECK_IDS)[number],
  { name: string; description: string; specReferences: SpecReference[] }
> = {
  'tasks-client-extension-declared': {
    name: 'TasksClientExtensionDeclared',
    description:
      'Flow gate: client declares io.modelcontextprotocol/tasks (initialize capabilities.extensions or per-request _meta clientCapabilities) so the tasks surface is negotiated',
    specReferences: [SEP_2663_REF]
  },
  'sep-2663-client-handles-polymorphic-result': {
    name: 'TasksClientHandlesPolymorphicResult',
    description:
      'A client that has negotiated this extension MUST be prepared to handle either CallToolResult or CreateTaskResult in response to any supported request it issues (drives tasks/get on CreateTaskResult; continues normally on CallToolResult)',
    specReferences: [SEP_2663_REF]
  },
  'sep-2663-client-emits-mcp-name-on-tasks-methods': {
    name: 'TasksClientEmitsMcpNameOnTasksMethods',
    description:
      'When tasks/get, tasks/update, or tasks/cancel is sent over the Streamable HTTP transport, the client MUST set the Mcp-Name header (defined by SEP-2243) to the value of params.taskId',
    specReferences: [SEP_2663_REF, SEP_2243_REF]
  },
  'sep-2663-client-honors-poll-interval': {
    name: 'TasksClientHonorsPollInterval',
    description:
      'Clients SHOULD respect the pollIntervalMs provided in responses when determining polling frequency (gated on the early side only)',
    specReferences: [SEP_2663_REF]
  },
  'tasks-client-terminal-failed-surfaced': {
    name: 'TasksClientTerminalFailedSurfaced',
    description:
      'Flow gate: a task that reaches status "failed" (inlined JSON-RPC error) is surfaced — the client continues the script instead of polling the terminal task indefinitely',
    specReferences: [SEP_2663_REF]
  },
  'sep-2663-cancel-not-via-cancelled-notification': {
    name: 'TasksClientCancelsViaTasksCancel',
    description:
      'The notifications/cancelled notification MUST NOT be used for task cancellation — the client cancels the running task via tasks/cancel',
    specReferences: [SEP_2663_REF]
  },
  'sep-2663-client-rejects-task-result-on-unsupported': {
    name: 'TasksClientRejectsTaskResultOnUnsupported',
    description:
      'A client that receives CreateTaskResult in response to an unsupported request type (ping) MUST interpret this as an invalid response to the request (and MUST NOT treat it as a real task)',
    specReferences: [SEP_2663_REF]
  }
};

const TOOLS = [
  {
    name: 'sync_echo',
    description:
      'Sync-only tool: always returns a plain CallToolResult immediately.',
    inputSchema: { type: 'object' as const, properties: {} }
  },
  {
    name: 'quick_task',
    description:
      'Task-augmented tool: tools/call returns CreateTaskResult; the task completes on the second tasks/get.',
    inputSchema: { type: 'object' as const, properties: {} }
  },
  {
    name: 'failing_task',
    description:
      'Task-augmented tool: the task settles to status "failed" with an inlined JSON-RPC error on the first tasks/get.',
    inputSchema: { type: 'object' as const, properties: {} }
  },
  {
    name: 'cancel_task',
    description:
      'Task-augmented tool: the task stays "working" forever; the client must cancel it via tasks/cancel.',
    inputSchema: { type: 'object' as const, properties: {} }
  }
];

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

/** Accept the raw value or the SEP-2243 `=?base64?...?=` encoded form. */
function mcpNameMatches(headerValue: string, expected: string): boolean {
  if (headerValue === expected) return true;
  const encoded = /^=\?base64\?(.+)\?=$/.exec(headerValue);
  if (encoded) {
    try {
      return Buffer.from(encoded[1], 'base64').toString('utf-8') === expected;
    } catch {
      return false;
    }
  }
  return false;
}

export class TasksClientScenario extends BaseHttpScenario {
  name = 'tasks-client-lifecycle';
  override readonly source: ScenarioSource = {
    extensionId: 'io.modelcontextprotocol/tasks'
  };
  // A conformant client may surface the invalid CreateTaskResult returned to
  // `ping` (final script step) as an error and exit non-zero.
  override allowClientError = true;
  description = `Test SEP-2663 tasks-extension behavior of the client under test.

The harness serves a task-capable MCP server. The client is expected to run
this script (each step maps to one or more checks):

1. Declare the \`io.modelcontextprotocol/tasks\` extension — either in
   \`initialize\` \`capabilities.extensions\`, or per-request in
   \`_meta["io.modelcontextprotocol/clientCapabilities"].extensions\`.
   A client that never declares it has not opted into the extension and
   all checks report SKIPPED.
2. \`tools/list\`.
3. \`tools/call\` \`quick_task\` → the server task-augments the call and
   returns \`CreateTaskResult\` (\`resultType:"task"\`, \`status:"working"\`,
   \`pollIntervalMs:${TASKS_CLIENT_POLL_INTERVAL_MS}\`). Poll \`tasks/get\` until \`status:"completed"\`
   (first poll returns \`working\`, the second \`completed\` with the tool
   result inlined under \`result\`).
4. \`tools/call\` \`sync_echo\` → plain \`CallToolResult\`; continue normally.
5. \`tools/call\` \`failing_task\` → \`CreateTaskResult\`; the first
   \`tasks/get\` returns \`status:"failed"\` with an inlined JSON-RPC
   \`error\`. Surface it and continue — do not keep polling the terminal
   task.
6. \`tools/call\` \`cancel_task\` → \`CreateTaskResult\` for a task that
   never completes. Cancel it with \`tasks/cancel\` (never with
   \`notifications/cancelled\`); a follow-up \`tasks/get\` observes
   \`status:"cancelled"\`.
7. \`ping\` → the server (deliberately non-conformant) replies with a
   \`CreateTaskResult\`. Task augmentation is not supported for ping, so
   the client MUST treat the response as invalid and MUST NOT issue
   \`tasks/get\`/\`tasks/update\`/\`tasks/cancel\` for that taskId.

Every \`tasks/get\`, \`tasks/update\`, and \`tasks/cancel\` POST MUST carry
the \`Mcp-Name\` header set to \`params.taskId\` (SEP-2243 routing headers),
and consecutive polls of the same task SHOULD be at least \`pollIntervalMs\`
apart (only early polls are flagged).`;

  // ── Per-run observation state (reset in start()) ────────────────────────
  private requestCounter = 0;
  private sawAnyRequest = false;
  private extensionDeclared = false;

  private quickTaskCreated = false;
  private quickTaskGets = 0;
  private quickCompletedDelivered = false;

  private syncEchoCalledAt: number | null = null;

  private failTaskCreated = false;
  private failedDeliveredAt: number | null = null;
  private postFailedTerminalGets = 0;

  private cancelTaskCreated = false;
  private cancelTaskCancelled = false;
  private tasksCancelObserved = false;
  private cancelledNotifications: string[] = [];

  private pingObserved = false;
  private bogusTaskRequests: string[] = [];

  private tasksMethodRequests = 0;
  private mcpNameViolations: string[] = [];

  /** For the early-side poll-cadence gate: last non-terminal tasks/get
   * response time per taskId. */
  private lastPollRespondedAt = new Map<string, number>();
  private measuredPollGapsMs: number[] = [];
  private earlyPolls: string[] = [];

  override async start(ctx: ScenarioContext) {
    this.requestCounter = 0;
    this.sawAnyRequest = false;
    this.extensionDeclared = false;
    this.quickTaskCreated = false;
    this.quickTaskGets = 0;
    this.quickCompletedDelivered = false;
    this.syncEchoCalledAt = null;
    this.failTaskCreated = false;
    this.failedDeliveredAt = null;
    this.postFailedTerminalGets = 0;
    this.cancelTaskCreated = false;
    this.cancelTaskCancelled = false;
    this.tasksCancelObserved = false;
    this.cancelledNotifications = [];
    this.pingObserved = false;
    this.bogusTaskRequests = [];
    this.tasksMethodRequests = 0;
    this.mcpNameViolations = [];
    this.lastPollRespondedAt.clear();
    this.measuredPollGapsMs = [];
    this.earlyPolls = [];
    return super.start(ctx);
  }

  protected override discoverCapabilities(): object {
    return { tools: {}, extensions: { [TASKS_EXTENSION_ID]: {} } };
  }

  /** Whether this request (or the session's initialize) declared the tasks
   * extension capability. */
  private requestDeclaresExtension(request: JsonRpcRequest): boolean {
    const meta = request.params?._meta as Record<string, unknown> | undefined;
    const caps = meta?.['io.modelcontextprotocol/clientCapabilities'] as
      | { extensions?: Record<string, unknown> }
      | undefined;
    return Boolean(caps?.extensions?.[TASKS_EXTENSION_ID]);
  }

  private taskEnvelope(
    taskId: string,
    status: string,
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> {
    const now = new Date().toISOString();
    const envelope: Record<string, unknown> = {
      taskId,
      status,
      createdAt: now,
      lastUpdatedAt: now,
      ttlMs: TASK_TTL_MS,
      ...extra
    };
    if (!['completed', 'failed', 'cancelled'].includes(status)) {
      envelope.pollIntervalMs = TASKS_CLIENT_POLL_INTERVAL_MS;
    }
    return envelope;
  }

  private sendResult(
    res: http.ServerResponse,
    request: JsonRpcRequest,
    result: Record<string, unknown>
  ): void {
    this.sendJson(res, { jsonrpc: '2.0', id: request.id, result });
  }

  private sendError(
    res: http.ServerResponse,
    request: JsonRpcRequest,
    code: number,
    message: string
  ): void {
    this.sendJson(res, {
      jsonrpc: '2.0',
      id: request.id,
      error: { code, message }
    });
  }

  protected override handlePost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    request: JsonRpcRequest
  ): void {
    this.sawAnyRequest = true;
    this.requestCounter++;
    if (this.requestDeclaresExtension(request)) {
      this.extensionDeclared = true;
    }

    const method = request.method;
    const params = request.params ?? {};

    // ── Routing-header + cadence observation for tasks/* methods ──────────
    if (['tasks/get', 'tasks/update', 'tasks/cancel'].includes(method)) {
      this.tasksMethodRequests++;
      const taskId = params.taskId as string | undefined;
      const header = req.headers['mcp-name'];
      const headerValue = Array.isArray(header) ? header[0] : header;
      if (typeof taskId === 'string') {
        if (headerValue === undefined) {
          this.mcpNameViolations.push(
            `${method} for ${taskId}: Mcp-Name header missing`
          );
        } else if (!mcpNameMatches(headerValue, taskId)) {
          this.mcpNameViolations.push(
            `${method} for ${taskId}: Mcp-Name header is ${JSON.stringify(headerValue)}, expected params.taskId`
          );
        }
        if (taskId === TASK_BOGUS) {
          this.bogusTaskRequests.push(method);
        }
        if (method === 'tasks/get') {
          const last = this.lastPollRespondedAt.get(taskId);
          if (last !== undefined) {
            const gap = Date.now() - last;
            this.measuredPollGapsMs.push(gap);
            if (
              gap <
              TASKS_CLIENT_POLL_INTERVAL_MS - TASKS_CLIENT_POLL_TOLERANCE_MS
            ) {
              this.earlyPolls.push(
                `tasks/get for ${taskId} arrived ${gap}ms after the previous poll (pollIntervalMs: ${TASKS_CLIENT_POLL_INTERVAL_MS})`
              );
            }
          }
        }
      } else {
        this.mcpNameViolations.push(`${method}: params.taskId missing`);
      }
    }

    switch (method) {
      case 'initialize': {
        const caps = params.capabilities as
          | { extensions?: Record<string, unknown> }
          | undefined;
        if (caps?.extensions?.[TASKS_EXTENSION_ID]) {
          this.extensionDeclared = true;
        }
        const requested = params.protocolVersion;
        this.sendResult(res, request, {
          protocolVersion:
            typeof requested === 'string' ? requested : '2025-11-25',
          serverInfo: { name: this.name + '-server', version: '1.0.0' },
          capabilities: this.discoverCapabilities()
        });
        return;
      }

      case 'notifications/cancelled': {
        this.cancelledNotifications.push(JSON.stringify(params));
        this.sendNotificationAck(res);
        return;
      }

      case 'ping': {
        this.pingObserved = true;
        if (this.extensionDeclared) {
          // Deliberately invalid: ping does not support task augmentation.
          // The client MUST treat this CreateTaskResult as an invalid
          // response and MUST NOT drive the tasks surface for TASK_BOGUS.
          this.sendResult(res, request, {
            resultType: 'task',
            ...this.taskEnvelope(TASK_BOGUS, 'working')
          });
        } else {
          this.sendResult(res, request, { resultType: 'complete' });
        }
        return;
      }

      case 'tools/list': {
        this.sendResult(
          res,
          request,
          withRequiredDraftResultFields('tools/list', {
            tools: TOOLS
          }) as Record<string, unknown>
        );
        return;
      }

      case 'tools/call': {
        this.handleToolsCall(res, request);
        return;
      }

      case 'tasks/get': {
        this.handleTasksGet(res, request);
        return;
      }

      case 'tasks/cancel': {
        const taskId = params.taskId as string | undefined;
        if (
          taskId === undefined ||
          ![TASK_QUICK, TASK_FAIL, TASK_CANCEL].includes(taskId)
        ) {
          this.sendError(res, request, -32602, `Unknown task: ${taskId}`);
          return;
        }
        if (taskId === TASK_CANCEL) {
          this.tasksCancelObserved = true;
          this.cancelTaskCancelled = true;
        }
        // Empty ack (idempotent for terminal tasks).
        this.sendResult(res, request, { resultType: 'complete' });
        return;
      }

      case 'tasks/update': {
        // No MRTR flow in this scenario; acknowledge with an empty result.
        this.sendResult(res, request, { resultType: 'complete' });
        return;
      }

      default: {
        if (method.startsWith('notifications/')) {
          this.sendNotificationAck(res);
          return;
        }
        this.sendError(res, request, -32601, `Method not found: ${method}`);
        return;
      }
    }
  }

  private handleToolsCall(
    res: http.ServerResponse,
    request: JsonRpcRequest
  ): void {
    const toolName = request.params?.name as string | undefined;

    // A spec-compliant server MUST NOT return CreateTaskResult to a client
    // that did not include the extension capability — non-declaring clients
    // fall through to synchronous execution for every tool.
    const augment =
      this.extensionDeclared || this.requestDeclaresExtension(request);

    switch (toolName) {
      case 'sync_echo': {
        this.syncEchoCalledAt = this.requestCounter;
        this.sendResult(res, request, {
          resultType: 'complete',
          content: [{ type: 'text', text: 'sync-ok' }]
        });
        return;
      }
      case 'quick_task': {
        if (!augment) {
          this.sendResult(res, request, {
            resultType: 'complete',
            content: [{ type: 'text', text: 'quick-sync-fallback' }]
          });
          return;
        }
        this.quickTaskCreated = true;
        this.sendResult(res, request, {
          resultType: 'task',
          ...this.taskEnvelope(TASK_QUICK, 'working')
        });
        return;
      }
      case 'failing_task': {
        if (!augment) {
          this.sendResult(res, request, {
            resultType: 'complete',
            isError: true,
            content: [{ type: 'text', text: 'fail-sync-fallback' }]
          });
          return;
        }
        this.failTaskCreated = true;
        this.sendResult(res, request, {
          resultType: 'task',
          ...this.taskEnvelope(TASK_FAIL, 'working')
        });
        return;
      }
      case 'cancel_task': {
        if (!augment) {
          this.sendResult(res, request, {
            resultType: 'complete',
            content: [{ type: 'text', text: 'cancel-sync-fallback' }]
          });
          return;
        }
        this.cancelTaskCreated = true;
        this.sendResult(res, request, {
          resultType: 'task',
          ...this.taskEnvelope(TASK_CANCEL, 'working')
        });
        return;
      }
      default: {
        this.sendError(res, request, -32602, `Unknown tool: ${toolName}`);
        return;
      }
    }
  }

  private handleTasksGet(
    res: http.ServerResponse,
    request: JsonRpcRequest
  ): void {
    const taskId = request.params?.taskId as string | undefined;
    switch (taskId) {
      case TASK_QUICK: {
        this.quickTaskGets++;
        if (this.quickTaskGets >= 2) {
          this.quickCompletedDelivered = true;
          this.lastPollRespondedAt.delete(TASK_QUICK);
          this.sendResult(res, request, {
            resultType: 'complete',
            ...this.taskEnvelope(TASK_QUICK, 'completed', {
              result: {
                content: [{ type: 'text', text: 'quick-task-result' }]
              }
            })
          });
        } else {
          this.sendResult(res, request, {
            resultType: 'complete',
            ...this.taskEnvelope(TASK_QUICK, 'working')
          });
          this.lastPollRespondedAt.set(TASK_QUICK, Date.now());
        }
        return;
      }
      case TASK_FAIL: {
        if (this.failedDeliveredAt !== null) {
          this.postFailedTerminalGets++;
        } else {
          this.failedDeliveredAt = this.requestCounter;
        }
        this.lastPollRespondedAt.delete(TASK_FAIL);
        this.sendResult(res, request, {
          resultType: 'complete',
          ...this.taskEnvelope(TASK_FAIL, 'failed', {
            statusMessage: 'deliberate failure for conformance testing',
            error: {
              code: -32603,
              message: 'Internal error: failing_task always fails'
            }
          })
        });
        return;
      }
      case TASK_CANCEL: {
        if (this.cancelTaskCancelled) {
          this.lastPollRespondedAt.delete(TASK_CANCEL);
          this.sendResult(res, request, {
            resultType: 'complete',
            ...this.taskEnvelope(TASK_CANCEL, 'cancelled')
          });
        } else {
          this.sendResult(res, request, {
            resultType: 'complete',
            ...this.taskEnvelope(TASK_CANCEL, 'working')
          });
          this.lastPollRespondedAt.set(TASK_CANCEL, Date.now());
        }
        return;
      }
      default: {
        this.sendError(res, request, -32602, `Unknown task: ${taskId}`);
        return;
      }
    }
  }

  // ── Check synthesis ──────────────────────────────────────────────────────

  private check(
    id: (typeof TASKS_CLIENT_DECLARED_CHECK_IDS)[number],
    errs: string[],
    details?: Record<string, unknown>
  ): ConformanceCheck {
    const meta = CHECK_META[id];
    return {
      id,
      name: meta.name,
      description: meta.description,
      status: errs.length === 0 ? 'SUCCESS' : 'FAILURE',
      timestamp: new Date().toISOString(),
      errorMessage: errs.length > 0 ? errs.join('; ') : undefined,
      specReferences: meta.specReferences,
      details
    };
  }

  getChecks(): ConformanceCheck[] {
    // Build fresh each call — the runner may call getChecks() repeatedly.
    if (!this.sawAnyRequest) {
      return TASKS_CLIENT_DECLARED_CHECK_IDS.map((id) => {
        const meta = CHECK_META[id];
        return untestableCheck(
          id,
          meta.name,
          meta.description,
          'client never sent a request to the scenario server',
          meta.specReferences,
          id === 'sep-2663-client-honors-poll-interval' ? 'WARNING' : 'FAILURE'
        );
      });
    }

    if (!this.extensionDeclared) {
      // Optional extension the client never opted into: legitimately not
      // applicable (the server never task-augmented anything), so SKIPPED
      // rather than untestable-FAILURE.
      return TASKS_CLIENT_DECLARED_CHECK_IDS.map((id) => {
        const meta = CHECK_META[id];
        return {
          id,
          name: meta.name,
          description: meta.description,
          status: 'SKIPPED' as const,
          timestamp: new Date().toISOString(),
          errorMessage:
            'Skipped: client never declared the io.modelcontextprotocol/tasks extension capability (neither initialize capabilities.extensions nor per-request _meta clientCapabilities); tasks-extension client requirements are not applicable',
          specReferences: meta.specReferences
        };
      });
    }

    const checks: ConformanceCheck[] = [];

    // 1. Flow gate: extension declared (true on this code path).
    checks.push(this.check('tasks-client-extension-declared', []));

    // 2. Polymorphic result handling (MUST → FAILURE).
    {
      const errs: string[] = [];
      if (!this.quickTaskCreated) {
        errs.push(
          'client never issued tools/call for quick_task with the tasks capability declared'
        );
      } else if (this.quickTaskGets === 0) {
        errs.push(
          'client received CreateTaskResult for quick_task but never issued tasks/get for its taskId — the task-augmented response was not handled'
        );
      } else if (!this.quickCompletedDelivered) {
        errs.push(
          'client stopped polling quick_task before tasks/get returned status "completed"'
        );
      }
      if (this.syncEchoCalledAt === null) {
        errs.push('client never issued tools/call for sync_echo');
      } else if (this.requestCounter <= this.syncEchoCalledAt) {
        errs.push(
          'client stopped after receiving the plain CallToolResult for sync_echo — both result shapes must be handled on a negotiated session'
        );
      }
      checks.push(
        this.check('sep-2663-client-handles-polymorphic-result', errs, {
          quickTaskGets: this.quickTaskGets,
          quickCompletedDelivered: this.quickCompletedDelivered,
          syncEchoCalled: this.syncEchoCalledAt !== null
        })
      );
    }

    // 3. Mcp-Name routing header on tasks/* (MUST → FAILURE).
    if (this.tasksMethodRequests === 0) {
      const meta =
        CHECK_META['sep-2663-client-emits-mcp-name-on-tasks-methods'];
      checks.push(
        untestableCheck(
          'sep-2663-client-emits-mcp-name-on-tasks-methods',
          meta.name,
          meta.description,
          'client never sent a tasks/get, tasks/update, or tasks/cancel request',
          meta.specReferences
        )
      );
    } else {
      checks.push(
        this.check(
          'sep-2663-client-emits-mcp-name-on-tasks-methods',
          this.mcpNameViolations,
          { tasksMethodRequests: this.tasksMethodRequests }
        )
      );
    }

    // 4. pollIntervalMs cadence (SHOULD → WARNING), early side only.
    if (this.measuredPollGapsMs.length === 0) {
      const meta = CHECK_META['sep-2663-client-honors-poll-interval'];
      checks.push(
        untestableCheck(
          'sep-2663-client-honors-poll-interval',
          meta.name,
          meta.description,
          'no consecutive tasks/get polls of the same task were observed, so polling cadence could not be measured',
          meta.specReferences,
          'WARNING'
        )
      );
    } else {
      const meta = CHECK_META['sep-2663-client-honors-poll-interval'];
      checks.push({
        id: 'sep-2663-client-honors-poll-interval',
        name: meta.name,
        description: meta.description,
        status: this.earlyPolls.length === 0 ? 'SUCCESS' : 'WARNING',
        timestamp: new Date().toISOString(),
        errorMessage:
          this.earlyPolls.length > 0 ? this.earlyPolls.join('; ') : undefined,
        specReferences: meta.specReferences,
        details: {
          pollIntervalMs: TASKS_CLIENT_POLL_INTERVAL_MS,
          toleranceMs: TASKS_CLIENT_POLL_TOLERANCE_MS,
          measuredGapsMs: this.measuredPollGapsMs
        }
      });
    }

    // 5. Terminal (failed) task surfaced, flow continues (flow gate).
    {
      const errs: string[] = [];
      if (!this.failTaskCreated) {
        errs.push('client never issued tools/call for failing_task');
      } else if (this.failedDeliveredAt === null) {
        errs.push(
          'client never polled failing_task to its terminal "failed" status'
        );
      } else {
        if (this.postFailedTerminalGets >= 3) {
          errs.push(
            `client kept polling the failed task (${this.postFailedTerminalGets} tasks/get requests after the terminal status was delivered) — terminal tasks must be surfaced, not polled indefinitely`
          );
        }
        if (this.requestCounter <= this.failedDeliveredAt) {
          errs.push(
            'client did not continue the script after the task failed — the failure was not surfaced'
          );
        }
      }
      checks.push(
        this.check('tasks-client-terminal-failed-surfaced', errs, {
          postFailedTerminalGets: this.postFailedTerminalGets
        })
      );
    }

    // 6. Cancellation channel (MUST NOT → FAILURE).
    {
      const errs: string[] = [];
      if (this.cancelledNotifications.length > 0) {
        errs.push(
          `client sent notifications/cancelled (${this.cancelledNotifications.join(', ')}) — the notifications/cancelled notification MUST NOT be used for task cancellation; use tasks/cancel`
        );
      }
      if (!this.cancelTaskCreated) {
        errs.push('client never issued tools/call for cancel_task');
      } else if (!this.tasksCancelObserved) {
        errs.push(
          'client never issued tasks/cancel for the running cancel_task task'
        );
      }
      checks.push(
        this.check('sep-2663-cancel-not-via-cancelled-notification', errs, {
          tasksCancelObserved: this.tasksCancelObserved,
          cancelledNotifications: this.cancelledNotifications.length
        })
      );
    }

    // 7. Invalid CreateTaskResult on an unsupported request type
    //    (MUST → FAILURE).
    if (!this.pingObserved) {
      const meta =
        CHECK_META['sep-2663-client-rejects-task-result-on-unsupported'];
      checks.push(
        untestableCheck(
          'sep-2663-client-rejects-task-result-on-unsupported',
          meta.name,
          meta.description,
          'client never sent the ping request that the scenario answers with an invalid CreateTaskResult',
          meta.specReferences
        )
      );
    } else {
      checks.push(
        this.check(
          'sep-2663-client-rejects-task-result-on-unsupported',
          this.bogusTaskRequests.length > 0
            ? [
                `client issued ${this.bogusTaskRequests.join(', ')} for the taskId returned to ping — a CreateTaskResult on an unsupported request type MUST be interpreted as an invalid response, not driven as a real task`
              ]
            : []
        )
      );
    }

    return checks;
  }
}
