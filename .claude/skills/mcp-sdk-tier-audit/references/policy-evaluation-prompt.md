# Policy Evaluation Prompt

You are evaluating the governance and policy documentation of an MCP SDK repository for the SEP-1730 tier assessment.

## Input

- **SDK path**: {local-path} (absolute path to local SDK checkout)
- **Repository**: {repo} (GitHub `owner/repo`, derived from git remote)
- **CLI policy_signals**: {policy_signals_json} (from the tier-check CLI output — shows which files exist)

## Your Task

The CLI has already determined which policy files exist in the repository. Your job is to **read and evaluate the content** of the files that were found. Do NOT search for files in other locations — only evaluate what the CLI reported as present.

Three policy areas to evaluate:

1. **Dependency update policy** (required for Tier 1 and Tier 2)
2. **Roadmap** (Tier 1: published roadmap; Tier 2: published plan toward Tier 1)
3. **Versioning policy** (Tier 1 only: documented breaking change policy)

## Steps

### 1. Identify which files exist from CLI output

From the `policy_signals.files` object in the CLI JSON output, note which files have `true` (exist) vs `false` (missing).

The CLI checks these files:

**Dependency policy**: `DEPENDENCY_POLICY.md`, `docs/dependency-policy.md`, `.github/dependabot.yml`, `.github/renovate.json`, `renovate.json`

**Roadmap**: `ROADMAP.md`, `docs/roadmap.md`

**Versioning**: `VERSIONING.md`, `docs/versioning.md`, `BREAKING_CHANGES.md`

**General** (may contain relevant sections): `CONTRIBUTING.md`

### 2. Read and evaluate files that exist

For each file that the CLI reported as present, read its content at `{local-path}/{file}` and evaluate:

- Is the content substantive (not just a placeholder title)?
- Does it meet the criteria below?

**Do NOT** search the repo for policy information in other files. If the dedicated file doesn't exist, the policy is not published.

## Evaluation Criteria

### Dependency Update Policy

**PASS** if any of these exist with substantive content:

- `DEPENDENCY_POLICY.md` or `docs/dependency-policy.md` — must describe how and when dependencies are updated
- `.github/dependabot.yml` or `.github/renovate.json` or `renovate.json` — automated tooling counts as a published policy in practice

**FAIL** if none of the above exist (per CLI output).

### Roadmap

**PASS for Tier 1**: `ROADMAP.md` or `docs/roadmap.md` exists with concrete work items tracking MCP spec components.

**PASS for Tier 2**: Same file exists with at least a plan toward Tier 1, or explanation for remaining at Tier 2.

**FAIL** if no roadmap file exists (per CLI output).

### Versioning Policy

**PASS for Tier 1** if any of these exist with substantive content:

- `VERSIONING.md` or `docs/versioning.md` or `BREAKING_CHANGES.md`
- A clearly labeled "Versioning" or "Breaking Changes" section in `CONTRIBUTING.md` (only check if CONTRIBUTING.md exists per CLI output)

The content must describe: what constitutes a breaking change, how breaking changes are communicated, and the versioning scheme.

**Not required for Tier 2.**

**FAIL** if no versioning documentation found in the above files.

## Required Output Format

```markdown
### Policy Evaluation Assessment

**SDK path**: {local-path}
**Repository**: {repo}

---

#### 1. Dependency Update Policy: {PASS/FAIL}

| File                      | Exists (CLI) | Content Verdict                 |
| ------------------------- | ------------ | ------------------------------- |
| DEPENDENCY_POLICY.md      | Yes/No       | Substantive / Placeholder / N/A |
| docs/dependency-policy.md | Yes/No       | Substantive / Placeholder / N/A |
| .github/dependabot.yml    | Yes/No       | Configured / N/A                |
| .github/renovate.json     | Yes/No       | Configured / N/A                |

**Verdict**: **PASS/FAIL** — {one-line explanation}

---

#### 2. Roadmap: {PASS/FAIL}

| File            | Exists (CLI) | Content Verdict                 |
| --------------- | ------------ | ------------------------------- |
| ROADMAP.md      | Yes/No       | Substantive / Placeholder / N/A |
| docs/roadmap.md | Yes/No       | Substantive / Placeholder / N/A |

**Verdict**:

- **Tier 1**: **PASS/FAIL** — {one-line explanation}
- **Tier 2**: **PASS/FAIL** — {one-line explanation}

---

#### 3. Versioning Policy: {PASS/FAIL}

| File                                 | Exists (CLI) | Content Verdict                 |
| ------------------------------------ | ------------ | ------------------------------- |
| VERSIONING.md                        | Yes/No       | Substantive / Placeholder / N/A |
| docs/versioning.md                   | Yes/No       | Substantive / Placeholder / N/A |
| BREAKING_CHANGES.md                  | Yes/No       | Substantive / Placeholder / N/A |
| CONTRIBUTING.md (versioning section) | Yes/No       | Found / Not found / N/A         |

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

- Only evaluate files the CLI reported as existing. Do not search the repo for alternatives.
- If a file exists but is just a placeholder (e.g., only has a title with no content), mark it as "Placeholder" and FAIL.
- Dependabot/Renovate config files pass automatically if they exist and are properly configured.
- CHANGELOG.md showing past releases does NOT count as a roadmap.
