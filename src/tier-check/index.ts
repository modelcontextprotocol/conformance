import { Command } from 'commander';
import { Octokit } from '@octokit/rest';
import {
  checkConformance,
  checkClientConformance,
  mergeByRevision
} from './checks/test-conformance-results';
import { checkLabels } from './checks/labels';
import { checkTriage } from './checks/triage';
import { checkP0Resolution } from './checks/p0';
import { checkStableRelease } from './checks/release';
import { checkPolicySignals } from './checks/files';
import { checkSpecTracking } from './checks/spec-tracking';
import { computeTier } from './tier-logic';
import { formatJson, formatMarkdown, formatTerminal } from './output';
import { TierScorecard } from './types';
import { resolveSpecVersion } from '../scenarios';
import {
  listRequirementRevisions,
  loadRequirements,
  RequirementSet
} from '../requirements';
import { execShell, withManagedServer } from '../sdk-runner';
import { lookupBuiltinConfig } from '../sdk-runner/known-sdks';
import { resolveConfigForSpec, SdkConfig } from '../sdk-runner/config';
import { ensureCheckout, parseSdkSpec } from '../sdk-runner/checkout';
import { ConformanceResult } from './types';
import path from 'path';

/**
 * Run both conformance legs for each claimed revision with the SDK's own
 * invocation for that revision, resolved from KNOWN_SDKS specOverrides. This is
 * what makes multi-revision tiering correct for SDKs whose wire era is fixed
 * per process (go-sdk starts a different server per revision) or per endpoint
 * (csharp-sdk serves the stateless lifecycle at /stateless): one
 * --conformance-server-url cannot describe them, but their config already does.
 * Sequential on purpose — consecutive revisions reuse the same port.
 */
async function runSdkConformance(
  dir: string,
  base: SdkConfig,
  requirements: RequirementSet[],
  options: { skipBuild?: boolean; timeoutMs?: number }
): Promise<{ server: ConformanceResult; client: ConformanceResult }> {
  const server: { revision: string; result: ConformanceResult }[] = [];
  const client: { revision: string; result: ConformanceResult }[] = [];
  const built = new Set<string>();

  for (const req of requirements) {
    const cfg = resolveConfigForSpec(base, req.revision);

    if (cfg.build && !options.skipBuild && !built.has(cfg.build)) {
      console.error(`  [sdk] Building for ${req.revision}: ${cfg.build}`);
      await execShell(cfg.build, dir);
      built.add(cfg.build);
    }

    if (cfg.server) {
      const { command, url, readyTimeoutMs } = cfg.server;
      const result = await withManagedServer(
        command,
        dir,
        url,
        readyTimeoutMs ?? 15000,
        () => checkConformance({ serverUrl: url, requirements: req })
      );
      server.push({ revision: req.revision, result });
    } else {
      server.push({
        revision: req.revision,
        result: {
          status: 'skipped',
          pass_rate: 0,
          passed: 0,
          failed: 0,
          total: 0,
          details: []
        }
      });
    }

    client.push({
      revision: req.revision,
      result: await checkClientConformance({
        clientCmd: cfg.client?.command,
        skip: !cfg.client,
        requirements: req,
        cwd: dir,
        timeoutMs: options.timeoutMs
      })
    });
  }

  return {
    server: mergeByRevision(server),
    client: mergeByRevision(client)
  };
}

function parseRepo(repo: string): { owner: string; repo: string } {
  const parts = repo.split('/');
  if (parts.length !== 2)
    throw new Error(`Invalid repo format: ${repo}. Expected owner/repo`);
  return { owner: parts[0], repo: parts[1] };
}

export function createTierCheckCommand(): Command {
  const tierCheck = new Command('tier-check')
    .description('Run SDK tier assessment checks against a GitHub repository')
    .option(
      '--repo <owner/repo>',
      'GitHub repository (e.g., modelcontextprotocol/typescript-sdk). Derived from --sdk when omitted'
    )
    .option('--branch <branch>', 'Branch to check')
    .option(
      '--sdk <name[@ref]>',
      'Assess a known SDK end to end: clones/builds it and runs each revision with the invocation its config declares for that revision (see src/sdk-runner/known-sdks.ts)'
    )
    .option(
      '--sdk-path <dir>',
      'Use an existing local SDK checkout with --sdk semantics (config resolved from the directory name unless --sdk names it)'
    )
    .option('--skip-build', 'Skip the SDK build step (with --sdk/--sdk-path)')
    .option(
      '--cache-dir <dir>',
      'Directory for cached SDK clones (with --sdk)',
      '.sdk-under-test'
    )
    .option(
      '--timeout <ms>',
      'Per-scenario client timeout, forwarded to the client leg'
    )
    .option(
      '--conformance-server-url <url>',
      'URL of an already-running conformance server. Only correct when that one endpoint serves every claimed revision at its own wire; SDKs that vary the server per revision need --sdk'
    )
    .option(
      '--client-cmd <cmd>',
      'Command to run the SDK conformance client (with --conformance-server-url; must be invocable from this directory)'
    )
    .option('--skip-conformance', 'Skip conformance tests')
    .option('--days <n>', 'Limit triage check to issues created in last N days')
    .option(
      '--output <format>',
      'Output format: json, markdown, terminal',
      'terminal'
    )
    .option(
      '--token <token>',
      'GitHub token (defaults to GITHUB_TOKEN env var)'
    )
    .option(
      '--spec-version <version>',
      'Only run conformance scenarios for this spec version'
    )
    .option(
      '--requirements <revision>',
      'Score against the frozen requirement set for a spec revision (e.g. 2026-07-28), so the SDK is measured against the suite as it stood when that revision shipped'
    )
    .action(async (options) => {
      const sdkMode =
        options.sdk !== undefined || options.sdkPath !== undefined;

      if (sdkMode && (options.conformanceServerUrl || options.clientCmd)) {
        console.error(
          '--sdk resolves the server and client invocation per revision from the SDK config; it cannot be combined with --conformance-server-url or --client-cmd.'
        );
        process.exit(1);
      }
      if (sdkMode && (options.specVersion || options.skipConformance)) {
        console.error(
          '--sdk runs the frozen requirement sets; it cannot be combined with --spec-version or --skip-conformance.'
        );
        process.exit(1);
      }

      // Resolve the SDK checkout and config up front so --repo/--branch can be
      // derived from it.
      let sdkDir: string | undefined;
      let sdkConfig: SdkConfig | undefined;
      if (sdkMode) {
        const spec = options.sdk ? parseSdkSpec(options.sdk) : undefined;
        const sdkName =
          spec?.name ?? path.basename(path.resolve(options.sdkPath));
        sdkConfig = lookupBuiltinConfig(sdkName) ?? undefined;
        if (!sdkConfig) {
          console.error(
            `'${sdkName}' is not a known SDK (see src/sdk-runner/known-sdks.ts). Use --conformance-server-url/--client-cmd to drive an unknown SDK directly.`
          );
          process.exit(1);
        }
        // One ref, used for the checkout, the scorecard and the policy-file
        // reads alike — computing them independently attributed verdicts to
        // branches that never ran (an aliased entry like typescript-sdk-v1
        // tests v1.x but read policy files from main).
        if (options.sdk && options.branch) {
          console.error(
            '--branch cannot be combined with --sdk: put the ref in the SDK spec instead (e.g. --sdk typescript-sdk@v1.x).'
          );
          process.exit(1);
        }
        if (options.sdkPath) {
          sdkDir = path.resolve(options.sdkPath);
          if (!options.branch) {
            // Report the branch the checkout is actually on.
            try {
              const { execSync } = await import('child_process');
              const head = execSync('git rev-parse --abbrev-ref HEAD', {
                cwd: sdkDir,
                encoding: 'utf-8'
              }).trim();
              if (head && head !== 'HEAD') options.branch = head;
            } catch {
              // not a git checkout; leave branch unset
            }
          }
        } else {
          const ref = spec!.ref ?? sdkConfig.defaultRef ?? 'main';
          sdkDir = await ensureCheckout(
            { name: sdkConfig.repo ?? spec!.name, ref },
            options.cacheDir
          );
          options.branch = ref;
        }
        if (!options.repo) {
          options.repo = `modelcontextprotocol/${sdkConfig.repo ?? sdkName}`;
        }
      }
      if (!options.repo) {
        console.error(
          '--repo is required (or pass --sdk to derive it from the SDK config).'
        );
        process.exit(1);
      }

      const { owner, repo } = parseRepo(options.repo);
      let token = options.token || process.env.GITHUB_TOKEN;

      const specVersion = options.specVersion
        ? resolveSpecVersion(options.specVersion)
        : undefined;

      let requirements: RequirementSet[] | undefined;
      if (options.requirements !== undefined) {
        if (specVersion) {
          console.error(
            '--requirements cannot be combined with --spec-version: a requirement set already fixes which scenarios run.'
          );
          process.exit(1);
        }
        try {
          // Several revisions may be claimed at once. Tier 1 then means every
          // one of them passes, because a scenario shared by two revisions has
          // to work on both wires, and one run does not cover the other.
          // Dedupe: '2026-07-28,2026-07-28' must not run and count twice.
          requirements = [
            ...new Set(
              String(options.requirements)
                .split(',')
                .map((r) => r.trim())
                .filter(Boolean)
            )
          ].map(loadRequirements);
          if (requirements.length === 0) {
            throw new Error('--requirements needs at least one revision');
          }
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
          process.exit(1);
        }
      } else if (sdkMode) {
        // Tiering means every shipped revision: a scenario shared by two
        // revisions must pass on both wires, so default to all of them.
        const revisions = listRequirementRevisions();
        console.error(
          `No --requirements given; assessing every shipped revision: ${revisions.join(', ')}`
        );
        requirements = revisions.map(loadRequirements);
      }

      if (!token) {
        // Try to get token from GitHub CLI
        try {
          const { execSync } = await import('child_process');
          token = execSync('gh auth token', { encoding: 'utf-8' }).trim();
        } catch {
          // gh not installed or not authenticated
        }
      }

      if (!token) {
        console.error(
          'GitHub token required. Either:\n' +
            '  gh auth login\n' +
            '  export GITHUB_TOKEN=$(gh auth token)\n' +
            '  or pass --token <token>'
        );
        process.exit(1);
      }

      const octokit = new Octokit({ auth: token });
      const days = options.days ? parseInt(options.days, 10) : undefined;
      const timeoutMs = options.timeout
        ? parseInt(options.timeout, 10)
        : undefined;

      console.error('Running tier assessment checks...\n');

      // Conformance strategy. SDK mode resolves the invocation per revision
      // from the SDK's config and manages the server itself; URL mode drives an
      // already-running server that must serve every claimed revision.
      let serverConformancePromise: Promise<ConformanceResult>;
      let clientConformancePromise: Promise<ConformanceResult>;
      if (sdkMode) {
        const sdkRun = runSdkConformance(sdkDir!, sdkConfig!, requirements!, {
          skipBuild: options.skipBuild,
          timeoutMs
        });
        serverConformancePromise = sdkRun.then((r) => r.server);
        clientConformancePromise = sdkRun.then((r) => r.client);
      } else if (requirements) {
        const reqs = requirements;
        serverConformancePromise = Promise.all(
          reqs.map((req) =>
            checkConformance({
              serverUrl: options.conformanceServerUrl,
              skip: options.skipConformance,
              requirements: req
            }).then((result) => ({ revision: req.revision, result }))
          )
        ).then(mergeByRevision);
        clientConformancePromise = Promise.all(
          reqs.map((req) =>
            checkClientConformance({
              clientCmd: options.clientCmd,
              skip: options.skipConformance || !options.clientCmd,
              requirements: req,
              timeoutMs
            }).then((result) => ({ revision: req.revision, result }))
          )
        ).then(mergeByRevision);
      } else {
        serverConformancePromise = checkConformance({
          serverUrl: options.conformanceServerUrl,
          skip: options.skipConformance,
          specVersion
        });
        clientConformancePromise = checkClientConformance({
          clientCmd: options.clientCmd,
          skip: options.skipConformance || !options.clientCmd,
          specVersion,
          timeoutMs
        });
      }

      // Conformance first, to completion, so a failing GitHub API call can
      // never interrupt a leg mid-run and orphan a managed server. The GitHub
      // checks are seconds; nothing meaningful is lost by not overlapping.
      let conformance: ConformanceResult;
      let clientConformance: ConformanceResult;
      try {
        conformance = await serverConformancePromise;
        console.error('  \u2713 Server Conformance');
        clientConformance = await clientConformancePromise;
        console.error('  \u2713 Client Conformance');
      } catch (error) {
        console.error(
          `Conformance run failed: ${error instanceof Error ? error.message : String(error)}`
        );
        process.exit(1);
      }

      let labels, triage, p0, release, files, specTracking;
      try {
        [labels, triage, p0, release, files, specTracking] = await Promise.all([
          checkLabels(octokit, owner, repo).then((r) => {
            console.error('  ✓ Labels');
            return r;
          }),
          checkTriage(octokit, owner, repo, days).then((r) => {
            console.error('  \u2713 Triage');
            return r;
          }),
          checkP0Resolution(octokit, owner, repo).then((r) => {
            console.error('  \u2713 P0 Resolution');
            return r;
          }),
          checkStableRelease(octokit, owner, repo).then((r) => {
            console.error('  \u2713 Stable Release');
            return r;
          }),
          checkPolicySignals(octokit, owner, repo, options.branch).then((r) => {
            console.error('  \u2713 Policy Signals');
            return r;
          }),
          checkSpecTracking(octokit, owner, repo).then((r) => {
            console.error('  \u2713 Spec Tracking');
            return r;
          })
        ]);
      } catch (error) {
        console.error(
          `GitHub API check failed: ${error instanceof Error ? error.message : String(error)}`
        );
        process.exit(1);
      }

      const checks = {
        conformance,
        client_conformance: clientConformance,
        labels,
        triage,
        p0_resolution: p0,
        stable_release: release,
        policy_signals: files,
        spec_tracking: specTracking
      };

      const implied_tier = computeTier(checks);

      const scorecard: TierScorecard = {
        repo: options.repo,
        branch: options.branch || null,
        timestamp: new Date().toISOString(),
        version: release.version,
        requirements_revisions: requirements?.map((r) => r.revision) ?? null,
        checks,
        implied_tier
      };

      switch (options.output) {
        case 'json':
          console.log(formatJson(scorecard));
          break;
        case 'markdown':
          console.log(formatMarkdown(scorecard));
          break;
        default:
          formatTerminal(scorecard);
      }

      // Exit code gates on the machine-checkable half — scored conformance
      // failures, or a leg that could not be measured — but only under
      // --requirements, where "failed" is measured against a frozen contract.
      // Legacy mode scores against today's suite, which drifts: gating there
      // would flip existing pipelines red the day a post-release scenario
      // merges, the exact injustice the frozen sets exist to remove. Legacy
      // stays report-only (exit 0), as it always was.
      if (requirements) {
        const conformanceBroken = [conformance, clientConformance].some(
          (c) => c.error !== undefined || c.failed > 0
        );
        process.exitCode = conformanceBroken ? 1 : 0;
      }
    });

  // Subcommands for individual checks
  tierCheck
    .command('labels')
    .description('Check label taxonomy')
    .requiredOption('--repo <owner/repo>', 'GitHub repository')
    .option('--token <token>', 'GitHub token')
    .action(async (options) => {
      const { owner, repo } = parseRepo(options.repo);
      const octokit = new Octokit({
        auth: options.token || process.env.GITHUB_TOKEN
      });
      const result = await checkLabels(octokit, owner, repo);
      console.log(JSON.stringify(result, null, 2));
    });

  tierCheck
    .command('triage')
    .description('Check issue triage speed')
    .requiredOption('--repo <owner/repo>', 'GitHub repository')
    .option('--days <n>', 'Limit triage check to issues created in last N days')
    .option('--token <token>', 'GitHub token')
    .action(async (options) => {
      const { owner, repo } = parseRepo(options.repo);
      const octokit = new Octokit({
        auth: options.token || process.env.GITHUB_TOKEN
      });
      const result = await checkTriage(
        octokit,
        owner,
        repo,
        options.days ? parseInt(options.days, 10) : undefined
      );
      console.log(JSON.stringify(result, null, 2));
    });

  return tierCheck;
}
