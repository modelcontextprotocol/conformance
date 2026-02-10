---
name: mcp-sdk-tier-audit
description: >-
  Comprehensive tier assessment for an MCP SDK repository against SEP-1730.
  Produces tier classification (1/2/3) with evidence table, gap list, and
  remediation guide. Works for any official MCP SDK (TypeScript, Python, Go,
  C#, Java, Kotlin, PHP, Swift, Rust, Ruby).
argument-hint: '<local-path> <conformance-server-url>'
---

# MCP SDK Tier Audit

You are performing a comprehensive tier assessment for an MCP SDK repository against SEP-1730 (the SDK Tiering System). Your goal is to produce a definitive tier classification (Tier 1, 2, or 3) backed by evidence.

## Step 1: Parse Arguments

Extract from the user's input:

- **local-path**: absolute path to the SDK checkout (e.g. `~/src/mcp/typescript-sdk`)
- **conformance-server-url**: URL where the SDK's everything server is already running (e.g. `http://localhost:3000/mcp`)

Both arguments are required. If either is missing, ask the user to provide it.

Derive the GitHub `owner/repo` from the local checkout:

```bash
cd <local-path> && git remote get-url origin | sed 's#.*github.com[:/]##; s#\.git$##'
```

## Step 2: Run the Deterministic Scorecard

The `tier-check` CLI handles all deterministic checks — conformance, labels, triage, P0 resolution, releases, policy signals, and spec tracking. You are already in the conformance repo, so run it directly.

```bash
npm run --silent tier-check -- \
  --repo <owner/repo> \
  --conformance-server-url <conformance-server-url> \
  --output json
```

The CLI output includes conformance pass rate, issue triage compliance, P0 resolution times, label taxonomy, stable release status, policy signal files, and spec tracking gap. Parse the JSON output to feed into Step 4.

## Step 3: Launch Parallel Evaluations

Launch 2 evaluations in parallel. Each reads the SDK from the local checkout path.

**IMPORTANT**: Launch both evaluations at the same time (in the same response) so they run in parallel.

### Evaluation 1: Documentation Coverage

Use the prompt from `references/docs-coverage-prompt.md`. Pass the local path.

This evaluation checks:

- Whether all non-experimental features are documented with examples (Tier 1 requirement)
- Whether core features are documented (Tier 2 requirement)
- Produces an evidence table with file:line references

### Evaluation 2: Policy Evaluation

Use the prompt from `references/policy-evaluation-prompt.md`. Pass the local path and the derived `owner/repo`.

This evaluation checks:

- Dependency update policy (required for Tier 1 and Tier 2)
- Published roadmap (required for Tier 1; plan-toward-Tier-1 for Tier 2)
- Clear versioning with documented breaking change policy (required for Tier 1)
- Produces evidence tables for each policy area

## Step 4: Compute Final Tier

Combine the deterministic scorecard (from the CLI) with the evaluation results (docs, policies). Apply the tier logic:

### Tier 1 requires ALL of:

- Conformance test pass rate == 100%
- Issue triage compliance >= 90% within 2 business days
- All P0 bugs resolved within 7 days
- Stable release >= 1.0.0 with no pre-release suffix
- Clear versioning with documented breaking change policy (evaluation)
- All non-experimental features documented with examples (evaluation)
- Published dependency update policy (evaluation)
- Published roadmap with concrete steps tracking spec components (evaluation)

### Tier 2 requires ALL of:

- Conformance test pass rate >= 80%
- Issue triage compliance >= 80% within 1 month
- P0 bugs resolved within 2 weeks
- At least one stable release >= 1.0.0
- Basic docs covering core features (evaluation)
- Published dependency update policy (evaluation)
- Published plan toward Tier 1 or explanation for remaining Tier 2 (evaluation)

### Otherwise: Tier 3

If any Tier 2 requirement is not met, the SDK is Tier 3.

**Important edge cases:**

- If GitHub issue labels are not set up per SEP-1730, triage metrics cannot be computed. Note this as a gap. However, repos may use GitHub's native issue types instead of type labels — the CLI checks for both.

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
- `references/docs-coverage-prompt.md` -- Evaluation prompt for documentation coverage
- `references/policy-evaluation-prompt.md` -- Evaluation prompt for policy review

Read these reference files when you need the detailed content for evaluation prompts or report formatting.

## Usage Examples

```
# TypeScript SDK on v1.x with everything server running on port 3000
/mcp-sdk-tier-audit ~/src/mcp/worktrees/typescript-sdk-v1x http://localhost:3000/mcp

# Python SDK with everything server running on port 3001
/mcp-sdk-tier-audit ~/src/mcp/python-sdk http://localhost:3001/mcp
```
