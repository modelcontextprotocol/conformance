import { Octokit } from '@octokit/rest';
import { P0Result } from '../types';

export async function checkP0Resolution(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<P0Result> {
  // Fetch all issues with P0 label
  const p0Issues: Array<{
    number: number;
    title: string;
    state: string;
    created_at: string;
    closed_at: string | null;
    labels: Array<{ name: string }>;
  }> = [];

  let page = 1;
  while (true) {
    const { data } = await octokit.issues.listForRepo({
      owner,
      repo,
      labels: 'P0',
      state: 'all',
      per_page: 100,
      page
    });
    for (const issue of data) {
      if (issue.pull_request) continue;
      p0Issues.push({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        created_at: issue.created_at,
        closed_at: issue.closed_at ?? null,
        labels: issue.labels.filter(
          (l): l is { name: string } =>
            typeof l === 'object' && l !== null && 'name' in l
        )
      });
    }
    if (data.length < 100) break;
    page++;
  }

  const openP0s = p0Issues.filter((i) => i.state === 'open');
  const closedP0s = p0Issues.filter(
    (i) => i.state === 'closed' && i.closed_at
  );

  let closedWithin7d = 0;
  let closedWithin14d = 0;

  for (const issue of closedP0s) {
    const daysToClose =
      (new Date(issue.closed_at!).getTime() -
        new Date(issue.created_at).getTime()) /
      (1000 * 60 * 60 * 24);
    if (daysToClose <= 7) closedWithin7d++;
    if (daysToClose <= 14) closedWithin14d++;
  }

  const openP0Details = openP0s.map((i) => ({
    number: i.number,
    title: i.title,
    age_days: Math.round(
      (Date.now() - new Date(i.created_at).getTime()) / (1000 * 60 * 60 * 24)
    )
  }));

  const allResolved7d =
    openP0s.length === 0 &&
    (closedP0s.length === 0 || closedWithin7d === closedP0s.length);
  const allResolved14d =
    openP0s.length === 0 &&
    (closedP0s.length === 0 || closedWithin14d === closedP0s.length);

  return {
    status: allResolved7d ? 'pass' : allResolved14d ? 'partial' : 'fail',
    open_p0s: openP0s.length,
    open_p0_details: openP0Details,
    closed_within_7d: closedWithin7d,
    closed_within_14d: closedWithin14d,
    closed_total: closedP0s.length,
    all_p0s_resolved_within_7d: allResolved7d,
    all_p0s_resolved_within_14d: allResolved14d
  };
}
