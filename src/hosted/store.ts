/**
 * Run persistence for the hosted conformance server.
 *
 * A long-lived Node process keeps every run in memory and needs none of this.
 * Serverless hosts (val.town, Deno Deploy, …) load-balance one run's requests
 * across short-lived isolates, so the isolate that answers GET /results is
 * often not the one that saw the MCP traffic. A RunStore lets each isolate
 * write through what it observed and lets any isolate serve a merged view:
 *
 *   - run metadata (id → scenario) so an isolate that never saw the run can
 *     still rebuild its handlers (aux-origin requests, results pages);
 *   - checks, keyed by (run, writer): each isolate owns its own row and
 *     replaces it wholesale after every request, so concurrent writers never
 *     clobber each other and no append ordering is needed.
 *
 * The merged log is re-judged at results time by a fresh scenario instance
 * (see SessionManager.results), which is what turns "isolate B never saw a
 * tools/call" from a false FAILURE into the union of what A and B saw.
 */

import type { ConformanceCheck } from '../types';

export interface RunStore {
  saveRun(id: string, scenarioName: string): Promise<void>;
  /** Scenario name for a run id, or undefined if no isolate ever saw it. */
  loadRun(id: string): Promise<string | undefined>;
  saveChecks(
    id: string,
    writer: string,
    checks: ConformanceCheck[]
  ): Promise<void>;
  /** All writers' check lists for a run, keyed by writer id. */
  loadChecks(id: string): Promise<Map<string, ConformanceCheck[]>>;
  deleteRun(id: string): Promise<void>;
}

/** In-process store — used by tests to exercise the merge path. */
export class MemoryRunStore implements RunStore {
  private runs = new Map<string, string>();
  private checks = new Map<string, Map<string, ConformanceCheck[]>>();

  async saveRun(id: string, scenarioName: string): Promise<void> {
    if (!this.runs.has(id)) this.runs.set(id, scenarioName);
  }
  async loadRun(id: string): Promise<string | undefined> {
    return this.runs.get(id);
  }
  async saveChecks(
    id: string,
    writer: string,
    checks: ConformanceCheck[]
  ): Promise<void> {
    let byWriter = this.checks.get(id);
    if (!byWriter) this.checks.set(id, (byWriter = new Map()));
    byWriter.set(
      writer,
      checks.map((c) => ({ ...c }))
    );
  }
  async loadChecks(id: string): Promise<Map<string, ConformanceCheck[]>> {
    return new Map(this.checks.get(id) ?? []);
  }
  async deleteRun(id: string): Promise<void> {
    this.runs.delete(id);
    this.checks.delete(id);
  }
}
