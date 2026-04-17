import { Command } from 'commander';
import { Octokit } from '@octokit/rest';
import {
  checkConformance,
  checkClientConformance
} from './checks/test-conformance-results';
import { checkLabels } from './checks/labels';
import { checkTriage } from './checks/triage';
import { checkP0Resolution } from './checks/p0';
import { checkStableRelease } from './checks/release';
import { checkPolicySignals } from './checks/files';
import { checkSpecTracking } from './checks/spec-tracking';
import { skippedConformance } from './checks/skipped';
import { computeTier } from './tier-logic';
import { formatJson, formatMarkdown, formatTerminal } from './output';
import { TierScorecard } from './types';
import { resolveSpecVersion } from '../scenarios';

function parseRepo(repo: string): { owner: string; repo: string } {
  const parts = repo.split('/');
  if (parts.length !== 2)
    throw new Error(`Invalid repo format: ${repo}. Expected owner/repo`);
  return { owner: parts[0], repo: parts[1] };
}

export function resolveTierCheckPlan(options: {
  skipConformance?: boolean;
  conformanceServerUrl?: string;
  clientCmd?: string;
}) {
  const skipConformance = !!options.skipConformance;
  const runServer = !skipConformance && !!options.conformanceServerUrl;
  const runClient = !skipConformance && !!options.clientCmd;

  return {
    runServer,
    runClient,
    skipRepoHealth: false,
    nothingToRun: false,
    serverSkipReason: runServer
      ? null
      : skipConformance
        ? 'excluded by --skip-conformance'
        : 'no --conformance-server-url',
    clientSkipReason: runClient
      ? null
      : skipConformance
        ? 'excluded by --skip-conformance'
        : 'no --client-cmd'
  };
}

export function createTierCheckCommand(): Command {
  const tierCheck = new Command('tier-check')
    .description('Run SDK tier assessment checks against a GitHub repository')
    .requiredOption(
      '--repo <owner/repo>',
      'GitHub repository (e.g., modelcontextprotocol/typescript-sdk)'
    )
    .option('--branch <branch>', 'Branch to check')
    .option(
      '--conformance-server-url <url>',
      'URL of the already-running conformance server'
    )
    .option(
      '--client-cmd <cmd>',
      'Command to run the SDK conformance client (for client conformance tests)'
    )
    .option('--skip-conformance', 'Skip conformance tests (server and client)')
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
    .action(async (options) => {
      const { owner, repo } = parseRepo(options.repo);

      const runPlan = resolveTierCheckPlan(options);
      const { runServer, runClient } = runPlan;

      let token = options.token || process.env.GITHUB_TOKEN;

      const specVersion = options.specVersion
        ? resolveSpecVersion(options.specVersion)
        : undefined;

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

      console.error('Running tier assessment checks...\n');

      const note = (label: string, didRun: boolean, reason?: string | null) =>
        `  ${didRun ? '\u2713' : '\u25cb'} ${label}${didRun ? '' : ` (skipped${reason ? `: ${reason}` : ''})`}`;

      // Run all non-skipped checks in parallel. Skipped checks resolve to
      // a canned {status: 'skipped'} payload so downstream formatting and
      // the tier scorecard schema remain stable.
      const [
        conformance,
        clientConformance,
        labels,
        triage,
        p0,
        release,
        files,
        specTracking
      ] = await Promise.all([
        runServer
          ? checkConformance({
              serverUrl: options.conformanceServerUrl,
              skip: false,
              specVersion
            }).then((r) => {
              console.error(note('Server Conformance', true));
              return r;
            })
          : Promise.resolve(skippedConformance()).then((r) => {
              console.error(
                note('Server Conformance', false, runPlan.serverSkipReason)
              );
              return r;
            }),
        runClient
          ? checkClientConformance({
              clientCmd: options.clientCmd,
              skip: false,
              specVersion
            }).then((r) => {
              console.error(note('Client Conformance', true));
              return r;
            })
          : Promise.resolve(skippedConformance()).then((r) => {
              console.error(
                note('Client Conformance', false, runPlan.clientSkipReason)
              );
              return r;
            }),
        checkLabels(octokit, owner, repo).then((r) => {
          console.error(note('Labels', true));
          return r;
        }),
        checkTriage(octokit, owner, repo, days).then((r) => {
          console.error(note('Triage', true));
          return r;
        }),
        checkP0Resolution(octokit, owner, repo).then((r) => {
          console.error(note('P0 Resolution', true));
          return r;
        }),
        checkStableRelease(octokit, owner, repo).then((r) => {
          console.error(note('Stable Release', true));
          return r;
        }),
        checkPolicySignals(octokit, owner, repo, options.branch).then((r) => {
          console.error(note('Policy Signals', true));
          return r;
        }),
        checkSpecTracking(octokit, owner, repo).then((r) => {
          console.error(note('Spec Tracking', true));
          return r;
        })
      ]);

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
      const partialRun = Object.values(checks).some(
        (check) => check.status === 'skipped'
      );

      const implied_tier = computeTier(checks);

      const scorecard: TierScorecard = {
        repo: options.repo,
        branch: options.branch || null,
        timestamp: new Date().toISOString(),
        version: release.version,
        partial_run: partialRun,
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
