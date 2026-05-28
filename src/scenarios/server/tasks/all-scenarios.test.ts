/**
 * SEP-2663 Tasks extension test runner.
 *
 * Iterates the tasks server scenarios against a SEP-2663-conformant
 * server. Configuration is brand-neutral and language-agnostic:
 *
 *   1. Point at an already-running server:
 *        TASKS_SERVER_URL=http://localhost:8080/mcp npm test -- tasks/all-scenarios.test.ts
 *
 *   2. Auto-spawn a fixture before tests (any language; the runner just
 *      shells out to TASKS_SERVER_CMD and waits until TASKS_SERVER_URL
 *      becomes reachable):
 *        TASKS_SERVER_URL=http://localhost:18092/mcp \
 *        TASKS_SERVER_CMD="/path/to/server --port 18092" \
 *          npm test -- tasks/all-scenarios.test.ts
 *
 * If TASKS_SERVER_URL is unset, the suite is skipped — letting CI runs
 * against the everything-server stay green until the upstream fixture
 * grows SEP-2663 support.
 *
 * Readiness is detected by polling the URL's host/port for a TCP
 * connection (deliberately language-agnostic — no log-line scanning).
 *
 * The fixture server can be implemented in any language as long as it
 * exposes a SEP-2663 conformant Streamable HTTP MCP endpoint. Anyone is
 * free to bring their own; one example reference implementation lives
 * at https://github.com/panyam/mcpkit/tree/main/examples/tasks-v2.
 */

import { spawn, ChildProcess } from 'child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TasksLifecycleScenario } from './lifecycle';
import { TasksCapabilityNegotiationScenario } from './capability';
import { TasksWireFieldsScenario } from './wire-fields';
import { TasksRequestStateRemovalScenario } from './request-state';
import { TasksMRTRInputScenario } from './mrtr-input';
import { TasksRequestHeadersScenario } from './headers';
import { TasksDispatchScenario } from './dispatch';
import { TasksStatusNotificationsScenario } from './notifications';
import { TasksRequiredTaskErrorScenario } from './required-task-error';
import { parseWireModes, type WireMode } from '../_shared/wire-mode';
import { waitForServerReady } from '../_shared/test-runner';

const SERVER_URL = process.env.TASKS_SERVER_URL;
const SERVER_CMD = process.env.TASKS_SERVER_CMD;
const SERVER_STARTUP_TIMEOUT_MS = 15_000;
const SHOULD_SPAWN = Boolean(SERVER_URL && SERVER_CMD);
const HAVE_TARGET = Boolean(SERVER_URL);

const TASKS_SCENARIOS = [
  new TasksLifecycleScenario(),
  new TasksCapabilityNegotiationScenario(),
  new TasksWireFieldsScenario(),
  new TasksRequestStateRemovalScenario(),
  new TasksMRTRInputScenario(),
  new TasksRequestHeadersScenario(),
  new TasksDispatchScenario(),
  new TasksStatusNotificationsScenario(),
  new TasksRequiredTaskErrorScenario()
];

// Tasks behavior is wire-independent in spec: SEP-2663 semantics
// hold on both the legacy session wire AND the SEP-2575 stateless
// wire. parseWireModes returns both by default; pin via
// MCP_WIRE_MODES=legacy or =stateless when an SDK has only one wire
// implemented. The same parser drives the mrtr harness.
const WIRE_MODES: WireMode[] = parseWireModes();

// describe.each / it.each table shape: tuple of (label, statelessFlag) so
// vitest reports the wire as a clean parameter row (`legacy wire`,
// `stateless wire`) without us re-deriving the boolean inside each test.
const WIRE_TABLE: ReadonlyArray<readonly [WireMode, boolean]> = WIRE_MODES.map(
  (m) => [m, m === 'stateless'] as const
);

const describeIfTarget = HAVE_TARGET ? describe : describe.skip;

describeIfTarget('SEP-2663 Tasks — server conformance', () => {
  let serverProcess: ChildProcess | null = null;

  beforeAll(async () => {
    if (!SHOULD_SPAWN) return;

    serverProcess = spawn('sh', ['-c', SERVER_CMD!], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    serverProcess.stdout?.on('data', (b) => {
      stdoutBuf += b.toString();
    });
    serverProcess.stderr?.on('data', (b) => {
      stderrBuf += b.toString();
    });

    serverProcess.on('exit', (code) => {
      if (code !== null && code !== 0) {
        console.error(
          `tasks fixture exited unexpectedly with code ${code}.\nSTDOUT: ${stdoutBuf}\nSTDERR: ${stderrBuf}`
        );
      }
    });

    await waitForServerReady(SERVER_URL!, SERVER_STARTUP_TIMEOUT_MS).catch(
      (err) => {
        if (serverProcess && !serverProcess.killed) {
          serverProcess.kill('SIGKILL');
        }
        throw new Error(
          `tasks fixture did not become reachable within ${SERVER_STARTUP_TIMEOUT_MS}ms: ${err.message}\nSTDOUT: ${stdoutBuf}\nSTDERR: ${stderrBuf}`
        );
      }
    );
  }, SERVER_STARTUP_TIMEOUT_MS + 5_000);

  afterAll(async () => {
    if (!SHOULD_SPAWN) return;
    if (!serverProcess || serverProcess.killed) return;
    serverProcess.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (serverProcess && !serverProcess.killed) {
          serverProcess.kill('SIGKILL');
        }
        resolve();
      }, 3_000);
      serverProcess!.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    serverProcess = null;
  });

  describe.each(WIRE_TABLE)('%s wire', (_wireLabel, stateless) => {
    it.each(TASKS_SCENARIOS)(
      '$name — all checks succeed against fixture',
      async (scenario) => {
        const checks = await scenario.run(SERVER_URL!, { stateless });
        expect(checks.length).toBeGreaterThan(0);
        const failures = checks.filter(
          (c) => c.status === 'FAILURE' || c.status === 'WARNING'
        );
        if (failures.length > 0) {
          const detail = failures
            .map((c) => `  - ${c.id}: ${c.errorMessage ?? '(no message)'}`)
            .join('\n');
          throw new Error(
            `${failures.length}/${checks.length} checks failed:\n${detail}`
          );
        }
      }
    );
  });
});
