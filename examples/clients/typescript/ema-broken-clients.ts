/** Broken requests for the optional EMA refresh-token exchange profile. */
import { ClientConformanceContextSchema } from '../../../src/schemas/context.js';

export type EmaRefreshDefect =
  | 'ordinary-refresh'
  | 'wrong-subject-type'
  | 'unknown-refresh-token'
  | 'missing-idp-auth'
  | 'wrong-idp-auth'
  | 'wrong-audience'
  | 'wrong-resource'
  | 'scope-escalation'
  | 'unissued-mcp-token'
  | 'invalid-mcp-request'
  | 'stops-after-token';

export async function runEmaRefreshBrokenClient(
  serverUrl: string,
  defect: EmaRefreshDefect
): Promise<{ status: number; body: Record<string, unknown> }> {
  const ctx = ClientConformanceContextSchema.parse(
    JSON.parse(process.env.MCP_CONFORMANCE_CONTEXT ?? '{}')
  );
  if (ctx.name !== 'auth/enterprise-managed-authorization-refresh-token') {
    throw new Error(`Expected EMA refresh-token context, got ${ctx.name}`);
  }

  const prm = await (
    await fetch(new URL('/.well-known/oauth-protected-resource/mcp', serverUrl))
  ).json();
  const metadata = await (
    await fetch(
      new URL(
        '/.well-known/oauth-authorization-server',
        prm.authorization_servers[0]
      )
    )
  ).json();
  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    requested_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
    subject_token_type: 'urn:ietf:params:oauth:token-type:refresh_token',
    subject_token: ctx.idp_refresh_token,
    audience: metadata.issuer,
    resource: prm.resource,
    scope: 'test:read test:write'
  });
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Authorization: basicAuth(ctx.idp_client_id, ctx.idp_client_secret)
  };

  switch (defect) {
    case 'ordinary-refresh':
      params.set('grant_type', 'refresh_token');
      params.set('refresh_token', ctx.idp_refresh_token);
      params.delete('subject_token');
      break;
    case 'wrong-subject-type':
      params.set(
        'subject_token_type',
        'urn:ietf:params:oauth:token-type:id_token'
      );
      break;
    case 'unknown-refresh-token':
      params.set('subject_token', 'unknown-refresh-token');
      break;
    case 'missing-idp-auth':
      delete headers.Authorization;
      break;
    case 'wrong-idp-auth':
      headers.Authorization = basicAuth(ctx.idp_client_id, 'wrong-secret');
      break;
    case 'wrong-audience':
      params.set('audience', 'https://other.example');
      break;
    case 'wrong-resource':
      params.set('resource', 'https://other.example/mcp');
      break;
  }

  let response = await fetch(ctx.idp_token_endpoint, {
    method: 'POST',
    headers,
    body: params
  });
  let body: Record<string, unknown> = await response.json();
  if (
    defect === 'scope-escalation' ||
    defect === 'unissued-mcp-token' ||
    defect === 'invalid-mcp-request' ||
    defect === 'stops-after-token'
  ) {
    if (!response.ok || typeof body.access_token !== 'string') {
      throw new Error('Expected a valid ID-JAG before the AS exchange');
    }
    const grantParams = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: body.access_token
    });
    if (defect === 'scope-escalation') {
      grantParams.set('scope', 'test:read test:write');
    }
    response = await fetch(metadata.token_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: basicAuth(ctx.client_id, ctx.client_secret)
      },
      body: grantParams
    });
    body = await response.json();
  }
  if (defect === 'unissued-mcp-token' || defect === 'invalid-mcp-request') {
    if (!response.ok || typeof body.access_token !== 'string') {
      throw new Error(
        'Expected an issued access token before testing MCP access'
      );
    }
    response = await fetch(serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${defect === 'unissued-mcp-token' ? 'test-token-not-issued' : body.access_token}`
      },
      body: JSON.stringify(
        defect === 'invalid-mcp-request'
          ? {}
          : { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
      )
    });
    body = await response.json();
  }
  return { status: response.status, body };
}

function basicAuth(clientId: string, clientSecret: string): string {
  const encode = (value: string) =>
    new URLSearchParams([['', value]]).toString().slice(1);
  return `Basic ${Buffer.from(`${encode(clientId)}:${encode(clientSecret)}`).toString('base64')}`;
}
