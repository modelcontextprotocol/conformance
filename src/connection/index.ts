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
 * Handler for a server-to-client request that arrives on the response stream
 * during a `request()` call (e.g. `sampling/createMessage`,
 * `elicitation/create`). Only meaningful under the stateful lifecycle; the
 * stateless lifecycle uses MRTR instead and ignores handlers.
 */
export type ServerRequestHandler = (
  params: unknown
) => unknown | Promise<unknown>;

export interface RequestOptions {
  /** Map of method name to handler for server-to-client requests. */
  handlers?: Record<string, ServerRequestHandler>;
  /**
   * Extra `_meta` fields to merge into the request (e.g.
   * `'io.modelcontextprotocol/logLevel': 'debug'` for the 2026 logging path).
   */
  meta?: Record<string, unknown>;
}

export interface Connection {
  /**
   * Send a JSON-RPC request and return its result.
   * Throws on JSON-RPC error responses; the thrown error has `.code` and `.data`.
   */
  request<R = unknown>(
    method: string,
    params?: Record<string, unknown>,
    opts?: RequestOptions
  ): Promise<R>;

  /**
   * All notifications received over this connection's lifetime, in arrival
   * order. For the stateful impl this includes notifications from the
   * standalone GET stream; for stateless it's only those on POST-response
   * streams.
   */
  readonly notifications: JSONRPCNotification[];

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
  connect(): Promise<Connection>;
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
export { connectStateless } from './stateless';
export { connectFor } from './select';
