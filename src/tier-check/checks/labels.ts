import { Octokit } from '@octokit/rest';
import { LabelsResult } from '../types';

// Type labels can be satisfied by GitHub's native issue types (Bug, Enhancement, Question)
const TYPE_LABELS = ['bug', 'enhancement', 'question'];

const STATUS_LABELS = [
  'needs confirmation',
  'needs repro',
  'ready for work',
  'good first issue',
  'help wanted'
];

const PRIORITY_LABELS = ['P0', 'P1', 'P2', 'P3'];

export async function checkLabels(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<LabelsResult> {
  const labels: string[] = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.issues.listLabelsForRepo({
      owner,
      repo,
      per_page: 100,
      page
    });
    labels.push(...data.map((l) => l.name));
    if (data.length < 100) break;
    page++;
  }

  // Check if the repo uses GitHub's native issue types
  // If so, type labels (bug/enhancement/question) are satisfied
  let usesIssueTypes = false;
  try {
    const { data: repoData } = await octokit.request(
      'GET /repos/{owner}/{repo}',
      { owner, repo }
    );
    // Repos with issue types enabled have them configured at the org or repo level.
    // We detect this by checking for the presence of issue type configuration.
    // As a heuristic: if the repo has no type labels but has issues, it likely uses types.
    usesIssueTypes = !!(repoData as Record<string, unknown>).issue_types;
  } catch {
    // If we can't determine, assume labels are needed
  }

  const labelSet = new Set(labels.map((l) => l.toLowerCase()));

  // Build required labels list, excluding type labels if issue types are used
  const requiredLabels = [
    ...(usesIssueTypes ? [] : TYPE_LABELS),
    ...STATUS_LABELS,
    ...PRIORITY_LABELS
  ];

  const missing = requiredLabels.filter((l) => !labelSet.has(l.toLowerCase()));
  const found = requiredLabels.filter((l) => labelSet.has(l.toLowerCase()));

  return {
    status: missing.length === 0 ? 'pass' : 'fail',
    present: found.length,
    required: requiredLabels.length,
    missing,
    found,
    uses_issue_types: usesIssueTypes
  };
}
