/**
 * Shared helpers for the SEP-2640 (Skills extension) server-conformance
 * scenarios under this directory.
 *
 * The scenarios treat the server-under-test as an arbitrary SEP-2640 server:
 * capability is read from `server/discover` (never inferred from an error), and
 * every skill is discovered dynamically through `skills/list` — no
 * fixture-specific URI is hardcoded, so the checks pass against any conformant
 * server, not just one implementation's fixture.
 *
 * Extracted against the 2026-08-21 revision of the SEP (branch
 * `sep/skills-extension`), which replaced the `skill://index.json` well-known
 * resource with the `skills/list` and `skills/get` methods, deferred archive
 * distribution, and reshaped the skill entry to `{uri, frontmatter, resources}`.
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
export const SKILL_MANIFEST_FILENAME = 'SKILL.md';
export const SKILLS_META_PREFIX = 'io.modelcontextprotocol.skills/';

/** Reserved prefix for MCP-defined keys inside frontmatter `metadata`. */
export const FRONTMATTER_RESERVED_PREFIX = 'io.modelcontextprotocol/';

export const SKILLS_LIST_METHOD = 'skills/list';
export const SKILLS_GET_METHOD = 'skills/get';
export const DIRECTORY_READ_METHOD = 'resources/directory/read';

/** `sha256:{hex}` with exactly 64 lowercase hex characters (SEP-2640). */
export const SKILL_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** The `"dynamic"` sentinel a server sets in place of a `resources` array. */
export const RESOURCES_DYNAMIC = 'dynamic';

/** Per-skill limits fixed by the SEP (§Limits). */
export const MAX_RESOURCES_PER_SKILL = 512;
export const MAX_TOTAL_SIZE_PER_SKILL = 16 * 1024 * 1024; // 16 MiB

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

/** One `{uri, digest, size}` triple of a skill entry's `resources` array. */
export interface SkillResourceEntry {
  uri?: unknown;
  digest?: unknown;
  size?: unknown;
  [key: string]: unknown;
}

/**
 * One skill entry, as returned by `skills/list` (in `skills[]`) and by
 * `skills/get` (as `skill`). The two are identical in shape and meaning.
 */
export interface SkillEntry {
  uri?: unknown;
  frontmatter?: unknown;
  /** An array of `{uri, digest, size}`, or the string `"dynamic"`. */
  resources?: unknown;
  [key: string]: unknown;
}

export interface SkillsListResult {
  skills?: unknown;
  nextCursor?: string;
  ttlMs?: unknown;
  cacheScope?: unknown;
  [key: string]: unknown;
}

export interface SkillsGetResult {
  skill?: unknown;
  nextCursor?: unknown;
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

/** A JSON object, as opposed to an array, `null`, or a primitive. */
export function isSettingsObject(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** How to name an observed non-object value in an error message. */
export function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/**
 * Whether the server declared the skills extension at all, and the raw value it
 * declared it with, before any shape coercion.
 *
 * `skillsCapability` folds a malformed declaration (`true`, a string, an array)
 * into `undefined`, which downstream reads as "extension not declared" and
 * SKIPs. That is a false SKIP: the server did declare the extension, it just
 * declared it with the wrong type, and the suite should say so. Callers that
 * need to tell "absent" from "malformed" apart use this instead.
 *
 * Reads the declared capability from `server/discover` (mirrors
 * `tasks/capability.ts`), never inferred from a `-32601`.
 */
export async function declaredSkillsCapability(
  conn: Connection
): Promise<{ declared: boolean; value: unknown }> {
  const discovered = await conn.discover();
  const caps = (discovered.capabilities as Record<string, unknown>) ?? {};
  const extensions = caps.extensions as Record<string, unknown> | undefined;
  if (!extensions || !(SKILLS_EXTENSION_ID in extensions)) {
    return { declared: false, value: undefined };
  }
  return { declared: true, value: extensions[SKILLS_EXTENSION_ID] };
}

/**
 * The skills extension object declared under `capabilities.extensions`, or
 * `undefined` when the server did not declare it — or declared it with
 * something that is not a settings object, which the callers of this helper
 * treat the same way. An undeclared optional extension is a SKIP.
 */
export async function skillsCapability(
  conn: Connection
): Promise<Record<string, unknown> | undefined> {
  const { value } = await declaredSkillsCapability(conn);
  return isSettingsObject(value) ? value : undefined;
}

/**
 * Whether the declared extension object nests its settings inline, as both
 * SEP-2133 and SEP-2640 require, rather than wrapping them in an envelope.
 *
 * SEP-2133 (status Final) defines `extensions` as "a map of extension
 * identifiers to per-extension settings objects", and SEP-2640's capability
 * block matches: `{"io.modelcontextprotocol/skills": {"directoryRead": true}}`.
 * Neither SEP defines an envelope, and neither has a slot for `id`,
 * `specVersion` or `stability`.
 *
 * An earlier revision of this helper accepted a `config` envelope alongside the
 * inline form, on the belief that the two SEPs disagreed. Re-reading SEP-2133
 * at Final status, they do not. The envelope is a non-conformant shape emitted
 * by at least one SDK, so it is reported rather than silently accepted.
 */
export function settingsAreInline(skills: Record<string, unknown>): {
  inline: boolean;
  envelopeKeys: string[];
} {
  const envelopeKeys = ['config', 'specVersion', 'stability', 'id'].filter(
    (k) => k in skills
  );
  return { inline: envelopeKeys.length === 0, envelopeKeys };
}

/**
 * Whether the skills extension declares `directoryRead: true`.
 *
 * Reads only the inline location the SEPs specify. A server that buries the
 * flag inside an envelope fails `sep-2640-capability-declaration-inline` and is
 * treated here as not having declared the optional method, which is the
 * conservative reading: a client that follows the spec would not see the flag
 * either, and "clients MUST NOT call resources/directory/read against a server
 * that has not declared directoryRead: true".
 */
export function directoryReadDeclared(
  skills: Record<string, unknown>
): boolean {
  return skills.directoryRead === true;
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

/** One page of `skills/list`, kept separate so pagination can be inspected. */
export interface SkillsListPage {
  result: SkillsListResult;
  entries: SkillEntry[];
}

/**
 * Call `skills/list` once, optionally with a cursor. Returns a `JsonRpcError`
 * rather than throwing so a scenario can distinguish "method not implemented"
 * (a FAILURE, since the method is mandatory for a declaring server) from a
 * transport fault.
 */
export async function skillsListPage(
  conn: Connection,
  cursor?: string
): Promise<SkillsListPage | { error: JsonRpcError }> {
  try {
    const result = await conn.request<SkillsListResult>(
      SKILLS_LIST_METHOD,
      cursor ? { cursor } : {}
    );
    const entries = Array.isArray(result.skills)
      ? (result.skills as SkillEntry[])
      : [];
    return { result, entries };
  } catch (e) {
    if (e instanceof JsonRpcError) return { error: e };
    throw e;
  }
}

/**
 * Every entry from `skills/list`, following `nextCursor`. `pages` is retained
 * so the atomic-entry and pagination checks can reason about page boundaries.
 * Bounded to avoid looping forever against a server that returns a constant
 * cursor.
 */
export async function skillsListAll(
  conn: Connection,
  maxPages = 50
): Promise<
  | { entries: SkillEntry[]; pages: SkillsListPage[]; truncated: boolean }
  | { error: JsonRpcError }
> {
  const pages: SkillsListPage[] = [];
  const entries: SkillEntry[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();

  for (let i = 0; i < maxPages; i++) {
    const page = await skillsListPage(conn, cursor);
    if ('error' in page) return page;
    pages.push(page);
    entries.push(...page.entries);
    const next = page.result.nextCursor;
    if (typeof next !== 'string' || next.length === 0) {
      return { entries, pages, truncated: false };
    }
    if (seenCursors.has(next)) {
      // A repeating cursor is a server bug; stop rather than spin.
      return { entries, pages, truncated: true };
    }
    seenCursors.add(next);
    cursor = next;
  }
  return { entries, pages, truncated: true };
}

/** Call `skills/get` for one skill URI. */
export async function skillsGet(
  conn: Connection,
  uri: string
): Promise<{ result: SkillsGetResult } | { error: JsonRpcError }> {
  try {
    const result = await conn.request<SkillsGetResult>(SKILLS_GET_METHOD, {
      uri
    });
    return { result };
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
 * `SKILL.md`. Returns `undefined` when the URI does not end in `/SKILL.md`.
 *
 * Scheme-agnostic by design: the SEP is explicit that "no scheme is
 * privileged" and that the structural constraints "apply regardless of
 * scheme", so a server serving skills under `github://` is judged by the same
 * path rule as one using `skill://`.
 *
 *   skill://org/team/deploy/SKILL.md -> "deploy"
 *   github://acme/repo/lint/SKILL.md -> "lint"
 */
export function skillNameFromManifestUri(uri: string): string | undefined {
  const schemeEnd = uri.indexOf('://');
  if (schemeEnd < 0) return undefined;
  const parts = uri
    .slice(schemeEnd + 3)
    .split('/')
    .filter((p) => p.length > 0);
  if (parts.length < 2) return undefined;
  if (parts[parts.length - 1] !== SKILL_MANIFEST_FILENAME) return undefined;
  return parts[parts.length - 2];
}

/** The skill's root directory URI: its `SKILL.md` URI with the file removed. */
export function skillRootFromManifestUri(uri: string): string | undefined {
  if (!uri.endsWith(`/${SKILL_MANIFEST_FILENAME}`)) return undefined;
  return uri.slice(0, -`/${SKILL_MANIFEST_FILENAME}`.length);
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

/** True when the entry's `resources` is the `"dynamic"` sentinel. */
export function isDynamicResources(entry: SkillEntry): boolean {
  return entry.resources === RESOURCES_DYNAMIC;
}

/**
 * The entry's `resources` array, or `undefined` when it is `"dynamic"`, absent,
 * or any other value. Callers distinguish those cases via `isDynamicResources`.
 */
export function resourcesArray(
  entry: SkillEntry
): SkillResourceEntry[] | undefined {
  return Array.isArray(entry.resources)
    ? (entry.resources as SkillResourceEntry[])
    : undefined;
}

/** A short, stable label for an entry, for error messages. */
export function entryLabel(entry: SkillEntry, i: number): string {
  return typeof entry.uri === 'string' ? entry.uri : `skills[${i}]`;
}

/**
 * Every child of a directory, following `nextCursor` until it clears.
 *
 * SEP-2640 says directory-read pagination mirrors `resources/list`, so a
 * conformant server MAY split a directory across pages. Reading only the
 * first page makes "no subdirectory here" indistinguishable from "the
 * subdirectory is on page two".
 */
export async function directoryReadAll(
  conn: Connection,
  uri: string,
  maxPages = 50
): Promise<{ resources: SkillResource[]; pages: number; truncated: boolean }> {
  const resources: SkillResource[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;

  for (let i = 0; i < maxPages; i++) {
    const page = await conn.request<{
      resources?: SkillResource[];
      nextCursor?: string;
    }>('resources/directory/read', cursor ? { uri, cursor } : { uri });
    resources.push(...(page.resources ?? []));
    const next = page.nextCursor;
    if (typeof next !== 'string' || next.length === 0) {
      return { resources, pages: i + 1, truncated: false };
    }
    if (seen.has(next)) return { resources, pages: i + 1, truncated: true };
    seen.add(next);
    cursor = next;
  }
  return { resources, pages: maxPages, truncated: true };
}
