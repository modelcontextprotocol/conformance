import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { DNSRebindingProtectionScenario } from './dns-rebinding';
import { ResourcesNotFoundErrorScenario } from './resources';
import { CachingScenario } from './caching';
import { Sep2106Scenario } from './sep-2106';

function startServer(scriptPath: string, port: number): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const proc = spawn('npx', ['tsx', scriptPath], {
      env: { ...process.env, PORT: port.toString() },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows
    });
    let stderr = '';
    proc.stderr?.on('data', (d) => (stderr += d.toString()));
    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(
        new Error(`Server ${scriptPath} failed to start within 30s: ${stderr}`)
      );
    }, 30000);
    proc.stdout?.on('data', (data) => {
      if (data.toString().includes('running on')) {
        clearTimeout(timeout);
        resolve(proc);
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function stopServer(proc: ChildProcess | null): Promise<void> {
  return new Promise((resolve) => {
    if (!proc || proc.killed) return resolve();
    const t = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve();
    }, 5000);
    proc.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

describe('Server scenario negative tests', () => {
  describe('dns-rebinding-protection', () => {
    let serverProcess: ChildProcess | null = null;
    const PORT = 3004;

    beforeAll(async () => {
      serverProcess = await startServer(
        path.join(
          process.cwd(),
          'examples/servers/typescript/no-dns-rebinding-protection.ts'
        ),
        PORT
      );
    }, 35000);

    afterAll(async () => {
      await stopServer(serverProcess);
    });

    it('emits FAILURE against a server without rebinding protection', async () => {
      const scenario = new DNSRebindingProtectionScenario();
      const checks = await scenario.run(`http://localhost:${PORT}/mcp`);

      const rebindingCheck = checks.find(
        (c) => c.id === 'localhost-host-rebinding-rejected'
      );
      expect(rebindingCheck?.status).toBe('FAILURE');
    }, 10000);
  });

  describe('sep-2164-resource-not-found', () => {
    let serverProcess: ChildProcess | null = null;
    const PORT = 3005;

    beforeAll(async () => {
      serverProcess = await startServer(
        path.join(
          process.cwd(),
          'examples/servers/typescript/sep-2164-empty-contents.ts'
        ),
        PORT
      );
    }, 35000);

    afterAll(async () => {
      await stopServer(serverProcess);
    });

    it('emits FAILURE for no-empty-contents and WARNING for error-code against a server returning empty contents', async () => {
      const scenario = new ResourcesNotFoundErrorScenario();
      const checks = await scenario.run(`http://localhost:${PORT}/mcp`);

      const noEmpty = checks.find((c) => c.id === 'sep-2164-no-empty-contents');
      expect(noEmpty?.status).toBe('FAILURE');

      const errorCode = checks.find((c) => c.id === 'sep-2164-error-code');
      expect(errorCode?.status).toBe('WARNING');
    }, 10000);
  });

  describe('sep-2549-caching-hints', () => {
    let serverProcess: ChildProcess | null = null;
    const PORT = 3006;

    beforeAll(async () => {
      serverProcess = await startServer(
        path.join(
          process.cwd(),
          'examples/servers/typescript/sep-2549-no-caching-hints.ts'
        ),
        PORT
      );
    }, 35000);

    afterAll(async () => {
      await stopServer(serverProcess);
    });

    it('emits FAILURE for presence checks against a server without caching hints', async () => {
      const scenario = new CachingScenario();
      const checks = await scenario.run(`http://localhost:${PORT}/mcp`);

      // Should have at least 7 checks (5 presence + 2 aggregate)
      expect(checks.length).toBeGreaterThanOrEqual(7);

      const presenceCheckIds = [
        'sep-2549-tools-list-caching-hints',
        'sep-2549-prompts-list-caching-hints',
        'sep-2549-resources-list-caching-hints',
        'sep-2549-resources-templates-list-caching-hints',
        'sep-2549-resources-read-caching-hints'
      ];

      for (const checkId of presenceCheckIds) {
        const check = checks.find((c) => c.id === checkId);
        expect(check).toBeDefined();
        expect(check?.status).toBe('FAILURE');
      }
    }, 15000);
  });

  describe('sep-2106-broken-schema', () => {
    let serverProcess: ChildProcess | null = null;
    const PORT = 3008;

    beforeAll(async () => {
      serverProcess = await startServer(
        path.join(
          process.cwd(),
          'examples/servers/typescript/sep-2106-broken-schema.ts'
        ),
        PORT
      );
    }, 35000);

    afterAll(async () => {
      await stopServer(serverProcess);
    });

    it('emits FAILURE/WARNING against a server that flattens loosened SEP-2106 schemas', async () => {
      const scenario = new Sep2106Scenario();
      const checks = await scenario.run(`http://localhost:${PORT}/mcp`);

      // Tools are advertised, so the *-tool-found checks pass.
      // The shape/value checks should all fail.
      const expectedFailures = [
        'sep-2106-array-output-schema-preserved',
        'sep-2106-array-structured-content',
        'sep-2106-oneof-input-schema-preserved',
        'sep-2106-primitive-output-schema-preserved',
        'sep-2106-primitive-structured-content'
      ];
      for (const id of expectedFailures) {
        const check = checks.find((c) => c.id === id);
        expect(check, `check ${id} should exist`).toBeDefined();
        expect(check?.status, `check ${id} should fail`).toBe('FAILURE');
      }

      // The TextContent fallback SHOULD: WARNING when missing.
      const fallback = checks.find(
        (c) => c.id === 'sep-2106-array-text-fallback'
      );
      expect(fallback).toBeDefined();
      expect(fallback?.status).toBe('WARNING');
    }, 15000);
  });

  describe('sep-2106-compliant-positive', () => {
    let serverProcess: ChildProcess | null = null;
    const PORT = 3009;

    beforeAll(async () => {
      serverProcess = await startServer(
        path.join(
          process.cwd(),
          'examples/servers/typescript/sep-2106-compliant-server.ts'
        ),
        PORT
      );
    }, 35000);

    afterAll(async () => {
      await stopServer(serverProcess);
    });

    it('emits all SUCCESS against a SEP-2106-compliant server (positive case)', async () => {
      const scenario = new Sep2106Scenario();
      const checks = await scenario.run(`http://localhost:${PORT}/mcp`);

      // Every check should be SUCCESS (no FAILURE, no WARNING).
      const failures = checks.filter((c) => c.status === 'FAILURE');
      const warnings = checks.filter((c) => c.status === 'WARNING');
      expect(
        failures,
        `unexpected failures: ${failures.map((f) => `${f.id}: ${f.errorMessage}`).join('; ')}`
      ).toHaveLength(0);
      expect(
        warnings,
        `unexpected warnings: ${warnings.map((w) => `${w.id}: ${w.errorMessage}`).join('; ')}`
      ).toHaveLength(0);

      // Sanity: all 9 expected check IDs are present.
      const expectedIds = [
        'sep-2106-array-output-tool-found',
        'sep-2106-array-output-schema-preserved',
        'sep-2106-array-structured-content',
        'sep-2106-array-text-fallback',
        'sep-2106-oneof-input-tool-found',
        'sep-2106-oneof-input-schema-preserved',
        'sep-2106-primitive-output-tool-found',
        'sep-2106-primitive-output-schema-preserved',
        'sep-2106-primitive-structured-content'
      ];
      for (const id of expectedIds) {
        expect(
          checks.find((c) => c.id === id),
          `${id} missing`
        ).toBeDefined();
      }
    }, 15000);
  });
});
