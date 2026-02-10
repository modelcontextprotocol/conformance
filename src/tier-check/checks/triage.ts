import { Octokit } from '@octokit/rest';
import { TriageResult } from '../types';

export async function checkTriage(
  octokit: Octokit,
  owner: string,
  repo: string,
  days?: number
): Promise<TriageResult> {
  const since = days
    ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
    : undefined;

  // Fetch issues (not PRs) — the API returns labels inline
  const issues: Array<{
    number: number;
    created_at: string;
    labels: string[];
  }> = [];

  let page = 1;
  while (true) {
    const { data } = await octokit.issues.listForRepo({
      owner,
      repo,
      state: 'open',
      ...(since ? { since } : {}),
      per_page: 100,
      page,
      sort: 'created',
      direction: 'desc'
    });
    if (data.length === 0) break;
    for (const issue of data) {
      if (issue.pull_request) continue;
      if (since && new Date(issue.created_at) < new Date(since)) continue;
      issues.push({
        number: issue.number,
        created_at: issue.created_at,
        labels: issue.labels
          .filter(
            (l): l is { name: string } =>
              typeof l === 'object' && l !== null && 'name' in l
          )
          .map((l) => l.name)
      });
    }
    if (data.length < 100) break;
    page++;
  }

  if (issues.length === 0) {
    return {
      status: 'pass',
      compliance_rate: 1,
      total_issues: 0,
      triaged_within_sla: 0,
      exceeding_sla: 0,
      median_hours: 0,
      p95_hours: 0,
      days_analyzed: days
    };
  }

  // An issue is "triaged" if it has at least one label
  const triaged = issues.filter((i) => i.labels.length > 0);
  const untriaged = issues.filter((i) => i.labels.length === 0);

  // For untriaged issues, compute how long they've been open without a label
  const untriagedAgeHours = untriaged.map(
    (i) =>
      (Date.now() - new Date(i.created_at).getTime()) / (1000 * 60 * 60)
  );
  untriagedAgeHours.sort((a, b) => a - b);

  const total = issues.length;
  const triagedRate = total > 0 ? triaged.length / total : 1;

  // For SLA: issues without labels that are older than 2BD are SLA violations
  const TWO_BUSINESS_DAYS_HOURS = 2 * 24;
  const exceeding = untriagedAgeHours.filter(
    (h) => h > TWO_BUSINESS_DAYS_HOURS
  ).length;

  // Median/p95 of untriaged issue ages (0 if all triaged)
  const median =
    untriagedAgeHours.length > 0
      ? untriagedAgeHours[Math.floor(untriagedAgeHours.length / 2)]
      : 0;
  const p95 =
    untriagedAgeHours.length > 0
      ? untriagedAgeHours[Math.floor(untriagedAgeHours.length * 0.95)]
      : 0;

  let status: 'pass' | 'partial' | 'fail';
  if (triagedRate >= 0.9) status = 'pass';
  else if (triagedRate >= 0.8) status = 'partial';
  else status = 'fail';

  return {
    status,
    compliance_rate: triagedRate,
    total_issues: total,
    triaged_within_sla: triaged.length,
    exceeding_sla: exceeding,
    median_hours: Math.round(median * 10) / 10,
    p95_hours: Math.round(p95 * 10) / 10,
    days_analyzed: days
  };
}
