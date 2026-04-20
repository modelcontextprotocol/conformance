# Contributing

Thanks for helping improve the MCP conformance suite!

The most valuable contributions are **new conformance scenarios** that cover under-tested parts of the [MCP spec](https://modelcontextprotocol.io/specification/). If you're not sure where to start, ask in `#conformance-testing-wg` on the MCP Contributors Discord.

## Before you start

**Open an issue first** — whether you've found a bug or want to propose a new scenario. A short discussion up front saves everyone time on PRs that overlap existing work or head in a direction we're not going.

Then read **[AGENTS.md](./AGENTS.md)** — it's the design guide for scenarios and checks. The short version:

- **Fewer scenarios, more checks.** Each scenario spins up its own server and runs in CI for every SDK. One scenario with 10 checks beats 10 scenarios with one check each.
- **Prove it passes and fails.** Extend the existing everything-client/server to pass your scenario, and show (or include) a failing case.
- **Reuse the CLI runner.** Don't add parallel entry points.

If you're using an AI agent to help, please **don't** point it at the repo with a generic "find bugs" prompt — give it a specific MUST from the spec or an open issue to work on. See AGENTS.md for details.

## Setup

```sh
npm install
npm run build
npm test
```

This repo uses **npm** — don't commit `pnpm-lock.yaml` or `yarn.lock`.

## Running your scenario

Run a client scenario against the bundled example client:

```sh
npm run build
node dist/index.js client --command "tsx examples/clients/typescript/everything-client.ts" --scenario <your-scenario>
```

Run a server scenario against any server running locally (replace 3000 with your server's port, if necessary):

```sh
# Against a server
node dist/index.js server --url http://localhost:3000/mcp --scenario <your-scenario>
```

Run a server scenario against the latest TypeScript SDK:

```sh
# In another directory, clone and prepare the SDK once
cd ..
git clone https://github.com/modelcontextprotocol/typescript-sdk.git
cd typescript-sdk
pnpm install
pnpm run build:all

# Start the SDK's conformance server in one terminal
cd test/conformance
PORT=3100 pnpm run test:conformance:server:run

# Back in this repo, run your local conformance build against it
cd /path/to/conformance
npm run build
node dist/index.js server --url http://localhost:3100/mcp --scenario <your-scenario>
```

See the [README](./README.md) for full CLI options and the [SDK Integration Guide](./SDK_INTEGRATION.md) for more on testing against a real SDK.

## Pull requests

- Register your scenario in the right suite in `src/scenarios/index.ts`
- Run against at least one real SDK (see above) before opening the PR — we'll ask what the output looked like
- Keep PRs focused; one feature or scenario group at a time
