/**
 * MCP conformance — val.town deployment.
 *
 * val.town can't bind loopback ports, so the proxy approach used by
 * `conformance hosted` doesn't apply. This file instead re-implements a small
 * set of scenarios as pure Request→Response handlers and serves them with the
 * same URL shape:
 *
 *   POST /s/<scenario>      MCP endpoint (session created on first request)
 *   GET  /results/<id>      JSON checks
 *   GET  /results/<id>.html HTML report
 *   GET  /scenarios         JSON scenario list
 *   POST /mcp               meta-MCP server (list_scenarios / get_results)
 *
 * Deploy: paste this file into a val.town HTTP val. State lives in module
 * scope, which val.town keeps warm between requests; for durable storage swap
 * `sessions` for `import { sqlite } from "https://esm.town/v/std/sqlite"`.
 *
 * Coverage is intentionally narrow (initialize, tools_call). Add more
 * handlers to the `scenarios` map below as needed.
 */

// --- types (inlined so this file is self-contained) -------------------------

type CheckStatus = 'SUCCESS' | 'FAILURE' | 'WARNING' | 'SKIPPED' | 'INFO';

interface ConformanceCheck {
  id: string;
  name: string;
  description: string;
  status: CheckStatus;
  timestamp: string;
  specReferences?: { id: string; url?: string }[];
  details?: Record<string, unknown>;
  errorMessage?: string;
}

interface Session {
  id: string;
  scenario: string;
  checks: ConformanceCheck[];
  createdAt: number;
}

type JsonRpc = {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: any;
};

type ScenarioHandler = (msg: JsonRpc, session: Session) => object;

// --- state -----------------------------------------------------------------

const NEGOTIABLE = ['2025-06-18', '2025-11-25', 'DRAFT-2026-v1'];
const sessions = new Map<string, Session>();

function newSession(scenario: string): Session {
  const id = crypto.randomUUID().slice(0, 8);
  const s: Session = { id, scenario, checks: [], createdAt: Date.now() };
  sessions.set(id, s);
  return s;
}

function push(s: Session, c: Omit<ConformanceCheck, 'timestamp'>): void {
  s.checks.push({ ...c, timestamp: new Date().toISOString() });
}

// --- scenario handlers -----------------------------------------------------

const scenarios: Record<
  string,
  { description: string; handle: ScenarioHandler }
> = {
  initialize: {
    description: 'Tests MCP client initialization handshake',
    handle(msg, s) {
      if (msg.method === 'initialize') {
        const p = msg.params ?? {};
        const ok =
          typeof p.protocolVersion === 'string' &&
          p.clientInfo?.name &&
          p.clientInfo?.version;
        push(s, {
          id: 'mcp-client-initialization',
          name: 'MCPClientInitialization',
          description:
            'Validates that MCP client properly initializes with server',
          status: ok ? 'SUCCESS' : 'FAILURE',
          specReferences: [
            {
              id: 'MCP-Lifecycle',
              url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle'
            }
          ],
          details: {
            protocolVersionSent: p.protocolVersion,
            clientName: p.clientInfo?.name,
            clientVersion: p.clientInfo?.version
          },
          errorMessage: ok ? undefined : 'missing protocolVersion or clientInfo'
        });
        const v = NEGOTIABLE.includes(p.protocolVersion)
          ? p.protocolVersion
          : '2025-11-25';
        return {
          protocolVersion: v,
          serverInfo: { name: 'conformance-valtown', version: '0.1.0' },
          capabilities: {}
        };
      }
      return {};
    }
  },

  tools_call: {
    description: 'Tests calling tools with various parameter types',
    handle(msg, s) {
      if (msg.method === 'initialize') {
        return {
          protocolVersion: '2025-11-25',
          serverInfo: { name: 'add-numbers-server', version: '1.0.0' },
          capabilities: { tools: {} }
        };
      }
      if (msg.method === 'tools/list') {
        return {
          tools: [
            {
              name: 'add_numbers',
              description: 'Add two numbers together',
              inputSchema: {
                type: 'object',
                properties: { a: { type: 'number' }, b: { type: 'number' } },
                required: ['a', 'b']
              }
            }
          ]
        };
      }
      if (msg.method === 'tools/call' && msg.params?.name === 'add_numbers') {
        const { a, b } = msg.params.arguments ?? {};
        const ok = typeof a === 'number' && typeof b === 'number';
        push(s, {
          id: 'tool-add-numbers',
          name: 'ToolAddNumbers',
          description: 'Validates that the add_numbers tool works correctly',
          status: ok ? 'SUCCESS' : 'FAILURE',
          specReferences: [
            {
              id: 'MCP-Tools',
              url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/tools#calling-tools'
            }
          ],
          details: { a, b, result: ok ? a + b : undefined }
        });
        return {
          content: [
            {
              type: 'text',
              text: ok ? `The sum of ${a} and ${b} is ${a + b}` : 'bad args'
            }
          ]
        };
      }
      return {};
    }
  }
};

// --- meta MCP (the hosted server is itself an MCP server) ------------------

function metaMcp(msg: JsonRpc, origin: string): object {
  if (msg.method === 'initialize') {
    return {
      protocolVersion: '2025-11-25',
      serverInfo: { name: 'mcp-conformance-hosted', version: '0.1.0' },
      capabilities: { tools: {} }
    };
  }
  if (msg.method === 'tools/list') {
    return {
      tools: [
        {
          name: 'list_scenarios',
          description: 'List hostable scenarios.',
          inputSchema: { type: 'object', properties: {} }
        },
        {
          name: 'get_results',
          description: 'Fetch checks for a session.',
          inputSchema: {
            type: 'object',
            properties: { session_id: { type: 'string' } },
            required: ['session_id']
          }
        }
      ]
    };
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params ?? {};
    if (name === 'list_scenarios') {
      const list = Object.entries(scenarios).map(([n, s]) => ({
        name: n,
        description: s.description,
        mcpUrl: `${origin}/s/${n}`
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify(list, null, 2) }]
      };
    }
    if (name === 'get_results') {
      const sess = sessions.get(args.session_id);
      if (!sess)
        return {
          content: [{ type: 'text', text: `no session '${args.session_id}'` }],
          isError: true
        };
      return {
        content: [
          { type: 'text', text: JSON.stringify(summarise(sess), null, 2) }
        ]
      };
    }
    return {
      content: [{ type: 'text', text: `unknown tool ${name}` }],
      isError: true
    };
  }
  return {};
}

// --- http glue -------------------------------------------------------------

function summarise(s: Session) {
  const n = (st: CheckStatus) => s.checks.filter((c) => c.status === st).length;
  return {
    sessionId: s.id,
    scenario: s.scenario,
    summary: {
      passed: n('SUCCESS'),
      failed: n('FAILURE'),
      warnings: n('WARNING'),
      total: s.checks.length
    },
    checks: s.checks
  };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }
  });
}

function rpcOk(
  id: JsonRpc['id'],
  result: object,
  headers: HeadersInit = {}
): Response {
  return json({ jsonrpc: '2.0', id, result }, { headers });
}

export default async function (req: Request): Promise<Response> {
  const url = new URL(req.url);
  const origin = `${url.protocol}//${url.host}`;

  // GET /
  if (url.pathname === '/' && req.method === 'GET') {
    const rows = Object.keys(scenarios)
      .map(
        (n) =>
          `<tr><td><code>${n}</code></td><td><code>${origin}/s/${n}</code></td></tr>`
      )
      .join('');
    return new Response(
      `<!doctype html><meta charset=utf-8><title>MCP conformance</title>` +
        `<style>body{font:14px system-ui;max-width:720px;margin:2rem auto}</style>` +
        `<h1>MCP conformance (val.town)</h1>` +
        `<p>Point your client at a scenario URL. Read <code>mcp-session-id</code> ` +
        `from the response, then GET <code>/results/&lt;id&gt;</code>.</p>` +
        `<p>Meta MCP server: <code>${origin}/mcp</code></p>` +
        `<table>${rows}</table>`,
      { headers: { 'content-type': 'text/html' } }
    );
  }

  // GET /scenarios
  if (url.pathname === '/scenarios') {
    return json(
      Object.entries(scenarios).map(([name, s]) => ({
        name,
        description: s.description
      }))
    );
  }

  // /results/<id>[.html]
  const r = url.pathname.match(/^\/results\/([^/.]+)(\.html)?$/);
  if (r) {
    const s = sessions.get(r[1]);
    if (!s) return json({ error: 'unknown session' }, { status: 404 });
    if (r[2]) {
      const items = s.checks
        .map(
          (c) =>
            `<div style="border:1px solid #ddd;padding:.5rem;margin:.5rem 0">` +
            `<b>${c.status}</b> <code>${c.id}</code> — ${c.description}` +
            (c.errorMessage ? `<br><small>${c.errorMessage}</small>` : '') +
            `</div>`
        )
        .join('');
      return new Response(`<!doctype html><h1>${s.scenario}</h1>${items}`, {
        headers: { 'content-type': 'text/html' }
      });
    }
    return json(summarise(s));
  }

  // POST /mcp — meta server
  if (url.pathname === '/mcp' && req.method === 'POST') {
    const msg = (await req.json()) as JsonRpc;
    if (msg.id === undefined) return new Response(null, { status: 202 });
    return rpcOk(msg.id, metaMcp(msg, origin));
  }

  // /s/<scenario>
  const m = url.pathname.match(/^\/s\/([^/]+)/);
  if (m) {
    const name = m[1];
    const handler = scenarios[name];
    if (!handler)
      return json({ error: `unknown scenario '${name}'` }, { status: 404 });

    if (req.method === 'GET') {
      // SSE endpoint — minimal keep-alive so SDK clients that open a GET stream don't error.
      return new Response('data: \n\n', {
        headers: { 'content-type': 'text/event-stream' }
      });
    }
    if (req.method === 'DELETE') return new Response(null, { status: 200 });
    if (req.method !== 'POST')
      return new Response('Method Not Allowed', { status: 405 });

    const sid = req.headers.get('mcp-session-id');
    let session = sid ? sessions.get(sid) : undefined;
    if (!session || session.scenario !== name) session = newSession(name);

    const msg = (await req.json()) as JsonRpc;
    push(session, {
      id: 'incoming-request',
      name: 'IncomingRequest',
      description: `Received ${msg.method ?? 'notification'}`,
      status: 'INFO',
      details: { method: msg.method, params: msg.params }
    });

    // notifications: no response body
    if (msg.id === undefined) {
      return new Response(null, {
        status: 202,
        headers: { 'mcp-session-id': session.id }
      });
    }

    const result = handler.handle(msg, session);
    return rpcOk(msg.id, result, {
      'mcp-session-id': session.id,
      link: `<${origin}/results/${session.id}>; rel="conformance-results"`
    });
  }

  return new Response('not found', { status: 404 });
}
