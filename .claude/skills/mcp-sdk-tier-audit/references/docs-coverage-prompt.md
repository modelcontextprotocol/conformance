# Documentation Coverage Subagent Prompt

You are evaluating the documentation coverage of an MCP SDK repository for the SEP-1730 tier assessment.

## Input

- **SDK path**: {local-path} (absolute path to local SDK checkout)

## Your Task

Evaluate the documentation quality and coverage of this MCP SDK against the canonical feature list. You need to determine:

1. **Tier 1 compliance**: Are ALL non-experimental features documented with examples?
2. **Tier 2 compliance**: Are core features documented (basic docs)?

## Steps

### 1. Read the canonical feature list

Read `references/feature-list.md` for the definitive list of 48 non-experimental features (plus 5 experimental) to evaluate. That file is the single source of truth — use every feature listed there, in order.

### 2. Find all documentation sources

The SDK is available at `{local-path}`. Search for documentation in these locations:

- `README.md` (root and any subdirectory READMEs)
- `docs/` directory
- `documentation/` directory
- `examples/` directory
- API documentation (generated or hand-written)
- `CONTRIBUTING.md`
- Inline code comments and docstrings on public API surfaces
- Any `*.md` files in the repo

```bash
# Find all markdown files
find {local-path} -name "*.md" -not -path "*/node_modules/*" -not -path "*/.git/*"

# Find example files
find {local-path} -path "*/examples/*" -not -path "*/node_modules/*"

# Find API docs
find {local-path} -path "*/docs/*" -not -path "*/node_modules/*"
```

### 3. Evaluate each feature

For each of the 48 non-experimental features in the canonical list, determine:

- **Documented?**: Is there documentation explaining this feature? (Yes/No)
- **Where**: File path and line numbers where documentation exists
- **Has Examples?**: Are there code examples showing how to use this feature? (Yes/No/N/A)
- **Verdict**: PASS (documented with examples), PARTIAL (documented but no examples), or FAIL (not documented)

## Required Output Format

Produce your assessment in this exact format:

```markdown
### Documentation Coverage Assessment

**SDK path**: {local-path}
**Documentation locations found**:

- {path1}: {description}
- {path2}: {description}
- ...

#### Feature Documentation Table

One row per feature from `references/feature-list.md`. Use the exact feature numbers and names from that file.

| #   | Feature                    | Documented? | Where          | Has Examples?           | Verdict           |
| --- | -------------------------- | ----------- | -------------- | ----------------------- | ----------------- |
| 1   | Tools - listing            | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 2   | Tools - calling            | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| ... | ...                        | ...         | ...            | ...                     | ...               |
| 48  | JSON Schema 2020-12        | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| —   | Tasks - get (experimental) | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | INFO              |
| ... | ...                        | ...         | ...            | ...                     | ...               |

All 48 non-experimental features MUST appear in the table. Do not skip or merge rows.

#### Summary

**Total non-experimental features**: 48
**PASS (documented with examples)**: {N}/48
**PARTIAL (documented, no examples)**: {N}/48
**FAIL (not documented)**: {N}/48

**Core features documented**: {N}/{total core} ({percentage}%)
**All features documented with examples**: {N}/48 ({percentage}%)

#### Tier Verdicts

**Tier 1** (all non-experimental features documented with examples): **PASS/FAIL**

- {If FAIL: list the features missing documentation or examples}

**Tier 2** (basic docs covering core features): **PASS/FAIL**

- {If FAIL: list the core features missing documentation}
```

## What Counts as "Documented"

A feature is "documented" only if there is **prose documentation** (in README, docs/, or similar) explaining what the feature does, when to use it, and how it works. The following do **not** count as documentation on their own:

- Example code without accompanying prose explanation
- Conformance test servers or test fixtures
- Source code, even with comments or docstrings
- Mere existence of an API (e.g., a function existing in the SDK)

**Examples supplement documentation but do not replace it.** A feature with a working example in `examples/` but no prose explaining the feature is PARTIAL, not PASS. A feature with only a conformance server implementation and no user-facing docs is FAIL.

### Verdict criteria

- **PASS**: Prose documentation exists explaining the feature AND at least one runnable or near-runnable code example
- **PARTIAL**: Either prose docs exist but no examples, OR examples exist but no prose docs
- **FAIL**: No prose documentation and no examples. Also use FAIL if the feature is only demonstrated in test/conformance code with no user-facing docs or examples

### What counts as an "example"

- Runnable code in an `examples/` directory
- Code snippets embedded in prose documentation (README, docs/\*.md)
- Go `Example*` test functions (these render on pkg.go.dev and are a language convention)
- Examples in test files count only if they are clearly labeled as examples or referenced from documentation

### What does NOT count as an example

- Conformance test server implementations
- Internal test fixtures
- Source code of the SDK itself

## Other Important Notes

- If the SDK does not implement a feature at all, mark it as "FAIL" for documentation but note "Not implemented" in the Where column.
- Be thorough: check README, docs/, examples/, API references, and inline docstrings.
- Apply these criteria consistently across all features. Do not give credit for documentation that doesn't exist.
