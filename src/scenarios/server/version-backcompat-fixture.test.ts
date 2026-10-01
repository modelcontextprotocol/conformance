import { ChildProcess, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import {
  LEGACY_PROTOCOL_VERSION,
  MAX_COMPAT_MESSAGE_BYTES,
  probeLegacyHttpFallback
} from '../../version-compat';

interface RunningFixture {
  processHandle: ChildProcess;
  serverUrl: string;
}

async function startFixture(emitModernError: boolean): Promise<RunningFixture> {
  const script = path.join(
    process.cwd(),
    'examples/servers/typescript/legacy-version-server.ts'
  );
  const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
  const processHandle = spawn(process.execPath, [tsxCli, script], {
    env: {
      ...process.env,
      PORT: '0',
      EMIT_MODERN_ERROR: String(emitModernError)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const serverUrl = await new Promise<string>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      processHandle.kill('SIGKILL');
      reject(new Error(`Legacy fixture startup timed out: ${stderr}`));
    }, 30_000);
    processHandle.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    processHandle.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/running on (http:\/\/127\.0\.0\.1:\d+\/mcp)/);
      if (match?.[1]) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    processHandle.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    processHandle.once('exit', (code) => {
      if (code !== null) {
        clearTimeout(timeout);
        reject(new Error(`Legacy fixture exited with ${code}: ${stderr}`));
      }
    });
  });

  return { processHandle, serverUrl };
}

async function stopFixture(processHandle: ChildProcess): Promise<void> {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      processHandle.kill('SIGKILL');
      resolve();
    }, 5_000);
    processHandle.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    processHandle.kill('SIGTERM');
  });
}

async function postJson(
  serverUrl: string,
  body: Record<string, unknown>
): Promise<Response> {
  return fetch(serverUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

describe('legacy version server example', () => {
  test.each([
    { emitModernError: false, expectedKind: 'legacy-fallback' },
    { emitModernError: true, expectedKind: 'modern' }
  ] as const)(
    'modern-error mode $emitModernError is classified as $expectedKind',
    async ({ emitModernError, expectedKind }) => {
      const fixture = await startFixture(emitModernError);
      try {
        const result = await probeLegacyHttpFallback(fixture.serverUrl);
        expect(result.kind).toBe(expectedKind);
      } finally {
        await stopFixture(fixture.processHandle);
      }
    },
    40_000
  );

  test('supports initialize, initialized notification, and tools/list', async () => {
    const fixture = await startFixture(false);
    try {
      const initialize = await postJson(fixture.serverUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LEGACY_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'fixture-test', version: '1.0.0' }
        }
      });
      expect(initialize.status).toBe(200);
      await expect(initialize.json()).resolves.toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: LEGACY_PROTOCOL_VERSION }
      });

      const initialized = await postJson(fixture.serverUrl, {
        jsonrpc: '2.0',
        method: 'notifications/initialized'
      });
      expect(initialized.status).toBe(202);

      const tools = await postJson(fixture.serverUrl, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {}
      });
      expect(tools.status).toBe(200);
      await expect(tools.json()).resolves.toMatchObject({
        jsonrpc: '2.0',
        id: 2,
        result: { tools: [] }
      });
    } finally {
      await stopFixture(fixture.processHandle);
    }
  }, 40_000);

  test('rejects scalar JSON and oversized request bodies without crashing', async () => {
    const fixture = await startFixture(false);
    try {
      const scalar = await fetch(fixture.serverUrl, {
        method: 'POST',
        body: 'null'
      });
      expect(scalar.status).toBe(400);

      const oversized = await fetch(fixture.serverUrl, {
        method: 'POST',
        body: 'x'.repeat(MAX_COMPAT_MESSAGE_BYTES + 1)
      });
      expect(oversized.status).toBe(413);
    } finally {
      await stopFixture(fixture.processHandle);
    }
  }, 40_000);
});
