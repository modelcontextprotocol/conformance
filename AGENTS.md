# AGENTS.md

Guidance for AI agents (and humans) contributing to the MCP conformance test framework.

## What this repo is

A test harness that exercises MCP SDK implementations against the protocol spec. The coverage number that matters here is **spec coverage** — how much of the protocol the scenarios test.

Uses **npm** (not pnpm/yarn). Don't commit `pnpm-lock.yaml` or `yarn.lock`.

## Where to start

**Open an issue first.** Before writing a scenario, open an issue describing which part of the spec you want to cover and roughly how. A quick discussion up front avoids wasted effort on scenarios that overlap existing work or don't fit the suite structure.

**Don't point an agent at the repo and ask it to "find bugs."** Generic bug-hunting on a test harness produces low-signal PRs (typo fixes, unused-variable cleanups, speculative refactors). If you want to contribute via an agent, give it a concrete target:

- Pick a specific MUST or SHOULD from the [MCP spec](https://modelcontextprotocol.io/specification/) that has no scenario yet, and ask the agent to draft one.
- Pick an [open issue](https://github.com/modelcontextprotocol/conformance/issues) and work on that.

The valuable contribution here is **spec coverage**, not harness polish.

## Scenario design: fewer scenarios, more checks

**The strongest rule in this repo:** prefer one scenario with many checks over many scenarios with one check each.

Why:

- Each scenario often spins up its own HTTP server. These suites run in CI on every push for every SDK, so per-scenario overhead multiplies fast.
- Less code to maintain and update when the spec shifts.
- Progress on making an SDK better shows up as "pass 7/10 checks" rather than "pass 1 test, fail another" — finer-grained signal from the same run.

### Granularity heuristic

Ask: **"Would it make sense for someone to implement a server/client that does just this scenario?"**

If two scenarios would always be implemented together, merge them. Examples:

- `tools/list` + a simple `tools/call` → one scenario
- All content-type variants (image, audio, mixed, resource) → one scenario
- Full OAuth flow with token refresh → one scenario, not separate "basic" + "refresh" scenarios. A client that passes "basic" but not "refresh" just shows up as passing N−2 checks.

Keep scenarios separate when they're genuinely independent features or when they're mutually exclusive (e.g., an SDK should support writing a server that _doesn't_ implement certain stateful features).

### When a PR adds scenarios

- Start with **one end-to-end scenario** covering the happy path with many checks along the way.
- Don't add "step 1 only" and "step 1+2" as separate scenarios — the second subsumes the first.
- Register the scenario in the appropriate suite list in `src/scenarios/index.ts` (`core`, `extensions`, `backcompat`, etc.).

## Check conventions

- **Same `id` for SUCCESS and FAIL.** A check should use one slug and flip `status` + `errorMessage`, not branch into `foo-success` vs `foo-failure` slugs.
- **Optimize for Ctrl+F on the slug.** Repetitive check blocks are fine — easier to find the failing one than to unwind a clever helper.
- Reuse `ConformanceCheck` and other types from `src/types.ts` rather than defining parallel shapes.
- Include `specReferences` pointing to the relevant spec section.

## Descriptions and wording

Be precise about what's **required** vs **optional**. A scenario description that tests optional behavior should make that clear — e.g. "Tests that a client _that wants a refresh token_ handles offline_access scope…" not "Tests that a client handles offline_access scope…". Don't accidentally promote a MAY/SHOULD to a MUST in the prose.

When in doubt about spec details (OAuth parameters, audiences, grant types), check the actual spec in `modelcontextprotocol` rather than guessing.

## Examples: prove it passes and fails

A new scenario should come with:

1. **A passing example** — usually by extending `examples/clients/typescript/everything-client.ts` or the everything-server, not a new file.
2. **Evidence it fails when it should** — ideally a negative example (a deliberately broken client), or at minimum a manual run showing the failure mode.

Delete unused example scenarios. If a scenario key in the everything-client has no corresponding test, remove it.

## Don't add new ways to run tests

Use the existing CLI runner (`npx @modelcontextprotocol/conformance client|server ...`). If you need a feature the runner doesn't have, add it to the runner rather than building a parallel entry point.

## Before opening a PR

- `npm run build` passes
- `npm test` passes
- For non-trivial scenario changes, run against at least one real SDK (typescript-sdk or python-sdk) to see actual output. For changes to shared infrastructure (runner, tier-check), test against go-sdk or csharp-sdk too.
- Scenario is registered in the right suite in `src/scenarios/index.ts`
