#!/usr/bin/env node

/**
 * Broken WIF client implementations for negative conformance tests.
 *
 * Each class/runner exercises a specific non-compliant behaviour.
 * WifJwtBearerProvider (the well-behaved client) lives in everything-client.ts.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  JWT_BEARER_GRANT_TYPE,
  WIF_TRIGGER_UNAUTHORIZED_SCOPE,
  WIF_REJECTED_SCOPE
} from '../../../src/scenarios/client/auth/helpers/createWorkloadJwt.js';
import { ClientConformanceContextSchema } from '../../../src/schemas/context.js';

function parseWifContext() {
  const raw = process.env.MCP_CONFORMANCE_CONTEXT;
  if (!raw) throw new Error('MCP_CONFORMANCE_CONTEXT not set');
  const ctx = ClientConformanceContextSchema.parse(JSON.parse(raw));
  if (ctx.name !== 'auth/wif-jwt-bearer') {
    throw new Error(`Expected wif-jwt-bearer context, got ${ctx.name}`);
  }
  return ctx;
}

// Base class with OAuthClientProvider boilerplate shared across all broken variants.
abstract class WifProviderBase implements OAuthClientProvider {
  private _tokens?: OAuthTokens;
  protected _clientInfo: OAuthClientInformation;
  protected readonly _clientMetadata: OAuthClientMetadata;

  constructor(clientId: string, clientName: string) {
    this._clientInfo = { client_id: clientId };
    this._clientMetadata = {
      client_name: clientName,
      redirect_uris: [],
      grant_types: [JWT_BEARER_GRANT_TYPE],
      token_endpoint_auth_method: 'none'
    };
  }

  get redirectUrl(): undefined {
    return undefined;
  }

  get clientMetadata(): OAuthClientMetadata {
    return this._clientMetadata;
  }

  clientInformation(): OAuthClientInformation {
    return this._clientInfo;
  }

  saveClientInformation(info: OAuthClientInformation): void {
    this._clientInfo = info;
  }

  tokens(): OAuthTokens | undefined {
    return this._tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this._tokens = tokens;
  }

  redirectToAuthorization(): void {
    throw new Error('redirectToAuthorization is not used for JWT-bearer flow');
  }

  saveCodeVerifier(): void {}

  codeVerifier(): string {
    throw new Error('codeVerifier is not used for JWT-bearer flow');
  }

  abstract prepareTokenRequest(_scope?: string): URLSearchParams;
}

async function runWifBrokenClient(
  serverUrl: string,
  provider: WifProviderBase,
  clientName: string
): Promise<void> {
  const client = new Client(
    { name: clientName, version: '1.0.0' },
    { capabilities: {} }
  );
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    authProvider: provider
  });
  await client.connect(transport);
  await client.listTools();
  await transport.close();
}

// ---------------------------------------------------------------------------
// Wrong audience
// ---------------------------------------------------------------------------

// BUG: presents a JWT whose aud does not match the AS
class WifWrongAudienceProvider extends WifProviderBase {
  constructor(
    private readonly assertion: string,
    clientId: string
  ) {
    super(clientId, 'conformance-wif-wrong-audience');
  }

  prepareTokenRequest(_scope?: string): URLSearchParams {
    const params = new URLSearchParams({ grant_type: JWT_BEARER_GRANT_TYPE });
    params.set('assertion', this.assertion);
    return params;
  }
}

export async function runWifJwtBearerWrongAudience(
  serverUrl: string
): Promise<void> {
  const ctx = parseWifContext();
  await runWifBrokenClient(
    serverUrl,
    new WifWrongAudienceProvider(ctx.wrong_audience_jwt, ctx.client_id),
    'conformance-wif-wrong-audience'
  );
}

// ---------------------------------------------------------------------------
// Missing assertion
// ---------------------------------------------------------------------------

// BUG: omits the assertion parameter entirely
class WifMissingAssertionProvider extends WifProviderBase {
  constructor(clientId: string) {
    super(clientId, 'conformance-wif-no-assertion');
  }

  prepareTokenRequest(_scope?: string): URLSearchParams {
    return new URLSearchParams({ grant_type: JWT_BEARER_GRANT_TYPE });
  }
}

export async function runWifJwtBearerMissingAssertion(
  serverUrl: string
): Promise<void> {
  const ctx = parseWifContext();
  await runWifBrokenClient(
    serverUrl,
    new WifMissingAssertionProvider(ctx.client_id),
    'conformance-wif-no-assertion'
  );
}

// ---------------------------------------------------------------------------
// Expired assertion
// ---------------------------------------------------------------------------

// BUG: presents a JWT whose exp has already passed
class WifExpiredAssertionProvider extends WifProviderBase {
  constructor(
    private readonly assertion: string,
    clientId: string
  ) {
    super(clientId, 'conformance-wif-expired-assertion');
  }

  prepareTokenRequest(_scope?: string): URLSearchParams {
    const params = new URLSearchParams({ grant_type: JWT_BEARER_GRANT_TYPE });
    params.set('assertion', this.assertion);
    return params;
  }
}

export async function runWifJwtBearerExpiredAssertion(
  serverUrl: string
): Promise<void> {
  const ctx = parseWifContext();
  await runWifBrokenClient(
    serverUrl,
    new WifExpiredAssertionProvider(ctx.expired_jwt, ctx.client_id),
    'conformance-wif-expired-assertion'
  );
}

// ---------------------------------------------------------------------------
// Scope rejected
// ---------------------------------------------------------------------------

// BUG: requests a scope the AS does not permit for JWT-bearer grant
class WifScopeRejectedProvider extends WifProviderBase {
  constructor(
    private readonly assertion: string,
    clientId: string
  ) {
    super(clientId, 'conformance-wif-scope-rejected');
  }

  prepareTokenRequest(_scope?: string): URLSearchParams {
    const params = new URLSearchParams({ grant_type: JWT_BEARER_GRANT_TYPE });
    params.set('assertion', this.assertion);
    params.set('scope', WIF_REJECTED_SCOPE);
    return params;
  }
}

export async function runWifJwtBearerScopeRejected(
  serverUrl: string
): Promise<void> {
  const ctx = parseWifContext();
  await runWifBrokenClient(
    serverUrl,
    new WifScopeRejectedProvider(ctx.valid_jwt, ctx.client_id),
    'conformance-wif-scope-rejected'
  );
}

// ---------------------------------------------------------------------------
// Grant fallback
// ---------------------------------------------------------------------------

// BUG: falls back to authorization_code after receiving unauthorized_client
class WifGrantFallbackProvider extends WifProviderBase {
  private attemptCount = 0;

  constructor(
    private readonly assertion: string,
    clientId: string
  ) {
    super(clientId, 'conformance-wif-grant-fallback');
  }

  prepareTokenRequest(_scope?: string): URLSearchParams {
    this.attemptCount++;
    if (this.attemptCount === 1) {
      const params = new URLSearchParams({ grant_type: JWT_BEARER_GRANT_TYPE });
      params.set('assertion', this.assertion);
      params.set('scope', WIF_TRIGGER_UNAUTHORIZED_SCOPE);
      return params;
    }
    // BUG: switches to authorization_code instead of surfacing the error
    return new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'fake-fallback-code'
    });
  }
}

export async function runWifJwtBearerGrantFallback(
  serverUrl: string
): Promise<void> {
  const ctx = parseWifContext();
  await runWifBrokenClient(
    serverUrl,
    new WifGrantFallbackProvider(ctx.valid_jwt, ctx.client_id),
    'conformance-wif-grant-fallback'
  );
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

// BUG: retries JWT-bearer after receiving unauthorized_client.
// Deliberately omits a hasAttempted guard so the SDK retry reaches the AS
// and the wif-no-retry check fires.
class WifRetryProvider extends WifProviderBase {
  private attemptCount = 0;

  constructor(
    private readonly assertion: string,
    clientId: string
  ) {
    super(clientId, 'conformance-wif-retry');
  }

  prepareTokenRequest(_scope?: string): URLSearchParams {
    this.attemptCount++;
    const params = new URLSearchParams({ grant_type: JWT_BEARER_GRANT_TYPE });
    params.set('assertion', this.assertion);
    if (this.attemptCount === 1) {
      params.set('scope', WIF_TRIGGER_UNAUTHORIZED_SCOPE);
    }
    // BUG: retries JWT-bearer instead of surfacing the error
    return params;
  }
}

export async function runWifJwtBearerRetry(serverUrl: string): Promise<void> {
  const ctx = parseWifContext();
  await runWifBrokenClient(
    serverUrl,
    new WifRetryProvider(ctx.valid_jwt, ctx.client_id),
    'conformance-wif-retry'
  );
}
