import { TierScorecard, CheckStatus, ConformanceResult } from './types';

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

const SPEC_VERSIONS = [
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
  'draft',
  'extension'
] as const;

type Cell = { passed: number; total: number };

interface MatrixRow {
  cells: Map<string, Cell>;
  unique: Cell;
}

function newRow(): MatrixRow {
  return { cells: new Map(), unique: { passed: 0, total: 0 } };
}

interface ConformanceMatrix {
  server: MatrixRow;
  clientCore: MatrixRow;
  clientAuth: MatrixRow;
}

function buildConformanceMatrix(
  server: ConformanceResult,
  client: ConformanceResult
): ConformanceMatrix {
  const matrix: ConformanceMatrix = {
    server: newRow(),
    clientCore: newRow(),
    clientAuth: newRow()
  };

  for (const d of server.details) {
    matrix.server.unique.total++;
    if (d.passed) matrix.server.unique.passed++;
    for (const v of d.specVersions ?? ['unknown']) {
      const cell = matrix.server.cells.get(v) ?? { passed: 0, total: 0 };
      cell.total++;
      if (d.passed) cell.passed++;
      matrix.server.cells.set(v, cell);
    }
  }

  for (const d of client.details) {
    const row = d.scenario.startsWith('auth/')
      ? matrix.clientAuth
      : matrix.clientCore;
    row.unique.total++;
    if (d.passed) row.unique.passed++;
    for (const v of d.specVersions ?? ['unknown']) {
      const cell = row.cells.get(v) ?? { passed: 0, total: 0 };
      cell.total++;
      if (d.passed) cell.passed++;
      row.cells.set(v, cell);
    }
  }

  return matrix;
}

function formatCell(cell: Cell | undefined): string {
  if (!cell || cell.total === 0) return '\u2014';
  return `${cell.passed}/${cell.total}`;
}

function formatRate(cell: Cell): string {
  if (cell.total === 0) return '0/0';
  return `${cell.passed}/${cell.total} (${Math.round((cell.passed / cell.total) * 100)}%)`;
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
  // Conformance matrix
  const matrix = buildConformanceMatrix(
    c.conformance as ConformanceResult,
    c.client_conformance as ConformanceResult
  );

  lines.push('');
  lines.push(`| | ${SPEC_VERSIONS.join(' | ')} | All* |`);
  lines.push(`|---|${SPEC_VERSIONS.map(() => '---|').join('')}---|`);

  const mdRows: [string, MatrixRow][] = [
    ['Server', matrix.server],
    ['Client: Core', matrix.clientCore],
    ['Client: Auth', matrix.clientAuth]
  ];

  for (const [label, row] of mdRows) {
    lines.push(
      `| ${label} | ${SPEC_VERSIONS.map((v) => formatCell(row.cells.get(v))).join(' | ')} | ${formatRate(row.unique)} |`
    );
  }

  lines.push('');
  lines.push(
    '_* unique scenarios — a scenario may apply to multiple spec versions_'
  );
  lines.push('');
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

  console.log(`${COLORS.BOLD}Conformance:${COLORS.RESET}\n`);

  // Conformance matrix
  const matrix = buildConformanceMatrix(
    c.conformance as ConformanceResult,
    c.client_conformance as ConformanceResult
  );

  const vw = 10; // column width for version cells
  const lw = 14; // label column width
  const tw = 16; // total column width
  const rp = (s: string, w: number) => s.padStart(w);
  const lp = (s: string, w: number) => s.padEnd(w);

  console.log(
    `  ${COLORS.DIM}${lp('', lw + 2)} ${SPEC_VERSIONS.map((v) => rp(v, vw)).join(' ')}  ${rp('All*', tw)}${COLORS.RESET}`
  );

  const rows: [string, MatrixRow, CheckStatus | null, boolean][] = [
    ['Server', matrix.server, c.conformance.status, true],
    ['Client: Core', matrix.clientCore, null, false],
    ['Client: Auth', matrix.clientAuth, null, false]
  ];

  for (const [label, row, status, bold] of rows) {
    const icon = status ? statusIcon(status) + ' ' : '  ';
    const b = bold ? COLORS.BOLD : '';
    const r = bold ? COLORS.RESET : '';
    console.log(
      `  ${icon}${b}${lp(label, lw)}${r} ${SPEC_VERSIONS.map((v) => rp(formatCell(row.cells.get(v)), vw)).join(' ')}  ${b}${rp(formatRate(row.unique), tw)}${r}`
    );
  }

  // Client total line
  const clientTotal: Cell = {
    passed: matrix.clientCore.unique.passed + matrix.clientAuth.unique.passed,
    total: matrix.clientCore.unique.total + matrix.clientAuth.unique.total
  };
  console.log(
    `  ${statusIcon(c.client_conformance.status)} ${COLORS.BOLD}${lp('Client Total', lw)}${COLORS.RESET} ${' '.repeat(SPEC_VERSIONS.length * (vw + 1) - 1)}  ${COLORS.BOLD}${rp(formatRate(clientTotal), tw)}${COLORS.RESET}`
  );
  console.log(
    `\n  ${COLORS.DIM}* unique scenarios — a scenario may apply to multiple spec versions${COLORS.RESET}`
  );
  console.log(`\n${COLORS.BOLD}Repository Health:${COLORS.RESET}\n`);
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
