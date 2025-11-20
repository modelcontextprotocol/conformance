/**
 * JSON Schema 2020-12 conformance test scenario (SEP-1613)
 *
 * Validates that MCP servers correctly preserve JSON Schema 2020-12 keywords
 * in tool definitions, ensuring implementations don't strip $schema, $defs,
 * or additionalProperties fields.
 */

import { ClientScenario, ConformanceCheck } from '../../types.js';
import { connectToServer } from './client-helper.js';

const EXPECTED_TOOL_NAME = 'json_schema_2020_12_tool';
const EXPECTED_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

export class JsonSchema2020_12Scenario implements ClientScenario {
  name = 'json-schema-2020-12';
  description = `Validates JSON Schema 2020-12 keyword preservation (SEP-1613).

**Server Implementation Requirements:**

Implement tool \`${EXPECTED_TOOL_NAME}\` with inputSchema containing JSON Schema 2020-12 features:

\`\`\`json
{
  "name": "${EXPECTED_TOOL_NAME}",
  "description": "Tool with JSON Schema 2020-12 features",
  "inputSchema": {
    "$schema": "${EXPECTED_SCHEMA_DIALECT}",
    "type": "object",
    "$defs": {
      "address": {
        "type": "object",
        "properties": {
          "street": { "type": "string" },
          "city": { "type": "string" }
        }
      }
    },
    "properties": {
      "name": { "type": "string" },
      "address": { "$ref": "#/$defs/address" }
    },
    "additionalProperties": false
  }
}
\`\`\`

**Verification**: The test verifies that \`$schema\`, \`$defs\`, and \`additionalProperties\` are preserved in the tool listing response.`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const specReferences = [
      {
        id: 'SEP-1613',
        url: 'https://github.com/modelcontextprotocol/specification/pull/655'
      }
    ];

    try {
      const connection = await connectToServer(serverUrl);
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
