/**
 * SEP-2640 Skills extension — the `SKILL.md` manifest resource.
 *
 * One scenario, many checks (per AGENTS.md "fewer scenarios, more checks").
 * Each check's verbatim spec quote lives next to its check ID in
 * src/seps/sep-2640.yaml.
 *
 * Discovery is dynamic and brand-neutral: the scenario finds a `skill-md`
 * skill's `SKILL.md` resource from `resources/list` (preferred — it carries the
 * Resource `name`/`description` metadata) or falls back to the first `skill-md`
 * entry in `skill://index.json`, hardcoding no fixture skill. Undeclared
 * extension SKIPs; a declared extension with no discoverable `SKILL.md` reports
 * the missing prerequisite via untestableCheck (issue #248), never a silent
 * green.
 */

import { ClientScenario, ConformanceCheck } from '../../../types';
import { JsonRpcError, type RunContext } from '../../../connection';
import { untestableCheck } from '../../untestable';
import {
  SKILLS_EXTENSION_ID,
  SKILLS_META_PREFIX,
  SEP_2640_REF,
  type SkillIndex,
  type SkillResource,
  skillsCapability,
  skillsCheck,
  listAllResources,
  readSkillIndexText,
  readResourceText,
  skillNameFromManifestUri,
  parseFrontmatter
} from './helpers';

const MIMETYPE_ID = 'sep-2640-skillmd-mimetype';
const METADATA_NAME_ID = 'sep-2640-skillmd-metadata-name';
const METADATA_DESCRIPTION_ID = 'sep-2640-skillmd-metadata-description';
const FINAL_SEGMENT_ID = 'sep-2640-final-segment-equals-name';
const META_PREFIX_ID = 'sep-2640-meta-prefix';

const MARKDOWN_MIME = 'text/markdown';

/** A SKILL.md resource URI is skill://<skill-path>/SKILL.md. */
function isManifestUri(uri: string): boolean {
  return skillNameFromManifestUri(uri) !== undefined;
}

/** A `_meta` key that already carries a reverse-domain namespace (`vendor.tld/…`). */
function isNamespacedMetaKey(key: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(key);
}

export class SkillsManifestScenario implements ClientScenario {
  name = 'sep-2640-skills-manifest';
  readonly source = { extensionId: SKILLS_EXTENSION_ID } as const;
  description = `SEP-2640 Skills extension: the \`SKILL.md\` manifest resource.

**Resource**: \`skill://<skill-path>/SKILL.md\` (read via \`resources/read\`)

**Requirements covered** (each check carries a verbatim spec excerpt in src/seps/sep-2640.yaml):

- \`sep-2640-skillmd-mimetype\` — the SKILL.md resource \`mimeType\` SHOULD be \`text/markdown\`
- \`sep-2640-skillmd-metadata-name\` — the resource \`name\` SHOULD be the frontmatter \`name\`
- \`sep-2640-skillmd-metadata-description\` — the resource \`description\` SHOULD be the frontmatter \`description\`
- \`sep-2640-final-segment-equals-name\` — the final \`<skill-path>\` segment MUST equal the frontmatter \`name\`
- \`sep-2640-meta-prefix\` — un-namespaced skill \`_meta\` keys SHOULD use the \`io.modelcontextprotocol.skills/\` prefix

**Discovery is dynamic**: the scenario picks the first \`skill-md\` skill it finds. Undeclared extension SKIPs; a declared extension with no discoverable SKILL.md reports the missing prerequisite (not a silent skip).`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const conn = await ctx.connect();
    try {
      const skills = await skillsCapability(conn);
      const allIds = [
        MIMETYPE_ID,
        METADATA_NAME_ID,
        METADATA_DESCRIPTION_ID,
        FINAL_SEGMENT_ID,
        META_PREFIX_ID
      ];
      if (!skills) {
        const reason =
          'Server did not declare the io.modelcontextprotocol/skills extension; SKILL.md checks not applicable.';
        return allIds.map((id) =>
          skillsCheck(id, reason, 'SKIPPED', { errorMessage: reason })
        );
      }

      // === Dynamic discovery: resources/list first (carries Resource
      // metadata), then skill://index.json. ===
      const resources = await listAllResources(conn);
      const manifestResource: SkillResource | undefined = resources.find((r) =>
        isManifestUri(r.uri)
      );
      let manifestUri = manifestResource?.uri;
      if (!manifestUri) {
        const idx = await readSkillIndexText(conn);
        if (!('error' in idx) && typeof idx.text === 'string') {
          try {
            const index = JSON.parse(idx.text) as SkillIndex;
            const entry = (index.skills ?? []).find(
              (e) =>
                e.type === 'skill-md' &&
                typeof e.url === 'string' &&
                isManifestUri(e.url)
            );
            manifestUri = entry?.url;
          } catch {
            // A malformed index is the index scenario's concern; ignore here.
          }
        }
      }

      if (!manifestUri) {
        const reason =
          'no skill://<skill-path>/SKILL.md resource found via resources/list or skill://index.json';
        return [
          untestableCheck(
            MIMETYPE_ID,
            MIMETYPE_ID,
            'SKILL.md resource mimeType SHOULD be text/markdown.',
            reason,
            [SEP_2640_REF],
            'WARNING'
          ),
          untestableCheck(
            METADATA_NAME_ID,
            METADATA_NAME_ID,
            'SKILL.md resource name SHOULD match the frontmatter name.',
            reason,
            [SEP_2640_REF],
            'WARNING'
          ),
          untestableCheck(
            METADATA_DESCRIPTION_ID,
            METADATA_DESCRIPTION_ID,
            'SKILL.md resource description SHOULD match the frontmatter description.',
            reason,
            [SEP_2640_REF],
            'WARNING'
          ),
          untestableCheck(
            FINAL_SEGMENT_ID,
            FINAL_SEGMENT_ID,
            'The final <skill-path> segment MUST equal the frontmatter name.',
            reason,
            [SEP_2640_REF],
            'FAILURE'
          ),
          untestableCheck(
            META_PREFIX_ID,
            META_PREFIX_ID,
            'Skill _meta keys SHOULD use the io.modelcontextprotocol.skills/ prefix.',
            reason,
            [SEP_2640_REF],
            'WARNING'
          )
        ];
      }

      const checks: ConformanceCheck[] = [];

      // Read the manifest content (for mimeType, frontmatter, and _meta).
      let content:
        | { text: string; mimeType?: string; meta?: Record<string, unknown> }
        | undefined;
      let readError: string | undefined;
      try {
        content = await readResourceText(conn, manifestUri);
        if (!content) readError = 'resources/read returned no text content';
      } catch (e) {
        readError =
          e instanceof JsonRpcError
            ? `resources/read failed: code ${e.code}: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e);
      }

      // === skillmd-mimetype (SHOULD) ===
      // Prefer the read content's mimeType; fall back to the resources/list
      // Resource metadata mimeType.
      const mimeType = content?.mimeType ?? manifestResource?.mimeType;
      if (mimeType === undefined) {
        checks.push(
          untestableCheck(
            MIMETYPE_ID,
            MIMETYPE_ID,
            'SKILL.md resource mimeType SHOULD be text/markdown.',
            `no mimeType observable for ${manifestUri}${readError ? ` (${readError})` : ''}`,
            [SEP_2640_REF],
            'WARNING'
          )
        );
      } else {
        checks.push(
          skillsCheck(
            MIMETYPE_ID,
            'SKILL.md resource mimeType SHOULD be text/markdown.',
            mimeType === MARKDOWN_MIME ? 'SUCCESS' : 'WARNING',
            mimeType === MARKDOWN_MIME
              ? { details: { uri: manifestUri, mimeType } }
              : {
                  errorMessage: `expected mimeType "${MARKDOWN_MIME}", got ${JSON.stringify(mimeType)}`
                }
          )
        );
      }

      // Parse the frontmatter once for the name/description/final-segment checks.
      const frontmatter = content ? parseFrontmatter(content.text) : undefined;
      const fmName =
        typeof frontmatter?.name === 'string' ? frontmatter.name : undefined;
      const fmDescription =
        typeof frontmatter?.description === 'string'
          ? frontmatter.description
          : undefined;

      // === final-segment-equals-name (MUST) ===
      const uriName = skillNameFromManifestUri(manifestUri);
      if (fmName === undefined || uriName === undefined) {
        const missing =
          fmName === undefined
            ? `SKILL.md frontmatter has no string "name"${readError ? ` (${readError})` : ''}`
            : `could not derive the skill name from URI ${manifestUri}`;
        checks.push(
          untestableCheck(
            FINAL_SEGMENT_ID,
            FINAL_SEGMENT_ID,
            'The final <skill-path> segment MUST equal the frontmatter name.',
            missing,
            [SEP_2640_REF],
            'FAILURE'
          )
        );
      } else {
        checks.push(
          skillsCheck(
            FINAL_SEGMENT_ID,
            'The final <skill-path> segment of the SKILL.md URI MUST equal the frontmatter name.',
            uriName === fmName ? 'SUCCESS' : 'FAILURE',
            uriName === fmName
              ? { details: { uri: manifestUri, name: fmName } }
              : {
                  errorMessage: `final path segment "${uriName}" != frontmatter name "${fmName}"`
                }
          )
        );
      }

      // === skillmd-metadata-name (SHOULD) — needs the Resource metadata ===
      if (!manifestResource) {
        checks.push(
          untestableCheck(
            METADATA_NAME_ID,
            METADATA_NAME_ID,
            'SKILL.md resource name SHOULD match the frontmatter name.',
            `SKILL.md ${manifestUri} is not listed in resources/list, so its Resource name metadata is not observable`,
            [SEP_2640_REF],
            'WARNING'
          )
        );
      } else if (fmName === undefined) {
        checks.push(
          untestableCheck(
            METADATA_NAME_ID,
            METADATA_NAME_ID,
            'SKILL.md resource name SHOULD match the frontmatter name.',
            `SKILL.md frontmatter has no string "name" to compare against${readError ? ` (${readError})` : ''}`,
            [SEP_2640_REF],
            'WARNING'
          )
        );
      } else {
        checks.push(
          skillsCheck(
            METADATA_NAME_ID,
            'The SKILL.md resource name SHOULD be set from the frontmatter name.',
            manifestResource.name === fmName ? 'SUCCESS' : 'WARNING',
            manifestResource.name === fmName
              ? { details: { name: fmName } }
              : {
                  errorMessage: `resource name ${JSON.stringify(manifestResource.name)} != frontmatter name ${JSON.stringify(fmName)}`
                }
          )
        );
      }

      // === skillmd-metadata-description (SHOULD) — needs Resource metadata ===
      if (!manifestResource) {
        checks.push(
          untestableCheck(
            METADATA_DESCRIPTION_ID,
            METADATA_DESCRIPTION_ID,
            'SKILL.md resource description SHOULD match the frontmatter description.',
            `SKILL.md ${manifestUri} is not listed in resources/list, so its Resource description metadata is not observable`,
            [SEP_2640_REF],
            'WARNING'
          )
        );
      } else if (fmDescription === undefined) {
        checks.push(
          untestableCheck(
            METADATA_DESCRIPTION_ID,
            METADATA_DESCRIPTION_ID,
            'SKILL.md resource description SHOULD match the frontmatter description.',
            `SKILL.md frontmatter has no string "description" to compare against${readError ? ` (${readError})` : ''}`,
            [SEP_2640_REF],
            'WARNING'
          )
        );
      } else {
        checks.push(
          skillsCheck(
            METADATA_DESCRIPTION_ID,
            'The SKILL.md resource description SHOULD be set from the frontmatter description.',
            manifestResource.description === fmDescription
              ? 'SUCCESS'
              : 'WARNING',
            manifestResource.description === fmDescription
              ? { details: { description: fmDescription } }
              : {
                  errorMessage: `resource description ${JSON.stringify(manifestResource.description)} != frontmatter description ${JSON.stringify(fmDescription)}`
                }
          )
        );
      }

      // === meta-prefix (SHOULD, conditional on _meta keys being present) ===
      // Union the _meta of the read content and the resources/list Resource.
      const metaKeys = new Set<string>([
        ...Object.keys(content?.meta ?? {}),
        ...Object.keys(manifestResource?._meta ?? {})
      ]);
      if (metaKeys.size === 0) {
        checks.push(
          skillsCheck(
            META_PREFIX_ID,
            'When _meta keys are used for skill resources, they SHOULD use the io.modelcontextprotocol.skills/ reverse-domain prefix.',
            'SUCCESS',
            { details: { note: 'skill resource exposes no _meta keys' } }
          )
        );
      } else {
        // Only bare (un-namespaced) keys are flagged: a key already carrying a
        // reverse-domain namespace is the intended shape, whichever vendor.
        const bareKeys = [...metaKeys].filter((k) => !isNamespacedMetaKey(k));
        checks.push(
          skillsCheck(
            META_PREFIX_ID,
            'When _meta keys are used for skill resources, they SHOULD use the io.modelcontextprotocol.skills/ reverse-domain prefix.',
            bareKeys.length === 0 ? 'SUCCESS' : 'WARNING',
            bareKeys.length === 0
              ? { details: { metaKeys: [...metaKeys] } }
              : {
                  errorMessage: `un-namespaced skill _meta keys SHOULD use the ${SKILLS_META_PREFIX} prefix: ${bareKeys.join(', ')}`
                }
          )
        );
      }

      return checks;
    } finally {
      await conn.close();
    }
  }
}
