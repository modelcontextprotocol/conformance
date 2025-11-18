import { authScenariosList } from './index.js';
import {
  runClientAgainstScenario,
  InlineClientRunner
} from './test_helpers/testClient.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  auth,
  extractWWWAuthenticateParams,
  UnauthorizedError
} from '@modelcontextprotocol/sdk/client/auth.js';
import { withOAuthRetry } from '../../../../examples/clients/typescript/helpers/withOAuthRetry.js';
import { ConformanceOAuthProvider } from '../../../../examples/clients/typescript/helpers/ConformanceOAuthProvider.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

// Well-behaved client that follows all auth protocols correctly
const goodClient = async (serverUrl: string) => {
  const client = new Client(
    { name: 'test-auth-client', version: '1.0.0' },
    { capabilities: {} }
  );

  const oauthFetch = withOAuthRetry(
    'test-auth-client',
    new URL(serverUrl)
  )(fetch);

  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    fetch: oauthFetch
  });

  await client.connect(transport);
  await client.listTools();
  await client.callTool({ name: 'test-tool', arguments: {} });
  await transport.close();
};

describe('Client Auth Scenarios', () => {
  // Generate individual test for each auth scenario
  for (const scenario of authScenariosList) {
    test(`${scenario.name} passes`, async () => {
      const runner = new InlineClientRunner(goodClient);
      await runClientAgainstScenario(runner, scenario.name);
    });
  }
});

describe('Negative tests', () => {
  test('bad client requests root PRM location', async () => {
    const brokenClient = async (serverUrl: string) => {
      const handle401Broken = async (
        response: Response,
        provider: ConformanceOAuthProvider,
        next: FetchLike,
        serverUrl: string | URL
      ): Promise<void> => {
        // BUG: Use root-based PRM discovery exclusively
        const resourceMetadataUrl = new URL(
          '/.well-known/oauth-protected-resource',
          typeof serverUrl === 'string' ? serverUrl : serverUrl.origin
        );

        let result = await auth(provider, {
          serverUrl,
          resourceMetadataUrl,
          fetchFn: next
        });

        if (result === 'REDIRECT') {
          const authorizationCode = await provider.getAuthCode();
          result = await auth(provider, {
            serverUrl,
            resourceMetadataUrl,
            authorizationCode,
            fetchFn: next
          });
          if (result !== 'AUTHORIZED') {
            throw new UnauthorizedError(
              `Authentication failed with result: ${result}`
            );
          }
        }
      };

      const client = new Client(
        { name: 'test-auth-client-broken', version: '1.0.0' },
        { capabilities: {} }
      );

      const oauthFetch = withOAuthRetry(
        'test-auth-client-broken',
        new URL(serverUrl),
        handle401Broken
      )(fetch);

      const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
        fetch: oauthFetch
      });

      await client.connect(transport);
      await client.listTools();
      await transport.close();
    };

    const runner = new InlineClientRunner(brokenClient);
    await runClientAgainstScenario(runner, 'auth/basic-dcr', [
      'prm-priority-order'
    ]);
  });

  test('client ignores scope from WWW-Authenticate header', async () => {
    const brokenClient = async (serverUrl: string) => {
      const handle401Broken = async (
        response: Response,
        provider: ConformanceOAuthProvider,
        next: FetchLike,
        serverUrl: string | URL
      ): Promise<void> => {
        // BUG: Don't read the scope from the header
        const { resourceMetadataUrl } = extractWWWAuthenticateParams(response);
        let result = await auth(provider, {
          serverUrl,
          resourceMetadataUrl,
          // scope deliberately omitted
          fetchFn: next
        });

        if (result === 'REDIRECT') {
          const authorizationCode = await provider.getAuthCode();
          result = await auth(provider, {
            serverUrl,
            resourceMetadataUrl,
            authorizationCode,
            fetchFn: next
          });
          if (result !== 'AUTHORIZED') {
            throw new UnauthorizedError(
              `Authentication failed with result: ${result}`
            );
          }
        }
      };

      const client = new Client(
        { name: 'test-auth-client-broken', version: '1.0.0' },
        { capabilities: {} }
      );

      const oauthFetch = withOAuthRetry(
        'test-auth-client-broken',
        new URL(serverUrl),
        handle401Broken
      )(fetch);

      const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
        fetch: oauthFetch
      });

      await client.connect(transport);
      await client.listTools();
      await transport.close();
    };

    const runner = new InlineClientRunner(brokenClient);
    await runClientAgainstScenario(runner, 'auth/scope-from-www-authenticate', [
      'scope-from-www-authenticate'
    ]);
  });

  test('client only requests subset of scopes_supported', async () => {
    const brokenClient = async (serverUrl: string) => {
      const handle401Broken = async (
        response: Response,
        provider: ConformanceOAuthProvider,
        next: FetchLike,
        serverUrl: string | URL
      ): Promise<void> => {
        const { resourceMetadataUrl } = extractWWWAuthenticateParams(response);
        // BUG: Only request one scope instead of all from scopes_supported
        let result = await auth(provider, {
          serverUrl,
          resourceMetadataUrl,
          scope: 'mcp:basic',
          fetchFn: next
        });

        if (result === 'REDIRECT') {
          const authorizationCode = await provider.getAuthCode();
          result = await auth(provider, {
            serverUrl,
            resourceMetadataUrl,
            scope: 'mcp:basic',
            authorizationCode,
            fetchFn: next
          });
          if (result !== 'AUTHORIZED') {
            throw new UnauthorizedError(
              `Authentication failed with result: ${result}`
            );
          }
        }
      };

      const client = new Client(
        { name: 'test-auth-client-broken', version: '1.0.0' },
        { capabilities: {} }
      );

      const oauthFetch = withOAuthRetry(
        'test-auth-client-broken',
        new URL(serverUrl),
        handle401Broken
      )(fetch);

      const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
        fetch: oauthFetch
      });

      await client.connect(transport);
      await client.listTools();
      await transport.close();
    };

    const runner = new InlineClientRunner(brokenClient);
    await runClientAgainstScenario(runner, 'auth/scope-from-scopes-supported', [
      'scope-from-scopes-supported'
    ]);
  });

  test('client requests scope even if scopes_supported is empty', async () => {
    const brokenClient = async (serverUrl: string) => {
      const handle401Broken = async (
        response: Response,
        provider: ConformanceOAuthProvider,
        next: FetchLike,
        serverUrl: string | URL
      ): Promise<void> => {
        const { resourceMetadataUrl } = extractWWWAuthenticateParams(response);
        // BUG: Request scope even when scopes_supported is undefined
        let result = await auth(provider, {
          serverUrl,
          resourceMetadataUrl,
          scope: 'mcp:basic',
          fetchFn: next
        });

        if (result === 'REDIRECT') {
          const authorizationCode = await provider.getAuthCode();
          result = await auth(provider, {
            serverUrl,
            resourceMetadataUrl,
            scope: 'mcp:basic',
            authorizationCode,
            fetchFn: next
          });
          if (result !== 'AUTHORIZED') {
            throw new UnauthorizedError(
              `Authentication failed with result: ${result}`
            );
          }
        }
      };

      const client = new Client(
        { name: 'test-auth-client-broken', version: '1.0.0' },
        { capabilities: {} }
      );

      const oauthFetch = withOAuthRetry(
        'test-auth-client-broken',
        new URL(serverUrl),
        handle401Broken
      )(fetch);

      const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
        fetch: oauthFetch
      });

      await client.connect(transport);
      await client.listTools();
      await transport.close();
    };

    const runner = new InlineClientRunner(brokenClient);
    await runClientAgainstScenario(
      runner,
      'auth/scope-omitted-when-undefined',
      ['scope-omitted-when-undefined']
    );
  });

  test('client only responds to 401, not 403', async () => {
    const brokenClient = async (serverUrl: string) => {
      const handle401Broken = async (
        response: Response,
        provider: ConformanceOAuthProvider,
        next: FetchLike,
        serverUrl: string | URL
      ): Promise<void> => {
        // BUG: Only respond to 401, not 403
        if (response.status !== 401) {
          return;
        }

        const { resourceMetadataUrl, scope } =
          extractWWWAuthenticateParams(response);
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
          if (result !== 'AUTHORIZED') {
            throw new UnauthorizedError(
              `Authentication failed with result: ${result}`
            );
          }
        }
      };

      const client = new Client(
        { name: 'test-auth-client-broken', version: '1.0.0' },
        { capabilities: {} }
      );

      const oauthFetch = withOAuthRetry(
        'test-auth-client-broken',
        new URL(serverUrl),
        handle401Broken
      )(fetch);

      const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
        fetch: oauthFetch
      });

      await client.connect(transport);
      await client.listTools();
      // Call tool to trigger step-up auth
      await client.callTool({ name: 'test-tool', arguments: {} });
      await transport.close();
    };

    const runner = new InlineClientRunner(brokenClient);
    await runClientAgainstScenario(runner, 'auth/scope-step-up', [
      'scope-step-up-escalation'
    ]);
  });
});
