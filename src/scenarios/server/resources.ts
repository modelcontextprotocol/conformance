/**
 * Resources test scenarios for MCP servers
 */

import { ClientScenario, ConformanceCheck } from '../../types';
import { connectToServer } from './client-helper';
import {
  TextResourceContents,
  BlobResourceContents
} from '@modelcontextprotocol/sdk/types.js';

export class ResourcesListScenario implements ClientScenario {
  name = 'resources-list';
  description = `Test listing available resources.

**Server Implementation Requirements:**

**Endpoint**: \`resources/list\`

**Requirements**:
- Return array of all available **direct resources** (not templates)
- Each resource MUST have:
  - \`uri\` (string)
  - \`name\` (string)
  - \`description\` (string)
  - \`mimeType\` (string, optional)`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const connection = await connectToServer(serverUrl);

      const result = await connection.client.listResources();

      // Validate response structure
      const errors: string[] = [];
      if (!result.resources) {
        errors.push('Missing resources array');
      } else {
        if (!Array.isArray(result.resources)) {
          errors.push('resources is not an array');
        }

        result.resources.forEach((resource, index) => {
          if (!resource.uri) errors.push(`Resource ${index}: missing uri`);
          if (!resource.name) errors.push(`Resource ${index}: missing name`);
        });
      }

      checks.push({
        id: 'resources-list',
        name: 'ResourcesList',
        description: 'Server lists available resources with valid structure',
        status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
        specReferences: [
          {
            id: 'MCP-Resources-List',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/resources#listing-resources'
          }
        ],
        details: {
          resourceCount: result.resources?.length || 0,
          resources: result.resources?.map((r) => r.uri)
        }
      });

      await connection.close();
    } catch (error) {
      checks.push({
        id: 'resources-list',
        name: 'ResourcesList',
        description: 'Server lists available resources with valid structure',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [
          {
            id: 'MCP-Resources-List',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/resources#listing-resources'
          }
        ]
      });
    }

    return checks;
  }
}

export class ResourcesReadTextScenario implements ClientScenario {
  name = 'resources-read-text';
  description = `Test reading text resource.

**Server Implementation Requirements:**

Implement resource \`test://static-text\` that returns:

\`\`\`json
{
  "contents": [
    {
      "uri": "test://static-text",
      "mimeType": "text/plain",
      "text": "This is the content of the static text resource."
    }
  ]
}
\`\`\``;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const connection = await connectToServer(serverUrl);

      const result = await connection.client.readResource({
        uri: 'test://static-text'
      });

      // Validate response
      const errors: string[] = [];
      if (!result.contents) errors.push('Missing contents array');
      if (!Array.isArray(result.contents))
        errors.push('contents is not an array');
      if (result.contents.length === 0) errors.push('contents array is empty');

      const content = result.contents[0] as TextResourceContents | undefined;
      if (content) {
        if (!content.uri) errors.push('Content missing uri');
        if (!content.mimeType) errors.push('Content missing mimeType');
        if (!content.text) errors.push('Content missing text field');
      }

      checks.push({
        id: 'resources-read-text',
        name: 'ResourcesReadText',
        description: 'Read text resource successfully',
        status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
        specReferences: [
          {
            id: 'MCP-Resources-Read',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/resources#reading-resources'
          }
        ],
        details: {
          uri: content?.uri,
          mimeType: content?.mimeType,
          hasText: !!content?.text
        }
      });

      await connection.close();
    } catch (error) {
      checks.push({
        id: 'resources-read-text',
        name: 'ResourcesReadText',
        description: 'Read text resource successfully',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [
          {
            id: 'MCP-Resources-Read',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/resources#reading-resources'
          }
        ]
      });
    }

    return checks;
  }
}

export class ResourcesReadBinaryScenario implements ClientScenario {
  name = 'resources-read-binary';
  description = `Test reading binary resource.

**Server Implementation Requirements:**

Implement resource \`test://static-binary\` that returns:

\`\`\`json
{
  "contents": [
    {
      "uri": "test://static-binary",
      "mimeType": "image/png",
      "blob": "<base64-encoded-png>"
    }
  ]
}
\`\`\``;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const connection = await connectToServer(serverUrl);

      const result = await connection.client.readResource({
        uri: 'test://static-binary'
      });

      // Validate response
      const errors: string[] = [];
      if (!result.contents) errors.push('Missing contents array');
      if (result.contents.length === 0) errors.push('contents array is empty');

      const content = result.contents[0] as BlobResourceContents | undefined;
      if (content) {
        if (!content.uri) errors.push('Content missing uri');
        if (!content.mimeType) errors.push('Content missing mimeType');
        if (!content.blob) errors.push('Content missing blob field');
      }

      checks.push({
        id: 'resources-read-binary',
        name: 'ResourcesReadBinary',
        description: 'Read binary resource successfully',
        status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
        specReferences: [
          {
            id: 'MCP-Resources-Read',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/resources#reading-resources'
          }
        ],
        details: {
          uri: content?.uri,
          mimeType: content?.mimeType,
          hasBlob: !!content?.blob
        }
      });

      await connection.close();
    } catch (error) {
      checks.push({
        id: 'resources-read-binary',
        name: 'ResourcesReadBinary',
        description: 'Read binary resource successfully',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [
          {
            id: 'MCP-Resources-Read',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/resources#reading-resources'
          }
        ]
      });
    }

    return checks;
  }
}

export class ResourcesTemplateReadScenario implements ClientScenario {
  name = 'resources-templates-read';
  description = `Test reading resource from template.

**Server Implementation Requirements:**

Implement resource template \`test://template/{id}/data\` that substitutes parameters.

**Behavior**: When client requests \`test://template/123/data\`, substitute \`{id}\` with \`123\`

Returns (for \`uri: "test://template/123/data"\`):

\`\`\`json
{
  "contents": [
    {
      "uri": "test://template/123/data",
      "mimeType": "application/json",
      "text": "{"id":"123","templateTest":true,"data":"Data for ID: 123"}"
    }
  ]
}
\`\`\``;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const connection = await connectToServer(serverUrl);

      const result = await connection.client.readResource({
        uri: 'test://template/123/data'
      });

      // Validate response
      const errors: string[] = [];
      if (!result.contents) errors.push('Missing contents array');
      if (result.contents.length === 0) errors.push('contents array is empty');

      const content = result.contents[0];
      if (content) {
        if (!content.uri) errors.push('Content missing uri');
        const hasText = 'text' in content;
        const hasBlob = 'blob' in content;
        if (!hasText && !hasBlob) errors.push('Content missing text or blob');

        const text = hasText
          ? (content as TextResourceContents).text
          : hasBlob
            ? '[binary]'
            : '';
        if (typeof text === 'string' && !text.includes('123')) {
          errors.push('Parameter substitution not reflected in content');
        }
      }

      checks.push({
        id: 'resources-templates-read',
        name: 'ResourcesTemplateRead',
        description: 'Read resource from template with parameter substitution',
        status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
        specReferences: [
          {
            id: 'MCP-Resources-Templates',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/resources#resource-templates'
          }
        ],
        details: {
          uri: content?.uri,
          content: content
            ? 'text' in content
              ? (content as TextResourceContents).text
              : (content as BlobResourceContents).blob
            : undefined
        }
      });

      await connection.close();
    } catch (error) {
      checks.push({
        id: 'resources-templates-read',
        name: 'ResourcesTemplateRead',
        description: 'Read resource from template with parameter substitution',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [
          {
            id: 'MCP-Resources-Templates',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/resources#resource-templates'
          }
        ]
      });
    }

    return checks;
  }
}

export class ResourcesSubscribeScenario implements ClientScenario {
  name = 'resources-subscribe';
  description = `Test subscribing to resource updates.

**Server Implementation Requirements:**

**Endpoint**: \`resources/subscribe\`

**Requirements**:
- Accept subscription request with URI
- Track subscribed URIs
- Return empty object \`{}\`

Example request:

\`\`\`json
{
  "method": "resources/subscribe",
  "params": {
    "uri": "test://watched-resource"
  }
}
\`\`\``;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const connection = await connectToServer(serverUrl);

      await connection.client.subscribeResource({
        uri: 'test://watched-resource'
      });

      checks.push({
        id: 'resources-subscribe',
        name: 'ResourcesSubscribe',
        description: 'Subscribe to resource successfully',
        status: 'SUCCESS',
        timestamp: new Date().toISOString(),
        specReferences: [
          {
            id: 'MCP-Resources-Subscribe',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/resources#resource-subscriptions'
          }
        ]
      });

      await connection.close();
    } catch (error) {
      checks.push({
        id: 'resources-subscribe',
        name: 'ResourcesSubscribe',
        description: 'Subscribe to resource successfully',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [
          {
            id: 'MCP-Resources-Subscribe',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/resources#resource-subscriptions'
          }
        ]
      });
    }

    return checks;
  }
}

export class ResourcesUnsubscribeScenario implements ClientScenario {
  name = 'resources-unsubscribe';
  description = `Test unsubscribing from resource.

**Server Implementation Requirements:**

**Endpoint**: \`resources/unsubscribe\`

**Requirements**:
- Accept unsubscribe request with URI
- Remove URI from subscriptions
- Stop sending update notifications for that URI
- Return empty object \`{}\``;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const connection = await connectToServer(serverUrl);

      // First subscribe
      await connection.client.subscribeResource({
        uri: 'test://watched-resource'
      });

      // Then unsubscribe
      await connection.client.unsubscribeResource({
        uri: 'test://watched-resource'
      });

      checks.push({
        id: 'resources-unsubscribe',
        name: 'ResourcesUnsubscribe',
        description: 'Unsubscribe from resource successfully',
        status: 'SUCCESS',
        timestamp: new Date().toISOString(),
        specReferences: [
          {
            id: 'MCP-Resources-Subscribe',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/schema#unsubscriberequest'
          }
        ]
      });

      await connection.close();
    } catch (error) {
      checks.push({
        id: 'resources-unsubscribe',
        name: 'ResourcesUnsubscribe',
        description: 'Unsubscribe from resource successfully',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [
          {
            id: 'MCP-Resources-Subscribe',
            url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/resources#resource-subscriptions'
          }
        ]
      });
    }

    return checks;
  }
}
