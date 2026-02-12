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

## Step 0: Pre-flight Checks

Before doing anything else, verify GitHub CLI authentication:

```bash
gh auth status 2>&1
```

If this fails (exit code non-zero or shows "not logged in"), stop immediately and tell the user:

> GitHub authentication is required for this skill. Please run `gh auth login` first, then re-run the skill.

Do NOT proceed to any other step if this check fails.

After parsing arguments (Step 1), also verify the conformance server is reachable:

```bash
curl -sf <conformance-server-url> -o /dev/null -w '%{http_code}' 2>&1 || true
```

If the server is not reachable, stop and tell the user:

> Conformance server at `<url>` is not reachable. Make sure the everything server is running before invoking this skill.

## Step 1: Parse Arguments

Extract from the user's input:

- **local-path**: absolute path to the SDK checkout (e.g. `~/src/mcp/typescript-sdk`)
- **conformance-server-url**: URL where the SDK's everything server is already running (e.g. `http://localhost:3000/mcp`)
- **client-cmd** (optional): command to run the SDK's conformance client (e.g. `npx tsx test/conformance/src/everythingClient.ts`). If not provided, client conformance tests are skipped and noted as a gap in the report.

The first two arguments are required. If either is missing, ask the user to provide it.

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

### Conformance Baseline Check

After running the CLI, check for an expected-failures baseline file in the SDK repo:

```bash
find <local-path> -name "baseline.yml" -o -name "expected-failures.yml" 2>/dev/null | head -5
```

If found, read the file. It lists known/expected conformance failures. This context is essential for interpreting raw pass rates — a 20% client pass rate due entirely to unimplemented OAuth scenarios is very different from 20% due to broken core functionality.

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

Use the prompt from `references/policy-evaluation-prompt.md`. Pass the local path, the derived `owner/repo`, and the `policy_signals` section from the CLI JSON output.

The CLI has already checked which policy files exist (ROADMAP.md, DEPENDENCY_POLICY.md, dependabot.yml, VERSIONING.md, etc.). The AI evaluation reads only the files the CLI found to judge whether the content is substantive — it does NOT search for files in other locations.

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

**Client Conformance Splits:**

When reporting client conformance, always break results into three categories:

1. **Core suite** — Non-auth scenarios (e.g. initialize, tools_call, elicitation, sse-retry)
2. **Auth suite** — OAuth/authorization scenarios (any scenario starting with `auth/`)
3. **Full suite** — All scenarios combined

The **full suite** number is used for tier threshold checks. However, the core vs auth split provides essential context. Always present both numbers in the report.

If the SDK has a `baseline.yml` or expected-failures file, note which failures are known/tracked vs. unexpected regressions. A low full-suite score where all failures are auth scenarios documented in the baseline is a scope gap (OAuth not yet implemented), not a quality problem — flag it accordingly in the assessment.

**P0 Label Audit Guidance:**

When evaluating P0 metrics, flag potentially mislabeled P0 issues:

- If P0 count is high (>2) but other Tier 2 metrics (conformance, triage compliance, docs) are strong, this may indicate P0 labels are being used for enhancements, lower-priority work, or feature requests rather than actual critical bugs.
- In such cases, recommend a P0 label audit as a remediation action. Review open P0 issues to verify they represent genuine blocking defects vs. misclassified work.
- Document this finding in the remediation output with specific issue numbers and suggested re-triage actions.
- Do not treat high P0 count as an automatic hard blocker if the audit reveals mislabeling; instead, note it as a process improvement opportunity.

## Step 5: Generate Output

Write detailed reports to files using subagents, then show a concise summary to the user.

### Output files (write via subagents)

**IMPORTANT**: Write both report files using parallel subagents (Task tool) so the file-writing work does not pollute the main conversation thread. Launch both subagents at the same time.

Write two files to `results/` in the conformance repo:

- `results/<YYYY-MM-DD>-<sdk-name>-assessment.md`
- `results/<YYYY-MM-DD>-<sdk-name>-remediation.md`

For example: `results/2026-02-11-typescript-sdk-assessment.md`

#### Assessment subagent

Pass all the gathered data (CLI scorecard JSON, docs evaluation results, policy evaluation results) to a subagent and instruct it to write the assessment file using the template from `references/report-template.md`. This file contains the full requirements table, conformance test details (both server and client), triage metrics, documentation coverage table, and policy evaluation evidence.

#### Remediation subagent

Pass all the gathered data to a subagent and instruct it to write the remediation file using the template from `references/report-template.md`. This file always includes both:

- **Path to Tier 2** (if current tier is 3) -- what's needed to reach Tier 2
- **Path to Tier 1** (always) -- what's needed to reach Tier 1

### Console output (shown to the user)

After the subagents finish, output a short executive summary directly to the user:

```
## <sdk-name> — Tier <X>

| Check | Value | T2 | T1 |
|-------|-------|----|----|
| Server Conformance | <passed>/<total> (<rate>%) | ✓/✗ | ✓/✗ |
| Client Conformance (full) | <passed>/<total> (<rate>%) | ✓/✗ | ✓/✗ |
|   — Core scenarios | <core_pass>/<core_total> (<rate>%) | — | — |
|   — Auth scenarios | <auth_pass>/<auth_total> (<rate>%) | — | — |
| Issue Triage | <rate>% (<triaged>/<total>) | ✓/✗ | ✓/✗ |
| Labels | <present>/<required> | ✓/✗ | ✓/✗ |
| P0 Resolution | <count> open | ✓/✗ | ✓/✗ |
| Spec Tracking | <days>d gap | ✓/✗ | ✓/✗ |
| Documentation | <pass>/<total> features | ✓/✗ | ✓/✗ |
| Dependency Policy | <summary> | ✓/✗ | ✓/✗ |
| Roadmap | <summary> | ✓/✗ | ✓/✗ |
| Versioning Policy | <summary> | N/A | ✓/✗ |
| Stable Release | <version> | ✓/✗ | ✓/✗ |

If a baseline file was found, add a note below the table:
> **Baseline**: {N} failures in `baseline.yml` ({list of categories, e.g. "18 auth scenarios"}). Core suite: {core_rate}%.

---

**High-Priority Fixes:**
1. <fix description>

**For Tier 2:**
1. <gap description>
2. <gap description>

**For Tier 1:**
1. <gap description>
2. <gap description>

Reports:
- results/<date>-<sdk-name>-assessment.md
- results/<date>-<sdk-name>-remediation.md
```

Use ✓ for pass and ✗ for fail.

**High-Priority Fixes**: List any issues that need urgent attention (e.g., P0 label audit if P0 count is >2 but other metrics are strong, suggesting mislabeled issues). If none, omit this section.

**For Tier 2 / For Tier 1**: List each gap as a separate numbered item. Use "All requirements met" if there are no gaps for that tier. Each item should be a concise action (e.g., "Re-triage mislabeled P0s", "Document 16 undocumented core features").

## Reference Files

The following reference files are available in the `references/` directory alongside this skill:

- `references/feature-list.md` -- Canonical list of 48 non-experimental + 5 experimental features (single source of truth)
- `references/tier-requirements.md` -- Full SEP-1730 requirements table with exact thresholds
- `references/report-template.md` -- Output format template for the audit report
- `references/docs-coverage-prompt.md` -- Evaluation prompt for documentation coverage
- `references/policy-evaluation-prompt.md` -- Evaluation prompt for policy review

Read these reference files when you need the detailed content for evaluation prompts or report formatting.

## Usage Examples

```
# TypeScript SDK — server + client conformance
/mcp-sdk-tier-audit ~/src/mcp/typescript-sdk http://localhost:3000/mcp "npx tsx ~/src/mcp/typescript-sdk/test/conformance/src/everythingClient.ts"

# Python SDK — server + client conformance
/mcp-sdk-tier-audit ~/src/mcp/python-sdk http://localhost:3001/mcp "uv run python ~/src/mcp/python-sdk/.github/actions/conformance/client.py"

# Go SDK — server + client conformance
/mcp-sdk-tier-audit ~/src/mcp/go-sdk http://localhost:3002 "/tmp/go-conformance-client"

# C# SDK — server + client conformance
# Two C#-specific requirements in the client-cmd:
#   --framework net9.0    : required because the project targets net8.0/net9.0/net10.0
#   -- $MCP_CONFORMANCE_SCENARIO : the runner sets this env var and uses shell:true, so the
#                           shell expands it; dotnet passes [scenario, url] to the program
/mcp-sdk-tier-audit ~/src/mcp/csharp-sdk http://localhost:3003 "dotnet run --project ~/src/mcp/csharp-sdk/tests/ModelContextProtocol.ConformanceClient --framework net9.0 -- $MCP_CONFORMANCE_SCENARIO"

# Any SDK — server conformance only (no client)
/mcp-sdk-tier-audit ~/src/mcp/some-sdk http://localhost:3004
```
