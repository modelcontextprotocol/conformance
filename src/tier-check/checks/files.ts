import { Octokit } from '@octokit/rest';
import { PolicySignalsResult } from '../types';

// These files are evidence for policy evaluation, not hard tier requirements.
// Their presence/absence feeds into the overall assessment but does not
// independently block tier advancement.
const POLICY_SIGNAL_FILES = [
  'CHANGELOG.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  '.github/dependabot.yml',
  'ROADMAP.md'
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
