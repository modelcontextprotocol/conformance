/**
 * SEP-2243 request headers for the 2026-07-28 Streamable HTTP wire: the
 * standard `Mcp-Method` / `Mcp-Name` headers every POST carries, and the
 * `Mcp-Param-{Name}` headers a tools/call mirrors from the arguments its
 * tool's inputSchema designates with `x-mcp-header`.
 */

/**
 * Methods whose `Mcp-Name` header mirrors a param, and which param. A Map so
 * a method named like an Object.prototype member misses.
 */
const NAME_PARAM: ReadonlyMap<string, 'name' | 'uri'> = new Map([
  ['tools/call', 'name'],
  ['prompts/get', 'name'],
  ['resources/read', 'uri']
]);

const SENTINEL_PREFIX = '=?base64?';
const SENTINEL_SUFFIX = '?=';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A value as it may appear in an `Mcp-Name` or `Mcp-Param-*` header: as-is
 * when it is visible ASCII with at most inner spaces, otherwise (non-ASCII,
 * control characters, edge whitespace, or text that already looks like the
 * sentinel) the Base64 of its UTF-8 inside `=?base64?…?=`.
 */
export function encodeHeaderValue(value: string): string {
  const plain =
    /^[\x20-\x7e]*$/.test(value) &&
    value.trim() === value &&
    !(value.startsWith(SENTINEL_PREFIX) && value.endsWith(SENTINEL_SUFFIX));
  if (plain) return value;
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  return `${SENTINEL_PREFIX}${encoded}${SENTINEL_SUFFIX}`;
}

/** `Mcp-Method` for any request, plus `Mcp-Name` where the method has one. */
export function standardHeaders(message: {
  method: string;
  params?: Record<string, unknown>;
}): Record<string, string> {
  const headers: Record<string, string> = { 'Mcp-Method': message.method };
  const param = NAME_PARAM.get(message.method);
  const name = param ? message.params?.[param] : undefined;
  if (typeof name === 'string') headers['Mcp-Name'] = encodeHeaderValue(name);
  return headers;
}

/** One `x-mcp-header` annotation: where it sits and the header name part. */
export interface HeaderParam {
  /** The chain of `properties` keys from the schema root. */
  path: string[];
  /** The `{Name}` of `Mcp-Param-{Name}`. */
  header: string;
}

export type ToolHeaderParams =
  | { ok: true; params: HeaderParam[] }
  | { ok: false; reason: string };

/** RFC 9110 field-name token (`1*tchar`). */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MIRRORABLE_TYPES = new Set(['string', 'integer', 'boolean']);
/** Keywords whose values are instance data, not subschemas. */
const DATA_KEYWORDS = new Set(['const', 'enum', 'default', 'examples']);

/**
 * The `x-mcp-header` annotations of a tool's inputSchema, or why the tool
 * must be rejected (left out of tools/list): an annotation that is empty,
 * not an HTTP token, repeated case-insensitively, on a property that is not
 * string/integer/boolean, or not reachable from the root through
 * `properties` keys alone.
 */
export function toolHeaderParams(inputSchema: unknown): ToolHeaderParams {
  const annotated: { path: string[]; header: unknown; type: unknown }[] = [];
  const unreachable: string[] = [];

  // `path` is the properties chain from the root; undefined once the walk
  // has crossed any other keyword (items, oneOf, $ref, $defs, ...).
  const visit = (node: unknown, path: string[] | undefined, at: string) => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, undefined, `${at}/${i}`));
      return;
    }
    if (!isRecord(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'x-mcp-header') {
        if (path?.length)
          annotated.push({ path, header: value, type: node.type });
        else unreachable.push(at || '/');
      } else if (key === 'properties' && isRecord(value)) {
        for (const [prop, sub] of Object.entries(value)) {
          visit(sub, path && [...path, prop], `${at}/properties/${prop}`);
        }
      } else if (!DATA_KEYWORDS.has(key)) {
        visit(value, undefined, `${at}/${key}`);
      }
    }
  };
  visit(inputSchema, [], '');

  const reject = (reason: string): ToolHeaderParams => ({ ok: false, reason });
  if (unreachable.length) {
    return reject(
      `x-mcp-header at ${unreachable[0]} is not reachable from the schema root through properties alone`
    );
  }
  const params: HeaderParam[] = [];
  const seen = new Set<string>();
  for (const { path, header, type } of annotated) {
    const where = path.join('.');
    if (typeof header !== 'string' || header === '') {
      return reject(`x-mcp-header on '${where}' is not a non-empty string`);
    }
    if (!TOKEN.test(header)) {
      return reject(
        `x-mcp-header ${JSON.stringify(header)} on '${where}' is not an HTTP field-name token`
      );
    }
    if (typeof type !== 'string' || !MIRRORABLE_TYPES.has(type)) {
      return reject(
        `x-mcp-header on '${where}' annotates a ${JSON.stringify(type) ?? 'untyped'} property; only string, integer and boolean can be mirrored`
      );
    }
    const folded = header.toLowerCase();
    if (seen.has(folded)) {
      return reject(
        `x-mcp-header ${JSON.stringify(header)} is used more than once (case-insensitively)`
      );
    }
    seen.add(folded);
    params.push({ path, header });
  }
  return { ok: true, params };
}

/**
 * The `Mcp-Param-{Name}` headers for one tools/call: each annotated value
 * present in the arguments, as its string form (integers in decimal,
 * booleans as true/false) and encoded. A missing or null value sends no
 * header.
 */
export function paramHeaders(
  params: readonly HeaderParam[],
  args: Record<string, unknown> | undefined
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const { path, header } of params) {
    let value: unknown = args;
    for (const key of path) {
      value =
        isRecord(value) && Object.prototype.hasOwnProperty.call(value, key)
          ? value[key]
          : undefined;
    }
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      headers[`Mcp-Param-${header}`] = encodeHeaderValue(String(value));
    }
  }
  return headers;
}
