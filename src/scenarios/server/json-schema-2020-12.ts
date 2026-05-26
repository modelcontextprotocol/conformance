/**
 * JSON Schema 2020-12 conformance test scenario (SEP-1613, SEP-2106)
 *
 * Validates that MCP servers correctly preserve JSON Schema 2020-12 keywords
 * in tool definitions, ensuring implementations don't strip $schema, $defs,
 * or additionalProperties fields (SEP-1613).
 *
 * SEP-2106 broadened inputSchema to permit the full JSON Schema 2020-12
 * vocabulary alongside the required root `type: "object"`. This scenario also
 * verifies that composition (allOf/anyOf), conditional (if/then/else), and
 * reference ($anchor) keywords survive tools/list rather than being stripped.
 */

import {
  CheckStatus,
  ClientScenario,
  ConformanceCheck,
  DRAFT_PROTOCOL_VERSION
} from '../../types.js';
import type { RunContext } from '../../connection';
import { connectToServer } from './client-helper.js';

const EXPECTED_TOOL_NAME = 'json_schema_2020_12_tool';
const EXPECTED_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/**
 * Soft version gate for the SEP-2106 keyword-preservation checks.
 *
 * Preserving the broader JSON Schema 2020-12 vocabulary is good behavior at
 * any protocol version, so a server that preserves the keywords gets SUCCESS
 * regardless of what it negotiated. Stripping them is only a conformance
 * FAILURE once the server claims a protocol version that includes SEP-2106
 * (the draft); a server that only negotiated an earlier dated version is not
 * yet subject to the requirement, so the check is SKIPPED rather than failed.
 */
export function sep2106KeywordCheckStatus(
  preserved: boolean,
  negotiatedProtocolVersion: string | undefined
): CheckStatus {
  if (preserved) {
    return 'SUCCESS';
  }
  return negotiatedProtocolVersion === DRAFT_PROTOCOL_VERSION
    ? 'FAILURE'
    : 'SKIPPED';
}

export class JsonSchema2020_12Scenario implements ClientScenario {
  name = 'json-schema-2020-12';
  readonly source = { introducedIn: '2025-11-25' } as const;
  description = `Validates JSON Schema 2020-12 keyword preservation (SEP-1613, SEP-2106).

**Server Implementation Requirements:**

Implement tool \`${EXPECTED_TOOL_NAME}\` with inputSchema containing JSON Schema 2020-12 features, including the broader vocabulary permitted by SEP-2106 (an \`$anchor\` inside \`$defs\`, composition keywords \`allOf\`/\`anyOf\`, and conditional keywords \`if\`/\`then\`/\`else\`):

\`\`\`json
{
  "name": "${EXPECTED_TOOL_NAME}",
  "description": "Tool with JSON Schema 2020-12 features",
  "inputSchema": {
    "$schema": "${EXPECTED_SCHEMA_DIALECT}",
    "type": "object",
    "$defs": {
      "address": {
        "$anchor": "addressDef",
        "type": "object",
        "properties": {
          "street": { "type": "string" },
          "city": { "type": "string" }
        }
      }
    },
    "properties": {
      "name": { "type": "string" },
      "address": { "$ref": "#/$defs/address" },
      "contactMethod": { "type": "string", "enum": ["phone", "email"] },
      "phone": { "type": "string" },
      "email": { "type": "string" }
    },
    "allOf": [
      { "anyOf": [{ "required": ["phone"] }, { "required": ["email"] }] }
    ],
    "if": {
      "properties": { "contactMethod": { "const": "phone" } },
      "required": ["contactMethod"]
    },
    "then": { "required": ["phone"] },
    "else": { "required": ["email"] },
    "additionalProperties": false
  }
}
\`\`\`

**Verification**: The test verifies that \`$schema\`, \`$defs\`, and \`additionalProperties\` are preserved (SEP-1613), and that the composition (\`allOf\`/\`anyOf\`), conditional (\`if\`/\`then\`/\`else\`), and \`$anchor\` keywords are preserved (SEP-2106), in the tool listing response.`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const { serverUrl } = ctx;
    const checks: ConformanceCheck[] = [];
    const specReferences = [
      {
        id: 'SEP-1613',
        url: 'https://github.com/modelcontextprotocol/specification/pull/655'
      }
    ];
    const sep2106References = [
      {
        id: 'SEP-2106',
        url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2106'
      }
    ];

    try {
      const connection = await connectToServer(serverUrl);
      // Negotiated wire protocolVersion from the initialize handshake; used to
      // soft-gate the SEP-2106 checks below.
      const negotiatedVersion = (
        connection.client.transport as { protocolVersion?: string } | undefined
      )?.protocolVersion;
      const result = await connection.client.listTools();

      // Find the test tool
      const tool = result.tools?.find((t) => t.name === EXPECTED_TOOL_NAME);

      // Check 1: Tool exists
      checks.push({
        id: 'json-schema-2020-12-tool-found',
        name: 'JsonSchema2020_12ToolFound',
        description: `Server advertises tool '${EXPECTED_TOOL_NAME}'`,
        status: tool ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: tool
          ? undefined
          : `Tool '${EXPECTED_TOOL_NAME}' not found. Available tools: ${result.tools?.map((t) => t.name).join(', ') || 'none'}`,
        specReferences,
        details: {
          toolFound: !!tool,
          availableTools: result.tools?.map((t) => t.name) || []
        }
      });

      if (!tool) {
        await connection.close();
        return checks;
      }

      const inputSchema = tool.inputSchema as Record<string, unknown>;

      // Check 2: $schema field preserved
      const hasSchema = '$schema' in inputSchema;
      const schemaValue = inputSchema['$schema'];
      const schemaCorrect = schemaValue === EXPECTED_SCHEMA_DIALECT;

      checks.push({
        id: 'json-schema-2020-12-$schema',
        name: 'JsonSchema2020_12$Schema',
        description: `inputSchema.$schema field preserved with value '${EXPECTED_SCHEMA_DIALECT}'`,
        status: hasSchema && schemaCorrect ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: !hasSchema
          ? '$schema field missing from inputSchema - field was likely stripped'
          : !schemaCorrect
            ? `$schema has unexpected value: ${JSON.stringify(schemaValue)}`
            : undefined,
        specReferences,
        details: {
          hasSchema,
          schemaValue,
          expected: EXPECTED_SCHEMA_DIALECT
        }
      });

      // Check 3: $defs field preserved
      const hasDefs = '$defs' in inputSchema;
      const defsValue = inputSchema['$defs'] as
        | Record<string, unknown>
        | undefined;
      const defsHasAddress = defsValue && 'address' in defsValue;

      checks.push({
        id: 'json-schema-2020-12-$defs',
        name: 'JsonSchema2020_12$Defs',
        description:
          'inputSchema.$defs field preserved with expected structure',
        status: hasDefs && defsHasAddress ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: !hasDefs
          ? '$defs field missing from inputSchema - field was likely stripped'
          : !defsHasAddress
            ? '$defs exists but missing expected "address" definition'
            : undefined,
        specReferences,
        details: {
          hasDefs,
          defsKeys: defsValue ? Object.keys(defsValue) : [],
          defsValue
        }
      });

      // Check 4: additionalProperties field preserved
      const hasAdditionalProps = 'additionalProperties' in inputSchema;
      const additionalPropsValue = inputSchema['additionalProperties'];
      const additionalPropsCorrect = additionalPropsValue === false;

      checks.push({
        id: 'json-schema-2020-12-additionalProperties',
        name: 'JsonSchema2020_12AdditionalProperties',
        description: 'inputSchema.additionalProperties field preserved',
        status:
          hasAdditionalProps && additionalPropsCorrect ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: !hasAdditionalProps
          ? 'additionalProperties field missing from inputSchema - field was likely stripped'
          : !additionalPropsCorrect
            ? `additionalProperties has unexpected value: ${JSON.stringify(additionalPropsValue)}, expected: false`
            : undefined,
        specReferences,
        details: {
          hasAdditionalProps,
          additionalPropsValue,
          expected: false
        }
      });

      // SEP-2106: the full JSON Schema 2020-12 vocabulary is permitted in
      // inputSchema and must survive tools/list rather than being stripped to
      // properties/required. These checks are soft-gated on the negotiated
      // protocol version (see sep2106KeywordCheckStatus): stripping the
      // keywords is only a FAILURE for servers that negotiated the draft
      // protocol version, and SKIPPED otherwise.
      const skippedSuffix = ` (server negotiated protocol version ${negotiatedVersion ?? 'unknown'}; SEP-2106 applies from ${DRAFT_PROTOCOL_VERSION})`;

      // Check 5: composition keywords (allOf / anyOf) preserved
      const allOf = inputSchema['allOf'];
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
        negotiatedVersion
      );

      checks.push({
        id: 'sep-2106-composition-keywords-preserved',
        name: 'JsonSchema2020_12CompositionKeywords',
        description:
          'inputSchema composition keywords (allOf/anyOf) preserved (SEP-2106)',
        status: compositionStatus,
        timestamp: new Date().toISOString(),
        errorMessage: compositionPreserved
          ? undefined
          : (!hasAllOf
              ? 'allOf keyword missing from inputSchema - composition keyword was likely stripped'
              : 'nested anyOf missing from allOf - composition keyword was likely stripped') +
            (compositionStatus === 'SKIPPED' ? skippedSuffix : ''),
        specReferences: sep2106References,
        details: {
          hasAllOf,
          hasNestedAnyOf,
          negotiatedProtocolVersion: negotiatedVersion
        }
      });

      // Check 6: conditional keywords (if / then / else) preserved
      const hasIf = 'if' in inputSchema;
      const hasThen = 'then' in inputSchema;
      const hasElse = 'else' in inputSchema;
      const conditionalPreserved = hasIf && hasThen && hasElse;
      const conditionalStatus = sep2106KeywordCheckStatus(
        conditionalPreserved,
        negotiatedVersion
      );

      checks.push({
        id: 'sep-2106-conditional-keywords-preserved',
        name: 'JsonSchema2020_12ConditionalKeywords',
        description:
          'inputSchema conditional keywords (if/then/else) preserved (SEP-2106)',
        status: conditionalStatus,
        timestamp: new Date().toISOString(),
        errorMessage: conditionalPreserved
          ? undefined
          : `Conditional keywords missing (if=${hasIf}, then=${hasThen}, else=${hasElse}) - likely stripped` +
            (conditionalStatus === 'SKIPPED' ? skippedSuffix : ''),
        specReferences: sep2106References,
        details: {
          hasIf,
          hasThen,
          hasElse,
          negotiatedProtocolVersion: negotiatedVersion
        }
      });

      // Check 7: reference keyword ($anchor) preserved within $defs.address
      const addressDef = defsValue?.['address'] as
        | Record<string, unknown>
        | undefined;
      const hasAnchor = !!addressDef && '$anchor' in addressDef;
      const anchorStatus = sep2106KeywordCheckStatus(
        hasAnchor,
        negotiatedVersion
      );

      checks.push({
        id: 'sep-2106-anchor-keyword-preserved',
        name: 'JsonSchema2020_12AnchorKeyword',
        description:
          'inputSchema reference keyword ($anchor) preserved in $defs (SEP-2106)',
        status: anchorStatus,
        timestamp: new Date().toISOString(),
        errorMessage: hasAnchor
          ? undefined
          : '$anchor missing from $defs.address - reference keyword was likely stripped' +
            (anchorStatus === 'SKIPPED' ? skippedSuffix : ''),
        specReferences: sep2106References,
        details: {
          hasAnchor,
          anchorValue: addressDef?.['$anchor']
        }
      });

      await connection.close();
    } catch (error) {
      checks.push({
        id: 'json-schema-2020-12-error',
        name: 'JsonSchema2020_12Error',
        description: 'JSON Schema 2020-12 conformance test',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences
      });
    }

    return checks;
  }
}
