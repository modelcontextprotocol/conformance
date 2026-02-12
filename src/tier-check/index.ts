import { Command } from 'commander';
import { Octokit } from '@octokit/rest';
import { checkConformance, checkClientConformance } from './checks/conformance';
import { checkLabels } from './checks/labels';
import { checkTriage } from './checks/triage';
import { checkP0Resolution } from './checks/p0';
import { checkStableRelease } from './checks/release';
import { checkPolicySignals } from './checks/files';
import { checkSpecTracking } from './checks/spec-tracking';
import { computeTier } from './tier-logic';
import { formatJson, formatMarkdown, formatTerminal } from './output';
import { TierScorecard } from './types';

function parseRepo(repo: string): { owner: string; repo: string } {
  const parts = repo.split('/');
  if (parts.length !== 2)
    throw new Error(`Invalid repo format: ${repo}. Expected owner/repo`);
  return { owner: parts[0], repo: parts[1] };
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
    .action(async (options) => {
      const { owner, repo } = parseRepo(options.repo);
      let token = options.token || process.env.GITHUB_TOKEN;

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

      // Run all checks
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
        checkConformance({
          serverUrl: options.conformanceServerUrl,
          skip: options.skipConformance
        }).then((r) => {
          console.error('  ✓ Server Conformance');
          return r;
        }),
        checkClientConformance({
          clientCmd: options.clientCmd,
          skip: options.skipConformance || !options.clientCmd
        }).then((r) => {
          console.error('  ✓ Client Conformance');
          return r;
        }),
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
