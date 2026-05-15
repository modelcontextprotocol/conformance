---
name: review-scenario
description: Use when reviewing a conformance PR that adds or changes scenario .ts files for a SEP — before approving, before requesting changes, or as a self-check before opening one.
---

# review-scenario

## What to check

**Spec diff is ground truth.** Pull the SEP's actual spec changes and read the RFC-2119 sentences yourself — don't trust the PR description or SEP summary for keyword levels:

```bash
gh api "repos/modelcontextprotocol/modelcontextprotocol/pulls/<SEP>/files" \
  --jq '.[] | select(.filename | test("^docs/specification/draft/.*\\.mdx$")) | {filename, patch}'
```

If the SEP includes a conformance-test-case table, that table is authoritative for the cases it lists. A table/prose mismatch is a spec gap to flag, not something to silently resolve either way.

**Traceability YAML.** `src/seps/sep-<SEP>.yaml` should exist (run `/new-sep <SEP>` first if not). Diff its rows against the spec sentences you extracted; flag rows that paraphrase rather than quote, claim a keyword level the spec doesn't, or assert something the spec never says. Check IDs follow `sep-<NNNN>-<kebab-slug>`.

**Per-scenario-file:**

- **Spec backing** — would a fully spec-compliant implementation FAIL this check? If yes — or if two compliant SDKs in different languages would get different results — the spec hasn't pinned the behavior; note it as a gap rather than enforce it.
- **Dead checks** — emits FAILURE with no reachable SUCCESS counterpart, or sits behind an always-false guard.
- **Logic** — does a missing/malformed input silently pass? Does the assertion distinguish "rejected for the right reason" from "rejected at all"?

**Coverage.** Count YAML `check:` rows vs how many the PR's scenarios actually exercise; list the gaps.

**Proof it runs.** The PR should reference at least one real implementation the scenario ran green against — the in-repo everything-client/server, or an external SDK via `npx https://pkg.pr.new/@modelcontextprotocol/conformance@<PR>`. No run referenced → ask for one before approving.

**Negative test.** Pins the specific failing slugs, not just `failures.length > 0` (AGENTS.md §Examples: prove it passes and fails).

## Output

This is a first pass for a human reviewer — give them what they need to verify each finding without re-deriving it.

**Open with a summary:** N scenarios added/changed, M distinct check IDs emitted, X/Y YAML `check:` rows covered, and which implementation it was run against.

**Then one bullet per finding.** Each bullet makes its own case — the reviewer should be able to confirm or refute it from the bullet alone:

> **`<check-id>`** — [`file.ts:Lnn`](https://github.com/modelcontextprotocol/conformance/blob/<HEAD-SHA>/path/file.ts#Lnn) — claim. Spec: _"quoted normative sentence"_ ([page#anchor](https://modelcontextprotocol.io/specification/draft/...#anchor)). Consequence: what a compliant impl would do and how this check would mis-report it.

e.g.

> **`client-consistent-version`** — [`stateless.ts:86`](…/blob/abc123/src/scenarios/client/stateless.ts#L86) — no spec backing. Spec: _"Servers MUST NOT rely on prior requests over the same connection to establish context (e.g., capabilities, protocol version)"_ ([lifecycle#stateless](…)). A compliant client may change `protocolVersion` per request; this check FAILs it. The `flippingVersionClient` negative test enforces a non-requirement.

Get `<HEAD-SHA>` once via `gh pr view <PR> --json headRefOid -q .headRefOid` and use it for all permalinks so they don't drift on rebase.

Order: spec-backing → logic/dead → coverage (gap list) → conventions. Put spec gaps in a separate trailing list — those go upstream, not to the PR author.

**Self-review:** fix in place and re-run.

**If asked to push fixes** (stacked diff on top of the PR head): one commit per finding, commit message is the finding. Leave design-level items (scenario count, refactors) as prose.
