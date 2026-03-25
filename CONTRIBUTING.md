# Contributing

Thanks for helping improve the MCP conformance suite!

The most valuable contributions are **new conformance scenarios** that cover under-tested parts of the [MCP spec](https://modelcontextprotocol.io/specification/). If you're not sure where to start, ask in `#conformance-testing-wg` on the MCP Contributors Discord.

## Before you start

**Open an issue first.** Describe which part of the spec you want to cover and roughly how — a short discussion up front saves everyone time on scenarios that overlap existing work or don't fit the suite structure.

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

```sh
# Against the bundled TypeScript example
npm run build
node dist/index.js client --command "tsx examples/clients/typescript/everything-client.ts" --scenario <your-scenario>

# Against a server
node dist/index.js server --url http://localhost:3000/mcp --scenario <your-scenario>
```

See the [README](./README.md) for full CLI options and the [SDK Integration Guide](./SDK_INTEGRATION.md) for testing against a real SDK.

## Pull requests

- Register your scenario in the right suite in `src/scenarios/index.ts`
- Run against at least one real SDK before opening the PR — we'll ask what the output looked like
- Keep PRs focused; one feature or scenario group at a time
