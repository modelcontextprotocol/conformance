import type { SdkConfig } from './config';

/**
 * Built-in conformance configs for official SDKs, keyed by repo name.
 *
 * These live here (not in the SDK repos) so adding an SDK to the matrix
 * doesn't require a coordinated cross-repo PR. An SDK can still ship a
 * conformance.config.yaml at its root to override these — see resolveConfig.
 */
export const KNOWN_SDKS: Record<string, SdkConfig> = {
  'typescript-sdk': {
    build: 'npm ci && npm run build',
    client: {
      command: 'npx tsx test/conformance/src/everythingClient.ts'
    },
    server: {
      command: 'npx tsx test/conformance/src/everythingServer.ts',
      url: 'http://localhost:3000/mcp'
    },
    expectedFailures: 'test/conformance/conformance-baseline.yml'
  },
  'go-sdk': {
    build: 'go build -o ./.conformance-server ./examples/server/conformance',
    // Upstream go-sdk has no client conformance fixture yet (see go-sdk#859).
    server: {
      command: './.conformance-server -http=:3000',
      url: 'http://localhost:3000'
    }
  }
};

/**
 * Look up a built-in config by SDK name. Accepts bare names (typescript-sdk),
 * owner/repo (modelcontextprotocol/typescript-sdk), or a checkout path
 * basename — only the final path segment is used as the key.
 */
export function lookupBuiltinConfig(name: string): SdkConfig | null {
  const key = name.split('/').pop() ?? name;
  return KNOWN_SDKS[key] ?? null;
}

export function knownSdkNames(): string[] {
  return Object.keys(KNOWN_SDKS);
}
