import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { clientScenarios } from '../scenarios';
import {
  type ClientScenario,
  type ConformanceCheck,
  DRAFT_PROTOCOL_VERSION,
  LATEST_SPEC_VERSION
} from '../types';
import { printServerResults, runServerConformanceTest } from './server';
import * as wireSchema from '../validation/wire-schema';

const URL = 'http://127.0.0.1:9/mcp';
const NAME = 'runner-persistence-fixture';
const check = (status: ConformanceCheck['status']): ConformanceCheck => ({
  id: 'fixture-check',
  name: 'Fixture check',
  description: 'Test-only runner result',
  status,
  timestamp: new Date().toISOString()
});

describe('runServerConformanceTest result persistence', () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'conformance-persistence-')
    );
    expect(clientScenarios.has(NAME)).toBe(false);
  });

  afterEach(async () => {
    clientScenarios.delete(NAME);
    vi.restoreAllMocks();
    vi.useRealTimers();
    await fs.rm(outputDir, { recursive: true, force: true });
  });

  function register(run: ClientScenario['run']) {
    clientScenarios.set(NAME, {
      name: NAME,
      description: 'Runner persistence fixture',
      source: { introducedIn: '2025-06-18' },
      run
    });
  }

  async function runAndRead() {
    const result = await runServerConformanceTest(URL, NAME, outputDir);
    const saved = JSON.parse(
      await fs.readFile(path.join(result.resultDir!, 'checks.json'), 'utf8')
    );
    expect(saved).toEqual(result.checks);
    return result;
  }

  test('persists a synchronous scenario exception as a failure', async () => {
    register(() => {
      throw new Error('synchronous failure');
    });
    const result = await runAndRead();
    expect(result.checks).toEqual([
      expect.objectContaining({
        id: NAME,
        name: NAME,
        description: 'Failed to run scenario',
        status: 'FAILURE',
        errorMessage: 'synchronous failure'
      })
    ]);
    expect(
      printServerResults(result.checks, result.scenarioDescription).failed
    ).toBe(1);
    expect(Number.isFinite(Date.parse(result.checks[0].timestamp))).toBe(true);
    expect(result.checks[0].specReferences).toBeUndefined();
  });

  test('persists an asynchronously rejected scenario', async () => {
    register(async () => {
      await Promise.resolve();
      throw new Error('asynchronous failure');
    });
    const result = await runAndRead();
    expect(result.checks[0]).toMatchObject({
      status: 'FAILURE',
      errorMessage: 'asynchronous failure'
    });
  });

  test.each([true, false])(
    'retains valid=%s wire checks alongside the scenario exception',
    async (valid) => {
      register(async () => {
        wireSchema.validateWireMessage(
          LATEST_SPEC_VERSION,
          {
            jsonrpc: '2.0',
            id: 1,
            result: { tools: valid ? [] : 'invalid tools list' }
          },
          {
            origin: 'implementation',
            context: 'controlled tools response',
            requestMethod: 'tools/list'
          }
        );
        throw new Error('failure after wire observation');
      });
      const result = await wireSchema.withWireRecorder(runAndRead);
      expect(result.checks.filter((check) => check.id === NAME)).toHaveLength(
        1
      );
      expect(result.checks[0]).toMatchObject({
        status: 'FAILURE',
        errorMessage: 'failure after wire observation'
      });
      expect(
        result.checks.find((check) => check.id === 'wire-schema-valid')
      ).toMatchObject({ status: valid ? 'SUCCESS' : 'FAILURE' });
      const next = await wireSchema.withWireRecorder(async () => {
        register(async () => [check('SUCCESS')]);
        return await runServerConformanceTest(URL, NAME);
      });
      expect(next.checks.map((check) => check.id)).toEqual(['fixture-check']);
    }
  );

  test('does not convert a wire-check infrastructure error into a scenario result', async () => {
    register(async () => [check('SUCCESS')]);
    const failure = new Error('controlled wire-check failure');
    vi.spyOn(wireSchema, 'wireSchemaChecks').mockImplementationOnce(() => {
      throw failure;
    });
    const write = vi.spyOn(fs, 'writeFile');
    await expect(runServerConformanceTest(URL, NAME, outputDir)).rejects.toBe(
      failure
    );
    expect(write).not.toHaveBeenCalled();
  });

  test.each(['plain rejection', null])(
    'preserves a non-Error rejection %s',
    async (error) => {
      register(() => Promise.reject(error));
      const result = await runAndRead();
      expect(result.checks[0]).toMatchObject({
        status: 'FAILURE',
        errorMessage: String(error)
      });
    }
  );

  test('clears the scenario timer when the scenario rejects', async () => {
    vi.useFakeTimers();
    register(() => Promise.reject(new Error('timer cleanup')));
    const result = await runServerConformanceTest(URL, NAME);
    expect(result.checks[0].status).toBe('FAILURE');
    expect(vi.getTimerCount()).toBe(0);
  });

  test('reports an exception without requiring an output directory', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('without output');
    register(() => {
      throw error;
    });
    const result = await runServerConformanceTest(URL, NAME);
    expect(result.resultDir).toBeUndefined();
    expect(result.checks[0]).toMatchObject({
      status: 'FAILURE',
      errorMessage: 'without output'
    });
    expect(log).toHaveBeenCalledExactlyOnceWith(
      `Failed to run scenario ${NAME}:`,
      error
    );
  });

  test.each(['SUCCESS', 'FAILURE'] as const)(
    'preserves a normal %s result',
    async (status) => {
      const expected = [check(status)];
      const unchanged = structuredClone(expected);
      register(async () => expected);
      const result = await runAndRead();
      expect(result.checks).toEqual(unchanged);
      expect(
        printServerResults(result.checks, result.scenarioDescription).failed
      ).toBe(status === 'FAILURE' ? 1 : 0);
    }
  );

  test('persists the existing timeout failure', async () => {
    register(() => new Promise(() => {}));
    const result = await runServerConformanceTest(
      URL,
      NAME,
      outputDir,
      undefined,
      false,
      10
    );
    expect(result.checks[0]).toMatchObject({
      id: 'scenario-timeout',
      status: 'FAILURE'
    });
    expect(
      JSON.parse(
        await fs.readFile(path.join(result.resultDir!, 'checks.json'), 'utf8')
      )
    ).toEqual(result.checks);
  });

  test('keeps a genuinely inapplicable scenario skipped without checks.json', async () => {
    const run = vi.fn<ClientScenario['run']>();
    register(run);
    clientScenarios.get(NAME)!.source = {
      introducedIn: DRAFT_PROTOCOL_VERSION
    };
    const result = await runServerConformanceTest(
      URL,
      NAME,
      outputDir,
      LATEST_SPEC_VERSION
    );
    expect(result.skipped).toBe(true);
    expect(result.checks).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(await fs.readdir(result.resultDir!)).toEqual([]);
  });

  test.each([false, true])(
    'propagates a report-write failure after scenario error=%s',
    async (throws) => {
      register(async () => {
        if (throws) throw new Error('scenario failure');
        return [check('SUCCESS')];
      });
      const failure = new Error('controlled write failure');
      const write = vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(failure);
      const log = vi.spyOn(console, 'log');
      await expect(runServerConformanceTest(URL, NAME, outputDir)).rejects.toBe(
        failure
      );
      expect(write).toHaveBeenCalledTimes(1);
      expect(
        log.mock.calls.some(([message]) =>
          String(message).startsWith('Results saved')
        )
      ).toBe(false);
    }
  );

  test('propagates directory creation errors before running the scenario', async () => {
    const run = vi.fn<ClientScenario['run']>();
    register(run);
    const failure = new Error('controlled mkdir failure');
    vi.spyOn(fs, 'mkdir').mockRejectedValueOnce(failure);
    await expect(runServerConformanceTest(URL, NAME, outputDir)).rejects.toBe(
      failure
    );
    expect(run).not.toHaveBeenCalled();
  });

  test('persists a forced scenario even outside its applicability window', async () => {
    register(() => {
      throw new Error('forced failure');
    });
    clientScenarios.get(NAME)!.source = {
      introducedIn: DRAFT_PROTOCOL_VERSION
    };
    const result = await runServerConformanceTest(
      URL,
      NAME,
      outputDir,
      LATEST_SPEC_VERSION,
      true
    );
    expect(result.skipped).toBeUndefined();
    expect(result.checks[0].status).toBe('FAILURE');
    expect(
      JSON.parse(
        await fs.readFile(path.join(result.resultDir!, 'checks.json'), 'utf8')
      )
    ).toEqual(result.checks);
  });

  test.each([{ checks: [] }, { checks: [check('SKIPPED')] }])(
    'preserves a completed result without failures: %j',
    async ({ checks }) => {
      register(async () => checks);
      expect((await runAndRead()).checks).toEqual(checks);
    }
  );

  test('does not rewrite a timeout report when the losing scenario rejects later', async () => {
    let reject!: (error: Error) => void;
    register(
      () =>
        new Promise((_resolve, rejectRun) => {
          reject = rejectRun;
        })
    );
    const write = vi.spyOn(fs, 'writeFile');
    const result = await runServerConformanceTest(
      URL,
      NAME,
      outputDir,
      undefined,
      false,
      10
    );
    reject(new Error('late failure'));
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(1);
    expect(result.checks[0].id).toBe('scenario-timeout');
    expect(
      JSON.parse(
        await fs.readFile(path.join(result.resultDir!, 'checks.json'), 'utf8')
      )
    ).toEqual(result.checks);
  });
});
