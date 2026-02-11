import { TierScorecard, CheckStatus } from './types';

const COLORS = {
  RESET: '\x1b[0m',
  GREEN: '\x1b[32m',
  YELLOW: '\x1b[33m',
  RED: '\x1b[31m',
  BLUE: '\x1b[36m',
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m'
};

function statusIcon(status: CheckStatus): string {
  switch (status) {
    case 'pass':
      return `${COLORS.GREEN}\u2713${COLORS.RESET}`;
    case 'fail':
      return `${COLORS.RED}\u2717${COLORS.RESET}`;
    case 'partial':
      return `${COLORS.YELLOW}~${COLORS.RESET}`;
    case 'skipped':
      return `${COLORS.DIM}-${COLORS.RESET}`;
  }
}

export function formatJson(scorecard: TierScorecard): string {
  return JSON.stringify(scorecard, null, 2);
}

export function formatMarkdown(scorecard: TierScorecard): string {
  const lines: string[] = [];
  const c = scorecard.checks;

  lines.push(`# Tier Assessment: Tier ${scorecard.implied_tier.tier}`);
  lines.push('');
  lines.push(`**Repo**: ${scorecard.repo}`);
  if (scorecard.branch) lines.push(`**Branch**: ${scorecard.branch}`);
  if (scorecard.version) lines.push(`**Version**: ${scorecard.version}`);
  lines.push(`**Timestamp**: ${scorecard.timestamp}`);
  lines.push('');
  lines.push('## Check Results');
  lines.push('');
  lines.push('| Check | Status | Detail |');
  lines.push('|-------|--------|--------|');
  lines.push(
    `| Server Conformance | ${c.conformance.status} | ${c.conformance.passed}/${c.conformance.total} scenarios pass (${Math.round(c.conformance.pass_rate * 100)}%) |`
  );
  lines.push(
    `| Client Conformance | ${c.client_conformance.status} | ${c.client_conformance.passed}/${c.client_conformance.total} scenarios pass (${Math.round(c.client_conformance.pass_rate * 100)}%) |`
  );
  lines.push(
    `| Labels | ${c.labels.status} | ${c.labels.present}/${c.labels.required} required labels${c.labels.missing.length > 0 ? ` (missing: ${c.labels.missing.join(', ')})` : ''} |`
  );
  lines.push(
    `| Triage | ${c.triage.status} | ${Math.round(c.triage.compliance_rate * 100)}% within 2BD, median ${c.triage.median_hours}h, p95 ${c.triage.p95_hours}h |`
  );
  lines.push(
    `| P0 Resolution | ${c.p0_resolution.status} | ${c.p0_resolution.open_p0s} open, ${c.p0_resolution.closed_within_7d}/${c.p0_resolution.closed_total} closed within 7d |`
  );
  lines.push(
    `| Stable Release | ${c.stable_release.status} | ${c.stable_release.version || 'none'} (stable: ${c.stable_release.is_stable}) |`
  );
  lines.push(
    `| Policy Signals | ${c.policy_signals.status} | ${Object.entries(
      c.policy_signals.files
    )
      .map(([f, e]) => `${f}: ${e ? '\u2713' : '\u2717'}`)
      .join(', ')} |`
  );
  lines.push(
    `| Spec Tracking | ${c.spec_tracking.status} | ${c.spec_tracking.days_gap !== null ? `${c.spec_tracking.days_gap}d gap` : 'N/A'} |`
  );
  lines.push('');

  if (scorecard.implied_tier.tier1_blockers.length > 0) {
    lines.push('## Tier 1 Blockers');
    lines.push('');
    for (const blocker of scorecard.implied_tier.tier1_blockers) {
      lines.push(`- ${blocker}`);
    }
    lines.push('');
  }

  lines.push(`> ${scorecard.implied_tier.note}`);

  return lines.join('\n');
}

export function formatTerminal(scorecard: TierScorecard): void {
  const c = scorecard.checks;
  const tier = scorecard.implied_tier.tier;
  const tierColor =
    tier === 1 ? COLORS.GREEN : tier === 2 ? COLORS.YELLOW : COLORS.RED;

  console.log(
    `\n${COLORS.BOLD}Tier Assessment: ${tierColor}Tier ${tier}${COLORS.RESET}\n`
  );
  console.log(`Repo:      ${scorecard.repo}`);
  if (scorecard.branch) console.log(`Branch:    ${scorecard.branch}`);
  if (scorecard.version) console.log(`Version:   ${scorecard.version}`);
  console.log(`Timestamp: ${scorecard.timestamp}\n`);

  console.log(`${COLORS.BOLD}Check Results:${COLORS.RESET}\n`);

  console.log(
    `  ${statusIcon(c.conformance.status)} Server Conformance  ${c.conformance.passed}/${c.conformance.total} (${Math.round(c.conformance.pass_rate * 100)}%)`
  );
  console.log(
    `  ${statusIcon(c.client_conformance.status)} Client Conformance  ${c.client_conformance.passed}/${c.client_conformance.total} (${Math.round(c.client_conformance.pass_rate * 100)}%)`
  );
  console.log(
    `  ${statusIcon(c.labels.status)} Labels         ${c.labels.present}/${c.labels.required} required labels`
  );
  if (c.labels.missing.length > 0)
    console.log(
      `    ${COLORS.DIM}Missing: ${c.labels.missing.join(', ')}${COLORS.RESET}`
    );
  console.log(
    `  ${statusIcon(c.triage.status)} Triage         ${Math.round(c.triage.compliance_rate * 100)}% within 2BD (${c.triage.total_issues} issues, median ${c.triage.median_hours}h)`
  );
  console.log(
    `  ${statusIcon(c.p0_resolution.status)} P0 Resolution  ${c.p0_resolution.open_p0s} open, ${c.p0_resolution.closed_within_7d}/${c.p0_resolution.closed_total} closed within 7d`
  );
  if (c.p0_resolution.open_p0_details.length > 0) {
    for (const p0 of c.p0_resolution.open_p0_details) {
      console.log(
        `    ${COLORS.RED}#${p0.number} (${p0.age_days}d old): ${p0.title}${COLORS.RESET}`
      );
    }
  }
  console.log(
    `  ${statusIcon(c.stable_release.status)} Stable Release ${c.stable_release.version || 'none'}`
  );
  console.log(
    `  ${statusIcon(c.policy_signals.status)} Policy Signals ${Object.entries(
      c.policy_signals.files
    )
      .map(([f, e]) => `${e ? '\u2713' : '\u2717'} ${f}`)
      .join(', ')}`
  );
  console.log(
    `  ${statusIcon(c.spec_tracking.status)} Spec Tracking  ${c.spec_tracking.days_gap !== null ? `${c.spec_tracking.days_gap}d gap` : 'N/A'}`
  );

  if (scorecard.implied_tier.tier1_blockers.length > 0) {
    console.log(`\n${COLORS.BOLD}Tier 1 Blockers:${COLORS.RESET}`);
    for (const blocker of scorecard.implied_tier.tier1_blockers) {
      console.log(`  ${COLORS.RED}\u2022${COLORS.RESET} ${blocker}`);
    }
  }

  console.log(`\n${COLORS.DIM}${scorecard.implied_tier.note}${COLORS.RESET}\n`);
}
