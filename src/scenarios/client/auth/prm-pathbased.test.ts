import { describe, test, expect } from '@jest/globals';
import { PRMPathBasedScenario } from './prm-pathbased.js';
import { spawn } from 'child_process';
import path from 'path';

async function runClient(
  serverUrl: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const clientPath = path.join(
    process.cwd(),
    'examples/clients/typescript/test1.ts'
  );

  return new Promise((resolve, reject) => {
    const proc = spawn('tsx', [clientPath, serverUrl], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      resolve({ exitCode: code || 0, stdout, stderr });
    });

    proc.on('error', (err) => {
      reject(err);
    });

    setTimeout(() => {
      proc.kill();
      reject(new Error('Test timeout'));
    }, 30000);
  });
}

describe('PRM Path-Based Discovery', () => {
  test('client discovers PRM at path-based location before root', async () => {
    const scenario = new PRMPathBasedScenario();

    const urls = await scenario.start();

    try {
      const result = await runClient(urls.serverUrl);

      console.log('Client stdout:', result.stdout);
      console.log('Client stderr:', result.stderr);
      console.log('Client exit code:', result.exitCode);

      const checks = scenario.getChecks();
      console.log(
        'Checks:',
        JSON.stringify(
          checks.filter((c) => c.status !== 'INFO'),
          null,
          2
        )
      );

      const pathBasedCheck = checks.find(
        (c) => c.id === 'prm-pathbased-requested'
      );
      expect(pathBasedCheck).toBeDefined();
      expect(pathBasedCheck?.status).toBe('SUCCESS');

      const rootNotFirstCheck = checks.find(
        (c) => c.id === 'prm-root-not-checked-first'
      );
      expect(rootNotFirstCheck).toBeDefined();
      expect(rootNotFirstCheck?.status).toBe('SUCCESS');
    } finally {
      await scenario.stop();
    }
  });
});
