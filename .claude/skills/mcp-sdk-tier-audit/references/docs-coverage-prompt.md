# Documentation Coverage Subagent Prompt

You are evaluating the documentation coverage of an MCP SDK repository for the SEP-1730 tier assessment.

## Input

- **SDK path**: {local-path} (absolute path to local SDK checkout)

## Your Task

Evaluate the documentation quality and coverage of this MCP SDK against the canonical feature list. You need to determine:

1. **Tier 1 compliance**: Are ALL non-experimental features documented with examples?
2. **Tier 2 compliance**: Are core features documented (basic docs)?

## Steps

### 1. Find all documentation sources

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

**SDK path**: {local-path}
**Documentation locations found**:

- {path1}: {description}
- {path2}: {description}
- ...

#### Feature Documentation Table

| # | Feature                                     | Documented? | Where          | Has Examples?           | Verdict           |
|---|---------------------------------------------|-------------|----------------|-------------------------| ------------------|
| 1 | Tools - listing                             | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 2 | Tools - calling                             | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 3 | Tools - text results                        | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 4 | Tools - image results                       | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 5 | Tools - audio results                       | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 6 | Tools - embedded resources                  | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 7 | Tools - error handling                      | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 8 | Tools - change notifications                | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 9 | Resources - listing                         | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 10 | Resources - reading text                   | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 11 | Resources - reading binary                 | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 12 | Resources - templates                      | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 13 | Resources - template reading               | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 14 | Resources - subscribing                    | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 15 | Resources - unsubscribing                  | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 16 | Resources - change notifications           | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 17 | Prompts - listing                          | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 18 | Prompts - getting simple                   | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 19 | Prompts - getting with args                | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 20 | Prompts - embedded resources               | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 21 | Prompts - image content                    | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 22 | Prompts - change notifications             | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 23 | Sampling - creating messages               | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 24 | Elicitation - form mode                    | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 25 | Elicitation - URL mode                     | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 26 | Elicitation - schema validation            | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 27 | Elicitation - default values               | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 28 | Elicitation - enum values                  | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 29 | Elicitation - complete notification        | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 30 | Roots - listing                            | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 31 | Roots - change notifications               | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 32 | Logging - sending log messages             | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 33 | Logging - setting level                    | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 34 | Completions - resource argument            | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 35 | Completions - prompt argument              | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 36 | Ping                                       | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 37 | Streamable HTTP - client                   | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 38 | Streamable HTTP - server                   | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 39 | SSE transport - client                     | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 40 | SSE transport - server                     | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 41 | stdio transport - client                   | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 42 | stdio transport - server                   | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 43 | Progress notifications                     | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 44 | Cancellation                               | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 45 | Pagination                                 | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 46 | Capability negotiation                     | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 47 | Protocol version negotiation               | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| 48 | JSON Schema 2020-12                        | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | PASS/PARTIAL/FAIL |
| — | Tasks - get (experimental)                 | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | INFO              |
| — | Tasks - result (experimental)              | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | INFO              |
| — | Tasks - cancel (experimental)              | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | INFO              |
| — | Tasks - list (experimental)                | Yes/No      | {file}:{lines} | Yes ({N} examples) / No | INFO              |
| — | Tasks - status notifications (experimental)| Yes/No      | {file}:{lines} | Yes ({N} examples) / No | INFO              |

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
