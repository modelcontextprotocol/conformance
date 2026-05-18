/**
 * Negative client for SEP-2350: on a step-up 403, re-authorizes with ONLY the
 * scope from the challenge (does not accumulate previously-granted scopes).
 * Expected to trigger sep-2350-scope-union-on-reauth = WARNING.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  auth,
  extractWWWAuthenticateParams
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { withOAuthRetry } from './helpers/withOAuthRetry';
import { ConformanceOAuthProvider } from './helpers/ConformanceOAuthProvider';
import { runAsCli } from './helpers/cliRunner';

// handle401 variant that ECHOES the challenge scope verbatim (no SEP-2350 union).
const handle401EchoScope = async (
  response: Response,
  provider: ConformanceOAuthProvider,
  next: FetchLike,
  serverUrl: string | URL
): Promise<void> => {
  const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
  let result = await auth(provider, {
    serverUrl,
    resourceMetadataUrl,
    scope,
    fetchFn: next
  });
  if (result === 'REDIRECT') {
    const authorizationCode = await provider.getAuthCode();
    result = await auth(provider, {
      serverUrl,
      resourceMetadataUrl,
      scope,
      authorizationCode,
      fetchFn: next
    });
  }
};

export async function runClient(serverUrl: string): Promise<void> {
  const client = new Client(
    { name: 'auth-test-echo-scope', version: '1.0.0' },
    { capabilities: {} }
  );
  const oauthFetch = withOAuthRetry(
    'auth-test-echo-scope',
    new URL(serverUrl),
    handle401EchoScope
  )(fetch);
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    fetch: oauthFetch
  });
  await client.connect(transport);
  await client.listTools();
  await client.callTool({ name: 'test-tool', arguments: {} });
  await transport.close();
}

runAsCli(runClient, import.meta.url, 'auth-test-echo-scope <server-url>');
