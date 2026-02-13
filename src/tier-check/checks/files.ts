import { Octokit } from '@octokit/rest';
import { PolicySignalsResult } from '../types';

// Policy files checked deterministically by the CLI.
// The AI policy evaluation then reads ONLY files that exist here
// to judge whether content is substantive — it does not search for
// files in other locations.
const POLICY_SIGNAL_FILES = [
  // General project health
  'CHANGELOG.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  // Dependency update policy
  'DEPENDENCY_POLICY.md',
  'docs/dependency-policy.md',
  '.github/dependabot.yml',
  '.github/renovate.json',
  'renovate.json',
  // Roadmap
  'ROADMAP.md',
  'docs/roadmap.md',
  // Versioning / breaking change policy
  'VERSIONING.md',
  'docs/versioning.md',
  'BREAKING_CHANGES.md'
];

export async function checkPolicySignals(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch?: string
): Promise<PolicySignalsResult> {
  const files: Record<string, boolean> = {};

  for (const filePath of POLICY_SIGNAL_FILES) {
    try {
      await octokit.repos.getContent({
        owner,
        repo,
        path: filePath,
        ...(branch ? { ref: branch } : {})
      });
      files[filePath] = true;
    } catch {
      files[filePath] = false;
    }
  }

  return {
    status: Object.values(files).every((v) => v)
      ? 'pass'
      : Object.values(files).some((v) => v)
        ? 'partial'
        : 'fail',
    files
  };
}
