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
import type { RunContext } from '../../connection';
import type {
  CacheableResult,
  ListToolsResult,
  ListPromptsResult,
  ListResourcesResult,
  ListResourceTemplatesResult,
  ReadResourceResult
} from '../../spec-types/draft';

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

function extractCachingFields(result: Partial<CacheableResult>): CachingFields {
  const hasTtlMs = 'ttlMs' in result;
  const hasCacheScope = 'cacheScope' in result;
  return {
    ttlMs: result.ttlMs,
    cacheScope: result.cacheScope,
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

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const allFields: Array<{ endpoint: string; fields: CachingFields }> = [];

    try {
      const conn = await ctx.connect();

      // 1. tools/list
      try {
        const toolsResult = await conn.request<ListToolsResult>('tools/list');
        const fields = extractCachingFields(toolsResult);
        allFields.push({ endpoint: 'tools/list', fields });
        checks.push(
          buildPresenceCheck(
            'sep-2549-tools-list-caching-hints',
            'ToolsListCachingHints',
            'tools/list',
            fields
          )
        );
      } catch (error) {
        checks.push({
          id: 'sep-2549-tools-list-caching-hints',
          name: 'ToolsListCachingHints',
          description:
            'tools/list response includes ttlMs and cacheScope caching hints',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: `tools/list request failed: ${error instanceof Error ? error.message : String(error)}`,
          specReferences: SPEC_REFS
        });
      }

      // 2. prompts/list
      try {
        const promptsResult =
          await conn.request<ListPromptsResult>('prompts/list');
        const fields = extractCachingFields(promptsResult);
        allFields.push({ endpoint: 'prompts/list', fields });
        checks.push(
          buildPresenceCheck(
            'sep-2549-prompts-list-caching-hints',
            'PromptsListCachingHints',
            'prompts/list',
            fields
          )
        );
      } catch (error) {
        checks.push({
          id: 'sep-2549-prompts-list-caching-hints',
          name: 'PromptsListCachingHints',
          description:
            'prompts/list response includes ttlMs and cacheScope caching hints',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: `prompts/list request failed: ${error instanceof Error ? error.message : String(error)}`,
          specReferences: SPEC_REFS
        });
      }

      // 3. resources/list
      let firstResourceUri: string | undefined;
      try {
        const resourcesResult =
          await conn.request<ListResourcesResult>('resources/list');
        const fields = extractCachingFields(resourcesResult);
        allFields.push({ endpoint: 'resources/list', fields });
        checks.push(
          buildPresenceCheck(
            'sep-2549-resources-list-caching-hints',
            'ResourcesListCachingHints',
            'resources/list',
            fields
          )
        );
        // Capture the first resource URI for the resources/read check
        if (resourcesResult.resources && resourcesResult.resources.length > 0) {
          firstResourceUri = resourcesResult.resources[0].uri;
        }
      } catch (error) {
        checks.push({
          id: 'sep-2549-resources-list-caching-hints',
          name: 'ResourcesListCachingHints',
          description:
            'resources/list response includes ttlMs and cacheScope caching hints',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: `resources/list request failed: ${error instanceof Error ? error.message : String(error)}`,
          specReferences: SPEC_REFS
        });
      }

      // 4. resources/templates/list
      try {
        const templatesResult = await conn.request<ListResourceTemplatesResult>(
          'resources/templates/list'
        );
        const fields = extractCachingFields(templatesResult);
        allFields.push({ endpoint: 'resources/templates/list', fields });
        checks.push(
          buildPresenceCheck(
            'sep-2549-resources-templates-list-caching-hints',
            'ResourcesTemplatesListCachingHints',
            'resources/templates/list',
            fields
          )
        );
      } catch (error) {
        checks.push({
          id: 'sep-2549-resources-templates-list-caching-hints',
          name: 'ResourcesTemplatesListCachingHints',
          description:
            'resources/templates/list response includes ttlMs and cacheScope caching hints',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: `resources/templates/list request failed: ${error instanceof Error ? error.message : String(error)}`,
          specReferences: SPEC_REFS
        });
      }

      // 5. resources/read — use first resource from resources/list
      if (firstResourceUri) {
        try {
          const readResult = await conn.request<ReadResourceResult>(
            'resources/read',
            { uri: firstResourceUri }
          );
          const fields = extractCachingFields(readResult);
          allFields.push({ endpoint: 'resources/read', fields });
          checks.push(
            buildPresenceCheck(
              'sep-2549-resources-read-caching-hints',
              'ResourcesReadCachingHints',
              'resources/read',
              fields
            )
          );
        } catch (error) {
          checks.push({
            id: 'sep-2549-resources-read-caching-hints',
            name: 'ResourcesReadCachingHints',
            description:
              'resources/read response includes ttlMs and cacheScope caching hints',
            status: 'FAILURE',
            timestamp: new Date().toISOString(),
            errorMessage: `resources/read request failed: ${error instanceof Error ? error.message : String(error)}`,
            specReferences: SPEC_REFS
          });
        }
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
      const endpointsWithScope = allFields.filter(
        (f) => f.fields.hasCacheScope
      );
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
        errorMessage:
          scopeErrors.length > 0 ? scopeErrors.join('; ') : undefined,
        specReferences: SPEC_REFS,
        details: {
          endpoints: allFields.map((f) => ({
            endpoint: f.endpoint,
            cacheScope: f.fields.cacheScope
          }))
        }
      });

      await conn.close();
    } catch (error) {
      // Connection-level failure — push a single failure check
      checks.push({
        id: 'sep-2549-caching-connection',
        name: 'CachingConnection',
        description: 'Caching hints scenario failed to connect',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: SPEC_REFS
      });
    }

    return checks;
  }
}
