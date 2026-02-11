---
name: mcp-sdk-tier-audit
description: >-
  Comprehensive tier assessment for an MCP SDK repository against SEP-1730.
  Produces tier classification (1/2/3) with evidence table, gap list, and
  remediation guide. Works for any official MCP SDK (TypeScript, Python, Go,
  C#, Java, Kotlin, PHP, Swift, Rust, Ruby).
argument-hint: '<local-path> <conformance-server-url> [client-cmd]'
---

# MCP SDK Tier Audit

You are performing a comprehensive tier assessment for an MCP SDK repository against SEP-1730 (the SDK Tiering System). Your goal is to produce a definitive tier classification (Tier 1, 2, or 3) backed by evidence.

## Step 1: Parse Arguments

Extract from the user's input:

- **local-path**: absolute path to the SDK checkout (e.g. `~/src/mcp/typescript-sdk`)
- **conformance-server-url**: URL where the SDK's everything server is already running (e.g. `http://localhost:3000/mcp`)
- **client-cmd** (optional): command to run the SDK's conformance client (e.g. `npx tsx test/conformance/src/everythingClient.ts`). If not provided, try to auto-detect it (see below).

The first two arguments are required. If either is missing, ask the user to provide it.

### Auto-detecting the conformance client command

If client-cmd is not provided, look for a conformance client in the local checkout:

```bash
# Check common locations for a conformance/everything client
ls <local-path>/test/conformance/src/everythingClient.ts 2>/dev/null
ls <local-path>/tests/conformance/client.py 2>/dev/null
```

For TypeScript SDKs, the client command is typically:
```
npx tsx <local-path>/test/conformance/src/everythingClient.ts
```

For Python SDKs, the client command is typically:
```
uv run python <local-path>/tests/conformance/client.py
```

If no conformance client is found, proceed without client conformance tests (they will be skipped and noted in the report).

Derive the GitHub `owner/repo` from the local checkout:

```bash
cd <local-path> && git remote get-url origin | sed 's#.*github.com[:/]##; s#\.git$##'
```

## Step 2: Run the Deterministic Scorecard

The `tier-check` CLI handles all deterministic checks — server conformance, client conformance, labels, triage, P0 resolution, releases, policy signals, and spec tracking. You are already in the conformance repo, so run it directly.

```bash
npm run --silent tier-check -- \
  --repo <owner/repo> \
  --conformance-server-url <conformance-server-url> \
  --client-cmd '<client-cmd>' \
  --output json
```

If no client-cmd was detected, omit the `--client-cmd` flag (client conformance will be skipped).

The CLI output includes server conformance pass rate, client conformance pass rate, issue triage compliance, P0 resolution times, label taxonomy, stable release status, policy signal files, and spec tracking gap. Parse the JSON output to feed into Step 4.

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

- Server conformance test pass rate == 100%
- Client conformance test pass rate == 100%
- Issue triage compliance >= 90% within 2 business days
- All P0 bugs resolved within 7 days
- Stable release >= 1.0.0 with no pre-release suffix
- Clear versioning with documented breaking change policy (evaluation)
- All non-experimental features documented with examples (evaluation)
- Published dependency update policy (evaluation)
- Published roadmap with concrete steps tracking spec components (evaluation)

### Tier 2 requires ALL of:

- Server conformance test pass rate >= 80%
- Client conformance test pass rate >= 80%
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
- If client conformance was skipped (no client command found), note this as a gap but do not block tier advancement based on it alone.

**P0 Label Audit Guidance:**

When evaluating P0 metrics, flag potentially mislabeled P0 issues:

- If P0 count is high (>2) but other Tier 2 metrics (conformance, triage compliance, docs) are strong, this may indicate P0 labels are being used for enhancements, lower-priority work, or feature requests rather than actual critical bugs.
- In such cases, recommend a P0 label audit as a remediation action. Review open P0 issues to verify they represent genuine blocking defects vs. misclassified work.
- Document this finding in the remediation output with specific issue numbers and suggested re-triage actions.
- Do not treat high P0 count as an automatic hard blocker if the audit reveals mislabeling; instead, note it as a process improvement opportunity.

## Step 5: Generate Output

Write detailed reports to files and show a concise summary to the user.

### Output files

Write two files to `results/` in the conformance repo:

- `results/<YYYY-MM-DD>-<sdk-name>-assessment.md`
- `results/<YYYY-MM-DD>-<sdk-name>-remediation.md`

For example: `results/2026-02-10-typescript-sdk-assessment.md`

### Assessment file

Use the assessment template from `references/report-template.md`. This file contains the full requirements table, conformance test details (both server and client), triage metrics, documentation coverage table, and policy evaluation evidence.

### Remediation file

Use the remediation template from `references/report-template.md`. This file always includes both:

- **Path to Tier 2** (if current tier is 3) -- what's needed to reach Tier 2
- **Path to Tier 1** (always) -- what's needed to reach Tier 1

### Console output (shown to the user)

After writing the files, output a short executive summary directly to the user:

```
## <sdk-name> — Tier <X>

Server Conformance: <passed>/<total> (<status>) | Client Conformance: <passed>/<total> (<status>) | Triage: <rate>% (<status>) | P0s: <count> open (<status>) | Docs: <pass>/<total> (<status>) | Policies: <summary> (<status>)

For Tier 2: <one-line summary of what's needed, or "All requirements met">
For Tier 1: <one-line summary of what's needed, or "All requirements met">

Reports:
- results/<date>-<sdk-name>-assessment.md
- results/<date>-<sdk-name>-remediation.md
```

Use checkmarks/crosses for status: ✓ for pass, ✗ for fail.

**Special note for high P0 count with strong other metrics:**

If P0 count is >2 but other Tier 2 metrics pass, add this note to the executive summary:

```
⚠️  P0 Label Audit Recommended: <count> open P0 issues detected. Review these issues to verify they represent critical bugs vs. misclassified enhancements or lower-priority work. See remediation report for specific issues and re-triage guidance.
```

This ensures the audit context is clear: the high P0 count may be a labeling process issue rather than a product quality issue.

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
# (client command auto-detected from test/conformance/src/everythingClient.ts)
/mcp-sdk-tier-audit ~/src/mcp/worktrees/typescript-sdk-v1x http://localhost:3000/mcp

# Explicit client command
/mcp-sdk-tier-audit ~/src/mcp/worktrees/typescript-sdk-v1x http://localhost:3000/mcp "npx tsx ~/src/mcp/worktrees/typescript-sdk-v1x/test/conformance/src/everythingClient.ts"

# Python SDK with everything server running on port 3001
/mcp-sdk-tier-audit ~/src/mcp/python-sdk http://localhost:3001/mcp
```
