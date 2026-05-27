export type CheckStatus =
  | 'SUCCESS'
  | 'FAILURE'
  | 'WARNING'
  | 'SKIPPED'
  | 'INFO';

export interface SpecReference {
  id: string;
  url?: string;
}

export interface ConformanceCheck {
  id: string;
  name: string;
  description: string;
  status: CheckStatus;
  timestamp: string;
  specReferences?: SpecReference[];
  details?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  errorMessage?: string;
  logs?: string[];
}

export const DATED_SPEC_VERSIONS = [
  '2025-03-26',
  '2025-06-18',
  '2025-11-25'
] as const;

export type DatedSpecVersion = (typeof DATED_SPEC_VERSIONS)[number];

export const LATEST_SPEC_VERSION: DatedSpecVersion = '2025-11-25';

/**
 * Wire `protocolVersion` for the in-progress spec. Mirrors
 * `LATEST_PROTOCOL_VERSION` in the spec repo's `schema/draft/schema.ts`;
 * bump when that constant changes.
 */
export const DRAFT_PROTOCOL_VERSION = 'DRAFT-2026-v1';

// Wire protocolVersion strings the mock server will negotiate on initialize.
export const NEGOTIABLE_PROTOCOL_VERSIONS: readonly string[] = [
  '2025-06-18',
  LATEST_SPEC_VERSION,
  DRAFT_PROTOCOL_VERSION
];

/**
 * A spec revision the conformance suite can target via `--spec-version`.
 * Always a wire `protocolVersion` string. The CLI also accepts `'draft'` as
 * an alias for {@link DRAFT_PROTOCOL_VERSION}.
 */
export type SpecVersion = DatedSpecVersion | typeof DRAFT_PROTOCOL_VERSION;

// Scenarios may also be tagged 'extension' to mark them as off-timeline
// (selectable via --suite extensions, never via --spec-version). See #256.
export type ScenarioSpecTag = SpecVersion | 'extension';

/**
 * Known protocol extensions that this suite has scenarios for.
 * Values are SEP-2133 extension identifiers (the keys used in
 * `capabilities.extensions`).
 */
export const EXTENSION_IDS = [
  'io.modelcontextprotocol/oauth-client-credentials',
  'io.modelcontextprotocol/enterprise-managed-authorization'
] as const;
export type ExtensionId = (typeof EXTENSION_IDS)[number];

/**
 * Where a scenario's requirement comes from. Either the dated spec timeline
 * (`introducedIn`/`removedIn`) or a named protocol extension that lives
 * outside the spec release cycle. Extensions never match `--spec-version`.
 */
export type ScenarioSource =
  | {
      introducedIn: DatedSpecVersion | typeof DRAFT_PROTOCOL_VERSION;
      removedIn?: DatedSpecVersion | typeof DRAFT_PROTOCOL_VERSION;
    }
  | { extensionId: ExtensionId };

export interface ScenarioUrls {
  serverUrl: string;
  authUrl?: string;
  /**
   * Optional context to pass to the client via MCP_CONFORMANCE_CONTEXT env var.
   * This is a JSON-serializable object containing scenario-specific data like credentials.
   */
  context?: Record<string, unknown>;
}

/** A Node-style request handler — what `http.createServer` accepts. */
export type RequestListener = (
  req: import('http').IncomingMessage,
  res: import('http').ServerResponse
) => void;

export interface Scenario {
  name: string;
  description: string;
  source: ScenarioSource;
  /**
   * If true, a non-zero client exit code is expected and will not cause the test to fail.
   * Use this for scenarios where the client is expected to error (e.g., rejecting invalid auth).
   */
  allowClientError?: boolean;
  /**
   * Sub-path of the MCP endpoint relative to the handler root. The CLI runner
   * appends this to the listen URL; the hosted runner appends it to the
   * mounted prefix. Default: '' (handler root is the MCP endpoint).
   */
  mcpPath?: string;
  /**
   * Return the request handler without binding a port. The hosted runner
   * mounts this directly under a path prefix so scenarios can run on
   * serverless hosts that don't allow loopback listeners.
   *
   * `getBaseUrl` returns the public URL this handler is reachable at (no
   * trailing slash) — use it for scenarios that embed self-referential
   * absolute URLs in responses. Called lazily so `start()` can resolve it
   * after the OS assigns a port.
   *
   * Implementations should reset per-run state here, not in `start()`.
   * If omitted, the scenario only runs via `start()`/`stop()` (e.g. auth
   * scenarios that need a second origin).
   */
  handler?(getBaseUrl: () => string): RequestListener;
  start(): Promise<ScenarioUrls>;
  stop(): Promise<void>;
  getChecks(): ConformanceCheck[];
}

/**
 * Convenience: implement `handler()` + `mcpPath` and get `start()`/`stop()`
 * for free. Covers every scenario that just needs one HTTP origin.
 */
export abstract class HandlerScenario implements Scenario {
  abstract name: string;
  abstract description: string;
  abstract readonly source: ScenarioSource;
  allowClientError?: boolean;
  mcpPath = '';

  private _server: import('http').Server | null = null;
  private _baseUrl = '';

  abstract handler(getBaseUrl: () => string): RequestListener;
  abstract getChecks(): ConformanceCheck[];

  async start(): Promise<ScenarioUrls> {
    const http = await import('http');
    const listener = this.handler(() => this._baseUrl);
    return new Promise((resolve, reject) => {
      this._server = http.createServer(listener);
      this._server.on('error', reject);
      this._server.listen(0, () => {
        const addr = this._server!.address();
        if (!addr || typeof addr !== 'object') {
          return reject(new Error('Failed to get server address'));
        }
        this._baseUrl = `http://localhost:${addr.port}`;
        resolve({ serverUrl: `${this._baseUrl}${this.mcpPath}` });
      });
    });
  }

  async stop(): Promise<void> {
    if (!this._server) return;
    await new Promise<void>((resolve) => {
      // closeAllConnections so hung SSE streams don't keep the process alive
      this._server!.closeAllConnections?.();
      this._server!.close(() => resolve());
    });
    this._server = null;
  }
}

export interface ClientScenario {
  name: string;
  description: string;
  source: ScenarioSource;
  run(serverUrl: string): Promise<ConformanceCheck[]>;
}

export interface ClientScenarioForAuthorizationServer {
  name: string;
  description: string;
  source: ScenarioSource;
  run(serverUrl: string): Promise<ConformanceCheck[]>;
}
