import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { Command, Option } from 'commander';
import { ZodError } from 'zod';
import { loadSdkConfig, SdkConfig } from './config';
import { parseSdkSpec, ensureCheckout } from './checkout';
import { lookupBuiltinConfig, knownSdkNames } from './known-sdks';

type Mode = 'client' | 'server' | 'both';

function execShell(command: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed (exit ${code}): ${command}`));
    });
  });
}

/**
 * Re-invoke this CLI as a subprocess so scenario selection / reporting stay in
 * one place (same approach tier-check uses). Preserves execArgv so tsx/loader
 * hooks carry over when running from source.
 */
function selfInvoke(args: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...process.execArgv, process.argv[1], ...args],
      { cwd, stdio: 'inherit' }
    );
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { method: 'GET' });
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(
    `Server at ${url} did not become ready within ${timeoutMs}ms: ${lastErr}`
  );
}

async function withManagedServer<T>(
  command: string,
  cwd: string,
  url: string,
  readyTimeoutMs: number,
  fn: () => Promise<T>
): Promise<T> {
  console.error(`[sdk] Starting server: ${command}`);
  const child: ChildProcess = spawn(command, {
    shell: true,
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  });

  let stderr = '';
  child.stdout?.on('data', (d) => process.stderr.write(`[server] ${d}`));
  child.stderr?.on('data', (d) => {
    stderr += d.toString();
    process.stderr.write(`[server] ${d}`);
  });

  let stopping = false;
  const exited = new Promise<never>((_, reject) => {
    child.on('exit', (code) => {
      if (stopping) return;
      reject(
        new Error(
          `Server exited with code ${code} before tests completed\n${stderr}`
        )
      );
    });
    child.on('error', reject);
  });
  exited.catch(() => {});

  try {
    await Promise.race([waitForReady(url, readyTimeoutMs), exited]);
    console.error(`[sdk] Server ready at ${url}`);
    return await Promise.race([fn(), exited]);
  } finally {
    stopping = true;
    console.error(`[sdk] Stopping server`);
    if (process.platform !== 'win32' && child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    } else {
      child.kill('SIGTERM');
    }
  }
}

function passThrough(options: {
  scenario?: string;
  suite?: string;
  timeout?: string;
  verbose?: boolean;
  output?: string;
}): string[] {
  const args: string[] = [];
  if (options.scenario) args.push('--scenario', options.scenario);
  else if (options.suite) args.push('--suite', options.suite);
  if (options.timeout) args.push('--timeout', options.timeout);
  if (options.verbose) args.push('--verbose');
  if (options.output) args.push('-o', options.output);
  return args;
}

export function createSdkCommand(): Command {
  return new Command('sdk')
    .description(
      'Run the local conformance build against an SDK checked out at a specific ref'
    )
    .argument(
      '[sdk]',
      'SDK to test as <name>[@<ref>], e.g. typescript-sdk@main. Name may be owner/repo.'
    )
    .option(
      '--path <dir>',
      'Use an existing local SDK checkout instead of cloning'
    )
    .option(
      '--cache-dir <dir>',
      'Directory for cached SDK clones',
      '.sdk-under-test'
    )
    .addOption(
      new Option('--mode <mode>', 'Which side to test')
        .choices(['client', 'server', 'both'])
        .default('both')
    )
    .option('--scenario <name>', 'Run a single scenario (passed through)')
    .option('--suite <name>', 'Run a suite (passed through)')
    .option('--skip-build', 'Skip the SDK build step (reuse prior build)')
    .option('--build-cmd <cmd>', 'Override the build command from config')
    .option('--client-cmd <cmd>', 'Override the client command from config')
    .option('--server-cmd <cmd>', 'Override the server command from config')
    .option('--server-url <url>', 'Override the server URL from config')
    .option('--timeout <ms>', 'Per-scenario client timeout (passed through)')
    .option('-o, --output <dir>', 'Output directory (passed through)')
    .option('--verbose', 'Verbose output (passed through)')
    .action(async (sdkArg: string | undefined, options) => {
      try {
        const mode = options.mode as Mode;
        if (options.scenario && mode === 'both') {
          throw new Error(
            `--scenario requires --mode client or --mode server (a scenario belongs to exactly one side)`
          );
        }
        if (!sdkArg && !options.path) {
          throw new Error(
            `Provide an SDK spec (e.g. typescript-sdk@main) or --path`
          );
        }

        const spec = sdkArg ? parseSdkSpec(sdkArg) : undefined;
        const dir = options.path
          ? path.resolve(options.path)
          : await ensureCheckout(spec!, options.cacheDir);
        const sdkName = spec?.name ?? path.basename(dir);

        // Resolution: CLI flag > config file in SDK checkout > built-in.
        const fileConfig: SdkConfig = (await loadSdkConfig(dir)) ?? {};
        const builtinConfig: SdkConfig = lookupBuiltinConfig(sdkName) ?? {};
        const buildCmd: string | undefined =
          options.buildCmd ?? fileConfig.build ?? builtinConfig.build;
        const clientCmd: string | undefined =
          options.clientCmd ??
          fileConfig.client?.command ??
          builtinConfig.client?.command;
        const serverCmd: string | undefined =
          options.serverCmd ??
          fileConfig.server?.command ??
          builtinConfig.server?.command;
        const serverUrl: string | undefined =
          options.serverUrl ??
          fileConfig.server?.url ??
          builtinConfig.server?.url;
        const expectedFailuresRel =
          fileConfig.expectedFailures ?? builtinConfig.expectedFailures;
        const expectedFailures = expectedFailuresRel
          ? path.resolve(dir, expectedFailuresRel)
          : undefined;

        if (buildCmd && !options.skipBuild) {
          console.error(`[sdk] Building: ${buildCmd}`);
          await execShell(buildCmd, dir);
        } else if (!buildCmd) {
          console.error(
            `[sdk] No build command in config; assuming SDK is already built`
          );
        }

        let exitCode = 0;

        if (mode === 'client' || mode === 'both') {
          if (!clientCmd) {
            throw new Error(
              `No client command for '${sdkName}'. Pass --client-cmd, or add it to KNOWN_SDKS in src/sdk-runner/known-sdks.ts (known: ${knownSdkNames().join(', ')}).`
            );
          }
          const args = [
            'client',
            '--command',
            clientCmd,
            ...passThrough({
              scenario: options.scenario,
              suite: options.suite ?? 'all',
              timeout: options.timeout,
              verbose: options.verbose,
              output: options.output
            })
          ];
          if (expectedFailures)
            args.push('--expected-failures', expectedFailures);
          console.error(`\n[sdk] conformance ${args.join(' ')}\n`);
          exitCode ||= await selfInvoke(args, dir);
        }

        if (mode === 'server' || mode === 'both') {
          if (!serverCmd || !serverUrl) {
            throw new Error(
              `No server command/url for '${sdkName}'. Pass --server-cmd / --server-url, or add it to KNOWN_SDKS in src/sdk-runner/known-sdks.ts (known: ${knownSdkNames().join(', ')}).`
            );
          }
          const args = [
            'server',
            '--url',
            serverUrl,
            ...passThrough({
              scenario: options.scenario,
              suite: options.suite,
              verbose: options.verbose,
              output: options.output
            })
          ];
          if (expectedFailures)
            args.push('--expected-failures', expectedFailures);
          exitCode ||= await withManagedServer(
            serverCmd,
            dir,
            serverUrl,
            fileConfig.server?.readyTimeoutMs ??
              builtinConfig.server?.readyTimeoutMs ??
              15000,
            async () => {
              console.error(`\n[sdk] conformance ${args.join(' ')}\n`);
              return selfInvoke(args, dir);
            }
          );
        }

        process.exit(exitCode);
      } catch (error) {
        if (error instanceof ZodError) {
          console.error('Config validation error:');
          error.issues.forEach((e) =>
            console.error(`  ${e.path.join('.')}: ${e.message}`)
          );
        } else {
          console.error(
            `[sdk] ${error instanceof Error ? error.message : String(error)}`
          );
        }
        process.exit(1);
      }
    });
}
