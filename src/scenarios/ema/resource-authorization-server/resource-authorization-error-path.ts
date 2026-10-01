/**
 * Error-path scenarios for the Resource-AS side of Enterprise-Managed
 * Authorization (ISSUE-470).
 *
 * Scenario 5 ({@link ResourceServerErrorPathScenario}): an ID-JAG whose
 * `resource` claim names an untrusted MCP Server is rejected with an RFC 8707
 * §2.1 `invalid_target` error (HTTP 400).
 *
 * Scenario 6 ({@link ResourceServerInvalidScopeScenario}): an ID-JAG with a
 * trusted `resource` but an unrecognised `scope` is rejected with an RFC 6749
 * §5.2 `invalid_scope` error (HTTP 400).
 *
 * Scenario 7 ({@link ResourceServerInvalidSignatureScenario}): the trusted IdP
 * itself creates and signs an otherwise well-formed ID-JAG, but with a key it
 * never publishes at its own `jwks_uri`. Signature verification must fail, so
 * the Resource AS rejects it with an RFC 7521 §4.1.1 `invalid_grant` error
 * (HTTP 400).
 *
 * Scenario 8 ({@link ResourceServerUntrustedIdpScenario}): an otherwise
 * well-formed and correctly signed ID-JAG whose `iss` names an IdP the
 * Resource AS does not trust is rejected with an RFC 7521 §4.1.1
 * `invalid_grant` error (HTTP 400).
 *
 * These scenarios target a Resource AS named by {@link
 * ResourceAuthorizationServerOptions}: they discover the token endpoint from the
 * issuer's server metadata. The runner plays the MCP Client and hosts the
 * Trusted IdP AS, handed over through `details` (see {@link getIdp}).
 */
import { randomUUID } from 'node:crypto';
import type {
  ConformanceCheck,
  ScenarioForResourceAuthorizationServer,
  ScenarioSource
} from '../../../types';
import type { ResourceAuthorizationServerOptions } from '../../../schemas';
import type { IdPAuthorizationServer } from '../auth/helpers/provideIdPAuthorizationServer';
import { requestAccessTokenWithIdJag } from '../auth/helpers/mockResourceAuthorizationServer';
import {
  TRUSTED_IDP_DETAIL,
  UNTRUSTED_IDP_DETAIL,
  getIdp,
  discoverResourceAs,
  type ResourceAsEndpoints
} from './support';
import { SpecReferences as SPEC_REFERENCES } from '../auth/spec-references';

const EMA_SOURCE: ScenarioSource = {
  extensionId: 'io.modelcontextprotocol/enterprise-managed-authorization'
};

/** Client credentials + IdP-registered subject the error-path flows carry in the ID-JAG. */
interface ClientContext {
  clientId: string;
  clientSecret: string;
  idpSub: string;
}

function skippedCheck(
  id: string,
  name: string,
  reason: string
): ConformanceCheck {
  return {
    id,
    name,
    description: reason,
    status: 'SKIPPED',
    timestamp: new Date().toISOString(),
    errorMessage: reason,
    specReferences: [SPEC_REFERENCES.EMA]
  };
}

function failureCheck(
  id: string,
  name: string,
  error: unknown
): ConformanceCheck {
  return {
    id,
    name,
    description: 'Resource AS ID-JAG error-path flow failed to run',
    status: 'FAILURE',
    timestamp: new Date().toISOString(),
    errorMessage: error instanceof Error ? error.message : String(error),
    specReferences: [SPEC_REFERENCES.EMA]
  };
}

/** Resolve the client credentials + IdP-registered subject every error-path flow needs. */
function resolveClientContext(
  options: ResourceAuthorizationServerOptions
): ClientContext | { missing: string } {
  if (!options.clientId) return { missing: 'clientId' };
  if (!options.clientSecret) return { missing: 'clientSecret' };
  if (!options.idpSub) return { missing: 'idpSub' };
  return {
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    idpSub: options.idpSub
  };
}

/**
 * Resolve the client credentials the invalid-signature flow needs. No
 * registered user is required: signature verification fails before the
 * Resource AS ever inspects the `sub` claim, so a placeholder subject is fine.
 */
function resolveSignatureClientContext(
  options: ResourceAuthorizationServerOptions
): ClientContext | { missing: string } {
  if (!options.clientId) return { missing: 'clientId' };
  if (!options.clientSecret) return { missing: 'clientSecret' };
  return {
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    idpSub: options.idpSub ?? 'ema-invalid-signature-test-subject'
  };
}

/**
 * Scenario 5: a `resource` claim naming an untrusted MCP Server is rejected
 * with `invalid_target` (RFC 8707 §2.1).
 */
export class ResourceServerErrorPathScenario implements ScenarioForResourceAuthorizationServer {
  name = 'ema/resource-authorization-server/error-path';
  readonly source = EMA_SOURCE;
  description =
    'EMA: a Resource AS rejects an ID-JAG whose resource claim names an untrusted MCP Server with a 400 invalid_target error (RFC 8707 §2.1).';

  async run(
    options: ResourceAuthorizationServerOptions,
    details: Record<string, unknown>
  ): Promise<ConformanceCheck[]> {
    try {
      const client = resolveClientContext(options);
      if ('missing' in client) {
        return [
          skippedCheck(
            'resource-as-error-invalid-target-status',
            'ResourceAsErrorInvalidTargetStatus',
            `error-path requires the "${client.missing}" setting`
          )
        ];
      }
      if (!options.untrustedMcpServer) {
        return [
          skippedCheck(
            'resource-as-error-invalid-target-status',
            'ResourceAsErrorInvalidTargetStatus',
            'error-path requires the "untrustedMcpServer" setting'
          )
        ];
      }
      const idp = getIdp(details, TRUSTED_IDP_DETAIL);
      if (!idp) {
        return [
          skippedCheck(
            'resource-as-error-invalid-target-status',
            'ResourceAsErrorInvalidTargetStatus',
            'error-path requires a trusted IdP AS supplied via details'
          )
        ];
      }
      const endpoints = await discoverResourceAs(options.url);
      return await this.runFlow(
        idp,
        endpoints,
        client,
        options.untrustedMcpServer
      );
    } catch (error) {
      return [
        failureCheck(
          'resource-as-error-invalid-target-status',
          'ResourceAsErrorInvalidTargetStatus',
          error
        )
      ];
    }
  }

  private async runFlow(
    idp: IdPAuthorizationServer,
    endpoints: ResourceAsEndpoints,
    client: ClientContext,
    untrustedMcpServer: string
  ): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const timestamp = () => new Date().toISOString();

    // The ID-JAG names an MCP Server that is NOT trusted by the Resource AS.
    const idJag = await idp.issueIdJag({
      subject: client.idpSub,
      audience: endpoints.issuer,
      clientId: client.clientId,
      resource: untrustedMcpServer
    });

    const response = await requestAccessTokenWithIdJag(
      endpoints.tokenEndpoint,
      {
        assertion: idJag,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        clientAuthMethod: 'client_secret_post'
      }
    );

    const statusOk = response.statusCode === 400;
    checks.push({
      id: 'resource-as-error-invalid-target-status',
      name: 'ResourceAsErrorInvalidTargetStatus',
      description:
        'Resource AS responds 400 Bad Request when the ID-JAG resource names an untrusted MCP Server (RFC 8707 §2.1)',
      status: statusOk ? 'SUCCESS' : 'FAILURE',
      timestamp: timestamp(),
      errorMessage: statusOk
        ? undefined
        : `Expected HTTP 400, got ${response.statusCode} with body ${JSON.stringify(response.body)}`,
      specReferences: [SPEC_REFERENCES.RFC_8707_INVALID_TARGET],
      details: { statusCode: response.statusCode }
    });

    const errorOk = response.body.error === 'invalid_target';
    checks.push({
      id: 'resource-as-error-invalid-target-code',
      name: 'ResourceAsErrorInvalidTargetCode',
      description:
        'Resource AS error response uses error="invalid_target" (RFC 8707 §2.1)',
      status: errorOk ? 'SUCCESS' : 'FAILURE',
      timestamp: timestamp(),
      errorMessage: errorOk
        ? undefined
        : `Expected error "invalid_target", got ${JSON.stringify(response.body.error)}`,
      specReferences: [
        SPEC_REFERENCES.RFC_8707_INVALID_TARGET,
        SPEC_REFERENCES.EMA
      ],
      details: {
        error: response.body.error,
        error_description: response.body.error_description
      }
    });

    return checks;
  }
}

/**
 * Scenario 6: an ID-JAG with a valid (trusted) `resource` claim but a `scope`
 * the Resource AS does not recognise is rejected with `invalid_scope`
 * (RFC 6749 §5.2). The scenario requests a random, almost-certainly-unregistered
 * scope so it does not depend on the configured (registered) scope.
 */
export class ResourceServerInvalidScopeScenario implements ScenarioForResourceAuthorizationServer {
  name = 'ema/resource-authorization-server/error-path-invalid-scope';
  readonly source = EMA_SOURCE;
  description =
    'EMA: a Resource AS rejects an ID-JAG whose scope claim is not among the registered scopes with a 400 invalid_scope error (RFC 6749 §5.2).';

  async run(
    options: ResourceAuthorizationServerOptions,
    details: Record<string, unknown>
  ): Promise<ConformanceCheck[]> {
    try {
      const client = resolveClientContext(options);
      if ('missing' in client) {
        return [
          skippedCheck(
            'resource-as-error-invalid-scope-status',
            'ResourceAsErrorInvalidScopeStatus',
            `error-path-invalid-scope requires the "${client.missing}" setting`
          )
        ];
      }
      if (!options.trustedMcpServer) {
        return [
          skippedCheck(
            'resource-as-error-invalid-scope-status',
            'ResourceAsErrorInvalidScopeStatus',
            'error-path-invalid-scope requires the "trustedMcpServer" setting'
          )
        ];
      }
      const idp = getIdp(details, TRUSTED_IDP_DETAIL);
      if (!idp) {
        return [
          skippedCheck(
            'resource-as-error-invalid-scope-status',
            'ResourceAsErrorInvalidScopeStatus',
            'error-path-invalid-scope requires a trusted IdP AS supplied via details'
          )
        ];
      }
      const endpoints = await discoverResourceAs(options.url);
      return await this.runFlow(
        idp,
        endpoints,
        client,
        options.trustedMcpServer
      );
    } catch (error) {
      return [
        failureCheck(
          'resource-as-error-invalid-scope-status',
          'ResourceAsErrorInvalidScopeStatus',
          error
        )
      ];
    }
  }

  private async runFlow(
    idp: IdPAuthorizationServer,
    endpoints: ResourceAsEndpoints,
    client: ClientContext,
    trustedMcpServer: string
  ): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const timestamp = () => new Date().toISOString();

    // A scope the Resource AS is not expected to recognise.
    const unregisteredScope = `urn:mcp-conformance:unregistered-scope:${randomUUID()}`;

    // The ID-JAG names the trusted MCP Server but requests an unregistered scope.
    const idJag = await idp.issueIdJag({
      subject: client.idpSub,
      audience: endpoints.issuer,
      clientId: client.clientId,
      resource: trustedMcpServer,
      scope: unregisteredScope
    });

    const response = await requestAccessTokenWithIdJag(
      endpoints.tokenEndpoint,
      {
        assertion: idJag,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        clientAuthMethod: 'client_secret_post'
      }
    );

    const statusOk = response.statusCode === 400;
    checks.push({
      id: 'resource-as-error-invalid-scope-status',
      name: 'ResourceAsErrorInvalidScopeStatus',
      description:
        'Resource AS responds 400 Bad Request when the ID-JAG scope is not recognised (RFC 6749 §5.2)',
      status: statusOk ? 'SUCCESS' : 'FAILURE',
      timestamp: timestamp(),
      errorMessage: statusOk
        ? undefined
        : `Expected HTTP 400, got ${response.statusCode} with body ${JSON.stringify(response.body)}`,
      specReferences: [SPEC_REFERENCES.RFC_6749_ERROR_RESPONSE],
      details: { statusCode: response.statusCode }
    });

    const errorOk = response.body.error === 'invalid_scope';
    checks.push({
      id: 'resource-as-error-invalid-scope-code',
      name: 'ResourceAsErrorInvalidScopeCode',
      description:
        'Resource AS error response uses error="invalid_scope" (RFC 6749 §5.2)',
      status: errorOk ? 'SUCCESS' : 'FAILURE',
      timestamp: timestamp(),
      errorMessage: errorOk
        ? undefined
        : `Expected error "invalid_scope", got ${JSON.stringify(response.body.error)}`,
      specReferences: [
        SPEC_REFERENCES.RFC_6749_ERROR_RESPONSE,
        SPEC_REFERENCES.EMA
      ],
      details: {
        error: response.body.error,
        error_description: response.body.error_description
      }
    });

    return checks;
  }
}

/**
 * Scenario 7: the trusted IdP itself creates and signs a well-formed ID-JAG
 * (`iss` names the trusted IdP, `client_id` is the registered client), but
 * with a key it never publishes at its own `jwks_uri`. The Resource AS fetches
 * the IdP's real JWK Set, cannot verify the signature, and must reject it with
 * `invalid_grant` (RFC 7521 §4.1.1).
 */
export class ResourceServerInvalidSignatureScenario implements ScenarioForResourceAuthorizationServer {
  name = 'ema/resource-authorization-server/error-path-invalid-signature';
  readonly source = EMA_SOURCE;
  description =
    'EMA: a Resource AS rejects an ID-JAG whose iss names a trusted IdP but whose signature was made with a key absent from that IdP jwks_uri, with a 400 invalid_grant error (RFC 7521 §4.1.1).';

  async run(
    options: ResourceAuthorizationServerOptions,
    details: Record<string, unknown>
  ): Promise<ConformanceCheck[]> {
    try {
      const client = resolveSignatureClientContext(options);
      if ('missing' in client) {
        return [
          skippedCheck(
            'resource-as-error-invalid-signature-status',
            'ResourceAsErrorInvalidSignatureStatus',
            `error-path-invalid-signature requires the "${client.missing}" setting`
          )
        ];
      }
      const idp = getIdp(details, TRUSTED_IDP_DETAIL);
      if (!idp) {
        return [
          skippedCheck(
            'resource-as-error-invalid-signature-status',
            'ResourceAsErrorInvalidSignatureStatus',
            'error-path-invalid-signature requires a trusted IdP AS supplied via details'
          )
        ];
      }
      const endpoints = await discoverResourceAs(options.url);
      return await this.runFlow(
        idp,
        endpoints,
        client,
        options.trustedMcpServer
      );
    } catch (error) {
      return [
        failureCheck(
          'resource-as-error-invalid-signature-status',
          'ResourceAsErrorInvalidSignatureStatus',
          error
        )
      ];
    }
  }

  private async runFlow(
    idp: IdPAuthorizationServer,
    endpoints: ResourceAsEndpoints,
    client: ClientContext,
    trustedMcpServer: string | undefined
  ): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const timestamp = () => new Date().toISOString();

    // The trusted IdP itself signs a valid-looking ID-JAG with a key it never
    // adds to its own JWK Set, so the Resource AS cannot verify it against
    // jwks_uri even though iss correctly names a trusted IdP.
    const idJag = await idp.issueIdJagWithUnpublishedKey({
      subject: client.idpSub,
      audience: endpoints.issuer,
      clientId: client.clientId,
      resource: trustedMcpServer
    });

    const response = await requestAccessTokenWithIdJag(
      endpoints.tokenEndpoint,
      {
        assertion: idJag,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        clientAuthMethod: 'client_secret_post'
      }
    );

    const statusOk = response.statusCode === 400;
    checks.push({
      id: 'resource-as-error-invalid-signature-status',
      name: 'ResourceAsErrorInvalidSignatureStatus',
      description:
        'Resource AS responds 400 Bad Request when the ID-JAG signature cannot be verified against the IdP jwks_uri (RFC 7521 §4.1.1)',
      status: statusOk ? 'SUCCESS' : 'FAILURE',
      timestamp: timestamp(),
      errorMessage: statusOk
        ? undefined
        : `Expected HTTP 400, got ${response.statusCode} with body ${JSON.stringify(response.body)}`,
      specReferences: [SPEC_REFERENCES.RFC_7521_INVALID_GRANT],
      details: { statusCode: response.statusCode }
    });

    const errorOk = response.body.error === 'invalid_grant';
    checks.push({
      id: 'resource-as-error-invalid-signature-code',
      name: 'ResourceAsErrorInvalidSignatureCode',
      description:
        'Resource AS error response uses error="invalid_grant" for an unverifiable ID-JAG signature (RFC 7521 §4.1.1)',
      status: errorOk ? 'SUCCESS' : 'FAILURE',
      timestamp: timestamp(),
      errorMessage: errorOk
        ? undefined
        : `Expected error "invalid_grant", got ${JSON.stringify(response.body.error)}`,
      specReferences: [
        SPEC_REFERENCES.RFC_7521_INVALID_GRANT,
        SPEC_REFERENCES.EMA
      ],
      details: {
        error: response.body.error,
        error_description: response.body.error_description
      }
    });

    return checks;
  }
}

/**
 * Scenario 8: an otherwise well-formed ID-JAG, correctly signed with its
 * issuing IdP's own published key, but that IdP is not one the Resource AS
 * trusts. Rejected with `invalid_grant` (RFC 7521 §4.1.1) purely on `iss`
 * trust, independent of signature validity.
 */
export class ResourceServerUntrustedIdpScenario implements ScenarioForResourceAuthorizationServer {
  name = 'ema/resource-authorization-server/error-path-untrusted-idp';
  readonly source = EMA_SOURCE;
  description =
    'EMA: a Resource AS rejects an ID-JAG issued by an IdP it does not trust, with a 400 invalid_grant error (RFC 7521 §4.1.1).';

  async run(
    options: ResourceAuthorizationServerOptions,
    details: Record<string, unknown>
  ): Promise<ConformanceCheck[]> {
    try {
      const client = resolveSignatureClientContext(options);
      if ('missing' in client) {
        return [
          skippedCheck(
            'resource-as-error-untrusted-idp-status',
            'ResourceAsErrorUntrustedIdpStatus',
            `error-path-untrusted-idp requires the "${client.missing}" setting`
          )
        ];
      }
      const idp = getIdp(details, UNTRUSTED_IDP_DETAIL);
      if (!idp) {
        return [
          skippedCheck(
            'resource-as-error-untrusted-idp-status',
            'ResourceAsErrorUntrustedIdpStatus',
            'error-path-untrusted-idp requires an untrusted IdP AS supplied via details'
          )
        ];
      }
      const endpoints = await discoverResourceAs(options.url);
      return await this.runFlow(
        idp,
        endpoints,
        client,
        options.trustedMcpServer
      );
    } catch (error) {
      return [
        failureCheck(
          'resource-as-error-untrusted-idp-status',
          'ResourceAsErrorUntrustedIdpStatus',
          error
        )
      ];
    }
  }

  private async runFlow(
    idp: IdPAuthorizationServer,
    endpoints: ResourceAsEndpoints,
    client: ClientContext,
    trustedMcpServer: string | undefined
  ): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const timestamp = () => new Date().toISOString();

    // Legitimately signed by the untrusted IdP's own published key; only its
    // iss is not one the Resource AS trusts.
    const idJag = await idp.issueIdJag({
      subject: client.idpSub,
      audience: endpoints.issuer,
      clientId: client.clientId,
      resource: trustedMcpServer
    });

    const response = await requestAccessTokenWithIdJag(
      endpoints.tokenEndpoint,
      {
        assertion: idJag,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        clientAuthMethod: 'client_secret_post'
      }
    );

    const statusOk = response.statusCode === 400;
    checks.push({
      id: 'resource-as-error-untrusted-idp-status',
      name: 'ResourceAsErrorUntrustedIdpStatus',
      description:
        'Resource AS responds 400 Bad Request when the ID-JAG issuer is not a trusted IdP (RFC 7521 §4.1.1)',
      status: statusOk ? 'SUCCESS' : 'FAILURE',
      timestamp: timestamp(),
      errorMessage: statusOk
        ? undefined
        : `Expected HTTP 400, got ${response.statusCode} with body ${JSON.stringify(response.body)}`,
      specReferences: [SPEC_REFERENCES.RFC_7521_INVALID_GRANT],
      details: { statusCode: response.statusCode }
    });

    const errorOk = response.body.error === 'invalid_grant';
    checks.push({
      id: 'resource-as-error-untrusted-idp-code',
      name: 'ResourceAsErrorUntrustedIdpCode',
      description:
        'Resource AS error response uses error="invalid_grant" for an untrusted ID-JAG issuer (RFC 7521 §4.1.1)',
      status: errorOk ? 'SUCCESS' : 'FAILURE',
      timestamp: timestamp(),
      errorMessage: errorOk
        ? undefined
        : `Expected error "invalid_grant", got ${JSON.stringify(response.body.error)}`,
      specReferences: [
        SPEC_REFERENCES.RFC_7521_INVALID_GRANT,
        SPEC_REFERENCES.EMA
      ],
      details: {
        error: response.body.error,
        error_description: response.body.error_description
      }
    });

    return checks;
  }
}
