/**
 * SEP-1036: URL mode elicitation test scenarios for MCP servers
 */

import { ClientScenario, ConformanceCheck } from '../../types.js';
import { connectToServerWithUrlElicitation } from './client-helper.js';
import {
  ElicitRequestSchema,
  ElicitationCompleteNotificationSchema,
  ErrorCode,
  McpError
} from '@modelcontextprotocol/sdk/types.js';

export class ElicitationUrlModeScenario implements ClientScenario {
  name = 'elicitation-sep1036-url-mode';
  description = `Test URL mode elicitation per SEP-1036.

**Server Implementation Requirements:**

Implement three tools:

1. \`test_elicitation_sep1036_url\` (no arguments) - Requests URL mode elicitation from client with:
   - \`mode\`: "url"
   - \`message\`: Human-readable explanation (non-empty string)
   - \`url\`: Valid URL (e.g., "https://mcp.example.com/test")
   - \`elicitationId\`: Unique identifier (non-empty string)

   **Returns**: Text content with the elicitation action received

2. \`test_elicitation_sep1036_error\` (no arguments) - Throws URLElicitationRequiredError:
   - Error code: -32042
   - Error data contains \`elicitations\` array with URL mode elicitation objects

3. \`test_elicitation_sep1036_complete\` (no arguments) - Tests completion notification flow:
   - Requests URL mode elicitation
   - When client accepts, sends \`notifications/elicitation/complete\` notification
   - The notification must include the matching \`elicitationId\`

**Example elicitation request:**
\`\`\`json
{
  "method": "elicitation/create",
  "params": {
    "mode": "url",
    "message": "Please complete authorization",
    "url": "https://mcp.example.com/test",
    "elicitationId": "sep1036-test-uuid"
  }
}
\`\`\``;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const connection = await connectToServerWithUrlElicitation(serverUrl);

      // Part 1: Test URL mode elicitation request flow
      let capturedRequest: any = null;
      connection.client.setRequestHandler(
        ElicitRequestSchema,
        async (request) => {
          capturedRequest = request;
          // URL mode response should have action but no content
          return {
            action: 'accept'
          };
        }
      );

      await connection.client.callTool({
        name: 'test_elicitation_sep1036_url',
        arguments: {}
      });

      // Validate that elicitation was requested
      if (!capturedRequest) {
        checks.push({
          id: 'sep1036-url-general',
          name: 'URLElicitationSEP1036General',
          description: 'Server requests URL mode elicitation',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: 'Server did not request elicitation from client',
          specReferences: [
            {
              id: 'SEP-1036',
              url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/pull/887'
            }
          ]
        });
        await connection.close();
        return checks;
      }

      const params = capturedRequest.params;

      // Check 1: Validate mode is "url"
      const modeErrors: string[] = [];
      if (!params?.mode) {
        modeErrors.push('Missing mode parameter');
      } else if (params.mode !== 'url') {
        modeErrors.push(`Expected mode "url", got "${params.mode}"`);
      }

      checks.push({
        id: 'sep1036-url-mode',
        name: 'URLModeRequired',
        description: 'URL elicitation request specifies mode as "url"',
        status: modeErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: modeErrors.length > 0 ? modeErrors.join('; ') : undefined,
        specReferences: [
          {
            id: 'SEP-1036',
            url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/pull/887'
          }
        ],
        details: {
          mode: params?.mode
        }
      });

      // Check 2: Validate message is present and non-empty
      const messageErrors: string[] = [];
      if (!params?.message) {
        messageErrors.push('Missing message parameter');
      } else if (typeof params.message !== 'string') {
        messageErrors.push(
          `Expected string message, got ${typeof params.message}`
        );
      } else if (params.message.trim() === '') {
        messageErrors.push('Message is empty');
      }

      checks.push({
        id: 'sep1036-url-message',
        name: 'URLMessagePresent',
        description: 'URL elicitation request includes human-readable message',
        status: messageErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage:
          messageErrors.length > 0 ? messageErrors.join('; ') : undefined,
        specReferences: [
          {
            id: 'SEP-1036',
            url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/pull/887'
          }
        ],
        details: {
          message: params?.message
        }
      });

      // Check 3: Validate url is present and valid
      const urlErrors: string[] = [];
      if (!params?.url) {
        urlErrors.push('Missing url parameter');
      } else if (typeof params.url !== 'string') {
        urlErrors.push(`Expected string url, got ${typeof params.url}`);
      } else {
        try {
          const urlObj = new URL(params.url);
          // URL should use HTTP or HTTPS protocol
          if (urlObj.protocol !== 'https:' && urlObj.protocol !== 'http:') {
            urlErrors.push(
              `URL must use HTTP or HTTPS protocol, got "${urlObj.protocol}"`
            );
          }
        } catch {
          urlErrors.push(`Invalid URL format: ${params.url}`);
        }
      }

      checks.push({
        id: 'sep1036-url-field',
        name: 'URLFieldValid',
        description: 'URL elicitation request includes valid URL',
        status: urlErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: urlErrors.length > 0 ? urlErrors.join('; ') : undefined,
        specReferences: [
          {
            id: 'SEP-1036',
            url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/pull/887'
          }
        ],
        details: {
          url: params?.url
        }
      });

      // Check 4: Validate elicitationId is present and valid
      const idErrors: string[] = [];
      if (!params?.elicitationId) {
        idErrors.push('Missing elicitationId parameter');
      } else if (typeof params.elicitationId !== 'string') {
        idErrors.push(
          `Expected string elicitationId, got ${typeof params.elicitationId}`
        );
      } else if (params.elicitationId.trim() === '') {
        idErrors.push('elicitationId is empty');
      }

      checks.push({
        id: 'sep1036-url-elicitation-id',
        name: 'URLElicitationIdPresent',
        description: 'URL elicitation request includes unique elicitationId',
        status: idErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: idErrors.length > 0 ? idErrors.join('; ') : undefined,
        specReferences: [
          {
            id: 'SEP-1036',
            url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/pull/887'
          }
        ],
        details: {
          elicitationId: params?.elicitationId
        }
      });

      // Check 5: URL mode response has action (this is implicitly tested by the tool completing)
      // We successfully returned { action: 'accept' } and the tool completed
      checks.push({
        id: 'sep1036-url-response-action',
        name: 'URLResponseAction',
        description: 'Client response has action field',
        status: 'SUCCESS',
        timestamp: new Date().toISOString(),
        specReferences: [
          {
            id: 'SEP-1036',
            url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/pull/887'
          }
        ],
        details: {
          action: 'accept'
        }
      });

      // Check 6: URL mode response should not have content field
      // Our handler returned { action: 'accept' } without content, which is correct
      checks.push({
        id: 'sep1036-url-response-no-content',
        name: 'URLResponseNoContent',
        description: 'URL mode response omits content field',
        status: 'SUCCESS',
        timestamp: new Date().toISOString(),
        specReferences: [
          {
            id: 'SEP-1036',
            url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/pull/887'
          }
        ],
        details: {
          note: 'Response contained action only, no content field'
        }
      });

      // Part 2: Test URLElicitationRequiredError flow
      let errorReceived: McpError | null = null;
      try {
        await connection.client.callTool({
          name: 'test_elicitation_sep1036_error',
          arguments: {}
        });
        // If we get here, the tool didn't throw an error as expected
        checks.push({
          id: 'sep1036-url-error-code',
          name: 'URLErrorCode',
          description:
            'Server returns URLElicitationRequiredError (code -32042)',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage:
            'Tool did not throw URLElicitationRequiredError as expected',
          specReferences: [
            {
              id: 'SEP-1036',
              url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/pull/887'
            }
          ]
        });
      } catch (error) {
        if (error instanceof McpError) {
          errorReceived = error;
        } else if (error instanceof Error && 'code' in error) {
          // Handle case where error might not be McpError instance but has code
          errorReceived = error as unknown as McpError;
        }

        // Check 7: Validate error code is -32042
        const errorCodeErrors: string[] = [];
        if (!errorReceived) {
          errorCodeErrors.push('Did not receive an MCP error');
        } else if (errorReceived.code !== ErrorCode.UrlElicitationRequired) {
          errorCodeErrors.push(
            `Expected error code ${ErrorCode.UrlElicitationRequired} (-32042), got ${errorReceived.code}`
          );
        }

        checks.push({
          id: 'sep1036-url-error-code',
          name: 'URLErrorCode',
          description:
            'Server returns URLElicitationRequiredError (code -32042)',
          status: errorCodeErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage:
            errorCodeErrors.length > 0 ? errorCodeErrors.join('; ') : undefined,
          specReferences: [
            {
              id: 'SEP-1036',
              url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/pull/887'
            }
          ],
          details: {
            errorCode: errorReceived?.code
          }
        });

        // Check 8: Validate error data contains elicitations array
        const elicitationsErrors: string[] = [];
        const errorData = errorReceived?.data as
          | { elicitations?: unknown[] }
          | undefined;
        if (!errorData?.elicitations) {
          elicitationsErrors.push('Error data missing elicitations array');
        } else if (!Array.isArray(errorData.elicitations)) {
          elicitationsErrors.push('elicitations is not an array');
        } else if (errorData.elicitations.length === 0) {
          elicitationsErrors.push('elicitations array is empty');
        }

        checks.push({
          id: 'sep1036-url-error-elicitations',
          name: 'URLErrorElicitations',
          description: 'Error data contains elicitations array',
          status: elicitationsErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage:
            elicitationsErrors.length > 0
              ? elicitationsErrors.join('; ')
              : undefined,
          specReferences: [
            {
              id: 'SEP-1036',
              url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/pull/887'
            }
          ],
          details: {
            elicitationsCount: errorData?.elicitations?.length
          }
        });

        // Check 9: Validate each elicitation has required URL mode fields
        const structureErrors: string[] = [];
        if (errorData?.elicitations && Array.isArray(errorData.elicitations)) {
          for (let i = 0; i < errorData.elicitations.length; i++) {
            const elicit = errorData.elicitations[i] as Record<string, unknown>;
            if (!elicit.mode || elicit.mode !== 'url') {
              structureErrors.push(
                `Elicitation[${i}]: missing or invalid mode (expected "url")`
              );
            }
            if (!elicit.url || typeof elicit.url !== 'string') {
              structureErrors.push(
                `Elicitation[${i}]: missing or invalid url field`
              );
            }
            if (
              !elicit.elicitationId ||
              typeof elicit.elicitationId !== 'string'
            ) {
              structureErrors.push(
                `Elicitation[${i}]: missing or invalid elicitationId field`
              );
            }
            if (!elicit.message || typeof elicit.message !== 'string') {
              structureErrors.push(
                `Elicitation[${i}]: missing or invalid message field`
              );
            }
          }
        }

        checks.push({
          id: 'sep1036-url-error-structure',
          name: 'URLErrorStructure',
          description: 'Each elicitation has required URL mode fields',
          status: structureErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage:
            structureErrors.length > 0 ? structureErrors.join('; ') : undefined,
          specReferences: [
            {
              id: 'SEP-1036',
              url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/pull/887'
            }
          ],
          details: {
            elicitations: errorData?.elicitations
          }
        });
      }

      // Part 3: Test completion notification flow
      let completionNotificationReceived = false;
      let receivedElicitationId: string | null = null;
      let capturedElicitationIdFromRequest: string | null = null;

      // Set up notification handler for completion
      connection.client.setNotificationHandler(
        ElicitationCompleteNotificationSchema,
        (notification) => {
          completionNotificationReceived = true;
          receivedElicitationId = notification.params.elicitationId;
        }
      );

      // Update the request handler to capture the elicitationId
      connection.client.setRequestHandler(
        ElicitRequestSchema,
        async (request) => {
          capturedElicitationIdFromRequest = request.params.elicitationId;
          return { action: 'accept' };
        }
      );

      try {
        await connection.client.callTool({
          name: 'test_elicitation_sep1036_complete',
          arguments: {}
        });

        // Small delay to allow notification to be received
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Check 10: Verify completion notification was received
        const notificationErrors: string[] = [];
        if (!completionNotificationReceived) {
          notificationErrors.push(
            'Server did not send notifications/elicitation/complete notification'
          );
        }

        checks.push({
          id: 'sep1036-url-completion-notification',
          name: 'URLCompletionNotification',
          description:
            'Server sends notifications/elicitation/complete after out-of-band completion',
          status: notificationErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage:
            notificationErrors.length > 0
              ? notificationErrors.join('; ')
              : undefined,
          specReferences: [
            {
              id: 'SEP-1036',
              url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/pull/887'
            }
          ],
          details: {
            notificationReceived: completionNotificationReceived
          }
        });

        // Check 11: Verify elicitationId matches
        const idMatchErrors: string[] = [];
        if (completionNotificationReceived) {
          if (!receivedElicitationId) {
            idMatchErrors.push('Completion notification missing elicitationId');
          } else if (
            capturedElicitationIdFromRequest &&
            receivedElicitationId !== capturedElicitationIdFromRequest
          ) {
            idMatchErrors.push(
              `elicitationId mismatch: request had "${capturedElicitationIdFromRequest}", notification had "${receivedElicitationId}"`
            );
          }
        }

        checks.push({
          id: 'sep1036-url-completion-id-match',
          name: 'URLCompletionIdMatch',
          description:
            'Completion notification elicitationId matches the original request',
          status:
            completionNotificationReceived && idMatchErrors.length === 0
              ? 'SUCCESS'
              : completionNotificationReceived
                ? 'FAILURE'
                : 'SKIPPED',
          timestamp: new Date().toISOString(),
          errorMessage:
            idMatchErrors.length > 0 ? idMatchErrors.join('; ') : undefined,
          specReferences: [
            {
              id: 'SEP-1036',
              url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/pull/887'
            }
          ],
          details: {
            requestElicitationId: capturedElicitationIdFromRequest,
            notificationElicitationId: receivedElicitationId
          }
        });
      } catch (error) {
        checks.push({
          id: 'sep1036-url-completion-notification',
          name: 'URLCompletionNotification',
          description:
            'Server sends notifications/elicitation/complete after out-of-band completion',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage: `Tool call failed: ${error instanceof Error ? error.message : String(error)}`,
          specReferences: [
            {
              id: 'SEP-1036',
              url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/pull/887'
            }
          ]
        });
      }

      await connection.close();
    } catch (error) {
      checks.push({
        id: 'sep1036-url-general',
        name: 'URLElicitationSEP1036General',
        description: 'Server requests URL mode elicitation',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [
          {
            id: 'SEP-1036',
            url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/pull/887'
          }
        ]
      });
    }

    return checks;
  }
}
