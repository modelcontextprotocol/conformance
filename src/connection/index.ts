/**
 * Version-aware connection abstraction for server-conformance scenarios.
 *
 * A `Connection` knows how to send JSON-RPC requests to the server-under-test
 * using the lifecycle appropriate for the spec version being tested:
 *
 * - 2025-x: stateful (initialize handshake, Mcp-Session-Id header)
 * - 2026-x: stateless (no handshake, per-request _meta + MCP-Protocol-Version)
 *
 * Scenarios call `ctx.connect()` and then `conn.request(method, params)`; the
 * runner picks the implementation based on `--spec-version`. Scenario code is
 * the same regardless of which lifecycle is in use.
 */

import type { SpecVersion } from '../types';
import type { JSONRPCNotification } from '../spec-types/2025-11-25';

/**
 * Options accepted at session bootstrap. On the stateful (2025-x) wire
 * these flow into the `initialize` request params; on the stateless
 * (2026-x) wire they live in `_meta.io.modelcontextprotocol/*` on the
 * `server/discover` request.
 */
export interface ConnectOptions {
  /**
   * Capabilities declared during session bootstrap (e.g.
   * `{ extensions: { 'io.modelcontextprotocol/tasks': {} }, elicitation: {} }`).
   */
  capabilities?: Record<string, unknown>;
  /** Client info advertised at bootstrap; defaults to the harness's own info. */
  clientInfo?: { name: string; version: string };
}

export interface Connection {
  /**
   * Send a JSON-RPC request and return its result.
   * Throws `JsonRpcError` on JSON-RPC error responses.
   *
   * `extraHeaders` extend or override the standard headers
   * (Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name)
   * for this call only, used by SEP-2243 routing-header tests that
   * inject a mismatch. Honored on the stateless wire; throws on the
   * stateful wire (the SDK transport manages headers internally, so
   * a per-call override would require dropping to raw fetch — silently
   * dropping the header in a conformance harness would mask test
   * correctness).
   */
  request<R = unknown>(
    method: string,
    params?: Record<string, unknown>,
    extraHeaders?: Record<string, string>
  ): Promise<R>;

  /**
   * All notifications received over this connection's lifetime, in arrival
   * order. For the stateful impl this includes notifications from the
   * standalone GET stream; for stateless it's only those on POST-response
   * streams.
   */
  readonly notifications: JSONRPCNotification[];

  /**
   * Return the server's advertised capabilities, serverInfo, and
   * instructions. On the stateful wire this is synthesized from the
   * SDK Client's post-`initialize` accessors and resolves immediately;
   * on the stateless wire this issues `server/discover` (SEP-2575's
   * equivalent of the missing handshake) on first call and memoizes
   * the result.
   *
   * Scenarios that don't inspect server-side state never call this —
   * SEP-2575 has no required handshake, so paying for the extra request
   * is opt-in.
   */
  discover(): Promise<Record<string, unknown>>;

  close(): Promise<void>;
}

/**
 * Per-run context handed to `ClientScenario.run()`. The runner constructs this
 * from the resolved `--spec-version` and server URL.
 */
export interface RunContext {
  serverUrl: string;
  specVersion: SpecVersion;
  /**
   * Open a version-appropriate connection to the server-under-test.
   * Scenarios that test the connection mechanics themselves (initialize,
   * GET-SSE, DNS rebinding) bypass this and use raw fetch.
   */
  connect(opts?: ConnectOptions): Promise<Connection>;
}

export class JsonRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown
  ) {
    super(message);
    this.name = 'JsonRpcError';
  }
}

export { connectStateful } from './stateful';
export {
  connectStateless,
  sendStatelessRequest,
  buildStandardHeaders,
  withRequestMeta,
  mcpNameForRequest,
  readSseJsonRpcResponse,
  CONFORMANCE_CLIENT_INFO,
  DEFAULT_CLIENT_CAPABILITIES,
  type JsonRpcResponse,
  type StatelessResponse
} from './stateless';
export { connectFor, isStateless } from './select';
