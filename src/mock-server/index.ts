/**
 * Version-aware mock-server abstraction for client-conformance scenarios.
 *
 * A `MockServer` is the HTTP server a client-under-test connects to. The
 * lifecycle scaffold (initialize handshake vs per-request `_meta` validation)
 * is supplied by the runner based on `--spec-version`; the scenario only
 * provides per-method handlers and asserts on the recorded requests.
 *
 * This is the client-conformance mirror of `Connection` in `../connection`.
 */

import type { RequestListener, SpecVersion } from '../types';
import type { JSONRPCRequest } from '../spec-types/2025-11-25';

/**
 * Per-method response handlers. Called with the request `params` object;
 * return value becomes the JSON-RPC `result`. Throw to produce an error
 * response.
 */
export type RequestHandlers = Record<
  string,
  (
    params: Record<string, unknown>,
    request: JSONRPCRequest
  ) => unknown | Promise<unknown>
>;

export interface MockServer {
  /** Full URL of the `/mcp` endpoint. */
  url: string;
  /** Base URL (no `/mcp` suffix), for scenarios that serve sibling routes. */
  baseUrl: string;
  /**
   * Every JSON-RPC request the client sent, in arrival order, excluding the
   * lifecycle preamble (`initialize` / `notifications/initialized` under the
   * stateful impl; `server/discover` under stateless). Recording happens
   * before validation, so requests the server rejects (e.g. missing header
   * or `_meta`) still appear here.
   */
  readonly recorded: JSONRPCRequest[];
  close(): Promise<void>;
}

/**
 * The same mock as `MockServer` but not bound to a port: a request listener
 * the caller mounts itself — `http.createServer(listener)` in the CLI
 * runner, a path-prefix mount in the hosted runner. `Scenario.handler()`
 * implementations use this so one scenario body serves both.
 */
export interface MockHandler {
  /** Serves `/mcp` — hand it to `http.createServer` or mount it. */
  listener: RequestListener;
  /** See `MockServer.recorded`. */
  readonly recorded: JSONRPCRequest[];
}

/**
 * Per-run context handed to `Scenario.start()`. The runner constructs this
 * from the resolved `--spec-version`.
 */
export interface ScenarioContext {
  specVersion: SpecVersion;
  /**
   * Create a version-appropriate mock server. Scenarios that test the
   * lifecycle itself (initialize, SSE-retry) bypass this and build a raw
   * `http.createServer`.
   */
  createServer(handlers: RequestHandlers): Promise<MockServer>;
  /**
   * Same mock, unbound. What `Scenario.handler()` implementations call so
   * the scenario can be mounted without a loopback port (see src/hosted).
   */
  createHandler(handlers: RequestHandlers): MockHandler;
}

export { createServerStateful, createHandlerStateful } from './stateful';
export {
  createServerStateless,
  createHandlerStateless,
  validateStatelessRequest,
  withRequiredDraftResultFields,
  CACHEABLE_RESULT_METHODS
} from './stateless';
export { createServerFor, createHandlerFor } from './select';
