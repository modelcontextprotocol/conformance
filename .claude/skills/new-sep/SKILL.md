---
name: new-sep
description: >-
  Scaffold a sep-NNNN.yaml requirement-traceability file for the MCP
  conformance repo from a SEP PR's spec diff. Runs the new-sep CLI, then
  parses the modelcontextprotocol/modelcontextprotocol spec diff to populate
  `requirements[]` with the RFC 2119 sentences and proposed check IDs.
argument-hint: '<sep-number>'
---

# new-sep: SEP traceability YAML scaffolding

You are bootstrapping a `sep-NNNN.yaml` file for a new SEP in the MCP conformance repo. The output is the requirement-traceability file specified by SEP-2484: a YAML that maps each normative sentence from the SEP's spec diff to a `check:` ID (testable) or an `excluded:` reason (not testable). The CLI gets the skeleton; you fill in the rows by reading the spec diff.

## Step 0: Pre-flight checks

Before doing anything else, verify GitHub CLI authentication:

```bash
gh auth status 2>&1
```

If this fails, stop immediately and tell the user:

> GitHub authentication is required for this skill. Please run `gh auth login` first, then re-run.

Verify you're running inside the conformance repo:

```bash
test -f package.json && jq -r '.name' package.json
```

The name should be `@modelcontextprotocol/conformance`. If not, stop and ask the user to `cd` into the conformance repo first.

## Step 1: Parse arguments

Extract from the user's input:

- **sep-number** (required): the SEP number, e.g. `2164`. This is also the PR number in `modelcontextprotocol/modelcontextprotocol` by convention.

If the SEP shipped in a released spec version (a backfill), see the [Variant](#variant-backfilling-a-sep-from-a-released-spec-version) section — use `--spec-url` (`--spec-path` only accepts `docs/specification/draft/` paths).

## Step 2: Generate the skeleton

Run the CLI:

```bash
npm run --silent build
node dist/index.js new-sep <NNNN>
```

(For development against a non-built source tree: `npx tsx src/index.ts new-sep ...`.)

The CLI writes `src/seps/sep-<NNNN>.yaml` with `sep`, `spec_url`, and two TODO `requirements[]` rows. Capture the output path from the CLI's `Wrote …` line and remember it as `$YAML`.

If the CLI errors with "does not change any docs/specification/draft/\*.mdx", the SEP's spec changes landed in a separate PR — ask the user for the spec file path and rerun with `--spec-path docs/specification/draft/<path>`. Do not guess. For a released-version backfill, use `--spec-url` instead — `--spec-path` only accepts `docs/specification/draft/` paths — see the [Variant](#variant-backfilling-a-sep-from-a-released-spec-version) section.

## Step 3: Fetch the spec diff

`AGENTS.md` (lines 64–72) is explicit that severity must come from the spec text itself, not the SEP markdown or the conformance PR description:

```bash
gh api "repos/modelcontextprotocol/modelcontextprotocol/pulls/<NNNN>/files" \
  --jq '.[] | select(.filename | test("^docs/specification/draft/.*\\.mdx$")) | {filename, patch}'
```

For each file, pull the added (`+`-prefixed) lines from `patch`. If `patch` is truncated for a large file, fall back to fetching the whole file at the PR's head ref:

```bash
gh api "repos/modelcontextprotocol/modelcontextprotocol/contents/<path>?ref=<sep-branch>" \
  --jq '.content' | base64 -d
```

## Step 4: Extract RFC 2119 requirements

Walk the added lines and identify sentences containing the keywords: **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **MAY**, **OPTIONAL**.

**Quote the whole sentence**, not just the matched line. The matched word may sit inside a bullet point whose lead-in sentence supplies the keyword by inheritance — e.g.:

> Servers SHOULD return standard JSON-RPC errors for common failure cases:
>
> - Resource not found: -32602 (Invalid Params)

The bullet inherits `SHOULD`. The yaml row should quote the _combined_ obligation: `'Servers SHOULD return standard JSON-RPC errors for common failure cases: Resource not found: -32602 (Invalid Params)'` — see `src/seps/sep-2164.yaml` for the canonical example.

**Regex alone is insufficient** (this is called out in Issue #243). Read for context: pronouns, "the server", and "such cases" all refer back to the lead-in.

## Step 5: Map severity → check vs. excluded

From `AGENTS.md:50-56`:

| Keyword                                        | Severity | YAML field                 |
| ---------------------------------------------- | -------- | -------------------------- |
| MUST / MUST NOT / SHALL / SHALL NOT / REQUIRED | FAILURE  | `check: sep-<NNNN>-<slug>` |
| SHOULD / SHOULD NOT                            | WARNING  | `check: sep-<NNNN>-<slug>` |
| MAY / OPTIONAL                                 | —        | _no row — skip entirely_   |

MAY / OPTIONAL sentences are noted in Step 4 only so you consciously skip them — they never produce a yaml row.

A row is `excluded:` when a MUST/SHOULD requirement can't be protocol-observed by the harness. Do **not** write any `excluded:` row on your own authority — every exclusion goes through Step 6.

While classifying, sort each MUST/SHOULD row into one of three buckets:

- **`check:`** — observably testable on the wire.
- **clearly-excluded** — you're confident it can't be observed (e.g. "clients SHOULD also accept -32002" when the harness only drives servers).
- **borderline** — you'd default to `check:` but observability is questionable. Markers:
  - _Internal state_ — verbs like _record_, _store_, _associate_, _track_, _cache_. The harness sees wire traffic, not memory; usually only observable via a downstream row already in your list.
  - _UI / human-facing_ — _display_, _show_, _render_, _prompt the user_.
  - _Precondition phrasing_ — "Before doing X, the implementation MUST Y" where X is itself another row.

Slug convention: lowercase-kebab, derived from the verb phrase. Examples from `sep-2164.yaml`: `no-empty-contents`, `error-code`. Same `id` is used for SUCCESS and FAILURE (`AGENTS.md:52`).

## Step 6: Confirm exclusions with the user

Nothing becomes `excluded:` without sign-off. Two rounds:

**Round 1 — clearly-excluded, single batch question.** One `AskUserQuestion` listing all clearly-excluded rows in the question body (slug + one-line reason each). Options:

- `Exclude all as listed (Recommended)`
- `Flip all to check:`
- `Let me adjust per-row` — if chosen, append these rows to round 2.

Skip this round if the bucket is empty.

**Round 2 — borderline, one question per row.** One `AskUserQuestion` call with a question per borderline row (loop in batches of 4 if needed). For each:

- header: the proposed slug
- question: quote the requirement sentence + your one-line observability concern
- options (list `check:` first — it's the default for borderline):
  - `check:` — keep as a testable check
  - `excluded: <reason>` — drop to excluded with your stated reason
  - `merge into <other-slug>` — offer when the row is a precondition for another row already in the list

Apply the answers before writing. For any `excluded:` outcome, write the reason verbatim into the yaml and add an `issue:` URL if the user supplies one. A `merge` outcome means: drop this row, and append its `text:` to the surviving row's `text:` separated by `/` so the traceability isn't lost.

## Step 7: Rewrite the YAML

Replace the two TODO rows the CLI generated with one row per extracted requirement. Preserve the CLI's quoting style (single quotes, two-space indent — see `src/seps/sep-2164.yaml`).

**Key order within each row** — for `check:` rows the **`check:` key comes first**, then `text:`, then any optional `url:`. Scanning the left margin should reveal every check ID without reading the quoted sentences. For `excluded:` rows the order is **`text:` first**, then `excluded:`, then optional `issue:` — there's no ID to scan for, so lead with the requirement.

**Row order in the file** — all `check:` rows first (in spec-diff order), then **all `excluded:` rows grouped at the bottom**, separated from the checks by **one blank line**. Do not interleave.

```yaml
requirements:
  - check: sep-NNNN-first-slug
    text: '...'
  - check: sep-NNNN-second-slug
    text: '...'

  - text: '...'
    excluded: 'reason'
    issue: https://github.com/modelcontextprotocol/conformance/issues/<NNNN>
```

If a requirement is ambiguous or you're not confident, leave it as a `TODO:` row rather than guessing — humans review this yaml before scenarios get written.

Also fix the `spec_url`: the CLI emits the page URL with no anchor. If the requirements you extracted live under a specific spec subsection (e.g. `#error-handling`), append it.

If a requirement comes from a **different spec page** than `spec_url` (the SEP touched multiple `.mdx` files — the CLI prints these as "PR also changes N other spec file(s)"), give that row a full `url:` override:

```yaml
- check: sep-NNNN-slug
  text: '...'
  url: https://modelcontextprotocol.io/specification/draft/other/page#anchor
```

A row's effective spec reference is `row.url ?? file.spec_url`.

Write the result back to `$YAML`.

## Step 8: Suggest a host scenario

`AGENTS.md` prefers **fewer scenarios with more checks** over one-scenario-per-check. Before telling the user to write a new scenario, look for an existing one the new checks could be folded into.

Determine the suite directory from the requirement subjects ("MCP clients MUST…" → `client/`, "Servers MUST…" → `server/`, "authorization servers MUST…" → `authorization-server/`; a SEP may map to more than one). Then search that directory for scenarios touching the same spec area:

```bash
rg -l -i '<domain-term>|<domain-term-2>' src/scenarios/<suite>/ --type ts
```

Pick 2–3 domain terms from the SEP's subject matter (for a discovery SEP: `metadata`, `well-known`; for an auth-response SEP: `redirect`, `callback`, `pkce`). For each hit, pull the scenario's `name`/`description` to confirm relevance:

```bash
rg -A1 'name:|description:' <hit.ts>
```

If you find a plausible host, recommend it by path. If nothing fits, say so explicitly — a new scenario file is then the right call.

## Variant: backfilling a SEP from a released spec version

The steps above assume a draft-era SEP whose number is its spec PR. For SEPs that shipped in a released version (e.g. `2025-11-25`), four things change:

- **Inventory** — the authoritative SEP list for a version is its changelog, `docs/specification/<version>/changelog.mdx` in the spec repo. Diff it against `ls src/seps/` to find gaps (governance SEPs like 932/994/1302/1730 have no protocol requirements — skip them).
- **SEP number ≠ PR number** — pre-draft-era SEPs are issue numbers; the spec diff landed in a separate PR (e.g. SEP-1036's spec text is PR #887, linked from the issue as "closed via"). Always pass `--spec-url` for released-version backfills; never rely on the PR lookup (a same-numbered unrelated PR can silently succeed with a wrong `spec_url`).
- **Quote the released page, not the draft** — read requirement text from `docs/specification/<version>/...`; the draft may have diverged since release (URL-mode elicitation's `elicitationId` and `notifications/elicitation/complete` were later removed from draft). Pin `spec_url` and every row `url:` to the `/<version>/` page, never `/draft/`.
- **Separate co-located SEPs** — a released page aggregates several SEPs (elicitation.mdx mixes SEP-1036, SEP-1330, SEP-1034). Diff the page against the previous released version to find what's new, then attribute sentences to the SEP you're covering and skip the neighbors'. Concretely, fetch both versions' page and diff them:

  ```bash
  base=https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification
  curl -sf "$base/2025-06-18/client/elicitation.mdx" -o /tmp/old.mdx
  curl -sf "$base/2025-11-25/client/elicitation.mdx" -o /tmp/new.mdx
  git diff --no-index /tmp/old.mdx /tmp/new.mdx
  ```

- **Exclusion sign-off moves to PR review** — Step 6's interactive `AskUserQuestion` sign-off is replaced by maintainer review of the draft PR for backfills: write the proposed `excluded:` rows with their rationales into the yaml and let maintainers approve or flip them on the PR.
- **Disposition reworded sentences explicitly** — diff sentences that were reworded but can't be attributed to a specific prior sentence (e.g. a SHOULD→MUST upgrade, or one old sentence split into two) must be dispositioned explicitly — a YAML comment on the row or a note in the PR description — so they don't fall through the traceability net.

## Step 9: Hand-off

Report to the user, in this order:

1. Path to the generated yaml.
2. Row counts: "`N check:` rows, `M excluded:` rows" — and note which exclusions the user signed off in Step 6.
3. Any requirements you left as `TODO:` and why.
4. **Host-scenario recommendation** from Step 8 — either "consider adding these checks to `src/scenarios/<suite>/<file>.ts` (it already exercises _X_)" or "no existing scenario covers this area; a new file is appropriate".
5. Remaining next steps the user owns:
   - add the checks to the host scenario (or create one) under `src/scenarios/{client,server,authorization-server}/`,
   - register any new scenario in `src/scenarios/index.ts` (`AGENTS.md:48`),
   - add a passing example to the everything-client/server and a negative test, per `AGENTS.md:74-81`.

Do **not** generate or edit scenario `.ts` files or touch `src/scenarios/index.ts`. The skill's scope ends at the yaml plus the recommendation.
