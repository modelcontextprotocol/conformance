# Report Templates

Write two files to `results/` in the conformance repo:

- `results/<YYYY-MM-DD>-<sdk-name>-assessment.md`
- `results/<YYYY-MM-DD>-<sdk-name>-remediation.md`

## assessment.md

```markdown
# MCP SDK Tier Audit: {repo}

**Date**: {date}
**Branch**: {branch}
**Auditor**: mcp-sdk-tier-audit skill (automated + subagent evaluation)

## Tier Assessment: Tier {X}

{Brief 1-2 sentence summary of the overall assessment and key factors.}

### Requirements Summary

| #   | Requirement             | Tier 1 Standard                   | Tier 2 Standard              | Current Value                     | T1?         | T2?         | Gap                |
| --- | ----------------------- | --------------------------------- | ---------------------------- | --------------------------------- | ----------- | ----------- | ------------------ |
| 1   | Conformance Tests       | 100% pass rate                    | >= 80% pass rate             | {X}% ({passed}/{total})           | {PASS/FAIL} | {PASS/FAIL} | {detail or "None"} |
| 2   | Issue Triage            | >= 90% within 2 biz days          | >= 80% within 1 month        | {compliance}% ({triaged}/{total}) | {PASS/FAIL} | {PASS/FAIL} | {detail or "None"} |
| 3   | Critical Bug Resolution | All P0s within 7 days             | All P0s within 2 weeks       | {open P0 count} open              | {PASS/FAIL} | {PASS/FAIL} | {detail or "None"} |
| 4   | Stable Release          | Required + clear versioning       | At least one stable release  | {version}                         | {PASS/FAIL} | {PASS/FAIL} | {detail or "None"} |
| 5   | Documentation           | Comprehensive w/ examples         | Basic docs for core features | {pass}/{total} features           | {PASS/FAIL} | {PASS/FAIL} | {detail or "None"} |
| 6   | Dependency Policy       | Published update policy           | Published update policy      | {Found/Not found}                 | {PASS/FAIL} | {PASS/FAIL} | {detail or "None"} |
| 7   | Roadmap                 | Published roadmap                 | Plan toward Tier 1           | {Found/Not found}                 | {PASS/FAIL} | {PASS/FAIL} | {detail or "None"} |
| 8   | Versioning Policy       | Documented breaking change policy | N/A                          | {Found/Not found}                 | {PASS/FAIL} | N/A         | {detail or "None"} |

### Tier Determination

- Tier 1: {PASS/FAIL} -- {count}/8 requirements met (failing: {list})
- Tier 2: {PASS/FAIL} -- {count}/7 requirements met (failing: {list})
- **Final Tier: {X}**

---

## Conformance Details

Pass rate: {X}% ({passed}/{total})

| Scenario | Status      | Checks           |
| -------- | ----------- | ---------------- |
| {name}   | {PASS/FAIL} | {passed}/{total} |
| ...      | ...         | ...              |

---

## Issue Triage Details

Analysis period: Last {N} issues
Labels: {present/missing list}

| Metric          | Value | T1 Req | T2 Req | Verdict   |
| --------------- | ----- | ------ | ------ | --------- |
| Compliance rate | {X}%  | >= 90% | >= 80% | {verdict} |
| Exceeding SLA   | {N}   | --     | --     | --        |
| Open P0s        | {N}   | 0      | 0      | {verdict} |

{If open P0s, list them with issue number, title, age}

---

## Documentation Coverage

{Paste subagent 1 output: feature table with Documented/Where/Examples/Verdict columns}

---

## Policy Evaluation

{Paste subagent 2 output: dependency policy, roadmap, versioning policy sections with evidence tables}
```

## remediation.md

```markdown
# Remediation Guide: {repo}

**Date**: {date}
**Current Tier**: {X}
**Target**: Tier {next}

## Blocking for Tier {next}

| #   | Action        | Requirement   | Effort               | Where        |
| --- | ------------- | ------------- | -------------------- | ------------ |
| 1   | {description} | {requirement} | {Small/Medium/Large} | {file paths} |
| ... | ...           | ...           | ...                  | ...          |

## Quick Wins

| #   | Action        | Requirement   | Effort | Where        |
| --- | ------------- | ------------- | ------ | ------------ |
| 1   | {description} | {requirement} | Small  | {file paths} |
| ... | ...           | ...           | ...    | ...          |

## Longer-Term

| #   | Action        | Requirement   | Effort         | Where        |
| --- | ------------- | ------------- | -------------- | ------------ |
| 1   | {description} | {requirement} | {Medium/Large} | {file paths} |
| ... | ...           | ...           | ...            | ...          |

## Recommended Next Steps

1. {First priority action with brief rationale}
2. {Second priority action}
3. {Third priority action}
```

## Formatting Rules

1. Every PASS/FAIL must be based on evidence, not assumption.
2. If data is unavailable, mark as "N/A - {reason}" and note in remediation.
3. All file references must include file path and line numbers where possible.
4. Remediation items ordered by impact: tier-advancing items first.
5. Effort estimates: Small (< 1 day), Medium (1-3 days), Large (> 3 days).
