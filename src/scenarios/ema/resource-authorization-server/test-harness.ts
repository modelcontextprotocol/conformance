/**
 * Test harness for the Resource-AS EMA scenarios. It stands up the runner-side
 * pieces a human tester would provision for a real target — a Trusted IdP AS and
 * a Resource AS with a registered client, user, trusted MCP Server and scope —
 * then packages them as the {@link ResourceAuthorizationServerOptions} config
 * plus the `details` bag (carrying the live IdP) that a scenario consumes.
 */
import {
  MockResourceAuthorizationServer,
  type MockResourceAuthorizationServerOptions
} from '../auth/helpers/mockResourceAuthorizationServer';
import { IdPAuthorizationServer } from '../auth/helpers/provideIdPAuthorizationServer';
import type { ResourceAuthorizationServerOptions } from '../../../schemas';
import { TRUSTED_IDP_DETAIL, UNTRUSTED_IDP_DETAIL } from './support';

export const TEST_CLIENT_ID = 'mcp-client';
export const TEST_USERNAME = 'Alice';
export const TEST_IDP_SUB = 'idp-alice-001';
export const TEST_TRUSTED_MCP_SERVER = 'https://mcp.example/';
export const TEST_UNTRUSTED_MCP_SERVER = 'https://other-mcp.example/';
export const TEST_SCOPE = 'mcp.read';

export interface HarnessProvisioning {
  /** Whether the mock Resource AS requires the ID-JAG `resource` claim. Defaults to true. */
  requireResourceClaim?: boolean;
  /** Register {@link TEST_TRUSTED_MCP_SERVER} as a trusted MCP Server. */
  registerTrustedMcpServer?: boolean;
  /** Register {@link TEST_SCOPE} so the Resource AS enforces its scope set. */
  registerScope?: boolean;
  /** Provision a second IdP AS that the Resource AS never registers as trusted. */
  provisionUntrustedIdp?: boolean;
  /** Extra options passed to the mock Resource AS (e.g. metadataTransform). */
  mockOptions?: MockResourceAuthorizationServerOptions;
}

export interface Harness {
  idp: IdPAuthorizationServer;
  /** Present only when `provisioning.provisionUntrustedIdp` is set. */
  untrustedIdp?: IdPAuthorizationServer;
  resourceAs: MockResourceAuthorizationServer;
  options: ResourceAuthorizationServerOptions;
  details: Record<string, unknown>;
  stop(): Promise<void>;
}

/**
 * Provision the IdP + Resource AS and return the config, details and a teardown.
 * The caller owns the lifecycle: always `await harness.stop()` in a finally.
 */
export async function createHarness(
  provisioning: HarnessProvisioning = {}
): Promise<Harness> {
  const idp = await IdPAuthorizationServer.create();
  await idp.start();

  const untrustedIdp = provisioning.provisionUntrustedIdp
    ? await IdPAuthorizationServer.create()
    : undefined;
  if (untrustedIdp) {
    await untrustedIdp.start();
  }

  const resourceAs = await MockResourceAuthorizationServer.create({
    requireResourceClaim: provisioning.requireResourceClaim ?? true,
    ...provisioning.mockOptions
  });
  await resourceAs.start();

  resourceAs.registerTrustedIdp(idp.issuer);
  const sub = resourceAs.registerUser(TEST_USERNAME);
  resourceAs.linkIdpSubject(TEST_IDP_SUB, sub);
  const clientSecret = resourceAs.registerClient(TEST_CLIENT_ID);
  if (provisioning.registerTrustedMcpServer) {
    resourceAs.registerTrustedMcpServer(TEST_TRUSTED_MCP_SERVER);
  }
  if (provisioning.registerScope) {
    resourceAs.registerScope(TEST_SCOPE);
  }

  const options: ResourceAuthorizationServerOptions = {
    url: resourceAs.issuer,
    clientId: TEST_CLIENT_ID,
    clientSecret,
    sub,
    idpSub: TEST_IDP_SUB,
    trustedIdpIssuer: idp.issuer,
    untrustedIdpIssuer: untrustedIdp?.issuer,
    trustedMcpServer: TEST_TRUSTED_MCP_SERVER,
    untrustedMcpServer: TEST_UNTRUSTED_MCP_SERVER,
    scope: TEST_SCOPE
  };

  const details: Record<string, unknown> = { [TRUSTED_IDP_DETAIL]: idp };
  if (untrustedIdp) {
    details[UNTRUSTED_IDP_DETAIL] = untrustedIdp;
  }

  return {
    idp,
    untrustedIdp,
    resourceAs,
    options,
    details,
    async stop() {
      await resourceAs.stop();
      await idp.stop();
      await untrustedIdp?.stop();
    }
  };
}
