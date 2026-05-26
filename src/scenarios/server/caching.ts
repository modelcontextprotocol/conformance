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
import { sendStatelessRequest } from './stateless-client';

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

interface CachingFields {
  ttlMs: unknown;
  cacheScope: unknown;
  hasTtlMs: boolean;
  hasCacheScope: boolean;
}

function extractCachingFields(result: Record<string, unknown>): CachingFields {
  const hasTtlMs = 'ttlMs' in result;
  const hasCacheScope = 'cacheScope' in result;
  return {
    ttlMs: hasTtlMs ? result.ttlMs : undefined,
    cacheScope: hasCacheScope ? result.cacheScope : undefined,
    hasTtlMs,
    hasCacheScope
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

export class CachingScenario implements ClientScenario {
  name = 'caching';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  description = `Test that servers include caching hints (ttlMs and cacheScope) on cacheable results (SEP-2549).

**Server Implementation Requirements:**

Servers MUST include \`ttlMs\` (integer >= 0) and \`cacheScope\` ("public" or "private") on results from:
- \`tools/list\`
- \`prompts/list\`
- \`resources/list\`
- \`resources/templates/list\`
- \`resources/read\``;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const allFields: Array<{ endpoint: string; fields: CachingFields }> = [];

    // SEP-2549 only exists in the draft spec, so each cacheable endpoint is
    // queried over the stateless path (SEP-2575): protocolVersion DRAFT-2026-v1
    // plus the cross-cutting _meta and standard headers (issue #315).
    const queryEndpoint = async (
      checkId: string,
      checkName: string,
      endpoint: string,
      params?: Record<string, unknown>
    ): Promise<Record<string, unknown> | undefined> => {
      const description = `${endpoint} response includes ttlMs and cacheScope caching hints`;
      try {
        const response = await sendStatelessRequest(
          serverUrl,
          endpoint,
          params
        );
        const result = response.body?.result;
        if (!result) {
          const error = response.body?.error;
          checks.push({
            id: checkId,
            name: checkName,
            description,
            status: 'FAILURE',
            timestamp: new Date().toISOString(),
            errorMessage: error
              ? `${endpoint} returned JSON-RPC error ${error.code}: ${error.message}`
              : `${endpoint} returned HTTP ${response.status} with no result`,
            specReferences: SPEC_REFS,
            details: { httpStatus: response.status, error }
          });
          return undefined;
        }
        const fields = extractCachingFields(result);
        allFields.push({ endpoint, fields });
        checks.push(buildPresenceCheck(checkId, checkName, endpoint, fields));
        return result;
      } catch (error) {
        checks.push({
          id: checkId,
          name: checkName,
          description,
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: `${endpoint} request failed: ${error instanceof Error ? error.message : String(error)}`,
          specReferences: SPEC_REFS
        });
        return undefined;
      }
    };

    // 1. tools/list
    await queryEndpoint(
      'sep-2549-tools-list-caching-hints',
      'ToolsListCachingHints',
      'tools/list'
    );

    // 2. prompts/list
    await queryEndpoint(
      'sep-2549-prompts-list-caching-hints',
      'PromptsListCachingHints',
      'prompts/list'
    );

    // 3. resources/list
    const resourcesResult = await queryEndpoint(
      'sep-2549-resources-list-caching-hints',
      'ResourcesListCachingHints',
      'resources/list'
    );

    // 4. resources/templates/list
    await queryEndpoint(
      'sep-2549-resources-templates-list-caching-hints',
      'ResourcesTemplatesListCachingHints',
      'resources/templates/list'
    );

    // 5. resources/read — use first resource from resources/list
    const resources = resourcesResult?.resources as
      | Array<{ uri?: string }>
      | undefined;
    const firstResourceUri = resources?.[0]?.uri;
    if (firstResourceUri) {
      await queryEndpoint(
        'sep-2549-resources-read-caching-hints',
        'ResourcesReadCachingHints',
        'resources/read',
        { uri: firstResourceUri }
      );
    } else {
      // Keep the emitted check-ID set stable even when there is nothing to
      // read (resources/list failed or the server exposes no resources).
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

    // 6. Aggregate: ttlMs must be a non-negative integer
    const ttlErrors: string[] = [];
    const endpointsWithTtl = allFields.filter((f) => f.fields.hasTtlMs);
    if (endpointsWithTtl.length === 0) {
      ttlErrors.push('no endpoints returned ttlMs');
    } else {
      for (const { endpoint, fields } of endpointsWithTtl) {
        const val = fields.ttlMs;
        if (typeof val !== 'number') {
          ttlErrors.push(
            `${endpoint}: ttlMs is ${typeof val}, expected number`
          );
        } else if (!Number.isInteger(val)) {
          ttlErrors.push(`${endpoint}: ttlMs is ${val}, expected integer`);
        } else if (val < 0) {
          ttlErrors.push(`${endpoint}: ttlMs is ${val}, must be >= 0`);
        }
      }
    }

    checks.push({
      id: 'sep-2549-ttl-non-negative',
      name: 'TtlNonNegative',
      description: 'All ttlMs values are non-negative integers',
      status: ttlErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
      timestamp: new Date().toISOString(),
      errorMessage: ttlErrors.length > 0 ? ttlErrors.join('; ') : undefined,
      specReferences: SPEC_REFS,
      details: {
        endpoints: allFields.map((f) => ({
          endpoint: f.endpoint,
          ttlMs: f.fields.ttlMs
        }))
      }
    });

    // 7. Aggregate: cacheScope must be "public" or "private"
    const scopeErrors: string[] = [];
    const endpointsWithScope = allFields.filter((f) => f.fields.hasCacheScope);
    if (endpointsWithScope.length === 0) {
      scopeErrors.push('no endpoints returned cacheScope');
    } else {
      for (const { endpoint, fields } of endpointsWithScope) {
        const val = fields.cacheScope;
        if (val !== 'public' && val !== 'private') {
          scopeErrors.push(
            `${endpoint}: cacheScope is ${JSON.stringify(val)}, expected "public" or "private"`
          );
        }
      }
    }

    checks.push({
      id: 'sep-2549-cache-scope-valid',
      name: 'CacheScopeValid',
      description: 'All cacheScope values are "public" or "private"',
      status: scopeErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
      timestamp: new Date().toISOString(),
      errorMessage: scopeErrors.length > 0 ? scopeErrors.join('; ') : undefined,
      specReferences: SPEC_REFS,
      details: {
        endpoints: allFields.map((f) => ({
          endpoint: f.endpoint,
          cacheScope: f.fields.cacheScope
        }))
      }
    });

    return checks;
  }
}
