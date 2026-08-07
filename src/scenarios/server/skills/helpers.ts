/**
 * Shared helpers for the SEP-2640 (Skills extension) server-conformance
 * scenarios under this directory.
 *
 * The scenarios treat the server-under-test as an arbitrary SEP-2640 server:
 * capability is read from `server/discover` (never inferred from an error), and
 * every skill is discovered dynamically from `skill://index.json` and
 * `resources/list` — no fixture-specific URI is hardcoded, so the checks pass
 * against any conformant server, not just one implementation's fixture.
 */

import type {
  CheckStatus,
  ConformanceCheck,
  SpecReference
} from '../../../types';
import type { Connection } from '../../../connection';
import { JsonRpcError } from '../../../connection';
import { parse as parseYaml } from 'yaml';

export const SKILLS_EXTENSION_ID = 'io.modelcontextprotocol/skills';
export const SKILL_URI_SCHEME = 'skill://';
export const SKILL_INDEX_URI = 'skill://index.json';
export const SKILL_MANIFEST_FILENAME = 'SKILL.md';
export const SKILLS_META_PREFIX = 'io.modelcontextprotocol.skills/';

/** `sha256:{hex}` with exactly 64 lowercase hex characters (SEP-2640 index). */
export const SKILL_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** The SEP enumerated `skills[].type` values. */
export const SKILL_TYPES = ['skill-md', 'archive'] as const;

export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;

export const SEP_2640_REF: SpecReference = {
  id: 'SEP-2640',
  url: 'https://modelcontextprotocol.io/seps/2640-skills-extension#specification'
};

/** A `resources/list` / directory-read entry (only the fields we inspect). */
export interface SkillResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
}

/** One `skills[]` entry of the `skill://index.json` document. */
export interface SkillIndexEntry {
  name?: string;
  type?: string;
  description?: string;
  url?: string;
  digest?: string;
  [key: string]: unknown;
}

/** The parsed `skill://index.json` document. */
export interface SkillIndex {
  $schema?: string;
  skills?: SkillIndexEntry[];
  [key: string]: unknown;
}

/** First text content of a `resources/read`, with its mimeType and `_meta`. */
export interface ResourceText {
  text: string;
  mimeType?: string;
  meta?: Record<string, unknown>;
}

/**
 * Build a check carrying the SEP-2640 reference. Per AGENTS.md the same `id`
 * flips `status` + `errorMessage` between SUCCESS and FAILURE rather than
 * branching into distinct slugs.
 */
export function skillsCheck(
  id: string,
  description: string,
  status: CheckStatus,
  extras: Partial<ConformanceCheck> = {}
): ConformanceCheck {
  return {
    id,
    name: id,
    description,
    status,
    timestamp: new Date().toISOString(),
    specReferences: [SEP_2640_REF],
    ...extras
  };
}

/**
 * The skills extension object declared under `capabilities.extensions`, or
 * `undefined` when the server did not declare it. Reads the declared capability
 * from `server/discover` (mirrors `tasks/capability.ts`) — an undeclared
 * optional extension is a SKIP, never inferred from a `-32601`.
 */
export async function skillsCapability(
  conn: Connection
): Promise<Record<string, unknown> | undefined> {
  const discovered = await conn.discover();
  const caps = (discovered.capabilities as Record<string, unknown>) ?? {};
  const extensions = caps.extensions as Record<string, unknown> | undefined;
  const skills = extensions?.[SKILLS_EXTENSION_ID];
  return skills && typeof skills === 'object'
    ? (skills as Record<string, unknown>)
    : undefined;
}

/**
 * Whether the skills extension declares `directoryRead: true`.
 *
 * SEP-2640's capability-declaration example places the flag directly on the
 * extension object (`extensions[id].directoryRead`). SEP-2133 extension
 * negotiation — which SEP-2640 normatively defers to ("Per SEP-2133 extension
 * negotiation") — wraps settings in a `{ specVersion, stability, config }`
 * envelope, putting the flag at `extensions[id].config.directoryRead`. The two
 * SEPs are inconsistent on nesting, so a brand-neutral conformance check accepts
 * either location rather than privileging one reading of an ambiguous spec.
 * (The inconsistency is worth a WG clarification; see the scenario docs.)
 */
export function directoryReadDeclared(
  skills: Record<string, unknown>
): boolean {
  if (skills.directoryRead === true) return true;
  const config = skills.config as Record<string, unknown> | undefined;
  return config?.directoryRead === true;
}

/** Everything from `resources/list`, paginating until `nextCursor` clears. */
export async function listAllResources(
  conn: Connection
): Promise<SkillResource[]> {
  const out: SkillResource[] = [];
  let cursor: string | undefined;
  do {
    const page = await conn.request<{
      resources?: SkillResource[];
      nextCursor?: string;
    }>('resources/list', cursor ? { cursor } : undefined);
    out.push(...(page.resources ?? []));
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

/**
 * Read `skill://index.json`. Returns the raw JSON text (for parse-error
 * reporting) or a `JsonRpcError` when the server declines the well-known index
 * — a permitted MAY (SEP-2640 §Enumeration): the catalog may be unenumerable.
 */
export async function readSkillIndexText(
  conn: Connection
): Promise<{ text?: string; mimeType?: string } | { error: JsonRpcError }> {
  try {
    const res = await conn.request<{
      contents?: Array<{ text?: string; mimeType?: string }>;
    }>('resources/read', { uri: SKILL_INDEX_URI });
    const entry = (res.contents ?? []).find((c) => typeof c.text === 'string');
    return { text: entry?.text, mimeType: entry?.mimeType };
  } catch (e) {
    if (e instanceof JsonRpcError) return { error: e };
    throw e;
  }
}

/** Read a resource's first text content plus its mimeType and `_meta`. */
export async function readResourceText(
  conn: Connection,
  uri: string
): Promise<ResourceText | undefined> {
  const res = await conn.request<{
    contents?: Array<{
      text?: string;
      mimeType?: string;
      _meta?: Record<string, unknown>;
    }>;
  }>('resources/read', { uri });
  const entry = (res.contents ?? []).find((c) => typeof c.text === 'string');
  if (!entry || typeof entry.text !== 'string') return undefined;
  return { text: entry.text, mimeType: entry.mimeType, meta: entry._meta };
}

/**
 * The skill name recoverable from a `SKILL.md` resource URI: the final segment
 * of `<skill-path>`, i.e. the last path segment before the trailing
 * `SKILL.md`. Returns `undefined` when the URI is not a `skill://…/SKILL.md`.
 *
 *   skill://org/team/deploy/SKILL.md -> "deploy"
 *   skill://lint/SKILL.md            -> "lint"
 */
export function skillNameFromManifestUri(uri: string): string | undefined {
  if (!uri.startsWith(SKILL_URI_SCHEME)) return undefined;
  const parts = uri
    .slice(SKILL_URI_SCHEME.length)
    .split('/')
    .filter((p) => p.length > 0);
  if (parts.length < 2) return undefined;
  if (parts[parts.length - 1] !== SKILL_MANIFEST_FILENAME) return undefined;
  return parts[parts.length - 2];
}

/**
 * Extract and parse the YAML frontmatter block at the head of a `SKILL.md`.
 * Returns `undefined` when there is no leading `---` delimited block or it does
 * not parse to an object.
 */
export function parseFrontmatter(
  markdown: string
): Record<string, unknown> | undefined {
  // Tolerate a leading UTF-8 BOM before the opening `---` fence.
  const body = markdown.charCodeAt(0) === 0xfeff ? markdown.slice(1) : markdown;
  const match = body.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return undefined;
  try {
    const parsed = parseYaml(match[1]) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
