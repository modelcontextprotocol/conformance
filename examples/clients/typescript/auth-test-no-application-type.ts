/**
 * Negative client for SEP-837: registers via DCR WITHOUT application_type.
 * Expected to trigger sep-837-application-type-present = FAILURE.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  withOAuthRetryWithProvider,
  handle401
} from './helpers/withOAuthRetry';
import { ConformanceOAuthProvider } from './helpers/ConformanceOAuthProvider';
import { runAsCli } from './helpers/cliRunner';

export async function runClient(serverUrl: string): Promise<void> {
  const provider = new ConformanceOAuthProvider(
    'http://localhost:3000/callback',
    {
      client_name: 'auth-test-no-application-type',
      redirect_uris: ['http://localhost:3000/callback']
      // application_type intentionally omitted
    }
  );
  const oauthFetch = withOAuthRetryWithProvider(
    provider,
    new URL(serverUrl),
    handle401
  )(fetch);
  const client = new Client(
    { name: 'auth-test-no-application-type', version: '1.0.0' },
    { capabilities: {} }
  );
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    fetch: oauthFetch
  });
  await client.connect(transport);
  await client.listTools();
  await transport.close();
}

runAsCli(
  runClient,
  import.meta.url,
  'auth-test-no-application-type <server-url>'
);
