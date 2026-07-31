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
import { computeTier } from './tier-logic';
import { formatJson, formatMarkdown, formatTerminal } from './output';
import { TierScorecard } from './types';
import { resolveSpecVersion } from '../scenarios';
import { DRAFT_PROTOCOL_VERSION } from '../types';

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
    .option(
      '--spec-version <version>',
      'Only run conformance scenarios for this spec version'
    )
    .option(
      '--sdk-release-tag <tag>',
      'Exact release tag of the submitted SDK version, resolved with no normalization (pins spec-tracking to that submission)'
    )
    .action(async (options) => {
      const { owner, repo } = parseRepo(options.repo);
      let token = options.token || process.env.GITHUB_TOKEN;

      const specVersion = options.specVersion
        ? resolveSpecVersion(options.specVersion)
        : undefined;

      // The CLI's --spec-version vocabulary is released dated versions plus
      // the 'draft' alias — resolveSpecVersion above already exits the
      // process on anything else. checkSpecTracking itself accepts any exact
      // release tag (including pre-releases like an RC), which is exercised
      // directly in its unit tests; pinning one of those from this CLI would
      // need a wider --spec-version vocabulary, deliberately out of scope
      // here. The draft spec version has no GitHub release to pin against,
      // so draft runs fall back to tracking the latest stable spec release
      // instead — during the graduation window, the latest stable release
      // IS the version that was just the draft, so the fallback lands on
      // the right release anyway.
      const specVersionForTracking =
        specVersion === DRAFT_PROTOCOL_VERSION ? undefined : specVersion;

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
          skip: options.skipConformance,
          specVersion
        }).then((r) => {
          console.error('  ✓ Server Conformance');
          return r;
        }),
        checkClientConformance({
          clientCmd: options.clientCmd,
          skip: options.skipConformance || !options.clientCmd,
          specVersion
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
        checkSpecTracking(octokit, owner, repo, {
          sdkReleaseTag: options.sdkReleaseTag,
          specVersion: specVersionForTracking
        }).then((r) => {
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
