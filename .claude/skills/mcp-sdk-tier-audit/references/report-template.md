# Audit Report Template

Use this exact format when generating the final tier audit report.

## Part 1: Tier Assessment

```markdown
# MCP SDK Tier Audit: {repo}

**Date**: {date}
**Branch**: {branch}
**Auditor**: mcp-sdk-tier-audit skill (automated + subagent evaluation)

---

## Tier Assessment: Tier {X}

{Brief 1-2 sentence summary of the overall assessment and key factors.}

### Requirements Summary

| # | Requirement | Tier 1 Standard | Tier 2 Standard | Current Value | T1? | T2? | Gap |
|---|---|---|---|---|---|---|---|
| 1 | Conformance Tests | 100% pass rate | >= 80% pass rate | {X}% ({passed}/{total}) | {PASS/FAIL} | {PASS/FAIL} | {detail or "None"} |
| 2 | Issue Triage | Within 2 business days | Within 1 month | {median triage time} | {PASS/FAIL} | {PASS/FAIL} | {detail or "None"} |
| 3 | Critical Bug Resolution | Within 7 days | Within 2 weeks | {P0 resolution stats} | {PASS/FAIL} | {PASS/FAIL} | {detail or "None"} |
| 4 | Stable Release | Required + clear versioning | At least one stable release | {latest version} | {PASS/FAIL} | {PASS/FAIL} | {detail or "None"} |
| 5 | Documentation | Comprehensive w/ examples for all features | Basic docs covering core features | {X}/{Y} features documented | {PASS/FAIL} | {PASS/FAIL} | {detail or "None"} |
| 6 | Dependency Policy | Published update policy | Published update policy | {Found/Not found} | {PASS/FAIL} | {PASS/FAIL} | {detail or "None"} |
| 7 | Roadmap | Published roadmap | Plan toward Tier 1 | {Found/Not found} | {PASS/FAIL} | {PASS/FAIL} | {detail or "None"} |
| 8 | Versioning Policy | Documented breaking change policy | N/A | {Found/Not found} | {PASS/FAIL} | {N/A} | {detail or "None"} |

**Legend**: PASS = meets requirement, FAIL = does not meet requirement, N/A = not applicable at this tier

### Tier Determination Logic

- Tier 1: {PASS/FAIL} -- {count} of 8 requirements met ({list failing requirements if any})
- Tier 2: {PASS/FAIL} -- {count} of 7 requirements met ({list failing requirements if any})
- **Final Tier: {X}**

---

### Conformance Test Details

**Suite**: {active/all}
**Total scenarios**: {N}
**Passed**: {N} | **Failed**: {N} | **Warnings**: {N}
**Pass rate**: {X}%

{If tests were run, include per-scenario breakdown:}

| Scenario | Status | Notes |
|---|---|---|
| lifecycle | PASS/FAIL | {detail} |
| tools-list | PASS/FAIL | {detail} |
| ... | ... | ... |

{If tests were NOT run:}
> Conformance tests could not be run: {reason}. This is recorded as a gap.

---

### Issue Triage Metrics

**Analysis period**: Last {N} issues
**Labels configured**: {Yes/No -- list which SEP-1730 labels are present}

| Metric | Value | Tier 1 Requirement | Tier 2 Requirement | Verdict |
|---|---|---|---|---|
| Median triage time | {value} | <= 2 business days | <= 1 month | {T1: PASS/FAIL, T2: PASS/FAIL} |
| Triage compliance rate | {X}% | >= 90% | >= 80% | {T1: PASS/FAIL, T2: PASS/FAIL} |
| P0 issues found | {N} | -- | -- | -- |
| P0 median resolution time | {value} | <= 7 days | <= 14 days | {T1: PASS/FAIL, T2: PASS/FAIL} |

{If labels are not set up:}
> SEP-1730 labels are not configured in this repository. Issue triage metrics cannot be computed. This is a blocking gap for Tier 1 and Tier 2.

---

### Documentation Coverage (Subagent 1)

{Paste the subagent's evidence table here}

---

### Policy Evaluation (Subagent 2)

{Paste the subagent's evidence tables here}
```

## Part 2: Remediation Guide

```markdown
---

## Remediation Guide

### Blocking for Tier {next tier} (must fix)

| # | Action Item | Requirement | Effort | Where to Change |
|---|---|---|---|---|
| 1 | {description} | {requirement name} | {Small/Medium/Large} | {file path(s)} |
| 2 | {description} | {requirement name} | {Small/Medium/Large} | {file path(s)} |
| ... | ... | ... | ... | ... |

### Quick Wins (low effort, high impact)

| # | Action Item | Requirement | Effort | Where to Change |
|---|---|---|---|---|
| 1 | {description} | {requirement name} | Small | {file path(s)} |
| ... | ... | ... | ... | ... |

### Longer-Term Improvements

| # | Action Item | Requirement | Effort | Where to Change |
|---|---|---|---|---|
| 1 | {description} | {requirement name} | {Medium/Large} | {file path(s)} |
| ... | ... | ... | ... | ... |

### Recommended Next Steps

1. {First priority action with brief rationale}
2. {Second priority action}
3. {Third priority action}
```

## Formatting Rules

1. Every PASS/FAIL cell must be based on evidence, not assumption.
2. If data is unavailable (e.g., conformance tests not runnable), mark as "N/A - {reason}" rather than FAIL, but note it as a gap in the remediation guide.
3. All file references from subagents must include file path and line numbers where possible.
4. The remediation guide must be ordered by impact: items that would advance the SDK to the next tier come first.
5. Effort estimates should be realistic: Small (< 1 day), Medium (1-3 days), Large (> 3 days).
