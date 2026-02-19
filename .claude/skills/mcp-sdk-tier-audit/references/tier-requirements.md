# SEP-1730: SDK Tier Requirements Reference

This is the authoritative reference table for MCP SDK tiering requirements, extracted from SEP-1730.

Source: `modelcontextprotocol/docs/community/sdk-tiers.mdx` in the spec repository

## Full Requirements Table

| Requirement                 | Tier 1: Fully Supported                                                                  | Tier 2: Commitment to Full Support                               | Tier 3: Experimental   |
| --------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------- |
| **Conformance Tests**       | 100% pass rate                                                                           | >= 80% pass rate                                                 | No minimum             |
| **New Protocol Features**   | Before new spec version release, timeline agreed per release based on feature complexity | Within 6 months                                                  | No timeline commitment |
| **Issue Triage**            | Within 2 business days                                                                   | Within a month                                                   | No requirement         |
| **Critical Bug Resolution** | Within 7 days                                                                            | Within two weeks                                                 | No requirement         |
| **Stable Release**          | Required with clear versioning                                                           | At least one stable release                                      | Not required           |
| **Documentation**           | Comprehensive with examples for all features                                             | Basic documentation covering core features                       | No minimum             |
| **Dependency Policy**       | Published update policy                                                                  | Published update policy                                          | Not required           |
| **Roadmap**                 | Published roadmap                                                                        | Published plan toward Tier 1 or explanation for remaining Tier 2 | Not required           |

## Exact Thresholds for Automated Checking

| Metric                 | Tier 1 Threshold                                       | Tier 2 Threshold                | How to Measure                                                                           |
| ---------------------- | ------------------------------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------- |
| Conformance pass rate  | == 100%                                                | >= 80%                          | `passed / (passed + failed) * 100` from conformance suite                                |
| Issue triage time      | <= 2 business days                                     | <= 1 month (30 calendar days)   | Time from issue creation to first label application                                      |
| P0 resolution time     | <= 7 calendar days                                     | <= 14 calendar days             | Time from P0 label application to issue close                                            |
| Stable release version | >= 1.0.0, no pre-release suffix                        | >= 1.0.0 (at least one)         | Check `gh release list` for version matching `^[0-9]+\.[0-9]+\.[0-9]+$` where major >= 1 |
| Documentation coverage | All non-experimental features documented with examples | Core features documented        | Subagent evaluation                                                                      |
| Dependency policy      | Published and findable in repo                         | Published and findable in repo  | Subagent evaluation                                                                      |
| Roadmap                | Published with concrete steps tracking spec components | Published plan toward Tier 1    | Subagent evaluation                                                                      |
| Versioning policy      | Documented breaking change policy                      | N/A (just needs stable release) | Subagent evaluation                                                                      |

## Conformance Score Calculation

Every scenario in the conformance suite has a `specVersions` field indicating which spec version it targets. The valid values are defined as the `SpecVersion` type (as a list) in `src/types.ts` — run `node dist/index.js list` to see the current mapping of scenarios to spec versions.

Date-versioned scenarios (e.g. `2025-06-18`, `2025-11-25`) count toward tier scoring. `draft` and `extension` scenarios are listed separately as informational.

The `--spec-version` CLI flag filters scenarios cumulatively for date versions (e.g. `--spec-version 2025-06-18` includes `2025-03-26` + `2025-06-18`). For `draft`/`extension`, it returns exact matches only.

The tier-check output includes a per-version pass rate breakdown alongside the aggregate.

## Tier Relegation Rules

- **Tier 1 to Tier 2**: Any conformance test fails continuously for 4 weeks
- **Tier 2 to Tier 3**: More than 20% of conformance tests fail continuously for 4 weeks

## Issue Triage Label Taxonomy

SDK repositories must use these consistent labels to enable automated reporting.

### Type Labels (pick one)

| Label         | Description                   |
| ------------- | ----------------------------- |
| `bug`         | Something isn't working       |
| `enhancement` | Request for new feature       |
| `question`    | Further information requested |

Note: Repositories using GitHub's native issue types satisfy this requirement without needing type labels.

### Status Labels (pick one)

| Label                | Description                                             |
| -------------------- | ------------------------------------------------------- |
| `needs confirmation` | Unclear if still relevant                               |
| `needs repro`        | Insufficient information to reproduce                   |
| `ready for work`     | Has enough information to start                         |
| `good first issue`   | Good for newcomers                                      |
| `help wanted`        | Contributions welcome from those familiar with codebase |

### Priority Labels (only if actionable)

| Label | Description                                                     |
| ----- | --------------------------------------------------------------- |
| `P0`  | Critical: core functionality failures or high-severity security |
| `P1`  | Significant bug affecting many users                            |
| `P2`  | Moderate issues, valuable feature requests                      |
| `P3`  | Nice to haves, rare edge cases                                  |

**Total: 12 labels** (3 type + 5 status + 4 priority)

## Key Definitions

### Issue Triage

Labeling and determining whether an issue is valid. This is NOT the same as resolving the issue. An issue is considered triaged when it receives its first label.

### Critical Bug (P0)

- **Security vulnerabilities** with CVSS score >= 7.0 (High or Critical severity)
- **Core functionality failures** that prevent basic MCP operations: connection establishment, message exchange, or use of core primitives (tools, resources, prompts)

### Stable Release

A published version explicitly marked as production-ready. Specifically: version `1.0.0` or higher without pre-release identifiers like `-alpha`, `-beta`, or `-rc`.

### Clear Versioning

Following idiomatic versioning patterns with documented breaking change policies, so users can understand compatibility expectations when upgrading.

### Roadmap

Outlines concrete steps and work items that track implementation of required MCP specification components (non-experimental features and optional capabilities), giving users visibility into upcoming feature support.
