---
name: new-sep
description: >-
  Scaffold a sep-NNNN.yaml requirement-traceability file for the MCP
  conformance repo from a SEP PR's spec diff. Runs the new-sep CLI, then
  parses the modelcontextprotocol/modelcontextprotocol spec diff to populate
  `requirements[]` with the RFC 2119 sentences and proposed check IDs.
argument-hint: '<sep-number> [--target client|server|authorization-server]'
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
- **--target client|server|authorization-server** (optional): which scenarios subdirectory to write to. Inferred from the spec path if omitted.

## Step 2: Generate the skeleton

Run the CLI:

```bash
npm run --silent build
node dist/index.js new-sep <NNNN> [--target <target>]
```

(For development against a non-built source tree: `npx tsx src/index.ts new-sep ...`.)

The CLI writes `src/scenarios/<target>/sep-<NNNN>.yaml` with `sep`, `spec_url`, and two TODO `requirements[]` rows. Capture the output path from the CLI's `Wrote …` line and remember it as `$YAML`.

If the CLI errors with "does not change any docs/specification/draft/\*.mdx", the SEP's spec changes landed in a separate PR — ask the user for the spec file path and rerun with `--spec-path docs/specification/draft/<path>`. Do not guess.

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

The bullet inherits `SHOULD`. The yaml row should quote the _combined_ obligation: `'Servers SHOULD return standard JSON-RPC errors for common failure cases: Resource not found: -32602 (Invalid Params)'` — see `src/scenarios/server/sep-2164.yaml` for the canonical example.

**Regex alone is insufficient** (this is called out in Issue #243). Read for context: pronouns, "the server", and "such cases" all refer back to the lead-in.

## Step 5: Map severity → check vs. excluded

From `AGENTS.md:50-56`:

| Keyword                                        | Severity                  | YAML field                 |
| ---------------------------------------------- | ------------------------- | -------------------------- |
| MUST / MUST NOT / SHALL / SHALL NOT / REQUIRED | FAILURE                   | `check: sep-<NNNN>-<slug>` |
| SHOULD / SHOULD NOT                            | WARNING                   | `check: sep-<NNNN>-<slug>` |
| MAY / OPTIONAL                                 | (not enforced as a check) | `excluded: '<reason>'`     |

If a requirement is testable in principle but you can't see how to drive it from the harness, write a `check:` row anyway and leave it for the human to wire up — do **not** silently demote to `excluded:`.

Use `excluded:` only when the requirement genuinely can't be protocol-observed (e.g. "clients SHOULD also accept -32002" — the conformance harness tests servers, so client-side acceptance is not observable here). When you use `excluded:`, write the reason verbatim and add an `issue:` URL if there's a tracking issue.

Slug convention: lowercase-kebab, derived from the verb phrase. Examples from `sep-2164.yaml`: `no-empty-contents`, `error-code`. Same `id` is used for SUCCESS and FAILURE (`AGENTS.md:52`).

## Step 6: Rewrite the YAML

Replace the two TODO rows the CLI generated with one row per extracted requirement. Preserve the CLI's quoting style (single quotes, two-space indent — see `src/scenarios/server/sep-2164.yaml`).

If a requirement is ambiguous or you're not confident, leave it as a `TODO:` row rather than guessing — humans review this yaml before scenarios get written.

Also fix the `spec_url`: the CLI emits the page URL with no anchor. If the requirements you extracted live under a specific spec subsection (e.g. `#error-handling`), append it.

If a requirement comes from a **different spec page** than `spec_url` (the SEP touched multiple `.mdx` files — the CLI prints these as "PR also changes N other spec file(s)"), give that row a full `url:` override:

```yaml
- text: '...'
  check: sep-NNNN-slug
  url: https://modelcontextprotocol.io/specification/draft/other/page#anchor
```

A row's effective spec reference is `row.url ?? file.spec_url`.

Write the result back to `$YAML`.

## Step 7: Hand-off

Report to the user, in this order:

1. Path to the generated yaml.
2. Number of rows extracted (e.g. "3 `check:` rows, 1 `excluded:` row").
3. Any requirements you marked TODO and why.
4. Reminder of the next steps the user still owns:
   - implement the TypeScript scenario under `src/scenarios/<target>/`,
   - register it in the appropriate suite list in `src/scenarios/index.ts` (`AGENTS.md:48`),
   - add a passing example to the everything-client/server and a negative test, per `AGENTS.md:74-81`.

Do **not** generate the scenario `.ts` file or touch `src/scenarios/index.ts`. The skill's scope ends at the yaml.
