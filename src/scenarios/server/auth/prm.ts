/**
 * Protected Resource Metadata discovery helpers (RFC 9728).
 *
 * Shared by server-side auth scenarios: probe an MCP endpoint without a
 * token, read the WWW-Authenticate challenge, and fetch the metadata the way
 * an MCP client would (resource_metadata URL, then the path-based well-known
 * URL, then the root one). Nothing here grades a response; callers decide
 * which checks a result passes or fails.
 */

import { request } from 'undici';
import { DRAFT_PROTOCOL_VERSION } from '../../../types';
import { buildStandardHeaders, withRequestMeta } from '../../../connection';

export const WELL_KNOWN_PRM_PATH = '/.well-known/oauth-protected-resource';

/**
 * Upper bound on one request, headers and body together, matching the
 * stateless connection's default. A server that leaves an SSE stream open or
 * never ends a JSON body must not hang the suite.
 */
export const REQUEST_TIMEOUT_MS = 10000;

export interface RequestOptions {
  timeoutMs?: number;
}

export interface UnauthenticatedProbe {
  statusCode: number;
  wwwAuthenticate: string | undefined;
  /** Mcp-Session-Id the server assigned, if it opened a session. */
  sessionId: string | undefined;
  body: string;
}

function timeoutError(timeoutMs: number): Error {
  return new Error(`timed out after ${timeoutMs} ms`);
}

/**
 * Run `fn` with an abort signal that fires after `timeoutMs`. The signal is
 * aborted on the way out as well so a still-open response body is torn
 * down. A timeout surfaces as an Error naming it; other failures pass through.
 */
async function withDeadline<T>(
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (error) {
    if (timedOut) throw timeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function probeBody(specVersion: string): {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
} {
  if (specVersion === DRAFT_PROTOCOL_VERSION) {
    return {
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: withRequestMeta({}, specVersion)
    };
  }
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: specVersion,
      capabilities: {},
      clientInfo: { name: 'conformance-prm-test', version: '1.0.0' }
    }
  };
}

export function singleHeader(
  value: string | string[] | undefined
): string | undefined {
  if (Array.isArray(value)) return value.join(', ');
  return value;
}

/**
 * Send one request without an Authorization header. The body is the request
 * any server for the spec version accepts without prior setup, so a 401 can
 * only come from the missing token.
 */
export async function probeUnauthenticated(
  serverUrl: string,
  specVersion: string,
  options: RequestOptions = {}
): Promise<UnauthenticatedProbe> {
  const probe = probeBody(specVersion);
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  return withDeadline(timeoutMs, async (signal) => {
    const response = await request(serverUrl, {
      method: 'POST',
      headers: buildStandardHeaders(probe.method, probe.params, {
        headers: { 'MCP-Protocol-Version': specVersion }
      }),
      body: JSON.stringify(probe),
      signal
    });
    const body = await response.body.text();
    return {
      statusCode: response.statusCode,
      wwwAuthenticate: singleHeader(response.headers['www-authenticate']),
      sessionId: singleHeader(response.headers['mcp-session-id']),
      body
    };
  });
}

export interface Challenge {
  scheme: string;
  params: Record<string, string>;
}

// RFC 9110 §5.6.2 token characters.
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+/;

/**
 * Parse a WWW-Authenticate header into its challenges (RFC 9110 §11.6.1).
 * A token followed by `=` is an auth-param; any other token starts a new
 * challenge. Quoted-string values are unescaped. Param names are lowercased.
 * token68 credentials (`Negotiate abc==`) are skipped so the challenges after
 * them survive. An unquoted value runs to the next space or comma, wider than
 * the grammar's token, because `resource_metadata=https://...` is seen in the
 * wild.
 */
export function parseChallenges(header: string): Challenge[] {
  const challenges: Challenge[] = [];
  let i = 0;
  const skip = (chars: RegExp) => {
    while (i < header.length && chars.test(header[i])) i++;
  };
  while (i < header.length) {
    skip(/[\s,]/);
    const token = TOKEN.exec(header.slice(i));
    if (!token) break;
    i += token[0].length;
    skip(/[ \t]/);
    const current = challenges[challenges.length - 1];
    if (header[i] === '=' && current) {
      i++;
      skip(/[ \t]/);
      let value = '';
      if (header[i] === '"') {
        i++;
        while (i < header.length && header[i] !== '"') {
          if (header[i] === '\\' && i + 1 < header.length) i++;
          value += header[i];
          i++;
        }
        i++;
      } else {
        if (/^[=\s,]/.test(header.slice(i)) || i >= header.length) {
          // token68 (`abc==`): skip the `=` run; nothing to record.
          skip(/=/);
          continue;
        }
        const raw = /^[^\s,]+/.exec(header.slice(i));
        value = raw ? raw[0] : '';
        i += value.length;
      }
      current.params[token[0].toLowerCase()] = value;
      continue;
    }
    if (header[i] === '=') {
      i++;
      continue;
    }
    challenges.push({ scheme: token[0], params: {} });
  }
  return challenges;
}

/** First value of `name` across every challenge in the header. */
export function challengeParam(
  header: string | undefined,
  name: string
): string | undefined {
  if (!header) return undefined;
  for (const challenge of parseChallenges(header)) {
    const value = challenge.params[name.toLowerCase()];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * The two well-known URLs RFC 9728 §3.1 derives from a resource identifier:
 * the suffix inserted before the path, and the suffix alone at the origin.
 * They coincide for a resource at the origin.
 */
export function wellKnownUrls(resourceUrl: string): {
  pathBased: string;
  root: string;
} {
  const u = new URL(resourceUrl);
  const path = u.pathname === '/' ? '' : u.pathname;
  return {
    pathBased: `${u.origin}${WELL_KNOWN_PRM_PATH}${path}${u.search}`,
    root: `${u.origin}${WELL_KNOWN_PRM_PATH}`
  };
}

export function isRootWellKnownUrl(url: string): boolean {
  try {
    return new URL(url).pathname === WELL_KNOWN_PRM_PATH;
  } catch {
    return false;
  }
}

/**
 * RFC 9728 §3.3: `resource` must equal the identifier the well-known suffix
 * was inserted into. For a document served at the root well-known URL that
 * identifier is the origin; the MCP endpoint is accepted there too, matching
 * what MCP clients such as the TypeScript SDK accept.
 */
export function acceptedResources(
  resourceUrl: string,
  metadataUrl: string
): string[] {
  if (!isRootWellKnownUrl(metadataUrl)) return [resourceUrl];
  const { origin } = new URL(resourceUrl);
  return [resourceUrl, origin, `${origin}/`];
}

export interface MetadataFetch {
  /** URL first requested. */
  requestedUrl: string;
  /** URL that answered, after any redirects. */
  url: string;
  statusCode: number;
  contentType: string | undefined;
  text: string;
  /** Parsed body when it is a JSON object, whatever the Content-Type. */
  doc: Record<string, unknown> | undefined;
  /** Transport failure; the other fields describe nothing. */
  error?: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

/** RFC 9728 §3.2: `application/json`, media-type parameters allowed. */
export function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  return value.split(';')[0].trim().toLowerCase() === 'application/json';
}

export async function fetchMetadata(
  url: string,
  options: RequestOptions = {}
): Promise<MetadataFetch> {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let current = url;
  for (let hop = 0; ; hop++) {
    let statusCode: number;
    let headers: Record<string, string | string[] | undefined>;
    let text = '';
    try {
      ({ statusCode, headers, text } = await withDeadline(
        timeoutMs,
        async (signal) => {
          const res = await request(current, {
            method: 'GET',
            headers: { accept: 'application/json' },
            signal
          });
          return {
            statusCode: res.statusCode,
            headers: res.headers,
            text: await res.body.text()
          };
        }
      ));
    } catch (e) {
      return {
        requestedUrl: url,
        url: current,
        statusCode: 0,
        contentType: undefined,
        text: '',
        doc: undefined,
        error: e instanceof Error ? e.message : String(e)
      };
    }
    const location = singleHeader(headers.location);
    if (REDIRECT_STATUSES.has(statusCode) && location && hop < MAX_REDIRECTS) {
      try {
        current = new URL(location, current).href;
        continue;
      } catch {
        // Fall through and report the redirect as the final response.
      }
    }
    let doc: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        doc = parsed as Record<string, unknown>;
      }
    } catch {
      doc = undefined;
    }
    return {
      requestedUrl: url,
      url: current,
      statusCode,
      contentType: singleHeader(headers['content-type']),
      text,
      doc
    };
  }
}

export type MetadataSource =
  | 'resource_metadata'
  | 'well-known-path'
  | 'well-known-root';

export interface MetadataAttempt extends MetadataFetch {
  source: MetadataSource;
}

export interface MetadataDiscovery {
  /** `resource_metadata` from the challenge, resolved against the server URL. */
  challengeUrl: string | undefined;
  /** First attempt that answered 200, in client discovery order. */
  found: MetadataAttempt | undefined;
  attempts: MetadataAttempt[];
}

/**
 * Discover the metadata in the order MCP clients use: the challenge's
 * `resource_metadata` URL when present, then the path-based well-known URL,
 * then the root one. Every URL tried is recorded so a caller can grade the
 * challenge URL on its own and still find a document to grade when the
 * challenge URL is broken. A URL is fetched once even when two sources name
 * it, the common case being a challenge that points at the well-known URL.
 */
export async function discoverProtectedResourceMetadata(
  resourceUrl: string,
  wwwAuthenticate: string | undefined,
  options: RequestOptions = {}
): Promise<MetadataDiscovery> {
  const attempts: MetadataAttempt[] = [];
  const candidates: Array<{ source: MetadataSource; url: string }> = [];
  const seen = new Set<string>();
  const add = (source: MetadataSource, url: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    candidates.push({ source, url });
  };

  let challengeUrl: string | undefined;
  const param = challengeParam(wwwAuthenticate, 'resource_metadata');
  if (param !== undefined && param.length > 0) {
    try {
      challengeUrl = new URL(param, resourceUrl).href;
      add('resource_metadata', challengeUrl);
    } catch {
      challengeUrl = param;
    }
  }

  const { pathBased, root } = wellKnownUrls(resourceUrl);
  add('well-known-path', pathBased);
  add('well-known-root', root);

  let found: MetadataAttempt | undefined;
  for (const candidate of candidates) {
    const attempt = {
      source: candidate.source,
      ...(await fetchMetadata(candidate.url, options))
    };
    attempts.push(attempt);
    if (attempt.statusCode === 200) {
      found = attempt;
      break;
    }
  }

  return { challengeUrl, found, attempts };
}
