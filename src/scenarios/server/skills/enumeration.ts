/**
 * SEP-2640 Skills extension — the `skills/list` and `skills/get` surface.
 *
 * Replaces the former `skill://index.json` scenario. The 2026-08-21 revision of
 * the SEP removed that well-known resource entirely (it appears nowhere in the
 * current text) and replaced it with two methods that every server declaring the
 * extension MUST implement.
 *
 * One scenario, many checks (per AGENTS.md "fewer scenarios, more checks").
 * Each check's verbatim spec quote lives next to its check ID in
 * src/seps/sep-2640.yaml, keeping the YAML and this scenario in lock-step.
 *
 * All discovery is dynamic and brand-neutral: the scenario enumerates whatever
 * the server serves and validates the entries it finds, hardcoding no
 * fixture-specific skill name or URI. When the server does not declare the
 * skills extension the checks are SKIPPED (an optional, undeclared capability).
 * An empty listing is explicitly permitted, so entry-level checks SKIP rather
 * than fail against a server with an unenumerable catalog.
 */

import { isDeepStrictEqual } from 'util';
import { ClientScenario, ConformanceCheck } from '../../../types';
import type { RunContext } from '../../../connection';
import {
  SKILLS_EXTENSION_ID,
  SKILLS_LIST_METHOD,
  SKILLS_GET_METHOD,
  SKILL_URI_SCHEME,
  SKILL_MANIFEST_FILENAME,
  SKILL_DIGEST_PATTERN,
  RESOURCES_DYNAMIC,
  MAX_RESOURCES_PER_SKILL,
  MAX_TOTAL_SIZE_PER_SKILL,
  FRONTMATTER_RESERVED_PREFIX,
  JSONRPC_INVALID_PARAMS,
  type SkillEntry,
  type SkillResourceEntry,
  declaredSkillsCapability,
  describeValue,
  resourcesCapabilityDeclared,
  isSettingsObject,
  skillsCheck,
  skillsListAll,
  skillsGet,
  settingsAreInline,
  skillNameFromManifestUri,
  skillRootFromManifestUri,
  isDynamicResources,
  resourcesArray,
  entryLabel,
  readResourceText,
  parseFrontmatter
} from './helpers';

const CAPABILITY_IDS = [
  'sep-2640-capability-declaration-inline',
  'sep-2640-capability-requires-resources',
  'sep-2640-capability-commits-to-methods',
  'sep-2640-capability-empty-object'
] as const;

const LIST_IDS = [
  'sep-2640-skills-list-implemented',
  'sep-2640-skills-list-pagination',
  'sep-2640-skills-list-entry-atomic',
  'sep-2640-skills-list-cache-attributes'
] as const;

const ENTRY_IDS = [
  'sep-2640-entry-uri-required',
  'sep-2640-entry-frontmatter-required',
  'sep-2640-entry-uri-matches-frontmatter-name',
  'sep-2640-skill-uri-scheme',
  'sep-2640-entry-resources-required',
  'sep-2640-resources-complete',
  'sep-2640-resources-uri-within-skill',
  'sep-2640-resources-digest-format',
  'sep-2640-resources-size-required',
  'sep-2640-limit-resources-per-skill',
  'sep-2640-limit-total-size',
  'sep-2640-metadata-reserved-prefix',
  'sep-2640-name-naming-rules',
  'sep-2640-authority-reg-name',
  'sep-2640-names-should-be-unique'
] as const;

const GET_IDS = [
  'sep-2640-skills-get-implemented',
  'sep-2640-skills-get-entry-shape',
  'sep-2640-skills-get-cache-attributes',
  'sep-2640-skills-get-no-cursor',
  'sep-2640-skills-get-unknown-uri-invalid-params'
] as const;

/** Emitted by the read-back pass, which fetches one listed SKILL.md. */
const READBACK_IDS = [
  'sep-2640-skillmd-required',
  'sep-2640-skillmd-frontmatter',
  'sep-2640-entry-frontmatter-identical'
] as const;

const ALL_CHECK_IDS = [
  ...CAPABILITY_IDS,
  ...LIST_IDS,
  ...ENTRY_IDS,
  ...GET_IDS,
  ...READBACK_IDS
];

/**
 * Agent Skills naming rules as the SEP defers to them: 1-64 characters,
 * lowercase alphanumeric and hyphens, with no leading, trailing or
 * consecutive hyphens. The leading/trailing rule falls out of the anchored
 * alphanumeric bookends; the consecutive one needs the `(?!.*--)` lookahead.
 */
const SKILL_NAME_PATTERN = /^(?!.*--)[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

/** RFC 3986 reg-name: unreserved / pct-encoded / sub-delims, case-insensitive. */
const REG_NAME_PATTERN = /^(?:[A-Za-z0-9\-._~!$&'()*+,;=]|%[0-9A-Fa-f]{2})*$/;

/** A URI that no conformant server should serve, for the -32602 probe. */
const UNKNOWN_SKILL_URI =
  'skill://mcp-conformance-nonexistent-skill-9f3a2b/SKILL.md';

function joinErrs(errs: string[], limit = 5): string {
  const shown = errs.slice(0, limit).join('; ');
  return errs.length > limit
    ? `${shown} (+${errs.length - limit} more)`
    : shown;
}

export class SkillsEnumerationScenario implements ClientScenario {
  name = 'sep-2640-skills-enumeration';
  readonly source = { extensionId: SKILLS_EXTENSION_ID } as const;
  description = `SEP-2640 Skills extension: \`skills/list\` enumeration and \`skills/get\` retrieval.

**Methods**: \`skills/list\`, \`skills/get\` (both mandatory for a server declaring \`io.modelcontextprotocol/skills\`)

**Requirements covered** (each check carries a verbatim spec excerpt in src/seps/sep-2640.yaml):

- \`sep-2640-capability-declaration-inline\` — extension settings sit inline under the identifier, per SEP-2133 (no \`config\` envelope)
- \`sep-2640-capability-commits-to-methods\` — declaring the extension commits the server to both methods
- \`sep-2640-skills-list-implemented\` — \`skills/list\` is implemented and returns a \`skills\` array
- \`sep-2640-skills-list-pagination\` — \`nextCursor\` is honoured as a cursor on the next request
- \`sep-2640-skills-list-entry-atomic\` — no skill entry is split across pages
- \`sep-2640-entry-uri-required\` / \`sep-2640-entry-frontmatter-required\` / \`sep-2640-entry-resources-required\` — the three required entry fields
- \`sep-2640-entry-uri-matches-frontmatter-name\` — the final skill-path segment equals \`frontmatter.name\`
- \`sep-2640-resources-complete\` — \`resources\` includes an entry matching the skill's own \`uri\`, each file once
- \`sep-2640-resources-uri-within-skill\` / \`sep-2640-resources-digest-format\` / \`sep-2640-resources-size-required\` — the \`{uri, digest, size}\` triple
- \`sep-2640-limit-resources-per-skill\` / \`sep-2640-limit-total-size\` — 512 entries, 16 MiB
- \`sep-2640-metadata-reserved-prefix\` — frontmatter \`metadata\` keys under \`io.modelcontextprotocol/\` are reserved
- \`sep-2640-skills-get-*\` — \`skills/get\` returns a list-shaped entry, carries no cursor, and answers \`-32602\` for an unknown URI

**Discovery is dynamic**: an undeclared extension SKIPs everything; an empty or partial listing is permitted and SKIPs the entry-level checks.`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const conn = await ctx.connect();
    try {
      const declaration = await declaredSkillsCapability(conn);
      if (!declaration.declared) {
        const reason =
          'Server did not declare the io.modelcontextprotocol/skills extension; enumeration checks not applicable.';
        return ALL_CHECK_IDS.map((id) =>
          skillsCheck(id, reason, 'SKIPPED', { errorMessage: reason })
        );
      }

      // Declared, but possibly with something that is not a settings object.
      // The remaining checks read no settings from a malformed declaration, so
      // they proceed against an empty one rather than aborting: `skills/list`
      // and `skills/get` are still owed by anything that declared at all.
      const declaredValue = declaration.value;
      const wellFormed = isSettingsObject(declaredValue);
      const skills: Record<string, unknown> = wellFormed ? declaredValue : {};

      const checks: ConformanceCheck[] = [];

      // === capability-empty-object ===
      // "An empty object indicates support for the extension with no optional
      // features." The observable half is the type: the declared value MUST be
      // an object, and an empty one is a valid declaration rather than a
      // malformed capability. A server declaring `true` fails here instead of
      // silently skipping the suite.
      checks.push(
        skillsCheck(
          'sep-2640-capability-empty-object',
          'An empty object indicates support for the extension with no optional features.',
          wellFormed ? 'SUCCESS' : 'FAILURE',
          wellFormed
            ? {
                details: {
                  declaredKeys: Object.keys(skills),
                  empty: Object.keys(skills).length === 0
                }
              }
            : {
                errorMessage: `capabilities.extensions["${SKILLS_EXTENSION_ID}"] is ${describeValue(declaredValue)}, not a settings object. An empty object is the way to declare support with no optional features.`,
                details: { observed: declaredValue }
              }
        )
      );

      // === capability-declaration-inline ===
      // SEP-2133 (Final) maps an extension identifier straight to its settings
      // object. An envelope hides settings from any spec-following client.
      if (wellFormed) {
        const { inline, envelopeKeys } = settingsAreInline(skills);
        checks.push(
          skillsCheck(
            'sep-2640-capability-declaration-inline',
            'Extension settings are a map of extension identifiers to per-extension settings objects; the settings sit directly under the identifier.',
            inline ? 'SUCCESS' : 'FAILURE',
            inline
              ? { details: { settingKeys: Object.keys(skills) } }
              : {
                  errorMessage: `capabilities.extensions["${SKILLS_EXTENSION_ID}"] carries envelope key(s) ${envelopeKeys.join(', ')} instead of the settings object itself. SEP-2133 (Final) defines no envelope, and SEP-2640's capability block places directoryRead inline.`,
                  details: { envelopeKeys, observed: skills }
                }
          )
        );
      } else {
        const reason =
          'the declared value is not a settings object, so there are no settings to place inline or in an envelope; see sep-2640-capability-empty-object';
        checks.push(
          skillsCheck(
            'sep-2640-capability-declaration-inline',
            'Extension settings are a map of extension identifiers to per-extension settings objects; the settings sit directly under the identifier.',
            'SKIPPED',
            { errorMessage: reason }
          )
        );
      }

      // === capability-requires-resources ===
      // Stated on the stable page as a consequence of the base Resources
      // spec rather than a new obligation: a server serving skill files
      // through resources/read already has to declare `resources`. Checkable
      // here because the declaration is on the wire either way.
      const hasResources = await resourcesCapabilityDeclared(conn);
      checks.push(
        skillsCheck(
          'sep-2640-capability-requires-resources',
          'A server declaring this extension MUST also declare the resources capability, because skill files are served through resources/read.',
          hasResources ? 'SUCCESS' : 'FAILURE',
          hasResources
            ? { details: { resources: true } }
            : {
                errorMessage:
                  'the server declares the skills extension but not the base `resources` capability, so a spec-following client has no basis to call resources/read for skill files.'
              }
        )
      );

      // === skills/list ===
      const listed = await skillsListAll(conn);
      if ('error' in listed) {
        const reason = `${SKILLS_LIST_METHOD} failed with code ${listed.error.code}: ${listed.error.message}. A server declaring the extension MUST implement it.`;
        checks.push(
          skillsCheck(
            'sep-2640-capability-commits-to-methods',
            'Declaring the extension commits the server to skills/list and skills/get.',
            'FAILURE',
            { errorMessage: reason }
          ),
          skillsCheck(
            'sep-2640-skills-list-implemented',
            'A server declaring the extension MUST implement the skills/list method.',
            'FAILURE',
            { errorMessage: reason }
          )
        );
        for (const id of [
          'sep-2640-skills-list-pagination',
          'sep-2640-skills-list-entry-atomic',
          ...ENTRY_IDS,
          ...GET_IDS,
          ...READBACK_IDS
        ]) {
          checks.push(
            skillsCheck(id, 'skills/list is unavailable.', 'SKIPPED', {
              errorMessage: reason
            })
          );
        }
        return checks;
      }

      const { entries, pages, truncated } = listed;

      checks.push(
        skillsCheck(
          'sep-2640-skills-list-implemented',
          'A server declaring the extension MUST implement the skills/list method, which returns the skills it serves. The result MAY be empty.',
          'SUCCESS',
          {
            details: {
              pages: pages.length,
              entries: entries.length,
              emptyListingPermitted: entries.length === 0
            }
          }
        )
      );

      // === skills-list-pagination ===
      // Multi-page runs prove the cursor round-trips. A single page is a clean
      // pass: the contract is "when nextCursor is present, pass it back", and
      // skillsListAll did exactly that to reach the end.
      checks.push(
        skillsCheck(
          'sep-2640-skills-list-pagination',
          'Pagination mirrors the base protocol: the request accepts an optional cursor, and when the result includes nextCursor the client passes it back.',
          truncated ? 'FAILURE' : 'SUCCESS',
          truncated
            ? {
                errorMessage: `skills/list did not terminate: the server kept returning a nextCursor (or repeated one) across ${pages.length} pages.`
              }
            : { details: { pages: pages.length } }
        )
      );

      // === skills-list-entry-atomic ===
      // "An entry is atomic — a skill's resources set is never split across
      // pages." Observable as a URI appearing in more than one page.
      const uriPages = new Map<string, number[]>();
      pages.forEach((page, pageIdx) => {
        for (const e of page.entries) {
          if (typeof e.uri !== 'string') continue;
          const seen = uriPages.get(e.uri) ?? [];
          if (!seen.includes(pageIdx)) seen.push(pageIdx);
          uriPages.set(e.uri, seen);
        }
      });
      const split = [...uriPages.entries()]
        .filter(([, p]) => p.length > 1)
        .map(([uri, p]) => `${uri} appears on pages ${p.join(', ')}`);
      checks.push(
        skillsCheck(
          'sep-2640-skills-list-entry-atomic',
          "An entry is atomic — a skill's resources set is never split across pages.",
          split.length === 0 ? 'SUCCESS' : 'FAILURE',
          split.length === 0
            ? { details: { pages: pages.length, distinctUris: uriPages.size } }
            : { errorMessage: joinErrs(split) }
        )
      );

      // === skills-list-cache-attributes ===
      // SEP-2549 attributes exist only from 2026-07-28. Below that they are
      // not merely optional, they are undefined by the negotiated schema, so
      // a server that omits them is correct and a WARNING is a false
      // positive. From 2026-07-28 they are required, so a missing one is a
      // FAILURE rather than something to shrug at. Reported by Sam Bloomberg
      // against the Go SDK, which was correct in both directions while this
      // check graded it wrong in both.
      const first = pages[0]?.result ?? {};
      const hasTtl = first.ttlMs !== undefined;
      const hasScope = first.cacheScope !== undefined;
      const cacheAttrsApply = ctx.specVersion >= '2026-07-28';

      if (!cacheAttrsApply) {
        checks.push(
          skillsCheck(
            'sep-2640-skills-list-cache-attributes',
            "In protocol versions 2026-07-28 and later, the skills/list result carries the base protocol's list-caching attributes ttlMs and cacheScope (SEP-2549).",
            'SKIPPED',
            {
              errorMessage: `not applicable on negotiated protocol ${ctx.specVersion}: ttlMs and cacheScope are defined from 2026-07-28`,
              details: {
                specVersion: ctx.specVersion,
                ttlMs: first.ttlMs,
                cacheScope: first.cacheScope
              }
            }
          )
        );
      } else {
        const missing = [!hasTtl && 'ttlMs', !hasScope && 'cacheScope']
          .filter(Boolean)
          .join(' and ');
        checks.push(
          skillsCheck(
            'sep-2640-skills-list-cache-attributes',
            "In protocol versions 2026-07-28 and later, the skills/list result carries the base protocol's list-caching attributes ttlMs and cacheScope (SEP-2549).",
            hasTtl && hasScope ? 'SUCCESS' : 'FAILURE',
            hasTtl && hasScope
              ? {
                  details: { ttlMs: first.ttlMs, cacheScope: first.cacheScope }
                }
              : {
                  errorMessage: `skills/list result omits ${missing} on protocol ${ctx.specVersion}, where SEP-2549 requires both.`
                }
          )
        );
      }

      if (entries.length === 0) {
        const reason =
          'skills/list returned no entries; entry-level checks not applicable. A server whose catalog is large, generated on demand, or otherwise unenumerable MAY return an empty listing.';
        for (const id of [...ENTRY_IDS, ...GET_IDS, ...READBACK_IDS]) {
          checks.push(
            skillsCheck(id, reason, 'SKIPPED', { errorMessage: reason })
          );
        }
        checks.push(
          skillsCheck(
            'sep-2640-capability-commits-to-methods',
            'Declaring the extension commits the server to skills/list and skills/get.',
            'SUCCESS',
            { details: { note: 'skills/list answered; listing is empty.' } }
          )
        );
        return checks;
      }

      checks.push(...entryChecks(entries));
      checks.push(...(await getChecks(conn, entries, ctx.specVersion)));
      checks.push(...(await readbackChecks(conn, entries)));

      return checks;
    } finally {
      await conn.close();
    }
  }
}

/** Validate every `skills[]` entry against the §Discovery entry schema. */
function entryChecks(entries: SkillEntry[]): ConformanceCheck[] {
  const checks: ConformanceCheck[] = [];

  // === entry-uri-required ===
  const uriErrs = entries
    .map((e, i) =>
      typeof e.uri === 'string' && e.uri.length > 0
        ? null
        : `skills[${i}].uri is missing or not a string`
    )
    .filter((x): x is string => x !== null);
  checks.push(
    skillsCheck(
      'sep-2640-entry-uri-required',
      "Every entry carries uri, the full resource URI of the skill's SKILL.md.",
      uriErrs.length === 0 ? 'SUCCESS' : 'FAILURE',
      uriErrs.length === 0
        ? { details: { entryCount: entries.length } }
        : { errorMessage: joinErrs(uriErrs) }
    )
  );

  // === entry-frontmatter-required ===
  // Verbatim frontmatter, so name and description are always present.
  const fmErrs: string[] = [];
  entries.forEach((e, i) => {
    const fm = e.frontmatter;
    if (!fm || typeof fm !== 'object' || Array.isArray(fm)) {
      fmErrs.push(
        `${entryLabel(e, i)}: frontmatter is missing or not an object`
      );
      return;
    }
    const obj = fm as Record<string, unknown>;
    if (typeof obj.name !== 'string' || obj.name.length === 0) {
      fmErrs.push(`${entryLabel(e, i)}: frontmatter.name is missing or empty`);
    }
    if (typeof obj.description !== 'string' || obj.description.length === 0) {
      fmErrs.push(
        `${entryLabel(e, i)}: frontmatter.description is missing or empty`
      );
    }
  });
  checks.push(
    skillsCheck(
      'sep-2640-entry-frontmatter-required',
      "frontmatter is the skill's SKILL.md YAML frontmatter rendered verbatim as a JSON object; because the Agent Skills specification requires name and description, those fields are always present.",
      fmErrs.length === 0 ? 'SUCCESS' : 'FAILURE',
      fmErrs.length === 0
        ? { details: { entryCount: entries.length } }
        : { errorMessage: joinErrs(fmErrs) }
    )
  );

  // === entry-uri-matches-frontmatter-name ===
  const nameErrs: string[] = [];
  entries.forEach((e) => {
    if (typeof e.uri !== 'string') return;
    const fm = e.frontmatter as Record<string, unknown> | undefined;
    const declared = fm && typeof fm.name === 'string' ? fm.name : undefined;
    if (declared === undefined) return;
    const fromUri = skillNameFromManifestUri(e.uri);
    if (fromUri === undefined) {
      nameErrs.push(
        `${e.uri}: does not end in /${SKILL_MANIFEST_FILENAME}, so the skill name is not recoverable from the URI`
      );
    } else if (fromUri !== declared) {
      nameErrs.push(
        `${e.uri}: final skill-path segment "${fromUri}" !== frontmatter.name "${declared}"`
      );
    }
  });
  checks.push(
    skillsCheck(
      'sep-2640-entry-uri-matches-frontmatter-name',
      "The final <skill-path> segment of the entry's uri MUST equal frontmatter.name.",
      nameErrs.length === 0 ? 'SUCCESS' : 'FAILURE',
      nameErrs.length === 0
        ? { details: { entryCount: entries.length } }
        : { errorMessage: joinErrs(nameErrs) }
    )
  );

  // === skill-uri-scheme (SHOULD) ===
  // "Servers SHOULD use the skill:// URI scheme", but a server MAY serve
  // skills under another scheme native to its domain and no scheme is
  // privileged, so a deviation is a WARNING rather than a failure.
  const otherScheme = entries
    .filter(
      (e) => typeof e.uri === 'string' && !e.uri.startsWith(SKILL_URI_SCHEME)
    )
    .map((e) => String(e.uri));
  checks.push(
    skillsCheck(
      'sep-2640-skill-uri-scheme',
      'Servers SHOULD use the skill:// URI scheme for the resources of a skill.',
      otherScheme.length === 0 ? 'SUCCESS' : 'WARNING',
      otherScheme.length === 0
        ? { details: { entryCount: entries.length } }
        : {
            errorMessage: `Entries served under another scheme (explicitly permitted; no scheme is privileged): ${joinErrs(otherScheme)}`
          }
    )
  );

  // === entry-resources-required ===
  const resErrs: string[] = [];
  entries.forEach((e, i) => {
    if (isDynamicResources(e)) return;
    if (resourcesArray(e) !== undefined) return;
    resErrs.push(
      `${entryLabel(e, i)}: resources is ${JSON.stringify(e.resources)}, neither an array nor "${RESOURCES_DYNAMIC}"`
    );
  });
  checks.push(
    skillsCheck(
      'sep-2640-entry-resources-required',
      'resources is REQUIRED on every skill entry and takes one of two forms: an array of {uri, digest, size} triples, or the string "dynamic". An entry with no resources at all, or with any other value, is invalid.',
      resErrs.length === 0 ? 'SUCCESS' : 'FAILURE',
      resErrs.length === 0
        ? {
            details: {
              entryCount: entries.length,
              dynamicEntries: entries.filter(isDynamicResources).length
            }
          }
        : { errorMessage: joinErrs(resErrs) }
    )
  );

  // Entries carrying an array are the only ones the remaining checks apply to.
  const arrayEntries = entries
    .map((e, i) => ({ e, i, arr: resourcesArray(e) }))
    .filter(
      (x): x is { e: SkillEntry; i: number; arr: SkillResourceEntry[] } =>
        x.arr !== undefined
    );

  const dynamicOnlyReason =
    'Every entry declares "resources": "dynamic", which publishes no file manifest; the resources-array checks are not applicable.';

  if (arrayEntries.length === 0) {
    for (const id of [
      'sep-2640-resources-complete',
      'sep-2640-resources-uri-within-skill',
      'sep-2640-resources-digest-format',
      'sep-2640-resources-size-required',
      'sep-2640-limit-resources-per-skill',
      'sep-2640-limit-total-size'
    ]) {
      checks.push(
        skillsCheck(id, dynamicOnlyReason, 'SKIPPED', {
          errorMessage: dynamicOnlyReason
        })
      );
    }
  } else {
    // === resources-complete ===
    // Observable half: an entry matching the skill's own uri, and no file
    // listed twice. Full completeness (every file of the skill) cannot be
    // confirmed from the wire without a second source of truth.
    const completeErrs: string[] = [];
    for (const { e, i, arr } of arrayEntries) {
      const own = typeof e.uri === 'string' ? e.uri : undefined;
      if (own && !arr.some((r) => r.uri === own)) {
        completeErrs.push(
          `${entryLabel(e, i)}: resources has no entry matching the skill's own uri (the SKILL.md digest and size)`
        );
      }
      const seen = new Set<string>();
      const dupes = new Set<string>();
      for (const r of arr) {
        if (typeof r.uri !== 'string') continue;
        if (seen.has(r.uri)) dupes.add(r.uri);
        seen.add(r.uri);
      }
      if (dupes.size > 0) {
        completeErrs.push(
          `${entryLabel(e, i)}: resources lists ${[...dupes].join(', ')} more than once`
        );
      }
    }
    checks.push(
      skillsCheck(
        'sep-2640-resources-complete',
        'When present, resources MUST be complete: it lists every file of the skill, each exactly once, including an entry matching the skill top-level uri — that entry carries the digest and size of SKILL.md itself.',
        completeErrs.length === 0 ? 'SUCCESS' : 'FAILURE',
        completeErrs.length === 0
          ? { details: { entriesChecked: arrayEntries.length } }
          : { errorMessage: joinErrs(completeErrs) }
      )
    );

    // === resources-uri-within-skill ===
    const containErrs: string[] = [];
    for (const { e, i, arr } of arrayEntries) {
      const own = typeof e.uri === 'string' ? e.uri : undefined;
      const root = own ? skillRootFromManifestUri(own) : undefined;
      if (!root) continue;
      for (const r of arr) {
        if (typeof r.uri !== 'string') {
          containErrs.push(`${entryLabel(e, i)}: a resources entry has no uri`);
          continue;
        }
        if (r.uri !== own && !r.uri.startsWith(`${root}/`)) {
          containErrs.push(
            `${entryLabel(e, i)}: ${r.uri} is outside the skill directory ${root}`
          );
        }
      }
    }
    checks.push(
      skillsCheck(
        'sep-2640-resources-uri-within-skill',
        "Each uri MUST be the skill's SKILL.md or a file within the skill's directory.",
        containErrs.length === 0 ? 'SUCCESS' : 'FAILURE',
        containErrs.length === 0
          ? { details: { entriesChecked: arrayEntries.length } }
          : { errorMessage: joinErrs(containErrs) }
      )
    );

    // === resources-digest-format ===
    const digestErrs: string[] = [];
    for (const { e, i, arr } of arrayEntries) {
      for (const r of arr) {
        if (
          typeof r.digest !== 'string' ||
          !SKILL_DIGEST_PATTERN.test(r.digest)
        ) {
          digestErrs.push(
            `${entryLabel(e, i)}: ${String(r.uri)} digest=${JSON.stringify(r.digest)} is not sha256:{64 lowercase hex}`
          );
        }
      }
    }
    checks.push(
      skillsCheck(
        'sep-2640-resources-digest-format',
        "Digests are SHA-256 hashes of an artifact's raw bytes, formatted as sha256:{hex} where {hex} is 64 lowercase hexadecimal characters.",
        digestErrs.length === 0 ? 'SUCCESS' : 'FAILURE',
        digestErrs.length === 0
          ? { details: { entriesChecked: arrayEntries.length } }
          : { errorMessage: joinErrs(digestErrs) }
      )
    );

    // === resources-size-required ===
    const sizeErrs: string[] = [];
    for (const { e, i, arr } of arrayEntries) {
      for (const r of arr) {
        if (
          typeof r.size !== 'number' ||
          !Number.isInteger(r.size) ||
          r.size < 0
        ) {
          sizeErrs.push(
            `${entryLabel(e, i)}: ${String(r.uri)} size=${JSON.stringify(r.size)} is not a non-negative integer`
          );
        }
      }
    }
    checks.push(
      skillsCheck(
        'sep-2640-resources-size-required',
        "Each entry MUST carry size: the length in bytes of the file's raw content — the same bytes the digest covers.",
        sizeErrs.length === 0 ? 'SUCCESS' : 'FAILURE',
        sizeErrs.length === 0
          ? { details: { entriesChecked: arrayEntries.length } }
          : { errorMessage: joinErrs(sizeErrs) }
      )
    );

    // === limit-resources-per-skill (SHOULD NOT exceed) ===
    const overCount = arrayEntries
      .filter(({ arr }) => arr.length > MAX_RESOURCES_PER_SKILL)
      .map(({ e, i, arr }) => `${entryLabel(e, i)}: ${arr.length} entries`);
    checks.push(
      skillsCheck(
        'sep-2640-limit-resources-per-skill',
        'Servers SHOULD NOT serve a skill exceeding 512 resource entries, counted over the entries of the skill resources, SKILL.md included.',
        overCount.length === 0 ? 'SUCCESS' : 'WARNING',
        overCount.length === 0
          ? {
              details: {
                maxObserved: Math.max(
                  ...arrayEntries.map(({ arr }) => arr.length)
                ),
                limit: MAX_RESOURCES_PER_SKILL
              }
            }
          : { errorMessage: joinErrs(overCount) }
      )
    );

    // === limit-total-size (SHOULD NOT exceed) ===
    const sums = arrayEntries.map(({ e, i, arr }) => ({
      label: entryLabel(e, i),
      total: arr.reduce(
        (acc, r) => acc + (typeof r.size === 'number' ? r.size : 0),
        0
      )
    }));
    const overSize = sums
      .filter((s) => s.total > MAX_TOTAL_SIZE_PER_SKILL)
      .map((s) => `${s.label}: ${s.total} bytes`);
    checks.push(
      skillsCheck(
        'sep-2640-limit-total-size',
        'Servers SHOULD NOT serve a skill whose total file size exceeds 16 MiB (16,777,216 bytes), summed over the skill resources.',
        overSize.length === 0 ? 'SUCCESS' : 'WARNING',
        overSize.length === 0
          ? {
              details: {
                maxObservedBytes: Math.max(...sums.map((s) => s.total)),
                limit: MAX_TOTAL_SIZE_PER_SKILL
              }
            }
          : { errorMessage: joinErrs(overSize) }
      )
    );
  }

  // === metadata-reserved-prefix ===
  // This extension currently defines no keys under the reserved prefix, so a
  // server publishing one is squatting on a namespace reserved for MCP.
  const reservedErrs: string[] = [];
  entries.forEach((e, i) => {
    const fm = e.frontmatter as Record<string, unknown> | undefined;
    const meta = fm?.metadata;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return;
    for (const key of Object.keys(meta as Record<string, unknown>)) {
      if (key.startsWith(FRONTMATTER_RESERVED_PREFIX)) {
        reservedErrs.push(
          `${entryLabel(e, i)}: frontmatter.metadata["${key}"]`
        );
      }
    }
  });
  checks.push(
    skillsCheck(
      'sep-2640-metadata-reserved-prefix',
      'Within the frontmatter metadata object, keys prefixed with io.modelcontextprotocol/ are reserved for metadata defined by MCP extensions. This extension currently defines no such keys.',
      reservedErrs.length === 0 ? 'SUCCESS' : 'WARNING',
      reservedErrs.length === 0
        ? { details: { entryCount: entries.length } }
        : {
            errorMessage: `Keys under the reserved prefix, which this extension does not currently define: ${joinErrs(reservedErrs)}`
          }
    )
  );

  // === name-naming-rules ===
  // The name is recoverable from the URI alone, so this is checkable without
  // fetching anything.
  const badNames: string[] = [];
  entries.forEach((e, i) => {
    if (typeof e.uri !== 'string') return;
    const name = skillNameFromManifestUri(e.uri);
    if (name !== undefined && !SKILL_NAME_PATTERN.test(name)) {
      badNames.push(`${entryLabel(e, i)}: name "${name}"`);
    }
  });
  checks.push(
    skillsCheck(
      'sep-2640-name-naming-rules',
      "The final <skill-path> segment, being the skill name, MUST satisfy the Agent Skills specification's naming rules (1-64 characters, lowercase alphanumeric and hyphens, no leading, trailing or consecutive hyphens).",
      badNames.length === 0 ? 'SUCCESS' : 'FAILURE',
      badNames.length === 0
        ? { details: { entryCount: entries.length } }
        : { errorMessage: joinErrs(badNames) }
    )
  );

  // === authority-reg-name (SHOULD) ===
  const badAuthority: string[] = [];
  entries.forEach((e, i) => {
    if (typeof e.uri !== 'string') return;
    const schemeEnd = e.uri.indexOf('://');
    if (schemeEnd < 0) return;
    const segments = e.uri
      .slice(schemeEnd + 3)
      .split('/')
      .filter((x) => x.length > 0);
    const authority = segments[0];
    if (authority !== undefined && !REG_NAME_PATTERN.test(authority)) {
      badAuthority.push(`${entryLabel(e, i)}: authority "${authority}"`);
    }
  });
  checks.push(
    skillsCheck(
      'sep-2640-authority-reg-name',
      'The first <skill-path> segment occupies the authority component and SHOULD be a valid reg-name per RFC 3986.',
      badAuthority.length === 0 ? 'SUCCESS' : 'WARNING',
      badAuthority.length === 0
        ? { details: { entryCount: entries.length } }
        : { errorMessage: joinErrs(badAuthority) }
    )
  );

  // === names-should-be-unique (SHOULD) ===
  // A collision is explicitly permitted — two skills at different paths may
  // share a final segment — so this is a WARNING that tells a host operator the
  // listing will need disambiguating, not a failure.
  const byName = new Map<string, string[]>();
  entries.forEach((e) => {
    if (typeof e.uri !== 'string') return;
    const n = skillNameFromManifestUri(e.uri);
    if (n === undefined) return;
    byName.set(n, [...(byName.get(n) ?? []), e.uri]);
  });
  const collisions = [...byName.entries()]
    .filter(([, uris]) => uris.length > 1)
    .map(([n, uris]) => `"${n}" served at ${uris.join(' and ')}`);
  checks.push(
    skillsCheck(
      'sep-2640-names-should-be-unique',
      "Within a server's listing, names SHOULD be unique, but they are not guaranteed to be.",
      collisions.length === 0 ? 'SUCCESS' : 'WARNING',
      collisions.length === 0
        ? { details: { distinctNames: byName.size } }
        : {
            errorMessage: `Names collide within one listing, so hosts MUST disambiguate them: ${joinErrs(collisions)}`
          }
    )
  );

  return checks;
}

/**
 * Fetch one listed `SKILL.md` and check it against the entry that advertised
 * it. This is the server-side half of the host's frontmatter-comparison MUST:
 * if the entry's `frontmatter` does not match the file, no conforming host can
 * load the skill.
 */
async function readbackChecks(
  conn: Parameters<typeof readResourceText>[0],
  entries: SkillEntry[]
): Promise<ConformanceCheck[]> {
  const checks: ConformanceCheck[] = [];
  const sample = entries.find(
    (e) =>
      typeof e.uri === 'string' && e.uri.endsWith(`/${SKILL_MANIFEST_FILENAME}`)
  );
  const uri = sample?.uri as string | undefined;

  if (!uri) {
    const reason = `No listed entry has a uri ending in /${SKILL_MANIFEST_FILENAME}, so no SKILL.md can be read back.`;
    for (const id of READBACK_IDS) {
      checks.push(skillsCheck(id, reason, 'SKIPPED', { errorMessage: reason }));
    }
    return checks;
  }

  let body: Awaited<ReturnType<typeof readResourceText>>;
  try {
    body = await readResourceText(conn, uri);
  } catch (e) {
    const reason = `resources/read on ${uri} failed: ${e instanceof Error ? e.message : String(e)}`;
    checks.push(
      skillsCheck(
        'sep-2640-skillmd-required',
        'Every skill MUST contain a SKILL.md file at its root.',
        'FAILURE',
        { errorMessage: reason }
      )
    );
    for (const id of [
      'sep-2640-skillmd-frontmatter',
      'sep-2640-entry-frontmatter-identical'
    ]) {
      checks.push(
        skillsCheck(id, 'SKILL.md is unreadable.', 'SKIPPED', {
          errorMessage: reason
        })
      );
    }
    return checks;
  }

  if (!body) {
    const reason = `resources/read on ${uri} returned no text content, so the listed SKILL.md is not retrievable.`;
    checks.push(
      skillsCheck(
        'sep-2640-skillmd-required',
        'Every skill MUST contain a SKILL.md file at its root.',
        'FAILURE',
        { errorMessage: reason }
      )
    );
    for (const id of [
      'sep-2640-skillmd-frontmatter',
      'sep-2640-entry-frontmatter-identical'
    ]) {
      checks.push(
        skillsCheck(id, 'No SKILL.md content to inspect.', 'SKIPPED', {
          errorMessage: reason
        })
      );
    }
    return checks;
  }

  checks.push(
    skillsCheck(
      'sep-2640-skillmd-required',
      'Every skill MUST contain a SKILL.md file at its root.',
      'SUCCESS',
      { details: { uri, bytes: body.text.length } }
    )
  );

  // === skillmd-frontmatter ===
  const fm = parseFrontmatter(body.text);
  const fmErrs: string[] = [];
  if (!fm) {
    fmErrs.push('SKILL.md has no leading --- delimited YAML frontmatter block');
  } else {
    if (typeof fm.name !== 'string' || fm.name.length === 0) {
      fmErrs.push('frontmatter has no non-empty name');
    }
    if (typeof fm.description !== 'string' || fm.description.length === 0) {
      fmErrs.push('frontmatter has no non-empty description');
    }
  }
  checks.push(
    skillsCheck(
      'sep-2640-skillmd-frontmatter',
      'SKILL.md MUST begin with YAML frontmatter containing at minimum the name and description fields.',
      fmErrs.length === 0 ? 'SUCCESS' : 'FAILURE',
      fmErrs.length === 0
        ? { details: { uri } }
        : { errorMessage: `${uri}: ${fmErrs.join('; ')}` }
    )
  );

  // === entry-frontmatter-identical ===
  const declared = sample?.frontmatter as Record<string, unknown> | undefined;
  if (
    !fm ||
    !declared ||
    typeof declared !== 'object' ||
    Array.isArray(declared)
  ) {
    const reason =
      'Either the file has no parseable frontmatter or the entry carries no frontmatter object, so the two cannot be compared.';
    checks.push(
      skillsCheck(
        'sep-2640-entry-frontmatter-identical',
        'The frontmatter object MUST be identical in content to the frontmatter of the SKILL.md it describes.',
        'SKIPPED',
        { errorMessage: reason }
      )
    );
    return checks;
  }

  const diffs: string[] = [];
  const keys = new Set([...Object.keys(fm), ...Object.keys(declared)]);
  // Content, not serialisation: an encoder that orders map keys differently
  // from the YAML source (Go's encoding/json sorts them) still describes the
  // same frontmatter.
  for (const k of keys) {
    if (isDeepStrictEqual(fm[k] ?? null, declared[k] ?? null)) continue;
    diffs.push(
      `${k}: file=${JSON.stringify(fm[k] ?? null)} entry=${JSON.stringify(declared[k] ?? null)}`
    );
  }
  checks.push(
    skillsCheck(
      'sep-2640-entry-frontmatter-identical',
      'The frontmatter object MUST be identical in content to the frontmatter of the SKILL.md it describes.',
      diffs.length === 0 ? 'SUCCESS' : 'FAILURE',
      diffs.length === 0
        ? { details: { uri, fields: [...keys] } }
        : {
            errorMessage: `${uri}: entry frontmatter differs from the file's: ${joinErrs(diffs)}`
          }
    )
  );

  return checks;
}

/** Exercise `skills/get` against a real entry and against an unknown URI. */
async function getChecks(
  conn: Parameters<typeof skillsGet>[0],
  entries: SkillEntry[],
  specVersion: string
): Promise<ConformanceCheck[]> {
  const checks: ConformanceCheck[] = [];
  const sample = entries.find((e) => typeof e.uri === 'string');
  const sampleUri = sample?.uri as string | undefined;

  if (!sampleUri) {
    const reason =
      'No listed entry carries a uri, so skills/get cannot be exercised against a known skill.';
    for (const id of GET_IDS) {
      checks.push(skillsCheck(id, reason, 'SKIPPED', { errorMessage: reason }));
    }
    return checks;
  }

  const got = await skillsGet(conn, sampleUri);
  if ('error' in got) {
    const reason = `${SKILLS_GET_METHOD} failed for a skill the server itself listed (${sampleUri}) with code ${got.error.code}: ${got.error.message}.`;
    checks.push(
      skillsCheck(
        'sep-2640-capability-commits-to-methods',
        'Declaring the extension commits the server to skills/list and skills/get.',
        'FAILURE',
        { errorMessage: reason }
      ),
      skillsCheck(
        'sep-2640-skills-get-implemented',
        'A server declaring the extension MUST also implement the skills/get method, which returns the entry for a single skill named by its URI.',
        'FAILURE',
        { errorMessage: reason }
      )
    );
    for (const id of [
      'sep-2640-skills-get-entry-shape',
      'sep-2640-skills-get-no-cursor',
      'sep-2640-skills-get-unknown-uri-invalid-params'
    ]) {
      checks.push(
        skillsCheck(id, 'skills/get is unavailable.', 'SKIPPED', {
          errorMessage: reason
        })
      );
    }
    return checks;
  }

  checks.push(
    skillsCheck(
      'sep-2640-capability-commits-to-methods',
      'Declaring the extension itself commits the server to skills/list and skills/get.',
      'SUCCESS',
      { details: { methods: [SKILLS_LIST_METHOD, SKILLS_GET_METHOD] } }
    ),
    skillsCheck(
      'sep-2640-skills-get-implemented',
      'A server declaring the extension MUST also implement the skills/get method, which returns the entry for a single skill named by its URI.',
      'SUCCESS',
      { details: { probedUri: sampleUri } }
    )
  );

  // === skills-get-entry-shape ===
  const skill = got.result.skill as SkillEntry | undefined;
  const shapeErrs: string[] = [];
  if (!skill || typeof skill !== 'object' || Array.isArray(skill)) {
    shapeErrs.push('result.skill is missing or not an object');
  } else {
    if (skill.uri !== sampleUri) {
      shapeErrs.push(
        `result.skill.uri=${JSON.stringify(skill.uri)} does not echo the requested uri ${sampleUri}`
      );
    }
    if (
      !skill.frontmatter ||
      typeof skill.frontmatter !== 'object' ||
      Array.isArray(skill.frontmatter)
    ) {
      shapeErrs.push('result.skill.frontmatter is missing or not an object');
    }
    if (!isDynamicResources(skill) && resourcesArray(skill) === undefined) {
      shapeErrs.push(
        `result.skill.resources=${JSON.stringify(skill.resources)} is neither an array nor "${RESOURCES_DYNAMIC}"`
      );
    }
  }
  checks.push(
    skillsCheck(
      'sep-2640-skills-get-entry-shape',
      'The skill object is a skill entry, identical in shape and meaning to an entry of skills/list — the same uri, frontmatter, and resources fields, under the same rules.',
      shapeErrs.length === 0 ? 'SUCCESS' : 'FAILURE',
      shapeErrs.length === 0
        ? { details: { probedUri: sampleUri } }
        : { errorMessage: joinErrs(shapeErrs) }
    )
  );

  // === skills-get-no-cursor ===
  const hasCursor = got.result.nextCursor !== undefined;
  checks.push(
    skillsCheck(
      'sep-2640-skills-get-no-cursor',
      'The result carries no pagination cursor: a single entry is not a list.',
      hasCursor ? 'FAILURE' : 'SUCCESS',
      hasCursor
        ? {
            errorMessage: `skills/get returned nextCursor=${JSON.stringify(got.result.nextCursor)}; a single entry is not a list.`
          }
        : { details: { probedUri: sampleUri } }
    )
  );

  // === skills-get-cache-attributes ===
  // SEP-2640 left this open ("whether the result should also carry the base
  // protocol's caching attributes ... is left open"); the stable page closed
  // it in the affirmative on 2026-09-10 (ext-skills#139). Gated the same way
  // as the skills/list check: below 2026-07-28 CacheableResult is undefined
  // by the negotiated schema, so omission is correct rather than a defect.
  const getResult = got.result as Record<string, unknown>;
  const getTtl = getResult.ttlMs !== undefined;
  const getScope = getResult.cacheScope !== undefined;
  const getCacheApplies = specVersion >= '2026-07-28';
  const getCacheText =
    'GetSkillResult extends CacheableResult, so ttlMs and cacheScope are REQUIRED, as they are on resources/read.';

  if (!getCacheApplies) {
    checks.push(
      skillsCheck(
        'sep-2640-skills-get-cache-attributes',
        getCacheText,
        'SKIPPED',
        {
          errorMessage: `not applicable on negotiated protocol ${specVersion}: ttlMs and cacheScope are defined from 2026-07-28`,
          details: {
            specVersion,
            ttlMs: getResult.ttlMs,
            cacheScope: getResult.cacheScope
          }
        }
      )
    );
  } else {
    const missing = [!getTtl && 'ttlMs', !getScope && 'cacheScope']
      .filter(Boolean)
      .join(' and ');
    checks.push(
      skillsCheck(
        'sep-2640-skills-get-cache-attributes',
        getCacheText,
        getTtl && getScope ? 'SUCCESS' : 'FAILURE',
        getTtl && getScope
          ? {
              details: {
                ttlMs: getResult.ttlMs,
                cacheScope: getResult.cacheScope
              }
            }
          : {
              errorMessage: `skills/get result omits ${missing} on protocol ${specVersion}, where the stable spec page requires both.`
            }
      )
    );
  }

  // === skills-get-unknown-uri-invalid-params ===
  const unknown = await skillsGet(conn, UNKNOWN_SKILL_URI);
  if ('error' in unknown) {
    const ok = unknown.error.code === JSONRPC_INVALID_PARAMS;
    checks.push(
      skillsCheck(
        'sep-2640-skills-get-unknown-uri-invalid-params',
        'If the URI does not identify a skill the server serves, the server MUST return error -32602 (Invalid params).',
        ok ? 'SUCCESS' : 'FAILURE',
        ok
          ? {
              details: {
                probedUri: UNKNOWN_SKILL_URI,
                code: unknown.error.code
              }
            }
          : {
              errorMessage: `skills/get on an unserved URI returned code ${unknown.error.code} (${unknown.error.message}); expected ${JSONRPC_INVALID_PARAMS}.`
            }
      )
    );
  } else {
    checks.push(
      skillsCheck(
        'sep-2640-skills-get-unknown-uri-invalid-params',
        'If the URI does not identify a skill the server serves, the server MUST return error -32602 (Invalid params).',
        'FAILURE',
        {
          errorMessage: `skills/get returned a successful result for ${UNKNOWN_SKILL_URI}, which no conformant server should serve; expected error ${JSONRPC_INVALID_PARAMS}.`
        }
      )
    );
  }

  return checks;
}
