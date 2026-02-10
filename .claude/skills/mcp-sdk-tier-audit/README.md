# MCP SDK Tier Audit

Assess any MCP SDK repository against [SEP-1730](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1730) (the SDK Tiering System). Produces a tier classification (1/2/3) with an evidence-backed scorecard.

Two components work together:

- **`tier-check` CLI** — runs deterministic checks (conformance pass rate, issue triage speed, P0 resolution, labels, releases, policy signals). Works standalone, no AI needed.
- **AI-assisted assessment** — an agent uses the CLI scorecard plus judgment-based evaluation (documentation coverage, dependency policy, roadmap) to produce a full tier report with remediation guide.

## Quick Start: CLI

The CLI is a subcommand of the [MCP Conformance](https://github.com/modelcontextprotocol/conformance) tool.

```bash
# Clone and build
git clone https://github.com/modelcontextprotocol/conformance.git
cd conformance
npm install
npm run build

# Authenticate with GitHub (needed for API access)
gh auth login

# Run against any MCP SDK repo
npx @modelcontextprotocol/conformance tier-check --repo modelcontextprotocol/typescript-sdk
```

The CLI uses the GitHub API for issue metrics, labels, and release checks. Authenticate via one of:

- **GitHub CLI** (recommended): `gh auth login` — the CLI picks up your token automatically
- **Environment variable**: `export GITHUB_TOKEN=ghp_...` (create a read-only token at [github.com/settings/tokens](https://github.com/settings/tokens) with `repo:read` and `issues:read` scopes)
- **Flag**: `--token ghp_...`

### CLI Options

```
--repo <owner/repo>              GitHub repository (required)
--branch <branch>                Branch to check
--skip-conformance               Skip conformance tests
--conformance-server-cmd <cmd>   Command to start the conformance server
--conformance-server-cwd <path>  Working directory for the conformance server
--conformance-server-url <url>   URL of the running conformance server
--days <n>                       Limit triage analysis to last N days
--output <format>                json | markdown | terminal (default: terminal)
--token <token>                  GitHub token (defaults to GITHUB_TOKEN or gh auth token)
```

### What the CLI Checks

| Check          | What it measures                                                               |
| -------------- | ------------------------------------------------------------------------------ |
| Conformance    | Pass rate against the conformance test suite                                   |
| Labels         | Whether SEP-1730 label taxonomy is set up (supports GitHub native issue types) |
| Triage         | How quickly issues get labeled after creation                                  |
| P0 Resolution  | Whether critical bugs are resolved within SLA                                  |
| Stable Release | Whether a stable release >= 1.0.0 exists                                       |
| Policy Signals | Presence of CHANGELOG, SECURITY, CONTRIBUTING, dependabot, ROADMAP             |
| Spec Tracking  | Gap between latest spec release and SDK release                                |

### Example Output

```
Tier Assessment: Tier 2

Repo:      modelcontextprotocol/typescript-sdk
Timestamp: 2026-02-10T12:00:00Z

Check Results:

  ✓ Conformance    45/45 (100%)
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

The skill lives in `.claude/skills/` in this repo, so if you open [Claude Code](https://docs.anthropic.com/en/docs/claude-code) in the conformance repo it's already available — just run:

```
/mcp-sdk-tier-audit modelcontextprotocol/typescript-sdk
```

It runs the CLI, launches parallel evaluations for docs and policy, and produces a full report with remediation guide.

### Any Other AI Coding Agent

If you use a different agent (Codex, Cursor, Aider, OpenCode, etc.), give it these instructions:

1. **Run the CLI** to get the deterministic scorecard:

   ```bash
   npx @modelcontextprotocol/conformance tier-check --repo <repo> --output json
   ```

2. **Evaluate documentation coverage** — check whether MCP features (tools, resources, prompts, sampling, transports, etc.) are documented with examples. See [`references/docs-coverage-prompt.md`](references/docs-coverage-prompt.md) for the full checklist.

3. **Evaluate policies** — check for dependency update policy, roadmap, and versioning/breaking-change policy. See [`references/policy-evaluation-prompt.md`](references/policy-evaluation-prompt.md) for criteria.

4. **Apply tier logic** — combine scorecard + evaluations against the thresholds in [`references/tier-requirements.md`](references/tier-requirements.md).

5. **Generate report** — use [`references/report-template.md`](references/report-template.md) for the output format.

### Manual Review

Run the CLI for the scorecard, then review docs and policies yourself using the tier requirements as a checklist:

| Requirement       | Tier 1                         | Tier 2                   |
| ----------------- | ------------------------------ | ------------------------ |
| Conformance       | 100% pass                      | >= 80% pass              |
| Issue triage      | Within 2 business days         | Within 1 month           |
| P0 resolution     | Within 7 days                  | Within 2 weeks           |
| Stable release    | >= 1.0.0 with clear versioning | At least one >= 1.0.0    |
| Documentation     | All features with examples     | Core features documented |
| Dependency policy | Published                      | Published                |
| Roadmap           | Published with spec tracking   | Plan toward Tier 1       |

## Running Conformance Tests

To include conformance test results in the scorecard, you need to start the SDK's everything server, then run tier-check against it.

**TypeScript SDK:**

```bash
# Clone the TypeScript SDK and start its conformance server
cd /path/to/typescript-sdk/test/conformance
npx tsx src/everythingServer.ts &

# Back in the conformance repo, run tier-check
npx @modelcontextprotocol/conformance tier-check \
  --repo modelcontextprotocol/typescript-sdk \
  --conformance-server-url http://localhost:3000/mcp
```

**Python SDK:**

```bash
# In the python-sdk repo, start the everything server
uv run mcp-everything-server &

# Back in the conformance repo, run tier-check
npx @modelcontextprotocol/conformance tier-check \
  --repo modelcontextprotocol/python-sdk \
  --conformance-server-url http://localhost:3001/mcp
```

**Other SDKs:** Start your SDK's everything server, then pass `--conformance-server-url`. If no everything server exists yet, use `--skip-conformance` — the scorecard will note this as a gap.

## Reference Files

These files in [`references/`](references/) contain the detailed criteria and prompts:

| File                          | Purpose                                                 |
| ----------------------------- | ------------------------------------------------------- |
| `tier-requirements.md`        | Full SEP-1730 requirements with exact thresholds        |
| `docs-coverage-prompt.md`     | Feature checklist for documentation evaluation          |
| `policy-evaluation-prompt.md` | Criteria for dependency, roadmap, and versioning policy |
| `report-template.md`          | Output format for the full audit report                 |
