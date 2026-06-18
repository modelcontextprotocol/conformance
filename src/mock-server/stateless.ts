/**
 * Stateless mock server: 2026-x lifecycle (SEP-2575).
 *
 * No initialize handshake. Validates `_meta` (protocolVersion / clientInfo /
 * clientCapabilities) and the `MCP-Protocol-Version` header on every request,
 * serves `server/discover`, and routes other methods to the supplied handlers.
 * Implemented with raw express so it can front-run SDK support.
 */

import express from 'express';
import type { SpecVersion } from '../types';
import type { JSONRPCRequest } from '../spec-types/2025-11-25';
import type { MockServer, RequestHandlers } from './index';
import { STATELESS_SPEC_VERSIONS } from '../connection/select';
import { capabilitiesFromHandlers } from './stateful';

const META_KEYS = [
  'io.modelcontextprotocol/protocolVersion',
  'io.modelcontextprotocol/clientInfo',
  'io.modelcontextprotocol/clientCapabilities'
] as const;

/**
 * Operations whose results the 2026-07-28 revision marks cacheable: servers
 * MUST include the caching hints `ttlMs` and `cacheScope` on these results
 * (draft `CacheableResult`, server/utilities/caching).
 */
export const CACHEABLE_RESULT_METHODS: ReadonlySet<string> = new Set([
  'server/discover',
  'tools/list',
  'prompts/list',
  'resources/list',
  'resources/templates/list',
  'resources/read'
]);

/**
 * Fill in the result members the 2026-07-28 revision requires of servers when
 * the handler did not set them itself: every result MUST carry `resultType`,
 * and results of the cacheable operations MUST also carry `ttlMs` and
 * `cacheScope`. Members the handler set are preserved (e.g. a handler may
 * return `resultType: 'input_required'`); only absent (or undefined) ones are
 * filled. A scenario that needs to send a deliberately non-conformant result
 * must build its own server instead of routing through this mock.
 */
export function withRequiredDraftResultFields(
  method: string,
  result: unknown
): unknown {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return result;
  }
  const stamped: Record<string, unknown> = { ...result };
  stamped.resultType ??= 'complete';
  if (CACHEABLE_RESULT_METHODS.has(method)) {
    stamped.ttlMs ??= 0;
    stamped.cacheScope ??= 'private';
  }
  return stamped;
}

type IncomingHeaders = Record<string, string | string[] | undefined>;

export type StatelessValidation =
  | { kind: 'reject'; status: number; body: object }
  | { kind: 'handled'; status: number; body: object }
  | {
      kind: 'route';
      id: string | number | null;
      method: string;
      params: Record<string, unknown>;
    };

/**
 * Shared SEP-2575 request validation: header presence, `_meta` 3-key check,
 * header/`_meta` version match, version-supported check, and `server/discover`
 * handling. Returns `reject` when validation failed, `handled` when the
 * request was valid and already answered (`server/discover`), and `route`
 * when the caller should dispatch to its own handlers. Consumers write
 * `res.status(v.status).json(v.body)` for `reject` and `handled` alike and
 * route only on `route`.
 *
 * Exported so any mock server that needs a stateless `/mcp` route (e.g.
 * `auth/helpers/createServer.ts`) uses the same validation as this module.
 *
 * `supportedVersions` is the list of wire protocolVersion strings this
 * endpoint accepts; anything else is rejected with -32004 carrying
 * `{ supported, requested }` in the error data, and the list is echoed in
 * the `server/discover` result.
 */
export function validateStatelessRequest(
  req: { headers: IncomingHeaders; body: unknown },
  capabilities: Record<string, unknown>,
  supportedVersions: readonly string[]
): StatelessValidation {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const id = (body.id ?? null) as string | number | null;
  const method = body.method as string;
  const params = (body.params ?? {}) as Record<string, unknown>;
  const meta = params._meta as Record<string, unknown> | undefined;

  const reject = (status: number, code: number, message: string) =>
    ({
      kind: 'reject',
      status,
      body: { jsonrpc: '2.0', id, error: { code, message } }
    }) as const;

  const headerVersion = req.headers['mcp-protocol-version'];
  if (!headerVersion) {
    return reject(400, -32001, 'Missing MCP-Protocol-Version header');
  }
  const missing = META_KEYS.filter((k) => meta?.[k] === undefined);
  if (missing.length > 0) {
    return reject(
      400,
      -32602,
      `Invalid params: missing _meta keys: ${missing.join(', ')}`
    );
  }
  if (meta?.[META_KEYS[0]] !== headerVersion) {
    return reject(
      400,
      -32001,
      'MCP-Protocol-Version header does not match _meta.protocolVersion'
    );
  }
  if (
    typeof headerVersion !== 'string' ||
    !supportedVersions.includes(headerVersion)
  ) {
    return {
      kind: 'reject',
      status: 400,
      body: {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32004,
          message: 'Unsupported protocol version',
          data: {
            supported: supportedVersions,
            requested: String(headerVersion)
          }
        }
      }
    };
  }
  if (method === 'server/discover') {
    return {
      kind: 'handled',
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: withRequiredDraftResultFields(method, {
          supportedVersions,
          capabilities,
          serverInfo: { name: 'conformance-mock-server', version: '1.0.0' }
        })
      }
    };
  }
  return { kind: 'route', id, method, params };
}

/**
 * When `specVersion` is given (the runner's resolved `--spec-version`), the
 * server accepts exactly that version. Without it, every known stateless
 * version is accepted.
 */
export async function createServerStateless(
  handlers: RequestHandlers,
  specVersion?: SpecVersion
): Promise<MockServer> {
  const recorded: JSONRPCRequest[] = [];
  const capabilities = capabilitiesFromHandlers(handlers);
  const supportedVersions: readonly string[] = specVersion
    ? [specVersion]
    : STATELESS_SPEC_VERSIONS;

  const app = express();
  app.use(express.json());

  app.post('/mcp', async (req, res) => {
    // Record every JSON-RPC request the client sends (excluding the
    // `server/discover` lifecycle preamble) before validation so rejected
    // requests are captured too, matching the stateful impl and the
    // MockServer.recorded contract.
    const body = req.body as Record<string, unknown> | undefined;
    if (body?.method && body.method !== 'server/discover') {
      recorded.push(req.body as JSONRPCRequest);
    }
    const v = validateStatelessRequest(req, capabilities, supportedVersions);
    if (v.kind !== 'route') {
      return res.status(v.status).json(v.body);
    }
    const { id, method, params } = v;
    const error = (status: number, code: number, message: string) =>
      res.status(status).json({ jsonrpc: '2.0', id, error: { code, message } });

    const handler = handlers[method];
    if (!handler) {
      return error(404, -32601, `Method not found: ${method}`);
    }
    try {
      const result = await handler(params, req.body as JSONRPCRequest);
      return res.json({
        jsonrpc: '2.0',
        id,
        result: withRequiredDraftResultFields(method, result)
      });
    } catch (e) {
      return error(500, -32603, e instanceof Error ? e.message : String(e));
    }
  });

  return new Promise((resolve, reject) => {
    const httpServer = app.listen(0);
    httpServer.on('error', reject);
    httpServer.on('listening', () => {
      const addr = httpServer.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const baseUrl = `http://localhost:${port}`;
      resolve({
        url: `${baseUrl}/mcp`,
        baseUrl,
        recorded,
        close: () =>
          new Promise<void>((r) => {
            httpServer.closeAllConnections?.();
            httpServer.close(() => r());
          })
      });
    });
  });
}
