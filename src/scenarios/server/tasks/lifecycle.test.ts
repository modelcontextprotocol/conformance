import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createServerStateless, type MockServer } from '../../../mock-server';
import { runServerConformanceTest } from '../../../runner/server';
import type { ConformanceCheck } from '../../../types';

type CancellationBehavior =
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'working'
  | 'taskless';

async function startServer(
  cancellation: CancellationBehavior
): Promise<MockServer> {
  const tasks = new Map<
    string,
    {
      name: string;
      createdAt: string;
      completesAt: number;
      status: 'working' | 'cancelled' | 'completed' | 'failed';
    }
  >();

  return createServerStateless({
    'tools/call': (params) => {
      if (params.name === 'greet' || cancellation === 'taskless') {
        return { content: [{ type: 'text', text: 'Hello, World!' }] };
      }
      if (typeof params.name !== 'string') {
        throw new Error('Expected a tool name');
      }
      const args = params.arguments as Record<string, unknown> | undefined;
      const taskId = typeof args?.label === 'string' ? args.label : params.name;
      const seconds = typeof args?.seconds === 'number' ? args.seconds : 1;
      const task = {
        name: params.name,
        createdAt: new Date().toISOString(),
        completesAt: Date.now() + seconds * 1000,
        status: 'working' as const
      };
      tasks.set(taskId, task);
      return {
        resultType: 'task',
        taskId,
        status: task.status,
        createdAt: task.createdAt,
        lastUpdatedAt: task.createdAt,
        ttlMs: 60_000
      };
    },
    'tasks/cancel': (params) => {
      const task = tasks.get(String(params.taskId));
      if (!task) throw new Error('Unknown task');
      if (task.status === 'working' && cancellation !== 'taskless') {
        task.status = cancellation;
      }
      return { resultType: 'complete' };
    },
    'tasks/get': (params) => {
      const task = tasks.get(String(params.taskId));
      if (!task) throw new Error('Unknown task');
      if (task.status === 'working' && Date.now() >= task.completesAt) {
        task.status =
          task.name === 'protocol_error_job' ? 'failed' : 'completed';
      }
      return {
        taskId: params.taskId,
        status: task.status,
        createdAt: task.createdAt,
        lastUpdatedAt: new Date().toISOString(),
        ttlMs: 60_000,
        ...(task.status === 'completed'
          ? {
              result: {
                content: [{ type: 'text', text: 'done' }],
                isError: task.name === 'failing_job'
              }
            }
          : {}),
        ...(task.status === 'failed'
          ? { error: { code: -32603, message: 'Internal error' } }
          : {})
      };
    }
  });
}

describe('tasks-lifecycle cancellation reports', () => {
  let server: MockServer | undefined;
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await mkdtemp(path.join(tmpdir(), 'tasks-lifecycle-'));
  });

  afterEach(async () => {
    await server?.close();
    await rm(outputDir, { recursive: true, force: true });
  });

  async function runLifecycle(
    cancellation: CancellationBehavior
  ): Promise<ConformanceCheck[]> {
    server = await startServer(cancellation);
    const result = await runServerConformanceTest(
      server.url,
      'tasks-lifecycle',
      outputDir
    );
    expect(result.resultDir).toBeDefined();
    const checks: ConformanceCheck[] = JSON.parse(
      await readFile(path.join(result.resultDir!, 'checks.json'), 'utf8')
    );
    expect(checks).toEqual(JSON.parse(JSON.stringify(result.checks)));
    expect(checks.filter((check) => check.id === 'wire-schema-valid')).toEqual([
      expect.objectContaining({ status: 'SUCCESS' })
    ]);
    return checks;
  }

  test.each(['cancelled', 'completed', 'failed'] as const)(
    'reports the fixture contract when cancellation settles to %s',
    async (status) => {
      const checks = await runLifecycle(status);
      expect(
        checks.find((check) => check.id === 'sep-2663-cancel-ack-empty-result')
      ).toMatchObject({
        status: 'SUCCESS',
        details: { statusAfterCancel: status }
      });
      expect(
        checks.filter(
          (check) => check.id === 'sep-2663-tasks-get-status-cancelled'
        )
      ).toEqual([
        expect.objectContaining({
          status: status === 'cancelled' ? 'SUCCESS' : 'FAILURE',
          ...(status === 'cancelled'
            ? {}
            : {
                errorMessage:
                  `slow_compute fixture contract requires status:"cancelled" ` +
                  `after cancellation while running; got "${status}"`
              }),
          details: { statusAfterCancel: status }
        })
      ]);
      expect(checks.filter((check) => check.status !== 'SUCCESS')).toHaveLength(
        status === 'cancelled' ? 0 : 1
      );
    },
    20_000
  );

  test('reports cancelled status as untestable when no task is created', async () => {
    const checks = await runLifecycle('taskless');

    expect(
      checks.filter(
        (check) => check.id === 'sep-2663-tasks-get-status-cancelled'
      )
    ).toEqual([
      expect.objectContaining({
        status: 'FAILURE',
        errorMessage: expect.stringMatching(
          /^Not testable:.*did not create a task/
        ),
        details: expect.objectContaining({ untestable: true })
      })
    ]);
    const gated = checks.filter((check) =>
      check.errorMessage?.startsWith('Not testable:')
    );
    for (const check of gated) {
      expect(check.status).toBe('FAILURE');
      expect(check.details).toMatchObject({ untestable: true });
    }
    expect(checks.every((check) => check.status !== 'SKIPPED')).toBe(true);
    expect(
      server?.recorded.some((request) => request.method === 'tasks/cancel')
    ).toBe(false);
  });

  test('reports cancelled status as untestable when terminal polling times out', async () => {
    const checks = await runLifecycle('working');

    expect(
      checks.find((check) => check.id === 'sep-2663-cancel-ack-empty-result')
    ).toMatchObject({
      status: 'FAILURE',
      errorMessage:
        'Task lifecycle-cancel did not reach terminal state within 10000ms'
    });
    expect(
      checks.filter(
        (check) => check.id === 'sep-2663-tasks-get-status-cancelled'
      )
    ).toEqual([
      expect.objectContaining({
        status: 'FAILURE',
        errorMessage: expect.stringMatching(
          /^Not testable:.*Task lifecycle-cancel did not reach terminal state within 10000ms/
        ),
        details: expect.objectContaining({ untestable: true })
      })
    ]);
    expect(
      server?.recorded.filter(
        (request) =>
          request.method === 'tasks/get' &&
          request.params?.taskId === 'lifecycle-cancel'
      ).length
    ).toBeGreaterThan(1);
  }, 25_000);
});
