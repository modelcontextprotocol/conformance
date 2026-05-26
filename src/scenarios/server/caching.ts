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
import { connectToServer } from './client-helper';
import {
  ListToolsResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ReadResourceResultSchema
} from '@modelcontextprotocol/sdk/types.js';

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

// listCachingFieldsForAllEndpoints opens a fresh connection to the given
// fixture URL and returns the extracted caching-field tuples for each of
// the five SEP-2549 endpoints. Per-endpoint failures are silenced — the
// caller is interested in the wire-shape observable (presence/absence of
// `ttlMs` / `cacheScope`), not whether every endpoint round-trips. The
// connection is closed before returning, regardless of partial failure.
//
// Used by the two opt-in edge-case checks (`cache-fields-absent-when-unset`
// and `ttl-ms-explicit-zero-distinct`) so the default seven-check path
// against the everything-server stays exactly as written upstream.
async function listCachingFieldsForAllEndpoints(
  serverUrl: string
): Promise<Array<{ endpoint: string; fields: CachingFields }>> {
  const connection = await connectToServer(serverUrl);
  const out: Array<{ endpoint: string; fields: CachingFields }> = [];
  try {
    const stages: Array<{
      endpoint: string;
      method: string;
      schema: unknown;
    }> = [
      {
        endpoint: 'tools/list',
        method: 'tools/list',
        schema: ListToolsResultSchema
      },
      {
        endpoint: 'prompts/list',
        method: 'prompts/list',
        schema: ListPromptsResultSchema
      },
      {
        endpoint: 'resources/list',
        method: 'resources/list',
        schema: ListResourcesResultSchema
      },
      {
        endpoint: 'resources/templates/list',
        method: 'resources/templates/list',
        schema: ListResourceTemplatesResultSchema
      }
    ];
    let firstResourceUri: string | undefined;
    for (const stage of stages) {
      try {
        const result = await connection.client.request(
          { method: stage.method, params: {} },
          stage.schema as never
        );
        if (stage.endpoint === 'resources/list') {
          const listed = result as { resources?: Array<{ uri?: string }> };
          firstResourceUri = listed.resources?.[0]?.uri;
        }
        out.push({
          endpoint: stage.endpoint,
          fields: extractCachingFields(result as Record<string, unknown>)
        });
      } catch {
        // observable is the wire shape on the endpoints that respond; a
        // missing endpoint just contributes no row.
      }
    }
    if (firstResourceUri) {
      try {
        const readResult = await connection.client.request(
          { method: 'resources/read', params: { uri: firstResourceUri } },
          ReadResourceResultSchema
        );
        out.push({
          endpoint: 'resources/read',
          fields: extractCachingFields(readResult as Record<string, unknown>)
        });
      } catch {
        // absence-asserts work fine without resources/read in the set.
      }
    }
  } finally {
    await connection.close();
  }
  return out;
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

    try {
      const connection = await connectToServer(serverUrl);

      // 1. tools/list
      try {
        const toolsResult = await connection.client.request(
          { method: 'tools/list', params: {} },
          ListToolsResultSchema
        );
        const fields = extractCachingFields(
          toolsResult as Record<string, unknown>
        );
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
        const promptsResult = await connection.client.request(
          { method: 'prompts/list', params: {} },
          ListPromptsResultSchema
        );
        const fields = extractCachingFields(
          promptsResult as Record<string, unknown>
        );
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
        const resourcesResult = await connection.client.request(
          { method: 'resources/list', params: {} },
          ListResourcesResultSchema
        );
        const fields = extractCachingFields(
          resourcesResult as Record<string, unknown>
        );
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
        const templatesResult = await connection.client.request(
          { method: 'resources/templates/list', params: {} },
          ListResourceTemplatesResultSchema
        );
        const fields = extractCachingFields(
          templatesResult as Record<string, unknown>
        );
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
          const readResult = await connection.client.request(
            {
              method: 'resources/read',
              params: { uri: firstResourceUri }
            },
            ReadResourceResultSchema
          );
          const fields = extractCachingFields(
            readResult as Record<string, unknown>
          );
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

      await connection.close();
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

    // === Opt-in wire-shape edge cases ===
    // Both checks activate via optional secondary fixture URLs and SKIP
    // cleanly when their env var is unset. The default run against the
    // everything-server gets the seven checks above unchanged.

    // 8. Cache fields absent when server has no hints configured.
    //    Spec: ttlMs and cacheScope are OPTIONAL on cacheable results —
    //    a server that has no cache hints to publish MUST NOT emit them.
    const noHintsUrl = process.env.CACHING_NO_HINTS_URL;
    if (!noHintsUrl) {
      checks.push({
        id: 'sep-2549-cache-fields-absent-when-unset',
        name: 'CacheFieldsAbsentWhenUnset',
        description:
          'When server has no cache hints configured, ttlMs and cacheScope MUST NOT appear on cacheable list responses',
        status: 'SKIPPED',
        timestamp: new Date().toISOString(),
        errorMessage:
          'CACHING_NO_HINTS_URL env var not set. Activate by pointing it at a fixture configured without cache hints.',
        specReferences: SPEC_REFS
      });
    } else {
      try {
        const fields = await listCachingFieldsForAllEndpoints(noHintsUrl);
        const offenders = fields.filter(
          (f) => f.fields.hasTtlMs || f.fields.hasCacheScope
        );
        checks.push({
          id: 'sep-2549-cache-fields-absent-when-unset',
          name: 'CacheFieldsAbsentWhenUnset',
          description:
            'When server has no cache hints configured, ttlMs and cacheScope MUST NOT appear on cacheable list responses',
          status: offenders.length === 0 ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage:
            offenders.length > 0
              ? offenders
                  .map((f) => {
                    const carried = [
                      f.fields.hasTtlMs ? 'ttlMs' : null,
                      f.fields.hasCacheScope ? 'cacheScope' : null
                    ]
                      .filter(Boolean)
                      .join(' + ');
                    return `${f.endpoint} carried ${carried} when fixture has no hints configured`;
                  })
                  .join('; ')
              : undefined,
          specReferences: SPEC_REFS,
          details: {
            fixtureUrl: noHintsUrl,
            endpoints: fields.map((f) => ({
              endpoint: f.endpoint,
              hasTtlMs: f.fields.hasTtlMs,
              hasCacheScope: f.fields.hasCacheScope
            }))
          }
        });
      } catch (error) {
        checks.push({
          id: 'sep-2549-cache-fields-absent-when-unset',
          name: 'CacheFieldsAbsentWhenUnset',
          description:
            'When server has no cache hints configured, ttlMs and cacheScope MUST NOT appear on cacheable list responses',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: `Failed to connect to CACHING_NO_HINTS_URL (${noHintsUrl}): ${error instanceof Error ? error.message : String(error)}`,
          specReferences: SPEC_REFS
        });
      }
    }

    // 9. Explicit ttlMs:0 distinct from absent on the wire.
    //    The merged spec treats absent ≡ 0 client-side. A server
    //    configured to emit explicit ttlMs:0 MUST do so on the wire (not
    //    omit), distinguishing "explicitly stale" from "no hint at all".
    //    Stricter than the spec mandates client-side, useful for
    //    implementations that intentionally surface the wire distinction.
    const explicitZeroUrl = process.env.CACHING_EXPLICIT_ZERO_URL;
    if (!explicitZeroUrl) {
      checks.push({
        id: 'sep-2549-ttl-ms-explicit-zero-distinct',
        name: 'TtlMsExplicitZeroDistinct',
        description:
          'When server is configured to emit explicit ttlMs:0, the field MUST appear on the wire with value 0 (not omitted)',
        status: 'SKIPPED',
        timestamp: new Date().toISOString(),
        errorMessage:
          'CACHING_EXPLICIT_ZERO_URL env var not set. Activate by pointing it at a fixture configured to emit explicit ttlMs:0.',
        specReferences: SPEC_REFS
      });
    } else {
      try {
        const fields = await listCachingFieldsForAllEndpoints(explicitZeroUrl);
        const offenders = fields.filter(
          (f) => !f.fields.hasTtlMs || f.fields.ttlMs !== 0
        );
        checks.push({
          id: 'sep-2549-ttl-ms-explicit-zero-distinct',
          name: 'TtlMsExplicitZeroDistinct',
          description:
            'When server is configured to emit explicit ttlMs:0, the field MUST appear on the wire with value 0 (not omitted)',
          status: offenders.length === 0 ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage:
            offenders.length > 0
              ? offenders
                  .map((f) =>
                    !f.fields.hasTtlMs
                      ? `${f.endpoint}: ttlMs absent (expected explicit 0)`
                      : `${f.endpoint}: ttlMs=${JSON.stringify(f.fields.ttlMs)} (expected 0)`
                  )
                  .join('; ')
              : undefined,
          specReferences: SPEC_REFS,
          details: {
            fixtureUrl: explicitZeroUrl,
            endpoints: fields.map((f) => ({
              endpoint: f.endpoint,
              hasTtlMs: f.fields.hasTtlMs,
              ttlMs: f.fields.ttlMs
            }))
          }
        });
      } catch (error) {
        checks.push({
          id: 'sep-2549-ttl-ms-explicit-zero-distinct',
          name: 'TtlMsExplicitZeroDistinct',
          description:
            'When server is configured to emit explicit ttlMs:0, the field MUST appear on the wire with value 0 (not omitted)',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: `Failed to connect to CACHING_EXPLICIT_ZERO_URL (${explicitZeroUrl}): ${error instanceof Error ? error.message : String(error)}`,
          specReferences: SPEC_REFS
        });
      }
    }

    return checks;
  }
}
