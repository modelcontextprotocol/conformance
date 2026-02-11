# Policy Evaluation Prompt

You are evaluating the governance and policy documentation of an MCP SDK repository for the SEP-1730 tier assessment.

## Input

- **SDK path**: {local-path} (absolute path to local SDK checkout)
- **Repository**: {repo} (GitHub `owner/repo`, derived from git remote)

## Your Task

Check whether three required policy documents exist as files in the repository. This is a simple file-existence check — if the file exists and has substantive content, it passes.

1. **Dependency update policy** (required for Tier 1 and Tier 2)
2. **Roadmap** (Tier 1: published roadmap; Tier 2: published plan toward Tier 1)
3. **Versioning policy** (Tier 1 only: documented breaking change policy)

## Steps

### 1. Check for policy files

```bash
# Dependency update policy
ls {local-path}/DEPENDENCY_POLICY.md {local-path}/docs/dependency-policy.md 2>/dev/null

# Also check for automated dependency tooling as evidence
ls {local-path}/.github/dependabot.yml {local-path}/.github/renovate.json {local-path}/renovate.json 2>/dev/null

# Roadmap
ls {local-path}/ROADMAP.md {local-path}/docs/roadmap.md 2>/dev/null

# Versioning / breaking change policy
ls {local-path}/VERSIONING.md {local-path}/docs/versioning.md {local-path}/BREAKING_CHANGES.md 2>/dev/null

# Also check CONTRIBUTING.md and CHANGELOG.md for versioning sections
ls {local-path}/CONTRIBUTING.md {local-path}/CHANGELOG.md 2>/dev/null
```

### 2. Evaluate each policy area

For each area, check:
- Does a dedicated file exist?
- If no dedicated file, is there a clearly labeled section in CONTRIBUTING.md or README.md?
- Is the content substantive (not just a placeholder)?

## Evaluation Criteria

### Dependency Update Policy

**PASS** if any of these exist with substantive content:
- `DEPENDENCY_POLICY.md` or `docs/dependency-policy.md`
- A clearly labeled "Dependency Updates" or "Dependency Policy" section in `CONTRIBUTING.md`
- Configured Dependabot (`.github/dependabot.yml`) or Renovate (`.github/renovate.json`) — automated tooling counts as a published policy in practice

**FAIL** if none of the above exist.

### Roadmap

**PASS for Tier 1**: `ROADMAP.md` or `docs/roadmap.md` exists with concrete work items tracking MCP spec components.

**PASS for Tier 2**: Same file exists with at least a plan toward Tier 1, or explanation for remaining at Tier 2.

**FAIL** if no roadmap file exists. GitHub milestones alone are not sufficient — there must be a file in the repo.

### Versioning Policy

**PASS for Tier 1** if any of these exist with substantive content:
- `VERSIONING.md` or `docs/versioning.md` or `BREAKING_CHANGES.md`
- A clearly labeled "Versioning" or "Breaking Changes" section in `CONTRIBUTING.md`

The content must describe: what constitutes a breaking change, how breaking changes are communicated, and the versioning scheme (SemVer or language-idiomatic equivalent).

**Not required for Tier 2** (only needs a stable release >= 1.0.0, checked separately).

**FAIL** if no versioning documentation found.

## Required Output Format

Produce your assessment in this exact format:

```markdown
### Policy Evaluation Assessment

**SDK path**: {local-path}
**Repository**: {repo}

---

#### 1. Dependency Update Policy: {PASS/FAIL}

| File Checked | Exists? | Path |
|---|---|---|
| DEPENDENCY_POLICY.md | Yes/No | {path} or N/A |
| docs/dependency-policy.md | Yes/No | {path} or N/A |
| .github/dependabot.yml | Yes/No | {path} or N/A |
| .github/renovate.json | Yes/No | {path} or N/A |
| CONTRIBUTING.md (dependency section) | Yes/No | {path}:{lines} or N/A |

**Verdict**: **PASS/FAIL** — {one-line explanation}

---

#### 2. Roadmap: {PASS/FAIL}

| File Checked | Exists? | Path |
|---|---|---|
| ROADMAP.md | Yes/No | {path} or N/A |
| docs/roadmap.md | Yes/No | {path} or N/A |

**Verdict**:
- **Tier 1**: **PASS/FAIL** — {one-line explanation}
- **Tier 2**: **PASS/FAIL** — {one-line explanation}

---

#### 3. Versioning Policy: {PASS/FAIL}

| File Checked | Exists? | Path |
|---|---|---|
| VERSIONING.md | Yes/No | {path} or N/A |
| docs/versioning.md | Yes/No | {path} or N/A |
| BREAKING_CHANGES.md | Yes/No | {path} or N/A |
| CONTRIBUTING.md (versioning section) | Yes/No | {path}:{lines} or N/A |

**Verdict**:
- **Tier 1**: **PASS/FAIL** — {one-line explanation}
- **Tier 2**: **N/A** — only requires stable release

---

#### Overall Policy Summary

| Policy Area              | Tier 1    | Tier 2    |
| ------------------------ | --------- | --------- |
| Dependency Update Policy | PASS/FAIL | PASS/FAIL |
| Roadmap                  | PASS/FAIL | PASS/FAIL |
| Versioning Policy        | PASS/FAIL | N/A       |
```

## Important Notes

- This is primarily a file-existence check. If the file exists and has real content (not just a title), it passes.
- Do NOT search through the entire repo looking for scattered references. The policy must be in a dedicated file or a clearly labeled section in CONTRIBUTING.md.
- Dependabot/Renovate configuration counts as a dependency policy — it's a published, machine-readable commitment.
- CHANGELOG.md showing past releases does NOT count as a roadmap (it's backward-looking, not forward-looking).
