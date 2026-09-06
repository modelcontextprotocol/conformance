import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { Command, Option } from 'commander';
import { SdkConfig, resolveConfigForSpec } from './config';
import { parseSdkSpec, ensureCheckout } from './checkout';
import { lookupBuiltinConfig, knownSdkNames } from './known-sdks';
import { resolveSpecVersion } from '../scenarios';

type Mode = 'client' | 'server';

export function execShell(command: string, cwd: string): Promise<void> {
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
  // Per-probe timeout: a server that accepts the socket but never responds must
  // not block past the overall deadline (fetch has no timeout of its own).
  const probeTimeoutMs = 2000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(probeTimeoutMs)
      });
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

export async function withManagedServer<T>(
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
    const gone = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
    const signal = (sig: NodeJS.Signals) => {
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, sig);
        } catch {
          child.kill(sig);
        }
      } else {
        child.kill(sig);
      }
    };
    signal('SIGTERM');
    // Wait for the process to actually release its port: a consecutive run on
    // the same port must never race a dying predecessor. Escalate if needed.
    const timer = (ms: number) => new Promise((r) => setTimeout(r, ms));
    if ((await Promise.race([gone.then(() => true), timer(5000)])) !== true) {
      signal('SIGKILL');
      await Promise.race([gone, timer(2000)]);
    }
  }
}

function passThrough(options: {
  scenario?: string;
  suite?: string;
  timeout?: string;
  verbose?: boolean;
  output?: string;
  specVersion?: string;
  requirements?: string;
}): string[] {
  const args: string[] = [];
  // A requirement set replaces scenario/suite/spec-version selection: it names
  // the scenarios AND pins the wire version they run at.
  if (options.requirements) {
    args.push('--requirements', options.requirements);
  } else if (options.scenario) {
    args.push('--scenario', options.scenario);
  } else if (options.suite) {
    args.push('--suite', options.suite);
  }
  if (options.timeout) args.push('--timeout', options.timeout);
  if (options.verbose) args.push('--verbose');
  if (options.output) args.push('-o', options.output);
  if (!options.requirements && options.specVersion)
    args.push('--spec-version', options.specVersion);
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
      new Option(
        '--mode <mode>',
        'Which side to test (required): client or server'
      ).choices(['client', 'server'])
    )
    .option('--scenario <name>', 'Run a single scenario (passed through)')
    .option('--suite <name>', 'Run a suite (passed through)')
    .option('--skip-build', 'Skip the SDK build step (reuse prior build)')
    .option('--build-cmd <cmd>', 'Override the build command from config')
    .option('--client-cmd <cmd>', 'Override the client command from config')
    .option('--server-cmd <cmd>', 'Override the server command from config')
    .option('--server-url <url>', 'Override the server URL from config')
    .option(
      '--expected-failures <path>',
      'Override the expected-failures baseline file from config'
    )
    .option('--timeout <ms>', 'Per-scenario client timeout (passed through)')
    .option('-o, --output <dir>', 'Output directory (passed through)')
    .option(
      '--spec-version <version>',
      'Spec version to target (passed through; defaults to the SDK config)'
    )
    .option(
      '--requirements <revision>',
      "Run exactly the scenarios this spec revision requires, at that revision's wire, with the SDK invocation resolved for that revision (e.g. 2026-07-28). Replaces --suite/--scenario/--spec-version"
    )
    .option('--verbose', 'Verbose output (passed through)')
    .action(async (sdkArg: string | undefined, options) => {
      try {
        const mode = options.mode as Mode | undefined;
        if (!mode) {
          throw new Error(`--mode is required (client | server)`);
        }
        if (!sdkArg && !options.path) {
          throw new Error(
            `Provide an SDK spec (e.g. typescript-sdk@main) or --path`
          );
        }

        const spec = sdkArg ? parseSdkSpec(sdkArg) : undefined;
        const sdkName =
          spec?.name ?? path.basename(path.resolve(options.path!));

        // Resolution: CLI flag > built-in entry (KNOWN_SDKS).
        const baseConfig: SdkConfig = lookupBuiltinConfig(sdkName) ?? {};

        // The targeted spec version (explicit flag wins over the per-SDK
        // default) selects that version's specOverrides entry, so version-
        // specific invocations live in config instead of copy-paste flags.
        // 'draft' resolves to its dated alias so overlay keys stay canonical.
        if (
          options.requirements &&
          (options.specVersion || options.suite || options.scenario)
        ) {
          throw new Error(
            '--requirements cannot be combined with --spec-version, --suite or --scenario: a requirement set already fixes which scenarios run and at which wire.'
          );
        }
        // A requirements revision doubles as the spec version for config
        // resolution, so the specOverrides entry for that revision picks the
        // right server command/url (go-sdk needs a different process per wire
        // era, csharp-sdk a different endpoint).
        const requestedSpec =
          options.requirements ?? options.specVersion ?? baseConfig.specVersion;
        const specVersion: string | undefined = requestedSpec
          ? resolveSpecVersion(requestedSpec)
          : undefined;
        const builtinConfig = resolveConfigForSpec(baseConfig, specVersion);

        // The built-in entry may be an alias (e.g. typescript-sdk-v1): honor its
        // `repo` (real clone target) and `defaultRef` (branch when no @ref given).
        const dir = options.path
          ? path.resolve(options.path)
          : await ensureCheckout(
              {
                name: builtinConfig.repo ?? spec!.name,
                ref: spec!.ref ?? builtinConfig.defaultRef ?? 'main'
              },
              options.cacheDir
            );
        const buildCmd: string | undefined =
          options.buildCmd ?? builtinConfig.build;
        const clientCmd: string | undefined =
          options.clientCmd ?? builtinConfig.client?.command;
        const serverCmd: string | undefined =
          options.serverCmd ?? builtinConfig.server?.command;
        const serverUrl: string | undefined =
          options.serverUrl ?? builtinConfig.server?.url;
        // CLI override resolves relative to the user's invocation cwd; the
        // built-in default resolves relative to the SDK checkout.
        // Under --requirements the frozen set decides pass/fail and tier-check
        // ignores baselines entirely, so auto-attaching the SDK's own baseline
        // would let the two commands return opposite verdicts for the same
        // run. An explicit --expected-failures remains a deliberate choice.
        const expectedFailures = options.expectedFailures
          ? path.resolve(options.expectedFailures)
          : builtinConfig.expectedFailures && !options.requirements
            ? path.resolve(dir, builtinConfig.expectedFailures)
            : undefined;
        // Resolve -o to an absolute path so it lands where the user expects,
        // not relative to the SDK checkout (selfInvoke runs with cwd = dir).
        const output = options.output
          ? path.resolve(options.output)
          : undefined;
        if (buildCmd && !options.skipBuild) {
          console.error(`[sdk] Building: ${buildCmd}`);
          await execShell(buildCmd, dir);
        } else if (!buildCmd) {
          console.error(
            `[sdk] No build command in config; assuming SDK is already built`
          );
        }

        let exitCode: number;

        if (mode === 'client') {
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
              suite: options.requirements
                ? undefined
                : (options.suite ?? 'all'),
              timeout: options.timeout,
              verbose: options.verbose,
              output,
              specVersion,
              requirements: options.requirements
            })
          ];
          if (expectedFailures)
            args.push('--expected-failures', expectedFailures);
          console.error(`\n[sdk] conformance ${args.join(' ')}\n`);
          exitCode = await selfInvoke(args, dir);
        } else {
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
              // Default to the `active` suite (excludes pending/draft) — the same
              // suite tiering runs, and the most reasonable default to avoid
              // surfacing intentionally-deferred `pending` scenarios.
              suite: options.requirements
                ? undefined
                : (options.suite ?? 'active'),
              verbose: options.verbose,
              output,
              specVersion,
              requirements: options.requirements
            })
          ];
          if (expectedFailures)
            args.push('--expected-failures', expectedFailures);
          exitCode = await withManagedServer(
            serverCmd,
            dir,
            serverUrl,
            builtinConfig.server?.readyTimeoutMs ?? 15000,
            async () => {
              console.error(`\n[sdk] conformance ${args.join(' ')}\n`);
              return selfInvoke(args, dir);
            }
          );
        }

        process.exit(exitCode);
      } catch (error) {
        console.error(
          `[sdk] ${error instanceof Error ? error.message : String(error)}`
        );
        process.exit(1);
      }
    });
}
