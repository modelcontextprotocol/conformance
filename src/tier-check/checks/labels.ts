import { Octokit } from '@octokit/rest';
import { LabelsResult } from '../types';

const REQUIRED_LABELS = [
  'bug',
  'enhancement',
  'question',
  'needs confirmation',
  'needs repro',
  'ready for work',
  'good first issue',
  'help wanted',
  'P0',
  'P1',
  'P2',
  'P3'
];

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

  const labelSet = new Set(labels.map((l) => l.toLowerCase()));
  const missing = REQUIRED_LABELS.filter((l) => !labelSet.has(l.toLowerCase()));
  const found = REQUIRED_LABELS.filter((l) => labelSet.has(l.toLowerCase()));

  return {
    status: missing.length === 0 ? 'pass' : 'fail',
    present: found.length,
    required: REQUIRED_LABELS.length,
    missing,
    found
  };
}
