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
      return `${COLORS.DIM}\u25cb${COLORS.RESET}`;
  }
}

const TIER_SPEC_VERSIONS = ['2025-03-26', '2025-06-18', '2025-11-25'] as const;

const INFO_SPEC_VERSIONS = ['draft', 'extension'] as const;

type Cell = { passed: number; total: number };

interface MatrixRow {
  cells: Map<string, Cell>;
  /** Unique scenario counts for tier-scoring versions only. */
  tierUnique: Cell;
  /** Unique scenario counts for informational versions only. */
  infoUnique: Cell;
}

const INFO_SET = new Set<string>(INFO_SPEC_VERSIONS);

function newRow(): MatrixRow {
  return {
    cells: new Map(),
    tierUnique: { passed: 0, total: 0 },
    infoUnique: { passed: 0, total: 0 }
  };
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

  function addToRow(
    row: MatrixRow,
    d: { passed: boolean; specVersions?: string[] }
  ) {
    const versions = d.specVersions ?? ['unknown'];
    const isTierScoring = versions.some((v) => !INFO_SET.has(v));
    const bucket = isTierScoring ? row.tierUnique : row.infoUnique;
    bucket.total++;
    if (d.passed) bucket.passed++;
    for (const v of versions) {
      const cell = row.cells.get(v) ?? { passed: 0, total: 0 };
      cell.total++;
      if (d.passed) cell.passed++;
      row.cells.set(v, cell);
    }
  }

  for (const d of server.details) {
    addToRow(matrix.server, d);
  }

  for (const d of client.details) {
    const row = d.scenario.startsWith('auth/')
      ? matrix.clientAuth
      : matrix.clientCore;
    addToRow(row, d);
  }

  return matrix;
}

function formatCell(cell: Cell | undefined): string {
  if (!cell || cell.total === 0) return '\u2014';
  return `${cell.passed}/${cell.total}`;
}

function formatConformanceCell(
  cell: Cell | undefined,
  status: CheckStatus | null
): string {
  return status === 'skipped' ? '\u25cb' : formatCell(cell);
}

function formatRate(cell: Cell): string {
  if (cell.total === 0) return '0/0';
  return `${cell.passed}/${cell.total} (${Math.round((cell.passed / cell.total) * 100)}%)`;
}

function formatConformanceTotal(
  cell: Cell,
  status: CheckStatus | null,
  verbose = false
): string {
  if (status === 'skipped') return verbose ? '\u25cb skipped' : '\u25cb';
  return formatRate(cell);
}

export function formatJson(scorecard: TierScorecard): string {
  return JSON.stringify(scorecard, null, 2);
}

export function formatMarkdown(scorecard: TierScorecard): string {
  const lines: string[] = [];
  const c = scorecard.checks;

  const tierLabel = scorecard.partial_run
    ? 'N/A (partial run)'
    : `Tier ${scorecard.implied_tier.tier}`;
  lines.push(`# Tier Assessment: ${tierLabel}`);
  lines.push('');
  lines.push(`**Repo**: ${scorecard.repo}`);
  if (scorecard.branch) lines.push(`**Branch**: ${scorecard.branch}`);
  if (scorecard.version) lines.push(`**Version**: ${scorecard.version}`);
  lines.push(`**Timestamp**: ${scorecard.timestamp}`);
  if (scorecard.partial_run) {
    const skipped = Object.entries(c)
      .filter(([, v]) => (v as { status: CheckStatus }).status === 'skipped')
      .map(([k]) => k);
    lines.push(
      `**Scope**: partial run — skipped: ${skipped.join(', ') || '(none)'}`
    );
  }
  lines.push('_Legend: ✓ pass, ✗ fail, ~ partial, ○ skipped_');
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
  const skippedSuites = [
    c.conformance.status === 'skipped' ? 'server' : null,
    c.client_conformance.status === 'skipped' ? 'client' : null
  ].filter((suite): suite is string => suite !== null);

  if (skippedSuites.length > 0) {
    lines.push(
      `> ○ Skipped conformance suites: ${skippedSuites.join(', ')}. Provide the missing inputs to include them in a full assessment.`
    );
    lines.push('');
  }

  // Tier-scoring matrix
  lines.push('');
  lines.push(`| | ${TIER_SPEC_VERSIONS.join(' | ')} | All* |`);
  lines.push(`|---|${TIER_SPEC_VERSIONS.map(() => '---|').join('')}---|`);

  const mdRows: [string, MatrixRow, CheckStatus | null, boolean][] = [
    ['Server', matrix.server, c.conformance.status, true],
    ['Client: Core', matrix.clientCore, c.client_conformance.status, false],
    ['Client: Auth', matrix.clientAuth, c.client_conformance.status, false]
  ];

  for (const [label, row, status, verboseSkipped] of mdRows) {
    lines.push(
      `| ${label} | ${TIER_SPEC_VERSIONS.map((v) => formatConformanceCell(row.cells.get(v), status)).join(' | ')} | ${formatConformanceTotal(row.tierUnique, status, verboseSkipped)} |`
    );
  }

  lines.push('');
  lines.push(
    '_* unique scenarios — a scenario may apply to multiple spec versions_'
  );

  // Informational matrix (draft/extension)
  const hasInfoMd = mdRows.some(([, row]) =>
    INFO_SPEC_VERSIONS.some((v) => {
      const cell = row.cells.get(v);
      return cell && cell.total > 0;
    })
  );
  if (hasInfoMd) {
    lines.push('');
    lines.push('_Informational (not scored for tier):_');
    lines.push('');
    lines.push(`| | ${INFO_SPEC_VERSIONS.join(' | ')} |`);
    lines.push(`|---|${INFO_SPEC_VERSIONS.map(() => '---|').join('')}`);
    for (const [label, row, status] of mdRows) {
      const hasData = INFO_SPEC_VERSIONS.some((v) => {
        const cell = row.cells.get(v);
        return cell && cell.total > 0;
      });
      if (!hasData && status !== 'skipped') continue;
      lines.push(
        `| ${label} | ${INFO_SPEC_VERSIONS.map((v) => formatConformanceCell(row.cells.get(v), status)).join(' | ')} |`
      );
    }
  }
  lines.push('');
  const skippedDetail = '○ skipped';
  lines.push(
    c.labels.status === 'skipped'
      ? `| Labels | ${skippedDetail} | ${skippedDetail} |`
      : `| Labels | ${c.labels.status} | ${c.labels.present}/${c.labels.required} required labels${c.labels.missing.length > 0 ? ` (missing: ${c.labels.missing.join(', ')})` : ''} |`
  );
  lines.push(
    c.triage.status === 'skipped'
      ? `| Triage | ${skippedDetail} | ${skippedDetail} |`
      : `| Triage | ${c.triage.status} | ${Math.round(c.triage.compliance_rate * 100)}% within 2BD, median ${c.triage.median_hours}h, p95 ${c.triage.p95_hours}h |`
  );
  lines.push(
    c.p0_resolution.status === 'skipped'
      ? `| P0 Resolution | ${skippedDetail} | ${skippedDetail} |`
      : `| P0 Resolution | ${c.p0_resolution.status} | ${c.p0_resolution.open_p0s} open, ${c.p0_resolution.closed_within_7d}/${c.p0_resolution.closed_total} closed within 7d |`
  );
  lines.push(
    c.stable_release.status === 'skipped'
      ? `| Stable Release | ${skippedDetail} | ${skippedDetail} |`
      : `| Stable Release | ${c.stable_release.status} | ${c.stable_release.version || 'none'} (stable: ${c.stable_release.is_stable}) |`
  );
  lines.push(
    c.policy_signals.status === 'skipped'
      ? `| Policy Signals | ${skippedDetail} | ${skippedDetail} |`
      : `| Policy Signals | ${c.policy_signals.status} | ${Object.entries(
          c.policy_signals.files
        )
          .map(([f, e]) => `${f}: ${e ? '\u2713' : '\u2717'}`)
          .join(', ')} |`
  );
  lines.push(
    c.spec_tracking.status === 'skipped'
      ? `| Spec Tracking | ${skippedDetail} | ${skippedDetail} |`
      : `| Spec Tracking | ${c.spec_tracking.status} | ${c.spec_tracking.days_gap !== null ? `${c.spec_tracking.days_gap}d gap` : 'N/A'} |`
  );
  lines.push('');

  if (
    !scorecard.partial_run &&
    scorecard.implied_tier.tier1_blockers.length > 0
  ) {
    lines.push('## Tier 1 Blockers');
    lines.push('');
    for (const blocker of scorecard.implied_tier.tier1_blockers) {
      lines.push(`- ${blocker}`);
    }
    lines.push('');
  }

  const closingNote = scorecard.partial_run
    ? 'Partial run — tier classification suppressed. Re-run without --skip-* flags for a full assessment.'
    : scorecard.implied_tier.note;
  lines.push(`> ${closingNote}`);

  return lines.join('\n');
}

export function formatTerminal(scorecard: TierScorecard): void {
  const c = scorecard.checks;
  const tier = scorecard.implied_tier.tier;
  const partial = !!scorecard.partial_run;
  const tierColor = partial
    ? COLORS.DIM
    : tier === 1
      ? COLORS.GREEN
      : tier === 2
        ? COLORS.YELLOW
        : COLORS.RED;
  const tierText = partial ? 'N/A (partial run)' : `Tier ${tier}`;

  console.log(
    `\n${COLORS.BOLD}Tier Assessment: ${tierColor}${tierText}${COLORS.RESET}\n`
  );
  console.log(`Repo:      ${scorecard.repo}`);
  if (scorecard.branch) console.log(`Branch:    ${scorecard.branch}`);
  if (scorecard.version) console.log(`Version:   ${scorecard.version}`);
  console.log(`Timestamp: ${scorecard.timestamp}`);
  if (partial) {
    const skipped = Object.entries(c)
      .filter(([, v]) => (v as { status: CheckStatus }).status === 'skipped')
      .map(([k]) => k);
    console.log(
      `${COLORS.DIM}Scope:     partial — skipped: ${skipped.join(', ') || '(none)'}${COLORS.RESET}`
    );
  }
  console.log(
    `${COLORS.DIM}Legend:    ${statusIcon('pass')} pass  ${statusIcon('fail')} fail  ${statusIcon('partial')} partial  ${statusIcon('skipped')} skipped${COLORS.RESET}`
  );
  console.log('');

  console.log(`${COLORS.BOLD}Conformance:${COLORS.RESET}\n`);

  // Conformance matrix
  const matrix = buildConformanceMatrix(
    c.conformance as ConformanceResult,
    c.client_conformance as ConformanceResult
  );
  const skippedConformanceSuites = [
    c.conformance.status === 'skipped' ? 'server' : null,
    c.client_conformance.status === 'skipped' ? 'client' : null
  ].filter((suite): suite is string => suite !== null);

  const vw = 10; // column width for version cells
  const lw = 14; // label column width
  const tw = 16; // total column width
  const rp = (s: string, w: number) => s.padStart(w);
  const lp = (s: string, w: number) => s.padEnd(w);

  if (skippedConformanceSuites.length > 0) {
    console.log(
      `  ${statusIcon('skipped')} Skipped suites: ${skippedConformanceSuites.join(', ')}`
    );
    console.log(
      `  ${COLORS.DIM}Provide the missing conformance inputs to include them in a full assessment.${COLORS.RESET}\n`
    );
  }

  // Tier-scoring matrix (date-versioned specs only)
  console.log(
    `  ${COLORS.DIM}${lp('', lw + 2)} ${TIER_SPEC_VERSIONS.map((v) => rp(v, vw)).join(' ')}  ${rp('All*', tw)}${COLORS.RESET}`
  );

  const rows: [string, MatrixRow, CheckStatus | null, boolean][] = [
    ['Server', matrix.server, c.conformance.status, true],
    ['Client: Core', matrix.clientCore, c.client_conformance.status, false],
    ['Client: Auth', matrix.clientAuth, c.client_conformance.status, false]
  ];

  for (const [label, row, status, bold] of rows) {
    const icon = status ? statusIcon(status) + ' ' : '  ';
    const b = bold ? COLORS.BOLD : '';
    const r = bold ? COLORS.RESET : '';
    console.log(
      `  ${icon}${b}${lp(label, lw)}${r} ${TIER_SPEC_VERSIONS.map((v) => rp(formatConformanceCell(row.cells.get(v), status), vw)).join(' ')}  ${b}${rp(formatConformanceTotal(row.tierUnique, status, bold), tw)}${r}`
    );
  }

  // Client total line (tier-scoring only)
  const clientTierTotal: Cell = {
    passed:
      matrix.clientCore.tierUnique.passed + matrix.clientAuth.tierUnique.passed,
    total:
      matrix.clientCore.tierUnique.total + matrix.clientAuth.tierUnique.total
  };
  console.log(
    `  ${statusIcon(c.client_conformance.status)} ${COLORS.BOLD}${lp('Client Total', lw)}${COLORS.RESET} ${' '.repeat(TIER_SPEC_VERSIONS.length * (vw + 1) - 1)}  ${COLORS.BOLD}${rp(formatConformanceTotal(clientTierTotal, c.client_conformance.status, true), tw)}${COLORS.RESET}`
  );
  console.log(
    `\n  ${COLORS.DIM}* unique scenarios — a scenario may apply to multiple spec versions${COLORS.RESET}`
  );

  // Informational matrix (draft/extension) — only if there are any
  const hasInfo = rows.some(([, row]) =>
    INFO_SPEC_VERSIONS.some((v) => {
      const cell = row.cells.get(v);
      return cell && cell.total > 0;
    })
  );
  if (hasInfo) {
    console.log(`\n  Informational (not scored for tier):\n`);
    console.log(
      `  ${COLORS.DIM}${lp('', lw + 2)} ${INFO_SPEC_VERSIONS.map((v) => rp(v, vw)).join(' ')}${COLORS.RESET}`
    );
    for (const [label, row, status, bold] of rows) {
      const hasData = INFO_SPEC_VERSIONS.some((v) => {
        const cell = row.cells.get(v);
        return cell && cell.total > 0;
      });
      if (!hasData && status !== 'skipped') continue;
      const b = bold ? COLORS.BOLD : '';
      const r = bold ? COLORS.RESET : '';
      console.log(
        `    ${b}${lp(label, lw)}${r} ${INFO_SPEC_VERSIONS.map((v) => rp(formatConformanceCell(row.cells.get(v), status), vw)).join(' ')}`
      );
    }
  }
  console.log(`\n${COLORS.BOLD}Repository Health:${COLORS.RESET}\n`);
  const rhLabel = (s: string) => s.padEnd(14);
  if (c.labels.status === 'skipped') {
    console.log(
      `  ${statusIcon('skipped')} ${rhLabel('Labels')} ${COLORS.DIM}skipped${COLORS.RESET}`
    );
  } else {
    console.log(
      `  ${statusIcon(c.labels.status)} ${rhLabel('Labels')} ${c.labels.present}/${c.labels.required} required labels`
    );
    if (c.labels.missing.length > 0)
      console.log(
        `    ${COLORS.DIM}Missing: ${c.labels.missing.join(', ')}${COLORS.RESET}`
      );
  }
  if (c.triage.status === 'skipped') {
    console.log(
      `  ${statusIcon('skipped')} ${rhLabel('Triage')} ${COLORS.DIM}skipped${COLORS.RESET}`
    );
  } else {
    console.log(
      `  ${statusIcon(c.triage.status)} ${rhLabel('Triage')} ${Math.round(c.triage.compliance_rate * 100)}% within 2BD (${c.triage.total_issues} issues, median ${c.triage.median_hours}h)`
    );
  }
  if (c.p0_resolution.status === 'skipped') {
    console.log(
      `  ${statusIcon('skipped')} ${rhLabel('P0 Resolution')} ${COLORS.DIM}skipped${COLORS.RESET}`
    );
  } else {
    console.log(
      `  ${statusIcon(c.p0_resolution.status)} ${rhLabel('P0 Resolution')} ${c.p0_resolution.open_p0s} open, ${c.p0_resolution.closed_within_7d}/${c.p0_resolution.closed_total} closed within 7d`
    );
    if (c.p0_resolution.open_p0_details.length > 0) {
      for (const p0 of c.p0_resolution.open_p0_details) {
        console.log(
          `    ${COLORS.RED}#${p0.number} (${p0.age_days}d old): ${p0.title}${COLORS.RESET}`
        );
      }
    }
  }
  if (c.stable_release.status === 'skipped') {
    console.log(
      `  ${statusIcon('skipped')} ${rhLabel('Stable Release')} ${COLORS.DIM}skipped${COLORS.RESET}`
    );
  } else {
    console.log(
      `  ${statusIcon(c.stable_release.status)} ${rhLabel('Stable Release')} ${c.stable_release.version || 'none'}`
    );
  }
  if (c.policy_signals.status === 'skipped') {
    console.log(
      `  ${statusIcon('skipped')} ${rhLabel('Policy Signals')} ${COLORS.DIM}skipped${COLORS.RESET}`
    );
  } else {
    console.log(
      `  ${statusIcon(c.policy_signals.status)} ${rhLabel('Policy Signals')} ${Object.entries(
        c.policy_signals.files
      )
        .map(([f, e]) => `${e ? '\u2713' : '\u2717'} ${f}`)
        .join(', ')}`
    );
  }
  if (c.spec_tracking.status === 'skipped') {
    console.log(
      `  ${statusIcon('skipped')} ${rhLabel('Spec Tracking')} ${COLORS.DIM}skipped${COLORS.RESET}`
    );
  } else {
    console.log(
      `  ${statusIcon(c.spec_tracking.status)} ${rhLabel('Spec Tracking')} ${c.spec_tracking.days_gap !== null ? `${c.spec_tracking.days_gap}d gap` : 'N/A'}`
    );
  }

  if (!partial && scorecard.implied_tier.tier1_blockers.length > 0) {
    console.log(`\n${COLORS.BOLD}Tier 1 Blockers:${COLORS.RESET}`);
    for (const blocker of scorecard.implied_tier.tier1_blockers) {
      console.log(`  ${COLORS.RED}\u2022${COLORS.RESET} ${blocker}`);
    }
  }

  const closingNote = partial
    ? 'Partial run — tier classification suppressed. Re-run without --skip-* flags for a full assessment.'
    : scorecard.implied_tier.note;
  console.log(`\n${COLORS.DIM}${closingNote}${COLORS.RESET}\n`);
}
