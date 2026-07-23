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
  // baseline the go-sdk repo's own conformance CI uses. The server entry runs
  // the fixture in its default stateless setting only; go-sdk's own
  // conformance CI runs it both ways (-stateless=false and -stateless).
  // Per-mode configs here are a follow-up.
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
  // Client fixture: tests/ModelContextProtocol.ConformanceClient. The fixture
  // takes the scenario as its first positional argument rather than reading
  // MCP_CONFORMANCE_SCENARIO, and the runner appends the server URL as the
  // last argument, so the command goes through `sh -c` to forward both
  // ("$1" is the appended URL). POSIX sh only — same constraint as the other
  // shell-based commands here. The csharp-sdk repo runs conformance
  // per-scenario via `dotnet test` and keeps no baseline file, so there is no
  // expectedFailures entry. Requires the .NET 10 SDK (global.json).
  'csharp-sdk': {
    build:
      'dotnet build tests/ModelContextProtocol.ConformanceClient/ModelContextProtocol.ConformanceClient.csproj -f net10.0 -c Release',
    client: {
      command: `sh -c 'exec ./artifacts/bin/ModelContextProtocol.ConformanceClient/Release/net10.0/ModelContextProtocol.ConformanceClient "$MCP_CONFORMANCE_SCENARIO" "$1"' conformance-client`
    }
  },
  // main — the development line, targeting the draft spec (analogous to the
  // bare typescript-sdk entry). Same fixture layout as python-sdk-v1: the
  // conformance client and the everything-server are uv workspace members, so
  // one `uv sync --all-packages` covers both modes. Matches the repo's own
  // conformance CI (.github/workflows/conformance.yml), including its
  // expected-failures baseline.
  'python-sdk': {
    build: 'uv sync --frozen --all-extras --all-packages',
    client: {
      command: '.venv/bin/python .github/actions/conformance/client.py'
    },
    server: {
      command: 'uv run --frozen mcp-everything-server --port 3000',
      url: 'http://localhost:3000/mcp'
    },
    expectedFailures: '.github/actions/conformance/expected-failures.yml'
  },
  // v1.x — the stable, published line of the python-sdk, analogous to
  // typescript-sdk-v1. Clones the
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
