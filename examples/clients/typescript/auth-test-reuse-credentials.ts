/**
 * Negative client for SEP-2352: uses a single provider with no issuer keying,
 * so when PRM authorization_servers changes it presents the previous AS's
 * client_id at the new AS. Expected to trigger
 * sep-2352-no-reuse-on-as-change / sep-2352-reregister-on-as-change FAILURE.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { withOAuthRetry, handle401 } from './helpers/withOAuthRetry';
import { runAsCli } from './helpers/cliRunner';

export async function runClient(serverUrl: string): Promise<void> {
  const oauthFetch = withOAuthRetry(
    'auth-test-reuse-credentials',
    new URL(serverUrl),
    handle401
  )(fetch);
  const client = new Client(
    { name: 'auth-test-reuse-credentials', version: '1.0.0' },
    { capabilities: {} }
  );
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    fetch: oauthFetch
  });
  await client.connect(transport);
  await client.listTools();
  await client.callTool({ name: 'test-tool', arguments: {} });
  await transport.close();
}

runAsCli(
  runClient,
  import.meta.url,
  'auth-test-reuse-credentials <server-url>'
);
