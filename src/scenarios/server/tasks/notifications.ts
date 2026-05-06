/**
 * SEP-2663 Tasks Extension — status notifications conformance.
 *
 * Status notifications are OPTIONAL. The check pattern is:
 *   - INFO when no notifications are received (well-formed silence).
 *   - SUCCESS when notifications arrive and carry the SEP-2663 shape
 *     (DetailedTask: taskId + status, with inlined result on terminal).
 *   - FAILURE only if a notification was emitted but is malformed.
 *
 * The raw HTTP harness can't open a long-lived GET SSE stream from the
 * scenario layer easily, so this check observes notifications via the
 * POST tools/call SSE response stream. That captures the status
 * transitions emitted while the task is running. This is a best-effort
 * smoke test — passing servers may still emit additional notifications
 * on the persistent GET stream that this harness doesn't see.
 *
 * Required server fixtures:
 *   - slow_compute  — task-supporting, sleeps N seconds
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
  SEP_2663_REF,
  errMsg,
  failureCheck,
  waitForTerminal
} from './helpers';

export class TasksStatusNotificationsScenario implements ClientScenario {
  name = 'tasks-status-notifications';
  specVersions: ScenarioSpecTag[] = ['extension', DRAFT_PROTOCOL_VERSION];
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

    const id = 'tasks-status-notifications-shape';
    const name = 'TasksStatusNotificationsShape';
    const description =
      'When status notifications are emitted, each MUST carry taskId + status (SEP-2663 DetailedTask)';

    // Issue tools/call with SSE-accepting headers and capture every
    // `data:` payload. Some are JSON-RPC responses (with id), some are
    // notifications (no id). We ingest all and classify by the body.
    //
    // The SDK's Client.request() consumes the response stream internally,
    // so to *observe* notification frames on the POST SSE we drop to raw
    // fetch here while reusing the SDK-initialized session via
    // `transport.sessionId`.
    let taskId: string | undefined;
    const notifications: any[] = [];
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
              } else if (parsed.method === 'notifications/tasks/status') {
                notifications.push(parsed.params);
              }
            }
          }
        }
      } else {
        const body = await resp.json();
        taskId = body.result?.taskId;
      }
    } catch (error) {
      checks.push(failureCheck(id, name, description, error, [SEP_2663_REF]));
      return checks;
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

    if (notifications.length === 0) {
      checks.push({
        id,
        name,
        description,
        status: 'INFO',
        timestamp: new Date().toISOString(),
        errorMessage:
          'No status notifications received on the tools/call POST SSE stream (notifications are optional)',
        specReferences: [SEP_2663_REF]
      });
      await client.close().catch(() => {});
      return checks;
    }

    const errs: string[] = [];
    for (const evt of notifications) {
      if (!evt.taskId) {
        errs.push('status notification MUST carry taskId');
      }
      if (!evt.status) {
        errs.push('status notification MUST carry status');
      }
    }
    // Optional terminal-with-inlined-result check: if the suite saw a
    // completed notification for our taskId, it SHOULD include result.
    const terminalForOurs = notifications.find(
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
      details: { notificationCount: notifications.length }
    });

    await client.close().catch(() => {});
    return checks;
  }
}
