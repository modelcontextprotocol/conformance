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
  // Fixtures live under conformance/ (the server moved there from
  // examples/server/conformance); one build compiles both. Same fixtures and
  // baseline the go-sdk repo's own conformance CI uses.
  'go-sdk': {
    build:
      'go build -o ./.conformance-client ./conformance/everything-client && go build -o ./.conformance-server ./conformance/everything-server',
    client: {
      command: './.conformance-client'
    },
    server: {
      command: './.conformance-server -http=:3000',
      url: 'http://localhost:3000/mcp'
    },
    expectedFailures: 'conformance/baseline.yml'
  },
  // v1.x — the stable, published line of the python-sdk, analogous to
  // typescript-sdk-v1 (v2/main is mid-refactor and noisy). Clones the
  // python-sdk repo, defaulting to the `v1.x` branch, and targets the latest
  // dated spec so draft-only scenarios/checks are excluded by default. uv
  // workspace: the `mcp` (client) and `mcp-everything-server` (server) packages
  // are both members, so one `uv sync --all-packages` covers both modes.
  // Fixtures live in the python-sdk repo (.github/actions/conformance/ and
  // examples/servers/everything-server). `--port 3000` matches the url and the
  // 3000 convention used above; the server's own default is 3001.
  'python-sdk-v1': {
    repo: 'python-sdk',
    defaultRef: 'v1.x',
    specVersion: '2025-11-25',
    build: 'uv sync --frozen --all-extras --all-packages',
    client: {
      command: 'uv run --frozen python .github/actions/conformance/client.py'
    },
    server: {
      command: 'uv run --frozen mcp-everything-server --port 3000',
      url: 'http://localhost:3000/mcp'
    },
    expectedFailures: '.github/actions/conformance/expected-failures.yml'
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
