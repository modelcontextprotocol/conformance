# Policy Evaluation Subagent Prompt

You are evaluating the governance and policy documentation of an MCP SDK repository for the SEP-1730 tier assessment.

## Input

- **Repository**: {repo} (e.g., `modelcontextprotocol/typescript-sdk`)
- **Branch**: {branch} (default branch if not specified)

## Your Task

Evaluate three policy areas required by SEP-1730:
1. **Dependency update policy** (required for Tier 1 and Tier 2)
2. **Roadmap** (Tier 1: published roadmap; Tier 2: published plan toward Tier 1)
3. **Versioning policy** (Tier 1: clear versioning with documented breaking change policy)

## Steps

### 1. Clone or access the repository

```bash
# If the repo is available locally at ~/src/mcp/{sdk-name}, read from there
# Otherwise clone it:
gh repo clone {repo} /tmp/sdk-audit-policy -- --branch {branch} --depth 1
```

### 2. Search for policy documents

Check these files and locations for each policy area:

**Dependency Policy:**
- `CONTRIBUTING.md` (look for dependency/update sections)
- `SECURITY.md` (may reference dependency updates)
- `.github/dependabot.yml` or `.github/dependabot.yaml`
- `.github/renovate.json` or `renovate.json`
- `docs/` directory (any policy documents)
- `README.md` (may reference update policy)
- `DEPENDENCIES.md` or similar
- Any CI workflow files that run dependency updates

**Roadmap:**
- `ROADMAP.md`
- `docs/roadmap.md` or `docs/ROADMAP.md`
- `README.md` (roadmap section)
- GitHub Projects or Milestones (check via `gh` CLI)
- `CHANGELOG.md` (for evidence of planned work)
- Any file mentioning "roadmap" or "planned features"

**Versioning Policy:**
- `CONTRIBUTING.md` (versioning/release sections)
- `README.md` (versioning section)
- `CHANGELOG.md` (evidence of versioning practice)
- `docs/versioning.md` or similar
- `RELEASE.md` or `docs/releasing.md`
- Any documentation mentioning "breaking changes", "semver", "versioning"

```bash
# Search for policy-related content
grep -rli "dependency\|dependencies\|update policy\|dependabot\|renovate" /path/to/repo --include="*.md" --include="*.yml" --include="*.yaml" --include="*.json"
grep -rli "roadmap\|planned\|upcoming\|milestone" /path/to/repo --include="*.md"
grep -rli "breaking change\|semver\|versioning\|version policy\|release policy" /path/to/repo --include="*.md"
```

Also check GitHub-level resources:

```bash
# Check for GitHub milestones
gh api repos/{repo}/milestones --jq '.[].title'

# Check for GitHub projects
gh api repos/{repo}/projects --jq '.[].name' 2>/dev/null || echo "No classic projects"

# Check for releases and versioning pattern
gh release list --repo {repo} --limit 20
```

### 3. Evaluate each policy area

For each area, determine:
- Is there a published policy/document?
- What does it commit to? (specific commitments vs vague statements)
- Does it meet Tier 1 standards? Tier 2 standards?

## Evaluation Criteria

### Dependency Update Policy

**PASS for Tier 1 and Tier 2** requires:
- A published, findable policy describing how dependencies are updated
- The policy must include actual commitments (e.g., "updated monthly", "security patches within 48h")
- Automated tooling (Dependabot, Renovate) configured counts as evidence of policy in practice
- Simply having a lockfile or running `npm install` does NOT count

**Tier 1 additional**: Policy should be comprehensive -- covering frequency, security updates, major version handling

**FAIL** if:
- No dependency update policy found anywhere in the repo
- Only vague references like "we try to keep dependencies up to date"

### Roadmap

**PASS for Tier 1** requires:
- A published roadmap document with concrete steps and work items
- Must track implementation of MCP specification components (non-experimental features and optional capabilities)
- Must give users visibility into upcoming feature support
- Can be a ROADMAP.md, GitHub milestones/projects, or a section in docs

**PASS for Tier 2** requires:
- A published plan toward Tier 1 (what the SDK intends to implement to reach full support)
- OR an explanation of why the SDK will remain at Tier 2 (intentionally scoped)
- Can be simpler than a full roadmap

**FAIL** if:
- No roadmap or plan found
- Only a CHANGELOG showing past work (not forward-looking)

### Versioning Policy

**PASS for Tier 1** requires:
- Documented breaking change policy (what constitutes a breaking change, how they are communicated)
- Clear versioning pattern (SemVer or language-idiomatic equivalent)
- Users can understand compatibility expectations when upgrading

**Not required for Tier 2** (only needs a stable release >= 1.0.0)

**FAIL** if:
- No versioning documentation found
- No breaking change policy documented

## Required Output Format

Produce your assessment in this exact format:

```markdown
### Policy Evaluation Assessment

**Repository**: {repo}
**Branch**: {branch}

---

#### 1. Dependency Update Policy: {PASS/FAIL}

| What Was Checked | Where | Content Found | Verdict |
|---|---|---|---|
| CONTRIBUTING.md dependency section | {path}:{lines} or "Not found" | "{relevant quote}" or "No dependency section" | {Found/Not found} |
| Dependabot/Renovate config | {path} or "Not found" | "{config summary}" or "Not configured" | {Found/Not found} |
| README dependency section | {path}:{lines} or "Not found" | "{relevant quote}" or "No section" | {Found/Not found} |
| SECURITY.md dependency references | {path}:{lines} or "Not found" | "{relevant quote}" or "No references" | {Found/Not found} |
| CI dependency update workflows | {path} or "Not found" | "{workflow description}" or "None" | {Found/Not found} |
| Other policy documents | {path}:{lines} or "Not found" | "{relevant quote}" or "None" | {Found/Not found} |

**Policy content summary**: {Brief description of what the policy says, or "No dependency update policy found"}

**Tier 1 verdict**: **PASS/FAIL** -- {explanation}
**Tier 2 verdict**: **PASS/FAIL** -- {explanation}

---

#### 2. Roadmap: {PASS/FAIL}

| What Was Checked | Where | Content Found | Verdict |
|---|---|---|---|
| ROADMAP.md | {path} or "Not found" | "{summary}" or "File does not exist" | {Found/Not found} |
| README roadmap section | {path}:{lines} or "Not found" | "{summary}" or "No roadmap section" | {Found/Not found} |
| GitHub Milestones | {URL or count} | "{milestone names}" or "None" | {Found/Not found} |
| GitHub Projects | {URL or count} | "{project names}" or "None" | {Found/Not found} |
| docs/ roadmap documents | {path} or "Not found" | "{summary}" or "None" | {Found/Not found} |
| Other forward-looking docs | {path}:{lines} or "Not found" | "{summary}" or "None" | {Found/Not found} |

**Roadmap content summary**: {Brief description of the roadmap contents, or "No roadmap found"}

**Tier 1 verdict**: **PASS/FAIL** -- {explanation: does it track concrete spec component implementation?}
**Tier 2 verdict**: **PASS/FAIL** -- {explanation: is there a plan toward Tier 1?}

---

#### 3. Versioning Policy: {PASS/FAIL}

| What Was Checked | Where | Content Found | Verdict |
|---|---|---|---|
| CONTRIBUTING.md versioning section | {path}:{lines} or "Not found" | "{relevant quote}" or "No versioning section" | {Found/Not found} |
| README versioning section | {path}:{lines} or "Not found" | "{relevant quote}" or "No section" | {Found/Not found} |
| CHANGELOG.md versioning evidence | {path} or "Not found" | "{pattern observed}" or "Not found" | {Found/Not found} |
| Release docs | {path}:{lines} or "Not found" | "{relevant quote}" or "Not found" | {Found/Not found} |
| Breaking change documentation | {path}:{lines} or "Not found" | "{relevant quote}" or "Not found" | {Found/Not found} |
| Version pattern analysis | Release history | "{pattern}" (e.g., "Follows SemVer, X.Y.Z pattern") | {Consistent/Inconsistent} |

**Versioning content summary**: {Brief description of the versioning approach and breaking change policy, or "No versioning policy found"}

**Tier 1 verdict**: **PASS/FAIL** -- {explanation: is there a documented breaking change policy with clear versioning?}
**Tier 2 verdict**: **N/A** -- Tier 2 only requires at least one stable release (checked separately)

---

#### Overall Policy Summary

| Policy Area | Tier 1 | Tier 2 |
|---|---|---|
| Dependency Update Policy | PASS/FAIL | PASS/FAIL |
| Roadmap | PASS/FAIL | PASS/FAIL |
| Versioning Policy | PASS/FAIL | N/A |
```

## Important Notes

- Be factual and evidence-based. Quote actual content found in files.
- If a policy exists but is vague or insufficient, explain WHY it does not meet the standard.
- Automated dependency tooling (Dependabot, Renovate) configured and active counts as a published policy in practice, even without a separate written policy document.
- GitHub Milestones and Projects with concrete work items count as a roadmap.
- For versioning, look at both documentation AND practice (release history pattern).
- Include file:line references for every piece of evidence so reviewers can verify.
