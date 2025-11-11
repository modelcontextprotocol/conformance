/**
 * SEP-1034: Elicitation default values test scenarios for MCP servers
 */

import { ClientScenario, ConformanceCheck } from '../../types.js';
import { connectToServer } from './client-helper.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export class ElicitationDefaultsScenario implements ClientScenario {
  name = 'elicitation-sep1034-defaults';
  description =
    'Test elicitation with default values for all primitive types (SEP-1034)';

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const connection = await connectToServer(serverUrl);

      let capturedRequest: any = null;
      connection.client.setRequestHandler(
        ElicitRequestSchema,
        async (request) => {
          capturedRequest = request;
          return {
            action: 'accept',
            content: {
              name: 'Jane Smith',
              age: 25,
              score: 88.0,
              status: 'inactive',
              verified: false
            }
          };
        }
      );

      await connection.client.callTool({
        name: 'test_elicitation_sep1034_defaults',
        arguments: {}
      });

      // Validate that elicitation was requested
      if (!capturedRequest) {
        checks.push({
          id: 'elicitation-sep1034-general',
          name: 'ElicitationSEP1034General',
          description: 'Server requests elicitation with default values',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: 'Server did not request elicitation from client',
          specReferences: [
            {
              id: 'SEP-1034',
              url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1034'
            }
          ]
        });
        await connection.close();
        return checks;
      }

      const schema = capturedRequest.params?.requestedSchema;
      const properties = schema?.properties;

      // Validate string default
      const stringErrors: string[] = [];
      if (!properties?.name) {
        stringErrors.push('Missing string field "name"');
      } else {
        if (properties.name.type !== 'string') {
          stringErrors.push(
            `Expected type "string", got "${properties.name.type}"`
          );
        }
        if (!('default' in properties.name)) {
          stringErrors.push('Missing default field');
        } else if (properties.name.default !== 'John Doe') {
          stringErrors.push(
            `Expected default "John Doe", got "${properties.name.default}"`
          );
        }
      }

      checks.push({
        id: 'elicitation-sep1034-string-default',
        name: 'ElicitationSEP1034StringDefault',
        description: 'String schema includes default value',
        status: stringErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage:
          stringErrors.length > 0 ? stringErrors.join('; ') : undefined,
        specReferences: [
          {
            id: 'SEP-1034',
            url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1034'
          }
        ],
        details: {
          field: 'name',
          schema: properties?.name
        }
      });

      // Validate integer default
      const integerErrors: string[] = [];
      if (!properties?.age) {
        integerErrors.push('Missing integer field "age"');
      } else {
        if (properties.age.type !== 'integer') {
          integerErrors.push(
            `Expected type "integer", got "${properties.age.type}"`
          );
        }
        if (!('default' in properties.age)) {
          integerErrors.push('Missing default field');
        } else if (properties.age.default !== 30) {
          integerErrors.push(
            `Expected default 30, got ${properties.age.default}`
          );
        }
      }

      checks.push({
        id: 'elicitation-sep1034-integer-default',
        name: 'ElicitationSEP1034IntegerDefault',
        description: 'Integer schema includes default value',
        status: integerErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage:
          integerErrors.length > 0 ? integerErrors.join('; ') : undefined,
        specReferences: [
          {
            id: 'SEP-1034',
            url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1034'
          }
        ],
        details: {
          field: 'age',
          schema: properties?.age
        }
      });

      // Validate number default
      const numberErrors: string[] = [];
      if (!properties?.score) {
        numberErrors.push('Missing number field "score"');
      } else {
        if (properties.score.type !== 'number') {
          numberErrors.push(
            `Expected type "number", got "${properties.score.type}"`
          );
        }
        if (!('default' in properties.score)) {
          numberErrors.push('Missing default field');
        } else if (properties.score.default !== 95.5) {
          numberErrors.push(
            `Expected default 95.5, got ${properties.score.default}`
          );
        }
      }

      checks.push({
        id: 'elicitation-sep1034-number-default',
        name: 'ElicitationSEP1034NumberDefault',
        description: 'Number schema includes default value',
        status: numberErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage:
          numberErrors.length > 0 ? numberErrors.join('; ') : undefined,
        specReferences: [
          {
            id: 'SEP-1034',
            url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1034'
          }
        ],
        details: {
          field: 'score',
          schema: properties?.score
        }
      });

      // Validate enum default
      const enumErrors: string[] = [];
      if (!properties?.status) {
        enumErrors.push('Missing enum field "status"');
      } else {
        if (properties.status.type !== 'string') {
          enumErrors.push(
            `Expected type "string", got "${properties.status.type}"`
          );
        }
        if (!properties.status.enum || !Array.isArray(properties.status.enum)) {
          enumErrors.push('Missing or invalid enum array');
        }
        if (!('default' in properties.status)) {
          enumErrors.push('Missing default field');
        } else {
          if (properties.status.default !== 'active') {
            enumErrors.push(
              `Expected default "active", got "${properties.status.default}"`
            );
          }
          if (
            properties.status.enum &&
            !properties.status.enum.includes(properties.status.default)
          ) {
            enumErrors.push(
              `Default value "${properties.status.default}" is not a valid enum member`
            );
          }
        }
      }

      checks.push({
        id: 'elicitation-sep1034-enum-default',
        name: 'ElicitationSEP1034EnumDefault',
        description: 'Enum schema includes valid default value',
        status: enumErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: enumErrors.length > 0 ? enumErrors.join('; ') : undefined,
        specReferences: [
          {
            id: 'SEP-1034',
            url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1034'
          }
        ],
        details: {
          field: 'status',
          schema: properties?.status
        }
      });

      // Validate boolean default (regression test - already supported)
      const booleanErrors: string[] = [];
      if (!properties?.verified) {
        booleanErrors.push('Missing boolean field "verified"');
      } else {
        if (properties.verified.type !== 'boolean') {
          booleanErrors.push(
            `Expected type "boolean", got "${properties.verified.type}"`
          );
        }
        if (!('default' in properties.verified)) {
          booleanErrors.push('Missing default field');
        } else if (properties.verified.default !== true) {
          booleanErrors.push(
            `Expected default true, got ${properties.verified.default}`
          );
        }
      }

      checks.push({
        id: 'elicitation-sep1034-boolean-default',
        name: 'ElicitationSEP1034BooleanDefault',
        description: 'Boolean schema includes default value',
        status: booleanErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage:
          booleanErrors.length > 0 ? booleanErrors.join('; ') : undefined,
        specReferences: [
          {
            id: 'SEP-1034',
            url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1034'
          }
        ],
        details: {
          field: 'verified',
          schema: properties?.verified
        }
      });

      await connection.close();
    } catch (error) {
      checks.push({
        id: 'elicitation-sep1034-general',
        name: 'ElicitationSEP1034General',
        description: 'Server requests elicitation with default values',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [
          {
            id: 'SEP-1034',
            url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1034'
          }
        ]
      });
    }

    return checks;
  }
}
