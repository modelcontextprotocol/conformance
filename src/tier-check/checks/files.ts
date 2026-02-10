import { Octokit } from '@octokit/rest';
import { FilesResult } from '../types';

const REQUIRED_FILES = [
  'CHANGELOG.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  '.github/dependabot.yml',
  'ROADMAP.md'
];

export async function checkFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch?: string
): Promise<FilesResult> {
  const files: Record<string, boolean> = {};

  for (const filePath of REQUIRED_FILES) {
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
    status: Object.values(files).every((v) => v) ? 'pass' : 'fail',
    files
  };
}
