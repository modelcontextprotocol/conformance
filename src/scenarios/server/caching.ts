/**
 * Caching (SEP-2549) test scenario for MCP servers
 *
 * Tests that servers include ttlMs and cacheScope on cacheable results:
 * tools/list, prompts/list, resources/list, resources/templates/list, resources/read
 */

import {
  ClientScenario,
  ConformanceCheck,
  DRAFT_PROTOCOL_VERSION
} from '../../types';
import {
  JsonRpcError,
  type Connection,
  type RunContext
} from '../../connection';
import type { CacheableResult } from '../../spec-types/draft';
import { notTestable } from '../untestable';
import { hasServerCapability, isPlainObject } from './requirements-check';

const SPEC_REFS = [
  {
    id: 'MCP-Caching',
    url: 'https://modelcontextprotocol.io/specification/draft/server/utilities/caching'
  },
  {
    id: 'SEP-2549',
    url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2549'
  }
];

type CacheableCapability = 'tools' | 'prompts' | 'resources';

interface CachingFields {
  ttlMs: unknown;
  cacheScope: unknown;
  hasTtlMs: boolean;
  hasCacheScope: boolean;
}

interface EndpointFields {
  endpoint: string;
  fields: CachingFields;
}

function extractCachingFields(result: Partial<CacheableResult>): CachingFields {
  return {
    ttlMs: result.ttlMs,
    cacheScope: result.cacheScope,
    hasTtlMs: 'ttlMs' in result,
    hasCacheScope: 'cacheScope' in result
  };
}

function buildPresenceCheck(
  id: string,
  name: string,
  endpoint: string,
  fields: CachingFields
): ConformanceCheck {
  const errors: string[] = [];
  if (!fields.hasTtlMs) {
    errors.push(`${endpoint} response missing ttlMs`);
  }
  if (!fields.hasCacheScope) {
    errors.push(`${endpoint} response missing cacheScope`);
  }

  return {
    id,
    name,
    description: `${endpoint} response includes ttlMs and cacheScope caching hints`,
    status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
    timestamp: new Date().toISOString(),
    errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
    specReferences: SPEC_REFS,
    details: {
      ttlMs: fields.ttlMs,
      cacheScope: fields.cacheScope,
      hasTtlMs: fields.hasTtlMs,
      hasCacheScope: fields.hasCacheScope
    }
  };
}

function buildSkippedCapabilityCheck(
  id: string,
  name: string,
  endpoint: string,
  capability: CacheableCapability
): ConformanceCheck {
  return {
    id,
    name,
    description: `${endpoint} response includes ttlMs and cacheScope caching hints`,
    status: 'SKIPPED',
    timestamp: new Date().toISOString(),
    errorMessage: `${endpoint} was not exercised: server did not declare '${capability}' capability.`,
    specReferences: SPEC_REFS,
    details: {
      skippedReason: 'missing-capability',
      capability
    }
  };
}

async function discoverDeclaredCapabilities(
  conn: Connection
): Promise<Record<string, unknown> | null> {
  try {
    const discovered = await conn.discover();
    return isPlainObject(discovered.capabilities)
      ? discovered.capabilities
      : {};
  } catch {
    // When discovery itself fails, do not assume capabilities are absent:
    // probe all endpoints so a broken server fails rather than skipping.
    return null;
  }
}

function isCapabilityDeclared(
  capabilities: Record<string, unknown> | null,
  capability: CacheableCapability
): boolean {
  return capabilities === null || hasServerCapability(capabilities, capability);
}

async function queryCacheableEndpoint(
  conn: Connection,
  checks: ConformanceCheck[],
  allFields: EndpointFields[],
  checkId: string,
  checkName: string,
  endpoint: string,
  params?: Record<string, unknown>
): Promise<(CacheableResult & Record<string, unknown>) | undefined> {
  const description = `${endpoint} response includes ttlMs and cacheScope caching hints`;
  try {
    const result = await conn.request<
      CacheableResult & Record<string, unknown>
    >(endpoint, params);
    const fields = extractCachingFields(result);
    allFields.push({ endpoint, fields });
    checks.push(buildPresenceCheck(checkId, checkName, endpoint, fields));
    return result;
  } catch (error) {
    const rpcError = error instanceof JsonRpcError ? error : undefined;
    checks.push({
      id: checkId,
      name: checkName,
      description,
      status: 'FAILURE',
      timestamp: new Date().toISOString(),
      errorMessage: rpcError
        ? `${endpoint} returned JSON-RPC error ${rpcError.code}: ${rpcError.message}`
        : `${endpoint} request failed: ${error instanceof Error ? error.message : String(error)}`,
      specReferences: SPEC_REFS,
      details: rpcError
        ? { error: { code: rpcError.code, message: rpcError.message } }
        : undefined
    });
    return undefined;
  }
}

async function probeResourceEndpoints(
  conn: Connection,
  checks: ConformanceCheck[],
  allFields: EndpointFields[],
  resourcesDeclared: boolean
): Promise<void> {
  if (!resourcesDeclared) {
    checks.push(
      buildSkippedCapabilityCheck(
        'sep-2549-resources-list-caching-hints',
        'ResourcesListCachingHints',
        'resources/list',
        'resources'
      ),
      buildSkippedCapabilityCheck(
        'sep-2549-resources-templates-list-caching-hints',
        'ResourcesTemplatesListCachingHints',
        'resources/templates/list',
        'resources'
      ),
      buildSkippedCapabilityCheck(
        'sep-2549-resources-read-caching-hints',
        'ResourcesReadCachingHints',
        'resources/read',
        'resources'
      )
    );
    return;
  }

  const resourcesResult = await queryCacheableEndpoint(
    conn,
    checks,
    allFields,
    'sep-2549-resources-list-caching-hints',
    'ResourcesListCachingHints',
    'resources/list'
  );
  await queryCacheableEndpoint(
    conn,
    checks,
    allFields,
    'sep-2549-resources-templates-list-caching-hints',
    'ResourcesTemplatesListCachingHints',
    'resources/templates/list'
  );

  const resources = resourcesResult?.resources as
    | Array<{ uri?: string }>
    | undefined;
  const firstResourceUri = resources?.[0]?.uri;
  if (firstResourceUri) {
    await queryCacheableEndpoint(
      conn,
      checks,
      allFields,
      'sep-2549-resources-read-caching-hints',
      'ResourcesReadCachingHints',
      'resources/read',
      { uri: firstResourceUri }
    );
    return;
  }

  // Keep the emitted check-ID set stable even when there is nothing to read.
  checks.push({
    id: 'sep-2549-resources-read-caching-hints',
    name: 'ResourcesReadCachingHints',
    description:
      'resources/read response includes ttlMs and cacheScope caching hints',
    status: 'SKIPPED',
    timestamp: new Date().toISOString(),
    errorMessage:
      'resources/read was not exercised: resources/list failed or returned no resources.',
    specReferences: SPEC_REFS
  });
}

function validateTtlValues(allFields: EndpointFields[]): string[] {
  const endpointsWithTtl = allFields.filter((f) => f.fields.hasTtlMs);
  if (endpointsWithTtl.length === 0) {
    return ['no endpoints returned ttlMs'];
  }

  const errors: string[] = [];
  for (const { endpoint, fields } of endpointsWithTtl) {
    const val = fields.ttlMs;
    if (typeof val !== 'number') {
      errors.push(`${endpoint}: ttlMs is ${typeof val}, expected number`);
    } else if (!Number.isInteger(val)) {
      errors.push(`${endpoint}: ttlMs is ${val}, expected integer`);
    } else if (val < 0) {
      errors.push(`${endpoint}: ttlMs is ${val}, must be >= 0`);
    }
  }
  return errors;
}

function validateCacheScopeValues(allFields: EndpointFields[]): string[] {
  const endpointsWithScope = allFields.filter((f) => f.fields.hasCacheScope);
  if (endpointsWithScope.length === 0) {
    return ['no endpoints returned cacheScope'];
  }

  const errors: string[] = [];
  for (const { endpoint, fields } of endpointsWithScope) {
    const val = fields.cacheScope;
    if (val !== 'public' && val !== 'private') {
      errors.push(
        `${endpoint}: cacheScope is ${JSON.stringify(val)}, expected "public" or "private"`
      );
    }
  }
  return errors;
}

function buildAggregateChecks(
  allFields: EndpointFields[],
  anyCapabilityDeclared: boolean,
  production: boolean
): ConformanceCheck[] {
  const timestamp = new Date().toISOString();
  if (!anyCapabilityDeclared) {
    const status = production ? 'SKIPPED' : 'FAILURE';
    const message = production
      ? 'Skipped in production mode: server did not declare tools, prompts, or resources capabilities.'
      : notTestable(
          'server declared none of tools, prompts, or resources capabilities, so caching hints could not be exercised'
        );
    const details = production
      ? {
          skippedReason: 'missing-capability',
          requiredAnyOf: ['tools', 'prompts', 'resources']
        }
      : { untestable: true, endpoints: [] };

    return [
      {
        id: 'sep-2549-ttl-non-negative',
        name: 'TtlNonNegative',
        description: 'All ttlMs values are non-negative integers',
        status,
        timestamp,
        errorMessage: message,
        specReferences: SPEC_REFS,
        details
      },
      {
        id: 'sep-2549-cache-scope-valid',
        name: 'CacheScopeValid',
        description: 'All cacheScope values are "public" or "private"',
        status,
        timestamp,
        errorMessage: message,
        specReferences: SPEC_REFS,
        details
      }
    ];
  }

  const ttlErrors = validateTtlValues(allFields);
  const scopeErrors = validateCacheScopeValues(allFields);

  return [
    {
      id: 'sep-2549-ttl-non-negative',
      name: 'TtlNonNegative',
      description: 'All ttlMs values are non-negative integers',
      status: ttlErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
      timestamp,
      errorMessage: ttlErrors.length > 0 ? ttlErrors.join('; ') : undefined,
      specReferences: SPEC_REFS,
      details: {
        endpoints: allFields.map((f) => ({
          endpoint: f.endpoint,
          ttlMs: f.fields.ttlMs
        }))
      }
    },
    {
      id: 'sep-2549-cache-scope-valid',
      name: 'CacheScopeValid',
      description: 'All cacheScope values are "public" or "private"',
      status: scopeErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
      timestamp,
      errorMessage: scopeErrors.length > 0 ? scopeErrors.join('; ') : undefined,
      specReferences: SPEC_REFS,
      details: {
        endpoints: allFields.map((f) => ({
          endpoint: f.endpoint,
          cacheScope: f.fields.cacheScope
        }))
      }
    }
  ];
}

export class CachingScenario implements ClientScenario {
  name = 'caching';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  readonly requires = {
    anyCapability: ['tools', 'prompts', 'resources']
  } as const;
  description = `Test that servers include caching hints (ttlMs and cacheScope) on cacheable results (SEP-2549).

**Server Implementation Requirements:**

Servers MUST include \`ttlMs\` (integer >= 0) and \`cacheScope\` ("public" or "private") on results from:
- \`tools/list\`
- \`prompts/list\`
- \`resources/list\`
- \`resources/templates/list\`
- \`resources/read\``;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const allFields: EndpointFields[] = [];

    let conn: Connection;
    try {
      conn = await ctx.connect();
    } catch (error) {
      checks.push({
        id: 'sep-2549-caching-connection',
        name: 'CachingConnection',
        description: 'Caching hints scenario failed to connect',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: SPEC_REFS
      });
      return checks;
    }

    const capabilities = await discoverDeclaredCapabilities(conn);
    const hasTools = isCapabilityDeclared(capabilities, 'tools');
    const hasPrompts = isCapabilityDeclared(capabilities, 'prompts');
    const hasResources = isCapabilityDeclared(capabilities, 'resources');

    if (hasTools) {
      await queryCacheableEndpoint(
        conn,
        checks,
        allFields,
        'sep-2549-tools-list-caching-hints',
        'ToolsListCachingHints',
        'tools/list'
      );
    } else {
      checks.push(
        buildSkippedCapabilityCheck(
          'sep-2549-tools-list-caching-hints',
          'ToolsListCachingHints',
          'tools/list',
          'tools'
        )
      );
    }

    if (hasPrompts) {
      await queryCacheableEndpoint(
        conn,
        checks,
        allFields,
        'sep-2549-prompts-list-caching-hints',
        'PromptsListCachingHints',
        'prompts/list'
      );
    } else {
      checks.push(
        buildSkippedCapabilityCheck(
          'sep-2549-prompts-list-caching-hints',
          'PromptsListCachingHints',
          'prompts/list',
          'prompts'
        )
      );
    }

    await probeResourceEndpoints(conn, checks, allFields, hasResources);
    await conn.close();

    checks.push(
      ...buildAggregateChecks(
        allFields,
        hasTools || hasPrompts || hasResources,
        Boolean(ctx.production)
      )
    );
    return checks;
  }
}
