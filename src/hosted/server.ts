/**
 * Hosted conformance server.
 *
 * Mounts every (non-auth) client-testing scenario at a stable path:
 *
 *   POST /s/<scenario>      MCP endpoint — first request creates a session,
 *                           subsequent requests reuse it via mcp-session-id
 *   GET  /results/<id>      JSON ConformanceCheck[] for that session
 *   GET  /results/<id>.html Pretty HTML report
 *   GET  /scenarios         JSON list of hostable scenarios
 *   GET  /                  Landing page with usage instructions
 *   POST /mcp               The hosted server is itself an MCP server
 *                           exposing list_scenarios / start_session /
 *                           get_results tools.
 *
 * Under the hood each session is a real Scenario instance listening on a
 * loopback port; requests are proxied. That means ~90% of scenarios work
 * unchanged. Auth scenarios are excluded because they need a second
 * publicly-reachable origin for the authorization server.
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
  listHostableScenarios
} from './session';
import { proxyToSession, SESSION_HEADER } from './proxy';
import { renderLanding, renderResults } from './html';
import { getScenario } from '../scenarios';
import { ConformanceCheck } from '../types';

export interface HostedServerOptions {
  /** Public origin (scheme+host+port) used in generated links. Auto-detected from Host header if omitted. */
  publicOrigin?: string;
  ttlMs?: number;
}

export function createHostedApp(opts: HostedServerOptions = {}): {
  app: express.Application;
  sessions: SessionManager;
} {
  const sessions = new SessionManager({ ttlMs: opts.ttlMs });
  const app = express();

  // Only parse JSON on the routes that need it; keep the proxy route raw so
  // streaming bodies (and non-JSON content types) pass through untouched.
  const jsonBody = express.json();

  function origin(req: Request): string {
    if (opts.publicOrigin) return opts.publicOrigin;
    const proto = (req.header('x-forwarded-proto') ?? req.protocol) || 'http';
    const host = req.header('x-forwarded-host') ?? req.header('host');
    return `${proto}://${host}`;
  }

  // ---------- discovery ----------

  app.get('/', (req, res) => {
    res.type('html').send(renderLanding(origin(req), listHostableScenarios()));
  });

  app.get('/scenarios', (_req, res) => {
    const list = listHostableScenarios().map((name) => {
      const s = getScenario(name)!;
      return { name, description: s.description, source: s.source };
    });
    res.json(list);
  });

  // ---------- scenario proxy ----------

  // Match the scenario name plus any trailing sub-path (some scenarios serve
  // /mcp, others /, some auth-adjacent ones serve well-known paths).
  // Use a regex param so names containing '/' still work as a single segment
  // group while the suffix captures everything after it.
  app.all(/^\/s\/(.+?)(\/.*)?$/, jsonBody, async (req, res) => {
    const scenarioName = req.params[0];
    const suffix = req.params[1] ?? '';

    if (!getScenario(scenarioName)) {
      res.status(404).json({ error: `unknown scenario '${scenarioName}'` });
      return;
    }

    const incomingId = req.header(SESSION_HEADER);
    let session = incomingId ? sessions.get(incomingId) : undefined;

    if (session && session.scenarioName !== scenarioName) {
      // Client is reusing a session id against a different scenario path.
      // Treat as a new session rather than silently mixing checks.
      session = undefined;
    }

    if (!session) {
      try {
        session = await sessions.create(scenarioName);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        res.status(500).json({ error: msg });
        return;
      }
      // Tell the client where to find its results without making it parse the
      // session id out of the response headers.
      res.setHeader(
        'link',
        `<${origin(req)}/results/${session.id}>; rel="conformance-results"`
      );
    }

    // If the client appended a sub-path (/.well-known/..., /mcp, ...) honour
    // it; otherwise hit whatever path the scenario advertised in serverUrl.
    const targetPath = suffix || undefined;
    proxyToSession(session, req, res, targetPath);
  });

  // ---------- results ----------

  app.get('/results/:id.html', (req, res) => {
    const id = req.params.id;
    const session = sessions.get(id);
    const checks = sessions.results(id);
    if (!session || !checks) {
      res.status(404).type('html').send(`<p>No session <code>${id}</code></p>`);
      return;
    }
    res.type('html').send(renderResults(session.scenarioName, id, checks));
  });

  app.get('/results/:id', (req, res) => {
    const checks = sessions.results(req.params.id);
    if (!checks) {
      res.status(404).json({ error: 'unknown session' });
      return;
    }
    res.json(summarise(req.params.id, checks));
  });

  app.delete('/results/:id', async (req, res) => {
    await sessions.destroy(req.params.id);
    res.status(204).end();
  });

  // ---------- meta MCP server ----------

  app.post('/mcp', jsonBody, async (req, res) => {
    const server = createMetaMcpServer(sessions, origin(req));
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

function summarise(id: string, checks: ConformanceCheck[]) {
  const counts = { SUCCESS: 0, FAILURE: 0, WARNING: 0, SKIPPED: 0, INFO: 0 };
  for (const c of checks) counts[c.status]++;
  return {
    sessionId: id,
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
 * The hosted server is itself an MCP server so an agent can drive the whole
 * flow over MCP: discover scenarios, mint a session URL, then fetch results.
 */
function createMetaMcpServer(
  sessions: SessionManager,
  publicOrigin: string
): Server {
  const server = new Server(
    { name: 'mcp-conformance-hosted', version: '0.1.0' },
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
        name: 'start_session',
        description:
          'Create a fresh session for a scenario and return the MCP URL to point the client-under-test at, plus the results URL.',
        inputSchema: {
          type: 'object',
          properties: {
            scenario: {
              type: 'string',
              description: 'Scenario name, e.g. "initialize" or "tools_call".'
            }
          },
          required: ['scenario']
        }
      },
      {
        name: 'get_results',
        description:
          'Fetch the conformance checks recorded for a session. Returns the same shape as GET /results/<id>.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string' }
          },
          required: ['session_id']
        }
      }
    ]
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> => {
      const args = (request.params.arguments ?? {}) as Record<string, string>;
      switch (request.params.name) {
        case 'list_scenarios': {
          const list = listHostableScenarios().map((name) => ({
            name,
            description: getScenario(name)!.description
          }));
          return text(JSON.stringify(list, null, 2));
        }
        case 'start_session': {
          try {
            const session = await sessions.create(args.scenario);
            return text(
              JSON.stringify(
                {
                  sessionId: session.id,
                  mcpUrl: `${publicOrigin}/s/${session.scenarioName}`,
                  resultsUrl: `${publicOrigin}/results/${session.id}`,
                  resultsHtmlUrl: `${publicOrigin}/results/${session.id}.html`,
                  context: session.context,
                  note:
                    'Point your client at mcpUrl and include header ' +
                    `"${SESSION_HEADER}: ${session.id}" on every request.`
                },
                null,
                2
              )
            );
          } catch (e) {
            if (e instanceof UnknownScenarioError) {
              return {
                content: [{ type: 'text', text: e.message }],
                isError: true
              };
            }
            throw e;
          }
        }
        case 'get_results': {
          const checks = sessions.results(args.session_id);
          if (!checks) {
            return {
              content: [
                { type: 'text', text: `No session '${args.session_id}'` }
              ],
              isError: true
            };
          }
          return text(
            JSON.stringify(summarise(args.session_id, checks), null, 2)
          );
        }
        default:
          return {
            content: [
              { type: 'text', text: `Unknown tool ${request.params.name}` }
            ],
            isError: true
          };
      }
    }
  );

  return server;
}

function text(t: string): CallToolResult {
  return { content: [{ type: 'text', text: t }] };
}
