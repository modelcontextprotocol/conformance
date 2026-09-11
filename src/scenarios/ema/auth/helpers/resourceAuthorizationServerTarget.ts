/**
 * The Resource Authorization Server (Resource AS) surface the EMA
 * conformance scenarios drive (ISSUE-470).
 *
 * Scenarios target a *general* Resource AS through this interface instead of
 * the concrete {@link MockResourceAuthorizationServer}, so the same scenario
 * can run against any Resource AS that satisfies the contract. Tests inject the
 * mock; a future runner could inject an adapter over a real Resource AS.
 *
 * The caller owns the target's lifecycle (create/start/stop): the target must
 * be started and its endpoints reachable before it is handed to a scenario.
 */
export interface ResourceAuthorizationServerUnderTest {
  /** This Resource AS's issuer identifier (the ID-JAG `aud` must match it). */
  readonly issuer: string;
  /** Token endpoint that accepts the `jwt-bearer` ID-JAG grant. */
  readonly tokenEndpoint: string;
  /** RFC 7662 introspection endpoint. */
  readonly introspectionEndpoint: string;

  /** Provision a trusted IdP AS by issuer URL (ID-JAGs it signs are accepted). */
  registerTrustedIdp(issuer: string): void;
  /** Provision a user and return its id, registered with this Resource AS. */
  registerUser(username: string): string;
  /** Provision a client and return the `client_secret_basic` secret to present. */
  registerClient(clientId: string): string;
  /** Provision a trusted MCP Server the ID-JAG `resource` claim may name. */
  registerTrustedMcpServer(url: string): void;
  /** Provision a scope the Resource AS recognises. */
  registerScope(scope: string): void;
}
