import { describe, it, expect, afterEach } from 'vitest';
import * as jose from 'jose';
import {
  IdPAuthorizationServer,
  createIdPKeyPair,
  createIdJag,
  ID_JAG_ALG
} from './provideIdPAuthorizationServer';
import {
  MockResourceAuthorizationServer,
  validateIdJagForResourceAs,
  requestAccessTokenWithIdJag,
  introspectToken,
  JWT_BEARER_GRANT_TYPE,
  ID_JAG_GRANT_PROFILE,
  type ResourceAsKeyResolver
} from './mockResourceAuthorizationServer';

const MCP_RESOURCE = 'https://mcp.example/';
const TEST_CLIENT_ID = 'conformance-test-client';
const TEST_SUBJECT = 'demo-user@example.com';

// ---------------------------------------------------------------------------
// Pure validator (Resource-AS processing rules) with a stub key resolver
// ---------------------------------------------------------------------------

describe('validateIdJagForResourceAs', () => {
  const RESOURCE_AS_ISSUER = 'https://resource-as.example';
  const IDP_ISSUER = 'https://trusted-idp.example';

  async function setup() {
    const idpKey = await createIdPKeyPair('idp-key');
    const resolve: ResourceAsKeyResolver = async (issuer) => {
      if (issuer === IDP_ISSUER) return [idpKey.publicJwk];
      throw new Error(`no keys for ${issuer}`);
    };
    return { idpKey, resolve };
  }

  it('accepts a valid ID-JAG from a trusted IdP', async () => {
    const { idpKey, resolve } = await setup();
    const assertion = await createIdJag(idpKey.privateKey, idpKey.kid, {
      issuer: IDP_ISSUER,
      subject: TEST_SUBJECT,
      audience: RESOURCE_AS_ISSUER,
      resource: MCP_RESOURCE,
      clientId: TEST_CLIENT_ID,
      scope: 'mcp.read'
    });

    const result = await validateIdJagForResourceAs(assertion, {
      resourceAsIssuer: RESOURCE_AS_ISSUER,
      trustedIdpIssuers: [IDP_ISSUER],
      resolveIdpKeys: resolve
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issuer).toBe(IDP_ISSUER);
      expect(result.subject).toBe(TEST_SUBJECT);
      expect(result.resource).toBe(MCP_RESOURCE);
      expect(result.scope).toBe('mcp.read');
      expect(result.clientId).toBe(TEST_CLIENT_ID);
    }
  });

  it('rejects an ID-JAG from an untrusted issuer with invalid_grant', async () => {
    const { idpKey, resolve } = await setup();
    const assertion = await createIdJag(idpKey.privateKey, idpKey.kid, {
      issuer: 'https://untrusted-idp.example',
      subject: TEST_SUBJECT,
      audience: RESOURCE_AS_ISSUER,
      resource: MCP_RESOURCE
    });

    const result = await validateIdJagForResourceAs(assertion, {
      resourceAsIssuer: RESOURCE_AS_ISSUER,
      trustedIdpIssuers: [IDP_ISSUER],
      resolveIdpKeys: resolve
    });

    expect(result).toMatchObject({ ok: false, error: 'invalid_grant' });
  });

  it('rejects a bad signature (trusted issuer, foreign key) with invalid_grant', async () => {
    const { resolve } = await setup();
    const foreignKey = await createIdPKeyPair('foreign');
    const assertion = await createIdJag(foreignKey.privateKey, foreignKey.kid, {
      issuer: IDP_ISSUER,
      subject: TEST_SUBJECT,
      audience: RESOURCE_AS_ISSUER,
      resource: MCP_RESOURCE
    });

    const result = await validateIdJagForResourceAs(assertion, {
      resourceAsIssuer: RESOURCE_AS_ISSUER,
      trustedIdpIssuers: [IDP_ISSUER],
      resolveIdpKeys: resolve
    });

    expect(result).toMatchObject({ ok: false, error: 'invalid_grant' });
  });

  it('rejects a mismatched audience with invalid_grant', async () => {
    const { idpKey, resolve } = await setup();
    const assertion = await createIdJag(idpKey.privateKey, idpKey.kid, {
      issuer: IDP_ISSUER,
      subject: TEST_SUBJECT,
      audience: 'https://other-resource-as.example',
      resource: MCP_RESOURCE
    });

    const result = await validateIdJagForResourceAs(assertion, {
      resourceAsIssuer: RESOURCE_AS_ISSUER,
      trustedIdpIssuers: [IDP_ISSUER],
      resolveIdpKeys: resolve
    });

    expect(result).toMatchObject({ ok: false, error: 'invalid_grant' });
  });

  it('rejects an expired ID-JAG with invalid_grant', async () => {
    const { idpKey, resolve } = await setup();
    const assertion = await createIdJag(idpKey.privateKey, idpKey.kid, {
      issuer: IDP_ISSUER,
      subject: TEST_SUBJECT,
      audience: RESOURCE_AS_ISSUER,
      resource: MCP_RESOURCE,
      expiresIn: '-60s'
    });

    const result = await validateIdJagForResourceAs(assertion, {
      resourceAsIssuer: RESOURCE_AS_ISSUER,
      trustedIdpIssuers: [IDP_ISSUER],
      resolveIdpKeys: resolve
    });

    expect(result).toMatchObject({ ok: false, error: 'invalid_grant' });
  });

  it('rejects a JWT with the wrong typ header with invalid_grant', async () => {
    const { idpKey, resolve } = await setup();
    const notAnIdJag = await new jose.SignJWT({ resource: MCP_RESOURCE })
      .setProtectedHeader({ alg: ID_JAG_ALG, typ: 'JWT', kid: idpKey.kid })
      .setIssuer(IDP_ISSUER)
      .setSubject(TEST_SUBJECT)
      .setAudience(RESOURCE_AS_ISSUER)
      .setIssuedAt()
      .setExpirationTime('5m')
      .setJti('x')
      .sign(idpKey.privateKey);

    const result = await validateIdJagForResourceAs(notAnIdJag, {
      resourceAsIssuer: RESOURCE_AS_ISSUER,
      trustedIdpIssuers: [IDP_ISSUER],
      resolveIdpKeys: resolve
    });

    expect(result).toMatchObject({ ok: false, error: 'invalid_grant' });
  });

  it('rejects an ID-JAG missing the resource claim with invalid_target', async () => {
    const { idpKey, resolve } = await setup();
    const assertion = await createIdJag(idpKey.privateKey, idpKey.kid, {
      issuer: IDP_ISSUER,
      subject: TEST_SUBJECT,
      audience: RESOURCE_AS_ISSUER
    });

    const result = await validateIdJagForResourceAs(assertion, {
      resourceAsIssuer: RESOURCE_AS_ISSUER,
      trustedIdpIssuers: [IDP_ISSUER],
      resolveIdpKeys: resolve
    });

    expect(result).toMatchObject({ ok: false, error: 'invalid_target' });
  });

  it('rejects a malformed assertion with invalid_request', async () => {
    const { resolve } = await setup();
    const result = await validateIdJagForResourceAs('not-a-jwt', {
      resourceAsIssuer: RESOURCE_AS_ISSUER,
      trustedIdpIssuers: [IDP_ISSUER],
      resolveIdpKeys: resolve
    });
    expect(result).toMatchObject({ ok: false, error: 'invalid_request' });
  });
});

// ---------------------------------------------------------------------------
// Hosted Resource AS driven end-to-end against real IdP AS servers
// ---------------------------------------------------------------------------

describe('MockResourceAuthorizationServer', () => {
  let trustedIdp: IdPAuthorizationServer | null = null;
  let untrustedIdp: IdPAuthorizationServer | null = null;
  let resourceAs: MockResourceAuthorizationServer | null = null;

  afterEach(async () => {
    await resourceAs?.stop();
    await trustedIdp?.stop();
    await untrustedIdp?.stop();
    resourceAs = null;
    trustedIdp = null;
    untrustedIdp = null;
  });

  async function boot() {
    trustedIdp = await IdPAuthorizationServer.create();
    await trustedIdp.start();
    untrustedIdp = await IdPAuthorizationServer.create();
    await untrustedIdp.start();
    resourceAs = await MockResourceAuthorizationServer.create({
      trustedIdpIssuers: [trustedIdp.issuer]
    });
    await resourceAs.start();
    return { trustedIdp, untrustedIdp, resourceAs };
  }

  it('advertises the id-jag grant profile and jwt-bearer grant in metadata', async () => {
    const { resourceAs } = await boot();
    const metadata = resourceAs.getMetadata();
    expect(metadata.issuer).toBe(resourceAs.issuer);
    expect(metadata.token_endpoint).toBe(resourceAs.tokenEndpoint);
    expect(metadata.grant_types_supported).toContain(JWT_BEARER_GRANT_TYPE);
    expect(metadata.authorization_grant_profiles_supported).toContain(
      ID_JAG_GRANT_PROFILE
    );
  });

  it('issues an access token audience-restricted to the resource for a valid ID-JAG', async () => {
    const { trustedIdp, resourceAs } = await boot();
    const assertion = await trustedIdp.issueIdJag({
      subject: TEST_SUBJECT,
      audience: resourceAs.issuer,
      resource: MCP_RESOURCE,
      clientId: TEST_CLIENT_ID,
      scope: 'mcp.read mcp.write'
    });

    const response = await requestAccessTokenWithIdJag(
      resourceAs.tokenEndpoint,
      { assertion, clientId: TEST_CLIENT_ID }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.token_type).toBe('Bearer');
    expect(response.body.scope).toBe('mcp.read mcp.write');
    expect(typeof response.body.access_token).toBe('string');

    const payload = await resourceAs.verifyAccessToken(
      response.body.access_token as string,
      MCP_RESOURCE
    );
    expect(payload.aud).toBe(MCP_RESOURCE);
    expect(payload.sub).toBe(TEST_SUBJECT);
    expect(payload.iss).toBe(resourceAs.issuer);
  });

  it('rejects an ID-JAG from an untrusted IdP', async () => {
    const { untrustedIdp, resourceAs } = await boot();
    const assertion = await untrustedIdp.issueIdJag({
      subject: TEST_SUBJECT,
      audience: resourceAs.issuer,
      resource: MCP_RESOURCE
    });

    const response = await requestAccessTokenWithIdJag(
      resourceAs.tokenEndpoint,
      { assertion }
    );

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toBe('invalid_grant');
  });

  it('rejects an ID-JAG that claims a trusted issuer but is signed by another key', async () => {
    const { trustedIdp, resourceAs } = await boot();
    // Forge the trusted issuer while signing with a foreign key; the Resource AS
    // fetches the real trusted IdP keys, so the signature must not verify.
    const foreignKey = await createIdPKeyPair('foreign');
    const assertion = await createIdJag(foreignKey.privateKey, foreignKey.kid, {
      issuer: trustedIdp.issuer,
      subject: TEST_SUBJECT,
      audience: resourceAs.issuer,
      resource: MCP_RESOURCE
    });

    const response = await requestAccessTokenWithIdJag(
      resourceAs.tokenEndpoint,
      { assertion }
    );

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toBe('invalid_grant');
  });

  it('rejects an ID-JAG addressed to a different audience', async () => {
    const { trustedIdp, resourceAs } = await boot();
    const assertion = await trustedIdp.issueIdJag({
      subject: TEST_SUBJECT,
      audience: 'https://other-resource-as.example',
      resource: MCP_RESOURCE
    });

    const response = await requestAccessTokenWithIdJag(
      resourceAs.tokenEndpoint,
      { assertion }
    );

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toBe('invalid_grant');
  });

  it('rejects an ID-JAG without a resource claim as invalid_target', async () => {
    const { trustedIdp, resourceAs } = await boot();
    const assertion = await trustedIdp.issueIdJag({
      subject: TEST_SUBJECT,
      audience: resourceAs.issuer
    });

    const response = await requestAccessTokenWithIdJag(
      resourceAs.tokenEndpoint,
      { assertion }
    );

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toBe('invalid_target');
  });

  it('rejects an unsupported grant type', async () => {
    const { trustedIdp, resourceAs } = await boot();
    const assertion = await trustedIdp.issueIdJag({
      subject: TEST_SUBJECT,
      audience: resourceAs.issuer,
      resource: MCP_RESOURCE
    });

    const response = await requestAccessTokenWithIdJag(
      resourceAs.tokenEndpoint,
      { assertion, grantType: 'authorization_code' }
    );

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toBe('unsupported_grant_type');
  });

  it('rejects a request missing the assertion parameter', async () => {
    const { resourceAs } = await boot();
    const response = await requestAccessTokenWithIdJag(
      resourceAs.tokenEndpoint,
      { assertion: '' }
    );

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toBe('invalid_request');
  });

  it('honours addTrustedIdp for issuers discovered after construction', async () => {
    trustedIdp = await IdPAuthorizationServer.create();
    await trustedIdp.start();
    resourceAs = await MockResourceAuthorizationServer.create();
    await resourceAs.start();
    resourceAs.addTrustedIdp(trustedIdp.issuer);

    const assertion = await trustedIdp.issueIdJag({
      subject: TEST_SUBJECT,
      audience: resourceAs.issuer,
      resource: MCP_RESOURCE
    });
    const response = await requestAccessTokenWithIdJag(
      resourceAs.tokenEndpoint,
      { assertion }
    );

    expect(response.statusCode).toBe(200);
  });
});

describe('MockResourceAuthorizationServer registration', () => {
  let trustedIdp: IdPAuthorizationServer | null = null;
  let resourceAs: MockResourceAuthorizationServer | null = null;

  afterEach(async () => {
    await resourceAs?.stop();
    await trustedIdp?.stop();
    resourceAs = null;
    trustedIdp = null;
  });

  async function bootWith(
    options: Parameters<typeof MockResourceAuthorizationServer.create>[0] = {}
  ) {
    trustedIdp = await IdPAuthorizationServer.create();
    await trustedIdp.start();
    resourceAs = await MockResourceAuthorizationServer.create({
      trustedIdpIssuers: [trustedIdp.issuer],
      ...options
    });
    await resourceAs.start();
    return { trustedIdp, resourceAs };
  }

  it('registerClient returns a secret and enforces client_secret_basic', async () => {
    const { trustedIdp, resourceAs } = await bootWith();
    const secret = resourceAs.registerClient(TEST_CLIENT_ID);
    expect(secret).toBe(resourceAs.getClientSecret(TEST_CLIENT_ID));

    const assertion = await trustedIdp.issueIdJag({
      subject: TEST_SUBJECT,
      audience: resourceAs.issuer,
      resource: MCP_RESOURCE,
      clientId: TEST_CLIENT_ID
    });

    const authed = await requestAccessTokenWithIdJag(resourceAs.tokenEndpoint, {
      assertion,
      clientId: TEST_CLIENT_ID,
      clientSecret: secret
    });
    expect(authed.statusCode).toBe(200);

    const noCreds = await requestAccessTokenWithIdJag(
      resourceAs.tokenEndpoint,
      {
        assertion
      }
    );
    expect(noCreds.statusCode).toBe(401);
    expect(noCreds.body.error).toBe('invalid_client');

    const badSecret = await requestAccessTokenWithIdJag(
      resourceAs.tokenEndpoint,
      { assertion, clientId: TEST_CLIENT_ID, clientSecret: 'wrong-secret' }
    );
    expect(badSecret.statusCode).toBe(401);
    expect(badSecret.body.error).toBe('invalid_client');
  });

  it('registerClient accepts a caller-provided secret', async () => {
    const { resourceAs } = await bootWith();
    const secret = resourceAs.registerClient(TEST_CLIENT_ID, 'fixed-secret');
    expect(secret).toBe('fixed-secret');
    expect(resourceAs.getClientSecret(TEST_CLIENT_ID)).toBe('fixed-secret');
  });

  it('registerUser returns a user id usable as the ID-JAG sub', async () => {
    const { trustedIdp, resourceAs } = await bootWith();
    const userId = resourceAs.registerUser('alice');
    expect(userId).toBe(resourceAs.getUserId('alice'));

    const assertion = await trustedIdp.issueIdJag({
      subject: userId,
      audience: resourceAs.issuer,
      resource: MCP_RESOURCE
    });
    const response = await requestAccessTokenWithIdJag(
      resourceAs.tokenEndpoint,
      { assertion }
    );
    expect(response.statusCode).toBe(200);

    const payload = await resourceAs.verifyAccessToken(
      response.body.access_token as string,
      MCP_RESOURCE
    );
    expect(payload.sub).toBe(userId);
  });

  it('linkIdpSubject maps the ID-JAG sub to the linked Resource AS user id', async () => {
    const { trustedIdp, resourceAs } = await bootWith();
    const userId = resourceAs.registerUser('alice');
    const idpSub = 'idp-alice-001';
    resourceAs.linkIdpSubject(idpSub, userId);

    const assertion = await trustedIdp.issueIdJag({
      subject: idpSub,
      audience: resourceAs.issuer,
      resource: MCP_RESOURCE
    });
    const response = await requestAccessTokenWithIdJag(
      resourceAs.tokenEndpoint,
      { assertion }
    );
    expect(response.statusCode).toBe(200);

    const payload = await resourceAs.verifyAccessToken(
      response.body.access_token as string,
      MCP_RESOURCE
    );
    expect(payload.sub).toBe(userId);
    expect(payload.sub).not.toBe(idpSub);
  });

  it('registerScope records recognised scopes', async () => {
    const { resourceAs } = await bootWith();
    resourceAs.registerScope('mcp.read');
    resourceAs.registerScope('mcp.write');
    expect(resourceAs.getRegisteredScopes()).toEqual(['mcp.read', 'mcp.write']);
  });

  it('rejects an ID-JAG requesting an unregistered scope with invalid_scope', async () => {
    const { trustedIdp, resourceAs } = await bootWith();
    resourceAs.registerScope('mcp.read');

    const accepted = await trustedIdp.issueIdJag({
      subject: TEST_SUBJECT,
      audience: resourceAs.issuer,
      resource: MCP_RESOURCE,
      scope: 'mcp.read'
    });
    const acceptedResponse = await requestAccessTokenWithIdJag(
      resourceAs.tokenEndpoint,
      { assertion: accepted }
    );
    expect(acceptedResponse.statusCode).toBe(200);

    const rejected = await trustedIdp.issueIdJag({
      subject: TEST_SUBJECT,
      audience: resourceAs.issuer,
      resource: MCP_RESOURCE,
      scope: 'mcp.read mcp.admin'
    });
    const rejectedResponse = await requestAccessTokenWithIdJag(
      resourceAs.tokenEndpoint,
      { assertion: rejected }
    );
    expect(rejectedResponse.statusCode).toBe(400);
    expect(rejectedResponse.body.error).toBe('invalid_scope');
  });

  it('only accepts ID-JAGs whose resource is a registered trusted MCP Server', async () => {
    const { trustedIdp, resourceAs } = await bootWith();
    resourceAs.registerTrustedMcpServer(MCP_RESOURCE);
    expect(resourceAs.getTrustedMcpServers()).toEqual([MCP_RESOURCE]);

    const trusted = await trustedIdp.issueIdJag({
      subject: TEST_SUBJECT,
      audience: resourceAs.issuer,
      resource: MCP_RESOURCE
    });
    const trustedResponse = await requestAccessTokenWithIdJag(
      resourceAs.tokenEndpoint,
      { assertion: trusted }
    );
    expect(trustedResponse.statusCode).toBe(200);

    const untrusted = await trustedIdp.issueIdJag({
      subject: TEST_SUBJECT,
      audience: resourceAs.issuer,
      resource: 'https://other-mcp.example/'
    });
    const untrustedResponse = await requestAccessTokenWithIdJag(
      resourceAs.tokenEndpoint,
      { assertion: untrusted }
    );
    expect(untrustedResponse.statusCode).toBe(400);
    expect(untrustedResponse.body.error).toBe('invalid_target');
  });

  it('registerTrustedIdp gates the accepted ID-JAG issuers', async () => {
    trustedIdp = await IdPAuthorizationServer.create();
    await trustedIdp.start();
    resourceAs = await MockResourceAuthorizationServer.create();
    await resourceAs.start();

    const assertion = await trustedIdp.issueIdJag({
      subject: TEST_SUBJECT,
      audience: resourceAs.issuer,
      resource: MCP_RESOURCE
    });

    const before = await requestAccessTokenWithIdJag(resourceAs.tokenEndpoint, {
      assertion
    });
    expect(before.statusCode).toBe(400);
    expect(before.body.error).toBe('invalid_grant');

    resourceAs.registerTrustedIdp(trustedIdp.issuer);
    const after = await requestAccessTokenWithIdJag(resourceAs.tokenEndpoint, {
      assertion
    });
    expect(after.statusCode).toBe(200);
  });
});

describe('MockResourceAuthorizationServer token introspection', () => {
  let trustedIdp: IdPAuthorizationServer | null = null;
  let resourceAs: MockResourceAuthorizationServer | null = null;

  afterEach(async () => {
    await resourceAs?.stop();
    await trustedIdp?.stop();
    resourceAs = null;
    trustedIdp = null;
  });

  async function boot(
    options: Parameters<typeof MockResourceAuthorizationServer.create>[0] = {}
  ) {
    trustedIdp = await IdPAuthorizationServer.create();
    await trustedIdp.start();
    resourceAs = await MockResourceAuthorizationServer.create({
      trustedIdpIssuers: [trustedIdp.issuer],
      ...options
    });
    await resourceAs.start();
    return { trustedIdp, resourceAs };
  }

  async function issueToken(
    trustedIdp: IdPAuthorizationServer,
    resourceAs: MockResourceAuthorizationServer,
    overrides: Record<string, unknown> = {}
  ): Promise<string> {
    const assertion = await trustedIdp.issueIdJag({
      subject: TEST_SUBJECT,
      audience: resourceAs.issuer,
      resource: MCP_RESOURCE,
      clientId: TEST_CLIENT_ID,
      scope: 'mcp.read',
      ...overrides
    });
    const response = await requestAccessTokenWithIdJag(
      resourceAs.tokenEndpoint,
      { assertion }
    );
    expect(response.statusCode).toBe(200);
    return response.body.access_token as string;
  }

  it('advertises the introspection endpoint in its metadata', async () => {
    const { resourceAs } = await boot();
    const metadata = resourceAs.getMetadata();
    expect(metadata.introspection_endpoint).toBe(
      resourceAs.introspectionEndpoint
    );
    expect(metadata.introspection_endpoint_auth_methods_supported).toContain(
      'client_secret_basic'
    );
  });

  it('reports an active access token with its claims', async () => {
    const { trustedIdp, resourceAs } = await boot();
    const token = await issueToken(trustedIdp, resourceAs);

    const response = await introspectToken(resourceAs.introspectionEndpoint, {
      token
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.active).toBe(true);
    expect(response.body.token_type).toBe('Bearer');
    expect(response.body.scope).toBe('mcp.read');
    expect(response.body.client_id).toBe(TEST_CLIENT_ID);
    expect(response.body.sub).toBe(TEST_SUBJECT);
    expect(response.body.aud).toBe(MCP_RESOURCE);
    expect(response.body.iss).toBe(resourceAs.issuer);
    expect(typeof response.body.exp).toBe('number');
    expect(typeof response.body.iat).toBe('number');
    expect(typeof response.body.jti).toBe('string');
  });

  it('reports active:false for an unknown or malformed token', async () => {
    const { resourceAs } = await boot();
    const response = await introspectToken(resourceAs.introspectionEndpoint, {
      token: 'not-a-token'
    });
    expect(response.statusCode).toBe(200);
    expect(response.body.active).toBe(false);
    expect(Object.keys(response.body)).toEqual(['active']);
  });

  it('reports active:false for a token signed by another key', async () => {
    const { trustedIdp, resourceAs } = await boot();
    // A token minted by a different Resource AS must not introspect as active.
    const other = await MockResourceAuthorizationServer.create({
      trustedIdpIssuers: [trustedIdp.issuer]
    });
    await other.start();
    try {
      const foreignToken = await issueToken(trustedIdp, other);
      const response = await introspectToken(resourceAs.introspectionEndpoint, {
        token: foreignToken
      });
      expect(response.body.active).toBe(false);
    } finally {
      await other.stop();
    }
  });

  it('reports active:false for an expired token', async () => {
    // A negative lifetime mints an already-expired access token; with zero clock
    // tolerance introspection must report it inactive.
    const { trustedIdp, resourceAs } = await boot({
      accessTokenLifetimeSeconds: -10,
      clockToleranceSeconds: 0
    });
    const token = await issueToken(trustedIdp, resourceAs);

    const response = await introspectToken(resourceAs.introspectionEndpoint, {
      token
    });
    expect(response.body.active).toBe(false);
  });

  it('includes the registered username for the token subject', async () => {
    const { trustedIdp, resourceAs } = await boot();
    const userId = resourceAs.registerUser('alice');
    const token = await issueToken(trustedIdp, resourceAs, { subject: userId });

    const response = await introspectToken(resourceAs.introspectionEndpoint, {
      token
    });
    expect(response.body.active).toBe(true);
    expect(response.body.sub).toBe(userId);
    expect(response.body.username).toBe('alice');
  });

  it('requires client authentication once a client is registered', async () => {
    const { trustedIdp, resourceAs } = await boot();
    const secret = resourceAs.registerClient(TEST_CLIENT_ID);
    const token = await issueTokenAuthed(trustedIdp, resourceAs, secret);

    const unauth = await introspectToken(resourceAs.introspectionEndpoint, {
      token
    });
    expect(unauth.statusCode).toBe(401);
    expect(unauth.body.error).toBe('invalid_client');

    const authed = await introspectToken(resourceAs.introspectionEndpoint, {
      token,
      clientId: TEST_CLIENT_ID,
      clientSecret: secret
    });
    expect(authed.statusCode).toBe(200);
    expect(authed.body.active).toBe(true);
  });

  async function issueTokenAuthed(
    trustedIdp: IdPAuthorizationServer,
    resourceAs: MockResourceAuthorizationServer,
    secret: string
  ): Promise<string> {
    const assertion = await trustedIdp.issueIdJag({
      subject: TEST_SUBJECT,
      audience: resourceAs.issuer,
      resource: MCP_RESOURCE,
      clientId: TEST_CLIENT_ID
    });
    const response = await requestAccessTokenWithIdJag(
      resourceAs.tokenEndpoint,
      { assertion, clientId: TEST_CLIENT_ID, clientSecret: secret }
    );
    expect(response.statusCode).toBe(200);
    return response.body.access_token as string;
  }

  it('returns invalid_request when the token parameter is missing', async () => {
    const { resourceAs } = await boot();
    const response = await introspectToken(resourceAs.introspectionEndpoint, {
      token: ''
    });
    expect(response.statusCode).toBe(400);
    expect(response.body.error).toBe('invalid_request');
  });
});
