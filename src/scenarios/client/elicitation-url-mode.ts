/**
 * SEP-1036: URL mode elicitation, client side.
 *
 * Targets the 2026-07-28 revision only. There, URL-mode requests arrive inside
 * an InputRequiredResult (MRTR, SEP-2322), and the 2025-11-25 elicitationId,
 * notifications/elicitation/complete, and -32042 error no longer exist.
 *
 * The harness is the MCP server. Each tool answers with InputRequiredResults
 * and grades how the client answers them and retries:
 * - test_url_elicitation_decline: a URL the client declines must never be
 *   fetched
 * - test_url_elicitation_rounds: three URL requests in a row; every retry must
 *   answer the newest request and echo the newest requestState
 * - test_elicitation_no_mode: a request without `mode` is form mode, even when
 *   it carries a `url` field
 * - test_url_elicitation_mixed: a URL request and a form request in one result
 * - test_url_elicitation_held_json / test_url_elicitation_held_sse: the server
 *   holds the accepted retry open before answering, which the URL Mode Flow
 *   allows ("It may need to block until the request is fulfilled")
 */

import http from 'http';
import express, { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import type { ScenarioContext } from '../../mock-server';
import {
  validateStatelessRequest,
  withRequiredDraftResultFields
} from '../../mock-server';
import { STATELESS_SPEC_VERSIONS } from '../../connection/select';
import { validateWireMessage } from '../../validation/wire-schema';
import type {
  ConformanceCheck,
  Scenario,
  ScenarioUrls,
  SpecReference,
  SpecVersion
} from '../../types';
import { untestableCheck } from '../untestable';

const SPEC_VERSION = '2026-07-28';
const SPEC_BASE = `https://modelcontextprotocol.io/specification/${SPEC_VERSION}`;

const CAPABILITIES_REFERENCES: SpecReference[] = [
  {
    id: 'SEP-1036-Capabilities',
    url: `${SPEC_BASE}/client/elicitation#capabilities`
  }
];
const ELICITATION_REQUESTS_REFERENCES: SpecReference[] = [
  {
    id: 'SEP-1036-Elicitation-Requests',
    url: `${SPEC_BASE}/client/elicitation#elicitation-requests`
  }
];
const SAFE_URL_HANDLING_REFERENCES: SpecReference[] = [
  {
    id: 'SEP-1036-Safe-URL-Handling',
    url: `${SPEC_BASE}/client/elicitation#safe-url-handling`
  }
];
const MRTR_CLIENT_REFERENCES: SpecReference[] = [
  {
    id: 'SEP-2322-Client-Requirements',
    url: `${SPEC_BASE}/basic/patterns/mrtr#client-requirements-basic-workflow`
  }
];
const URL_MODE_FLOW_REFERENCES: SpecReference[] = [
  {
    id: 'SEP-1036-URL-Mode-Flow',
    url: `${SPEC_BASE}/client/elicitation#url-mode-flow`
  },
  {
    id: 'Streamable-HTTP-Receiving-Messages',
    url: `${SPEC_BASE}/basic/transports/streamable-http#receiving-messages`
  }
];

const DECLINE_TOOL = 'test_url_elicitation_decline';
const ROUNDS_TOOL = 'test_url_elicitation_rounds';
const NO_MODE_TOOL = 'test_elicitation_no_mode';
const MIXED_TOOL = 'test_url_elicitation_mixed';
const HELD_JSON_TOOL = 'test_url_elicitation_held_json';
const HELD_SSE_TOOL = 'test_url_elicitation_held_sse';

/** The client must decline a URL-mode request whose message starts with this. */
const DECLINE_PREFIX = 'DECLINE:';

/** How long the server holds an accepted retry before answering it. */
const HOLD_MS = 5000;

/** Gap between SSE keep-alive comments while a retry is held. */
const KEEP_ALIVE_MS = 1000;

/**
 * Listed in the order the client calls them. The decline tool goes first so a
 * prefetch has the whole run to arrive.
 */
const TOOLS = [
  {
    name: DECLINE_TOOL,
    description:
      'Sends a URL-mode request the client declines. The URL must never be fetched.'
  },
  {
    name: ROUNDS_TOOL,
    description:
      'Sends three URL-mode requests in a row, to be answered accept, accept, decline.'
  },
  {
    name: NO_MODE_TOOL,
    description:
      'Sends an elicitation request without `mode` (and with a stray `url`). It is form mode.'
  },
  {
    name: MIXED_TOOL,
    description:
      'Sends a URL-mode request and a form-mode request in one InputRequiredResult.'
  },
  {
    name: HELD_JSON_TOOL,
    description: `Holds the accepted retry open for ${HOLD_MS / 1000} seconds, then answers with application/json.`
  },
  {
    name: HELD_SSE_TOOL,
    description: `Holds the accepted retry open for ${HOLD_MS / 1000} seconds on an SSE stream with keep-alives, then answers.`
  }
].map((tool) => ({
  ...tool,
  inputSchema: { type: 'object' as const, properties: {} }
}));

/**
 * The modes each tool's input requests use. A tool whose modes the client did
 * not declare answers -32021 instead of sending them.
 */
const REQUIRED_MODES: Record<string, Array<'form' | 'url'>> = {
  [DECLINE_TOOL]: ['url'],
  [ROUNDS_TOOL]: ['url'],
  [NO_MODE_TOOL]: ['form'],
  [MIXED_TOOL]: ['url', 'form'],
  [HELD_JSON_TOOL]: ['url'],
  [HELD_SSE_TOOL]: ['url']
};

type ElicitAction = 'accept' | 'decline' | 'cancel';

/**
 * The rounds tool's script. Each round is a new input request the client must
 * build an answer for. Round 3 sends round 1's URL again with a message that
 * asks for a decline, so a client that reuses an earlier answer instead of
 * asking its handler gives the wrong one.
 */
const ROUNDS: Array<{
  key: string;
  path: string;
  message: string;
  expected: ElicitAction;
}> = [
  {
    key: 'connect_service_a',
    path: '/connect/service-a',
    message: 'Connect your Service A account to continue.',
    expected: 'accept'
  },
  {
    key: 'connect_service_b',
    path: '/connect/service-b',
    message: 'Service A is connected. Now connect your Service B account.',
    expected: 'accept'
  },
  {
    key: 'reconnect_service_a',
    path: '/connect/service-a',
    message: `${DECLINE_PREFIX} Service A needs to be connected again.`,
    expected: 'decline'
  }
];

const DECLINE_KEY = 'connect_service_c';
const NO_MODE_KEY = 'confirm';
const MIXED_URL_KEY = 'connect_service_d';
const MIXED_FORM_KEY = 'confirm_details';
const HELD_REQUESTS: Record<string, { key: string; path: string }> = {
  [HELD_JSON_TOOL]: { key: 'connect_service_e', path: '/connect/service-e' },
  [HELD_SSE_TOOL]: { key: 'connect_service_f', path: '/connect/service-f' }
};

const CONFIRM_SCHEMA = {
  type: 'object',
  properties: { confirmed: { type: 'boolean', description: 'Confirm?' } },
  required: ['confirmed']
};

interface Retry {
  inputResponses: Record<string, unknown>;
  requestState?: string;
}

/** What one tool saw during the run. */
interface ToolRecord {
  called: boolean;
  /** Why the tool answered -32021 instead of sending its input requests. */
  missingCapability?: string;
  /** Fresh calls after the first. Each one restarts the tool's flow. */
  restarts: number;
  /** The requestState sent with each InputRequiredResult, in order. */
  sentStates: string[];
  retries: Retry[];
}

/** One held retry: when the client gave up on it, or when it was answered. */
interface HeldAttempt {
  cancelledAfterMs?: number;
  answeredAfterMs?: number;
}

/** A request that reached one of the elicitation URL origins. */
interface UrlHit {
  method: string;
  path: string;
  at: string;
}

function actionOf(answer: unknown): ElicitAction | undefined {
  if (typeof answer !== 'object' || answer === null) return undefined;
  const action = (answer as Record<string, unknown>).action;
  return action === 'accept' || action === 'decline' || action === 'cancel'
    ? action
    : undefined;
}

/**
 * The modes a declared `elicitation` capability covers. An empty object means
 * form mode only, for clients written before URL mode existed.
 */
function declaredModes(elicitation: unknown): { form: boolean; url: boolean } {
  if (
    typeof elicitation !== 'object' ||
    elicitation === null ||
    Array.isArray(elicitation)
  ) {
    return { form: false, url: false };
  }
  const keys = Object.keys(elicitation);
  return {
    form: keys.length === 0 || keys.includes('form'),
    url: keys.includes('url')
  };
}

function urlRequest(url: string, message: string): object {
  return {
    method: 'elicitation/create',
    params: { mode: 'url', message, url }
  };
}

function formRequest(message: string): object {
  return {
    method: 'elicitation/create',
    params: { mode: 'form', message, requestedSchema: CONFIRM_SCHEMA }
  };
}

function clientCapabilities(
  params: unknown
): Record<string, unknown> | undefined {
  const meta = (params as Record<string, unknown> | undefined)?._meta as
    | Record<string, unknown>
    | undefined;
  const capabilities = meta?.['io.modelcontextprotocol/clientCapabilities'];
  return typeof capabilities === 'object' && capabilities !== null
    ? (capabilities as Record<string, unknown>)
    : undefined;
}

/** Start an HTTP server on a free port and resolve to its origin. */
function listen(server: http.Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve(`http://localhost:${port}`);
    });
  });
}

export class ElicitationClientUrlModeScenario implements Scenario {
  name = 'elicitation-sep1036-client-url-mode';
  readonly source = { introducedIn: SPEC_VERSION } as const;
  description = `Tests client URL mode elicitation (SEP-1036) on the ${SPEC_VERSION} revision, where elicitation requests arrive inside an InputRequiredResult (SEP-2322).

**Client Implementation Requirements:**

1. Declare \`elicitation: { "form": {}, "url": {} }\` in \`_meta["io.modelcontextprotocol/clientCapabilities"]\` on every request.
2. Call \`tools/list\`, then call every listed tool once, in the order listed, with no arguments.
3. While a tool returns an \`InputRequiredResult\`, answer every entry in \`inputRequests\` and retry the call, echoing \`requestState\`.
4. Answer URL-mode requests with \`decline\` when the message starts with \`${DECLINE_PREFIX}\`, and with \`accept\` otherwise. Never fetch or open the URL.
5. Answer form-mode requests (explicit, or \`mode\` omitted) with \`accept\` and \`{ "confirmed": true }\`.6. Wait for held retries: two tools answer the accepted retry after ${HOLD_MS / 1000} seconds, one as \`application/json\` and one on an SSE stream.

A client without URL mode support can declare form mode only. Its URL-mode checks are then skipped.`;

  private servers: http.Server[] = [];
  private timers = new Set<NodeJS.Timeout>();
  private wireVersion: SpecVersion = SPEC_VERSION;
  private consentOrigin = '';
  private declineOrigin = '';
  private tools = new Map<string, ToolRecord>();
  /** Every `elicitation` capability the client declared, one per request. */
  private declaredElicitation: unknown[] = [];
  private consentHits: UrlHit[] = [];
  private declineHits: UrlHit[] = [];
  private held = new Map<string, HeldAttempt[]>();

  async start(ctx: ScenarioContext): Promise<ScenarioUrls> {
    this.tools = new Map(
      TOOLS.map((tool): [string, ToolRecord] => [
        tool.name,
        { called: false, restarts: 0, sentStates: [], retries: [] }
      ])
    );
    this.declaredElicitation = [];
    this.consentHits = [];
    this.declineHits = [];
    this.held = new Map<string, HeldAttempt[]>([
      [HELD_JSON_TOOL, []],
      [HELD_SSE_TOOL, []]
    ]);
    // Serve the 2026-07-28 wire, or a later stateless revision if the runner
    // resolved one.
    this.wireVersion = STATELESS_SPEC_VERSIONS.includes(ctx.specVersion)
      ? ctx.specVersion
      : SPEC_VERSION;

    // Two origins for the elicitation URLs. Everything the client may open
    // after accepting lives on the consent origin. The declined URL gets an
    // origin of its own, so any request to it (a favicon, a HEAD, a link
    // preview) is a fetch of a URL the user never consented to open.
    this.consentOrigin = await this.startUrlOrigin(this.consentHits);
    this.declineOrigin = await this.startUrlOrigin(this.declineHits);

    const app = express();
    app.use(express.json());
    app.post('/mcp', (req: Request, res: Response) =>
      this.handlePost(req, res)
    );
    const mcpServer = http.createServer(app);
    this.servers.push(mcpServer);
    return { serverUrl: `${await listen(mcpServer)}/mcp` };
  }

  async stop() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    await Promise.all(
      this.servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
          })
      )
    );
    this.servers = [];
  }

  getChecks(): ConformanceCheck[] {
    return [
      this.declaredModeCheck(),
      ...this.roundsChecks(),
      this.mixedCheck(),
      this.noModeCheck(),
      this.noPrefetchCheck(),
      this.heldRetryCheck(
        HELD_JSON_TOOL,
        'sep-1036-client-held-json-retry-complete',
        'ClientHeldJsonRetryComplete',
        'Client waits for a retry the server holds open, answered as application/json'
      ),
      this.heldRetryCheck(
        HELD_SSE_TOOL,
        'sep-1036-client-held-sse-retry-complete',
        'ClientHeldSseRetryComplete',
        'Client waits for a retry the server holds open on an SSE stream with keep-alives'
      )
    ];
  }

  private async startUrlOrigin(hits: UrlHit[]): Promise<string> {
    const server = http.createServer((req, res) => {
      hits.push({
        method: req.method ?? '',
        path: req.url ?? '',
        at: new Date().toISOString()
      });
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<p>Out-of-band interaction (conformance fixture)</p>');
    });
    this.servers.push(server);
    return listen(server);
  }

  private handlePost(req: Request, res: Response): void {
    const body = req.body as Record<string, unknown> | undefined;
    if (body !== undefined) {
      validateWireMessage(this.wireVersion, body, {
        origin: 'implementation',
        context: `client request '${body.method ?? '(unknown)'}' to ${this.name} mock`
      });
      const capabilities = clientCapabilities(body.params);
      if (capabilities && 'elicitation' in capabilities) {
        this.declaredElicitation.push(capabilities.elicitation);
      }
    }

    const v = validateStatelessRequest(req, { tools: {} }, [this.wireVersion]);
    if (v.kind !== 'route') {
      this.sendJson(
        res,
        v.status,
        v.body,
        v.kind === 'handled' ? (body?.method as string) : undefined
      );
      return;
    }

    const { id, method, params } = v;
    if (method === 'tools/list') {
      this.sendJson(
        res,
        200,
        {
          jsonrpc: '2.0',
          id,
          result: withRequiredDraftResultFields(method, { tools: TOOLS })
        },
        method
      );
      return;
    }
    if (method === 'tools/call') {
      this.handleToolCall(res, id, params);
      return;
    }
    this.sendJson(res, 404, {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    });
  }

  private handleToolCall(
    res: Response,
    id: string | number | null,
    params: Record<string, unknown>
  ): void {
    const name = params.name as string;
    const record = this.tools.get(name);
    if (!record) {
      this.sendJson(
        res,
        200,
        {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: `Unknown tool: ${name}` }
        },
        'tools/call'
      );
      return;
    }

    const inputResponses = params.inputResponses as
      | Record<string, unknown>
      | undefined;
    if (inputResponses === undefined) {
      // A fresh call starts the tool's flow over.
      if (record.called) record.restarts++;
      record.called = true;
      record.sentStates = [];
      record.retries = [];
      record.missingCapability = undefined;

      const elicitation = clientCapabilities(params)?.elicitation;
      const declared = declaredModes(elicitation);
      const missing = REQUIRED_MODES[name].filter((mode) => !declared[mode]);
      if (elicitation === undefined || missing.length > 0) {
        record.missingCapability =
          elicitation === undefined
            ? 'Client did not declare the elicitation capability'
            : `Client did not declare elicitation ${missing.join(' and ')} mode`;
        // A server MUST NOT send elicitation requests in modes the client did
        // not declare. -32021 (HTTP 400) is what the revision prescribes
        // when a request needs a capability the client lacks.
        this.sendJson(
          res,
          400,
          {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32021,
              message: `${name} needs an elicitation mode the client did not declare`,
              data: {
                requiredCapabilities: {
                  elicitation: Object.fromEntries(
                    missing.map((mode) => [mode, {}])
                  )
                }
              }
            }
          },
          'tools/call'
        );
        return;
      }
      this.sendInputRequired(res, id, name, record);
      return;
    }

    record.retries.push({
      inputResponses,
      requestState: params.requestState as string | undefined
    });
    if (name === ROUNDS_TOOL && record.retries.length < ROUNDS.length) {
      this.sendInputRequired(res, id, name, record);
      return;
    }
    if (name === HELD_JSON_TOOL) {
      this.holdJson(res, id);
      return;
    }
    if (name === HELD_SSE_TOOL) {
      this.holdSse(res, id, params);
      return;
    }
    this.sendJson(res, 200, this.completeResponse(id, name), 'tools/call');
  }

  private sendInputRequired(
    res: Response,
    id: string | number | null,
    name: string,
    record: ToolRecord
  ): void {
    const round = record.sentStates.length;
    const requestState = `${name}:${round + 1}:${randomUUID()}`;
    record.sentStates.push(requestState);
    const message = {
      jsonrpc: '2.0',
      id,
      result: {
        resultType: 'input_required',
        inputRequests: this.inputRequests(name, round),
        requestState
      }
    };
    this.sendJson(res, 200, message, 'tools/call');
  }

  private inputRequests(name: string, round: number): Record<string, unknown> {
    switch (name) {
      case DECLINE_TOOL:
        return {
          [DECLINE_KEY]: urlRequest(
            `${this.declineOrigin}/connect/service-c`,
            `${DECLINE_PREFIX} Connect your Service C account to continue.`
          )
        };
      case ROUNDS_TOOL: {
        const { key, path, message } = ROUNDS[round];
        return { [key]: urlRequest(`${this.consentOrigin}${path}`, message) };
      }
      case NO_MODE_TOOL:
        // No `mode`, so this is form mode. The stray `url` field catches a
        // client that picks URL mode by looking for one.
        return {
          [NO_MODE_KEY]: {
            method: 'elicitation/create',
            params: {
              message: 'Please confirm to continue.',
              requestedSchema: CONFIRM_SCHEMA,
              url: `${this.consentOrigin}/not-a-url-mode-request`
            }
          }
        };
      case MIXED_TOOL:
        return {
          [MIXED_URL_KEY]: urlRequest(
            `${this.consentOrigin}/connect/service-d`,
            'Connect your Service D account to continue.'
          ),
          [MIXED_FORM_KEY]: formRequest('Confirm the details for Service D.')
        };
      default: {
        // HELD_JSON_TOOL and HELD_SSE_TOOL
        const { key, path } = HELD_REQUESTS[name];
        return {
          [key]: urlRequest(
            `${this.consentOrigin}${path}`,
            'Finish connecting your account in the browser.'
          )
        };
      }
    }
  }

  private completeResponse(id: string | number | null, name: string): object {
    return {
      jsonrpc: '2.0',
      id,
      result: withRequiredDraftResultFields('tools/call', {
        content: [{ type: 'text', text: `${name}: complete` }]
      })
    };
  }

  /** Record when the client gives up on a held retry, or when it is answered. */
  private startHeldAttempt(name: string, res: Response): HeldAttempt {
    const attempt: HeldAttempt = {};
    this.held.get(name)!.push(attempt);
    const startedAt = Date.now();
    res.on('finish', () => {
      attempt.answeredAfterMs = Date.now() - startedAt;
    });
    // `close` also follows a normal finish. Only a close before the response
    // was fully written means the client cancelled the request.
    res.on('close', () => {
      if (!res.writableFinished) {
        attempt.cancelledAfterMs = Date.now() - startedAt;
      }
    });
    return attempt;
  }

  private holdJson(res: Response, id: string | number | null): void {
    const attempt = this.startHeldAttempt(HELD_JSON_TOOL, res);
    // Nothing is written while the retry is held: the client sees no bytes
    // until the response arrives.
    this.schedule(HOLD_MS, () => {
      if (attempt.cancelledAfterMs !== undefined || res.writableEnded) return;
      this.sendJson(
        res,
        200,
        this.completeResponse(id, HELD_JSON_TOOL),
        'tools/call'
      );
    });
  }

  private holdSse(
    res: Response,
    id: string | number | null,
    params: Record<string, unknown>
  ): void {
    const attempt = this.startHeldAttempt(HELD_SSE_TOOL, res);
    const progressToken = (params._meta as Record<string, unknown> | undefined)
      ?.progressToken;
    const open = () =>
      attempt.cancelledAfterMs === undefined && !res.writableEnded;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();

    const ticks = HOLD_MS / KEEP_ALIVE_MS;
    for (let tick = 1; tick < ticks; tick++) {
      this.schedule(tick * KEEP_ALIVE_MS, () => {
        if (!open()) return;
        // An SSE comment line carries no event. It keeps intermediaries and
        // idle timeouts from closing a quiet stream.
        res.write(': keep-alive\n\n');
        if (
          typeof progressToken === 'string' ||
          typeof progressToken === 'number'
        ) {
          this.writeSseEvent(res, {
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: {
              progressToken,
              progress: tick,
              total: ticks,
              message: 'Waiting for the out-of-band interaction to finish'
            }
          });
        }
      });
    }
    this.schedule(HOLD_MS, () => {
      if (!open()) return;
      this.writeSseEvent(
        res,
        this.completeResponse(id, HELD_SSE_TOOL),
        'tools/call'
      );
      res.end();
    });
  }

  private schedule(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }

  private sendJson(
    res: Response,
    status: number,
    message: object,
    requestMethod?: string
  ): void {
    validateWireMessage(this.wireVersion, message, {
      origin: 'harness',
      context: `${this.name} mock response${requestMethod ? ` to '${requestMethod}'` : ''}`,
      requestMethod
    });
    res.status(status).json(message);
  }

  private writeSseEvent(
    res: Response,
    message: object,
    requestMethod?: string
  ): void {
    validateWireMessage(this.wireVersion, message, {
      origin: 'harness',
      context: `${this.name} mock SSE event`,
      requestMethod
    });
    res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  }

  private declaredModeCheck(): ConformanceCheck {
    if (this.declaredElicitation.length === 0) {
      return {
        id: 'sep-1036-client-supports-declared-mode',
        name: 'ClientDeclaresElicitationMode',
        description:
          'Clients declaring the elicitation capability MUST support at least one mode (form or url)',
        status: 'SKIPPED',
        timestamp: new Date().toISOString(),
        errorMessage: 'Client never declared the elicitation capability',
        specReferences: CAPABILITIES_REFERENCES
      };
    }

    // `{}` is form mode only, so the only declarations that break the rule
    // name neither mode (e.g. `{ "foo": {} }`).
    const withoutMode = [
      ...new Set(
        this.declaredElicitation
          .filter((elicitation) => {
            const modes = declaredModes(elicitation);
            return !modes.form && !modes.url;
          })
          .map((elicitation) => JSON.stringify(elicitation))
      )
    ];
    return {
      id: 'sep-1036-client-supports-declared-mode',
      name: 'ClientDeclaresElicitationMode',
      description:
        'Clients declaring the elicitation capability MUST support at least one mode (form or url)',
      status: withoutMode.length === 0 ? 'SUCCESS' : 'FAILURE',
      timestamp: new Date().toISOString(),
      errorMessage:
        withoutMode.length > 0
          ? `Client declared elicitation without form or url mode: ${withoutMode.join(', ')}`
          : undefined,
      specReferences: CAPABILITIES_REFERENCES,
      details: {
        declared: [
          ...new Set(this.declaredElicitation.map((e) => JSON.stringify(e)))
        ]
      }
    };
  }

  private roundsChecks(): ConformanceCheck[] {
    const record = this.tools.get(ROUNDS_TOOL)!;
    if (record.missingCapability) {
      return [
        {
          id: 'sep-2322-client-constructs-inputs',
          name: 'ClientConstructsInputsUrlRounds',
          description:
            'Client MUST construct the input for every new URL-mode request before retrying, round after round',
          status: 'SKIPPED',
          timestamp: new Date().toISOString(),
          errorMessage: record.missingCapability,
          specReferences: MRTR_CLIENT_REFERENCES
        },
        {
          id: 'sep-2322-client-request-state-echoed',
          name: 'ClientRequestStateEchoedUrlRounds',
          description:
            'Client MUST echo back the exact value of the newest requestState on every retry of a URL-mode flow',
          status: 'SKIPPED',
          timestamp: new Date().toISOString(),
          errorMessage: record.missingCapability,
          specReferences: MRTR_CLIENT_REFERENCES
        }
      ];
    }

    const constructErrors: string[] = [];
    const stateErrors: string[] = [];
    ROUNDS.forEach((round, i) => {
      const retry = record.retries[i];
      if (!retry) return;

      const answer = retry.inputResponses[round.key];
      const action = actionOf(answer);
      if (answer === undefined) {
        constructErrors.push(
          `Round ${i + 1}: the retry did not answer '${round.key}' (it answered: ${Object.keys(retry.inputResponses).join(', ') || 'nothing'})`
        );
      } else if (action === undefined) {
        constructErrors.push(
          `Round ${i + 1}: '${round.key}' was answered with ${JSON.stringify(answer)}, which is not an ElicitResult`
        );
      } else if (action !== round.expected) {
        constructErrors.push(
          `Round ${i + 1}: '${round.key}' was answered '${action}', but its message ${round.expected === 'decline' ? 'starts' : 'does not start'} with "${DECLINE_PREFIX}", so the client's handler answers '${round.expected}'. The answer was not built from this request.`
        );
      }

      const sentState = record.sentStates[i];
      if (retry.requestState === undefined) {
        stateErrors.push(
          `Round ${i + 1}: the retry did not include requestState`
        );
      } else if (retry.requestState !== sentState) {
        const earlier = record.sentStates.indexOf(retry.requestState);
        stateErrors.push(
          earlier >= 0 && earlier < i
            ? `Round ${i + 1}: the retry echoed the requestState from round ${earlier + 1}`
            : `Round ${i + 1}: requestState was not echoed back exactly`
        );
      }
    });

    const roundsAnswered = Math.min(record.retries.length, ROUNDS.length);
    const incompleteReason = !record.called
      ? `Client never called ${ROUNDS_TOOL}`
      : `Client stopped retrying ${ROUNDS_TOOL} after ${roundsAnswered} of ${ROUNDS.length} rounds`;
    const details = {
      roundsAnswered,
      restarts: record.restarts,
      requestStatesSent: record.sentStates,
      retries: record.retries
    };

    const checks: ConformanceCheck[] = [];
    if (constructErrors.length === 0 && roundsAnswered < ROUNDS.length) {
      checks.push(
        untestableCheck(
          'sep-2322-client-constructs-inputs',
          'ClientConstructsInputsUrlRounds',
          'Client MUST construct the input for every new URL-mode request before retrying, round after round',
          incompleteReason,
          MRTR_CLIENT_REFERENCES
        )
      );
    } else {
      checks.push({
        id: 'sep-2322-client-constructs-inputs',
        name: 'ClientConstructsInputsUrlRounds',
        description:
          'Client MUST construct the input for every new URL-mode request before retrying, round after round',
        status: constructErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage:
          constructErrors.length > 0 ? constructErrors.join('; ') : undefined,
        specReferences: MRTR_CLIENT_REFERENCES,
        details
      });
    }

    if (stateErrors.length === 0 && roundsAnswered < ROUNDS.length) {
      checks.push(
        untestableCheck(
          'sep-2322-client-request-state-echoed',
          'ClientRequestStateEchoedUrlRounds',
          'Client MUST echo back the exact value of the newest requestState on every retry of a URL-mode flow',
          incompleteReason,
          MRTR_CLIENT_REFERENCES
        )
      );
    } else {
      checks.push({
        id: 'sep-2322-client-request-state-echoed',
        name: 'ClientRequestStateEchoedUrlRounds',
        description:
          'Client MUST echo back the exact value of the newest requestState on every retry of a URL-mode flow',
        status: stateErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage:
          stateErrors.length > 0 ? stateErrors.join('; ') : undefined,
        specReferences: MRTR_CLIENT_REFERENCES,
        details
      });
    }
    return checks;
  }

  private mixedCheck(): ConformanceCheck {
    const record = this.tools.get(MIXED_TOOL)!;
    if (record.missingCapability) {
      return {
        id: 'sep-2322-client-constructs-inputs-mixed',
        name: 'ClientConstructsInputsMixedModes',
        description:
          'Client MUST construct both a URL-mode and a form-mode input sent together before retrying',
        status: 'SKIPPED',
        timestamp: new Date().toISOString(),
        errorMessage: record.missingCapability,
        specReferences: MRTR_CLIENT_REFERENCES
      };
    }
    const retry = record.retries[0];
    if (!retry) {
      return untestableCheck(
        'sep-2322-client-constructs-inputs-mixed',
        'ClientConstructsInputsMixedModes',
        'Client MUST construct both a URL-mode and a form-mode input sent together before retrying',
        record.called
          ? `Client never retried ${MIXED_TOOL}`
          : `Client never called ${MIXED_TOOL}`,
        MRTR_CLIENT_REFERENCES
      );
    }

    const errors: string[] = [];
    const urlAnswer = retry.inputResponses[MIXED_URL_KEY];
    const formAnswer = retry.inputResponses[MIXED_FORM_KEY];
    const formContent = (formAnswer as Record<string, unknown> | undefined)
      ?.content;
    if (urlAnswer === undefined) {
      errors.push(
        `The retry did not answer the URL-mode request '${MIXED_URL_KEY}'`
      );
    } else if (actionOf(urlAnswer) !== 'accept') {
      errors.push(
        `'${MIXED_URL_KEY}' was answered ${JSON.stringify(urlAnswer)}; the client's handler accepts this URL-mode request`
      );
    }
    if (formAnswer === undefined) {
      errors.push(
        `The retry did not answer the form-mode request '${MIXED_FORM_KEY}'`
      );
    } else if (
      actionOf(formAnswer) !== 'accept' ||
      typeof formContent !== 'object' ||
      formContent === null
    ) {
      errors.push(
        `'${MIXED_FORM_KEY}' was answered ${JSON.stringify(formAnswer)}; the client's handler accepts this form-mode request with content`
      );
    }

    return {
      id: 'sep-2322-client-constructs-inputs-mixed',
      name: 'ClientConstructsInputsMixedModes',
      description:
        'Client MUST construct both a URL-mode and a form-mode input sent together before retrying',
      status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
      timestamp: new Date().toISOString(),
      errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
      specReferences: MRTR_CLIENT_REFERENCES,
      details: { inputResponses: retry.inputResponses }
    };
  }

  private noModeCheck(): ConformanceCheck {
    const record = this.tools.get(NO_MODE_TOOL)!;
    if (record.missingCapability) {
      return {
        id: 'sep-1036-client-missing-mode-is-form',
        name: 'ClientMissingModeIsForm',
        description:
          'Clients MUST treat elicitation requests without a mode field as form mode',
        status: 'SKIPPED',
        timestamp: new Date().toISOString(),
        errorMessage: record.missingCapability,
        specReferences: ELICITATION_REQUESTS_REFERENCES
      };
    }
    const retry = record.retries[0];
    const answer = retry?.inputResponses[NO_MODE_KEY];
    const action = actionOf(answer);
    if (!retry || action === 'decline' || action === 'cancel') {
      return untestableCheck(
        'sep-1036-client-missing-mode-is-form',
        'ClientMissingModeIsForm',
        'Clients MUST treat elicitation requests without a mode field as form mode',
        !record.called
          ? `Client never called ${NO_MODE_TOOL}`
          : !retry
            ? `Client never retried ${NO_MODE_TOOL}, so it never answered the request without mode`
            : `Client answered '${action}' where its handler accepts form-mode requests; a ${action} does not show which mode the client assumed`,
        ELICITATION_REQUESTS_REFERENCES
      );
    }

    const content = (answer as Record<string, unknown> | undefined)?.content;
    let error: string | undefined;
    if (answer === undefined) {
      error = `The retry did not answer '${NO_MODE_KEY}'`;
    } else if (action !== 'accept') {
      error = `'${NO_MODE_KEY}' was answered with ${JSON.stringify(answer)}, which is not an ElicitResult`;
    } else if (typeof content !== 'object' || content === null) {
      // An accept without content is how a URL-mode request is answered.
      error =
        'The client accepted without content, as it would a URL-mode request. A request without mode is form mode, even when it carries a url field.';
    }

    return {
      id: 'sep-1036-client-missing-mode-is-form',
      name: 'ClientMissingModeIsForm',
      description:
        'Clients MUST treat elicitation requests without a mode field as form mode',
      status: error === undefined ? 'SUCCESS' : 'FAILURE',
      timestamp: new Date().toISOString(),
      errorMessage: error,
      specReferences: ELICITATION_REQUESTS_REFERENCES,
      details: { answer }
    };
  }

  private noPrefetchCheck(): ConformanceCheck {
    const record = this.tools.get(DECLINE_TOOL)!;
    if (record.missingCapability) {
      return {
        id: 'sep-1036-client-no-url-prefetch',
        name: 'ClientNoUrlPrefetch',
        description:
          'Client MUST NOT pre-fetch a URL-mode URL (judged on a URL the user declined)',
        status: 'SKIPPED',
        timestamp: new Date().toISOString(),
        errorMessage: record.missingCapability,
        specReferences: SAFE_URL_HANDLING_REFERENCES
      };
    }

    // Only a declined URL can be judged. In the URL Mode Flow the client
    // opens the URL before it sends the accept retry, so on the accept path a
    // consented open looks identical to a prefetch. Cancel can't be judged
    // either: the spec's cancel examples include "browser failed to load",
    // which implies the URL was opened.
    const answer = record.retries[0]?.inputResponses[DECLINE_KEY];
    if (actionOf(answer) !== 'decline') {
      return untestableCheck(
        'sep-1036-client-no-url-prefetch',
        'ClientNoUrlPrefetch',
        'Client MUST NOT pre-fetch a URL-mode URL (judged on a URL the user declined)',
        !record.called
          ? `Client never called ${DECLINE_TOOL}`
          : record.retries.length === 0
            ? `Client never retried ${DECLINE_TOOL}, so it never declined the URL`
            : `Client answered ${JSON.stringify(answer)} instead of declining a request whose message starts with "${DECLINE_PREFIX}"; a fetch can only be judged on a declined URL`,
        SAFE_URL_HANDLING_REFERENCES
      );
    }

    return {
      id: 'sep-1036-client-no-url-prefetch',
      name: 'ClientNoUrlPrefetch',
      description:
        'Client MUST NOT pre-fetch a URL-mode URL (judged on a URL the user declined)',
      status: this.declineHits.length === 0 ? 'SUCCESS' : 'FAILURE',
      timestamp: new Date().toISOString(),
      errorMessage:
        this.declineHits.length > 0
          ? `The client declined the URL but still requested its origin ${this.declineHits.length} time(s): ${this.declineHits.map((hit) => `${hit.method} ${hit.path}`).join(', ')}`
          : undefined,
      specReferences: SAFE_URL_HANDLING_REFERENCES,
      details: { declineHits: this.declineHits, consentHits: this.consentHits }
    };
  }

  private heldRetryCheck(
    name: string,
    id: string,
    checkName: string,
    description: string
  ): ConformanceCheck {
    const record = this.tools.get(name)!;
    if (record.missingCapability) {
      return {
        id,
        name: checkName,
        description,
        status: 'SKIPPED',
        timestamp: new Date().toISOString(),
        errorMessage: record.missingCapability,
        specReferences: URL_MODE_FLOW_REFERENCES
      };
    }
    const attempts = this.held.get(name)!;
    const first = attempts[0];
    if (!first) {
      return untestableCheck(
        id,
        checkName,
        description,
        record.called
          ? `Client never retried ${name} after the URL-mode request`
          : `Client never called ${name}`,
        URL_MODE_FLOW_REFERENCES
      );
    }

    let error: string | undefined;
    if (first.cancelledAfterMs !== undefined) {
      error = `The client closed the held retry after ${first.cancelledAfterMs} ms; the server answers after ${HOLD_MS} ms`;
    } else if (first.answeredAfterMs === undefined) {
      error = `The held retry was still open when the client finished; the server answers after ${HOLD_MS} ms`;
    }

    return {
      id,
      name: checkName,
      description,
      status: error === undefined ? 'SUCCESS' : 'FAILURE',
      timestamp: new Date().toISOString(),
      errorMessage: error,
      specReferences: URL_MODE_FLOW_REFERENCES,
      details: { holdMs: HOLD_MS, attempts }
    };
  }
}
