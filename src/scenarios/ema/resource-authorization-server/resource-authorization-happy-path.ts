/**
 * Successful-path scenarios for the Resource-AS side of Enterprise-Managed
 * Authorization (ISSUE-470):
 *   - Scenario 2 ({@link ResourceServerHappyPathScenario}): ID-JAG with no
 *     `resource` claim.
 *   - Scenario 3 ({@link ResourceServerHappyPathWithResourceScenario}): ID-JAG
 *     carrying a `resource` claim naming a trusted MCP Server, which the issued
 *     access token is audience-restricted to.
 *   - Scenario 4 ({@link ResourceServerHappyPathWithScopeScenario}): Scenario 3
 *     plus a `scope`.
 *
 * Each scenario targets a Resource AS named by {@link
 * ResourceAuthorizationServerOptions}: it discovers the token and introspection
 * endpoints from the issuer's server metadata, then drives the ID-JAG flow. The
 * runner plays the MCP Client and hosts the Trusted IdP AS, handed over through
 * `details` (see {@link getIdp}); it mints an ID-JAG, exchanges it for an access
 * token (client_secret_post), and introspects that token.
 *
 * The `resource` claim is OPTIONAL (EMA §4.3), so a Resource AS must return a
 * successful OAuth token response (RFC 6749 §5.1 / RFC 7521 §5.2) and a
 * successful introspection response (RFC 7662 §2.2) either way.
 */
import type {
  ConformanceCheck,
  ScenarioForResourceAuthorizationServer,
  ScenarioSource
} from '../../../types';
import type { ResourceAuthorizationServerOptions } from '../../../schemas';
import type { IdPAuthorizationServer } from '../auth/helpers/provideIdPAuthorizationServer';
import {
  requestAccessTokenWithIdJag,
  introspectToken,
  type TokenEndpointResponse,
  type IntrospectionEndpointResponse
} from '../auth/helpers/mockResourceAuthorizationServer';
import {
  TRUSTED_IDP_DETAIL,
  getIdp,
  discoverResourceAs,
  type ResourceAsEndpoints
} from './support';
import { SpecReferences as SPEC_REFERENCES } from '../auth/spec-references';

const EMA_SOURCE: ScenarioSource = {
  extensionId: 'io.modelcontextprotocol/enterprise-managed-authorization'
};

/** Resource-AS settings the ID-JAG happy-path flow requires from the config. */
interface FlowContext {
  clientId: string;
  clientSecret: string;
  /** User id registered with the trusted IdP; carried as the ID-JAG `sub` claim. */
  idpSub: string;
  /** User id registered with the target Resource AS; expected in the issued access token's `sub` claim. */
  sub: string;
  /** MCP Server the ID-JAG names (`resource`); omitted for the no-resource scenario. */
  resource?: string;
  /** OAuth scope the ID-JAG requests (`scope`); omitted when not exercising scope. */
  scope?: string;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
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
    description: 'Resource AS ID-JAG happy-path flow failed to run',
    status: 'FAILURE',
    timestamp: new Date().toISOString(),
    errorMessage: error instanceof Error ? error.message : String(error),
    specReferences: [SPEC_REFERENCES.EMA]
  };
}

/**
 * Resolve the config fields every happy-path flow needs (`clientId`,
 * `clientSecret`, `idpSub`, `sub`) plus any scenario-specific extras. Returns
 * the missing field name when a required value is absent.
 */
function resolveFlowContext(
  options: ResourceAuthorizationServerOptions,
  extras: { resource?: boolean; scope?: boolean } = {}
): FlowContext | { missing: string } {
  if (!options.clientId) return { missing: 'clientId' };
  if (!options.clientSecret) return { missing: 'clientSecret' };
  if (!options.idpSub) return { missing: 'idpSub' };
  if (!options.sub) return { missing: 'sub' };
  if (extras.resource && !options.trustedMcpServer) {
    return { missing: 'trustedMcpServer' };
  }
  if (extras.scope && !options.scope) return { missing: 'scope' };
  return {
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    idpSub: options.idpSub,
    sub: options.sub,
    resource: extras.resource ? options.trustedMcpServer : undefined,
    scope: extras.scope ? options.scope : undefined
  };
}

/**
 * Mint an ID-JAG, exchange it for an access token, and introspect that token
 * against the discovered endpoints. Shared by all three happy-path scenarios.
 */
async function requestAndIntrospect(
  idp: IdPAuthorizationServer,
  endpoints: ResourceAsEndpoints,
  flow: FlowContext
): Promise<{
  tokenResponse: TokenEndpointResponse;
  introspection?: IntrospectionEndpointResponse;
  accessToken?: string;
}> {
  const idJag = await idp.issueIdJag({
    subject: flow.idpSub,
    audience: endpoints.issuer,
    clientId: flow.clientId,
    resource: flow.resource,
    scope: flow.scope
  });

  const tokenResponse = await requestAccessTokenWithIdJag(
    endpoints.tokenEndpoint,
    {
      assertion: idJag,
      clientId: flow.clientId,
      clientSecret: flow.clientSecret,
      clientAuthMethod: 'client_secret_post'
    }
  );

  const accessToken =
    typeof tokenResponse.body.access_token === 'string'
      ? tokenResponse.body.access_token
      : undefined;

  let introspection: IntrospectionEndpointResponse | undefined;
  if (accessToken) {
    introspection = await introspectToken(endpoints.introspectionEndpoint, {
      token: accessToken,
      clientId: flow.clientId,
      clientSecret: flow.clientSecret,
      clientAuthMethod: 'client_secret_post'
    });
  }

  return { tokenResponse, introspection, accessToken };
}

/**
 * Scenario 2: successful ID-JAG exchange and introspection without a `resource`
 * claim. The target Resource AS must be configured to not require a `resource`
 * claim (EMA §4.3).
 */
export class ResourceServerHappyPathScenario implements ScenarioForResourceAuthorizationServer {
  name = 'ema/resource-authorization-server/happy-path';
  readonly source = EMA_SOURCE;
  description =
    'EMA: a Resource AS accepts an ID-JAG without a resource claim, returns an RFC 6749 §5.1 token response (no refresh token), and introspects the issued access token (client_id + sub).';

  async run(
    options: ResourceAuthorizationServerOptions,
    details: Record<string, unknown>
  ): Promise<ConformanceCheck[]> {
    try {
      const flow = resolveFlowContext(options);
      if ('missing' in flow) {
        return [
          skippedCheck(
            'resource-as-happy-token-response',
            'ResourceAsHappyTokenResponse',
            `happy-path requires the "${flow.missing}" setting`
          )
        ];
      }
      const idp = getIdp(details, TRUSTED_IDP_DETAIL);
      if (!idp) {
        return [
          skippedCheck(
            'resource-as-happy-token-response',
            'ResourceAsHappyTokenResponse',
            'happy-path requires a trusted IdP AS supplied via details'
          )
        ];
      }
      const endpoints = await discoverResourceAs(options.url);
      return await this.runFlow(idp, endpoints, flow);
    } catch (error) {
      return [
        failureCheck(
          'resource-as-happy-token-response',
          'ResourceAsHappyTokenResponse',
          error
        )
      ];
    }
  }

  private async runFlow(
    idp: IdPAuthorizationServer,
    endpoints: ResourceAsEndpoints,
    flow: FlowContext
  ): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const timestamp = () => new Date().toISOString();

    const { tokenResponse, introspection, accessToken } =
      await requestAndIntrospect(idp, endpoints, flow);

    this.checkTokenResponse(checks, tokenResponse, timestamp);
    this.checkIntrospection(
      checks,
      accessToken ? introspection : undefined,
      flow,
      timestamp
    );

    return checks;
  }

  private checkTokenResponse(
    checks: ConformanceCheck[],
    response: TokenEndpointResponse,
    timestamp: () => string
  ): void {
    const accessToken =
      typeof response.body.access_token === 'string'
        ? response.body.access_token
        : undefined;
    const tokenTypeOk =
      typeof response.body.token_type === 'string' &&
      response.body.token_type.length > 0;
    const jsonContentType =
      typeof response.contentType === 'string' &&
      response.contentType.toLowerCase().includes('application/json');
    const successOk =
      response.statusCode === 200 &&
      accessToken !== undefined &&
      tokenTypeOk &&
      jsonContentType;

    checks.push({
      id: 'resource-as-happy-token-response',
      name: 'ResourceAsHappyTokenResponse',
      description:
        'Resource AS returns a successful access token response with access_token and token_type (RFC 6749 §5.1 / RFC 7521 §5.2)',
      status: successOk ? 'SUCCESS' : 'FAILURE',
      timestamp: timestamp(),
      errorMessage: successOk
        ? undefined
        : `Expected 200 JSON token response with access_token and token_type, got status ${response.statusCode}, body ${JSON.stringify(response.body)}`,
      specReferences: [
        SPEC_REFERENCES.RFC_6749_TOKEN_RESPONSE,
        SPEC_REFERENCES.RFC_7521_RESPONSE,
        SPEC_REFERENCES.EMA
      ],
      details: {
        statusCode: response.statusCode,
        contentType: response.contentType,
        token_type: response.body.token_type
      }
    });

    // RFC 6749 §5.1: successful token responses must not be cached.
    const cacheControl = headerValue(response.headers, 'cache-control');
    const cacheControlOk =
      typeof cacheControl === 'string' &&
      cacheControl.toLowerCase().includes('no-store');
    checks.push({
      id: 'resource-as-happy-token-cache-control',
      name: 'ResourceAsHappyTokenCacheControl',
      description:
        'Resource AS token response sets Cache-Control: no-store (RFC 6749 §5.1)',
      status: cacheControlOk ? 'SUCCESS' : 'FAILURE',
      timestamp: timestamp(),
      errorMessage: cacheControlOk
        ? undefined
        : `Expected Cache-Control: no-store, got ${cacheControl ?? '(missing)'}`,
      specReferences: [SPEC_REFERENCES.RFC_6749_TOKEN_RESPONSE],
      details: { cacheControl }
    });

    // The flow uses no refresh token; the response must not include one.
    const hasRefreshToken = response.body.refresh_token !== undefined;
    checks.push({
      id: 'resource-as-happy-no-refresh-token',
      name: 'ResourceAsHappyNoRefreshToken',
      description:
        'Resource AS token response does not include a refresh_token for the ID-JAG grant',
      status: hasRefreshToken ? 'FAILURE' : 'SUCCESS',
      timestamp: timestamp(),
      errorMessage: hasRefreshToken
        ? `Unexpected refresh_token in the token response: ${JSON.stringify(response.body.refresh_token)}`
        : undefined,
      specReferences: [SPEC_REFERENCES.RFC_6749_TOKEN_RESPONSE],
      details: { refresh_token_present: hasRefreshToken }
    });
  }

  private checkIntrospection(
    checks: ConformanceCheck[],
    response: IntrospectionEndpointResponse | undefined,
    flow: FlowContext,
    timestamp: () => string
  ): void {
    const activeOk =
      response !== undefined &&
      response.statusCode === 200 &&
      response.body.active === true;
    checks.push({
      id: 'resource-as-happy-introspection-active',
      name: 'ResourceAsHappyIntrospectionActive',
      description:
        'Resource AS returns a successful introspection response marking the access token active (RFC 7662 §2.2)',
      status: activeOk ? 'SUCCESS' : 'FAILURE',
      timestamp: timestamp(),
      errorMessage: activeOk
        ? undefined
        : `Expected 200 introspection response with active=true, got ${response ? `status ${response.statusCode}, body ${JSON.stringify(response.body)}` : '(no introspection performed)'}`,
      specReferences: [SPEC_REFERENCES.RFC_7662_INTROSPECTION],
      details: response
        ? { statusCode: response.statusCode, active: response.body.active }
        : {}
    });

    const clientIdOk = response?.body.client_id === flow.clientId;
    checks.push({
      id: 'resource-as-happy-introspection-client-id',
      name: 'ResourceAsHappyIntrospectionClientId',
      description: `Introspection response "client_id" equals the configured client "${flow.clientId}" (RFC 7662 §2.2)`,
      status: clientIdOk ? 'SUCCESS' : 'FAILURE',
      timestamp: timestamp(),
      errorMessage: clientIdOk
        ? undefined
        : `Expected client_id "${flow.clientId}", got ${JSON.stringify(response?.body.client_id)}`,
      specReferences: [SPEC_REFERENCES.RFC_7662_INTROSPECTION],
      details: { client_id: response?.body.client_id }
    });

    // The access token's sub is the Resource AS's own id for the user identified
    // by the ID-JAG's sub claim (flow.idpSub), which may differ from it.
    const subOk = response?.body.sub === flow.sub;
    checks.push({
      id: 'resource-as-happy-introspection-sub',
      name: 'ResourceAsHappyIntrospectionSub',
      description:
        'Introspection response "sub" equals the configured Resource AS user id linked to the ID-JAG subject (RFC 7662 §2.2)',
      status: subOk ? 'SUCCESS' : 'FAILURE',
      timestamp: timestamp(),
      errorMessage: subOk
        ? undefined
        : `Expected sub "${flow.sub}", got ${JSON.stringify(response?.body.sub)}`,
      specReferences: [SPEC_REFERENCES.RFC_7662_INTROSPECTION],
      details: { sub: response?.body.sub, username: response?.body.username }
    });
  }
}

/**
 * Scenario 3: successful ID-JAG exchange and introspection with a `resource`
 * claim naming a trusted MCP Server. The issued access token is
 * audience-restricted to that MCP Server (EMA §5.1), so introspection reports a
 * single-valued `aud` equal to the trusted MCP Server URL.
 */
export class ResourceServerHappyPathWithResourceScenario implements ScenarioForResourceAuthorizationServer {
  name = 'ema/resource-authorization-server/happy-path-with-resource';
  readonly source = EMA_SOURCE;
  description =
    'EMA: a Resource AS accepts an ID-JAG carrying a resource claim for a trusted MCP Server, returns an RFC 6749 §5.1 token response (no refresh token), and introspects the issued access token (client_id, sub, and single-valued aud = the MCP Server).';

  async run(
    options: ResourceAuthorizationServerOptions,
    details: Record<string, unknown>
  ): Promise<ConformanceCheck[]> {
    try {
      const flow = resolveFlowContext(options, { resource: true });
      if ('missing' in flow) {
        return [
          skippedCheck(
            'resource-as-happy-with-resource-token-response',
            'ResourceAsHappyWithResourceTokenResponse',
            `happy-path-with-resource requires the "${flow.missing}" setting`
          )
        ];
      }
      const idp = getIdp(details, TRUSTED_IDP_DETAIL);
      if (!idp) {
        return [
          skippedCheck(
            'resource-as-happy-with-resource-token-response',
            'ResourceAsHappyWithResourceTokenResponse',
            'happy-path-with-resource requires a trusted IdP AS supplied via details'
          )
        ];
      }
      const endpoints = await discoverResourceAs(options.url);
      return await this.runFlow(idp, endpoints, flow);
    } catch (error) {
      return [
        failureCheck(
          'resource-as-happy-with-resource-token-response',
          'ResourceAsHappyWithResourceTokenResponse',
          error
        )
      ];
    }
  }

  private async runFlow(
    idp: IdPAuthorizationServer,
    endpoints: ResourceAsEndpoints,
    flow: FlowContext
  ): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const timestamp = () => new Date().toISOString();

    const { tokenResponse, introspection, accessToken } =
      await requestAndIntrospect(idp, endpoints, flow);

    this.checkTokenResponse(checks, tokenResponse, timestamp);
    this.checkIntrospection(
      checks,
      accessToken ? introspection : undefined,
      flow,
      timestamp
    );

    return checks;
  }

  private checkTokenResponse(
    checks: ConformanceCheck[],
    response: TokenEndpointResponse,
    timestamp: () => string
  ): void {
    const accessToken =
      typeof response.body.access_token === 'string'
        ? response.body.access_token
        : undefined;
    const tokenTypeOk =
      typeof response.body.token_type === 'string' &&
      response.body.token_type.length > 0;
    const jsonContentType =
      typeof response.contentType === 'string' &&
      response.contentType.toLowerCase().includes('application/json');
    const successOk =
      response.statusCode === 200 &&
      accessToken !== undefined &&
      tokenTypeOk &&
      jsonContentType;

    checks.push({
      id: 'resource-as-happy-with-resource-token-response',
      name: 'ResourceAsHappyWithResourceTokenResponse',
      description:
        'Resource AS returns a successful access token response with access_token and token_type (RFC 6749 §5.1 / RFC 7521 §5.2)',
      status: successOk ? 'SUCCESS' : 'FAILURE',
      timestamp: timestamp(),
      errorMessage: successOk
        ? undefined
        : `Expected 200 JSON token response with access_token and token_type, got status ${response.statusCode}, body ${JSON.stringify(response.body)}`,
      specReferences: [
        SPEC_REFERENCES.RFC_6749_TOKEN_RESPONSE,
        SPEC_REFERENCES.RFC_7521_RESPONSE,
        SPEC_REFERENCES.EMA
      ],
      details: {
        statusCode: response.statusCode,
        contentType: response.contentType,
        token_type: response.body.token_type
      }
    });

    const cacheControl = headerValue(response.headers, 'cache-control');
    const cacheControlOk =
      typeof cacheControl === 'string' &&
      cacheControl.toLowerCase().includes('no-store');
    checks.push({
      id: 'resource-as-happy-with-resource-token-cache-control',
      name: 'ResourceAsHappyWithResourceTokenCacheControl',
      description:
        'Resource AS token response sets Cache-Control: no-store (RFC 6749 §5.1)',
      status: cacheControlOk ? 'SUCCESS' : 'FAILURE',
      timestamp: timestamp(),
      errorMessage: cacheControlOk
        ? undefined
        : `Expected Cache-Control: no-store, got ${cacheControl ?? '(missing)'}`,
      specReferences: [SPEC_REFERENCES.RFC_6749_TOKEN_RESPONSE],
      details: { cacheControl }
    });

    const hasRefreshToken = response.body.refresh_token !== undefined;
    checks.push({
      id: 'resource-as-happy-with-resource-no-refresh-token',
      name: 'ResourceAsHappyWithResourceNoRefreshToken',
      description:
        'Resource AS token response does not include a refresh_token for the ID-JAG grant',
      status: hasRefreshToken ? 'FAILURE' : 'SUCCESS',
      timestamp: timestamp(),
      errorMessage: hasRefreshToken
        ? `Unexpected refresh_token in the token response: ${JSON.stringify(response.body.refresh_token)}`
        : undefined,
      specReferences: [SPEC_REFERENCES.RFC_6749_TOKEN_RESPONSE],
      details: { refresh_token_present: hasRefreshToken }
    });
  }

  private checkIntrospection(
    checks: ConformanceCheck[],
    response: IntrospectionEndpointResponse | undefined,
    flow: FlowContext,
    timestamp: () => string
  ): void {
    const activeOk =
      response !== undefined &&
      response.statusCode === 200 &&
      response.body.active === true;
    checks.push({
      id: 'resource-as-happy-with-resource-introspection-active',
      name: 'ResourceAsHappyWithResourceIntrospectionActive',
      description:
        'Resource AS returns a successful introspection response marking the access token active (RFC 7662 §2.2)',
      status: activeOk ? 'SUCCESS' : 'FAILURE',
      timestamp: timestamp(),
      errorMessage: activeOk
        ? undefined
        : `Expected 200 introspection response with active=true, got ${response ? `status ${response.statusCode}, body ${JSON.stringify(response.body)}` : '(no introspection performed)'}`,
      specReferences: [SPEC_REFERENCES.RFC_7662_INTROSPECTION],
      details: response
        ? { statusCode: response.statusCode, active: response.body.active }
        : {}
    });

    const clientIdOk = response?.body.client_id === flow.clientId;
    checks.push({
      id: 'resource-as-happy-with-resource-introspection-client-id',
      name: 'ResourceAsHappyWithResourceIntrospectionClientId',
      description: `Introspection response "client_id" equals the configured client "${flow.clientId}" (RFC 7662 §2.2)`,
      status: clientIdOk ? 'SUCCESS' : 'FAILURE',
      timestamp: timestamp(),
      errorMessage: clientIdOk
        ? undefined
        : `Expected client_id "${flow.clientId}", got ${JSON.stringify(response?.body.client_id)}`,
      specReferences: [SPEC_REFERENCES.RFC_7662_INTROSPECTION],
      details: { client_id: response?.body.client_id }
    });

    // The access token's sub is the Resource AS's own id for the user identified
    // by the ID-JAG's sub claim (flow.idpSub), which may differ from it.
    const subOk = response?.body.sub === flow.sub;
    checks.push({
      id: 'resource-as-happy-with-resource-introspection-sub',
      name: 'ResourceAsHappyWithResourceIntrospectionSub',
      description:
        'Introspection response "sub" equals the configured Resource AS user id linked to the ID-JAG subject (RFC 7662 §2.2)',
      status: subOk ? 'SUCCESS' : 'FAILURE',
      timestamp: timestamp(),
      errorMessage: subOk
        ? undefined
        : `Expected sub "${flow.sub}", got ${JSON.stringify(response?.body.sub)}`,
      specReferences: [SPEC_REFERENCES.RFC_7662_INTROSPECTION],
      details: { sub: response?.body.sub, username: response?.body.username }
    });

    // `aud` must be a string or a single-element array (RFC 7662 §2.2 / RFC 7519).
    const aud = response?.body.aud;
    let audValues: string[] | undefined;
    if (typeof aud === 'string') {
      audValues = [aud];
    } else if (
      Array.isArray(aud) &&
      aud.length === 1 &&
      typeof aud[0] === 'string'
    ) {
      audValues = aud as string[];
    }
    const audFormatOk = audValues !== undefined;
    checks.push({
      id: 'resource-as-happy-with-resource-introspection-aud-format',
      name: 'ResourceAsHappyWithResourceIntrospectionAudFormat',
      description:
        'Introspection response "aud" is a string or a single-valued array (RFC 7662 §2.2)',
      status: audFormatOk ? 'SUCCESS' : 'FAILURE',
      timestamp: timestamp(),
      errorMessage: audFormatOk
        ? undefined
        : `Expected "aud" to be a string or single-element array, got ${JSON.stringify(aud)}`,
      specReferences: [SPEC_REFERENCES.RFC_7662_INTROSPECTION],
      details: { aud }
    });

    // The single audience value must be the trusted MCP Server (EMA §5.1).
    const audValueOk = audValues?.[0] === flow.resource;
    checks.push({
      id: 'resource-as-happy-with-resource-introspection-aud-value',
      name: 'ResourceAsHappyWithResourceIntrospectionAudValue',
      description: `Introspection response "aud" equals the configured trusted MCP Server "${flow.resource}" (EMA §5.1)`,
      status: audValueOk ? 'SUCCESS' : 'FAILURE',
      timestamp: timestamp(),
      errorMessage: audValueOk
        ? undefined
        : `Expected aud "${flow.resource}", got ${JSON.stringify(aud)}`,
      specReferences: [
        SPEC_REFERENCES.RFC_7662_INTROSPECTION,
        SPEC_REFERENCES.EMA
      ],
      details: { aud }
    });
  }
}

/**
 * Scenario 4: successful ID-JAG exchange and introspection with both a
 * `resource` claim naming a trusted MCP Server and a `scope`. Extends Scenario 3
 * by requesting a registered scope and asserting the introspection response
 * carries it back.
 */
export class ResourceServerHappyPathWithScopeScenario implements ScenarioForResourceAuthorizationServer {
  name = 'ema/resource-authorization-server/happy-path-with-scope';
  readonly source = EMA_SOURCE;
  description =
    'EMA: a Resource AS accepts an ID-JAG carrying a resource claim and a scope, returns an RFC 6749 §5.1 token response (no refresh token), and introspects the issued access token (client_id, sub, single-valued aud = the MCP Server, and scope).';

  async run(
    options: ResourceAuthorizationServerOptions,
    details: Record<string, unknown>
  ): Promise<ConformanceCheck[]> {
    try {
      const flow = resolveFlowContext(options, { resource: true, scope: true });
      if ('missing' in flow) {
        return [
          skippedCheck(
            'resource-as-happy-with-scope-token-response',
            'ResourceAsHappyWithScopeTokenResponse',
            `happy-path-with-scope requires the "${flow.missing}" setting`
          )
        ];
      }
      const idp = getIdp(details, TRUSTED_IDP_DETAIL);
      if (!idp) {
        return [
          skippedCheck(
            'resource-as-happy-with-scope-token-response',
            'ResourceAsHappyWithScopeTokenResponse',
            'happy-path-with-scope requires a trusted IdP AS supplied via details'
          )
        ];
      }
      const endpoints = await discoverResourceAs(options.url);
      return await this.runFlow(idp, endpoints, flow);
    } catch (error) {
      return [
        failureCheck(
          'resource-as-happy-with-scope-token-response',
          'ResourceAsHappyWithScopeTokenResponse',
          error
        )
      ];
    }
  }

  private async runFlow(
    idp: IdPAuthorizationServer,
    endpoints: ResourceAsEndpoints,
    flow: FlowContext
  ): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const timestamp = () => new Date().toISOString();

    const { tokenResponse, introspection, accessToken } =
      await requestAndIntrospect(idp, endpoints, flow);

    this.checkTokenResponse(checks, tokenResponse, timestamp);
    this.checkIntrospection(
      checks,
      accessToken ? introspection : undefined,
      flow,
      timestamp
    );

    return checks;
  }

  private checkTokenResponse(
    checks: ConformanceCheck[],
    response: TokenEndpointResponse,
    timestamp: () => string
  ): void {
    const accessToken =
      typeof response.body.access_token === 'string'
        ? response.body.access_token
        : undefined;
    const tokenTypeOk =
      typeof response.body.token_type === 'string' &&
      response.body.token_type.length > 0;
    const jsonContentType =
      typeof response.contentType === 'string' &&
      response.contentType.toLowerCase().includes('application/json');
    const successOk =
      response.statusCode === 200 &&
      accessToken !== undefined &&
      tokenTypeOk &&
      jsonContentType;

    checks.push({
      id: 'resource-as-happy-with-scope-token-response',
      name: 'ResourceAsHappyWithScopeTokenResponse',
      description:
        'Resource AS returns a successful access token response with access_token and token_type (RFC 6749 §5.1 / RFC 7521 §5.2)',
      status: successOk ? 'SUCCESS' : 'FAILURE',
      timestamp: timestamp(),
      errorMessage: successOk
        ? undefined
        : `Expected 200 JSON token response with access_token and token_type, got status ${response.statusCode}, body ${JSON.stringify(response.body)}`,
      specReferences: [
        SPEC_REFERENCES.RFC_6749_TOKEN_RESPONSE,
        SPEC_REFERENCES.RFC_7521_RESPONSE,
        SPEC_REFERENCES.EMA
      ],
      details: {
        statusCode: response.statusCode,
        contentType: response.contentType,
        token_type: response.body.token_type
      }
    });

    const cacheControl = headerValue(response.headers, 'cache-control');
    const cacheControlOk =
      typeof cacheControl === 'string' &&
      cacheControl.toLowerCase().includes('no-store');
    checks.push({
      id: 'resource-as-happy-with-scope-token-cache-control',
      name: 'ResourceAsHappyWithScopeTokenCacheControl',
      description:
        'Resource AS token response sets Cache-Control: no-store (RFC 6749 §5.1)',
      status: cacheControlOk ? 'SUCCESS' : 'FAILURE',
      timestamp: timestamp(),
      errorMessage: cacheControlOk
        ? undefined
        : `Expected Cache-Control: no-store, got ${cacheControl ?? '(missing)'}`,
      specReferences: [SPEC_REFERENCES.RFC_6749_TOKEN_RESPONSE],
      details: { cacheControl }
    });

    const hasRefreshToken = response.body.refresh_token !== undefined;
    checks.push({
      id: 'resource-as-happy-with-scope-no-refresh-token',
      name: 'ResourceAsHappyWithScopeNoRefreshToken',
      description:
        'Resource AS token response does not include a refresh_token for the ID-JAG grant',
      status: hasRefreshToken ? 'FAILURE' : 'SUCCESS',
      timestamp: timestamp(),
      errorMessage: hasRefreshToken
        ? `Unexpected refresh_token in the token response: ${JSON.stringify(response.body.refresh_token)}`
        : undefined,
      specReferences: [SPEC_REFERENCES.RFC_6749_TOKEN_RESPONSE],
      details: { refresh_token_present: hasRefreshToken }
    });
  }

  private checkIntrospection(
    checks: ConformanceCheck[],
    response: IntrospectionEndpointResponse | undefined,
    flow: FlowContext,
    timestamp: () => string
  ): void {
    const activeOk =
      response !== undefined &&
      response.statusCode === 200 &&
      response.body.active === true;
    checks.push({
      id: 'resource-as-happy-with-scope-introspection-active',
      name: 'ResourceAsHappyWithScopeIntrospectionActive',
      description:
        'Resource AS returns a successful introspection response marking the access token active (RFC 7662 §2.2)',
      status: activeOk ? 'SUCCESS' : 'FAILURE',
      timestamp: timestamp(),
      errorMessage: activeOk
        ? undefined
        : `Expected 200 introspection response with active=true, got ${response ? `status ${response.statusCode}, body ${JSON.stringify(response.body)}` : '(no introspection performed)'}`,
      specReferences: [SPEC_REFERENCES.RFC_7662_INTROSPECTION],
      details: response
        ? { statusCode: response.statusCode, active: response.body.active }
        : {}
    });

    const clientIdOk = response?.body.client_id === flow.clientId;
    checks.push({
      id: 'resource-as-happy-with-scope-introspection-client-id',
      name: 'ResourceAsHappyWithScopeIntrospectionClientId',
      description: `Introspection response "client_id" equals the configured client "${flow.clientId}" (RFC 7662 §2.2)`,
      status: clientIdOk ? 'SUCCESS' : 'FAILURE',
      timestamp: timestamp(),
      errorMessage: clientIdOk
        ? undefined
        : `Expected client_id "${flow.clientId}", got ${JSON.stringify(response?.body.client_id)}`,
      specReferences: [SPEC_REFERENCES.RFC_7662_INTROSPECTION],
      details: { client_id: response?.body.client_id }
    });

    // The access token's sub is the Resource AS's own id for the user identified
    // by the ID-JAG's sub claim (flow.idpSub), which may differ from it.
    const subOk = response?.body.sub === flow.sub;
    checks.push({
      id: 'resource-as-happy-with-scope-introspection-sub',
      name: 'ResourceAsHappyWithScopeIntrospectionSub',
      description:
        'Introspection response "sub" equals the configured Resource AS user id linked to the ID-JAG subject (RFC 7662 §2.2)',
      status: subOk ? 'SUCCESS' : 'FAILURE',
      timestamp: timestamp(),
      errorMessage: subOk
        ? undefined
        : `Expected sub "${flow.sub}", got ${JSON.stringify(response?.body.sub)}`,
      specReferences: [SPEC_REFERENCES.RFC_7662_INTROSPECTION],
      details: { sub: response?.body.sub, username: response?.body.username }
    });

    const aud = response?.body.aud;
    let audValues: string[] | undefined;
    if (typeof aud === 'string') {
      audValues = [aud];
    } else if (
      Array.isArray(aud) &&
      aud.length === 1 &&
      typeof aud[0] === 'string'
    ) {
      audValues = aud as string[];
    }
    const audFormatOk = audValues !== undefined;
    checks.push({
      id: 'resource-as-happy-with-scope-introspection-aud-format',
      name: 'ResourceAsHappyWithScopeIntrospectionAudFormat',
      description:
        'Introspection response "aud" is a string or a single-valued array (RFC 7662 §2.2)',
      status: audFormatOk ? 'SUCCESS' : 'FAILURE',
      timestamp: timestamp(),
      errorMessage: audFormatOk
        ? undefined
        : `Expected "aud" to be a string or single-element array, got ${JSON.stringify(aud)}`,
      specReferences: [SPEC_REFERENCES.RFC_7662_INTROSPECTION],
      details: { aud }
    });

    const audValueOk = audValues?.[0] === flow.resource;
    checks.push({
      id: 'resource-as-happy-with-scope-introspection-aud-value',
      name: 'ResourceAsHappyWithScopeIntrospectionAudValue',
      description: `Introspection response "aud" equals the configured trusted MCP Server "${flow.resource}" (EMA §5.1)`,
      status: audValueOk ? 'SUCCESS' : 'FAILURE',
      timestamp: timestamp(),
      errorMessage: audValueOk
        ? undefined
        : `Expected aud "${flow.resource}", got ${JSON.stringify(aud)}`,
      specReferences: [
        SPEC_REFERENCES.RFC_7662_INTROSPECTION,
        SPEC_REFERENCES.EMA
      ],
      details: { aud }
    });

    // `scope` is space-delimited (RFC 7662 §2.2); it must include the requested scope.
    const scope = response?.body.scope;
    const scopeIncluded =
      typeof scope === 'string' &&
      flow.scope !== undefined &&
      scope.split(' ').includes(flow.scope);
    checks.push({
      id: 'resource-as-happy-with-scope-introspection-scope',
      name: 'ResourceAsHappyWithScopeIntrospectionScope',
      description: `Introspection response "scope" includes the configured scope "${flow.scope}" (RFC 7662 §2.2)`,
      status: scopeIncluded ? 'SUCCESS' : 'FAILURE',
      timestamp: timestamp(),
      errorMessage: scopeIncluded
        ? undefined
        : `Expected "scope" to include "${flow.scope}", got ${JSON.stringify(scope)}`,
      specReferences: [SPEC_REFERENCES.RFC_7662_INTROSPECTION],
      details: { scope }
    });
  }
}
