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
  // Fixtures live under conformance/ (everything-client + everything-server,
  // mirroring scripts/{client,server}-conformance.sh). The server's -stateless
  // flag defaults to true; the dated-spec (`active` suite) scenarios need the
  // stateful transport, so the base command pins -stateless=false and the
  // 2026-07-28 override drops it for the SEP-2575 stateless lifecycle.
  'go-sdk': {
    build:
      'go build -o ./.conformance-server ./conformance/everything-server && go build -o ./.conformance-client ./conformance/everything-client',
    client: {
      command: './.conformance-client'
    },
    server: {
      command: './.conformance-server -http=localhost:3000 -stateless=false',
      url: 'http://localhost:3000'
    },
    expectedFailures: 'conformance/baseline.yml',
    specOverrides: {
      '2026-07-28': {
        server: { command: './.conformance-server -http=localhost:3000' }
      }
    }
  },
  // main — targets the 2026-07-28 revision. Same uv workspace layout as v1.x
  // (client fixture in .github/actions/conformance/, mcp-everything-server
  // workspace package). Two baselines exist upstream, one per spec target;
  // the 2026-07-28 override picks the matching one.
  'python-sdk': {
    build: 'uv sync --frozen --all-extras --all-packages',
    client: {
      command: 'uv run --frozen python .github/actions/conformance/client.py'
    },
    server: {
      command: 'uv run --frozen mcp-everything-server --port 3000',
      url: 'http://localhost:3000/mcp'
    },
    expectedFailures: '.github/actions/conformance/expected-failures.yml',
    specOverrides: {
      '2026-07-28': {
        expectedFailures:
          '.github/actions/conformance/expected-failures.2026-07-28.yml'
      }
    }
  },
  // v1.x — the stable, published line of the python-sdk, analogous to
  // typescript-sdk-v1. Clones the python-sdk repo, defaulting to the `v1.x`
  // branch, and targets the latest
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
  },
  // Fixtures live in conformance/ (the mcp-conformance package's
  // conformance-client + conformance-server bins; the package is excluded from
  // the workspace default-members, so build it explicitly). The server reads
  // PORT and STATELESS from the environment: the stateful (dated-spec)
  // lifecycle is the default, and the 2026-07-28 override sets STATELESS=1
  // for the SEP-2575 stateless lifecycle.
  'rust-sdk': {
    build: 'cargo build -p mcp-conformance',
    client: {
      command: './target/debug/conformance-client'
    },
    server: {
      command: 'PORT=3000 ./target/debug/conformance-server',
      url: 'http://localhost:3000/mcp'
    },
    specOverrides: {
      '2026-07-28': {
        server: {
          command: 'STATELESS=1 PORT=3000 ./target/debug/conformance-server'
        }
      }
    }
  },
  // Fixtures live in Sources/MCPConformance/{Client,Server} — the
  // mcp-everything-client and mcp-everything-server products, mirroring
  // scripts/run-conformance.sh. SwiftPM writes binaries to a per-triple
  // directory but also maintains a `.build/debug` symlink pointing at it, so
  // the paths below stay portable across host architectures. The server
  // defaults to port 3001; `--port` pins it to the 3000 convention used above.
  'swift-sdk': {
    build:
      'swift build --product mcp-everything-client && swift build --product mcp-everything-server',
    client: {
      command: './.build/debug/mcp-everything-client'
    },
    server: {
      command: './.build/debug/mcp-everything-server --port 3000',
      url: 'http://localhost:3000/mcp'
    },
    expectedFailures: 'conformance-baseline.yml'
  },
  // Fixtures live in tests/ModelContextProtocol.ConformanceClient and
  // tests/ModelContextProtocol.ConformanceServer (requires the .NET 10 SDK,
  // per global.json); build output goes to the repo-level artifacts/ tree
  // (UseArtifactsOutput), not per-project bin/. The client binary takes the scenario as its first
  // argument rather than reading MCP_CONFORMANCE_SCENARIO, so the command
  // bridges the env var into argv ($1 is the server URL the harness appends).
  // The server serves the stateful lifecycle at / and the SEP-2575 stateless
  // lifecycle at /stateless from the same port; the 2026-07-28 override
  // points runs at the stateless endpoint.
  'csharp-sdk': {
    build:
      'dotnet build tests/ModelContextProtocol.ConformanceClient -c Release -f net10.0 && dotnet build tests/ModelContextProtocol.ConformanceServer -c Release -f net10.0',
    client: {
      command: `bash -c 'exec dotnet artifacts/bin/ModelContextProtocol.ConformanceClient/Release/net10.0/ModelContextProtocol.ConformanceClient.dll "$MCP_CONFORMANCE_SCENARIO" "$1"' conformance-client`
    },
    server: {
      command:
        'dotnet artifacts/bin/ModelContextProtocol.ConformanceServer/Release/net10.0/ModelContextProtocol.ConformanceServer.dll --urls http://localhost:3000',
      url: 'http://localhost:3000'
    },
    specOverrides: {
      '2026-07-28': {
        server: { url: 'http://localhost:3000/stateless' }
      }
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
