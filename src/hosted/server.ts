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
 *                                            /mcp, whatever the scenario's
 *                                            own mcpPath (see MCP_PATH).
 *   GET  /results/<run-id>[/<rev>[/<scenario>]]
 *                                            Results, mirroring /s; a run or
 *                                            column also as `?format=md`
 *   POST /results/<run-id>/freeze            Freeze the run's report → its
 *                                            snapshot (303 for a browser)
 *   GET  /results/<run-id>/snapshot/<id>     A frozen report (html/json/md)
 *   DELETE /results/<run-id>                 Tear down every cell of the run,
 *                                            and its snapshots
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
  RunResults,
  RUN_ID_RE,
  UnknownScenarioError,
  NotHostableError,
  StoreUnavailableError,
  cellId,
  mintId,
  mintRunId
} from './session';
import {
  buildMatrix,
  MCP_PATH,
  type HostedMatrix,
  type MatrixCell
} from './matrix';
import {
  renderLanding,
  renderConfig,
  renderReport,
  renderResults
} from './html';
import {
  bodyFitsBuffer,
  declaresNoBody,
  onBodySettled,
  tapJsonBody
} from './body';
import { identityFrom } from './identity';
import { isStatefulVersion } from '../connection/select';
import {
  answeredVersion,
  describeRequest,
  discoverReply,
  getOnMcpCheck,
  GET_ON_MCP_REPLY,
  isAcceptedInitialize,
  isLegacyProbe,
  isLoneDiscover,
  isModernProbe,
  isUnparseable,
  legacyAnswer,
  legacyInitializeReply,
  legacyProbeCheck,
  modernProbeCheck,
  PARSE_ERROR_REPLY,
  pinInitializeVersion,
  refusalOf,
  reachedRevision,
  revisionReachedCheck,
  revisionSpokenCheck,
  spokeRevision,
  tapResponse,
  unparseableBodyCheck,
  versionAnswer,
  versionOfferedCheck,
  wireRejectedCheck,
  wireRejection,
  wrongRevision,
  wrongRevisionCheck,
  type CapturedResponse,
  type RequestInfo
} from './wire';
import {
  buildReport,
  reportJson,
  summarize,
  viewCell,
  type CellState,
  type ReportSources,
  type RunReport,
  type Verdict
} from './report';
import { parseComposite } from './composite';
import { createCompositeRoute } from './composite-route';
import { MemoryRunStore, type RunStore, type SnapshotInfo } from './store';
import { reportMarkdown, reportText } from './markdown';
import { jsonRows, type ShownCheck } from './shown';
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

/** Snapshot ids are minted like run ids (see mintId()), shorter. */
const SNAPSHOT_ID_RE = /^[0-9a-z]{1,32}$/;

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
  // Frozen reports live in the run store, so any isolate can serve a
  // permalink; a single process without one keeps them in memory.
  const snapshots: RunStore = opts.store ?? new MemoryRunStore();
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
   * The cell, built on first reference but not yet seeded from the store;
   * or undefined, with the request answered, when it cannot be mounted.
   */
  function mountCell(
    req: Request,
    ref: CellRef,
    res: Response
  ): HostedRun | undefined {
    try {
      return sessions.getOrCreate(ref, (r) => cellBaseUrl(req, r));
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
    const run = mountCell(req, ref, res);
    if (run) await sessions.hydrate(run);
    return run;
  }

  /**
   * Make the cells ready for a request to their MCP endpoint (`mcp`) or
   * another path: seeded from the store, unless the request is a
   * `server/discover` whose answer no history can change. A client may give
   * discover a second before it falls back to an older handshake, so that
   * answer does not wait on the store; it is recorded all the same
   * (SessionManager.persist). Which discovers qualify: the hosted layer's
   * own refusal on a dated cell (discoverReply()), and on a stateless one
   * the scenario's, unless it reads its log to answer
   * (Scenario.discoverReadsHistory). Not an auth cell's, whose resource
   * server decides before it looks at the request.
   */
  async function prepare(
    runs: HostedRun[],
    req: Request,
    mcp: boolean
  ): Promise<void> {
    const early =
      mcp &&
      req.method === 'POST' &&
      bodyFitsBuffer(req) &&
      runs.every(
        (run) =>
          !run.auxListeners &&
          (isStatefulVersion(run.revision) ||
            !run.scenario.discoverReadsHistory)
      ) &&
      (await new Promise<boolean>((resolve) =>
        onBodySettled(req, (body) =>
          resolve(body !== undefined && isLoneDiscover(body))
        )
      ));
    if (!early) await Promise.all(runs.map((run) => sessions.hydrate(run)));
  }

  /**
   * The path the scenario sees for a request at `<cell><suffix>`: the
   * suffix, except that `/mcp` on a scenario serving MCP at its root is the
   * root — every cell is reachable at `<cell>/mcp` (see MCP_PATH).
   */
  function scenarioPath(run: HostedRun, suffix: string): string {
    if (suffix === MCP_PATH && !run.mcpPath) return '';
    return suffix;
  }

  /** Whether `rewrittenUrl` (path, maybe a query) is the cell's MCP endpoint. */
  function isMcpEndpoint(run: HostedRun, rewrittenUrl: string): boolean {
    const q = rewrittenUrl.indexOf('?');
    const path = q === -1 ? rewrittenUrl : rewrittenUrl.slice(0, q);
    return path === (run.mcpPath || '/');
  }

  /**
   * The probe notes this process has recorded per cell, keyed by kind and
   * the revision probed for, and whether each already carries the cell's
   * version answer. Only a note's wording depends on it (see noteProbe());
   * whether a request is a probe never does.
   */
  const probeNotes = new WeakMap<
    HostedRun,
    Map<string, { check: ConformanceCheck; answered: boolean }>
  >();

  /**
   * Record a probe's note once per `key`. A probe an auth cell met with 401
   * is repeated after sign-in and then draws the cell's version answer,
   * which is what the note should report: the first note is updated in
   * place when that answer arrives.
   */
  function noteProbe(
    run: HostedRun,
    key: string,
    check: ConformanceCheck,
    answered: boolean
  ): void {
    let notes = probeNotes.get(run);
    if (!notes) probeNotes.set(run, (notes = new Map()));
    const seen = notes.get(key);
    if (!seen) {
      notes.set(key, { check, answered });
      sessions.recordHostedCheck(run, key, check);
    } else if (answered && !seen.answered) {
      seen.check.description = check.description;
      seen.check.details = check.details;
      seen.answered = true;
    }
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

    // The headers as the client sent them: a scenario may rewrite them
    // before handing the request on (json-schema-ref-deref maps the draft
    // header to the SDK's), and identity is what the client said.
    const headers = { ...req.headers };
    const headerVersion = req.header('mcp-protocol-version');
    const httpMethod = req.method;
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
      // Era detection on a dated cell (a server/discover, or another
      // 2026-07-28-shaped request it turned away) is the client negotiating:
      // noted once per revision probed for, and neither judgement — however
      // often it comes, and whatever the cell answered before it.
      if (
        mcp &&
        isModernProbe(run.revision, request, headerVersion, response)
      ) {
        const version = headerVersion ?? request.metaVersion;
        const answer = versionAnswer(run.revision, version, response);
        noteProbe(
          run,
          `modern-probe:${version ?? ''}`,
          modernProbeCheck(
            run.revision,
            request.methods[0],
            version,
            answer ?? refusalOf(response)
          ),
          !!answer
        );
      } else if (mcp) {
        const rejection = wireRejection(response, run.revision, headerVersion);
        // One mistake, one check: a wrong-revision request the wire also
        // turned away records the revision, with the rejection folded in.
        let explained = false;
        for (const method of request.methods) {
          // An initialize on the stateless wire is era detection (see
          // isLegacyProbe()): noted, never failed, and it explains the
          // rejection it may have drawn.
          if (isLegacyProbe(run.revision, method)) {
            explained = true;
            const answer = legacyAnswer(run.revision, response);
            noteProbe(
              run,
              `probe:${headerVersion ?? ''}`,
              legacyProbeCheck(
                run.revision,
                headerVersion,
                answer,
                request.bodyVersion
              ),
              answer?.code !== undefined
            );
            continue;
          }
          const reason = wrongRevision(run.revision, method, headerVersion);
          if (!reason) continue;
          explained = explained || rejection !== undefined;
          sessions.recordHostedCheck(
            run,
            `revision:${method}:${headerVersion ?? ''}`,
            wrongRevisionCheck(
              run.revision,
              method,
              headerVersion,
              reason,
              rejection
            )
          );
        }
        if (rejection && !explained) {
          sessions.recordHostedCheck(
            run,
            `rejected:${rejection.code}:${rejection.message}`,
            wireRejectedCheck(rejection, request, headerVersion)
          );
        }
      }
      if (mcp && spokeRevision(run.revision, request, headerVersion, response))
        sessions.recordHostedCheck(
          run,
          'spoken',
          revisionSpokenCheck(run.revision)
        );
      if (mcp && reachedRevision(run.revision, request, headerVersion))
        sessions.recordHostedCheck(
          run,
          'reached',
          revisionReachedCheck(run.revision)
        );
      // A GET the cell serves no stream for (the scenario's own 405, or
      // fallthrough()'s): noted so the client's author sees it.
      if (mcp && httpMethod === 'GET' && response.status === 405)
        sessions.recordHostedCheck(
          run,
          'get-on-mcp',
          getOnMcpCheck(run.revision)
        );
      if (mcp && isAcceptedInitialize(request, response)) {
        // Asked for another revision, told the cell's (pinInitializeVersion()).
        const asked = request.bodyVersion;
        if (isStatefulVersion(run.revision) && asked && asked !== run.revision)
          sessions.recordHostedCheck(
            run,
            `offered:${asked}`,
            versionOfferedCheck(run.revision, asked, answeredVersion(response))
          );
      }
      // Who the client is, from accepted exchanges only.
      const identity = identityFrom(headers, body, response);
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
    // Outside the tap, so what is judged is what the client was told.
    if (mcp && req.method === 'POST' && isStatefulVersion(run.revision)) {
      pinInitializeVersion(
        res,
        run.revision,
        () => request?.methods.includes('initialize') ?? false
      );
    }

    // Raw node calls: a composite's replayed request has no express helpers.
    const sendJson = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    /** Answer a POST whose body is empty or not JSON, and note it. */
    const parseError = (empty: boolean) => {
      sessions.recordHostedCheck(
        run,
        `unparseable:${empty ? 'empty' : 'malformed'}`,
        unparseableBodyCheck(run.revision, empty, headerVersion)
      );
      sendJson(400, PARSE_ERROR_REPLY);
    };
    // An express scenario with no route for the request calls this instead
    // of answering with Express's HTML 404 (a raw listener ignores it). On
    // the MCP endpoint that is a GET the scenario serves no stream for —
    // VS Code sends one after a 400, as its old HTTP+SSE fallback — so it
    // gets the SDK transport's 405, and the cell notes it (judge()). A body
    // the scenario's JSON parser refused is a parse error, as it is before
    // dispatch, not a crash.
    const fallthrough = (err?: unknown) => {
      if (res.headersSent) return;
      if (
        err &&
        mcp &&
        (err as { type?: unknown }).type === 'entity.parse.failed'
      ) {
        parseError(false);
        return;
      }
      if (err) {
        sendJson(500, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: 'Internal error' }
        });
        return;
      }
      if (mcp && req.method === 'GET') {
        res.setHeader('allow', 'POST');
        sendJson(405, GET_ON_MCP_REPLY);
        return;
      }
      sendJson(404, { error: `Cannot ${req.method} ${req.url}` });
    };
    const handOn = () =>
      (
        listener as (
          req: Request,
          res: Response,
          next: (err?: unknown) => void
        ) => void
      )(req, res, fallthrough);

    // What every cell of a column answers alike is answered here, before the
    // scenario sees the request: a body that is empty or not JSON (a plain
    // -32700), a legacy initialize on the stateless wire (see
    // legacyInitializeReply()) and a server/discover on a dated one (see
    // discoverReply()). Not an auth cell: its resource server must answer
    // 401 before it looks at the request, and after sign-in it gives the
    // same version answers itself (auth/helpers/createServer.ts).
    if (mcp && req.method === 'POST' && !run.auxListeners) {
      if (declaresNoBody(req)) {
        parseError(true);
        return;
      }
      if (bodyFitsBuffer(req)) {
        onBodySettled(req, (captured) => {
          if (captured !== undefined && isUnparseable(captured)) {
            parseError(captured.toString().trim() === '');
            return;
          }
          const reply =
            legacyInitializeReply(run.revision, captured, headerVersion) ??
            discoverReply(run.revision, captured, headerVersion);
          if (reply) sendJson(reply.status, reply.body);
          else handOn();
        });
        return;
      }
    }
    handOn();
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
      url: `${cellBaseUrl(req, run)}${run.mcpPath || MCP_PATH}`,
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
    // The page states this deployment's lifetimes, not the defaults.
    res.type('html').send(
      renderLanding(origin(req), matrix, {
        idleMs: sessions.ttlMs,
        ...(opts.store && { store: opts.store.retention ?? {} })
      })
    );
  });

  app.get('/scenarios', (_req, res) => {
    res.json(
      matrix.rows.map((row) => ({
        name: row.scenario,
        description: row.description,
        source: row.source,
        mcpPath: row.cells[0]?.mcpPath ?? MCP_PATH,
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
  const composite = createCompositeRoute({
    matrix,
    mountCell,
    prepare,
    dispatch,
    cellBaseUrl,
    resultsUrlFor,
    isPageRequest,
    wantsHtml
  });

  app.all(/^\/s\/(.+)$/, async (req, res) => {
    const segments = segmentsOf(req.params[0]);
    const [runId, revision] = segments;

    // Several scenarios' cells behind one URL, `<a>+<b>` (see ./composite.ts).
    const tail = segments.slice(2).join('/');
    const spec = tail.endsWith(MCP_PATH)
      ? tail.slice(0, -MCP_PATH.length)
      : tail;
    const children = segments.length > 2 ? parseComposite(spec) : undefined;
    if (children) {
      if (!RUN_ID_RE.test(runId)) {
        res.status(400).json({ error: 'invalid run-id' });
        return;
      }
      if (!revisions.includes(revision)) {
        res
          .status(404)
          .json({ error: `unknown revision '${revision}'`, revisions });
        return;
      }
      await composite(
        req,
        res,
        runId,
        revision as SpecVersion,
        children,
        spec === tail ? '' : MCP_PATH
      );
      return;
    }

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

    // A browser opening the MCP URL itself is sent to the cell's page.
    if (suffix === MCP_PATH && isPageRequest(req)) {
      const q = req.originalUrl.indexOf('?');
      const page = cellBaseUrl(req, ref);
      res.redirect(303, q === -1 ? page : page + req.originalUrl.slice(q));
      return;
    }

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

    const run = mountCell(req, ref, res);
    if (!run) return;
    // Rewrite to the path the scenario expects (it thinks it's at root).
    // The query string is preserved because we keep the express req object.
    const rewritten = scenarioPath(run, suffix) || run.mcpPath || '/';
    const mcp = isMcpEndpoint(run, rewritten);
    await prepare([run], req, mcp);
    dispatch(run, run.listener, req, res, rewritten, mcp);
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
      // (or the bare well-known path when its MCP endpoint is its root).
      dispatch(
        run,
        run.listener,
        req,
        res,
        '/.well-known/oauth-protected-resource' +
          scenarioPath(run, resolved.suffix)
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
    // A frozen report: /results/<run-id>/snapshot/<snapshot-id>.
    if (revision === 'snapshot') {
      const [snapshotId] = rest;
      let body: string | undefined;
      if (segments.length === 3 && SNAPSHOT_ID_RE.test(snapshotId)) {
        try {
          body = await snapshots.loadSnapshot(runId, snapshotId);
        } catch (e) {
          console.error(
            '[hosted] snapshot:',
            e instanceof Error ? e.message : e
          );
          res
            .status(503)
            .json({ error: 'could not read the snapshot; try again' });
          return;
        }
      }
      if (body === undefined) {
        res.status(404).json({
          error: `no snapshot '${rest.join('/')}' for run '${runId}'`
        });
        return;
      }
      sendReport(req, res, relink(req, JSON.parse(body) as RunReport));
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
      const cell = matrix.cell(resolved.scenarioName, ref.revision)!;
      // A cell nobody has hit yet is a valid, incomplete cell — not an
      // unknown run: the config page links here before any traffic.
      const r =
        cell.scoring === 'n/a'
          ? undefined
          : await sessions.results(cellId(ref));
      // One row per check, as the page and the report count them.
      const { shown, ...status } = cellStatus(cell, r);
      if (wantsHtml(req)) {
        res.type('html').send(renderResults(ref, shown, status));
      } else {
        res.json({ ...summarise(ref, shown), ...status });
      }
      return;
    }

    // Run or column scope: a verdict per cell of the matrix.
    const scope = segments.length === 2 ? (revision as SpecVersion) : undefined;
    const report = await buildReport(matrix, runId, scope, reportSources(req));
    // The live page lists the run's frozen copies; nothing else needs them.
    const frozen =
      reportFormat(req) === 'html'
        ? await snapshots.listSnapshots(runId).catch(() => [])
        : undefined;
    sendReport(req, res, report, frozen);
  });

  // Freeze the run's report as it stands now: a permalink later traffic
  // cannot change, for an issue or a chat. The whole run, whichever page
  // asked. No protection beyond the run id itself, like the rest of a run.
  app.post('/results/:runId/freeze', async (req, res) => {
    const { runId } = req.params;
    if (!RUN_ID_RE.test(runId)) {
      res.status(400).json({ error: 'invalid run-id' });
      return;
    }
    const report = await buildReport(
      matrix,
      runId,
      undefined,
      reportSources(req)
    );
    const snapshotId = mintId(8);
    const frozen: RunReport = {
      ...report,
      snapshotId,
      frozenAt: report.generatedAt
    };
    try {
      await snapshots.saveSnapshot(runId, snapshotId, JSON.stringify(frozen));
    } catch (e) {
      console.error('[hosted] snapshot:', e instanceof Error ? e.message : e);
      res.status(503).json({ error: 'could not save the snapshot; try again' });
      return;
    }
    const url = resultsUrlFor(req, runId, 'snapshot', snapshotId);
    if (wantsHtml(req)) {
      res.redirect(303, `/results/${runId}/snapshot/${snapshotId}`);
      return;
    }
    res
      .status(201)
      .location(url)
      .json({
        runId,
        snapshotId,
        frozenAt: frozen.frozenAt,
        url,
        markdownUrl: `${url}?format=md`,
        textUrl: `${url}?format=text`
      });
  });

  app.delete('/results/:runId', async (req, res) => {
    if (!RUN_ID_RE.test(req.params.runId)) {
      res.status(400).json({ error: 'invalid run-id' });
      return;
    }
    await sessions.destroyRun(req.params.runId);
    await snapshots.deleteSnapshots(req.params.runId).catch((e) => {
      console.error('[hosted] snapshot:', e instanceof Error ? e.message : e);
    });
    res.status(204).end();
  });

  function reportSources(req: Request): ReportSources {
    return {
      listCells: (id) => sessions.listCells(id),
      results: (id) => sessions.results(id),
      resultsUrl: (ref) => resultsUrlFor(req, cellId(ref))
    };
  }

  /**
   * `?format=md` (or `markdown`) is the report as Markdown; `?format=text`
   * (or `plain`) as plain lines, for a chat that renders no tables.
   */
  function reportFormat(req: Request): 'html' | 'json' | 'md' | 'text' {
    const format = req.query.format;
    if (format === 'md' || format === 'markdown') return 'md';
    if (format === 'text' || format === 'plain') return 'text';
    return wantsHtml(req) ? 'html' : 'json';
  }

  /**
   * A stored report's cell links, rebuilt for this request: a snapshot
   * keeps what the run said, not the host name it was frozen through.
   */
  function relink(req: Request, report: RunReport): RunReport {
    for (const col of report.columns) {
      for (const c of [...col.cells, ...col.notScored]) {
        c.resultsUrl = resultsUrlFor(req, report.runId, c.revision, c.scenario);
      }
    }
    return report;
  }

  function sendReport(
    req: Request,
    res: Response,
    report: RunReport,
    frozen?: SnapshotInfo[]
  ): void {
    const live = report.snapshotId
      ? resultsUrlFor(req, report.runId)
      : resultsUrlFor(
          req,
          report.runId,
          ...(report.revision ? [report.revision] : [])
        );
    const snapshot = report.snapshotId
      ? resultsUrlFor(req, report.runId, 'snapshot', report.snapshotId)
      : undefined;
    const links = { live, ...(snapshot && { snapshot }) };
    const markdown = reportMarkdown(report, links);
    switch (reportFormat(req)) {
      case 'md':
        res.set('content-type', 'text/markdown; charset=utf-8').send(markdown);
        return;
      case 'text':
        res
          .set('content-type', 'text/plain; charset=utf-8')
          .send(reportText(report, links));
        return;
      case 'html':
        res.type('html').send(
          renderReport(matrix, report, {
            markdown,
            text: reportText(report, links),
            liveUrl: live,
            ...(frozen && { snapshots: frozen })
          })
        );
        return;
      default:
        res.json(reportJson(report));
    }
  }

  // A store that could not be read, even after retrying: say so and ask for
  // a retry, rather than show a report as if nothing had been recorded.
  app.use(
    (
      err: unknown,
      _req: Request,
      res: Response,
      next: (err?: unknown) => void
    ) => {
      if (!(err instanceof StoreUnavailableError)) return next(err);
      if (res.headersSent) return;
      res.status(503).json({ error: err.message });
    }
  );

  return { app, sessions, matrix };
}

export function summarise(ref: CellRef, checks: ShownCheck[]) {
  return {
    runId: ref.runId,
    revision: ref.revision,
    scenario: ref.scenarioName,
    summary: summarize(checks),
    // A not-seen FAILURE reads NOT_SEEN, so the rows count as the summary.
    checks: jsonRows(checks)
  };
}

/** What a cell's results say about the cell itself, next to its checks. */
export interface CellStatus {
  scoring: MatrixCell['scoring'];
  verdict: Verdict;
  /** Where the cell stands, finer than the verdict (see CellState). */
  state: CellState;
  /**
   * On a startable incomplete cell: why, in plain words — nothing recorded
   * yet, or the checks listed are only what the scenario still expects. On
   * a waiting cell: that it waits for the flow to finish.
   */
  note?: string;
  /** For n/a (why the scenario does not apply) and not_scored/unlisted. */
  reason?: string;
  /** Present, false, when this deployment cannot start the cell. */
  startable?: false;
  startReason?: string;
}

export function cellStatus(
  cell: MatrixCell,
  results: Pick<RunResults, 'checks' | 'recorded'> | undefined
): CellStatus & { shown: ShownCheck[] } {
  const { verdict, state, note, shown } = viewCell(cell, results);
  return {
    scoring: cell.scoring,
    verdict,
    state,
    ...(note && { note }),
    ...(cell.reason !== undefined && { reason: cell.reason }),
    ...(!cell.startable &&
      cell.scoring !== 'n/a' && {
        startable: false as const,
        ...(cell.startReason !== undefined && { startReason: cell.startReason })
      }),
    shown: shown ?? []
  };
}
