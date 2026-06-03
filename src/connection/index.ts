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

export interface Connection {
  /**
   * Send a JSON-RPC request and return its result.
   * Throws `JsonRpcError` on JSON-RPC error responses.
   */
  request<R = unknown>(
    method: string,
    params?: Record<string, unknown>
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
export { connectFor } from './select';
