/**
 * Hosted conformance server — direct-mount, no loopback proxy.
 *
 * URL scheme (run-id is path-embedded so stateless-transport clients work):
 *
 *   ALL  /s/<scenario>/<run-id>[/<suffix>]  Mounted scenario handler. The run
 *                                           is created lazily on first hit;
 *                                           pick any <run-id> you like.
 *   GET  /s/<scenario>                      Convenience: mints a fresh run-id
 *                                           and returns {mcpUrl, resultsUrl}.
 *   GET  /results/<run-id>                  JSON {summary, checks}
 *   GET  /results/<run-id>.html             Pretty HTML report
 *   GET  /scenarios                         JSON list of hostable scenarios
 *   GET  /                                  Landing page
 *
 * Scenarios are mounted via Scenario.handler() — the same RequestListener the
 * CLI runner wraps in http.createServer — so there is no loopback port and
 * this works on serverless hosts. Each run gets a fresh Scenario instance.
 */

import express, { Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import {
  SessionManager,
  HostedRun,
  UnknownScenarioError,
  NotHostableError,
  listHostableScenarios
} from './session';
import { renderLanding, renderResults } from './html';
import type { RunStore } from './store';
import { getScenario } from '../scenarios';
import { ConformanceCheck, AuxOriginRole } from '../types';

export interface HostedServerOptions {
  publicOrigin?: string;
  ttlMs?: number;
  /**
   * Public origins of the AS/IdP relay deployments. When set, scenarios that
   * implement `authHandlers()` become hostable; their per-run AS issuer is
   * `<auxOrigins.as>/r/<run-id>`. See examples/hosted/valtown-relay.ts.
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
}

/** Only allow run-ids that are safe in a single path segment. */
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const AUX_ROLES: readonly AuxOriginRole[] = ['as', 'as2', 'idp'];

export function createHostedApp(opts: HostedServerOptions = {}): {
  app: express.Application;
  sessions: SessionManager;
} {
  const auxOrigins = opts.auxOrigins ?? {};
  const haveAux = AUX_ROLES.filter((r) => auxOrigins[r]);
  const sessions = new SessionManager({
    ttlMs: opts.ttlMs,
    auxOrigins,
    store: opts.store
  });
  const app = express();
  const hostable = new Set(listHostableScenarios(haveAux));

  function origin(req: Request): string {
    if (opts.publicOrigin) return opts.publicOrigin;
    const proto = (req.header('x-forwarded-proto') ?? req.protocol) || 'http';
    const host = req.header('x-forwarded-host') ?? req.header('host');
    return `${proto}://${host}`;
  }

  function runBaseUrl(req: Request, scenario: string, runId: string): string {
    return `${origin(req)}/s/${scenario}/${runId}`;
  }

  /**
   * Resolve "<scenario...>/<runId>/<suffix...>" against the hostable set.
   * Scenario names may contain '/', so try progressively longer prefixes.
   * Returns undefined if no hostable scenario matches the prefix.
   */
  function resolveRun(rest: string):
    | {
        scenarioName: string;
        runId: string | undefined;
        suffix: string;
      }
    | undefined {
    const segments = rest.split('/');
    for (let i = 1; i <= segments.length; i++) {
      const candidate = segments.slice(0, i).join('/');
      if (hostable.has(candidate)) {
        const runId = segments[i] || undefined;
        const suffix = '/' + segments.slice(i + 1).join('/');
        return { scenarioName: candidate, runId, suffix };
      }
    }
    return undefined;
  }

  /**
   * Dispatch (req, res) to `listener` after rewriting `req.url` so the
   * scenario sees the path it would have under start()/stop() — i.e. with
   * the run-prefix stripped and (for well-known dispatch) the well-known
   * prefix re-prepended.
   */
  function dispatch(
    run: HostedRun,
    listener: (req: Request, res: Response) => void,
    req: Request,
    res: Response,
    rewrittenUrl: string
  ) {
    res.setHeader(
      'link',
      `<${origin(req)}/results/${run.id}>; rel="conformance-results"`
    );
    req.url = rewrittenUrl;
    if (sessions.store) {
      // Write this process's view through once the scenario has answered
      // (hosted scenarios record their checks before calling end()).
      // Serverless entry points should await sessions.flush() before
      // returning the response so this write isn't abandoned.
      const end = res.end;
      res.end = function (this: Response, ...args: unknown[]) {
        const out = (end as (...a: unknown[]) => Response).apply(this, args);
        void sessions.persist(run);
        return out;
      } as Response['end'];
    }
    listener(req, res);
  }

  // ---------- discovery ----------

  app.get('/', (req, res) => {
    res
      .type('html')
      .send(
        renderLanding(
          origin(req),
          Array.from(hostable),
          (name) => getScenario(name)?.steps
        )
      );
  });

  app.get('/scenarios', (_req, res) => {
    res.json(
      Array.from(hostable).map((name) => {
        const s = getScenario(name)!;
        return {
          name,
          description: s.description,
          source: s.source,
          mcpPath: s.mcpPath ?? '',
          ...(s.steps && { steps: s.steps })
        };
      })
    );
  });

  // ---------- scenario mounting ----------
  //
  // We can't pre-register an express route per (scenario, run-id) because
  // run-ids are open-ended. Instead a single catch-all route resolves the
  // run, rewrites req.url to strip the /s/<scenario>/<id> prefix, and hands
  // off to the run's listener — exactly what app.use(prefix, fn) would do,
  // but with a dynamic prefix.

  app.all(/^\/s\/(.+)$/, (req, res, next) => {
    const rest = req.params[0]; // "<scenario...>/<runId>/<suffix...>"
    const resolved = resolveRun(rest);
    if (!resolved) {
      // Distinguish "exists but not hostable" from "unknown"
      const segments = rest.split('/');
      for (let i = 1; i <= segments.length; i++) {
        if (getScenario(segments.slice(0, i).join('/'))) {
          res.status(501).json({
            error: `scenario '${segments.slice(0, i).join('/')}' is not hostable here`
          });
          return;
        }
      }
      res.status(404).json({ error: `unknown scenario '${segments[0]}'` });
      return;
    }
    const { scenarioName, runId, suffix } = resolved;

    // GET /s/<scenario> with no run-id → mint one and tell the caller where
    // to point their client.
    if (!runId) {
      if (req.method !== 'GET') {
        res.status(400).json({
          error:
            'Missing run-id. Use /s/<scenario>/<run-id>, or GET /s/<scenario> to mint one.'
        });
        return;
      }
      try {
        const run = sessions.getOrCreate(scenarioName, undefined, (id) =>
          runBaseUrl(req, scenarioName, id)
        );
        res.json({
          runId: run.id,
          mcpUrl: `${runBaseUrl(req, scenarioName, run.id)}${run.mcpPath}`,
          resultsUrl: `${origin(req)}/results/${run.id}`,
          resultsHtmlUrl: `${origin(req)}/results/${run.id}.html`,
          context: contextFor(run)
        });
      } catch (e) {
        next(e);
      }
      return;
    }

    if (!RUN_ID_RE.test(runId)) {
      res.status(400).json({ error: 'invalid run-id' });
      return;
    }

    let run;
    try {
      run = sessions.getOrCreate(scenarioName, runId, (id) =>
        runBaseUrl(req, scenarioName, id)
      );
    } catch (e) {
      if (e instanceof UnknownScenarioError || e instanceof NotHostableError) {
        res.status(400).json({ error: e.message });
        return;
      }
      throw e;
    }

    // Rewrite to the path the scenario expects (it thinks it's at root).
    // The query string is preserved because we keep the express req object.
    dispatch(
      run,
      run.listener,
      req,
      res,
      suffix === '/' ? run.mcpPath || '/' : suffix
    );
  });

  // ---------- root well-known dispatch (RS side) ----------
  //
  // RFC 9728: a client given MCP URL <origin>/s/<scn>/<id>/mcp derives the PRM
  // URL as <origin>/.well-known/oauth-protected-resource/s/<scn>/<id>/mcp —
  // i.e. at the *origin root*, not under the run prefix. We catch that here,
  // recover (scenario, run-id) from the path suffix, and re-dispatch to the
  // run's RS handler with the path it would have seen on its own origin.
  //
  // Requests that arrive *under* the run prefix (because the WWW-Authenticate
  // header points there) already work via the /s/* mount above.

  app.get(/^\/\.well-known\/oauth-protected-resource\/s\/(.+)$/, (req, res) => {
    const resolved = resolveRun(req.params[0]);
    if (!resolved?.runId || !RUN_ID_RE.test(resolved.runId)) {
      res.status(404).json({ error: 'no run for this resource path' });
      return;
    }
    // getOrCreate, not get: on a multi-process host this may be the first
    // request this process sees for the run.
    let run;
    try {
      run = sessions.getOrCreate(resolved.scenarioName, resolved.runId, (id) =>
        runBaseUrl(req, resolved.scenarioName, id)
      );
    } catch {
      res.status(404).json({ error: 'no run for this resource path' });
      return;
    }
    // Scenario expects e.g. '/.well-known/oauth-protected-resource/mcp'
    const rewritten =
      '/.well-known/oauth-protected-resource' +
      (resolved.suffix === '/' ? '' : resolved.suffix);
    dispatch(run, run.listener, req, res, rewritten);
  });

  // ---------- aux-origin backchannel (relay target) ----------
  //
  // The AS relay (examples/hosted/valtown-relay.ts) forwards every request it
  // receives to <this-origin>/__aux/<role><path>. The per-run AS issuer is
  // <relay-origin>/r/<run-id>, so every path the client hits — endpoints
  // (/r/<id>/authorize) and RFC 8414 well-known
  // (/.well-known/oauth-authorization-server/r/<id>[/tenant]) — carries
  // `/r/<id>` somewhere in it. We extract the id, strip that segment, and
  // dispatch to the run's aux handler so it sees exactly the path
  // createAuthServer registered.
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

    app.all(/^\/__aux\/([a-z0-9]+)(\/.*)$/, async (req, res) => {
      if (!guard(req, res)) return;
      const role = req.params[0] as AuxOriginRole;
      const path = req.params[1];
      if (!AUX_ROLES.includes(role)) {
        res.status(404).json({ error: `unknown aux role '${role}'` });
        return;
      }

      // Find the first /r/<run-id> segment pair anywhere in the path and
      // excise it. Plain segment splitting: a regex over the whole path would
      // backtrack polynomially on adversarial input.
      const segments = path.split('/'); // path starts with '/', so [0] === ''
      let rIdx = -1;
      for (let i = 1; i < segments.length - 1; i++) {
        if (segments[i] === 'r' && RUN_ID_RE.test(segments[i + 1])) {
          rIdx = i;
          break;
        }
      }
      if (rIdx < 0) {
        res
          .status(404)
          .json({ error: 'aux request path missing /r/<run-id> segment' });
        return;
      }
      const prefix = segments.slice(0, rIdx).join('/');
      const runId = segments[rIdx + 1];
      const rest = segments.slice(rIdx + 2);
      const suffix = rest.length ? '/' + rest.join('/') : '';
      const search = req.url.includes('?')
        ? req.url.slice(req.url.indexOf('?'))
        : '';

      const run = await sessions.ensure(runId, (s, id) =>
        runBaseUrl(req, s, id)
      );
      const listener = run?.auxListeners?.[role];
      if (!run || !listener) {
        res.status(404).json({ error: `no aux '${role}' handler for run` });
        return;
      }
      dispatch(run, listener, req, res, (prefix + suffix || '/') + search);
    });
  }

  // ---------- results ----------

  app.get('/results/:id.html', async (req, res) => {
    const r = await sessions.results(req.params.id);
    if (!r) {
      res
        .status(404)
        .type('html')
        .send(`<p>No run <code>${escapeId(req.params.id)}</code></p>`);
      return;
    }
    res
      .type('html')
      .send(renderResults(r.scenarioName, req.params.id, r.checks));
  });

  app.get('/results/:id', async (req, res) => {
    const r = await sessions.results(req.params.id);
    if (!r) {
      res.status(404).json({ error: 'unknown run' });
      return;
    }
    res.json(summarise(r.scenarioName, req.params.id, r.checks));
  });

  app.delete('/results/:id', async (req, res) => {
    await sessions.destroy(req.params.id);
    res.status(204).end();
  });

  return { app, sessions };
}

function summarise(scenario: string, id: string, checks: ConformanceCheck[]) {
  const counts = { SUCCESS: 0, FAILURE: 0, WARNING: 0, SKIPPED: 0, INFO: 0 };
  for (const c of checks) counts[c.status]++;
  return {
    runId: id,
    scenario,
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

/**
 * The context blob a client-under-test needs (pre-registered credentials
 * etc.), tagged with the scenario name the way the CLI runner's
 * MCP_CONFORMANCE_CONTEXT is, so it can be passed through verbatim.
 */
function contextFor(run: HostedRun): Record<string, unknown> | undefined {
  return run.context ? { name: run.scenarioName, ...run.context } : undefined;
}

function escapeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '');
}
