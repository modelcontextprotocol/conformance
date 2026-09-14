/**
 * Where each cell of a run stands, for the run page's live line on every
 * URL: its state, when the client last sent it a request, and who the
 * client said it was. Judged exactly as the run report judges it
 * (buildReport(), over the same sources), so the run page, the report and
 * the score never disagree; with a store, that is every process's stored
 * log, so a cell another isolate served reads the same here.
 */

import {
  buildReport,
  groupColumn,
  type CellResults,
  type CellState,
  type ReportSources
} from './report';
import type { HostedMatrix } from './matrix';
import type { ClientIdentity } from './identity';
import { REACHED } from './markdown';

export interface CellLive {
  state: CellState;
  /** When the client last sent the cell a request (ISO 8601). */
  lastRequestAt?: string;
  identities: ClientIdentity[];
  resultsUrl: string;
}

export interface RunLive {
  /** Keyed `<revision>/<scenario>`, for every cell in scope. */
  cells: Map<string, CellLive>;
  /** Cells the client reached, and those among them that need a look. */
  reached: number;
  needsLook: number;
  /** The clock the times are read against (ms since the epoch). */
  now: number;
}

export async function runLive(
  matrix: HostedMatrix,
  runId: string,
  revision: string | undefined,
  sources: ReportSources
): Promise<RunLive> {
  // The report reads each reached cell once; its request time comes along.
  const lastRequest = new Map<string, string>();
  const results = async (id: string): Promise<CellResults | undefined> => {
    const r = await sources.results(id);
    if (r?.lastRequestAt) lastRequest.set(id, r.lastRequestAt);
    return r;
  };
  const now = sources.now?.() ?? Date.now();
  const report = await buildReport(matrix, runId, revision, {
    ...sources,
    results,
    now: () => now
  });
  const cells = new Map<string, CellLive>();
  let reached = 0;
  let needsLook = 0;
  for (const col of report.columns) {
    for (const c of col.cells) {
      const at = lastRequest.get(`${runId}/${c.revision}/${c.scenario}`);
      cells.set(`${c.revision}/${c.scenario}`, {
        state: c.state,
        ...(at && { lastRequestAt: at }),
        identities: c.identities ?? [],
        resultsUrl: c.resultsUrl
      });
      if (REACHED.includes(c.state)) reached++;
    }
    needsLook += groupColumn(col).problems.length;
  }
  return { cells, reached, needsLook, now };
}
