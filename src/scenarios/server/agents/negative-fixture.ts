/**
 * The fixture the agent discovery negative controls are graded against.
 *
 * One server, two scenarios. Every option here exists to break exactly one
 * rule while leaving the rest of the wire conformant, so a check that flips
 * says which rule it caught. With no options it is a conformant server, which
 * is what the false-positive test runs against.
 *
 * It speaks the SEP-2575 stateless wire (`server/discover` plus one POST per
 * request), built per test rather than checked in as an example server, as the
 * SEP-2640 negative tests do. `subscriptions/listen` is a real SSE response
 * held open until the client aborts, so the list-changed rows see a
 * notification arrive on a live stream.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { withRequiredDraftResultFields } from '../../../mock-server';
import { DRAFT_PROTOCOL_VERSION } from '../../../types';
import {
  AGENTS_EXTENSION_ID,
  AGENTS_LIST_CHANGED_FILTER_KEY,
  AGENTS_LIST_CHANGED_NOTIFICATION,
  CONTROL_ADD_AGENT,
  CONTROL_FIXTURE,
  SUBSCRIPTIONS_ACKNOWLEDGED_NOTIFICATION,
  isObject
} from './helpers';

export interface FixtureAgent {
  name: string;
  description?: string;
  capabilities?: string[];
  instructions?: string;
  modelRoutingHint?: unknown;
  tools: string[];
}

/** The catalog every fixture serves. `search` is shared by two agents. */
export function catalog(): Record<string, unknown>[] {
  return [
    {
      name: 'search',
      description: 'Search the index.',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } }
    },
    {
      name: 'summarize',
      description: 'Summarize a document.',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'secret_tool',
      description: 'Belongs to the hidden agent.',
      inputSchema: { type: 'object', properties: {} }
    }
  ];
}

/** The roster every fixture serves, before any test overrides it. */
export function roster(): FixtureAgent[] {
  return [
    {
      name: 'research-agent',
      description: 'Researches things',
      capabilities: ['research'],
      instructions: 'Research the question.',
      modelRoutingHint: { role: 'medium', vision: false },
      tools: ['search']
    },
    {
      name: 'writer-agent',
      capabilities: ['writing'],
      tools: ['search', 'summarize']
    }
  ];
}

export const HIDDEN_AGENT = 'hidden-agent';
export const BROKEN_AGENT = 'broken-agent';

const NOT_FOUND = {
  code: -32602,
  message: 'agent not found',
  data: { reason: 'agent_not_found' }
};

export interface AgentsFixtureOptions {
  /** The value declared under extensions; `null` leaves it undeclared. */
  declared?: unknown;
  agents?: FixtureAgent[];
  /** Agents per agents/list page. Default 1, so paging is exercised. */
  pageSize?: number;
  /** Answer agents/list with -32601 instead of a roster. */
  listUnimplemented?: boolean;
  /** Members merged into every agents/list page result. */
  listOverrides?: Record<string, unknown>;
  /** Hand out the same cursor forever. */
  loopingCursor?: boolean;
  /** Members merged into the card for one agent name. */
  cardOverrides?: Record<string, Record<string, unknown>>;
  /** Members merged into the agents/get result for one agent name. */
  getOverrides?: Record<string, Record<string, unknown>>;
  /** Fail agents/get for these listed agents with -32603. */
  getFails?: string[];
  /** Tools served by agents/get for one agent, replacing the catalog lookup. */
  getTools?: Record<string, Record<string, unknown>[]>;
  /** The error agents/get gives for a name it does not know. */
  unknownError?: Record<string, unknown>;
  /** The error agents/get gives for the hidden agent. */
  hiddenError?: Record<string, unknown>;
  /** List the hidden agent in agents/list anyway. */
  listHidden?: boolean;
  /** The error agents/get gives for the broken agent. */
  brokenError?: Record<string, unknown>;
  /** Refuse tools/list from a client that did not declare the extension. */
  coreRequiresExtension?: boolean;
  /** Leave out the named control tools. */
  withoutControls?: string[];
  /** Leave agentsListChanged out of the listen acknowledgement. */
  ackDropsKey?: boolean;
  /** Acknowledge agentsListChanged even when listChanged is not declared. */
  ackAlways?: boolean;
  /** Add agents without sending notifications/agents/list_changed. */
  silentAdd?: boolean;
  /** Send the notification but leave the roster unchanged. */
  addWithoutChange?: boolean;
}

export interface AgentsFixture {
  url: string;
  close(): Promise<void>;
}

async function readJsonBody(
  req: IncomingMessage
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
    string,
    unknown
  >;
}

function clientDeclaredAgents(params: Record<string, unknown>): boolean {
  const meta = isObject(params._meta) ? params._meta : {};
  const caps = meta['io.modelcontextprotocol/clientCapabilities'];
  return (
    isObject(caps) &&
    isObject(caps.extensions) &&
    AGENTS_EXTENSION_ID in caps.extensions
  );
}

export async function startAgentsFixture(
  opts: AgentsFixtureOptions = {}
): Promise<AgentsFixture> {
  const declared =
    opts.declared === undefined ? { listChanged: true } : opts.declared;
  const agents = (opts.agents ?? roster()).map((a) => ({ ...a }));
  const tools = catalog();
  const pageSize = opts.pageSize ?? 1;
  const listeners = new Set<ServerResponse>();
  const without = new Set(opts.withoutControls ?? []);

  const controls = [
    {
      name: CONTROL_FIXTURE,
      description: 'Names the hidden and broken agents.',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: CONTROL_ADD_AGENT,
      description: 'Adds an agent to the roster.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name']
      }
    }
  ].filter((c) => !without.has(c.name));

  const visible = (): FixtureAgent[] => {
    const out = [
      ...agents,
      { name: BROKEN_AGENT, capabilities: [], tools: ['missing_tool'] }
    ];
    if (opts.listHidden) {
      out.push({
        name: HIDDEN_AGENT,
        capabilities: [],
        tools: ['secret_tool']
      });
    }
    return out;
  };

  const card = (a: FixtureAgent): Record<string, unknown> => {
    const c: Record<string, unknown> = {
      name: a.name,
      capabilities: a.capabilities ?? []
    };
    if (a.description !== undefined) c.description = a.description;
    return { ...c, ...(opts.cardOverrides?.[a.name] ?? {}) };
  };

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const body = await readJsonBody(req);
    const method = body.method as string;
    const id = body.id;
    const params = isObject(body.params) ? body.params : {};
    const send = (result: object) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: withRequiredDraftResultFields(method, result)
        })
      );
    };
    const fail = (error: Record<string, unknown>) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, error }));
    };

    switch (method) {
      case 'server/discover': {
        const extensions =
          declared === null ? {} : { [AGENTS_EXTENSION_ID]: declared };
        send({
          supportedVersions: [DRAFT_PROTOCOL_VERSION],
          capabilities: { tools: {}, extensions },
          serverInfo: { name: 'agents-negative', version: '1.0.0' }
        });
        return;
      }
      case 'tools/list': {
        if (opts.coreRequiresExtension && !clientDeclaredAgents(params)) {
          fail({ code: -32600, message: 'declare the agents extension first' });
          return;
        }
        send({ tools: [...tools, ...controls] });
        return;
      }
      case 'tools/call': {
        const name = params.name;
        const args = isObject(params.arguments) ? params.arguments : {};
        if (name === CONTROL_FIXTURE && !without.has(CONTROL_FIXTURE)) {
          send({
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  hiddenAgent: HIDDEN_AGENT,
                  brokenAgent: BROKEN_AGENT
                })
              }
            ]
          });
          return;
        }
        if (name === CONTROL_ADD_AGENT && !without.has(CONTROL_ADD_AGENT)) {
          if (!opts.addWithoutChange) {
            agents.push({
              name: String(args.name),
              capabilities: [],
              tools: ['search']
            });
          }
          if (!opts.silentAdd) {
            const frame = JSON.stringify({
              jsonrpc: '2.0',
              method: AGENTS_LIST_CHANGED_NOTIFICATION,
              params: {}
            });
            for (const l of listeners) l.write(`data: ${frame}\n\n`);
          }
          send({ content: [{ type: 'text', text: 'ok' }] });
          return;
        }
        send({ content: [{ type: 'text', text: 'done' }] });
        return;
      }
      case 'agents/list': {
        if (opts.listUnimplemented) {
          fail({ code: -32601, message: 'method not found' });
          return;
        }
        const all = visible();
        const start =
          typeof params.cursor === 'string' ? Number(params.cursor) : 0;
        const page = all.slice(start, start + pageSize).map(card);
        const next =
          start + pageSize < all.length ? String(start + pageSize) : undefined;
        const result: Record<string, unknown> = {
          agents: page,
          ttlMs: 60000,
          cacheScope: 'private',
          ...(opts.loopingCursor
            ? { nextCursor: '0' }
            : next
              ? { nextCursor: next }
              : {}),
          ...(opts.listOverrides ?? {})
        };
        send(result);
        return;
      }
      case 'agents/get': {
        const name = params.name;
        if (name === HIDDEN_AGENT) {
          fail(opts.hiddenError ?? NOT_FOUND);
          return;
        }
        if (name === BROKEN_AGENT) {
          fail(
            opts.brokenError ?? {
              code: -32603,
              message: 'agent names a missing tool',
              data: { reason: 'invalid_agent_definition' }
            }
          );
          return;
        }
        const agent = agents.find((a) => a.name === name);
        if (!agent) {
          fail(opts.unknownError ?? NOT_FOUND);
          return;
        }
        if (opts.getFails?.includes(agent.name)) {
          fail({ code: -32603, message: 'boom' });
          return;
        }
        const result: Record<string, unknown> = {
          agent: agent.name,
          tools:
            opts.getTools?.[agent.name] ??
            agent.tools.map((t) => tools.find((c) => c.name === t)),
          ttlMs: 60000,
          cacheScope: 'private'
        };
        if (agent.instructions !== undefined) {
          result.instructions = agent.instructions;
        }
        if (agent.modelRoutingHint !== undefined) {
          result.modelRoutingHint = agent.modelRoutingHint;
        }
        send({ ...result, ...(opts.getOverrides?.[agent.name] ?? {}) });
        return;
      }
      case 'subscriptions/listen': {
        const filter = isObject(params.notifications)
          ? params.notifications
          : {};
        const declaredTrue =
          isObject(declared) && declared.listChanged === true;
        const honor =
          filter[AGENTS_LIST_CHANGED_FILTER_KEY] === true &&
          (declaredTrue || opts.ackAlways) &&
          !opts.ackDropsKey;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const ack = JSON.stringify({
          jsonrpc: '2.0',
          method: SUBSCRIPTIONS_ACKNOWLEDGED_NOTIFICATION,
          params: {
            notifications: honor
              ? { [AGENTS_LIST_CHANGED_FILTER_KEY]: true }
              : {},
            _meta: { 'io.modelcontextprotocol/subscriptionId': id }
          }
        });
        res.write(`data: ${ack}\n\n`);
        listeners.add(res);
        req.on('close', () => listeners.delete(res));
        return;
      }
      default:
        fail({ code: -32601, message: `method not found: ${method}` });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const l of listeners) l.end();
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  };
}
