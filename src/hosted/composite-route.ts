/**
 * The composite route, `/s/<run-id>/<rev>/<a>+<b>+…[/mcp]` (see ./composite.ts):
 * checks the children, serves the composite's page, and sends each MCP
 * request to the child cell that owns it or to every child cell at once.
 */

import type { Request, Response } from 'express';
import { MCP_PATH, type HostedMatrix } from './matrix';
import {
  freshScenario,
  hostedScenarioContext,
  loadCells,
  type CellRef,
  type HostedRun
} from './session';
import { onBodySettled } from './body';
import { jsonRpcMessages } from './wire';
import { replay, type Replayed } from './replay';
import {
  COMPOSITE_SEPARATOR,
  mergeLifecycle,
  mergeList,
  notComposableReason,
  ownerKey,
  routeFor,
  type ChildResult,
  type CompositeView
} from './composite';
import { renderComposite } from './html';
import { hostedScenarios } from './catalog';
import type { SpecVersion } from '../types';

/** What the composite route borrows from the hosted server. */
export interface CompositeDeps {
  matrix: HostedMatrix;
  /** The cell, not yet seeded; undefined (request answered) if unmountable. */
  mountCell(req: Request, ref: CellRef, res: Response): HostedRun | undefined;
  /** Seed the cells from the store unless the request needs no history. */
  prepare(runs: HostedRun[], req: Request, mcp: boolean): Promise<void>;
  dispatch(
    run: HostedRun,
    listener: (req: Request, res: Response) => void,
    req: Request,
    res: Response,
    rewrittenUrl: string,
    mcp: boolean
  ): void;
  cellBaseUrl(req: Request, ref: CellRef): string;
  resultsUrlFor(req: Request, ...parts: string[]): string;
  isPageRequest(req: Request): boolean;
  wantsHtml(req: Request): boolean;
}

const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';

/** A child's JSON-RPC result for request `id`, or undefined for an error. */
function resultOf(
  reply: Replayed,
  id: unknown
): Record<string, unknown> | undefined {
  if (reply.status >= 400) return undefined;
  const messages = jsonRpcMessages(reply.body, reply.contentType);
  const result = (messages.find((m) => m.id === id) ?? messages[0])?.result;
  return typeof result === 'object' && result !== null && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : undefined;
}

/** A list request valid on either wire, for learning who owns what. */
function discoveryRequest(
  req: Request,
  revision: SpecVersion,
  list: string
): { original: Request; body: Buffer } {
  const original = {
    method: 'POST',
    url: '/',
    protocol: req.protocol,
    query: {},
    headers: {
      host: req.headers.host ?? 'localhost',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': revision,
      'mcp-method': list
    }
  } as unknown as Request;
  const body = Buffer.from(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: list,
      params: {
        _meta: {
          [META_PROTOCOL_VERSION]: revision,
          [META_CLIENT_CAPABILITIES]: {}
        }
      }
    })
  );
  return { original, body };
}

export type CompositeHandler = (
  req: Request,
  res: Response,
  runId: string,
  revision: SpecVersion,
  names: string[],
  suffix: string
) => Promise<void>;

export function createCompositeRoute(deps: CompositeDeps): CompositeHandler {
  // Which child owns each tool, prompt and resource. Learned by asking fresh
  // throwaway instances, never the run's cells, so no child's log records a
  // request the client did not send. Per process: each isolate learns once.
  const owners = new Map<string, Promise<Map<string, string>>>();

  function invalid(
    revision: SpecVersion,
    names: string[]
  ): { status: number; error: string } | undefined {
    if (names.length < 2) {
      return {
        status: 404,
        error: `a composite joins two or more scenarios with '${COMPOSITE_SEPARATOR}'`
      };
    }
    for (const name of names) {
      if (!hostedScenarios.has(name)) {
        return { status: 404, error: `unknown scenario '${name}'` };
      }
      const reason = notComposableReason(name);
      if (reason) {
        return {
          status: 400,
          error: `'${name}' cannot share a URL: it ${reason}`
        };
      }
      const cell = deps.matrix.cell(name, revision);
      if (!cell || cell.scoring === 'n/a') {
        return {
          status: 404,
          error: `scenario '${name}' does not apply to ${revision}${cell?.reason ? `: ${cell.reason}` : ''}`
        };
      }
      if (!cell.startable) {
        return {
          status: 501,
          error: `scenario '${name}' at ${revision} cannot be started here: ${cell.startReason}`
        };
      }
    }
    return undefined;
  }

  function view(
    req: Request,
    runId: string,
    revision: SpecVersion,
    names: string[]
  ): CompositeView {
    const scenarioName = names.join(COMPOSITE_SEPARATOR);
    return {
      runId,
      revision,
      url: `${deps.cellBaseUrl(req, { runId, revision, scenarioName })}${MCP_PATH}`,
      resultsUrl: deps.resultsUrlFor(req, runId, revision),
      children: names.map((name) => {
        const cell = deps.matrix.cell(name, revision)!;
        return {
          scenario: name,
          description: hostedScenarios.meta(name)!.description,
          resultsUrl: deps.resultsUrlFor(req, runId, revision, name),
          ...(cell.steps && { steps: cell.steps })
        };
      })
    };
  }

  function ownersOf(
    req: Request,
    revision: SpecVersion,
    names: string[],
    list: string
  ): Promise<Map<string, string>> {
    const key = `${revision}/${names.join(COMPOSITE_SEPARATOR)}/${list}`;
    let found = owners.get(key);
    if (found) return found;
    found = (async () => {
      const results: ChildResult[] = [];
      for (const name of names) {
        const scenario = freshScenario(hostedScenarios.get(name)!);
        const url = deps.cellBaseUrl(req, {
          runId: 'owners',
          revision,
          scenarioName: name
        });
        const listener = scenario.handler?.(
          () => url,
          hostedScenarioContext(revision)
        );
        if (!listener) continue;
        const { original, body } = discoveryRequest(req, revision, list);
        const reply = await replay(original, body, (r, s) => {
          r.url = scenario.mcpPath || '/';
          listener(r, s);
        });
        results.push({ child: name, result: resultOf(reply, 1) });
      }
      const learned = new Map<string, string>();
      for (const [item, child] of mergeList(list, results)?.owners ?? []) {
        learned.set(ownerKey(list, item), child);
      }
      return learned;
    })();
    owners.set(key, found);
    return found;
  }

  return async function handleComposite(
    req,
    res,
    runId,
    revision,
    names,
    suffix
  ) {
    const problem = invalid(revision, names);
    if (problem) {
      res.status(problem.status).json({ error: problem.error });
      return;
    }
    if (deps.isPageRequest(req)) {
      // A browser opening the MCP URL itself is sent to the page about it.
      if (suffix !== '') {
        const q = req.originalUrl.indexOf('?');
        const page = deps.cellBaseUrl(req, {
          runId,
          revision,
          scenarioName: names.join(COMPOSITE_SEPARATOR)
        });
        res.redirect(303, q === -1 ? page : page + req.originalUrl.slice(q));
        return;
      }
      const v = view(req, runId, revision, names);
      if (deps.wantsHtml(req)) res.type('html').send(renderComposite(v));
      else res.json(v);
      return;
    }

    await loadCells(names.map((scenarioName) => ({ scenarioName, revision })));
    const runs: HostedRun[] = [];
    for (const scenarioName of names) {
      const run = deps.mountCell(req, { runId, revision, scenarioName }, res);
      if (!run) return;
      runs.push(run);
    }
    // All children at once: a discover (merged below from every child's
    // answer) does not wait on the store, anything else waits one round
    // trip rather than one per child.
    await deps.prepare(runs, req, true);
    const pathOf = (run: HostedRun) => run.mcpPath || '/';
    const forward = (run: HostedRun) =>
      deps.dispatch(run, run.listener, req, res, pathOf(run), true);

    if (req.method !== 'POST') {
      forward(runs[0]);
      return;
    }

    const route = async (body: Buffer | undefined) => {
      const messages = body
        ? jsonRpcMessages(body.toString('utf8'), 'application/json')
        : [];
      // A batch goes to the first child whole.
      const message = messages.length === 1 ? messages[0] : undefined;
      const where = routeFor(message);
      if (where.kind === 'first') return forward(runs[0]);
      if (where.kind === 'addressed') {
        const owner = (await ownersOf(req, revision, names, where.list)).get(
          ownerKey(where.list, where.item)
        );
        return forward(
          runs.find((run) => run.scenarioName === owner) ?? runs[0]
        );
      }

      // Every child sees the request exactly as the client sent it.
      const replies = await Promise.all(
        runs.map((run) =>
          replay(req, body ?? Buffer.alloc(0), (r, s) =>
            deps.dispatch(run, run.listener, r, s, pathOf(run), true)
          )
        )
      );
      if (where.kind === 'notification') {
        res.status(202).end();
        return;
      }
      const results = replies.map((reply, i) => ({
        child: runs[i].scenarioName,
        result: resultOf(reply, message!.id)
      }));
      const merged =
        where.kind === 'lifecycle'
          ? mergeLifecycle(results)
          : mergeList(where.method, results)?.result;
      if (!merged) {
        // Nobody answered: pass the first child's answer on unchanged.
        const first = replies[0];
        res.status(first.status);
        if (first.contentType) res.type(first.contentType);
        res.send(first.body);
        return;
      }
      res.json({ jsonrpc: '2.0', id: message!.id, result: merged });
    };

    onBodySettled(req, (body) => {
      route(body).catch((e: unknown) => {
        if (!res.headersSent) {
          res.status(500).json({
            error: e instanceof Error ? e.message : String(e)
          });
        }
      });
    });
  };
}
