/**
 * Hosted conformance server — direct-mount, no loopback proxy.
 *
 * One run exercises the whole matrix: every client scenario at every
 * specification revision that ships a requirement set (see ./matrix.ts).
 *
 *   GET  /                                   Landing page: the static matrix
 *   GET  /scenarios                          JSON rows with per-revision cells
 *   GET  /s                                  Mint a run id → 303 /s/<run-id>
 *   GET  /s/<run-id>                         Config for every startable cell
 *   GET  /s/<run-id>/<rev>                   … for one revision (a column)
 *   GET  /s/<run-id>/<rev>/<scenario>        … for one cell
 *   ALL  /s/<run-id>/<rev>/<scenario>[/<suffix>]
 *                                            The cell's server. Its MCP
 *                                            endpoint is the cell URL plus
 *                                            the scenario's mcpPath.
 *   GET  /results/<run-id>[/<rev>[/<scenario>]]
 *                                            Results, mirroring /s
 *   DELETE /results/<run-id>                 Tear down every cell of the run
 *
 * Config and results answer HTML when the request prefers text/html and JSON
 * otherwise; `?format=html|json` overrides. At a cell URL a GET that accepts
 * text/html (and not text/event-stream) or carries `?format=` is a page
 * request; every other request is dispatched to the scenario.
 *
 * Scenarios are mounted via Scenario.handler() — the same RequestListener the
 * CLI runner wraps in http.createServer — so there is no loopback port and
 * this works on serverless hosts. Each cell gets a fresh Scenario instance,
 * created lazily on first hit, built for the column's wire version.
 */

import express, { Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import {
  SessionManager,
  HostedRun,
  CellRef,
  RUN_ID_RE,
  UnknownScenarioError,
  NotHostableError,
  cellId,
  mintRunId
} from './session';
import { buildMatrix, type HostedMatrix, type MatrixCell } from './matrix';
import {
  renderLanding,
  renderConfig,
  renderReport,
  renderResults
} from './html';
import { onBodySettled, tapJsonBody } from './body';
import { identityFrom } from './identity';
import {
  describeRequest,
  tapResponse,
  wireRejectedCheck,
  wireRejection,
  wrongRevision,
  wrongRevisionCheck,
  type CapturedResponse,
  type RequestInfo
} from './wire';
import { buildReport } from './report';
import type { RunStore } from './store';
import { scenarios } from '../scenarios';
import { ConformanceCheck, AuxOriginRole, SpecVersion } from '../types';

export interface HostedServerOptions {
  publicOrigin?: string;
  ttlMs?: number;
  /**
   * Public origins of the AS/IdP relay deployments. When set, scenarios that
   * implement `authHandlers()` become startable; their per-cell AS issuer is
   * `<auxOrigins.as>/r/<run-id>/<rev>/<scenario>`. See
   * examples/hosted/valtown-relay.ts.
   */
  auxOrigins?: Partial<Record<AuxOriginRole, string>>;
  /**
   * Shared secret the relay sends in `x-relay-secret`. `/__aux/*` rejects
   * requests without it so the aux backchannel can't be hit directly. Set
   * the same value in the relay's env.
   */
  relaySecret?: string;
  /**
   * Persist runs so a deployment that load-balances one run's requests
   * across processes (serverless isolates) still serves complete results.
   * See ./store.ts. Omit for a single long-lived process.
   */
  store?: RunStore;
  /**
   * Scenarios this deployment refuses to mount, with the reason shown in
   * the matrix (e.g. scenarios that need one process's memory across
   * requests on a host that has none).
   */
  exclude?: Record<string, string>;
}

const AUX_ROLES: readonly AuxOriginRole[] = ['as', 'as2', 'idp'];

/** Cell config as served under /s/<run-id>[/<rev>[/<scenario>]]. */
export interface CellConfig {
  scenario: string;
  revision: SpecVersion;
  /** The MCP endpoint URL — what the client under test connects to. */
  url: string;
  resultsUrl: string;
  scoring: MatrixCell['scoring'];
  reason?: string;
  steps?: MatrixCell['steps'];
  env: {
    MCP_CONFORMANCE_SCENARIO: string;
    MCP_CONFORMANCE_PROTOCOL_VERSION: string;
    MCP_CONFORMANCE_CONTEXT?: string;
  };
}

export interface RunConfig {
  runId: string;
  revision?: SpecVersion;
  scenario?: string;
  resultsUrl: string;
  mcpServers: Record<string, { type: 'http'; url: string }>;
  cells: CellConfig[];
}

export function createHostedApp(opts: HostedServerOptions = {}): {
  app: express.Application;
  sessions: SessionManager;
  matrix: HostedMatrix;
} {
  const auxOrigins = opts.auxOrigins ?? {};
  const haveAux = AUX_ROLES.filter((r) => auxOrigins[r]);
  const sessions = new SessionManager({
    ttlMs: opts.ttlMs,
    auxOrigins,
    store: opts.store
  });
  const matrix = buildMatrix({ auxOrigins, exclude: opts.exclude });
  const revisions: readonly string[] = matrix.revisions;
  const app = express();
  // Copy JSON POST bodies as they flow so the report can name the client
  // (initialize params / per-request _meta) without consuming the stream
  // the scenario is about to read.
  app.use(tapJsonBody());

  function origin(req: Request): string {
    if (opts.publicOrigin) return opts.publicOrigin;
    const proto = (req.header('x-forwarded-proto') ?? req.protocol) || 'http';
    const host = req.header('x-forwarded-host') ?? req.header('host');
    return `${proto}://${host}`;
  }

  const cellBaseUrl = (req: Request, ref: CellRef) =>
    `${origin(req)}/s/${cellId(ref)}`;
  const resultsUrlFor = (req: Request, ...parts: string[]) =>
    `${origin(req)}/results/${parts.join('/')}`;

  /**
   * Path segments of a captured route tail. A trailing slash (`/s/<run-id>/`,
   * `/results/<run-id>/<rev>/`) is not a segment: without this it would read
   * as an empty revision or scenario name and 404.
   */
  function segmentsOf(tail: string): string[] {
    // A loop, not /\/+$/: that regex backtracks polynomially on
    // request-controlled input (CodeQL js/polynomial-redos).
    while (tail.endsWith('/')) tail = tail.slice(0, -1);
    return tail.split('/');
  }

  /**
   * Longest registered scenario name that prefixes `segments` (names may
   * contain '/'), plus whatever follows it as a path suffix ('' if nothing).
   * Matches every registered client scenario, not only startable ones, so a
   * cell that cannot start still answers with its reason.
   */
  function resolveScenario(
    segments: string[]
  ): { scenarioName: string; suffix: string } | undefined {
    for (let i = segments.length; i >= 1; i--) {
      const candidate = segments.slice(0, i).join('/');
      if (scenarios.has(candidate)) {
        return {
          scenarioName: candidate,
          suffix: i < segments.length ? '/' + segments.slice(i).join('/') : ''
        };
      }
    }
    return undefined;
  }

  interface ResolvedCell {
    ref: CellRef;
    cell: MatrixCell;
    suffix: string;
  }

  /**
   * Resolve `[<run-id>, <rev>, <scenario...>, <suffix...>]` to a startable
   * cell, or answer the request with why it isn't one and return undefined.
   */
  function resolveCell(
    segments: string[],
    res: Response
  ): ResolvedCell | undefined {
    const [runId, revision, ...rest] = segments;
    if (!RUN_ID_RE.test(runId ?? '')) {
      res.status(400).json({ error: 'invalid run-id' });
      return undefined;
    }
    if (!revisions.includes(revision ?? '')) {
      res
        .status(404)
        .json({ error: `unknown revision '${revision ?? ''}'`, revisions });
      return undefined;
    }
    const resolved = resolveScenario(rest);
    if (!resolved) {
      res.status(404).json({ error: `unknown scenario '${rest.join('/')}'` });
      return undefined;
    }
    const cell = matrix.cell(resolved.scenarioName, revision)!;
    if (!checkStartable(cell, res)) return undefined;
    return {
      ref: {
        runId,
        revision: revision as SpecVersion,
        scenarioName: resolved.scenarioName
      },
      cell,
      suffix: resolved.suffix
    };
  }

  /** 404 for n/a cells, 501 for cells this deployment cannot start. */
  function checkStartable(cell: MatrixCell, res: Response): boolean {
    if (cell.scoring === 'n/a') {
      res.status(404).json({
        error: `scenario '${cell.scenario}' does not apply to ${cell.revision}: ${cell.reason}`,
        scenario: cell.scenario,
        revision: cell.revision,
        scoring: cell.scoring,
        reason: cell.reason
      });
      return false;
    }
    if (!cell.startable) {
      res.status(501).json({
        error: `scenario '${cell.scenario}' at ${cell.revision} cannot be started here: ${cell.startReason}`,
        scenario: cell.scenario,
        revision: cell.revision,
        scoring: cell.scoring,
        reason: cell.startReason
      });
      return false;
    }
    return true;
  }

  /**
   * The cell, hydrated from the store when this process has never seen it
   * (see SessionManager.acquire) — a request must not be dispatched before
   * the scenario knows the run's history.
   */
  async function createRun(
    req: Request,
    ref: CellRef,
    res: Response
  ): Promise<HostedRun | undefined> {
    try {
      return await sessions.acquire(ref, (r) => cellBaseUrl(req, r));
    } catch (e) {
      if (e instanceof UnknownScenarioError) {
        res.status(404).json({ error: e.message });
        return undefined;
      }
      if (e instanceof NotHostableError) {
        res.status(501).json({ error: e.message });
        return undefined;
      }
      throw e;
    }
  }

  /** Whether `rewrittenUrl` (path, maybe a query) is the cell's MCP endpoint. */
  function isMcpEndpoint(run: HostedRun, rewrittenUrl: string): boolean {
    const q = rewrittenUrl.indexOf('?');
    const path = q === -1 ? rewrittenUrl : rewrittenUrl.slice(0, q);
    return path === (run.mcpPath || '/');
  }

  /**
   * Dispatch (req, res) to `listener` after rewriting `req.url` so the
   * scenario sees the path it would have under start()/stop() — i.e. with
   * the cell prefix stripped and (for well-known dispatch) the well-known
   * prefix re-prepended.
   *
   * `mcp` says the request is to the cell's MCP endpoint (not a PRM,
   * canary or aux path): only those are judged for wire rejections and
   * revision discipline (see ./wire.ts).
   */
  function dispatch(
    run: HostedRun,
    listener: (req: Request, res: Response) => void,
    req: Request,
    res: Response,
    rewrittenUrl: string,
    mcp = false
  ) {
    res.setHeader(
      'link',
      `<${resultsUrlFor(req, run.id)}>; rel="conformance-results"`
    );
    req.url = rewrittenUrl;
    run.touched = true;

    const headerVersion = req.header('mcp-protocol-version');
    let request: RequestInfo | undefined;
    let body: Buffer | undefined;
    let response: CapturedResponse | undefined;
    let judged = false;

    // Write this process's view through once the scenario has answered
    // (hosted scenarios record their checks before calling end()).
    // Serverless entry points should await sessions.flush() before
    // returning the response so this write isn't abandoned.
    const persist = () => {
      if (sessions.store) void sessions.persist(run);
    };

    /** Once the request is parsed and the response is out, judge both. */
    const judge = (): boolean => {
      if (judged || !request || !response) return false;
      judged = true;
      if (mcp) {
        for (const method of request.methods) {
          const reason = wrongRevision(run.revision, method, headerVersion);
          if (!reason) continue;
          sessions.recordHostedCheck(
            run,
            `revision:${method}:${headerVersion ?? ''}`,
            wrongRevisionCheck(run.revision, method, headerVersion, reason)
          );
        }
        const rejection = wireRejection(response);
        if (rejection) {
          sessions.recordHostedCheck(
            run,
            `rejected:${rejection.code}:${rejection.message}`,
            wireRejectedCheck(rejection, request, headerVersion)
          );
        }
      }
      const identity = identityFrom(req.headers, body);
      if (identity) sessions.recordIdentity(run, identity);
      return true;
    };

    onBodySettled(req, (captured) => {
      body = captured;
      request = describeRequest(captured);
      // The response is already out: what judge() recorded needs its own
      // write-through.
      if (judge() && response) persist();
    });
    tapResponse(res, (captured) => {
      response = captured;
      judge();
      persist();
    });
    listener(req, res);
  }

  // ---------- representation ----------

  /** `?format=` wins; otherwise the Accept header decides (JSON by default). */
  function wantsHtml(req: Request): boolean {
    const format = req.query.format;
    if (format === 'html') return true;
    if (format === 'json') return false;
    return req.accepts(['json', 'html']) === 'html';
  }

  /**
   * A GET at a cell URL is a page/config request when it accepts text/html
   * (and not the MCP SSE stream) or spells out `?format=`; anything else is
   * the client under test talking to the scenario.
   */
  function isPageRequest(req: Request): boolean {
    if (req.method !== 'GET') return false;
    if (typeof req.query.format === 'string') return true;
    const accept = req.header('accept') ?? '';
    return (
      accept.includes('text/html') && !accept.includes('text/event-stream')
    );
  }

  // ---------- config ----------

  function cellConfig(
    req: Request,
    run: HostedRun,
    cell: MatrixCell
  ): CellConfig {
    const context = run.context
      ? JSON.stringify({ name: run.scenarioName, ...run.context })
      : undefined;
    return {
      scenario: run.scenarioName,
      revision: run.revision,
      url: `${cellBaseUrl(req, run)}${run.mcpPath}`,
      resultsUrl: resultsUrlFor(req, run.id),
      scoring: cell.scoring,
      ...(cell.reason !== undefined && { reason: cell.reason }),
      ...(cell.steps && { steps: cell.steps }),
      env: {
        MCP_CONFORMANCE_SCENARIO: run.scenarioName,
        MCP_CONFORMANCE_PROTOCOL_VERSION: run.revision,
        ...(context !== undefined && { MCP_CONFORMANCE_CONTEXT: context })
      }
    };
  }

  /** Config for every startable cell in scope; creates the cells. */
  function runConfig(
    req: Request,
    runId: string,
    scope: { revision?: SpecVersion; scenario?: string }
  ): RunConfig {
    const cells = matrix
      .cells()
      .filter(
        (c) =>
          c.startable &&
          (scope.revision === undefined || c.revision === scope.revision) &&
          (scope.scenario === undefined || c.scenario === scope.scenario)
      )
      .map((c) => {
        const run = sessions.getOrCreate(
          { runId, revision: c.revision, scenarioName: c.scenario },
          (r) => cellBaseUrl(req, r)
        );
        return cellConfig(req, run, c);
      });
    const parts = [runId];
    if (scope.revision) parts.push(scope.revision);
    if (scope.revision && scope.scenario) parts.push(scope.scenario);
    return {
      runId,
      ...(scope.revision && { revision: scope.revision }),
      ...(scope.scenario && { scenario: scope.scenario }),
      resultsUrl: resultsUrlFor(req, ...parts),
      mcpServers: Object.fromEntries(
        cells.map((c) => [
          `${c.revision}/${c.scenario}`,
          { type: 'http' as const, url: c.url }
        ])
      ),
      cells
    };
  }

  function sendConfig(req: Request, res: Response, config: RunConfig): void {
    if (wantsHtml(req)) {
      res.type('html').send(renderConfig(origin(req), matrix, config));
    } else {
      res.json(config);
    }
  }

  // ---------- discovery ----------

  app.get('/', (req, res) => {
    res.type('html').send(renderLanding(origin(req), matrix));
  });

  app.get('/scenarios', (_req, res) => {
    res.json(
      matrix.rows.map((row) => ({
        name: row.scenario,
        description: row.description,
        source: row.source,
        mcpPath: row.cells[0]?.mcpPath ?? '',
        ...(row.cells[0]?.steps && { steps: row.cells[0].steps }),
        cells: row.cells.map(
          ({ revision, scoring, reason, startable, startReason }) => ({
            revision,
            scoring,
            ...(reason !== undefined && { reason }),
            startable,
            ...(startReason !== undefined && { startReason })
          })
        )
      }))
    );
  });

  // ---------- runs ----------

  app.get('/s', (_req, res) => {
    res.redirect(303, `/s/${mintRunId()}`);
  });

  // We can't pre-register an express route per cell because run-ids are
  // open-ended and scenario names contain '/'. A single catch-all resolves
  // the cell, rewrites req.url to strip the /s/<run-id>/<rev>/<scenario>
  // prefix, and hands off to the cell's listener — exactly what
  // app.use(prefix, fn) would do, but with a dynamic prefix.
  app.all(/^\/s\/(.+)$/, async (req, res) => {
    const segments = segmentsOf(req.params[0]);
    const [runId, revision] = segments;

    if (segments.length <= 2) {
      // Run or column scope: config only.
      if (!RUN_ID_RE.test(runId)) {
        res.status(400).json({ error: 'invalid run-id' });
        return;
      }
      if (segments.length === 2 && !revisions.includes(revision)) {
        res
          .status(404)
          .json({ error: `unknown revision '${revision}'`, revisions });
        return;
      }
      if (req.method !== 'GET') {
        res.status(405).json({
          error:
            'MCP endpoints live at /s/<run-id>/<rev>/<scenario>; GET here for the config.'
        });
        return;
      }
      sendConfig(
        req,
        res,
        runConfig(req, runId, {
          revision:
            segments.length === 2 ? (revision as SpecVersion) : undefined
        })
      );
      return;
    }

    const resolved = resolveCell(segments, res);
    if (!resolved) return;
    const { ref, suffix } = resolved;

    if (suffix === '' && isPageRequest(req)) {
      sendConfig(
        req,
        res,
        runConfig(req, ref.runId, {
          revision: ref.revision,
          scenario: ref.scenarioName
        })
      );
      return;
    }

    const run = await createRun(req, ref, res);
    if (!run) return;
    // Rewrite to the path the scenario expects (it thinks it's at root).
    // The query string is preserved because we keep the express req object.
    const rewritten = suffix || run.mcpPath || '/';
    dispatch(
      run,
      run.listener,
      req,
      res,
      rewritten,
      isMcpEndpoint(run, rewritten)
    );
  });

  // ---------- root well-known dispatch (RS side) ----------
  //
  // RFC 9728: a client given MCP URL <origin>/s/<cell>/mcp derives the PRM
  // URL as <origin>/.well-known/oauth-protected-resource/s/<cell>/mcp — i.e.
  // at the *origin root*, not under the cell prefix. We catch that here,
  // recover the cell from the path suffix, and re-dispatch to its RS handler
  // with the path it would have seen on its own origin.
  //
  // Requests that arrive *under* the cell prefix (because the WWW-Authenticate
  // header points there) already work via the /s/* mount above.

  app.get(
    /^\/\.well-known\/oauth-protected-resource\/s\/(.+)$/,
    async (req, res) => {
      const resolved = resolveCell(req.params[0].split('/'), res);
      if (!resolved) return;
      const run = await createRun(req, resolved.ref, res);
      if (!run) return;
      // Scenario expects e.g. '/.well-known/oauth-protected-resource/mcp'
      dispatch(
        run,
        run.listener,
        req,
        res,
        '/.well-known/oauth-protected-resource' + resolved.suffix
      );
    }
  );

  // ---------- aux-origin backchannel (relay target) ----------
  //
  // The AS relay (examples/hosted/valtown-relay.ts) forwards every request it
  // receives to <this-origin>/__aux/<role><path>. The per-cell AS issuer is
  // <relay-origin>/r/<run-id>/<rev>/<scenario>, so every path the client hits
  // — endpoints (/r/<cell>/authorize) and RFC 8414 well-known
  // (/.well-known/oauth-authorization-server/r/<cell>[/tenant]) — carries
  // `/r/<cell>` somewhere in it. We locate it, strip it, and dispatch to the
  // cell's aux handler so it sees exactly the path createAuthServer
  // registered.
  //
  // Guarded by a shared secret so this internal mount can't be hit directly
  // to forge checks into someone else's run.

  if (haveAux.length) {
    const secret = opts.relaySecret ?? process.env.CONFORMANCE_RELAY_SECRET;
    const guard = (req: Request, res: Response): boolean => {
      const got = req.header('x-relay-secret') ?? '';
      // Constant-time compare; mismatch length → fast 403 is fine.
      const ok =
        !!secret &&
        got.length === secret.length &&
        timingSafeEqual(Buffer.from(got), Buffer.from(secret));
      if (!ok) {
        res
          .status(403)
          .json({ error: 'forbidden: /__aux is the relay backchannel' });
      }
      return ok;
    };

    /**
     * Find the first `/r/<run-id>/<rev>/<scenario...>` in `segments` (plain
     * segment scan — a regex over the whole path would backtrack
     * polynomially on adversarial input) and split the path around it.
     */
    function locateCell(
      segments: string[]
    ): { prefix: string; ref: CellRef; suffix: string } | undefined {
      for (let i = 1; i < segments.length - 2; i++) {
        if (
          segments[i] !== 'r' ||
          !RUN_ID_RE.test(segments[i + 1]) ||
          !revisions.includes(segments[i + 2])
        ) {
          continue;
        }
        const resolved = resolveScenario(segments.slice(i + 3));
        if (!resolved) continue;
        return {
          prefix: segments.slice(0, i).join('/'),
          ref: {
            runId: segments[i + 1],
            revision: segments[i + 2] as SpecVersion,
            scenarioName: resolved.scenarioName
          },
          suffix: resolved.suffix
        };
      }
      return undefined;
    }

    app.all(/^\/__aux\/([a-z0-9]+)(\/.*)$/, async (req, res) => {
      if (!guard(req, res)) return;
      const role = req.params[0] as AuxOriginRole;
      const path = req.params[1];
      if (!AUX_ROLES.includes(role)) {
        res.status(404).json({ error: `unknown aux role '${role}'` });
        return;
      }

      const located = locateCell(path.split('/')); // path starts with '/', so [0] === ''
      if (!located) {
        res.status(404).json({
          error:
            'aux request path missing /r/<run-id>/<revision>/<scenario> segment'
        });
        return;
      }
      const { prefix, ref, suffix } = located;
      const cell = matrix.cell(ref.scenarioName, ref.revision)!;
      if (!checkStartable(cell, res)) return;
      const search = req.url.includes('?')
        ? req.url.slice(req.url.indexOf('?'))
        : '';

      // On a multi-process host this may be the first request this process
      // sees for the cell; the id carries everything needed to rebuild it.
      const run = sessions.ensure(cellId(ref), (r) => cellBaseUrl(req, r));
      const listener = run?.auxListeners?.[role];
      if (!run || !listener) {
        res.status(404).json({ error: `no aux '${role}' handler for cell` });
        return;
      }
      await sessions.hydrate(run);
      dispatch(run, listener, req, res, (prefix + suffix || '/') + search);
    });
  }

  // ---------- results ----------

  app.get(/^\/results\/(.+)$/, async (req, res) => {
    const segments = segmentsOf(req.params[0]);
    const [runId, revision, ...rest] = segments;
    if (!RUN_ID_RE.test(runId)) {
      res.status(400).json({ error: 'invalid run-id' });
      return;
    }
    if (segments.length >= 2 && !revisions.includes(revision)) {
      res
        .status(404)
        .json({ error: `unknown revision '${revision}'`, revisions });
      return;
    }

    if (segments.length >= 3) {
      const resolved = resolveScenario(rest);
      if (!resolved || resolved.suffix !== '') {
        res.status(404).json({ error: `unknown scenario '${rest.join('/')}'` });
        return;
      }
      const ref: CellRef = {
        runId,
        revision: revision as SpecVersion,
        scenarioName: resolved.scenarioName
      };
      const r = await sessions.results(cellId(ref));
      if (!r) {
        res.status(404).json({ error: 'unknown run' });
        return;
      }
      if (wantsHtml(req)) {
        res.type('html').send(renderResults(ref, r.checks));
      } else {
        res.json(summarise(ref, r.checks));
      }
      return;
    }

    // Run or column scope: a verdict per cell of the matrix.
    const scope = segments.length === 2 ? (revision as SpecVersion) : undefined;
    const report = await buildReport(matrix, runId, scope, {
      listCells: (id) => sessions.listCells(id),
      results: (id) => sessions.results(id),
      resultsUrl: (ref) => resultsUrlFor(req, cellId(ref))
    });
    if (wantsHtml(req)) {
      res.type('html').send(renderReport(origin(req), matrix, report));
    } else {
      res.json(report);
    }
  });

  app.delete('/results/:runId', async (req, res) => {
    if (!RUN_ID_RE.test(req.params.runId)) {
      res.status(400).json({ error: 'invalid run-id' });
      return;
    }
    await sessions.destroyRun(req.params.runId);
    res.status(204).end();
  });

  return { app, sessions, matrix };
}

export function summarise(ref: CellRef, checks: ConformanceCheck[]) {
  const counts = { SUCCESS: 0, FAILURE: 0, WARNING: 0, SKIPPED: 0, INFO: 0 };
  for (const c of checks) counts[c.status]++;
  return {
    runId: ref.runId,
    revision: ref.revision,
    scenario: ref.scenarioName,
    summary: {
      passed: counts.SUCCESS,
      failed: counts.FAILURE,
      warnings: counts.WARNING,
      info: counts.INFO,
      skipped: counts.SKIPPED,
      total: checks.length
    },
    checks
  };
}
