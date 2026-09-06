# MCP SDK Tier Audit

Assess any MCP SDK repository against [SEP-1730](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1730) (the SDK Tiering System). Produces a tier classification (1/2/3) with an evidence-backed scorecard.

Two components work together:

- **`tier-check` CLI** — runs deterministic checks (server + client conformance pass rate, issue triage speed, P0 resolution, labels, releases, policy signals). Works standalone, no AI needed.
- **AI-assisted assessment** — an agent uses the CLI scorecard plus judgment-based evaluation (documentation coverage, dependency policy, roadmap) to produce a full tier report with remediation guide.

## Quick Start: CLI

For an SDK listed in `src/sdk-runner/known-sdks.ts`, tier-check manages the whole conformance side itself — clone/build, then for each shipped revision the server invocation that SDK declares for that revision:

```bash
gh auth login
npx @modelcontextprotocol/conformance tier-check --sdk go-sdk
```

The per-SDK sections below are for the manual path: driving a server you started yourself.

The CLI is a subcommand of the [MCP Conformance](https://github.com/modelcontextprotocol/conformance) tool.

```bash
# Clone and build
git clone https://github.com/modelcontextprotocol/conformance.git
cd conformance
npm install
npm run build

# Authenticate with GitHub (needed for API access)
gh auth login

# Run against any MCP SDK repo (without conformance tests)
npm run --silent tier-check -- --repo modelcontextprotocol/typescript-sdk --skip-conformance
```

The CLI uses the GitHub API (read-only) for issue metrics, labels, and release checks. Authenticate via one of:

- **GitHub CLI** (recommended): `gh auth login` — the CLI picks up your token automatically
- **Environment variable**: `export GITHUB_TOKEN=ghp_...`
- **Flag**: `--token ghp_...`

For public repos, any authenticated token works (no special scopes needed — authentication just avoids rate limits). For a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new), select **Public Repositories (read-only)** with no additional permissions.

### CLI Options

```
--repo <owner/repo>              GitHub repository (required)
--branch <branch>                Branch to check
--skip-conformance               Skip conformance tests
--conformance-server-url <url>   URL of the already-running conformance server
--client-cmd <cmd>               Command to run the SDK conformance client (for client conformance tests)
--days <n>                       Limit triage analysis to last N days
--output <format>                json | markdown | terminal (default: terminal)
--token <token>                  GitHub token (defaults to GITHUB_TOKEN or gh auth token)
```

### What the CLI Checks

| Check              | What it measures                                                               |
| ------------------ | ------------------------------------------------------------------------------ |
| Server Conformance | Pass rate of server implementation against the conformance test suite          |
| Client Conformance | Pass rate of client implementation against the conformance test suite          |
| Labels             | Whether SEP-1730 label taxonomy is set up (supports GitHub native issue types) |
| Triage             | How quickly issues get labeled after creation                                  |
| P0 Resolution      | Whether critical bugs are resolved within SLA                                  |
| Stable Release     | Whether a stable release >= 1.0.0 exists                                       |
| Policy Signals     | Presence of CHANGELOG, SECURITY, CONTRIBUTING, dependabot, ROADMAP             |
| Spec Tracking      | Gap between latest spec release and SDK release                                |

### Example Output

```
Tier Assessment: Tier 2

Repo:      modelcontextprotocol/typescript-sdk
Timestamp: 2026-02-10T12:00:00Z

Check Results:

  ✓ Server Conformance  45/45 (100%)
  ✓ Client Conformance  4/4 (100%)
  ✗ Labels         9/12 required labels
    Missing: needs confirmation, needs repro, ready for work
  ✓ Triage         92% within 2BD (150 issues, median 8h)
  ✓ P0 Resolution  0 open, 3/3 closed within 7d
  ✓ Stable Release 2.3.1
  ~ Policy Signals ✓ CHANGELOG.md, ✗ SECURITY.md, ✓ CONTRIBUTING.md, ✓ .github/dependabot.yml, ✗ ROADMAP.md
  ✓ Spec Tracking  2d gap
```

Use `--output json` to get machine-readable results, or `--output markdown` for a report you can paste into an issue.

## Full AI-Assisted Assessment

The CLI produces a deterministic scorecard, but some SEP-1730 requirements need judgment: documentation quality, dependency policy, roadmap substance. An AI agent can evaluate these by reading the repo.

### Claude Code

The skill lives in `.claude/skills/` in this repo, so if you open [Claude Code](https://docs.anthropic.com/en/docs/claude-code) in the conformance repo it's already available.

1. Make sure `gh auth login` is done (the skill checks this upfront)
2. Start the SDK's everything server in a separate terminal
3. Run the skill:

```
/mcp-sdk-tier-audit <local-sdk-path> <conformance-server-url> [client-cmd] [--requirements <revision>]
```

Pass the client command as the third argument to include client conformance testing. If omitted, client conformance is skipped and noted as a gap in the report.

**Pass `--requirements` with every revision the SDK claims**, comma-separated. Each revision's scenarios run at that revision's own wire version, and all of them must pass for Tier 1: the dated revisions through `2025-11-25` use the stateful initialize handshake while `2026-07-28` is stateless, so a scenario belonging to both has to work on both and one run does not cover the other. It also means a scenario added to the suite after a revision shipped cannot fail an SDK that had no opportunity to adopt it. Without the flag, scoring uses the suite as it stands today, which is not a tier claim. See [Conformance Requirements](../../../README.md#conformance-requirements), and run `conformance list --requirements 2025-11-25,2026-07-28` to see both sets.

**Known SDKs — no server to start, no commands to look up:**

```
/mcp-sdk-tier-audit <sdk checkout> --requirements 2025-11-25,2026-07-28
```

The skill drives `tier-check --sdk-path`, which builds the SDK and starts the
server invocation its config declares **per revision** — the per-SDK commands
live in [`src/sdk-runner/known-sdks.ts`](../../../src/sdk-runner/known-sdks.ts),
not here. That matters because a hand-run example cannot be correct for every
SDK: go-sdk needs a different server process per revision (`-stateless` defaults
to true, so a bare invocation mis-measures 2025-11-25 — [#446](https://github.com/modelcontextprotocol/conformance/issues/446)),
and csharp-sdk serves the two revisions at different endpoints. Prose copies of
those invocations drift; the config is tested.

**An SDK not in `known-sdks.ts`:** start its everything server yourself and pass
the URL and client command explicitly — see [Other SDKs](#running-conformance-tests)
below. The one endpoint you give must serve every claimed revision at its own
wire, or the numbers will be wrong for the revisions it does not speak.


### Any Other AI Coding Agent

If you use a different agent (Codex, Cursor, Aider, OpenCode, etc.), give it these instructions:

1. **Run the CLI** to get the deterministic scorecard:

   ```bash
   node dist/index.js tier-check --repo <repo> --conformance-server-url <url> --output json
   ```

2. **Evaluate documentation coverage** — check whether MCP features (tools, resources, prompts, sampling, transports, etc.) are documented with examples. See [`references/docs-coverage-prompt.md`](references/docs-coverage-prompt.md) for the full checklist.

3. **Evaluate policies** — check for dependency update policy, roadmap, and versioning/breaking-change policy. See [`references/policy-evaluation-prompt.md`](references/policy-evaluation-prompt.md) for criteria.

4. **Apply tier logic** — combine scorecard + evaluations against the thresholds in [`references/tier-requirements.md`](references/tier-requirements.md).

5. **Generate report** — use [`references/report-template.md`](references/report-template.md) for the output format.

### Manual Review

Run the CLI for the scorecard, then review docs and policies yourself using the tier requirements as a checklist:

| Requirement        | Tier 1                         | Tier 2                   |
| ------------------ | ------------------------------ | ------------------------ |
| Server Conformance | 100% pass                      | >= 80% pass              |
| Client Conformance | 100% pass                      | >= 80% pass              |
| Issue triage       | Within 2 business days         | Within 1 month           |
| P0 resolution      | Within 7 days                  | Within 2 weeks           |
| Stable release     | >= 1.0.0 with clear versioning | At least one >= 1.0.0    |
| Documentation      | All features with examples     | Core features documented |
| Dependency policy  | Published                      | Published                |
| Roadmap            | Published with spec tracking   | Plan toward Tier 1       |

## Running Conformance Tests

For any SDK in [`src/sdk-runner/known-sdks.ts`](../../../src/sdk-runner/known-sdks.ts), don't start servers by hand — the config runs the right invocation per revision:

```bash
# both legs, every revision, one verdict
npx @modelcontextprotocol/conformance tier-check --sdk go-sdk

# a single leg at a single revision, for debugging
npx @modelcontextprotocol/conformance sdk --path <sdk checkout> --mode server --requirements 2026-07-28
```

To reproduce one leg fully by hand, copy the build/server/client commands from that SDK's `known-sdks.ts` entry (including its `specOverrides` for the revision you're running) rather than from a README: the entries are exercised by the test suite and per-revision, prose examples are neither.

**Other SDKs:** Your SDK needs an "everything server" — an HTTP server implementing the [Streamable HTTP transport](https://modelcontextprotocol.io/specification/draft/basic/transports.md) with all MCP features (tools, resources, prompts, etc.). See the implementations above as reference.

Start your everything server, then pass `--conformance-server-url`. Pass `--client-cmd` if your SDK has a conformance client. If neither exists yet, use `--skip-conformance` — the scorecard will note this as a gap.

## Reference Files

These files in [`references/`](references/) contain the detailed criteria and prompts:

| File                          | Purpose                                                 |
| ----------------------------- | ------------------------------------------------------- |
| `tier-requirements.md`        | Full SEP-1730 requirements with exact thresholds        |
| `docs-coverage-prompt.md`     | Feature checklist for documentation evaluation          |
| `policy-evaluation-prompt.md` | Criteria for dependency, roadmap, and versioning policy |
| `report-template.md`          | Output format for the full audit report                 |
