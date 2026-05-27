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
 *   POST /mcp                               Meta-MCP: list_scenarios,
 *                                           start_run, get_results
 *
 * Scenarios are mounted via Scenario.handler() — the same RequestListener the
 * CLI runner wraps in http.createServer — so there is no loopback port and
 * this works on serverless hosts. Each run gets a fresh Scenario instance.
 */

import express, { Request } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  CallToolResult
} from '@modelcontextprotocol/sdk/types.js';
import {
  SessionManager,
  UnknownScenarioError,
  NotHostableError,
  listHostableScenarios
} from './session';
import { renderLanding, renderResults } from './html';
import { getScenario } from '../scenarios';
import { ConformanceCheck } from '../types';

export interface HostedServerOptions {
  publicOrigin?: string;
  ttlMs?: number;
}

/** Only allow run-ids that are safe in a single path segment. */
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function createHostedApp(opts: HostedServerOptions = {}): {
  app: express.Application;
  sessions: SessionManager;
} {
  const sessions = new SessionManager({ ttlMs: opts.ttlMs });
  const app = express();
  const hostable = new Set(listHostableScenarios());

  function origin(req: Request): string {
    if (opts.publicOrigin) return opts.publicOrigin;
    const proto = (req.header('x-forwarded-proto') ?? req.protocol) || 'http';
    const host = req.header('x-forwarded-host') ?? req.header('host');
    return `${proto}://${host}`;
  }

  function runBaseUrl(req: Request, scenario: string, runId: string): string {
    return `${origin(req)}/s/${scenario}/${runId}`;
  }

  // ---------- discovery ----------

  app.get('/', (req, res) => {
    res.type('html').send(renderLanding(origin(req), Array.from(hostable)));
  });

  app.get('/scenarios', (_req, res) => {
    res.json(
      Array.from(hostable).map((name) => {
        const s = getScenario(name)!;
        return {
          name,
          description: s.description,
          source: s.source,
          mcpPath: s.mcpPath ?? ''
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

    // Scenario names can contain '/', so try progressively longer prefixes
    // until one matches a known scenario.
    const segments = rest.split('/');
    let nameLen = 0;
    let scenarioName = '';
    for (let i = 1; i <= segments.length; i++) {
      const candidate = segments.slice(0, i).join('/');
      if (hostable.has(candidate)) {
        scenarioName = candidate;
        nameLen = i;
        break;
      }
    }
    if (!scenarioName) {
      // Distinguish "exists but not hostable" from "unknown"
      for (let i = 1; i <= segments.length; i++) {
        if (getScenario(segments.slice(0, i).join('/'))) {
          res.status(501).json({
            error: `scenario '${segments.slice(0, i).join('/')}' is not hostable (no handler())`
          });
          return;
        }
      }
      res.status(404).json({ error: `unknown scenario '${segments[0]}'` });
      return;
    }

    const runId = segments[nameLen];
    const suffix = '/' + segments.slice(nameLen + 1).join('/');

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
          context: run.context
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

    // Advertise where results live so a client can discover them without
    // out-of-band knowledge of the URL scheme.
    res.setHeader(
      'link',
      `<${origin(req)}/results/${run.id}>; rel="conformance-results"`
    );

    // Rewrite to the path the scenario expects (it thinks it's at root).
    // The query string is preserved because we keep the express req object.
    req.url = suffix === '/' ? run.mcpPath || '/' : suffix;
    run.listener(req, res);
  });

  // ---------- results ----------

  app.get('/results/:id.html', (req, res) => {
    const run = sessions.get(req.params.id);
    const checks = sessions.results(req.params.id);
    if (!run || !checks) {
      res
        .status(404)
        .type('html')
        .send(`<p>No run <code>${req.params.id}</code></p>`);
      return;
    }
    res.type('html').send(renderResults(run.scenarioName, run.id, checks));
  });

  app.get('/results/:id', (req, res) => {
    const run = sessions.get(req.params.id);
    const checks = sessions.results(req.params.id);
    if (!run || !checks) {
      res.status(404).json({ error: 'unknown run' });
      return;
    }
    res.json(summarise(run.scenarioName, run.id, checks));
  });

  app.delete('/results/:id', async (req, res) => {
    await sessions.destroy(req.params.id);
    res.status(204).end();
  });

  // ---------- meta MCP server ----------

  app.post('/mcp', express.json(), async (req, res) => {
    const server = createMetaMcpServer(sessions, origin(req), (s, id) =>
      runBaseUrl(req, s, id)
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => {
      transport.close();
      server.close();
    });
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

function createMetaMcpServer(
  sessions: SessionManager,
  publicOrigin: string,
  runBaseUrl: (scenario: string, runId: string) => string
): Server {
  const server = new Server(
    { name: 'mcp-conformance-hosted', version: '0.2.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'list_scenarios',
        description:
          'List client-conformance scenarios this hosted instance can serve.',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'start_run',
        description:
          'Create a fresh run for a scenario and return the MCP URL to point ' +
          'the client-under-test at, plus the results URL. The run-id is ' +
          'embedded in the path so this works with stateless transports.',
        inputSchema: {
          type: 'object',
          properties: {
            scenario: {
              type: 'string',
              description: 'Scenario name, e.g. "initialize" or "tools_call".'
            },
            run_id: {
              type: 'string',
              description:
                'Optional. Supply your own [A-Za-z0-9_-]{1,64} id; ' +
                'otherwise one is generated.'
            }
          },
          required: ['scenario']
        }
      },
      {
        name: 'get_results',
        description:
          'Fetch the conformance checks recorded for a run. Same shape as ' +
          'GET /results/<id>.',
        inputSchema: {
          type: 'object',
          properties: { run_id: { type: 'string' } },
          required: ['run_id']
        }
      }
    ]
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> => {
      const args = (request.params.arguments ?? {}) as Record<string, string>;
      switch (request.params.name) {
        case 'list_scenarios':
          return text(
            JSON.stringify(
              listHostableScenarios().map((name) => ({
                name,
                description: getScenario(name)!.description
              })),
              null,
              2
            )
          );

        case 'start_run': {
          if (args.run_id && !RUN_ID_RE.test(args.run_id)) {
            return errorText(`invalid run_id (must match ${RUN_ID_RE})`);
          }
          try {
            const run = sessions.getOrCreate(args.scenario, args.run_id, (id) =>
              runBaseUrl(args.scenario, id)
            );
            return text(
              JSON.stringify(
                {
                  runId: run.id,
                  mcpUrl: `${runBaseUrl(run.scenarioName, run.id)}${run.mcpPath}`,
                  resultsUrl: `${publicOrigin}/results/${run.id}`,
                  resultsHtmlUrl: `${publicOrigin}/results/${run.id}.html`,
                  context: run.context
                },
                null,
                2
              )
            );
          } catch (e) {
            if (
              e instanceof UnknownScenarioError ||
              e instanceof NotHostableError
            ) {
              return errorText(e.message);
            }
            throw e;
          }
        }

        case 'get_results': {
          const run = sessions.get(args.run_id);
          const checks = sessions.results(args.run_id);
          if (!run || !checks) return errorText(`no run '${args.run_id}'`);
          return text(
            JSON.stringify(summarise(run.scenarioName, run.id, checks), null, 2)
          );
        }

        default:
          return errorText(`unknown tool ${request.params.name}`);
      }
    }
  );

  return server;
}

function text(t: string): CallToolResult {
  return { content: [{ type: 'text', text: t }] };
}

function errorText(t: string): CallToolResult {
  return { content: [{ type: 'text', text: t }], isError: true };
}
