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

export interface ScenarioUrls {
  serverUrl: string;
  authUrl?: string;
  /**
   * Optional context to pass to the client via MCP_CONFORMANCE_CONTEXT env var.
   * This is a JSON-serializable object containing scenario-specific data like credentials.
   *
   * **WARNING: The context schema is unstable and subject to change.**
   * Currently only used for client credentials scenarios (auth/client-credentials-jwt,
   * auth/client-credentials-basic). The runner automatically adds a `scenario` field
   * with the scenario name.
   *
   * If you have use cases that require additional context fields, please provide
   * feedback at: https://github.com/modelcontextprotocol/conformance/issues/51
   */
  context?: Record<string, unknown>;
}

export interface Scenario {
  name: string;
  description: string;
  start(): Promise<ScenarioUrls>;
  stop(): Promise<void>;
  getChecks(): ConformanceCheck[];
}

export interface ClientScenario {
  name: string;
  description: string;
  run(serverUrl: string): Promise<ConformanceCheck[]>;
}
