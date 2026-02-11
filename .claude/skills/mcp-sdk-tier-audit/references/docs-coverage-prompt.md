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

## Important Notes

- A feature is "documented" if there is prose or API reference explaining what it does and how to use it. Mere existence of source code does not count as documentation.
- "Has examples" means there is runnable or near-runnable code showing the feature in use. This can be in docs, README, or an examples/ directory.
- Examples in test files count only if they are clearly labeled as examples or referenced from documentation.
- If the SDK does not implement a feature at all, mark it as "FAIL" for documentation but note "Not implemented" in the Where column.
- Be thorough: check README, docs/, examples/, API references, and inline docstrings.
