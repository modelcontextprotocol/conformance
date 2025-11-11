/**
 * SEP-1330: Elicitation enum schema improvements test scenarios for MCP servers
 */

import { ClientScenario, ConformanceCheck } from '../../types.js';
import { connectToServer } from './client-helper.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export class ElicitationEnumsScenario implements ClientScenario {
  name = 'elicitation-sep1330-enums';
  description = 'Test elicitation with enum schema improvements (SEP-1330)';

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const connection = await connectToServer(serverUrl);

      let capturedRequest: any = null;
      connection.client.setRequestHandler(
        ElicitRequestSchema,
        async (request) => {
          capturedRequest = request;
          // Return mock data for all enum types
          return {
            action: 'accept',
            content: {
              untitledSingle: 'option1',
              titledSingle: 'value1',
              legacyEnum: 'opt1',
              untitledMulti: ['option1', 'option2'],
              titledMulti: ['value1', 'value2']
            }
          };
        }
      );

      await connection.client.callTool({
        name: 'test_elicitation_sep1330_enums',
        arguments: {}
      });

      // Validate that elicitation was requested
      if (!capturedRequest) {
        checks.push({
          id: 'elicitation-sep1330-general',
          name: 'ElicitationSEP1330General',
          description: 'Server requests elicitation with enum schemas',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: 'Server did not request elicitation from client',
          specReferences: [
            {
              id: 'SEP-1330',
              url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1330'
            }
          ]
        });
        await connection.close();
        return checks;
      }

      const schema = capturedRequest.params?.requestedSchema;
      const properties = schema?.properties;

      // Validate untitled single-select enum
      const untitledSingleErrors: string[] = [];
      if (!properties?.untitledSingle) {
        untitledSingleErrors.push(
          'Missing untitled single-select enum field "untitledSingle"'
        );
      } else {
        if (properties.untitledSingle.type !== 'string') {
          untitledSingleErrors.push(
            `Expected type "string", got "${properties.untitledSingle.type}"`
          );
        }
        if (
          !properties.untitledSingle.enum ||
          !Array.isArray(properties.untitledSingle.enum)
        ) {
          untitledSingleErrors.push('Missing or invalid enum array');
        }
        if (properties.untitledSingle.oneOf) {
          untitledSingleErrors.push(
            'Untitled enum should not have oneOf property'
          );
        }
        if (properties.untitledSingle.enumNames) {
          untitledSingleErrors.push(
            'Untitled enum should not have enumNames property'
          );
        }
      }

      checks.push({
        id: 'elicitation-sep1330-untitled-single',
        name: 'ElicitationSEP1330UntitledSingle',
        description: 'Untitled single-select enum schema uses enum array',
        status: untitledSingleErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage:
          untitledSingleErrors.length > 0
            ? untitledSingleErrors.join('; ')
            : undefined,
        specReferences: [
          {
            id: 'SEP-1330',
            url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1330'
          }
        ],
        details: {
          field: 'untitledSingle',
          schema: properties?.untitledSingle
        }
      });

      // Validate titled single-select enum (using oneOf with const/title)
      const titledSingleErrors: string[] = [];
      if (!properties?.titledSingle) {
        titledSingleErrors.push(
          'Missing titled single-select enum field "titledSingle"'
        );
      } else {
        if (properties.titledSingle.type !== 'string') {
          titledSingleErrors.push(
            `Expected type "string", got "${properties.titledSingle.type}"`
          );
        }
        if (
          !properties.titledSingle.oneOf ||
          !Array.isArray(properties.titledSingle.oneOf)
        ) {
          titledSingleErrors.push(
            'Missing or invalid oneOf array for titled enum'
          );
        } else {
          // Validate oneOf structure has const/title pairs
          const invalidItems = properties.titledSingle.oneOf.filter(
            (item: any) =>
              typeof item.const !== 'string' || typeof item.title !== 'string'
          );
          if (invalidItems.length > 0) {
            titledSingleErrors.push(
              `oneOf items must have "const" (string) and "title" (string) properties`
            );
          }
        }
        if (properties.titledSingle.enum) {
          titledSingleErrors.push(
            'Titled enum should use oneOf instead of enum array'
          );
        }
      }

      checks.push({
        id: 'elicitation-sep1330-titled-single',
        name: 'ElicitationSEP1330TitledSingle',
        description:
          'Titled single-select enum schema uses oneOf with const/title',
        status: titledSingleErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage:
          titledSingleErrors.length > 0
            ? titledSingleErrors.join('; ')
            : undefined,
        specReferences: [
          {
            id: 'SEP-1330',
            url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1330'
          }
        ],
        details: {
          field: 'titledSingle',
          schema: properties?.titledSingle
        }
      });

      // Validate legacy titled enum (using enumNames - deprecated)
      const legacyEnumErrors: string[] = [];
      if (!properties?.legacyEnum) {
        legacyEnumErrors.push('Missing legacy titled enum field "legacyEnum"');
      } else {
        if (properties.legacyEnum.type !== 'string') {
          legacyEnumErrors.push(
            `Expected type "string", got "${properties.legacyEnum.type}"`
          );
        }
        if (
          !properties.legacyEnum.enum ||
          !Array.isArray(properties.legacyEnum.enum)
        ) {
          legacyEnumErrors.push('Missing or invalid enum array');
        }
        if (
          !properties.legacyEnum.enumNames ||
          !Array.isArray(properties.legacyEnum.enumNames)
        ) {
          legacyEnumErrors.push(
            'Missing or invalid enumNames array for legacy titled enum'
          );
        } else if (
          properties.legacyEnum.enum &&
          properties.legacyEnum.enumNames.length !==
            properties.legacyEnum.enum.length
        ) {
          legacyEnumErrors.push(
            `enumNames length (${properties.legacyEnum.enumNames.length}) must match enum length (${properties.legacyEnum.enum.length})`
          );
        }
      }

      checks.push({
        id: 'elicitation-sep1330-legacy-enumnames',
        name: 'ElicitationSEP1330LegacyEnumNames',
        description: 'Legacy titled enum schema uses enumNames (deprecated)',
        status: legacyEnumErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage:
          legacyEnumErrors.length > 0 ? legacyEnumErrors.join('; ') : undefined,
        specReferences: [
          {
            id: 'SEP-1330',
            url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1330'
          }
        ],
        details: {
          field: 'legacyEnum',
          schema: properties?.legacyEnum
        }
      });

      // Validate untitled multi-select enum
      const untitledMultiErrors: string[] = [];
      if (!properties?.untitledMulti) {
        untitledMultiErrors.push(
          'Missing untitled multi-select enum field "untitledMulti"'
        );
      } else {
        if (properties.untitledMulti.type !== 'array') {
          untitledMultiErrors.push(
            `Expected type "array", got "${properties.untitledMulti.type}"`
          );
        }
        if (!properties.untitledMulti.items) {
          untitledMultiErrors.push('Missing items property for array type');
        } else {
          if (properties.untitledMulti.items.type !== 'string') {
            untitledMultiErrors.push(
              `Expected items.type "string", got "${properties.untitledMulti.items.type}"`
            );
          }
          if (
            !properties.untitledMulti.items.enum ||
            !Array.isArray(properties.untitledMulti.items.enum)
          ) {
            untitledMultiErrors.push('Missing or invalid items.enum array');
          }
          if (properties.untitledMulti.items.anyOf) {
            untitledMultiErrors.push(
              'Untitled multi-select should use items.enum, not items.anyOf'
            );
          }
        }
      }

      checks.push({
        id: 'elicitation-sep1330-untitled-multi',
        name: 'ElicitationSEP1330UntitledMulti',
        description:
          'Untitled multi-select enum schema uses array with items.enum',
        status: untitledMultiErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage:
          untitledMultiErrors.length > 0
            ? untitledMultiErrors.join('; ')
            : undefined,
        specReferences: [
          {
            id: 'SEP-1330',
            url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1330'
          }
        ],
        details: {
          field: 'untitledMulti',
          schema: properties?.untitledMulti
        }
      });

      // Validate titled multi-select enum (using items.anyOf with const/title)
      const titledMultiErrors: string[] = [];
      if (!properties?.titledMulti) {
        titledMultiErrors.push(
          'Missing titled multi-select enum field "titledMulti"'
        );
      } else {
        if (properties.titledMulti.type !== 'array') {
          titledMultiErrors.push(
            `Expected type "array", got "${properties.titledMulti.type}"`
          );
        }
        if (!properties.titledMulti.items) {
          titledMultiErrors.push('Missing items property for array type');
        } else {
          if (
            !properties.titledMulti.items.anyOf ||
            !Array.isArray(properties.titledMulti.items.anyOf)
          ) {
            titledMultiErrors.push(
              'Missing or invalid items.anyOf array for titled multi-select'
            );
          } else {
            // Validate anyOf structure has const/title pairs
            const invalidItems = properties.titledMulti.items.anyOf.filter(
              (item: any) =>
                typeof item.const !== 'string' || typeof item.title !== 'string'
            );
            if (invalidItems.length > 0) {
              titledMultiErrors.push(
                `items.anyOf entries must have "const" (string) and "title" (string) properties`
              );
            }
          }
          if (properties.titledMulti.items.enum) {
            titledMultiErrors.push(
              'Titled multi-select should use items.anyOf, not items.enum'
            );
          }
        }
      }

      checks.push({
        id: 'elicitation-sep1330-titled-multi',
        name: 'ElicitationSEP1330TitledMulti',
        description:
          'Titled multi-select enum schema uses array with items.anyOf',
        status: titledMultiErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage:
          titledMultiErrors.length > 0
            ? titledMultiErrors.join('; ')
            : undefined,
        specReferences: [
          {
            id: 'SEP-1330',
            url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1330'
          }
        ],
        details: {
          field: 'titledMulti',
          schema: properties?.titledMulti
        }
      });

      await connection.close();
    } catch (error) {
      checks.push({
        id: 'elicitation-sep1330-general',
        name: 'ElicitationSEP1330General',
        description: 'Server requests elicitation with enum schemas',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [
          {
            id: 'SEP-1330',
            url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1330'
          }
        ]
      });
    }

    return checks;
  }
}
