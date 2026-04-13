/**
 * Resources test scenarios for MCP servers
 */

import { ClientScenario, ConformanceCheck, SpecVersion } from '../../types';
import { connectToServer } from './client-helper';
import {
  TextResourceContents,
  BlobResourceContents,
  McpError
} from '@modelcontextprotocol/sdk/types.js';

export class ResourcesListScenario implements ClientScenario {
  name = 'resources-list';
  specVersions: SpecVersion[] = ['2025-06-18', '2025-11-25'];
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
  specVersions: SpecVersion[] = ['2025-06-18', '2025-11-25'];
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
  specVersions: SpecVersion[] = ['2025-06-18', '2025-11-25'];
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
  specVersions: SpecVersion[] = ['2025-06-18', '2025-11-25'];
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
  specVersions: SpecVersion[] = ['2025-06-18', '2025-11-25'];
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

export class ResourcesNotFoundErrorScenario implements ClientScenario {
  name = 'sep-2164-resource-not-found';
  specVersions: SpecVersion[] = ['draft'];
  description = `Test error handling for non-existent resources (SEP-2164).

**Server Implementation Requirements:**

**Endpoint**: \`resources/read\`

When a client requests a URI that does not correspond to any resource, the server:

- **MUST** return a JSON-RPC error with code \`-32602\` (Invalid Params)
- **MUST NOT** return a result with an empty \`contents\` array
- **SHOULD** include the requested \`uri\` in the error \`data\` field

Example error response:

\`\`\`json
{
  "jsonrpc": "2.0",
  "id": 2,
  "error": {
    "code": -32602,
    "message": "Resource not found",
    "data": {
      "uri": "test://nonexistent-resource-for-conformance-testing"
    }
  }
}
\`\`\`

This scenario does not require the server to register any specific resource — it tests behavior when reading a URI the server does not recognize.`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const nonexistentUri =
      'test://nonexistent-resource-for-conformance-testing';
    const specReferences = [
      {
        id: 'SEP-2164',
        url: 'https://modelcontextprotocol.io/specification/draft/server/resources#error-handling'
      }
    ];

    let connection;
    try {
      connection = await connectToServer(serverUrl);
    } catch (error) {
      checks.push({
        id: 'sep-2164-error-code',
        name: 'ResourcesNotFoundErrorCode',
        description:
          'Server returns -32602 (Invalid Params) for non-existent resource',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed to connect: ${error instanceof Error ? error.message : String(error)}`,
        specReferences
      });
      return checks;
    }

    let caughtError: unknown;
    let result: { contents: unknown[] } | undefined;
    try {
      result = await connection.client.readResource({ uri: nonexistentUri });
    } catch (error) {
      caughtError = error;
    }

    // Check 1: MUST return -32602 error code (not empty contents, not other codes)
    const errorCode =
      caughtError instanceof McpError ? caughtError.code : undefined;
    const errorCodeErrors: string[] = [];
    if (result !== undefined) {
      errorCodeErrors.push(
        `Server returned a result instead of an error (contents length: ${result.contents?.length ?? 'undefined'}). Servers MUST NOT return an empty contents array for non-existent resources.`
      );
    } else if (!(caughtError instanceof McpError)) {
      errorCodeErrors.push(
        `Expected a JSON-RPC error, got: ${caughtError instanceof Error ? caughtError.message : String(caughtError)}`
      );
    } else if (errorCode !== -32602) {
      errorCodeErrors.push(
        `Expected error code -32602 (Invalid Params), got ${errorCode}. ` +
          (errorCode === -32002
            ? 'Code -32002 was used in earlier spec versions but SEP-2164 standardizes on -32602.'
            : '')
      );
    }

    checks.push({
      id: 'sep-2164-error-code',
      name: 'ResourcesNotFoundErrorCode',
      description:
        'Server returns -32602 (Invalid Params) for non-existent resource',
      status: errorCodeErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
      timestamp: new Date().toISOString(),
      errorMessage:
        errorCodeErrors.length > 0 ? errorCodeErrors.join('; ') : undefined,
      specReferences,
      details: {
        requestedUri: nonexistentUri,
        receivedErrorCode: errorCode,
        receivedResult: result !== undefined
      }
    });

    // Check 2: SHOULD include uri in error data field
    const errorData =
      caughtError instanceof McpError
        ? (caughtError.data as { uri?: string } | undefined)
        : undefined;
    const dataUriMatches = errorData?.uri === nonexistentUri;

    checks.push({
      id: 'sep-2164-data-uri',
      name: 'ResourcesNotFoundDataUri',
      description:
        'Server includes the requested URI in the error data field (SHOULD)',
      status:
        caughtError instanceof McpError
          ? dataUriMatches
            ? 'SUCCESS'
            : 'WARNING'
          : 'FAILURE',
      timestamp: new Date().toISOString(),
      errorMessage:
        caughtError instanceof McpError
          ? dataUriMatches
            ? undefined
            : `Error data.uri is ${JSON.stringify(errorData?.uri)}, expected "${nonexistentUri}". This is a SHOULD requirement.`
          : 'No JSON-RPC error received; cannot evaluate data field.',
      specReferences,
      details: {
        requestedUri: nonexistentUri,
        receivedDataUri: errorData?.uri
      }
    });

    await connection.close();
    return checks;
  }
}

export class ResourcesUnsubscribeScenario implements ClientScenario {
  name = 'resources-unsubscribe';
  specVersions: SpecVersion[] = ['2025-06-18', '2025-11-25'];
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
