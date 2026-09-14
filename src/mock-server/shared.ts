import http from 'http';
import type { MockHandler, MockServer, RequestHandlers } from './index';

// What the stateful and stateless mock servers share, kept apart from
// ./stateful so the stateless one does not load the SDK server with it.

const CAPABILITY_BY_PREFIX: Record<string, string> = {
  tools: 'tools',
  prompts: 'prompts',
  resources: 'resources',
  completion: 'completions',
  logging: 'logging'
};

/**
 * Derive the server `capabilities` object from the registered handler method
 * names so the SDK's `assertRequestHandlerCapability` gate is always satisfied.
 * Shared with the stateless impl for `server/discover`.
 */
export function capabilitiesFromHandlers(
  handlers: RequestHandlers
): Record<string, object> {
  const out: Record<string, object> = {};
  for (const method of Object.keys(handlers)) {
    const cap = CAPABILITY_BY_PREFIX[method.split('/')[0]];
    if (cap) out[cap] = {};
  }
  return out;
}

/**
 * Bind a `MockHandler` to an ephemeral localhost port — the CLI runner's
 * path. Shared with the stateless impl.
 */
export function listenMockHandler(mock: MockHandler): Promise<MockServer> {
  return new Promise((resolve, reject) => {
    const httpServer = http.createServer(mock.listener);
    httpServer.on('error', reject);
    httpServer.listen(0, () => {
      const addr = httpServer.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const baseUrl = `http://localhost:${port}`;
      resolve({
        url: `${baseUrl}/mcp`,
        baseUrl,
        recorded: mock.recorded,
        close: () =>
          new Promise<void>((res) => {
            httpServer.closeAllConnections?.();
            httpServer.close(() => res());
          })
      });
    });
  });
}
