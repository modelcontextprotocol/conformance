/**
 * Helper utilities for creating MCP clients to test servers
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  LoggingMessageNotificationSchema,
  ProgressNotificationSchema
} from '@modelcontextprotocol/sdk/types.js';

export interface MCPClientConnection {
  client: Client;
  close: () => Promise<void>;
}

/**
 * Create and connect an MCP client to a server.
 *
 * The returned `close()` sends an HTTP DELETE to terminate the server-side
 * session (per the Streamable HTTP transport spec) before closing the client,
 * so each scenario leaves the server hermetic. A server that responds 405
 * (DELETE not supported) is tolerated, since the spec allows that.
 */
export async function connectToServer(
  serverUrl: string
): Promise<MCPClientConnection> {
  const client = new Client(
    {
      name: 'conformance-test-client',
      version: '1.0.0'
    },
    {
      capabilities: {
        // Client capabilities
        sampling: {},
        elicitation: {}
      }
    }
  );

  const transport = new StreamableHTTPClientTransport(new URL(serverUrl));

  await client.connect(transport);

  return {
    client,
    close: async () => {
      if (transport.sessionId) {
        try {
          await transport.terminateSession();
        } catch {
          // The spec allows the server to respond 405 to a DELETE; best-effort.
        }
      }
      await client.close();
    }
  };
}

/**
 * Best-effort HTTP DELETE to terminate a raw (non-SDK) session.
 *
 * Used by scenarios that open sessions via raw `fetch` instead of going through
 * the SDK's StreamableHTTPClientTransport. Failures are swallowed because the
 * spec allows servers to respond 405, and cleanup must not derail the scenario.
 */
export async function terminateSessionRaw(
  serverUrl: string,
  sessionId: string,
  protocolVersion: string
): Promise<void> {
  try {
    await fetch(serverUrl, {
      method: 'DELETE',
      headers: {
        'mcp-session-id': sessionId,
        'MCP-Protocol-Version': protocolVersion
      }
    });
  } catch {
    // best-effort cleanup
  }
}

/**
 * Helper to collect notifications (logging and progress)
 */
export class NotificationCollector {
  private loggingNotifications: any[] = [];
  private progressNotifications: any[] = [];

  constructor(client: Client) {
    // Set up notification handler for logging messages
    client.setNotificationHandler(
      LoggingMessageNotificationSchema,
      (notification) => {
        this.loggingNotifications.push(notification);
      }
    );

    // Set up notification handler for progress notifications
    client.setNotificationHandler(
      ProgressNotificationSchema,
      (notification) => {
        this.progressNotifications.push(notification);
      }
    );
  }

  /**
   * Get all collected logging notifications
   */
  getLoggingNotifications(): any[] {
    return this.loggingNotifications;
  }

  /**
   * Get all collected progress notifications
   */
  getProgressNotifications(): any[] {
    return this.progressNotifications;
  }

  /**
   * Get all notifications (for backward compatibility)
   */
  getNotifications(): any[] {
    return this.loggingNotifications;
  }
}
