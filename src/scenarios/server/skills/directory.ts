/**
 * SEP-2640 Skills extension — the `resources/directory/read` surface (added in
 * spec commit 2e04c48d, 2026-06-09).
 *
 * One scenario, six checks (per AGENTS.md "fewer scenarios, more checks").
 * Each check's verbatim spec quote lives next to its check ID in
 * src/seps/sep-2640.yaml.
 *
 * Capability gating reads the declared capability from `server/discover`
 * (mirrors `tasks/capability.ts`): the checks run only when the server declares
 * `io.modelcontextprotocol/skills.directoryRead: true`. An undeclared optional
 * capability is a SKIP (not a failure); a declared-but-broken one fails.
 *
 * Discovery is dynamic and brand-neutral: the directory to exercise is derived
 * from `skill://index.json` or `resources/list`, hardcoding no fixture URI, so
 * the scenario passes against any conformant SEP-2640 server. When no directory
 * (or no subdirectory) can be discovered, that check reports the missing
 * prerequisite via untestableCheck (issue #248), never a silent green.
 */

import { ClientScenario, ConformanceCheck } from '../../../types';
import { Connection, JsonRpcError, type RunContext } from '../../../connection';
import { untestableCheck } from '../../untestable';
import {
  SKILLS_EXTENSION_ID,
  SKILL_MANIFEST_FILENAME,
  SEP_2640_REF,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_INVALID_PARAMS,
  type SkillIndex,
  type SkillResource,
  skillsCapability,
  directoryReadDeclared,
  skillsCheck,
  listAllResources,
  readSkillIndexText,
  skillNameFromManifestUri
} from './helpers';

const DIRECTORY_MIME = 'inode/directory';

const CAPABILITY_ID = 'sep-2640-capability-directory-read-flag';
const METHOD_ID = 'sep-2640-directory-read-method-registered';
const SHAPE_ID = 'sep-2640-directory-read-result-resources-shape';
const SUBDIR_ID = 'sep-2640-directory-read-subdir-mimetype';
const INVALID_PARAMS_ID = 'sep-2640-directory-read-invalid-params';
const PAGINATION_ID = 'sep-2640-directory-read-pagination';

const ALL_IDS = [
  CAPABILITY_ID,
  METHOD_ID,
  SHAPE_ID,
  SUBDIR_ID,
  INVALID_PARAMS_ID,
  PAGINATION_ID
];

interface DirectoryReadResult {
  resources?: SkillResource[];
  nextCursor?: string;
}

/** A directory to exercise plus, when known, a non-directory resource under it. */
interface DirectoryTarget {
  dirUri: string;
  /** A known file (non-directory) resource, used for the -32602 negative path. */
  fileUri?: string;
}

/** The skill root directory URI for a SKILL.md URI (strip the trailing file). */
function skillRootFromManifestUri(uri: string): string | undefined {
  if (skillNameFromManifestUri(uri) === undefined) return undefined;
  return uri.slice(0, uri.length - `/${SKILL_MANIFEST_FILENAME}`.length);
}

/**
 * Discover a directory resource to exercise, brand-neutrally: prefer a skill
 * root derived from a skill-md SKILL.md (index first, then resources/list),
 * then any `inode/directory` resource in resources/list.
 */
async function discoverDirectory(
  conn: Connection
): Promise<DirectoryTarget | undefined> {
  // 1. skill-md entry in skill://index.json — its SKILL.md URL gives us both a
  //    directory (the skill root) and a known file (the SKILL.md itself).
  const idx = await readSkillIndexText(conn);
  if (!('error' in idx) && typeof idx.text === 'string') {
    try {
      const index = JSON.parse(idx.text) as SkillIndex;
      const entry = (index.skills ?? []).find(
        (e) =>
          e.type === 'skill-md' &&
          typeof e.url === 'string' &&
          skillRootFromManifestUri(e.url) !== undefined
      );
      if (entry?.url) {
        return {
          dirUri: skillRootFromManifestUri(entry.url)!,
          fileUri: entry.url
        };
      }
    } catch {
      // A malformed index is the index scenario's concern; keep discovering.
    }
  }

  const resources = await listAllResources(conn);

  // 2. A SKILL.md in resources/list — derive the skill root the same way.
  const manifest = resources.find(
    (r) => skillRootFromManifestUri(r.uri) !== undefined
  );
  if (manifest) {
    return {
      dirUri: skillRootFromManifestUri(manifest.uri)!,
      fileUri: manifest.uri
    };
  }

  // 3. Any directory resource, using a non-directory sibling for the -32602
  //    path when one is listed.
  const dir = resources.find((r) => r.mimeType === DIRECTORY_MIME);
  if (dir) {
    const file = resources.find((r) => r.mimeType !== DIRECTORY_MIME);
    return { dirUri: dir.uri, fileUri: file?.uri };
  }

  return undefined;
}

export class SkillsDirectoryReadScenario implements ClientScenario {
  name = 'sep-2640-skills-directory';
  readonly source = { extensionId: SKILLS_EXTENSION_ID } as const;
  description = `SEP-2640 Skills extension: resources/directory/read surface (added in spec commit 2e04c48d, 2026-06-09).

**Endpoint**: \`resources/directory/read\` (gated by \`io.modelcontextprotocol/skills.directoryRead: true\`)

**Requirements covered** (each check carries a verbatim spec excerpt in src/seps/sep-2640.yaml):

- \`sep-2640-capability-directory-read-flag\` — server declared directoryRead (read from server/discover)
- \`sep-2640-directory-read-method-registered\` — a declaring server supports the method on a served directory (MUST)
- \`sep-2640-directory-read-result-resources-shape\` — result has resources[] of direct children (MUST)
- \`sep-2640-directory-read-subdir-mimetype\` — subdirectory children carry \`inode/directory\` (MUST)
- \`sep-2640-directory-read-invalid-params\` — a non-directory URI returns \`-32602\` (MUST)
- \`sep-2640-directory-read-pagination\` — \`nextCursor\` round-trips per resources/list (single-page is conformant)

**Gating & discovery**: the checks SKIP when the skills extension or its \`directoryRead\` flag is undeclared. The directory to exercise is discovered dynamically from \`skill://index.json\` / \`resources/list\` — no fixture URI is hardcoded.`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const conn = await ctx.connect();
    try {
      // === Capability gating via server/discover (not error-inference) ===
      const skills = await skillsCapability(conn);
      if (!skills) {
        const reason =
          'Server did not declare the io.modelcontextprotocol/skills extension; directoryRead checks not applicable.';
        return ALL_IDS.map((id) =>
          skillsCheck(id, reason, 'SKIPPED', { errorMessage: reason })
        );
      }
      if (!directoryReadDeclared(skills)) {
        const reason =
          'Server declared the skills extension but not directoryRead: true; the resources/directory/read checks are optional and not applicable.';
        return ALL_IDS.map((id) =>
          skillsCheck(id, reason, 'SKIPPED', { errorMessage: reason })
        );
      }

      const checks: ConformanceCheck[] = [];

      // Check 1: capability declared (observed directly from server/discover).
      checks.push(
        skillsCheck(
          CAPABILITY_ID,
          'Server declared io.modelcontextprotocol/skills.directoryRead: true under capabilities.extensions.',
          'SUCCESS',
          { details: { directoryRead: true } }
        )
      );

      // === Discover a directory to exercise (brand-neutral) ===
      const target = await discoverDirectory(conn);
      if (!target) {
        const reason =
          'no directory resource discoverable via skill://index.json or resources/list to exercise resources/directory/read';
        const rest: Array<[string, string]> = [
          [
            METHOD_ID,
            'A declaring server MUST support the method on a served directory.'
          ],
          [
            SHAPE_ID,
            'Result carries resources[] of the directory’s direct children.'
          ],
          [SUBDIR_ID, 'Subdirectory children carry mimeType inode/directory.'],
          [
            INVALID_PARAMS_ID,
            'A non-directory URI yields -32602 Invalid params.'
          ],
          [
            PAGINATION_ID,
            'nextCursor round-trips per the resources/list contract.'
          ]
        ];
        for (const [id, desc] of rest) {
          checks.push(
            untestableCheck(id, id, desc, reason, [SEP_2640_REF], 'FAILURE')
          );
        }
        return checks;
      }

      // === Happy path: list the discovered directory ===
      let happy: DirectoryReadResult | undefined;
      let happyErr: unknown;
      try {
        happy = await conn.request<DirectoryReadResult>(
          'resources/directory/read',
          { uri: target.dirUri }
        );
      } catch (e) {
        happyErr = e;
      }

      // Check 2: method registered (declared -> MUST be supported).
      const methodNotFound =
        happyErr instanceof JsonRpcError &&
        happyErr.code === JSONRPC_METHOD_NOT_FOUND;
      checks.push(
        skillsCheck(
          METHOD_ID,
          'A server that declares directoryRead MUST support resources/directory/read on a served skill directory.',
          happy !== undefined ? 'SUCCESS' : 'FAILURE',
          happy !== undefined
            ? { details: { uri: target.dirUri } }
            : {
                errorMessage: methodNotFound
                  ? `resources/directory/read returned -32601 for ${target.dirUri} despite the server declaring directoryRead: true`
                  : `resources/directory/read on ${target.dirUri} failed: ${
                      happyErr instanceof Error
                        ? happyErr.message
                        : String(happyErr)
                    }`
              }
        )
      );

      // Check 3: result shape — resources[] of Resource objects.
      const shapeErrs: string[] = [];
      if (!Array.isArray(happy?.resources)) {
        shapeErrs.push('result.resources is not an array');
      } else {
        happy.resources.forEach((r, i) => {
          if (typeof r.uri !== 'string') {
            shapeErrs.push(`resources[${i}].uri is not a string`);
          }
        });
      }
      checks.push(
        skillsCheck(
          SHAPE_ID,
          'The result contains resources[] listing the directory’s direct children, each with at least a uri.',
          happy === undefined
            ? 'FAILURE'
            : shapeErrs.length === 0
              ? 'SUCCESS'
              : 'FAILURE',
          happy === undefined
            ? { errorMessage: 'directory read did not return a result' }
            : shapeErrs.length === 0
              ? { details: { childCount: happy.resources?.length ?? 0 } }
              : { errorMessage: shapeErrs.join('; ') }
        )
      );

      // Check 4: subdirectory mime marker. A directory whose fixture exposes no
      // child subdirectory cannot exercise this — report it untestable, not a
      // pass and not a failure of the server.
      const subdirChild = Array.isArray(happy?.resources)
        ? happy.resources.find((r) => r.mimeType === DIRECTORY_MIME)
        : undefined;
      if (subdirChild) {
        checks.push(
          skillsCheck(
            SUBDIR_ID,
            'A subdirectory child is listed as a directory resource (mimeType inode/directory) so clients can descend.',
            'SUCCESS',
            { details: { subdirectoryUri: subdirChild.uri } }
          )
        );
      } else {
        checks.push(
          untestableCheck(
            SUBDIR_ID,
            SUBDIR_ID,
            'A subdirectory child is listed with mimeType inode/directory.',
            `no child with mimeType ${DIRECTORY_MIME} under ${target.dirUri}; the served directory exposes no subdirectory to exercise this check`,
            [SEP_2640_REF],
            'FAILURE'
          )
        );
      }

      // Check 5: non-directory URI -> -32602. Needs a known non-directory
      // resource; prefer the discovered fileUri, else a non-directory child.
      const nonDirUri =
        target.fileUri ??
        (Array.isArray(happy?.resources)
          ? happy.resources.find(
              (r) => typeof r.uri === 'string' && r.mimeType !== DIRECTORY_MIME
            )?.uri
          : undefined);
      if (nonDirUri === undefined) {
        checks.push(
          untestableCheck(
            INVALID_PARAMS_ID,
            INVALID_PARAMS_ID,
            'A non-directory URI yields -32602 Invalid params.',
            'no non-directory resource discoverable to probe the -32602 path',
            [SEP_2640_REF],
            'FAILURE'
          )
        );
      } else {
        let invalidOk = false;
        let invalidDetail = '';
        try {
          await conn.request<DirectoryReadResult>('resources/directory/read', {
            uri: nonDirUri
          });
          invalidDetail = `expected -32602 for non-directory URI ${nonDirUri}, got a successful result`;
        } catch (e) {
          if (e instanceof JsonRpcError && e.code === JSONRPC_INVALID_PARAMS) {
            invalidOk = true;
          } else if (e instanceof JsonRpcError) {
            invalidDetail = `expected -32602 for ${nonDirUri}, got ${e.code}: ${e.message}`;
          } else {
            invalidDetail = `expected -32602, got non-JsonRpcError: ${
              e instanceof Error ? e.message : String(e)
            }`;
          }
        }
        checks.push(
          skillsCheck(
            INVALID_PARAMS_ID,
            'resources/directory/read on a non-directory URI MUST return -32602 (Invalid params).',
            invalidOk ? 'SUCCESS' : 'FAILURE',
            invalidOk
              ? { details: { nonDirectoryUri: nonDirUri } }
              : { errorMessage: invalidDetail }
          )
        );
      }

      // Check 6: pagination contract (single-page is conformant).
      let paginationOk = false;
      let paginationDetail = '';
      const firstCursor = happy?.nextCursor;
      if (happy === undefined) {
        paginationDetail = 'no directory result to evaluate pagination';
      } else if (!firstCursor) {
        paginationOk = true;
        paginationDetail = 'single-page response (no nextCursor)';
      } else {
        try {
          const second = await conn.request<DirectoryReadResult>(
            'resources/directory/read',
            { uri: target.dirUri, cursor: firstCursor }
          );
          paginationOk = Array.isArray(second.resources);
          paginationDetail = paginationOk
            ? `nextCursor round-tripped: ${firstCursor}`
            : 'follow-up call returned non-array resources';
        } catch (e) {
          paginationDetail = `follow-up call with cursor failed: ${
            e instanceof Error ? e.message : String(e)
          }`;
        }
      }
      checks.push(
        skillsCheck(
          PAGINATION_ID,
          'nextCursor round-trips per the resources/list contract (single-page responses are conformant).',
          paginationOk ? 'SUCCESS' : 'FAILURE',
          paginationOk
            ? { details: { paginationDetail } }
            : { errorMessage: paginationDetail }
        )
      );

      return checks;
    } finally {
      await conn.close();
    }
  }
}
