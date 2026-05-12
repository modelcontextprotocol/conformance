import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { ServerStatelessScenario } from './stateless';

function startServer(
  scriptPath: string,
  port: number,
  envOverrides?: Record<string, string>
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const proc = spawn('npx', ['tsx', scriptPath], {
      env: { ...process.env, PORT: port.toString(), ...envOverrides },
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

describe('ServerStatelessScenario tests', () => {
  describe('passing server', () => {
    let serverProcess: ChildProcess | null = null;
    const PORT = 3010;

    beforeAll(async () => {
      serverProcess = await startServer(
        path.join(
          process.cwd(),
          'examples/servers/typescript/everything-server.ts'
        ),
        PORT
      );
    }, 35000);

    afterAll(async () => {
      await stopServer(serverProcess);
    });

    it('emits SUCCESS for all checks against a compliant stateless server', async () => {
      const scenario = new ServerStatelessScenario();
      const checks = await scenario.run(`http://localhost:${PORT}/mcp`);

      for (const check of checks) {
        if (check.status !== 'SUCCESS') {
          console.error('FAILED CHECK:', JSON.stringify(check, null, 2));
        }
        expect(check.status).toBe('SUCCESS');
      }
    }, 15000);
  });

  describe('negative server', () => {
    let serverProcess: ChildProcess | null = null;
    const PORT = 3012;

    beforeAll(async () => {
      serverProcess = await startServer(
        path.join(
          process.cwd(),
          'examples/servers/typescript/everything-server.ts'
        ),
        PORT,
        { STATELESS_NEGATIVE: 'true' }
      );
    }, 35000);

    afterAll(async () => {
      await stopServer(serverProcess);
    });

    it('emits FAILURE for checks against a broken stateless server', async () => {
      const scenario = new ServerStatelessScenario();
      const checks = await scenario.run(`http://localhost:${PORT}/mcp`);

      const failures = checks.filter((c) => c.status === 'FAILURE');
      expect(failures.length).toBeGreaterThan(0);
    }, 15000);
  });
});
