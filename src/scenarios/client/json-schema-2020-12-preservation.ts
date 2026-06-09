/**
 * Client-side JSON Schema 2020-12 keyword preservation (SEP-1613, SEP-2106)
 *
 * Validates that a client receiving a tool definition via `tools/list`
 * preserves the full JSON Schema 2020-12 vocabulary in its internal
 * representation, rather than silently stripping `$schema`, `$defs`,
 * `additionalProperties`, `$anchor`, composition (`allOf`/`anyOf`), or
 * conditional (`if`/`then`/`else`) keywords during parsing.
 *
 * This is the client-side counterpart of the server-side
 * `json-schema-2020-12` scenario.
 * This scenario exercises:
 *
 * 1. The mock server advertises a focal tool (`json_schema_2020_12_tool`)
 *    whose inputSchema contains the full SEP-1613/SEP-2106 vocabulary, plus
 *    a permissive echo tool (`json_schema_echo`).
 * 2. The client under test calls `tools/list`, observes the focal tool's
 *    inputSchema, then round-trips it back via `tools/call json_schema_echo`
 *    with `{ schema: <observed inputSchema> }`.
 * 3. The scenario diffs the echoed schema against the original fixture and
 *    flags any missing or altered keywords.
 *
 * SEP-2106 vocabulary checks are soft-gated via `sep2106KeywordCheckStatus`:
 * stripping is FAILURE only when the run targets `DRAFT-2026-v1`; on earlier
 * dated versions the check reports SKIPPED.
 */

import type { ScenarioContext, MockServer } from '../../mock-server';
import type {
  CallToolRequest,
  ListToolsResult
} from '../../spec-types/2025-11-25';
import {
  LATEST_SPEC_VERSION,
  type ConformanceCheck,
  type Scenario,
  type ScenarioUrls,
  type SpecVersion
} from '../../types';
import {
  EXPECTED_SCHEMA_DIALECT,
  EXPECTED_TOOL_NAME,
  JSON_SCHEMA_2020_12_FIXTURE,
  sep2106KeywordCheckStatus
} from '../server/json-schema-2020-12';

const ECHO_TOOL_NAME = 'json_schema_echo';

const SEP_1613_REF = {
  id: 'SEP-1613',
  url: 'https://github.com/modelcontextprotocol/specification/pull/655'
};
const SEP_2106_REF = {
  id: 'SEP-2106',
  url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2106'
};

export class JsonSchema2020_12PreservationScenario implements Scenario {
  name = 'json-schema-2020-12-preservation';
  readonly source = { introducedIn: '2025-11-25' } as const;
  description = `Validates client-side preservation of JSON Schema 2020-12 keywords (SEP-1613, SEP-2106).

**Client Implementation Requirements:**

1. Call \`tools/list\`. The mock server advertises two tools: \`${EXPECTED_TOOL_NAME}\` (focal, carries the rich inputSchema) and \`${ECHO_TOOL_NAME}\` (permissive echo).
2. Round-trip the focal tool's \`inputSchema\` back via \`tools/call\` on \`${ECHO_TOOL_NAME}\`, passing it verbatim as the \`schema\` argument:

\`\`\`json
{
  "name": "${ECHO_TOOL_NAME}",
  "arguments": {
    "schema": "<the inputSchema the client received for ${EXPECTED_TOOL_NAME}>"
  }
}
\`\`\`

The scenario compares the echoed schema against the original fixture and flags any keyword that was stripped or altered during the client's internal parsing.

**Verification**: \`$schema\`, \`$defs\`, and \`additionalProperties\` must be preserved (SEP-1613). The SEP-2106 vocabulary (\`$anchor\` inside \`$defs\`, composition \`allOf\`/\`anyOf\`, conditional \`if\`/\`then\`/\`else\`) must also survive; for dated protocol versions these checks are SKIPPED rather than FAILURE since SEP-2106 applies from the draft version.`;

  private srv: MockServer | null = null;
  private specVersion: SpecVersion | null = null;
  private observedSchema: Record<string, unknown> | null = null;
  private toolsListed = false;

  async start(ctx: ScenarioContext): Promise<ScenarioUrls> {
    this.specVersion = ctx.specVersion;
    this.observedSchema = null;
    this.toolsListed = false;

    this.srv = await ctx.createServer({
      'tools/list': (): ListToolsResult => {
        this.toolsListed = true;
        return {
          tools: [
            {
              name: EXPECTED_TOOL_NAME,
              description: 'Tool with JSON Schema 2020-12 features',
              inputSchema: JSON_SCHEMA_2020_12_FIXTURE
            },
            {
              name: ECHO_TOOL_NAME,
              description:
                'Echoes back an arbitrary JSON Schema object so the harness can observe what the client preserved.',
              inputSchema: {
                type: 'object',
                properties: {
                  schema: {
                    type: 'object',
                    description: `The inputSchema the client observed for ${EXPECTED_TOOL_NAME}, passed back verbatim.`
                  }
                },
                required: ['schema']
              }
            }
          ]
        };
      },
      'tools/call': (params) => {
        const p = params as unknown as CallToolRequest['params'];
        if (p.name === ECHO_TOOL_NAME) {
          const args = p.arguments as { schema?: unknown } | undefined;
          if (args && typeof args.schema === 'object' && args.schema !== null) {
            this.observedSchema = args.schema as Record<string, unknown>;
          }
          return { content: [{ type: 'text', text: 'echoed' }] };
        }
        if (p.name === EXPECTED_TOOL_NAME) {
          return { content: [{ type: 'text', text: 'ok' }] };
        }
        throw new Error(`Unknown tool: ${p.name}`);
      }
    });
    return { serverUrl: this.srv.url };
  }

  async stop(): Promise<void> {
    await this.srv?.close();
    this.srv = null;
  }

  getChecks(): ConformanceCheck[] {
    // Built fresh on every call so getChecks() is idempotent — the runner may
    // call it more than once and we must not accumulate duplicates.
    const timestamp = new Date().toISOString();
    const targetVersion = this.specVersion ?? LATEST_SPEC_VERSION;
    const echo = this.observedSchema;

    const checks: ConformanceCheck[] = [];

    checks.push({
      id: 'json-schema-2020-12-client-tool-found',
      name: 'JsonSchema2020_12ClientToolFound',
      description: `Client called tools/list and the mock server advertised '${EXPECTED_TOOL_NAME}'`,
      status: this.toolsListed ? 'SUCCESS' : 'FAILURE',
      timestamp,
      specReferences: [SEP_1613_REF],
      errorMessage: this.toolsListed
        ? undefined
        : 'Client never called tools/list; the scenario cannot observe schema preservation',
      details: { toolsListCalled: this.toolsListed }
    });

    checks.push({
      id: 'json-schema-2020-12-client-echo-completed',
      name: 'JsonSchema2020_12ClientEchoCompleted',
      description: `Client called tools/call '${ECHO_TOOL_NAME}' with a 'schema' object argument`,
      status: echo !== null ? 'SUCCESS' : 'FAILURE',
      timestamp,
      specReferences: [SEP_1613_REF],
      errorMessage:
        echo !== null
          ? undefined
          : 'Client did not echo back the inputSchema; downstream preservation checks are SKIPPED',
      details: { echoCompleted: echo !== null }
    });

    // If the client never echoed, the downstream preservation checks cannot
    // be evaluated. Emit SKIPPED for each so the SEP traceability manifest
    // still records all known check IDs from this scenario.
    if (echo === null) {
      const skipReason =
        'Skipped because the client did not complete the schema echo';
      checks.push(
        {
          id: 'json-schema-2020-12-client-$schema-preserved',
          name: 'JsonSchema2020_12Client$SchemaPreserved',
          description:
            'Client preserved the $schema field of the focal tool inputSchema',
          status: 'SKIPPED',
          timestamp,
          specReferences: [SEP_1613_REF],
          errorMessage: skipReason
        },
        {
          id: 'json-schema-2020-12-client-$defs-preserved',
          name: 'JsonSchema2020_12Client$DefsPreserved',
          description:
            'Client preserved the $defs field of the focal tool inputSchema',
          status: 'SKIPPED',
          timestamp,
          specReferences: [SEP_1613_REF],
          errorMessage: skipReason
        },
        {
          id: 'json-schema-2020-12-client-additionalProperties-preserved',
          name: 'JsonSchema2020_12ClientAdditionalPropertiesPreserved',
          description:
            'Client preserved the additionalProperties field of the focal tool inputSchema',
          status: 'SKIPPED',
          timestamp,
          specReferences: [SEP_1613_REF],
          errorMessage: skipReason
        },
        {
          id: 'sep-2106-client-composition-keywords-preserved',
          name: 'JsonSchema2020_12ClientCompositionKeywordsPreserved',
          description:
            'Client preserved composition keywords (allOf/anyOf) on the focal tool inputSchema',
          status: 'SKIPPED',
          timestamp,
          specReferences: [SEP_2106_REF],
          errorMessage: skipReason
        },
        {
          id: 'sep-2106-client-conditional-keywords-preserved',
          name: 'JsonSchema2020_12ClientConditionalKeywordsPreserved',
          description:
            'Client preserved conditional keywords (if/then/else) on the focal tool inputSchema',
          status: 'SKIPPED',
          timestamp,
          specReferences: [SEP_2106_REF],
          errorMessage: skipReason
        },
        {
          id: 'sep-2106-client-anchor-keyword-preserved',
          name: 'JsonSchema2020_12ClientAnchorKeywordPreserved',
          description:
            'Client preserved the $anchor keyword inside $defs.address',
          status: 'SKIPPED',
          timestamp,
          specReferences: [SEP_2106_REF],
          errorMessage: skipReason
        }
      );
      return checks;
    }

    // SEP-1613: $schema preserved
    const hasSchema = '$schema' in echo;
    const schemaCorrect = echo['$schema'] === EXPECTED_SCHEMA_DIALECT;
    checks.push({
      id: 'json-schema-2020-12-client-$schema-preserved',
      name: 'JsonSchema2020_12Client$SchemaPreserved',
      description: `Client preserved $schema = '${EXPECTED_SCHEMA_DIALECT}'`,
      status: hasSchema && schemaCorrect ? 'SUCCESS' : 'FAILURE',
      timestamp,
      specReferences: [SEP_1613_REF],
      errorMessage: !hasSchema
        ? '$schema missing from echoed inputSchema — client likely stripped it during parsing'
        : !schemaCorrect
          ? `$schema has unexpected value: ${JSON.stringify(echo['$schema'])}`
          : undefined,
      details: { hasSchema, schemaValue: echo['$schema'] }
    });

    // SEP-1613: $defs preserved
    const defs = echo['$defs'] as Record<string, unknown> | undefined;
    const hasDefs = '$defs' in echo;
    const defsHasAddress = hasDefs && defs !== undefined && 'address' in defs;
    checks.push({
      id: 'json-schema-2020-12-client-$defs-preserved',
      name: 'JsonSchema2020_12Client$DefsPreserved',
      description:
        'Client preserved $defs with the expected nested definitions',
      status: hasDefs && defsHasAddress ? 'SUCCESS' : 'FAILURE',
      timestamp,
      specReferences: [SEP_1613_REF],
      errorMessage: !hasDefs
        ? '$defs missing from echoed inputSchema — client likely stripped it during parsing'
        : !defsHasAddress
          ? '$defs exists but missing expected "address" definition'
          : undefined,
      details: {
        hasDefs,
        defsKeys: defs !== undefined ? Object.keys(defs) : []
      }
    });

    // SEP-1613: additionalProperties preserved
    const hasAdditionalProps = 'additionalProperties' in echo;
    const additionalPropsCorrect = echo['additionalProperties'] === false;
    checks.push({
      id: 'json-schema-2020-12-client-additionalProperties-preserved',
      name: 'JsonSchema2020_12ClientAdditionalPropertiesPreserved',
      description:
        'Client preserved additionalProperties = false on the focal inputSchema',
      status:
        hasAdditionalProps && additionalPropsCorrect ? 'SUCCESS' : 'FAILURE',
      timestamp,
      specReferences: [SEP_1613_REF],
      errorMessage: !hasAdditionalProps
        ? 'additionalProperties missing from echoed inputSchema — client likely stripped it during parsing'
        : !additionalPropsCorrect
          ? `additionalProperties has unexpected value: ${JSON.stringify(echo['additionalProperties'])}`
          : undefined,
      details: { hasAdditionalProps, value: echo['additionalProperties'] }
    });

    // SEP-2106 vocabulary — soft-gated via sep2106KeywordCheckStatus.
    const skippedSuffix = ` (run targets protocol version ${targetVersion}; SEP-2106 applies from DRAFT-2026-v1)`;

    // SEP-2106: composition (allOf/anyOf) preserved
    const allOf = echo['allOf'];
    const hasAllOf = Array.isArray(allOf) && allOf.length > 0;
    const hasNestedAnyOf =
      Array.isArray(allOf) &&
      allOf.some(
        (sub) =>
          typeof sub === 'object' &&
          sub !== null &&
          Array.isArray((sub as Record<string, unknown>)['anyOf'])
      );
    const compositionPreserved = hasAllOf && hasNestedAnyOf;
    const compositionStatus = sep2106KeywordCheckStatus(
      compositionPreserved,
      targetVersion
    );
    checks.push({
      id: 'sep-2106-client-composition-keywords-preserved',
      name: 'JsonSchema2020_12ClientCompositionKeywordsPreserved',
      description:
        'Client preserved composition keywords (allOf/anyOf) on the focal inputSchema',
      status: compositionStatus,
      timestamp,
      specReferences: [SEP_2106_REF],
      errorMessage: compositionPreserved
        ? undefined
        : (!hasAllOf
            ? 'allOf missing from echoed inputSchema — composition keyword was likely stripped'
            : 'nested anyOf missing from echoed allOf — composition keyword was likely stripped') +
          (compositionStatus === 'SKIPPED' ? skippedSuffix : ''),
      details: {
        hasAllOf,
        hasNestedAnyOf,
        targetProtocolVersion: targetVersion
      }
    });

    // SEP-2106: conditional (if/then/else) preserved
    const hasIf = 'if' in echo;
    const hasThen = 'then' in echo;
    const hasElse = 'else' in echo;
    const conditionalPreserved = hasIf && hasThen && hasElse;
    const conditionalStatus = sep2106KeywordCheckStatus(
      conditionalPreserved,
      targetVersion
    );
    checks.push({
      id: 'sep-2106-client-conditional-keywords-preserved',
      name: 'JsonSchema2020_12ClientConditionalKeywordsPreserved',
      description:
        'Client preserved conditional keywords (if/then/else) on the focal inputSchema',
      status: conditionalStatus,
      timestamp,
      specReferences: [SEP_2106_REF],
      errorMessage: conditionalPreserved
        ? undefined
        : `Conditional keywords missing (if=${hasIf}, then=${hasThen}, else=${hasElse}) — likely stripped` +
          (conditionalStatus === 'SKIPPED' ? skippedSuffix : ''),
      details: {
        hasIf,
        hasThen,
        hasElse,
        targetProtocolVersion: targetVersion
      }
    });

    // SEP-2106: $anchor inside $defs.address preserved
    const address = defs?.['address'] as Record<string, unknown> | undefined;
    const hasAnchor = !!address && '$anchor' in address;
    const anchorStatus = sep2106KeywordCheckStatus(hasAnchor, targetVersion);
    checks.push({
      id: 'sep-2106-client-anchor-keyword-preserved',
      name: 'JsonSchema2020_12ClientAnchorKeywordPreserved',
      description: 'Client preserved $anchor inside $defs.address',
      status: anchorStatus,
      timestamp,
      specReferences: [SEP_2106_REF],
      errorMessage: hasAnchor
        ? undefined
        : '$anchor missing from echoed $defs.address — reference keyword was likely stripped' +
          (anchorStatus === 'SKIPPED' ? skippedSuffix : ''),
      details: {
        hasAnchor,
        anchorValue: address?.['$anchor']
      }
    });

    return checks;
  }
}
