/**
 * `conformance remote` — run one client scenario against a *hosted*
 * conformance server (see src/hosted) instead of spawning the scenario
 * in-process.
 *
 *   1. GET <url>/s/<scenario>[?runId=<id>]  → {runId, mcpUrl, resultsUrl, context}
 *   2. spawn the client command exactly like `conformance client --command`
 *      does: MCP URL appended as the last argv, MCP_CONFORMANCE_SCENARIO and
 *      MCP_CONFORMANCE_CONTEXT in env (see executeClient)
 *   3. GET <url>/results/<runId>            → {scenario, summary, checks}
 *
 * The scenario's checks are recorded server-side, so the returned checks are
 * authoritative; the client's own exit code is informational only (auth
 * scenarios legitimately end with the client bailing out).
 */

import { promises as fs } from 'fs';
import path from 'path';
import { executeClient, type ClientExecutionResult } from './client';
import type { ConformanceCheck } from '../types';

export interface RemoteRunOptions {
  /** Origin of the hosted conformance server, e.g. https://conformance.example.com */
  url: string;
  scenario: string;
  /** Client command; the MCP URL is appended as the last argument. */
  command: string;
  /** Caller-chosen run id (must match [A-Za-z0-9_-]{1,64}); minted when omitted. */
  runId?: string;
  /** Client timeout in ms (default 60s — remote round-trips are slower than loopback). */
  timeout?: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  /** Injected for tests. */
  log?: (line: string) => void;
}

export interface RemoteRunSummary {
  passed: number;
  failed: number;
  warnings: number;
  info: number;
  skipped: number;
  total: number;
}

export interface RemoteRunResult {
  scenario: string;
  runId: string;
  mcpUrl: string;
  resultsUrl: string;
  resultsHtmlUrl: string;
  summary: RemoteRunSummary;
  checks: ConformanceCheck[];
  clientOutput: ClientExecutionResult;
  /** summary.failed > 0, or the client timed out before the server saw a full run. */
  failed: boolean;
}

interface MintResponse {
  runId: string;
  mcpUrl: string;
  resultsUrl?: string;
  resultsHtmlUrl?: string;
  context?: Record<string, unknown>;
}

interface ResultsResponse {
  scenario: string;
  summary: RemoteRunSummary;
  checks: ConformanceCheck[];
}

async function getJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  what: string
): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  } catch (e) {
    throw new Error(
      `${what}: could not reach ${url}: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 500);
    throw new Error(
      `${what}: HTTP ${res.status} from ${url}${body ? ` — ${body}` : ''}`
    );
  }
  return (await res.json()) as T;
}

export async function runRemoteConformanceTest(
  opts: RemoteRunOptions
): Promise<RemoteRunResult> {
  const base = opts.url.replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((line: string) => console.error(line));
  const timeout = opts.timeout ?? 60000;

  const mintUrl = new URL(`${base}/s/${opts.scenario}`);
  if (opts.runId) mintUrl.searchParams.set('runId', opts.runId);
  const mint = await getJson<MintResponse>(
    fetchImpl,
    mintUrl.toString(),
    `mint run for '${opts.scenario}'`
  );
  if (!mint.runId || !mint.mcpUrl) {
    throw new Error(
      `mint run for '${opts.scenario}': unexpected response ${JSON.stringify(mint).slice(0, 500)}`
    );
  }
  // Results are always read back from the origin the caller gave us, not the
  // one the server derived from its Host header (proxies may differ).
  const resultsUrl = `${base}/results/${mint.runId}`;
  const resultsHtmlUrl = `${resultsUrl}.html`;

  log(`Starting remote scenario: ${opts.scenario} (run ${mint.runId})`);
  log(`Executing client: ${opts.command} ${mint.mcpUrl}`);
  if (mint.context) log(`With context: ${JSON.stringify(mint.context)}`);

  // Same spawn path as `conformance client`: URL as last arg, scenario +
  // context in env. The hosted context already carries `name`; executeClient
  // re-adds it, which is a no-op.
  const clientOutput = await executeClient(
    opts.command,
    opts.scenario,
    mint.mcpUrl,
    timeout,
    mint.context
  );

  if (clientOutput.exitCode !== 0) {
    log(`\nClient exited with code ${clientOutput.exitCode}`);
    if (clientOutput.stdout) log(`\nStdout:\n${clientOutput.stdout}`);
    if (clientOutput.stderr) log(`\nStderr:\n${clientOutput.stderr}`);
  }
  if (clientOutput.timedOut) log(`\nClient timed out after ${timeout}ms`);

  const results = await getJson<ResultsResponse>(
    fetchImpl,
    resultsUrl,
    `fetch results for run ${mint.runId}`
  );

  return {
    scenario: results.scenario ?? opts.scenario,
    runId: mint.runId,
    mcpUrl: mint.mcpUrl,
    resultsUrl,
    resultsHtmlUrl,
    summary: results.summary,
    checks: results.checks ?? [],
    clientOutput,
    failed: results.summary.failed > 0 || clientOutput.timedOut
  };
}

/** Write the JSON result (minus raw client output) for CI to aggregate. */
export async function writeRemoteResult(
  result: RemoteRunResult,
  file: string
): Promise<void> {
  const { clientOutput, ...rest } = result;
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify(
      {
        ...rest,
        clientExitCode: clientOutput.exitCode,
        clientTimedOut: clientOutput.timedOut
      },
      null,
      2
    ) + '\n'
  );
}
