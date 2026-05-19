# AGENTS.md

Guidance for AI agents (and humans) contributing to the MCP conformance test framework.

## What this repo is

A test harness that exercises MCP SDK implementations against the protocol spec. The coverage number that matters here is **spec coverage** — how much of the protocol the scenarios test.

Uses **npm** (not pnpm/yarn). Don't commit `pnpm-lock.yaml` or `yarn.lock`.

## Where to start

**Open an issue first** — whether you've hit a bug in the harness or want to propose a new scenario. For scenarios, sketch which part of the spec you want to cover and roughly how; for bugs, include the command you ran and the output. Either way, a short discussion up front beats review churn on a PR that overlaps existing work or heads in a direction we're not going.

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
- **Don't reimplement the runner.** New subcommands that need to "select scenarios → run them → print summary → compute exit code" must go through the existing `client` / `server` commands (subprocess via `process.execPath` like `tier-check` and `sdk` do) or call shared helpers — never a parallel suite-map / summary loop.
- Include `specReferences` pointing to the relevant spec section.
- **Severity follows the spec keyword:** MUST / MUST NOT → `FAILURE`; SHOULD / SHOULD NOT → `WARNING`. (CI treats WARNING as a failure, so Tier-1 SDKs still need to satisfy SHOULDs — see #245.)

## Descriptions and wording

Be precise about what's **required** vs **optional**. A scenario description that tests optional behavior should make that clear — e.g. "Tests that a client _that wants a refresh token_ handles offline_access scope…" not "Tests that a client handles offline_access scope…". Don't accidentally promote a MAY/SHOULD to a MUST in the prose.

When in doubt about spec details (OAuth parameters, audiences, grant types), check the actual spec in `modelcontextprotocol` rather than guessing.

## Reviewing PRs

### SEP scenarios

Verify requirement levels against the SEP's **spec diff** — the change to `docs/specification/draft/` in the SEP's PR — not the SEP markdown summary or the conformance PR's description. The keyword that governs check severity is the one in the spec text; a bullet under a "Servers SHOULD…" sentence is SHOULD-level even if the SEP's title says "standardize."

```sh
gh api "repos/modelcontextprotocol/modelcontextprotocol/contents/docs/specification/draft/<path>?ref=<sep-branch>" --jq '.content' | base64 -d
```

### Adding a new SEP

Scaffold the requirement-traceability YAML with:

```sh
npx @modelcontextprotocol/conformance new-sep <NNNN>
```

The command looks up PR #`<NNNN>` in `modelcontextprotocol/modelcontextprotocol` (SEP numbers are PR numbers), derives `spec_url` from the `docs/specification/draft/*.mdx` file it changes, and writes `src/seps/sep-<NNNN>.yaml` with TODO `requirements[]` rows. Use `--spec-path` or `--spec-url` to skip the lookup. The `new-sep` Claude Code skill drives the same flow end-to-end, parses the spec diff, and fills in the requirement rows.

### Traceability manifest

`src/seps/traceability.json` is a generated map of, per SEP, which declared `check:` IDs are actually emitted when the conformance suite runs against the reference SDK. It is consumed by plan.modelcontextprotocol.io to track SEP-2484 progress.

The emitted check IDs come from a real suite run (not a source scan), so dynamic (template-literal) IDs resolve to their concrete values. Generate the manifest from a results directory:

```sh
# 1. Run the suite against the reference SDK, collecting checks.json files:
node dist/index.js client --command '<sdk conformance client>' --suite all -o results
node dist/index.js server --url '<sdk conformance server url>' --suite all -o results
# 2. Build the manifest from those results:
npm run traceability -- --results results
npm run traceability -- --results results --strict   # exit 1 on any untested (advisory)
```

Manifest shape: `{ schemaVersion, docs, source, seps }`, where `seps` is keyed by SEP number. Each requirement is `tested` (its check ID was emitted) or `untested` (declared but never emitted — a real gap, or a check that only fires against a deliberately-broken impl, i.e. it needs a negative test). `"tested" means a scenario emitted the check ID, NOT that any SDK passes it` — per-SDK results live in `tier-check`. Matching is exact, so a scenario's emitted check IDs must match the requirement slugs in the yaml (one check ID per MUST/SHOULD, emitted once per case). `source` records what was run against (e.g. `typescript-sdk@<sha>`); the `docs` field points back here.

Contract for consumers (plan.mcp.io): a SEP appears only if it has a traceability yaml or emits `sep-NNNN-*` check IDs. **A SEP absent from the manifest has no conformance artifacts — treat it as not-started** (diff against your own SEP list to find them). `untracked` lists emitted IDs with no yaml row (usually scenario gates).

The manifest is refreshed by `.github/workflows/traceability.yml` (manual/scheduled), which runs the suite against typescript-sdk and opens a PR with the diff — it is **not** a PR gate. Untested checks are advisory for now; the intended future policy is that an untested check must be backed by a negative test.

## Examples: prove it passes and fails

A new scenario should come with:

1. **A passing example** — usually by extending `examples/clients/typescript/everything-client.ts` or the everything-server, not a new file.
2. **A negative test** — a deliberately-broken implementation in `examples/{clients,servers}/typescript/` plus a vitest case asserting the check emits `FAILURE`/`WARNING` against it. See `src/scenarios/client/auth/index.test.ts` and `src/scenarios/server/negative.test.ts` for the pattern. A passing run against the everything-server proves the check doesn't false-positive, but not that it catches anything.

Delete unused example scenarios. If a scenario key in the everything-client has no corresponding test, remove it.

## Don't add new ways to run tests

Use the existing CLI runner (`npx @modelcontextprotocol/conformance client|server ...`). If you need a feature the runner doesn't have, add it to the runner rather than building a parallel entry point.

## Before opening a PR

- `npm run build` passes
- `npm test` passes
- For non-trivial scenario changes, run against at least one real SDK (typescript-sdk or python-sdk) to see actual output. For changes to shared infrastructure (runner, tier-check), test against go-sdk or csharp-sdk too.
- Scenario is registered in the right suite in `src/scenarios/index.ts`
- If you changed a `sep-*.yaml` or scenario check IDs, `src/seps/traceability.json` will drift; the traceability workflow refreshes it via PR (or regenerate locally with `--results` from a suite run)
