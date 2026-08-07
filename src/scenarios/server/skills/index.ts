/**
 * SEP-2640 Skills extension — `skill://index.json` enumeration surface.
 *
 * One scenario, many checks (per AGENTS.md "fewer scenarios, more checks").
 * Each check's verbatim spec quote lives next to its check ID in
 * src/seps/sep-2640.yaml, keeping the YAML and this scenario in lock-step.
 *
 * All discovery is dynamic and brand-neutral: the scenario reads the well-known
 * `skill://index.json` and validates whatever entries it finds, hardcoding no
 * fixture-specific skill name or URI. When the server does not declare the
 * skills extension the checks are SKIPPED (an optional, undeclared capability);
 * when the server declines the index (a permitted MAY) or serves an empty index
 * the index-shape checks are SKIPPED (legitimately not applicable), never
 * failed against a conformant server.
 */

import { ClientScenario, ConformanceCheck } from '../../../types';
import type { RunContext } from '../../../connection';
import {
  SKILLS_EXTENSION_ID,
  SKILL_INDEX_URI,
  SKILL_URI_SCHEME,
  SKILL_TYPES,
  SKILL_DIGEST_PATTERN,
  type SkillIndex,
  type SkillIndexEntry,
  skillsCapability,
  skillsCheck,
  readSkillIndexText
} from './helpers';

const ENTRY_CHECK_IDS = [
  'sep-2640-index-entry-type-enum',
  'sep-2640-index-name-required',
  'sep-2640-index-digest-required',
  'sep-2640-skill-uri-scheme'
] as const;

const ALL_CHECK_IDS = ['sep-2640-server-expose-index', ...ENTRY_CHECK_IDS];

export class SkillsIndexScenario implements ClientScenario {
  name = 'sep-2640-skills-index';
  readonly source = { extensionId: SKILLS_EXTENSION_ID } as const;
  description = `SEP-2640 Skills extension: the \`skill://index.json\` enumeration index.

**Resource**: \`skill://index.json\` (read via \`resources/read\`, \`mimeType\` \`application/json\`)

**Requirements covered** (each check carries a verbatim spec excerpt in src/seps/sep-2640.yaml):

- \`sep-2640-server-expose-index\` — server exposes a readable \`skill://index.json\` (SHOULD; a server MAY decline for an unenumerable catalog)
- \`sep-2640-index-entry-type-enum\` — every \`skills[].type\` is \`"skill-md"\` or \`"archive"\` (MUST)
- \`sep-2640-index-name-required\` — every entry carries a non-empty \`name\` (required field)
- \`sep-2640-index-digest-required\` — a present \`skills[].digest\` is \`sha256:{64 hex}\` (MUST)
- \`sep-2640-skill-uri-scheme\` — index entry URLs use the \`skill://\` scheme (SHOULD; another scheme is permitted only when listed in the index)

**Discovery is dynamic**: the scenario reads whatever skills the index enumerates. Undeclared extension, a declined index, or an empty index all SKIP cleanly.`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const conn = await ctx.connect();
    try {
      const skills = await skillsCapability(conn);
      if (!skills) {
        const reason =
          'Server did not declare the io.modelcontextprotocol/skills extension; index checks not applicable.';
        return ALL_CHECK_IDS.map((id) =>
          skillsCheck(id, reason, 'SKIPPED', { errorMessage: reason })
        );
      }

      const checks: ConformanceCheck[] = [];

      // === server-expose-index (SHOULD, with an explicit MAY-decline) ===
      const read = await readSkillIndexText(conn);
      if ('error' in read) {
        const reason = `Server declined skill://index.json (code ${read.error.code}); permitted MAY — the catalog may be large or unenumerable. Hosts MUST NOT treat this as proof of no skills.`;
        checks.push(
          skillsCheck(
            'sep-2640-server-expose-index',
            'Server SHOULD expose a readable skill://index.json enumerating the skills it serves.',
            'SKIPPED',
            { errorMessage: reason }
          )
        );
        for (const id of ENTRY_CHECK_IDS) {
          checks.push(
            skillsCheck(id, 'No skill://index.json to inspect.', 'SKIPPED', {
              errorMessage: reason
            })
          );
        }
        return checks;
      }

      if (read.text === undefined) {
        const reason =
          'resources/read on skill://index.json returned no text content; the index resource is exposed but unreadable.';
        checks.push(
          skillsCheck(
            'sep-2640-server-expose-index',
            'Server SHOULD expose a readable skill://index.json enumerating the skills it serves.',
            'FAILURE',
            { errorMessage: reason }
          )
        );
        for (const id of ENTRY_CHECK_IDS) {
          checks.push(
            skillsCheck(
              id,
              'No readable index content to inspect.',
              'SKIPPED',
              {
                errorMessage: reason
              }
            )
          );
        }
        return checks;
      }

      let index: SkillIndex;
      try {
        index = JSON.parse(read.text) as SkillIndex;
      } catch (e) {
        const reason = `skill://index.json content is not valid JSON: ${
          e instanceof Error ? e.message : String(e)
        }`;
        checks.push(
          skillsCheck(
            'sep-2640-server-expose-index',
            'Server SHOULD expose a readable skill://index.json whose content is a JSON index.',
            'FAILURE',
            { errorMessage: reason }
          )
        );
        for (const id of ENTRY_CHECK_IDS) {
          checks.push(
            skillsCheck(id, 'Index did not parse as JSON.', 'SKIPPED', {
              errorMessage: reason
            })
          );
        }
        return checks;
      }

      checks.push(
        skillsCheck(
          'sep-2640-server-expose-index',
          'Server SHOULD expose a readable skill://index.json whose content is a JSON index of the skills it serves.',
          'SUCCESS',
          {
            details: {
              uri: SKILL_INDEX_URI,
              mimeType: read.mimeType,
              skillCount: Array.isArray(index.skills) ? index.skills.length : 0
            }
          }
        )
      );

      const entries: SkillIndexEntry[] = Array.isArray(index.skills)
        ? index.skills
        : [];

      // An exposed-but-empty index is valid: a partial/empty index is
      // permitted, and hosts MUST NOT read "no skills" from it. Nothing to
      // validate at the entry level, so SKIP those checks cleanly.
      if (entries.length === 0) {
        const reason =
          'skill://index.json is exposed but lists no skills; entry-level checks not applicable (an empty index is permitted).';
        for (const id of ENTRY_CHECK_IDS) {
          checks.push(
            skillsCheck(id, reason, 'SKIPPED', { errorMessage: reason })
          );
        }
        return checks;
      }

      // === index-entry-type-enum (MUST) ===
      const typeErrs = entries
        .map((e, i) =>
          SKILL_TYPES.includes(e.type as (typeof SKILL_TYPES)[number])
            ? null
            : `skills[${i}].type=${JSON.stringify(e.type)} is not one of ${SKILL_TYPES.join('|')}`
        )
        .filter((x): x is string => x !== null);
      checks.push(
        skillsCheck(
          'sep-2640-index-entry-type-enum',
          'Every skills[].type MUST be "skill-md" or "archive".',
          typeErrs.length === 0 ? 'SUCCESS' : 'FAILURE',
          typeErrs.length === 0
            ? { details: { entryCount: entries.length } }
            : { errorMessage: typeErrs.join('; ') }
        )
      );

      // === index-name-required (required field) ===
      const nameErrs = entries
        .map((e, i) =>
          typeof e.name === 'string' && e.name.length > 0
            ? null
            : `skills[${i}].name is missing or empty`
        )
        .filter((x): x is string => x !== null);
      checks.push(
        skillsCheck(
          'sep-2640-index-name-required',
          'Every index entry carries a non-empty name (matching the SKILL.md frontmatter name and the final skill-path segment).',
          nameErrs.length === 0 ? 'SUCCESS' : 'FAILURE',
          nameErrs.length === 0
            ? { details: { entryCount: entries.length } }
            : { errorMessage: nameErrs.join('; ') }
        )
      );

      // === index-digest-required (MUST — validate the format when present) ===
      const withDigest = entries.filter((e) => e.digest !== undefined);
      const digestErrs = withDigest
        .map((e, i) =>
          typeof e.digest === 'string' && SKILL_DIGEST_PATTERN.test(e.digest)
            ? null
            : `skills[${i}].digest=${JSON.stringify(e.digest)} is not sha256:{64 lowercase hex}`
        )
        .filter((x): x is string => x !== null);
      checks.push(
        skillsCheck(
          'sep-2640-index-digest-required',
          'Every present skills[].digest MUST be formatted as sha256:{hex} with 64 lowercase hex characters.',
          digestErrs.length === 0 ? 'SUCCESS' : 'FAILURE',
          digestErrs.length === 0
            ? {
                details: {
                  entriesWithDigest: withDigest.length,
                  entriesWithoutDigest: entries.length - withDigest.length
                }
              }
            : { errorMessage: digestErrs.join('; ') }
        )
      );

      // === skill-uri-scheme (SHOULD) ===
      // Servers SHOULD use skill://; another scheme is permitted only when the
      // skill is listed in the index (SEP-2640 §URI convention), so a non-
      // skill:// URL is a SHOULD deviation, not a hard failure.
      const nonSkillScheme = entries
        .map((e, i) =>
          typeof e.url === 'string' && !e.url.startsWith(SKILL_URI_SCHEME)
            ? `skills[${i}].url=${JSON.stringify(e.url)}`
            : null
        )
        .filter((x): x is string => x !== null);
      checks.push(
        skillsCheck(
          'sep-2640-skill-uri-scheme',
          'Skill resource URLs in the index SHOULD use the skill:// URI scheme.',
          nonSkillScheme.length === 0 ? 'SUCCESS' : 'WARNING',
          nonSkillScheme.length === 0
            ? { details: { entryCount: entries.length } }
            : {
                errorMessage: `Entries use a non-skill:// scheme (permitted only when indexed): ${nonSkillScheme.join(', ')}`
              }
        )
      );

      return checks;
    } finally {
      await conn.close();
    }
  }
}
