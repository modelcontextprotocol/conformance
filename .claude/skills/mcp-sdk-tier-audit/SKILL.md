---
name: mcp-sdk-tier-audit
description: >-
  Comprehensive tier assessment for an MCP SDK repository against SEP-1730.
  Produces tier classification (1/2/3) with evidence table, gap list, and
  remediation guide. Works for any official MCP SDK (TypeScript, Python, Go,
  C#, Java, Kotlin, PHP, Swift, Rust, Ruby).
argument-hint: "[repo] [--branch <branch>]"
---

# MCP SDK Tier Audit

You are performing a comprehensive tier assessment for an MCP SDK repository against SEP-1730 (the SDK Tiering System). Your goal is to produce a definitive tier classification (Tier 1, 2, or 3) backed by evidence.

## Step 1: Parse Arguments

Extract the target SDK from the user's input:

- **repo**: e.g. `modelcontextprotocol/typescript-sdk`, `modelcontextprotocol/python-sdk`
- **--branch**: optional branch name (defaults to the repo's default branch)

If the user did not specify a repo, check if the current working directory is inside a known SDK repo (look for a `package.json` or `pyproject.toml` with MCP-related metadata) and auto-detect. If you still cannot determine the repo, ask the user.

## Step 2: Run Deterministic Conformance Checks

Look up the SDK in the conformance server table below. If the SDK has a known conformance server, run the full conformance suite. If not, use `--skip-conformance` and note this as a gap.

### Conformance Server Lookup Table

| SDK | Org/Repo | Server Location | Start Command | Default URL |
|-----|----------|----------------|---------------|-------------|
| TypeScript | `modelcontextprotocol/typescript-sdk` | Conformance repo `examples/servers/typescript/` | `npx tsx everything-server.ts` | `http://localhost:3000/mcp` |
| Python | `modelcontextprotocol/python-sdk` | SDK repo `examples/servers/everything-server/` | `uv run mcp-everything-server` | TBD - check server source |

For other SDKs, ask the user how to start the conformance server, or check for a `scripts/run-server-conformance.sh` or entry points in `pyproject.toml` / `package.json`. If no conformance server is available, skip conformance and note the gap.

### Running Conformance Tests

Ask the user where the conformance repo checkout is, or look for it as a sibling directory. Then:

```bash
cd <conformance-repo-path>

# First, start the SDK's everything server (in background)
# Then run the conformance suite against it:
npx tsx src/index.ts server --url <server_url> --suite active --verbose
```

Parse the output to extract:
- Total tests passed / failed / warnings
- Per-scenario pass/fail status
- Calculate conformance percentage: `passed / (passed + failed) * 100`

For SDKs **without** a known conformance server, note conformance as "Not testable - no conformance server available" and recommend the maintainers set one up.

### GitHub Issue Metrics

Use the GitHub CLI to gather issue triage and resolution metrics:

```bash
# Get recent issues with labels and timestamps
gh issue list --repo <repo> --state all --limit 500 --json number,title,labels,createdAt,closedAt,state

# Check for P0 issues specifically
gh issue list --repo <repo> --label P0 --state all --json number,title,createdAt,closedAt,state

# Check label usage
gh label list --repo <repo> --json name
```

Calculate:
- **Triage compliance**: percentage of issues that received a label within the required timeframe
- **P0 resolution time**: time from P0 label to issue close

### Release Information

```bash
# Get latest releases
gh release list --repo <repo> --limit 10
```

Check if there is a stable release >= 1.0.0 with no pre-release suffix (`-alpha`, `-beta`, `-rc`).

## Step 3: Launch Parallel Subagent Evaluations

Launch exactly 2 subagents in parallel using the Task tool with `subagent_type="general-purpose"`. Each subagent should clone or read the SDK repo and evaluate its assigned area.

**IMPORTANT**: Launch both subagents at the same time (in the same response) so they run in parallel.

### Subagent 1: Documentation Coverage

Use the prompt from `references/docs-coverage-prompt.md`. Pass the repo name, branch, and the feature list embedded in that prompt.

The subagent evaluates:
- Whether all non-experimental features are documented with examples (Tier 1 requirement)
- Whether core features are documented (Tier 2 requirement)
- Produces an evidence table with file:line references

### Subagent 2: Policy Evaluation

Use the prompt from `references/policy-evaluation-prompt.md`. Pass the repo name and branch.

The subagent evaluates:
- Dependency update policy (required for Tier 1 and Tier 2)
- Published roadmap (required for Tier 1; plan-toward-Tier-1 for Tier 2)
- Clear versioning with documented breaking change policy (required for Tier 1)
- Produces evidence tables for each policy area

## Step 4: Compute Final Tier

Combine the deterministic scorecard (conformance %, issue metrics, release info) with the subagent judgment results (docs, policies). Apply the tier logic:

### Tier 1 requires ALL of:
- Conformance test pass rate == 100%
- Issue triage compliance >= 90% within 2 business days
- All P0 bugs resolved within 7 days
- Stable release >= 1.0.0 with no pre-release suffix
- Clear versioning with documented breaking change policy (subagent-evaluated)
- All non-experimental features documented with examples (subagent-evaluated)
- Published dependency update policy (subagent-evaluated)
- Published roadmap with concrete steps tracking spec components (subagent-evaluated)

### Tier 2 requires ALL of:
- Conformance test pass rate >= 80%
- Issue triage compliance >= 80% within 1 month
- P0 bugs resolved within 2 weeks
- At least one stable release >= 1.0.0
- Basic docs covering core features (subagent-evaluated)
- Published dependency update policy (subagent-evaluated)
- Published plan toward Tier 1 or explanation for remaining Tier 2 (subagent-evaluated)

### Otherwise: Tier 3

If any Tier 2 requirement is not met, the SDK is Tier 3.

**Important edge cases:**
- If conformance tests could not be run (no server), this counts as a FAIL for both Tier 1 and Tier 2 conformance requirements unless the SDK has a documented reason and plan.
- If GitHub issue labels are not set up per SEP-1730, triage metrics cannot be computed. Note this as a gap. However, repos may use GitHub's native issue types instead of type labels — check for both.

## Step 5: Generate Output

Use the template from `references/report-template.md` to produce the final report.

### Part 1: Audit Report

Output the tier summary table showing every requirement, the Tier 1 standard, the Tier 2 standard, the current value, whether it passes for T1 and T2, and any gap detail.

### Part 2: Remediation Guide

Produce a prioritized list of action items for SDK maintainers. Order by impact -- items that would advance the SDK to a higher tier come first. Group by:

1. **Blocking for next tier** -- requirements that must be met to advance
2. **Quick wins** -- low-effort improvements
3. **Longer-term** -- structural work needed

Each item should include:
- What needs to change
- Where in the repo to make the change (file paths if possible)
- Estimated effort (small/medium/large)
- Which tier requirement it satisfies

## Reference Files

The following reference files are available in the `references/` directory alongside this skill:

- `references/tier-requirements.md` -- Full SEP-1730 requirements table with exact thresholds
- `references/report-template.md` -- Output format template for the audit report
- `references/docs-coverage-prompt.md` -- Subagent prompt for documentation evaluation
- `references/policy-evaluation-prompt.md` -- Subagent prompt for policy evaluation

Read these reference files when you need the detailed content for subagent prompts or report formatting.

## Usage Examples

```
# TypeScript SDK (default branch)
/mcp-sdk-tier-audit modelcontextprotocol/typescript-sdk

# TypeScript SDK on specific branch
/mcp-sdk-tier-audit modelcontextprotocol/typescript-sdk --branch v1.x

# Python SDK
/mcp-sdk-tier-audit modelcontextprotocol/python-sdk

# Auto-detect from current directory
/mcp-sdk-tier-audit
```

For other SDKs, specify the repo and tell Claude how to start the conformance server:
```
/mcp-sdk-tier-audit modelcontextprotocol/go-sdk
# Claude will ask how to start the conformance server if it can't find one
```

### Directory Layout

For best results, have the conformance repo and SDK repos checked out as siblings:
```
some-dir/
  conformance/          # modelcontextprotocol/conformance
  typescript-sdk/       # modelcontextprotocol/typescript-sdk
  python-sdk/           # modelcontextprotocol/python-sdk
```
