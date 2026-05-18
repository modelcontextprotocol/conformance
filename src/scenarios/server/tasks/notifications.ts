/**
 * SEP-2663 Tasks Extension — status notifications conformance.
 *
 * Status notifications are OPTIONAL but the wire method name is fixed
 * post-merge. Three normative requirements observed here:
 *   1. When a server emits status notifications, the method MUST be
 *      `notifications/tasks` (renamed from `notifications/tasks/status`
 *      before SEP-2663 merged Final).
 *   2. The legacy method name `notifications/tasks/status` MUST NOT
 *      appear on the v2 tasks surface.
 *   3. `notifications/progress` and `notifications/message` MUST NOT be
 *      sent on the task stream. The check is FAILURE-on-presence —
 *      servers that fail to filter progress emissions inside their task
 *      runtime regress here.
 *
 * The raw HTTP harness can't open a long-lived GET SSE stream from the
 * scenario layer easily, so this check observes notifications via the
 * POST tools/call SSE response stream. That captures the status
 * transitions emitted while the task is running. This is a best-effort
 * smoke test — passing servers may still emit additional notifications
 * on the persistent GET stream that this harness doesn't see.
 *
 * Required server fixtures:
 *   - slow_compute  — task-supporting, sleeps N seconds. The fixture's
 *                     internal handler SHOULD attempt to emit a progress
 *                     notification while running, so the no-leak check
 *                     exercises the server's task-stream filter rather
 *                     than a quiet handler.
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
  errMsg,
  failureCheck,
  waitForTerminal
} from './helpers';

export class TasksStatusNotificationsScenario implements ClientScenario {
  name = 'tasks-status-notifications';
  source: ScenarioSource = { extensionId: 'io.modelcontextprotocol/tasks' };
  description = `Test SEP-2663 status notifications (optional).

**Server Implementation Requirements:**

Servers MAY emit \`notifications/tasks/status\` to inform clients of
task state changes without polling. Notifications are optional — a
server is conformant whether it sends them or not. When sent, the
notification params MUST carry:

- \`taskId\`: the task the notification refers to.
- \`status\`: the new task status.
- For terminal statuses (\`completed\`/\`failed\`/\`cancelled\`),
  notifications MAY inline the corresponding \`result\` or \`error\`
  per the SEP-2663 DetailedTask shape.`;

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
        specReferences: [SEP_2663_REF]
      });
      return checks;
    }

    // Issue tools/call with SSE-accepting headers and capture every
    // `data:` payload. Some are JSON-RPC responses (with id), some are
    // notifications (no id). We ingest all and classify by the body.
    //
    // The SDK's Client.request() consumes the response stream internally,
    // so to *observe* notification frames on the POST SSE we drop to raw
    // fetch here while reusing the SDK-initialized session via
    // `transport.sessionId`.
    let taskId: string | undefined;
    const taskNotifications: any[] = [];
    const deprecatedTaskStatusNotifications: any[] = [];
    const progressNotifications: any[] = [];
    const messageNotifications: any[] = [];
    let captureError: unknown;
    try {
      const resp = await fetch(serverUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream, application/json',
          'Mcp-Session-Id': transport.sessionId!
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'notif-test',
          method: 'tools/call',
          params: {
            name: 'slow_compute',
            arguments: { seconds: 1, label: 'notif' }
          }
        })
      });
      const ct = resp.headers.get('content-type') || '';
      if (ct.includes('text/event-stream')) {
        const text = await resp.text();
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data:')) {
            const payload = trimmed.slice(5).trimStart();
            if (payload.startsWith('{')) {
              const parsed = JSON.parse(payload);
              if (parsed.id === 'notif-test' && parsed.result) {
                taskId = parsed.result.taskId;
              } else if (parsed.method === 'notifications/tasks') {
                taskNotifications.push(parsed.params);
              } else if (parsed.method === 'notifications/tasks/status') {
                deprecatedTaskStatusNotifications.push(parsed.params);
              } else if (parsed.method === 'notifications/progress') {
                progressNotifications.push(parsed.params);
              } else if (parsed.method === 'notifications/message') {
                messageNotifications.push(parsed.params);
              }
            }
          }
        }
      } else {
        const body = await resp.json();
        taskId = body.result?.taskId;
      }
    } catch (error) {
      captureError = error;
    }

    // Drain to a terminal so the server has emitted everything it's
    // going to (best-effort — the persistent GET stream might be
    // collecting more, but we're done with this scenario regardless).
    if (taskId) {
      try {
        await waitForTerminal(client, taskId);
      } catch {
        /* swallow */
      }
    }

    // Check 1: the wire method name is now `notifications/tasks`.
    // The legacy `notifications/tasks/status` MUST NOT appear on the v2
    // surface — SEP-2663 renamed it before the spec merged Final.
    {
      const id = 'tasks-status-notifications-method-name';
      const name = 'TasksStatusNotificationsMethodName';
      const description =
        'Servers MUST NOT emit notifications/tasks/status on the v2 tasks surface; the merged SEP-2663 wire method is notifications/tasks';
      if (captureError) {
        checks.push(
          failureCheck(id, name, description, captureError, [SEP_2663_REF])
        );
      } else if (deprecatedTaskStatusNotifications.length > 0) {
        checks.push({
          id,
          name,
          description,
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: `Server emitted ${deprecatedTaskStatusNotifications.length} notifications/tasks/status on the v2 surface; the post-merge wire method is notifications/tasks.`,
          specReferences: [SEP_2663_REF],
          details: {
            deprecatedNotificationCount:
              deprecatedTaskStatusNotifications.length
          }
        });
      } else {
        checks.push({
          id,
          name,
          description,
          status: 'SUCCESS',
          timestamp: new Date().toISOString(),
          specReferences: [SEP_2663_REF]
        });
      }
    }

    // Check 2: notifications/progress MUST NOT be sent for tasks.
    {
      const id = 'tasks-no-progress-on-task-stream';
      const name = 'TasksNoProgressOnTaskStream';
      const description =
        'Servers MUST NOT emit notifications/progress for tasks (SEP-2663)';
      if (captureError) {
        checks.push(
          failureCheck(id, name, description, captureError, [SEP_2663_REF])
        );
      } else {
        checks.push({
          id,
          name,
          description,
          status: progressNotifications.length === 0 ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage:
            progressNotifications.length > 0
              ? `Server emitted ${progressNotifications.length} notifications/progress on the task stream; SEP-2663 forbids these on tasks.`
              : undefined,
          specReferences: [SEP_2663_REF],
          details: { progressNotificationCount: progressNotifications.length }
        });
      }
    }

    // Check 3: notifications/message MUST NOT be sent for tasks.
    {
      const id = 'tasks-no-message-on-task-stream';
      const name = 'TasksNoMessageOnTaskStream';
      const description =
        'Servers MUST NOT emit notifications/message for tasks (SEP-2663)';
      if (captureError) {
        checks.push(
          failureCheck(id, name, description, captureError, [SEP_2663_REF])
        );
      } else {
        checks.push({
          id,
          name,
          description,
          status: messageNotifications.length === 0 ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage:
            messageNotifications.length > 0
              ? `Server emitted ${messageNotifications.length} notifications/message on the task stream; SEP-2663 forbids these on tasks.`
              : undefined,
          specReferences: [SEP_2663_REF],
          details: { messageNotificationCount: messageNotifications.length }
        });
      }
    }

    // Check 4: when the server emits notifications/tasks, each carries
    // the DetailedTask shape — taskId + status, with inlined result on
    // terminal completion.
    {
      const id = 'tasks-status-notifications-shape';
      const name = 'TasksStatusNotificationsShape';
      const description =
        'When status notifications are emitted, each MUST carry taskId + status (SEP-2663 DetailedTask)';
      if (captureError) {
        checks.push(
          failureCheck(id, name, description, captureError, [SEP_2663_REF])
        );
      } else if (taskNotifications.length === 0) {
        checks.push({
          id,
          name,
          description,
          status: 'INFO',
          timestamp: new Date().toISOString(),
          errorMessage:
            'No notifications/tasks received on the tools/call POST SSE stream (status notifications are optional)',
          specReferences: [SEP_2663_REF]
        });
      } else {
        const errs: string[] = [];
        for (const evt of taskNotifications) {
          if (!evt.taskId) {
            errs.push('status notification MUST carry taskId');
          }
          if (!evt.status) {
            errs.push('status notification MUST carry status');
          }
        }
        const terminalForOurs = taskNotifications.find(
          (n: any) => n.taskId === taskId && n.status === 'completed'
        );
        if (terminalForOurs && !terminalForOurs.result) {
          errs.push(
            'completed status notification SHOULD inline result (DetailedTask shape)'
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
          details: { notificationCount: taskNotifications.length }
        });
      }
    }

    // Check 5: notifications/tasks payloads MUST NOT carry requestState.
    // The spec deleted the field from the Task base interface (commit
    // 3f1c3cfc), so the DetailedTask shape on every task-bearing message
    // — tools/call CreateTaskResult, tasks/get, and these notifications
    // — must omit it. The CreateTaskResult and tasks/get absence-asserts
    // live in request-state.ts; this check covers the notification path
    // by reusing the SSE-observation buffer above.
    {
      const id = 'tasks-status-notifications-no-request-state';
      const name = 'TasksStatusNotificationsNoRequestState';
      const description =
        'notifications/tasks payloads MUST NOT carry `requestState` (the merged SEP-2663 removed the field from the Task base interface)';
      if (captureError) {
        checks.push(
          failureCheck(id, name, description, captureError, [SEP_2663_REF])
        );
      } else if (taskNotifications.length === 0) {
        checks.push({
          id,
          name,
          description,
          status: 'INFO',
          timestamp: new Date().toISOString(),
          errorMessage:
            'No notifications/tasks observed; absence-assert not exercised',
          specReferences: [SEP_2663_REF]
        });
      } else {
        const offenders = taskNotifications.filter((n: any) =>
          Object.prototype.hasOwnProperty.call(n, 'requestState')
        );
        checks.push({
          id,
          name,
          description,
          status: offenders.length === 0 ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage:
            offenders.length > 0
              ? `${offenders.length}/${taskNotifications.length} notifications/tasks payloads carry requestState; the merged spec removed this field.`
              : undefined,
          specReferences: [SEP_2663_REF],
          details: {
            notificationsObserved: taskNotifications.length,
            notificationsWithRequestState: offenders.length
          }
        });
      }
    }

    await client.close().catch(() => {});
    return checks;
  }
}
