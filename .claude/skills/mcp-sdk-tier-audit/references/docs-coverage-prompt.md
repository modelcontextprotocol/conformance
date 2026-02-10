# Documentation Coverage Subagent Prompt

You are evaluating the documentation coverage of an MCP SDK repository for the SEP-1730 tier assessment.

## Input

- **Repository**: {repo} (e.g., `modelcontextprotocol/typescript-sdk`)
- **Branch**: {branch} (default branch if not specified)

## Your Task

Evaluate the documentation quality and coverage of this MCP SDK against the canonical feature list. You need to determine:

1. **Tier 1 compliance**: Are ALL non-experimental features documented with examples?
2. **Tier 2 compliance**: Are core features documented (basic docs)?

## Steps

### 1. Clone or access the repository

```bash
# If the repo is available locally, read from there
# Otherwise clone it:
gh repo clone {repo} /tmp/sdk-audit-docs -- --branch {branch} --depth 1
```

### 2. Find all documentation sources

Search for documentation in these locations:
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
find /path/to/repo -name "*.md" -not -path "*/node_modules/*" -not -path "*/.git/*"

# Find example files
find /path/to/repo -path "*/examples/*" -not -path "*/node_modules/*"

# Find API docs
find /path/to/repo -path "*/docs/*" -not -path "*/node_modules/*"
```

### 3. Evaluate each feature

For each feature in the canonical list below, determine:
- **Documented?**: Is there documentation explaining this feature? (Yes/No)
- **Where**: File path and line numbers where documentation exists
- **Has Examples?**: Are there code examples showing how to use this feature? (Yes/No/N/A)
- **Verdict**: PASS (documented with examples), PARTIAL (documented but no examples), or FAIL (not documented)

## Canonical Feature List to Check

### Core Features

**Tools:**
- Tools - listing (`tools/list`)
- Tools - calling (`tools/call`)
- Tools - text results
- Tools - image results
- Tools - audio results
- Tools - embedded resources
- Tools - error handling
- Tools - change notifications

**Resources:**
- Resources - listing (`resources/list`)
- Resources - reading text
- Resources - reading binary
- Resources - templates (`resources/templates/list`)
- Resources - template reading
- Resources - subscribing (`resources/subscribe`)
- Resources - unsubscribing (`resources/unsubscribe`)
- Resources - change notifications

**Prompts:**
- Prompts - listing (`prompts/list`)
- Prompts - getting simple
- Prompts - getting with arguments
- Prompts - embedded resources
- Prompts - image content
- Prompts - change notifications

**Sampling:**
- Sampling - creating messages (`sampling/createMessage`)

**Elicitation:**
- Elicitation - requesting input (`elicitation/create`) — form mode
- Elicitation - URL mode (`elicitation/create` with `mode: "url"`)
- Elicitation - schema validation
- Elicitation - default values
- Elicitation - enum values
- Elicitation - complete notification (`notifications/elicitation/complete`)

**Roots:**
- Roots - listing (`roots/list`)
- Roots - change notifications

**Logging:**
- Logging - sending log messages
- Logging - setting level (`logging/setLevel`)

**Completions:**
- Completions - resource argument completion
- Completions - prompt argument completion

**Ping:**
- Ping (`ping`)

### Transport Features
- Streamable HTTP transport (client)
- Streamable HTTP transport (server)
- SSE transport - legacy (client)
- SSE transport - legacy (server)
- stdio transport (client)
- stdio transport (server)

### Protocol Features
- Progress notifications
- Cancellation
- Pagination
- Capability negotiation (initialize/initialized)
- Protocol version negotiation
- JSON Schema 2020-12 support

### Experimental Features (does not count toward tier score)
- Tasks - get (`tasks/get`)
- Tasks - result (`tasks/result`)
- Tasks - cancel (`tasks/cancel`)
- Tasks - list (`tasks/list`)
- Tasks - status notifications (`notifications/tasks/status`)

## Required Output Format

Produce your assessment in this exact format:

```markdown
### Documentation Coverage Assessment

**Repository**: {repo}
**Branch**: {branch}
**Documentation locations found**:
- {path1}: {description}
- {path2}: {description}
- ...

#### Feature Documentation Table

| Feature | Documented? | Where | Has Examples? | Verdict |
|---------|-------------|-------|---------------|---------|
| Tools - listing | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Tools - calling | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Resources - listing | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Resources - reading text | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Resources - reading binary | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Resources - templates | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Resources - template reading | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Resources - subscribing | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Resources - unsubscribing | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Resources - change notifications | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Prompts - listing | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Prompts - getting simple | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Prompts - getting with args | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Prompts - embedded resources | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Prompts - image content | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Prompts - change notifications | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Sampling - creating messages | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Elicitation - form mode | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Elicitation - URL mode | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Elicitation - schema validation | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Elicitation - default values | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Elicitation - enum values | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Elicitation - complete notification | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Roots - listing | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Roots - change notifications | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Logging - sending log messages | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Logging - setting level | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Completions - resource argument | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Completions - prompt argument | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Ping | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Streamable HTTP - client | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Streamable HTTP - server | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| SSE transport - client | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| SSE transport - server | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| stdio transport - client | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| stdio transport - server | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Progress notifications | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Cancellation | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Pagination | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Capability negotiation | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| JSON Schema 2020-12 | Yes/No | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| Tasks - get (experimental) | Yes/No | {file}:{lines} | Yes ({N} examples) / No | INFO |
| Tasks - result (experimental) | Yes/No | {file}:{lines} | Yes ({N} examples) / No | INFO |
| Tasks - cancel (experimental) | Yes/No | {file}:{lines} | Yes ({N} examples) / No | INFO |
| Tasks - list (experimental) | Yes/No | {file}:{lines} | Yes ({N} examples) / No | INFO |
| Tasks - status notifications (experimental) | Yes/No | {file}:{lines} | Yes ({N} examples) / No | INFO |

#### Summary

**Total features**: {N}
**PASS (documented with examples)**: {N}
**PARTIAL (documented, no examples)**: {N}
**FAIL (not documented)**: {N}

**Core features documented**: {N}/{total core} ({percentage}%)
**All features documented with examples**: {N}/{total non-experimental} ({percentage}%)

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
