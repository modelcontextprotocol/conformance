import type { SdkConfig } from './config';

/**
 * Built-in conformance configs for official SDKs, keyed by repo name.
 *
 * These live here (not in the SDK repos) so adding an SDK to the matrix
 * doesn't require a coordinated cross-repo PR. Any field can be overridden
 * per-invocation via the CLI flags (--build-cmd / --client-cmd / etc.).
 */
export const KNOWN_SDKS: Record<string, SdkConfig> = {
  // v2 — the monorepo on `main` (pnpm). Default ref is `main`.
  'typescript-sdk': {
    build: 'pnpm install && pnpm run build:all',
    client: {
      command: 'npx tsx test/conformance/src/everythingClient.ts'
    },
    server: {
      command: 'npx tsx test/conformance/src/everythingServer.ts',
      url: 'http://localhost:3000/mcp'
    },
    expectedFailures: 'test/conformance/expected-failures.yaml'
  },
  // v1.x — the published npm line. Same fixtures as v2; differs only in the
  // build (npm, not pnpm) and the baseline filename. Clones the typescript-sdk
  // repo, defaulting to the `v1.x` branch. Targets the latest dated spec, so
  // draft-only scenarios and checks are excluded by default.
  'typescript-sdk-v1': {
    repo: 'typescript-sdk',
    defaultRef: 'v1.x',
    specVersion: '2025-11-25',
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
