/**
 * Stateless conformance gauntlet — one MCP server, many validating tools.
 *
 * Unlike the per-aspect scenarios, this is a single stateless server a client
 * connects to once. Every tool validates some aspect of the request that
 * carried it; transport-level obligations (Accept header, content type,
 * MCP-Protocol-Version) are validated on every POST before dispatch. The
 * conformance contract is self-evident:
 *
 *   list tools, call each one with valid arguments — if nothing errors,
 *   the client passed everything this server can observe per-request.
 *
 * There is intentionally NO cross-request state: each request is judged on
 * its own content, so the server can run on serverless hosts (val.town)
 * where consecutive requests may land on different isolates, and no run-id
 * or results polling is needed. Checks are still recorded for the runner /
 * hosted results view, but a misbehaving client finds out immediately
 * because its own request fails with an explanation.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import express, { Request, Response } from 'express';
import { createHash } from 'crypto';
import type { ConformanceCheck } from '../../types';
import { HandlerScenario, DRAFT_PROTOCOL_VERSION } from '../../types';

const SPEC_HTTP = {
  id: 'MCP-Streamable-HTTP',
  url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http'
};
const SPEC_TOOLS = {
  id: 'MCP-Tools',
  url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/tools#calling-tools'
};

/**
 * The draft wire string and its planned release date are treated as the same
 * version: clients built against the dated release string must pass against
 * a server that predates the rename (and vice versa).
 */
const DRAFT_VERSION_ALIASES = [DRAFT_PROTOCOL_VERSION, '2026-07-28'];

const CLASSIC_PROTOCOL_VERSIONS = ['2025-03-26', '2025-06-18', '2025-11-25'];

const KNOWN_PROTOCOL_VERSIONS = [
  ...CLASSIC_PROTOCOL_VERSIONS,
  ...DRAFT_VERSION_ALIASES
];

function isDraftVersion(v: unknown): boolean {
  return DRAFT_VERSION_ALIASES.includes(String(v));
}

/** Versions compare equal across the draft/release-date alias. */
function sameVersion(a: unknown, b: unknown): boolean {
  return (
    String(a) === String(b) || (isDraftVersion(a) && isDraftVersion(b))
  );
}

const META_NS = 'io.modelcontextprotocol/';

/**
 * The bearer token minted by the consent interstitial. The token IS the
 * message: every subsequent request from the consented client carries
 * `Authorization: Bearer this-client-led-with-initialize`, so request logs,
 * proxies, and the readiness report can all state the fact directly.
 */
const CONSENT_TOKEN = 'this-client-led-with-initialize';

/** What clients see in serverInfo — one val, one spec version. */
const SERVER_INFO = { name: 'mcp-checker-2026-07-28', version: '1.0.0' };

// ---------------------------------------------------------------------------
// MRTR (SEP-2322) — multi-round-trip tool, draft mode only.
//
// Listed only for clients whose per-request `_meta` clientCapabilities
// declare elicitation support: a client that can't answer elicitation
// requests simply never sees the tool, so "call every listed tool" stays the
// whole contract. The requestState is self-contained (no server memory), so
// the retry can land on any isolate.
// ---------------------------------------------------------------------------

const MRTR_TOOL = {
  name: 'mrtr_confirm',
  description:
    'Multi-round-trip tool (SEP-2322): the first call returns an ' +
    'input_required result with an elicitation request and a requestState. ' +
    'Re-call this tool with inputResponses.confirm set to the elicitation ' +
    'result and requestState echoed back unchanged.',
  inputSchema: { type: 'object', properties: {} }
};

/**
 * Listed in place of mrtr_confirm when the client does NOT declare the
 * elicitation capability — so the absence is discoverable instead of silent.
 * Calling it is not an error (not implementing elicitation is conformant);
 * the result explains what declaring the capability unlocks.
 */
const ELICITATION_MISSING_TOOL = {
  name: 'elicitation_missing',
  description:
    'You are seeing this tool because your client did not declare the ' +
    "'elicitation' capability in _meta " +
    `${META_NS}clientCapabilities. Clients that declare it ` +
    '({"elicitation": {}}) see the full tool list, including the ' +
    'multi-round-trip (MRTR, SEP-2322) tool mrtr_confirm. Calling this ' +
    'tool is not an error — it returns this explanation.',
  inputSchema: { type: 'object', properties: {} }
};

function declaresElicitation(meta: Record<string, unknown>): boolean {
  const caps = meta[`${META_NS}clientCapabilities`];
  return (
    typeof caps === 'object' &&
    caps !== null &&
    (caps as Record<string, unknown>).elicitation !== undefined
  );
}

function encodeMrtrState(): string {
  return Buffer.from(
    JSON.stringify({ tool: MRTR_TOOL.name, nonce: 'gauntlet-mrtr-v1' })
  ).toString('base64url');
}

function decodeMrtrState(state: string): boolean {
  try {
    const parsed = JSON.parse(Buffer.from(state, 'base64url').toString());
    return parsed.tool === MRTR_TOOL.name && parsed.nonce === 'gauntlet-mrtr-v1';
  } catch {
    return false;
  }
}

interface ToolOutcome {
  ok: boolean;
  /** What was validated (on success) or what the client got wrong. */
  detail: string;
}

/**
 * Tool registry. Transport conformance (headers, _meta, version) is enforced
 * on every request before any tool runs, so tools only need to cover what a
 * request body can get wrong: constructing arguments that honor the
 * inputSchema. One tool with a string, a number, and a same-document $ref
 * field covers every argument kind in a single call; failures itemize
 * per-field problems so nothing diagnostic is lost by the consolidation.
 */
const GAUNTLET_TOOLS: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  validate: (args: Record<string, unknown>, req: Request) => ToolOutcome;
}[] = [
  {
    name: 'validate_arguments',
    description:
      'Echoes back its arguments. Validates that the client constructs ' +
      'arguments honoring the inputSchema: a required string, a required ' +
      'JSON number (not a stringified number), and a field defined via a ' +
      'same-document $ref (#/$defs/payload) — local refs are safe to ' +
      'resolve (SEP-2106). Failures list every non-conforming field.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Any string to echo' },
        count: { type: 'number', description: 'Any JSON number' },
        payload: { $ref: '#/$defs/payload' }
      },
      required: ['message', 'count', 'payload'],
      $defs: {
        payload: {
          type: 'object',
          properties: { kind: { type: 'string', enum: ['solid', 'liquid'] } },
          required: ['kind']
        }
      }
    },
    validate: (args) => {
      const problems: string[] = [];
      if (typeof args.message !== 'string') {
        problems.push(
          `'message' must be a string; got ${JSON.stringify(args.message)} (${typeof args.message})`
        );
      }
      if (typeof args.count !== 'number') {
        problems.push(
          `'count' must be a JSON number, not a stringified number; got ${JSON.stringify(args.count)} (${typeof args.count})`
        );
      }
      const payload = args.payload as { kind?: unknown } | undefined;
      if (
        !payload ||
        typeof payload !== 'object' ||
        (payload.kind !== 'solid' && payload.kind !== 'liquid')
      ) {
        problems.push(
          `'payload' must match #/$defs/payload ({kind: "solid"|"liquid"}); got ${JSON.stringify(args.payload)}`
        );
      }
      if (problems.length > 0) {
        return { ok: false, detail: problems.join('; ') };
      }
      return {
        ok: true,
        detail: `message=${args.message}, count=${String(args.count)}, payload.kind=${String(payload?.kind)}`
      };
    }
  }
];

/** Transport-level problems with the request, empty when conformant. */
function headerProblems(req: Request): string[] {
  const problems: string[] = [];
  const accept = String(req.headers.accept ?? '');
  if (
    !accept.includes('application/json') ||
    !accept.includes('text/event-stream')
  ) {
    problems.push(
      `Accept header MUST list both application/json and text/event-stream; got '${accept || '(missing)'}'`
    );
  }
  const contentType = String(req.headers['content-type'] ?? '');
  if (!contentType.includes('application/json')) {
    problems.push(
      `Content-Type MUST be application/json; got '${contentType || '(missing)'}'`
    );
  }
  return problems;
}

/**
 * Draft-2026 (SEP-2575/SEP-2243) per-request obligations. There is no
 * initialization in the stateless draft protocol, so everything a classic
 * handshake established must be carried by every request: the version header,
 * the io.modelcontextprotocol/* `_meta` fields, and the Mcp-Method/Mcp-Name
 * routing headers.
 */
function draftProblems(
  req: Request,
  body: { method?: string; params?: Record<string, unknown> }
): string[] {
  const problems: string[] = [];
  const headerVersion = req.headers['mcp-protocol-version'];
  const meta = (body.params?._meta ?? {}) as Record<string, unknown>;
  const metaVersion = meta[`${META_NS}protocolVersion`];

  if (!headerVersion) {
    problems.push(
      'MCP-Protocol-Version header MUST be sent on every request (SEP-2575; there is no initialize handshake to negotiate it)'
    );
  } else if (!KNOWN_PROTOCOL_VERSIONS.includes(String(headerVersion))) {
    problems.push(
      `MCP-Protocol-Version '${String(headerVersion)}' is not a known protocol version (${KNOWN_PROTOCOL_VERSIONS.join(', ')})`
    );
  }
  for (const field of ['protocolVersion', 'clientInfo', 'clientCapabilities']) {
    if (meta[`${META_NS}${field}`] === undefined) {
      problems.push(
        `_meta MUST carry ${META_NS}${field} on every request (SEP-2575)`
      );
    }
  }
  if (
    headerVersion !== undefined &&
    metaVersion !== undefined &&
    !sameVersion(headerVersion, metaVersion)
  ) {
    problems.push(
      `MCP-Protocol-Version header ('${String(headerVersion)}') MUST match _meta ${META_NS}protocolVersion ('${String(metaVersion)}')`
    );
  }
  const mcpMethod = req.headers['mcp-method'];
  if (!mcpMethod) {
    problems.push(
      'Mcp-Method header MUST mirror the JSON-RPC method on every POST (SEP-2243)'
    );
  } else if (body.method && String(mcpMethod) !== body.method) {
    problems.push(
      `Mcp-Method header ('${String(mcpMethod)}') MUST equal the body method ('${body.method}') (SEP-2243)`
    );
  }
  if (body.method === 'tools/call') {
    const mcpName = req.headers['mcp-name'];
    const toolName = (body.params as { name?: string } | undefined)?.name;
    if (!mcpName) {
      problems.push(
        'Mcp-Name header MUST mirror params.name on tools/call (SEP-2243)'
      );
    } else if (toolName && String(mcpName) !== toolName) {
      problems.push(
        `Mcp-Name header ('${String(mcpName)}') MUST equal params.name ('${toolName}') (SEP-2243)`
      );
    }
  }
  return problems;
}

function check(
  checks: ConformanceCheck[],
  id: string,
  name: string,
  ok: boolean,
  description: string,
  details?: Record<string, unknown>,
  failStatus: 'FAILURE' | 'WARNING' = 'FAILURE'
): void {
  checks.push({
    id,
    name,
    description,
    status: ok ? 'SUCCESS' : failStatus,
    timestamp: new Date().toISOString(),
    specReferences: [SPEC_HTTP],
    details
  });
}

interface ToolCallResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Execute a gauntlet tool call. In lenient mode failures stay isError tool
 * results (recorded as WARNING checks) instead of escalating to HTTP 400 —
 * an old client keeps its flow and reads the feedback from the result.
 */
function runTool(
  checks: ConformanceCheck[],
  name: string,
  args: Record<string, unknown>,
  req: Request,
  lenient = false
): ToolCallResult {
  const tool = GAUNTLET_TOOLS.find((t) => t.name === name);
  if (!tool) {
    return {
      content: [
        {
          type: 'text',
          text:
            `CONFORMANCE FAIL: unknown tool '${name}'. ` +
            `Available: ${GAUNTLET_TOOLS.map((t) => t.name).join(', ')}`
        }
      ],
      isError: true
    };
  }
  const outcome = tool.validate(args, req);
  check(
    checks,
    `gauntlet-${tool.name}`,
    `Gauntlet: ${tool.name}`,
    outcome.ok,
    outcome.ok
      ? `Client called ${tool.name} conformantly`
      : `Client call to ${tool.name} was not conformant`,
    { detail: outcome.detail },
    lenient ? 'WARNING' : 'FAILURE'
  );
  if (!outcome.ok) {
    return {
      content: [
        {
          type: 'text',
          text: `CONFORMANCE FAIL [${tool.name}]: ${outcome.detail}`
        }
      ],
      isError: true
    };
  }
  return {
    content: [
      { type: 'text', text: `CONFORMANCE OK [${tool.name}]: ${outcome.detail}` }
    ]
  };
}

// ---------------------------------------------------------------------------
// Lenient mode ("/lenient" sub-path) — serve old clients, report the gaps.
//
// Classic flows complete normally (initialize handshake via the SDK) so an
// old client can actually run; the draft gap report is delivered where the
// client will see it: the initialize result's `instructions`, and the
// draft_readiness tool whose result itemizes what the request that carried
// it was missing relative to the stateless draft.
// ---------------------------------------------------------------------------

const DRAFT_READINESS_TOOL = {
  name: 'draft_readiness',
  description:
    'Reports how draft-ready (stateless 2026-07-28, SEP-2575) your client ' +
    'is, judged from the request that carries this call: protocol version ' +
    'declaration, _meta fields, and Mcp-* routing headers. Never errors — ' +
    'the result is the report.',
  inputSchema: { type: 'object', properties: {} }
};

/**
 * Behavioral changes the draft brings that a per-request gap list cannot
 * detect — appended to every readiness report so old clients learn about
 * them even though their requests can't "miss" them yet.
 */
const MRTR_NOTE =
  'Also note: the stateless draft replaces server-initiated requests with ' +
  'multi-round-trip tool results (MRTR, SEP-2322). If your client supports ' +
  'elicitation, it must declare it in _meta ' +
  `${META_NS}clientCapabilities ({"elicitation": {}}) and handle ` +
  "resultType:'input_required' tool results — answer the inputRequests and " +
  'retry the call with requestState echoed back unchanged. Declaring the ' +
  "capability makes this gauntlet list the mrtr_confirm tool so you can " +
  'exercise that flow.';

/** Itemized draft gaps of one request, framed as an advisory report. */
function readinessReport(
  req: Request,
  body: { method?: string; params?: Record<string, unknown> }
): string {
  const headerVersion = req.headers['mcp-protocol-version'];
  const meta = (body.params?._meta ?? {}) as Record<string, unknown>;
  const gaps = draftProblems(req, body);
  // The consent token spells it out: this client led with initialize.
  if (req.headers.authorization === `Bearer ${CONSENT_TOKEN}`) {
    gaps.unshift(
      'Do not lead with initialize — the stateless draft has no handshake. ' +
        'This client presented the consent token (literally ' +
        `'${CONSENT_TOKEN}') minted at the initialize gate, so it opened ` +
        'this session with initialize. Draft clients start with ' +
        'server/discover or any request directly.'
    );
  } else if (body.method === 'initialize') {
    gaps.unshift(
      'Do not lead with initialize — the stateless draft has no handshake. ' +
        'This request IS an initialize. Draft clients start with ' +
        'server/discover or any request directly.'
    );
  }
  if (gaps.length === 0) {
    return (
      'DRAFT-READY: this request carries everything the stateless draft ' +
      'protocol requires. Run the strict gauntlet at the parent URL ' +
      '(without /lenient) to confirm end to end.' +
      (declaresElicitation(meta) ? '' : `\n\n${MRTR_NOTE}`)
    );
  }
  const intro =
    body.method === 'initialize'
      ? 'Your client spoke the classic handshake protocol' +
        ' — the stateless draft (2026-07-28) has no initialize step.'
      : `Your client declared protocol version '${String(headerVersion ?? '(none)')}'.`;
  return (
    `DRAFT GAPS (${gaps.length}): ${intro} To be draft-ready it must also fix:\n` +
    gaps.map((g, i) => `${i + 1}. ${g}`).join('\n') +
    `\n\n${MRTR_NOTE}`
  );
}

/** Classic SDK server for lenient mode, carrying the gap report. */
function createLenientClassicServer(
  checks: ConformanceCheck[],
  req: Request,
  body: { method?: string; params?: Record<string, unknown> }
): Server {
  const server = new Server(
    SERVER_INFO,
    {
      capabilities: { tools: {} },
      instructions:
        'Lenient conformance gauntlet. Call every listed tool with valid ' +
        'arguments; call draft_readiness for an itemized report of what ' +
        'this client must change for the stateless draft protocol.\n\n' +
        readinessReport(req, body)
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    // Classic requests carry no per-request capabilities, so MRTR can't be
    // capability-gated here the way it is in draft mode — list the
    // placeholder unconditionally so the old client discovers the gap.
    tools: [
      ...GAUNTLET_TOOLS.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema
      })),
      DRAFT_READINESS_TOOL,
      ELICITATION_MISSING_TOOL
    ]
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> => {
      if (request.params.name === DRAFT_READINESS_TOOL.name) {
        return {
          content: [
            { type: 'text' as const, text: readinessReport(req, body) }
          ]
        };
      }
      if (request.params.name === ELICITATION_MISSING_TOOL.name) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `CONFORMANCE NOTE [elicitation_missing]: ${MRTR_NOTE}`
            }
          ]
        };
      }
      return runTool(
        checks,
        request.params.name,
        (request.params.arguments ?? {}) as Record<string, unknown>,
        req,
        true
      );
    }
  );

  return server;
}

export class StatelessGauntletScenario extends HandlerScenario {
  name = 'checker-2026-07-28';
  description =
    'Single stateless MCP server with validating tools, draft protocol ' +
    '(SEP-2575) ONLY. List tools, call each once with valid arguments; any ' +
    'error response tells you what the client got wrong. No run-id and no ' +
    'results polling — every request is judged on its own content. Clients ' +
    'that fall back to a classic version (initialize, or a 2025-* version ' +
    'header) fail with an itemized list of what a draft request carries ' +
    'that theirs did not.';
  readonly source = { introducedIn: '2025-06-18' } as const;
  mcpPath = '';

  private checks: ConformanceCheck[] = [];

  handler(getBaseUrl: () => string): express.Application {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));

    // -----------------------------------------------------------------------
    // Consent gate for `initialize` (and only initialize — nothing else is
    // auth-gated). An old client leading with initialize gets a 401; its
    // OAuth flow lands a human on an HTML page explaining that initialize
    // does not exist in the stateless draft. Continuing mints a consent
    // token, and a consented classic client is served leniently — so "I
    // understand, test anyway" is exactly what the token encodes. This
    // mini-AS is a consent-delivery vehicle, NOT an auth conformance test
    // (the auth/* scenarios cover that).
    // -----------------------------------------------------------------------
    const issuer = () => `${getBaseUrl()}/oauth`;
    // PRM URL per RFC 9728, derived from wherever this app is mounted:
    // root mount (dedicated checker val) → origin-rooted well-known;
    // /x/<name> mount (hosted runner) → path-suffixed well-known.
    const prmUrl = () => {
      const base = new URL(getBaseUrl());
      return `${base.origin}/.well-known/oauth-protected-resource${base.pathname === '/' ? '' : base.pathname}`;
    };

    app.get('/.well-known/oauth-protected-resource', (_req, res) => {
      res.json({
        resource: getBaseUrl(),
        authorization_servers: [issuer()],
        bearer_methods_supported: ['header']
      });
    });

    const asMetadata = (_req: Request, res: Response) => {
      res.json({
        issuer: issuer(),
        authorization_endpoint: `${issuer()}/authorize`,
        token_endpoint: `${issuer()}/token`,
        registration_endpoint: `${issuer()}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none']
      });
    };
    app.get('/.well-known/oauth-authorization-server/oauth', asMetadata);
    // OIDC-style discovery fallback for clients that only try this form.
    app.get('/.well-known/openid-configuration/oauth', asMetadata);

    app.post('/oauth/register', (req, res) => {
      res.status(201).json({
        ...req.body,
        client_id: 'gauntlet-consent-client',
        token_endpoint_auth_method: 'none'
      });
    });

    app.get('/oauth/authorize', (req, res) => {
      const query = new URLSearchParams(
        req.query as Record<string, string>
      ).toString();
      const continueUrl = `${issuer()}/authorize/continue?${query}`;
      res
        .status(200)
        .type('html')
        .send(`<!doctype html>
<html><head><title>Hold on — initialize?</title>
<style>body{font-family:system-ui;max-width:42em;margin:4em auto;line-height:1.5;padding:0 1em}
a.btn{display:inline-block;background:#2563eb;color:#fff;padding:.6em 1.2em;border-radius:6px;text-decoration:none}
code{background:#f3f4f6;padding:.1em .3em;border-radius:3px}</style></head>
<body>
<h1>Hold on — this client led with <code>initialize</code></h1>
<p>The client you are testing started its session with an
<code>initialize</code> request. <strong>That is invalid in the new
stateless protocol (2026-07-28 / SEP-2575)</strong> — there is no handshake;
every request carries the protocol version, client info, and capabilities
itself.</p>
<p>You can continue with the test if you want: the gauntlet will serve this
client's classic flow and report what it is missing (see the
<code>draft_readiness</code> tool and the initialize result's instructions).
But know that leading with <code>initialize</code> will not work against
stateless draft servers.</p>
<p><a class="btn" href="${continueUrl.replace(/&/g, '&amp;')}">I understand — continue with the test</a></p>
</body></html>`);
    });

    app.get('/oauth/authorize/continue', (req, res) => {
      const q = req.query as Record<string, string | undefined>;
      if (!q.redirect_uri) {
        res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri required' });
        return;
      }
      const redirect = new URL(q.redirect_uri);
      const code = Buffer.from(
        JSON.stringify({
          consent: 'gauntlet-initialize',
          challenge: q.code_challenge ?? null
        })
      ).toString('base64url');
      redirect.searchParams.set('code', code);
      if (q.state !== undefined) redirect.searchParams.set('state', q.state);
      res.redirect(redirect.toString());
    });

    app.post('/oauth/token', (req, res) => {
      const grant = req.body as Record<string, string | undefined>;
      let decoded: { consent?: string; challenge?: string | null };
      try {
        decoded = JSON.parse(
          Buffer.from(String(grant.code ?? ''), 'base64url').toString()
        );
      } catch {
        decoded = {};
      }
      if (
        grant.grant_type !== 'authorization_code' ||
        decoded.consent !== 'gauntlet-initialize'
      ) {
        res.status(400).json({ error: 'invalid_grant' });
        return;
      }
      if (decoded.challenge) {
        const expected = createHash('sha256')
          .update(String(grant.code_verifier ?? ''))
          .digest('base64url');
        if (expected !== decoded.challenge) {
          res.status(400).json({
            error: 'invalid_grant',
            error_description: 'PKCE verification failed'
          });
          return;
        }
      }
      res.json({
        access_token: CONSENT_TOKEN,
        token_type: 'Bearer',
        expires_in: 3600
      });
    });

    app.post('/', async (req: Request, res: Response) => {
      const body =
        req.body && !Array.isArray(req.body)
          ? (req.body as {
              method?: string;
              id?: unknown;
              params?: Record<string, unknown>;
            })
          : {};
      const headerVersion = req.headers['mcp-protocol-version'];

      // This gauntlet tests the stateless draft protocol ONLY. A client
      // that falls back to a classic version (an `initialize` request or a
      // 2025-* version header) fails — but with a full inventory of what a
      // draft request must carry that this one didn't, so the failure is
      // also the upgrade guide. A request carrying draft `_meta` fields is
      // judged as draft no matter what its header claims (the disagreement
      // is reported, not routed around).
      const meta = (body.params?._meta ?? {}) as Record<string, unknown>;
      const hasDraftMeta = Object.keys(meta).some((k) =>
        k.startsWith(META_NS)
      );
      const isClassicFallback =
        !hasDraftMeta &&
        ((body.method === 'initialize' && !isDraftVersion(headerVersion)) ||
          (headerVersion !== undefined &&
            CLASSIC_PROTOCOL_VERSIONS.includes(String(headerVersion))));

      // A consent token (minted by the initialize interstitial) means a
      // human read "this client shouldn't do initialize" and chose to
      // continue — serve the classic flow leniently from here on.
      const consented =
        req.headers.authorization === `Bearer ${CONSENT_TOKEN}`;
      if (isClassicFallback && consented) {
        const gaps = [...headerProblems(req), ...draftProblems(req, body)];
        check(
          this.checks,
          'gauntlet-draft-readiness',
          'Gauntlet: draft readiness (consented classic)',
          gaps.length === 0,
          'Consented classic flow served leniently; draft gaps are advisory',
          { method: body.method, ...(gaps.length ? { gaps } : {}) },
          'WARNING'
        );
        const server = createLenientClassicServer(this.checks, req, body);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        return;
      }

      // initialize — and ONLY initialize — is gated on auth: the OAuth flow
      // lands a human on an HTML page explaining that the draft has no
      // initialize, with a "continue anyway" button. Clients without OAuth
      // get the same explanation in the 401 body. Recorded as WARNING so
      // the /x wrapper lets the 401 challenge through.
      if (isClassicFallback && body.method === 'initialize') {
        const explanation =
          'This gauntlet tests the stateless draft protocol (2026-07-28): there is NO initialize handshake. Leading with initialize is invalid in the new spec. If your client supports OAuth, completing the authorization flow shows the full explanation and lets you continue testing the classic flow anyway; or point the client at this URL + /lenient for ungated advisory mode.';
        check(
          this.checks,
          'gauntlet-transport-headers',
          'Gauntlet: transport headers',
          false,
          'Client led with initialize; challenged with the consent gate',
          { method: body.method, mode: 'initialize-consent-gate' },
          'WARNING'
        );
        res
          .status(401)
          .set(
            'WWW-Authenticate',
            `Bearer resource_metadata="${prmUrl()}"`
          )
          .json({
            error: 'consent_required',
            explanation,
            problems: draftProblems(req, body)
          });
        return;
      }

      const problems = headerProblems(req);
      if (isClassicFallback) {
        problems.unshift(
          `Request declared classic protocol version '${String(headerVersion)}'. This gauntlet tests the stateless draft protocol only — declare 2026-07-28 (or DRAFT-2026-v1) in both the MCP-Protocol-Version header and _meta.`
        );
      }
      // Draft obligations are evaluated for EVERY request — for a classic
      // fallback this doubles as the itemized list of what was missing.
      problems.push(...draftProblems(req, body));

      check(
        this.checks,
        'gauntlet-transport-headers',
        'Gauntlet: transport headers',
        problems.length === 0,
        problems.length === 0
          ? 'Request carried conformant draft transport headers'
          : isClassicFallback
            ? 'Client fell back to a classic protocol version'
            : 'Request transport headers were not conformant',
        {
          method: body.method,
          mode: isClassicFallback ? 'classic-fallback-rejected' : 'draft',
          ...(problems.length ? { problems } : {})
        }
      );
      if (problems.length > 0) {
        res.status(400).json({
          error: 'conformance failure',
          mode: isClassicFallback ? 'classic-fallback-rejected' : 'draft',
          problems,
          hint: isClassicFallback
            ? 'Each listed problem is one thing a stateless draft request carries that this request did not. For advisory-only feedback that still serves classic flows, point the client at this URL + /lenient.'
            : 'Fix the listed transport problems and retry.'
        });
        return;
      }

      this.handleDraft(req, res, body);
    });

    // Lenient mode: old clients complete their flows (initialize included);
    // draft gaps are reported, not enforced. Tool failures stay isError
    // results, and gap checks are WARNINGs so the /x wrapper passes them.
    app.post('/lenient', async (req: Request, res: Response) => {
      const body =
        req.body && !Array.isArray(req.body)
          ? (req.body as {
              method?: string;
              id?: unknown;
              params?: Record<string, unknown>;
            })
          : {};
      const headerVersion = req.headers['mcp-protocol-version'];
      const meta = (body.params?._meta ?? {}) as Record<string, unknown>;
      const hasDraftMeta = Object.keys(meta).some((k) =>
        k.startsWith(META_NS)
      );

      const gaps = [...headerProblems(req), ...draftProblems(req, body)];
      check(
        this.checks,
        'gauntlet-draft-readiness',
        'Gauntlet: draft readiness (lenient)',
        gaps.length === 0,
        gaps.length === 0
          ? 'Request carries everything the stateless draft requires'
          : 'Request is missing draft obligations (advisory)',
        { method: body.method, ...(gaps.length ? { gaps } : {}) },
        'WARNING'
      );

      if (!hasDraftMeta && !isDraftVersion(headerVersion)) {
        // Classic client: serve the real handshake so the flow completes;
        // the gap report rides in instructions and draft_readiness.
        const server = createLenientClassicServer(this.checks, req, body);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        return;
      }

      this.handleDraft(req, res, body, true);
    });

    // Browsers get an explainer; programmatic GETs get the JSON hint.
    app.get('/', (req, res) => {
      if (!String(req.headers.accept ?? '').includes('text/html')) {
        res.status(405).json({
          error: 'stateless server: POST JSON-RPC to this URL',
          docs: 'open this URL in a browser for a full explanation'
        });
        return;
      }
      const base = getBaseUrl();
      res.type('html').send(`<!doctype html>
<html><head><title>MCP Checker — 2026-07-28</title>
<style>body{font-family:system-ui;max-width:46em;margin:3em auto;line-height:1.55;padding:0 1em}
code,pre{background:#f3f4f6;border-radius:4px}code{padding:.1em .3em}pre{padding:.8em;overflow-x:auto}
h1{margin-bottom:.2em}h2{margin-top:1.6em}.muted{color:#6b7280}</style></head>
<body>
<h1>MCP Checker — 2026-07-28</h1>
<p class="muted">Conformance checker for the <strong>stateless draft</strong> MCP protocol
(2026-07-28 / DRAFT-2026-v1) — and only that version. Other spec versions have their own checkers.</p>

<h2>How it works</h2>
<p>This URL is the MCP endpoint. There is no run to mint and no results to
poll: <strong>every request is judged on its own content</strong>. If your
client gets something wrong, the request itself fails with an explanation of
what and why. If you can list the tools and call each one successfully, your
client is conformant for everything this server can observe.</p>
<pre>POST ${base}            strict — stateless draft only
POST ${base}/lenient    advisory — classic clients complete, gaps reported</pre>

<h2>What is checked</h2>
<ul>
<li><strong>Every POST:</strong> Accept / Content-Type, <code>MCP-Protocol-Version</code> header,
<code>_meta</code> declarations (<code>io.modelcontextprotocol/protocolVersion</code>, <code>clientInfo</code>,
<code>clientCapabilities</code> — SEP-2575), and <code>Mcp-Method</code>/<code>Mcp-Name</code> routing headers (SEP-2243).</li>
<li><strong>validate_arguments:</strong> argument construction against the inputSchema —
string, JSON number (not stringified), and a same-document <code>$ref</code> (SEP-2106).</li>
<li><strong>mrtr_confirm:</strong> the multi-round-trip flow (SEP-2322) — answer the
elicitation request and retry with <code>requestState</code> echoed unchanged. Listed only when
your <code>_meta</code> clientCapabilities declare <code>{"elicitation": {}}</code>; otherwise an
<code>elicitation_missing</code> placeholder explains the gap.</li>
<li><strong>draft_readiness</strong> (lenient/consented): itemized report of what the request
that carried it is missing relative to the draft.</li>
</ul>

<h2>Old clients</h2>
<p>Leading with <code>initialize</code> is invalid in the stateless draft, so the strict
endpoint gates it behind an OAuth consent screen: your client's auth flow lands a human on a
page explaining the situation, with a continue button. Continuing mints the bearer token
<code>${CONSENT_TOKEN}</code> — the token is the message — and the classic flow is then served
with advisory feedback. No other request requires auth. Prefer zero friction? Use
<code>${base}/lenient</code>.</p>

<h2>Try it</h2>
<pre>curl -X POST ${base} \\
  -H 'content-type: application/json' \\
  -H 'accept: application/json, text/event-stream' \\
  -H 'mcp-protocol-version: 2026-07-28' \\
  -H 'mcp-method: tools/list' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{
    "io.modelcontextprotocol/protocolVersion":"2026-07-28",
    "io.modelcontextprotocol/clientInfo":{"name":"my-client","version":"1.0"},
    "io.modelcontextprotocol/clientCapabilities":{}}}}'</pre>
</body></html>`);
    });

    return app;
  }

  /**
   * Draft-2026 dispatch: no lifecycle, plain JSON responses, every request
   * self-contained. Transport/draft obligations were already enforced.
   */
  private handleDraft(
    req: Request,
    res: Response,
    body: { method?: string; id?: unknown; params?: Record<string, unknown> },
    lenient = false
  ): void {
    const reply = (result: object) => {
      // 2026-07-28 makes resultType REQUIRED on every Result; default it here so
      // every path is covered, and let callers override (e.g. 'input_required').
      res.json({
        jsonrpc: '2.0',
        id: body.id ?? null,
        result: { resultType: 'complete', ...result }
      });
    };

    switch (body.method) {
      case 'server/discover':
        reply({
          ttlMs: 0,
          cacheScope: 'public',
          supportedVersions: DRAFT_VERSION_ALIASES,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions:
            'Call every tool once with valid arguments. Each tool validates ' +
            'the request that carried it; any error explains what your ' +
            'client got wrong.'
        });
        return;

      case 'tools/list': {
        const meta = (body.params?._meta ?? {}) as Record<string, unknown>;
        const tools = GAUNTLET_TOOLS.map(
          ({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema
          })
        );
        // MRTR is only part of the contract for clients that can answer
        // elicitation requests — gate the listing on the declared capability
        // each request carries. Clients without it get a placeholder that
        // makes the gap (and how to close it) discoverable.
        tools.push(
          declaresElicitation(meta) ? MRTR_TOOL : ELICITATION_MISSING_TOOL
        );
        if (lenient) tools.push(DRAFT_READINESS_TOOL);
        reply({ ttlMs: 0, cacheScope: 'public', tools });
        return;
      }

      case 'tools/call': {
        const params = (body.params ?? {}) as {
          name?: string;
          arguments?: Record<string, unknown>;
          inputResponses?: Record<string, unknown>;
          requestState?: string;
          _meta?: Record<string, unknown>;
        };

        if (params.name === DRAFT_READINESS_TOOL.name && lenient) {
          reply({
            content: [
              { type: 'text', text: readinessReport(req, body) }
            ]
          });
          return;
        }

        if (params.name === MRTR_TOOL.name) {
          reply(this.runMrtr(params, lenient));
          return;
        }

        if (params.name === ELICITATION_MISSING_TOOL.name) {
          const declared = declaresElicitation(
            (params._meta ?? {}) as Record<string, unknown>
          );
          this.checks.push({
            id: 'gauntlet-elicitation-missing',
            name: 'Gauntlet: elicitation capability not declared',
            description:
              'Client called the elicitation_missing placeholder tool',
            status: 'INFO',
            timestamp: new Date().toISOString(),
            specReferences: [SPEC_TOOLS],
            details: { declared }
          });
          reply({
            content: [
              {
                type: 'text',
                text: declared
                  ? 'CONFORMANCE NOTE [elicitation_missing]: this request DOES declare the elicitation capability — list tools again and you will see mrtr_confirm instead of this placeholder.'
                  : 'CONFORMANCE NOTE [elicitation_missing]: your client has not declared the elicitation capability, so the MRTR (SEP-2322) tool mrtr_confirm is hidden. This is conformant — elicitation is optional — but to exercise the full gauntlet, implement elicitation and declare it in _meta ' +
                    `${META_NS}clientCapabilities as {"elicitation": {}}; the full tool list will then appear.`
              }
            ]
          });
          return;
        }

        // MRTR plumbing must not leak onto unrelated calls (SEP-2322).
        if (
          params.inputResponses !== undefined ||
          params.requestState !== undefined
        ) {
          const detail =
            'inputResponses/requestState MUST only be sent when retrying the ' +
            'tool that returned input_required; they leaked onto ' +
            `'${params.name ?? '(none)'}'`;
          check(
            this.checks,
            'gauntlet-mrtr-leak',
            'Gauntlet: MRTR state leak',
            false,
            'MRTR retry fields leaked onto an unrelated tool call',
            { detail }
          );
          reply({
            content: [
              { type: 'text', text: `CONFORMANCE FAIL [${params.name}]: ${detail}` }
            ],
            isError: true
          });
          return;
        }

        reply(
          runTool(this.checks, params.name ?? '', params.arguments ?? {}, req)
        );
        return;
      }

      case 'initialize':
      case 'ping':
      case 'logging/setLevel':
        // Removed from the stateless draft protocol entirely.
        res.status(404).json({
          jsonrpc: '2.0',
          id: body.id ?? null,
          error: {
            code: -32601,
            message: `Method not found: '${body.method}' does not exist in the stateless draft protocol (use server/discover, not initialize)`
          }
        });
        return;

      default:
        res.status(404).json({
          jsonrpc: '2.0',
          id: body.id ?? null,
          error: {
            code: -32601,
            message: `Method not found: '${body.method ?? '(none)'}'. Supported: server/discover, tools/list, tools/call`
          }
        });
    }
  }

  /**
   * Two-phase MRTR tool. First call → input_required with a self-contained
   * requestState. Retry → validate the echoed state and the elicitation
   * response shape, then complete.
   */
  private runMrtr(
    params: {
      inputResponses?: Record<string, unknown>;
      requestState?: string;
    },
    lenient = false
  ): object {
    if (params.inputResponses === undefined) {
      // Round 1: ask for confirmation via elicitation.
      return {
        resultType: 'input_required',
        inputRequests: {
          confirm: {
            method: 'elicitation/create',
            params: {
              message: 'Confirm the MRTR round-trip by answering this.',
              requestedSchema: {
                type: 'object',
                properties: { confirmed: { type: 'boolean' } },
                required: ['confirmed']
              }
            }
          }
        },
        requestState: encodeMrtrState()
      };
    }

    // Round 2: judge the retry on its own content.
    const problems: string[] = [];
    if (params.requestState === undefined) {
      problems.push(
        'requestState MUST be echoed back unchanged on the retry (SEP-2322)'
      );
    } else if (!decodeMrtrState(params.requestState)) {
      problems.push(
        `requestState was altered — it MUST be echoed back byte-exact; got '${params.requestState.slice(0, 60)}'`
      );
    }
    const confirm = params.inputResponses.confirm as
      | { action?: unknown; content?: { confirmed?: unknown } }
      | undefined;
    if (!confirm || typeof confirm !== 'object') {
      problems.push(
        "inputResponses MUST be keyed by the inputRequests key ('confirm')"
      );
    } else {
      if (confirm.action !== 'accept' && confirm.action !== 'decline' && confirm.action !== 'cancel') {
        problems.push(
          `elicitation response action MUST be accept/decline/cancel; got ${JSON.stringify(confirm.action)}`
        );
      }
      if (
        confirm.action === 'accept' &&
        typeof confirm.content?.confirmed !== 'boolean'
      ) {
        problems.push(
          `accepted elicitation content MUST match requestedSchema ({confirmed: boolean}); got ${JSON.stringify(confirm.content)}`
        );
      }
    }

    const ok = problems.length === 0;
    const detail = ok
      ? `requestState echoed intact; elicitation response valid (action=${String((params.inputResponses.confirm as { action?: unknown })?.action)})`
      : problems.join('; ');
    check(
      this.checks,
      'gauntlet-mrtr_confirm',
      'Gauntlet: mrtr_confirm',
      ok,
      ok
        ? 'Client completed the MRTR round-trip conformantly'
        : 'Client MRTR retry was not conformant',
      { detail },
      lenient ? 'WARNING' : 'FAILURE'
    );
    if (!ok) {
      return {
        content: [
          { type: 'text', text: `CONFORMANCE FAIL [mrtr_confirm]: ${detail}` }
        ],
        isError: true
      };
    }
    return {
      content: [
        { type: 'text', text: `CONFORMANCE OK [mrtr_confirm]: ${detail}` }
      ]
    };
  }

  getChecks(): ConformanceCheck[] {
    return this.checks;
  }
}
