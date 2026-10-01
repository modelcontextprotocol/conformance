/**
 * The hosted matrix: every registered client scenario (rows) against every
 * specification revision that ships a requirement set (columns).
 *
 * A cell says two independent things about (scenario, revision):
 *
 *   - scoring — what the revision's requirement set makes of the scenario:
 *     `scored` (in its `client:` list), `not_scored` (listed but never counted,
 *     with the set's reason), `unlisted` (applies to the revision but the
 *     frozen set predates it), or `n/a` (does not apply: introduced later,
 *     removed earlier, or an extension the set does not carry). The CLI
 *     answers the same question with `--requirements` / `--spec-version`.
 *   - startable — whether this deployment can mount the cell: the scenario
 *     has been converted to `handler()` / `authHandlers()`, every relay
 *     origin it needs is configured, and the deployment has not excluded it.
 *
 * `n/a` cells are never mounted; the other three are, when startable.
 */

import { isScenarioApplicableAt, scenarios } from '../scenarios';
import {
  listRequirementRevisions,
  loadRequirements,
  type RequirementSet
} from '../requirements';
import {
  AuthHandlerScenario,
  type AuxOriginRole,
  type Scenario,
  type ScenarioSource,
  type SpecVersion
} from '../types';
import type { Step } from '../steps';

export type CellScoring = 'scored' | 'not_scored' | 'unlisted' | 'n/a';

/**
 * Every cell's MCP endpoint is the cell URL plus this. A scenario that
 * serves MCP at its handler root (`mcpPath` '') is reached at `<cell>/mcp`
 * too: the hosted server rewrites that suffix to `/` before dispatch, so
 * clients see one URL shape across the matrix.
 */
export const MCP_PATH = '/mcp';

/** The public MCP sub-path of a scenario's cells: its mcpPath, or /mcp. */
export function publicMcpPath(scenario: Pick<Scenario, 'mcpPath'>): string {
  return scenario.mcpPath || MCP_PATH;
}

export interface MatrixCell {
  scenario: string;
  revision: SpecVersion;
  scoring: CellScoring;
  /**
   * For `not_scored`: the requirement set's reason (and note). For `n/a`: why
   * the scenario does not apply to the revision. For `unlisted`: a fixed
   * explanation. Absent for `scored`.
   */
  reason?: string;
  /** False when this deployment cannot mount the cell; see `startReason`. */
  startable: boolean;
  /** Why the cell cannot be started. Absent when startable or `n/a`. */
  startReason?: string;
  /** The scenario's declarative client choreography, when it has one. */
  steps?: readonly Step[];
  /** Sub-path of the MCP endpoint under the cell URL; always ends in /mcp. */
  mcpPath: string;
}

export interface MatrixRow {
  scenario: string;
  description: string;
  source: ScenarioSource;
  cells: MatrixCell[];
}

export interface HostedMatrix {
  /** Columns: revisions with a requirement set, in timeline order. */
  revisions: SpecVersion[];
  /** Rows: every registered client scenario, in registry order. */
  rows: MatrixRow[];
  cell(scenario: string, revision: string): MatrixCell | undefined;
  cells(): MatrixCell[];
}

export interface MatrixOptions {
  /** Relay origins this deployment has, keyed by role. */
  auxOrigins?: Partial<Record<AuxOriginRole, string>>;
  /** Scenario name → why this deployment refuses to mount it. */
  exclude?: Record<string, string>;
}

/** The CLI's wording for a scenario outside its applicability window. */
export function notApplicableReason(source: ScenarioSource): string {
  if ('introducedIn' in source) {
    return (
      `introduced in ${source.introducedIn}` +
      (source.removedIn !== undefined ? `, removed in ${source.removedIn}` : '')
    );
  }
  return 'extension, not on the spec timeline';
}

export function scoringFor(
  scenario: Pick<Scenario, 'name' | 'source'>,
  requirements: RequirementSet
): { scoring: CellScoring; reason?: string } {
  if (requirements.client.includes(scenario.name)) return { scoring: 'scored' };
  const entry = requirements.notScored.find(
    (e) => e.scenario === scenario.name && e.leg === 'client'
  );
  if (entry) {
    return {
      scoring: 'not_scored',
      reason: entry.note ? `${entry.reason}: ${entry.note}` : entry.reason
    };
  }
  if (
    isScenarioApplicableAt(
      scenario.source,
      requirements.revision as SpecVersion
    )
  ) {
    return { scoring: 'unlisted', reason: 'not in the requirement set' };
  }
  return { scoring: 'n/a', reason: notApplicableReason(scenario.source) };
}

/** Whether this deployment can mount `scenario` at all, and if not, why. */
export function startability(
  scenario: Scenario,
  opts: MatrixOptions
): { startable: true } | { startable: false; reason: string } {
  if (scenario instanceof AuthHandlerScenario) {
    const missing = scenario.auxRoles.filter((r) => !opts.auxOrigins?.[r]);
    if (missing.length) {
      return {
        startable: false,
        reason: `needs relay origin(s) [${missing.join(', ')}]`
      };
    }
  } else if (typeof scenario.handler !== 'function') {
    return { startable: false, reason: 'not converted for hosting yet' };
  }
  const excluded = opts.exclude?.[scenario.name];
  if (excluded) return { startable: false, reason: excluded };
  return { startable: true };
}

export function buildMatrix(opts: MatrixOptions = {}): HostedMatrix {
  const revisions = listRequirementRevisions();
  const requirements = revisions.map((r) => loadRequirements(r));
  const rows: MatrixRow[] = Array.from(scenarios.values()).map((scenario) => {
    const start = startability(scenario, opts);
    const cells = requirements.map((req): MatrixCell => {
      const { scoring, reason } = scoringFor(scenario, req);
      const applicable = scoring !== 'n/a';
      return {
        scenario: scenario.name,
        revision: req.revision as SpecVersion,
        scoring,
        ...(reason !== undefined && { reason }),
        startable: applicable && start.startable,
        ...(applicable && !start.startable && { startReason: start.reason }),
        ...(scenario.steps && { steps: scenario.steps }),
        mcpPath: publicMcpPath(scenario)
      };
    });
    return {
      scenario: scenario.name,
      description: scenario.description,
      source: scenario.source,
      cells
    };
  });
  const byKey = new Map(
    rows.flatMap((r) => r.cells.map((c) => [`${c.revision}/${c.scenario}`, c]))
  );
  return {
    revisions,
    rows,
    cell: (scenario, revision) => byKey.get(`${revision}/${scenario}`),
    cells: () => rows.flatMap((r) => r.cells)
  };
}
