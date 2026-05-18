/**
 * SEP-2663 Tasks Extension — `requestState` removal conformance.
 *
 * The pre-merge SEP-2663 defined a "Request State Management" section
 * that let servers attach an opaque `requestState` token to task-bearing
 * messages (CreateTaskResult, tasks/get, notifications/tasks). The
 * merged Final SEP-2663 removes the field from the `Task` base
 * interface and deletes that entire section, so the tasks-v2 wire
 * carries no `requestState`.
 *
 * This scenario asserts the absence:
 *   - CreateTaskResult MUST NOT carry `requestState`.
 *   - DetailedTask (tasks/get response) MUST NOT carry `requestState`,
 *     regardless of status.
 *
 * The notifications/tasks payload absence-assert lives in
 * notifications.ts so the SSE-observation harness is not duplicated.
 *
 * SEP-2322's InputRequiredResult still carries `requestState` — that is
 * the MRTR multi-round-trip surface, not the tasks-v2 wire, and is
 * tested separately in mrtr-input.ts.
 *
 * Required server fixtures:
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
  SEP_2663_REF,
  AnyResult,
  errMsg,
  failureCheck
} from './helpers';

export class TasksRequestStateRemovalScenario implements ClientScenario {
  name = 'tasks-request-state-removal';
  source: ScenarioSource = { extensionId: 'io.modelcontextprotocol/tasks' };
  description = `Verify the post-merge removal of \`requestState\` from the tasks-v2 wire.

**Server Implementation Requirements:**

The merged SEP-2663 dropped the \`requestState?: string\` field from
the \`Task\` base interface and removed the entire "Request State
Management" section. The Final spec does not define \`requestState\` on
any tasks-v2 wire shape.

- \`CreateTaskResult\` MUST NOT carry \`requestState\` on the
  \`tools/call\` response that creates a task.
- The \`tasks/get\` response (DetailedTask) MUST NOT carry
  \`requestState\` for any status (\`working\` / \`input_required\` /
  \`completed\` / \`cancelled\` / \`failed\`).

SEP-2322's \`InputRequiredResult\` still carries \`requestState\` on the
MRTR (multi-round-trip) surface — that is unrelated to the tasks-v2
wire and is exercised by mrtr-input.ts.`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    let client: Client;
    try {
      client = new Client(
        { name: 'mcp-conformance', version: '1.0' },
        {
          capabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } }
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

    // Drive a long-running task so we can interrogate `tasks/get` while
    // the task is still in `working`. A terminal-only sample would miss
    // any field a server populated only during the in-flight window.
    let taskId: string | undefined;
    let createdTask: any;
    try {
      createdTask = (await client.request(
        {
          method: 'tools/call',
          params: {
            name: 'slow_compute',
            arguments: { seconds: 60, label: 'request-state-removal' }
          }
        },
        AnyResult
      )) as any;
      taskId = createdTask?.taskId;
    } catch (error) {
      checks.push(
        failureCheck(
          'tasks-request-state-removal-setup',
          'TasksRequestStateRemovalSetup',
          'Failed to create a long-running task to exercise the absence-asserts',
          error,
          [SEP_2663_REF]
        )
      );
      await client.close().catch(() => {});
      return checks;
    }
    if (!taskId) {
      checks.push({
        id: 'tasks-request-state-removal-setup',
        name: 'TasksRequestStateRemovalSetup',
        description:
          'slow_compute did not return a CreateTaskResult; cannot exercise absence-asserts',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: 'no taskId in tools/call response',
        specReferences: [SEP_2663_REF]
      });
      await client.close().catch(() => {});
      return checks;
    }

    // Check 1: CreateTaskResult MUST NOT carry requestState.
    {
      const id = 'tasks-create-result-no-request-state';
      const name = 'TasksCreateResultNoRequestState';
      const description =
        'CreateTaskResult MUST NOT carry `requestState` (the merged SEP-2663 removed the field from the Task base interface)';
      const has = Object.prototype.hasOwnProperty.call(
        createdTask,
        'requestState'
      );
      checks.push({
        id,
        name,
        description,
        status: has ? 'FAILURE' : 'SUCCESS',
        timestamp: new Date().toISOString(),
        errorMessage: has
          ? `CreateTaskResult carries requestState = ${JSON.stringify(createdTask.requestState)}; the merged spec removed this field from the tasks-v2 wire.`
          : undefined,
        specReferences: [SEP_2663_REF]
      });
    }

    // Check 2: tasks/get response (DetailedTask) MUST NOT carry requestState.
    {
      const id = 'tasks-get-detailed-no-request-state';
      const name = 'TasksGetDetailedNoRequestState';
      const description =
        'tasks/get response (DetailedTask) MUST NOT carry `requestState` for any status (per the merged SEP-2663)';
      try {
        const detailed = (await client.request(
          { method: 'tasks/get', params: { taskId } },
          AnyResult
        )) as any;
        const has = Object.prototype.hasOwnProperty.call(
          detailed,
          'requestState'
        );
        checks.push({
          id,
          name,
          description,
          status: has ? 'FAILURE' : 'SUCCESS',
          timestamp: new Date().toISOString(),
          errorMessage: has
            ? `DetailedTask carries requestState = ${JSON.stringify(detailed.requestState)} (status=${detailed.status}); the merged spec removed this field from the tasks-v2 wire.`
            : undefined,
          specReferences: [SEP_2663_REF],
          details: { observedStatus: detailed.status }
        });
      } catch (error) {
        checks.push(failureCheck(id, name, description, error, [SEP_2663_REF]));
      }
    }

    // Cleanup so the fixture doesn't leak a 60-second goroutine.
    try {
      await client.request(
        { method: 'tasks/cancel', params: { taskId } },
        AnyResult
      );
    } catch {
      /* swallow */
    }

    await client.close().catch(() => {});
    return checks;
  }
}
