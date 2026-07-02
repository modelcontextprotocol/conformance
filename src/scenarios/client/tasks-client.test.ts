/**
 * Tests for the SEP-2663 tasks-extension CLIENT scenario (issue #374).
 *
 * Positive path: the everything-client's tasks handler runs in-process
 * against the scenario server and every check passes.
 *
 * Negative paths: deliberately-broken raw-fetch clients violate one
 * requirement at a time and the matching check flips to FAILURE/WARNING
 * (pattern from http-custom-headers.test.ts).
 */
import { describe, test, it, expect } from 'vitest';
import {
  runClientAgainstScenario,
  InlineClientRunner
} from './auth/test_helpers/testClient';
import { getHandler } from '../../../examples/clients/typescript/everything-client';
import { testScenarioContext } from '../../mock-server/testing';
import {
  TasksClientScenario,
  TASKS_CLIENT_DECLARED_CHECK_IDS,
  TASKS_CLIENT_POLL_INTERVAL_MS
} from './tasks-client';

const TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks';
const TASKS_META = {
  'io.modelcontextprotocol/clientCapabilities': {
    extensions: { [TASKS_EXTENSION_ID]: {} }
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let nextId = 1;
async function rpc(
  serverUrl: string,
  method: string,
  params: Record<string, unknown> = {},
  options: { declare?: boolean; omitMcpName?: boolean } = {}
): Promise<any> {
  const declare = options.declare ?? true;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'Mcp-Method': method
  };
  if (
    ['tasks/get', 'tasks/update', 'tasks/cancel'].includes(method) &&
    typeof params.taskId === 'string' &&
    !options.omitMcpName
  ) {
    headers['Mcp-Name'] = params.taskId;
  }
  const body: Record<string, unknown> = {
    jsonrpc: '2.0',
    id: nextId++,
    method,
    params: declare ? { ...params, _meta: TASKS_META } : params
  };
  const resp = await fetch(serverUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  if (resp.status === 202 || resp.status === 204) return {};
  const json = (await resp.json()) as { result?: any; error?: any };
  return json.result ?? json;
}

function statusOf(
  checks: { id: string; status: string }[],
  id: string
): string | undefined {
  return checks.find((c) => c.id === id)?.status;
}

/**
 * Drive the full conforming script with raw fetch, with hooks to break one
 * behavior at a time.
 */
async function runConformingScript(
  serverUrl: string,
  overrides: {
    /** Skip the pollIntervalMs sleeps (poll immediately). */
    pollImmediately?: boolean;
    /** Do not send the Mcp-Name header on tasks/* requests. */
    omitMcpName?: boolean;
    /** Cancel via notifications/cancelled instead of tasks/cancel. */
    cancelViaNotification?: boolean;
    /** Treat CreateTaskResult as a plain result: never poll quick_task. */
    ignoreCreateTaskResult?: boolean;
    /** Poll the bogus task returned to ping. */
    pollBogusPingTask?: boolean;
  } = {}
): Promise<void> {
  const wait = (ms: number) =>
    overrides.pollImmediately ? Promise.resolve() : sleep(ms);
  const taskOpts = { omitMcpName: overrides.omitMcpName ?? false };

  await rpc(serverUrl, 'tools/list');

  // quick_task
  const quick = await rpc(serverUrl, 'tools/call', { name: 'quick_task' });
  if (!overrides.ignoreCreateTaskResult && quick.resultType === 'task') {
    let interval = quick.pollIntervalMs ?? TASKS_CLIENT_POLL_INTERVAL_MS;
    for (let i = 0; i < 10; i++) {
      await wait(interval);
      const task = await rpc(
        serverUrl,
        'tasks/get',
        { taskId: quick.taskId },
        taskOpts
      );
      if (['completed', 'failed', 'cancelled'].includes(task.status)) break;
      interval = task.pollIntervalMs ?? interval;
    }
  }

  // sync_echo
  await rpc(serverUrl, 'tools/call', { name: 'sync_echo' });

  // failing_task
  const failing = await rpc(serverUrl, 'tools/call', { name: 'failing_task' });
  if (failing.resultType === 'task') {
    await wait(failing.pollIntervalMs ?? TASKS_CLIENT_POLL_INTERVAL_MS);
    await rpc(serverUrl, 'tasks/get', { taskId: failing.taskId }, taskOpts);
  }

  // cancel_task
  const cancel = await rpc(serverUrl, 'tools/call', { name: 'cancel_task' });
  if (cancel.resultType === 'task') {
    await wait(cancel.pollIntervalMs ?? TASKS_CLIENT_POLL_INTERVAL_MS);
    if (overrides.cancelViaNotification) {
      await rpc(serverUrl, 'notifications/cancelled', {
        requestId: 999,
        reason: `cancel task ${cancel.taskId}`
      });
    } else {
      await rpc(serverUrl, 'tasks/cancel', { taskId: cancel.taskId }, taskOpts);
      await rpc(serverUrl, 'tasks/get', { taskId: cancel.taskId }, taskOpts);
    }
  }

  // ping → invalid CreateTaskResult
  const pong = await rpc(serverUrl, 'ping');
  if (overrides.pollBogusPingTask && pong.resultType === 'task') {
    await rpc(serverUrl, 'tasks/get', { taskId: pong.taskId }, taskOpts);
  }
}

describe('tasks-client-lifecycle scenario (SEP-2663, issue #374)', () => {
  test('everything-client passes every check', async () => {
    const clientFn = getHandler('tasks-client-lifecycle');
    if (!clientFn) {
      throw new Error(
        'No handler registered for scenario: tasks-client-lifecycle'
      );
    }
    const runner = new InlineClientRunner(clientFn);
    // runClientAgainstScenario asserts every non-INFO check is SUCCESS.
    await runClientAgainstScenario(runner, 'tasks-client-lifecycle');
  }, 30000);

  it('emits exactly the declared check IDs as failures when no client connects', async () => {
    const scenario = new TasksClientScenario();
    await scenario.start(testScenarioContext());
    try {
      const checks = scenario.getChecks();
      expect(new Set(checks.map((c) => c.id))).toEqual(
        new Set(TASKS_CLIENT_DECLARED_CHECK_IDS)
      );
      for (const check of checks) {
        // Severity follows the requirement keyword: the SHOULD-level
        // poll-interval check reports WARNING, everything else FAILURE.
        expect(check.status).toBe(
          check.id === 'sep-2663-client-honors-poll-interval'
            ? 'WARNING'
            : 'FAILURE'
        );
        expect(check.details?.untestable).toBe(true);
      }
    } finally {
      await scenario.stop();
    }
  });

  it('SKIPs every check when the client never declares the tasks extension', async () => {
    const scenario = new TasksClientScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      // A tasks-unaware client: plain flow, no capability declaration. The
      // server (spec-compliant) falls through to sync execution.
      await rpc(serverUrl, 'tools/list', {}, { declare: false });
      const result = await rpc(
        serverUrl,
        'tools/call',
        { name: 'quick_task' },
        { declare: false }
      );
      expect(result.resultType).toBe('complete');
      const checks = scenario.getChecks();
      expect(new Set(checks.map((c) => c.id))).toEqual(
        new Set(TASKS_CLIENT_DECLARED_CHECK_IDS)
      );
      for (const check of checks) {
        expect(check.status).toBe('SKIPPED');
      }
    } finally {
      await scenario.stop();
    }
  });

  it('passes all checks for a conforming raw-fetch client', async () => {
    const scenario = new TasksClientScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      await runConformingScript(serverUrl);
      const checks = scenario.getChecks();
      for (const check of checks) {
        expect(check.status, `${check.id}: ${check.errorMessage ?? ''}`).toBe(
          'SUCCESS'
        );
      }
    } finally {
      await scenario.stop();
    }
  }, 30000);

  it('FAILs polymorphic-result handling when the client never polls the created task', async () => {
    const scenario = new TasksClientScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      await runConformingScript(serverUrl, { ignoreCreateTaskResult: true });
      const checks = scenario.getChecks();
      expect(
        statusOf(checks, 'sep-2663-client-handles-polymorphic-result')
      ).toBe('FAILURE');
    } finally {
      await scenario.stop();
    }
  }, 30000);

  it('FAILs the Mcp-Name check when tasks/* requests omit the header', async () => {
    const scenario = new TasksClientScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      await runConformingScript(serverUrl, { omitMcpName: true });
      const checks = scenario.getChecks();
      expect(
        statusOf(checks, 'sep-2663-client-emits-mcp-name-on-tasks-methods')
      ).toBe('FAILURE');
      // The rest of the flow is intact.
      expect(
        statusOf(checks, 'sep-2663-client-handles-polymorphic-result')
      ).toBe('SUCCESS');
    } finally {
      await scenario.stop();
    }
  }, 30000);

  it('WARNs on poll cadence when the client polls without waiting pollIntervalMs', async () => {
    const scenario = new TasksClientScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      await runConformingScript(serverUrl, { pollImmediately: true });
      const checks = scenario.getChecks();
      expect(statusOf(checks, 'sep-2663-client-honors-poll-interval')).toBe(
        'WARNING'
      );
    } finally {
      await scenario.stop();
    }
  }, 30000);

  it('FAILs the cancellation-channel check when the client uses notifications/cancelled', async () => {
    const scenario = new TasksClientScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      await runConformingScript(serverUrl, { cancelViaNotification: true });
      const checks = scenario.getChecks();
      expect(
        statusOf(checks, 'sep-2663-cancel-not-via-cancelled-notification')
      ).toBe('FAILURE');
    } finally {
      await scenario.stop();
    }
  }, 30000);

  it('FAILs the unsupported-request check when the client polls the task returned to ping', async () => {
    const scenario = new TasksClientScenario();
    const { serverUrl } = await scenario.start(testScenarioContext());
    try {
      await runConformingScript(serverUrl, { pollBogusPingTask: true });
      const checks = scenario.getChecks();
      expect(
        statusOf(checks, 'sep-2663-client-rejects-task-result-on-unsupported')
      ).toBe('FAILURE');
    } finally {
      await scenario.stop();
    }
  }, 30000);
});
