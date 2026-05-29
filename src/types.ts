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

/**
 * Named extra origins a multi-origin scenario needs beyond the resource
 * server. `as` is the OAuth authorization server; `as2`/`idp` cover the
 * three-origin scenarios (authorization-server-migration, EMA).
 */
export type AuxOriginRole = 'as' | 'as2' | 'idp';

export interface AuthHandlerContext {
  /** Public URL of the resource-server mount (no trailing slash). */
  getRsBaseUrl: () => string;
  /**
   * Public URL of an aux origin for this run (no trailing slash). When
   * hosted, this is `<relay-origin>/r/<run-id>` so the run-id is recoverable
   * from any path the client constructs from it (RFC 8414 well-known
   * insertion, endpoint paths, etc.).
   */
  getAuxBaseUrl: (role: AuxOriginRole) => string;
}

export interface AuthHandlers {
  /** Resource-server handler — serves /mcp and PRM. */
  rs: RequestListener;
  /** Aux-origin handlers keyed by role. */
  aux: Partial<Record<AuxOriginRole, RequestListener>>;
}

/**
 * Convenience: implement `authHandlers()` and get `start()`/`stop()` for
 * free. `start()` binds one ephemeral localhost port per origin, exactly as
 * the auth scenarios did with `ServerLifecycle` before; the hosted runner
 * mounts the same handlers behind path prefixes + an AS relay instead.
 */
export abstract class AuthHandlerScenario implements Scenario {
  abstract name: string;
  abstract description: string;
  abstract readonly source: ScenarioSource;
  allowClientError?: boolean;
  mcpPath = '/mcp';

  /** Aux origins this scenario needs. Override for 3-origin scenarios. */
  readonly auxRoles: readonly AuxOriginRole[] = ['as'];

  private _servers: import('http').Server[] = [];
  private _urls: { rs: string; aux: Partial<Record<AuxOriginRole, string>> } = {
    rs: '',
    aux: {}
  };

  abstract authHandlers(ctx: AuthHandlerContext): AuthHandlers;
  abstract getChecks(): ConformanceCheck[];

  /** Optional context to pass to the client (credentials etc). */
  protected scenarioContext?(): Record<string, unknown>;

  async start(): Promise<ScenarioUrls> {
    const http = await import('http');
    const handlers = this.authHandlers({
      getRsBaseUrl: () => this._urls.rs,
      getAuxBaseUrl: (role) => {
        const u = this._urls.aux[role];
        if (!u) throw new Error(`aux role '${role}' not started`);
        return u;
      }
    });

    const listen = (h: RequestListener): Promise<string> =>
      new Promise((resolve, reject) => {
        const srv = http.createServer(h);
        srv.on('error', reject);
        srv.listen(0, () => {
          const addr = srv.address();
          if (!addr || typeof addr !== 'object') {
            return reject(new Error('Failed to get server address'));
          }
          this._servers.push(srv);
          resolve(`http://localhost:${addr.port}`);
        });
      });

    // Aux origins must come up first — RS handlers reference their URLs.
    for (const role of this.auxRoles) {
      const h = handlers.aux[role];
      if (!h) throw new Error(`authHandlers() missing aux role '${role}'`);
      this._urls.aux[role] = await listen(h);
    }
    this._urls.rs = await listen(handlers.rs);

    return {
      serverUrl: `${this._urls.rs}${this.mcpPath}`,
      ...(this.scenarioContext && { context: this.scenarioContext() })
    };
  }

  async stop(): Promise<void> {
    await Promise.all(
      this._servers.map(
        (s) =>
          new Promise<void>((resolve) => {
            s.closeAllConnections?.();
            s.close(() => resolve());
          })
      )
    );
    this._servers = [];
    this._urls = { rs: '', aux: {} };
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
