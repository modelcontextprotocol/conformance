/**
 * SEP-2127 MCP Server Cards — hosted card scenario.
 *
 * SEP-2127 is an Extensions Track SEP: its normative text lives in
 * modelcontextprotocol/ext-server-card (docs/discovery.md, README, schema.json),
 * not under docs/specification/draft/. The SEP says implementers "should follow
 * the current, versioned extension specification rather than this historical
 * snapshot", so this scenario is pinned to ext-server-card@28db12c9 (the current
 * v1 schema, which adds Remote.extensionsInfo, ext-server-card#55).
 *
 * Hosting a card is a MAY ("MCP Servers MAY host their Server Card at
 * `GET <streamable-http-url>/server-card`"). Only a 2xx there counts as hosting
 * a card, and the checks run against it: a 200 HTML page fails
 * sep-2127-card-schema-valid instead of skipping. Any other status (404, 405, a
 * redirect, an auth challenge) means the optional feature is not offered, so
 * every check is SKIPPED. No answer at all fails sep-2127-card-schema-valid.
 *
 * Plain HTTP (GET with and without If-None-Match, and a CORS preflight) goes
 * through undici beside the MCP connection, as dns-rebinding.ts does. The
 * consistency checks compare the card with `server/discover`.
 */

import { request } from 'undici';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { default as addFormats } from 'ajv-formats';
import type {
  ClientScenario,
  ConformanceCheck,
  SpecReference
} from '../../../types';
import type { RunContext } from '../../../connection';
import { untestableCheck } from '../../untestable';
import serverCardSchema from './server-card.schema.json';

const SERVER_CARD_MEDIA_TYPE = 'application/mcp-server-card+json';
/** Any browser origin the server does not know; CORS for cards must allow it. */
const PROBE_ORIGIN = 'https://conformance-client.example';

const PIN = '28db12c9b4a379489d46e49bf1bd4a991f05c9b7';
const DISCOVERY = `https://github.com/modelcontextprotocol/ext-server-card/blob/${PIN}/docs/discovery.md`;
const REF_SEP: SpecReference = {
  id: 'SEP-2127',
  url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127'
};
const REF_LOCATION: SpecReference = {
  id: 'Server-Card-Hosted-Location',
  url: `${DISCOVERY}#hosted-server-card-location`
};
const REF_SCHEMA: SpecReference = {
  id: 'Server-Card-Schema-v1',
  url: `https://github.com/modelcontextprotocol/ext-server-card/blob/${PIN}/schema.json`
};
const REF_CORS: SpecReference = {
  id: 'Server-Card-CORS',
  url: `${DISCOVERY}#cors-requirements`
};
const REF_CACHING: SpecReference = {
  id: 'Server-Card-Caching',
  url: `${DISCOVERY}#caching`
};
const REF_CONSISTENCY: SpecReference = {
  id: 'Server-Card-Consistency',
  url: `${DISCOVERY}#consistency-with-runtime-behavior`
};

/** SemVer 2.0.0 (semver.org, "Is there a suggested regular expression"). */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
/** A reverse-DNS server name, `namespace/name`. */
const REVERSE_DNS_NAME = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `<streamable-http-url>/server-card`: the path gains one segment; query and fragment are dropped. */
function serverCardUrl(serverUrl: string): string {
  const u = new URL(serverUrl);
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/server-card`;
  u.search = '';
  u.hash = '';
  return u.href;
}

/** Two endpoint URLs name the same endpoint: same origin, path (ignoring a trailing slash) and query. */
function sameEndpoint(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false;
  try {
    const norm = (v: string) => {
      const u = new URL(v);
      return `${u.origin}${u.pathname.replace(/\/+$/, '')}${u.search}`;
    };
    return norm(a) === norm(b);
  } catch {
    return false;
  }
}

/**
 * A readable cause for a failed request. undici's connection errors can carry an
 * empty message (an AggregateError over the IPv6 and IPv4 attempts), so fall
 * back to the error code and the inner errors.
 */
function errorText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const code = (e as { code?: unknown }).code;
  const errors = (e as { errors?: unknown }).errors;
  const inner = Array.isArray(errors)
    ? errors.map((x) => (x instanceof Error ? x.message : String(x)))
    : [];
  const parts = [
    e.message,
    typeof code === 'string' ? code : '',
    inner.length ? `(${inner.join('; ')})` : ''
  ].filter(Boolean);
  return parts.length ? parts.join(' ') : e.name;
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v.join(', ') : v;
}

/** Comma-separated header tokens, lower-cased. */
function tokens(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

function check(
  id: string,
  name: string,
  description: string,
  ok: boolean,
  severity: 'FAILURE' | 'WARNING',
  specReferences: SpecReference[],
  errorMessage: string,
  details?: Json
): ConformanceCheck {
  return {
    id,
    name,
    description,
    status: ok ? 'SUCCESS' : severity,
    timestamp: new Date().toISOString(),
    specReferences,
    ...(ok ? {} : { errorMessage }),
    ...(details ? { details } : {})
  };
}

function skipped(
  id: string,
  name: string,
  description: string,
  reason: string,
  specReferences: SpecReference[]
): ConformanceCheck {
  return {
    id,
    name,
    description,
    status: 'SKIPPED',
    timestamp: new Date().toISOString(),
    specReferences,
    details: { reason }
  };
}

/** Every check this scenario emits: [id, name, description, severity, refs]. */
const CHECKS = [
  [
    'sep-2127-card-schema-valid',
    'ServerCardSchemaValid',
    'The hosted Server Card is a JSON object that validates against the v1 Server Card schema',
    'FAILURE',
    [REF_SCHEMA, REF_SEP]
  ],
  [
    'sep-2127-version-semver',
    'ServerCardVersionSemver',
    "The card's version follows semantic versioning",
    'WARNING',
    [REF_SCHEMA]
  ],
  [
    'sep-2127-card-media-type',
    'ServerCardMediaType',
    `The card is served as ${SERVER_CARD_MEDIA_TYPE} when that type is requested`,
    'WARNING',
    [REF_LOCATION]
  ],
  [
    'sep-2127-cors-allow-origin',
    'ServerCardCorsAllowOrigin',
    'The card response carries Access-Control-Allow-Origin: *',
    'FAILURE',
    [REF_CORS]
  ],
  [
    'sep-2127-cors-expose-headers',
    'ServerCardCorsExposeHeaders',
    'The card response exposes ETag (Access-Control-Expose-Headers)',
    'FAILURE',
    [REF_CORS]
  ],
  [
    'sep-2127-cors-preflight',
    'ServerCardCorsPreflight',
    'A CORS preflight for the card succeeds with Access-Control-Allow-Origin (* or the request origin)',
    'FAILURE',
    [REF_CORS]
  ],
  [
    'sep-2127-cors-allow-methods',
    'ServerCardCorsAllowMethods',
    'The preflight response allows GET (Access-Control-Allow-Methods)',
    'FAILURE',
    [REF_CORS]
  ],
  [
    'sep-2127-cors-allow-headers',
    'ServerCardCorsAllowHeaders',
    'The preflight response allows Content-Type and If-None-Match (Access-Control-Allow-Headers)',
    'FAILURE',
    [REF_CORS]
  ],
  [
    'sep-2127-cache-control',
    'ServerCardCacheControl',
    'The card response carries a Cache-Control header',
    'WARNING',
    [REF_CACHING]
  ],
  [
    'sep-2127-etag',
    'ServerCardETag',
    'The card response carries an ETag',
    'WARNING',
    [REF_CACHING]
  ],
  [
    'sep-2127-if-none-match',
    'ServerCardIfNoneMatch',
    'A request with If-None-Match set to that ETag gets 304 Not Modified',
    'WARNING',
    [REF_CACHING]
  ],
  [
    'sep-2127-consistent-transport',
    'ServerCardConsistentTransport',
    "The card's remote for this endpoint declares streamable-http",
    'WARNING',
    [REF_CONSISTENCY]
  ],
  [
    'sep-2127-consistent-protocol-version',
    'ServerCardConsistentProtocolVersion',
    "The card's supportedProtocolVersions do not contradict server/discover's supportedVersions",
    'WARNING',
    [REF_CONSISTENCY]
  ],
  [
    'sep-2127-consistent-version',
    'ServerCardConsistentVersion',
    "The card's version does not contradict serverInfo.version",
    'WARNING',
    [REF_CONSISTENCY]
  ],
  [
    'sep-2127-consistent-name',
    'ServerCardConsistentName',
    "The card's name does not contradict a reverse-DNS serverInfo.name",
    'WARNING',
    [REF_CONSISTENCY]
  ],
  [
    'sep-2127-consistent-title',
    'ServerCardConsistentTitle',
    "The card's title does not contradict serverInfo.title",
    'WARNING',
    [REF_CONSISTENCY]
  ],
  [
    'sep-2127-consistent-description',
    'ServerCardConsistentDescription',
    "The card's description does not contradict the server's description",
    'WARNING',
    [REF_CONSISTENCY]
  ]
] as const satisfies ReadonlyArray<
  readonly [string, string, string, 'FAILURE' | 'WARNING', SpecReference[]]
>;

type CheckId = (typeof CHECKS)[number][0];
const META = Object.fromEntries(
  CHECKS.map(([id, name, description, severity, refs]) => [
    id,
    { name, description, severity, refs }
  ])
) as unknown as Record<
  CheckId,
  {
    name: string;
    description: string;
    severity: 'FAILURE' | 'WARNING';
    refs: SpecReference[];
  }
>;

let validateCard:
  | (((card: unknown) => boolean) & { errors?: unknown })
  | undefined;
function cardValidator() {
  if (!validateCard) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    ajv.addSchema(serverCardSchema, 'server-card-v1');
    validateCard = ajv.getSchema(
      'server-card-v1#/$defs/ServerCard'
    ) as typeof validateCard;
  }
  return validateCard!;
}

export class ServerCardScenario implements ClientScenario {
  name = 'sep-2127-server-card';
  readonly source = {
    extensionId: 'io.modelcontextprotocol/server-card'
  } as const;
  description = `SEP-2127 MCP Server Cards: the card a server hosts at its reserved location, and whether it agrees with the live server.

**Optional feature:** servers MAY host a Server Card at \`GET <streamable-http-url>/server-card\`. Only a 2xx response there is treated as a hosted card; any other status means the server does not offer one, and every check is SKIPPED.

**Server Implementation Requirements (for servers that host a card), from ext-server-card@28db12c9:**
- MUST: the card validates against the v1 Server Card schema (\`$schema\`, \`name\`, \`version\`, \`description\`)
- MUST: CORS for browser clients — \`Access-Control-Allow-Origin: *\` and \`Access-Control-Expose-Headers: ETag\` on the card response; a preflight that succeeds and allows \`GET\` and the \`Content-Type\` and \`If-None-Match\` headers
- SHOULD: served as \`${SERVER_CARD_MEDIA_TYPE}\`; \`version\` is semver; a \`Cache-Control\` header; an \`ETag\`, and \`304 Not Modified\` for a matching \`If-None-Match\`
- SHOULD NOT: the card contradicts the live server (\`server/discover\`): the transport of the remote for this endpoint, \`supportedProtocolVersions\`, and \`serverInfo\` \`version\`, \`name\` (when reverse-DNS), \`title\` and \`description\``;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const add = (
      id: CheckId,
      ok: boolean,
      errorMessage: string,
      details?: Json
    ) => {
      const m = META[id];
      checks.push(
        check(
          id,
          m.name,
          m.description,
          ok,
          m.severity,
          m.refs,
          errorMessage,
          details
        )
      );
    };
    const skip = (id: CheckId, reason: string) => {
      const m = META[id];
      checks.push(skipped(id, m.name, m.description, reason, m.refs));
    };
    const untestable = (id: CheckId, reason: string) => {
      const m = META[id];
      checks.push(
        untestableCheck(id, m.name, m.description, reason, m.refs, m.severity)
      );
    };

    const cardUrl = serverCardUrl(ctx.serverUrl);

    // === The card, requested the way the spec asks clients to request it ===
    let res: Awaited<ReturnType<typeof request>>;
    let bodyText: string;
    try {
      res = await request(cardUrl, {
        method: 'GET',
        headers: { accept: SERVER_CARD_MEDIA_TYPE, origin: PROBE_ORIGIN }
      });
      bodyText = await res.body.text();
    } catch (e) {
      // The server did not answer at all, so whether it hosts a card is unknown.
      add(
        'sep-2127-card-schema-valid',
        false,
        `GET ${cardUrl} failed: ${errorText(e)}`
      );
      for (const [id] of CHECKS.slice(1))
        untestable(id, `GET ${cardUrl} failed: ${errorText(e)}`);
      return checks;
    }

    // Hosting a card is optional (MAY). Only a 2xx is a hosted card; anything
    // else (404, 405, a redirect, an auth challenge) means no card is offered.
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const reason = `No Server Card at ${cardUrl} (HTTP ${res.statusCode}); hosting a card is optional (MAY), so the checks do not apply.`;
      for (const [id] of CHECKS) skip(id, reason);
      return checks;
    }

    // --- sep-2127-card-schema-valid (MUST) ---
    let card: Json | undefined;
    let parseError: string | undefined;
    try {
      const parsed: unknown = JSON.parse(bodyText);
      if (isObject(parsed)) card = parsed;
      else parseError = 'the body is JSON but not an object';
    } catch {
      parseError = `the body is not JSON (HTTP ${res.statusCode}, content-type ${header(res.headers, 'content-type') ?? 'none'})`;
    }
    if (!card) {
      add(
        'sep-2127-card-schema-valid',
        false,
        `No valid Server Card at ${cardUrl}: ${parseError}`,
        { statusCode: res.statusCode }
      );
    } else {
      const validate = cardValidator();
      const ok = validate(card);
      add(
        'sep-2127-card-schema-valid',
        ok,
        'The card does not validate against the v1 Server Card schema',
        ok ? undefined : { errors: validate.errors }
      );
    }

    // --- sep-2127-version-semver (SHOULD) ---
    if (!card || typeof card.version !== 'string') {
      untestable(
        'sep-2127-version-semver',
        'the card has no version string to check'
      );
    } else {
      add(
        'sep-2127-version-semver',
        SEMVER.test(card.version),
        `version ${JSON.stringify(card.version)} is not semantic versioning`
      );
    }

    // --- sep-2127-card-media-type (SHOULD) ---
    const contentType = (header(res.headers, 'content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    add(
      'sep-2127-card-media-type',
      contentType === SERVER_CARD_MEDIA_TYPE,
      `Served as ${JSON.stringify(contentType || 'no content-type')}, not ${SERVER_CARD_MEDIA_TYPE}`
    );

    // --- sep-2127-cors-allow-origin (MUST), sep-2127-cors-expose-headers (MUST): on the card response ---
    const acao = header(res.headers, 'access-control-allow-origin');
    add(
      'sep-2127-cors-allow-origin',
      acao?.trim() === '*',
      `Access-Control-Allow-Origin is ${JSON.stringify(acao ?? null)}, not "*"`
    );
    const expose = tokens(header(res.headers, 'access-control-expose-headers'));
    add(
      'sep-2127-cors-expose-headers',
      expose.includes('etag') || expose.includes('*'),
      `Access-Control-Expose-Headers ${JSON.stringify(expose.join(', ') || null)} does not include ETag`
    );

    // --- Preflight: a browser sending If-None-Match always preflights (it is not a CORS-safelisted header) ---
    let pre: Awaited<ReturnType<typeof request>> | undefined;
    let preError: string | undefined;
    try {
      pre = await request(cardUrl, {
        method: 'OPTIONS',
        headers: {
          origin: PROBE_ORIGIN,
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'content-type, if-none-match'
        }
      });
      await pre.body.dump();
    } catch (e) {
      preError = `OPTIONS ${cardUrl} failed: ${errorText(e)}`;
    }
    if (!pre) {
      untestable('sep-2127-cors-preflight', preError!);
      untestable('sep-2127-cors-allow-methods', preError!);
      untestable('sep-2127-cors-allow-headers', preError!);
    } else {
      const preOrigin = header(
        pre.headers,
        'access-control-allow-origin'
      )?.trim();
      const preOk =
        pre.statusCode >= 200 &&
        pre.statusCode < 300 &&
        (preOrigin === '*' || preOrigin === PROBE_ORIGIN);
      add(
        'sep-2127-cors-preflight',
        preOk,
        `Preflight answered HTTP ${pre.statusCode} with Access-Control-Allow-Origin ${JSON.stringify(preOrigin ?? null)}`
      );
      const methods = tokens(
        header(pre.headers, 'access-control-allow-methods')
      );
      add(
        'sep-2127-cors-allow-methods',
        methods.includes('get') || methods.includes('*'),
        `Preflight Access-Control-Allow-Methods ${JSON.stringify(methods.join(', ') || null)} does not include GET`
      );
      const allowHeaders = tokens(
        header(pre.headers, 'access-control-allow-headers')
      );
      const missing = ['content-type', 'if-none-match'].filter(
        (h) => !allowHeaders.includes(h) && !allowHeaders.includes('*')
      );
      add(
        'sep-2127-cors-allow-headers',
        missing.length === 0,
        `Preflight Access-Control-Allow-Headers ${JSON.stringify(allowHeaders.join(', ') || null)} does not include ${missing.join(' and ')}`
      );
    }

    // --- sep-2127-cache-control, sep-2127-etag, sep-2127-if-none-match (SHOULD) ---
    const cacheControl = header(res.headers, 'cache-control') ?? '';
    add(
      'sep-2127-cache-control',
      cacheControl.trim() !== '',
      'The card response has no Cache-Control header'
    );
    const etag = header(res.headers, 'etag');
    add('sep-2127-etag', Boolean(etag), 'The card response has no ETag');
    if (!etag) {
      untestable(
        'sep-2127-if-none-match',
        'the card response has no ETag to revalidate'
      );
    } else {
      try {
        const again = await request(cardUrl, {
          method: 'GET',
          headers: { accept: SERVER_CARD_MEDIA_TYPE, 'if-none-match': etag }
        });
        await again.body.dump();
        add(
          'sep-2127-if-none-match',
          again.statusCode === 304,
          `If-None-Match ${etag} answered HTTP ${again.statusCode}, not 304`
        );
      } catch (e) {
        untestable(
          'sep-2127-if-none-match',
          `the revalidation GET failed: ${errorText(e)}`
        );
      }
    }

    // === Consistency with runtime behavior: the card vs server/discover ===
    const consistency: CheckId[] = [
      'sep-2127-consistent-transport',
      'sep-2127-consistent-protocol-version',
      'sep-2127-consistent-version',
      'sep-2127-consistent-name',
      'sep-2127-consistent-title',
      'sep-2127-consistent-description'
    ];
    if (!card) {
      for (const id of consistency)
        untestable(id, 'there is no card object to compare with the server');
      return checks;
    }

    let discovered: Json;
    try {
      const conn = await ctx.connect();
      try {
        discovered = await conn.discover();
      } finally {
        await conn.close();
      }
    } catch (e) {
      const reason = `server/discover failed: ${errorText(e)}`;
      for (const id of consistency) untestable(id, reason);
      return checks;
    }
    const meta = isObject(discovered._meta) ? discovered._meta : {};
    const serverInfo: Json = isObject(
      meta['io.modelcontextprotocol/serverInfo']
    )
      ? meta['io.modelcontextprotocol/serverInfo']
      : isObject(discovered.serverInfo)
        ? discovered.serverInfo
        : {};
    const supportedVersions = Array.isArray(discovered.supportedVersions)
      ? discovered.supportedVersions.filter(
          (v): v is string => typeof v === 'string'
        )
      : undefined;

    // --- sep-2127-consistent-transport ---
    // The first remotes[] entry for this URL is compared; a card listing two
    // transports at one URL is judged on the first.
    const remote = Array.isArray(card.remotes)
      ? card.remotes
          .filter(isObject)
          .find((r) => sameEndpoint(r.url, ctx.serverUrl))
      : undefined;
    if (!remote) {
      skip(
        'sep-2127-consistent-transport',
        `The card declares no remote for ${ctx.serverUrl}`
      );
    } else {
      add(
        'sep-2127-consistent-transport',
        remote.type === 'streamable-http',
        `The card's remote for this endpoint says type ${JSON.stringify(remote.type)}; it answered server/discover over Streamable HTTP`
      );
    }

    // --- sep-2127-consistent-protocol-version ---
    const listed =
      remote && Array.isArray(remote.supportedProtocolVersions)
        ? remote.supportedProtocolVersions.filter(
            (v): v is string => typeof v === 'string'
          )
        : undefined;
    if (!listed) {
      skip(
        'sep-2127-consistent-protocol-version',
        "The card's remote for this endpoint lists no supportedProtocolVersions"
      );
    } else if (!supportedVersions) {
      untestable(
        'sep-2127-consistent-protocol-version',
        'server/discover returned no supportedVersions'
      );
    } else {
      const extra = listed.filter((v) => !supportedVersions.includes(v));
      add(
        'sep-2127-consistent-protocol-version',
        extra.length === 0,
        `The card lists ${extra.join(', ')}, which server/discover does not (server: ${supportedVersions.join(', ')})`,
        { card: listed, server: supportedVersions }
      );
    }

    // --- sep-2127-consistent-version / -title / -description ---
    const compare = (
      id: CheckId,
      field: 'version' | 'title' | 'description'
    ) => {
      const mine = card![field];
      const theirs = serverInfo[field];
      if (typeof mine !== 'string' || typeof theirs !== 'string') {
        skip(
          id,
          `The card or serverInfo sets no ${field}, so there is nothing to contradict`
        );
      } else {
        add(
          id,
          mine === theirs,
          `The card's ${field} ${JSON.stringify(mine)} contradicts serverInfo.${field} ${JSON.stringify(theirs)}`
        );
      }
    };
    compare('sep-2127-consistent-version', 'version');

    // --- sep-2127-consistent-name: only a reverse-DNS serverInfo.name can contradict the card's ---
    if (
      typeof serverInfo.name !== 'string' ||
      !REVERSE_DNS_NAME.test(serverInfo.name)
    ) {
      skip(
        'sep-2127-consistent-name',
        'serverInfo.name is not reverse-DNS, so it cannot contradict the card name'
      );
    } else {
      add(
        'sep-2127-consistent-name',
        serverInfo.name === card.name,
        `The card's name ${JSON.stringify(card.name)} contradicts serverInfo.name ${JSON.stringify(serverInfo.name)}`
      );
    }
    compare('sep-2127-consistent-title', 'title');
    compare('sep-2127-consistent-description', 'description');

    return checks;
  }
}
