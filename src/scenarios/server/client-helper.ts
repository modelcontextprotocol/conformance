/**
 * Helper utilities for creating MCP clients to test servers
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LoggingMessageNotificationSchema, ProgressNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

export interface MCPClientConnection {
    client: Client;
    close: () => Promise<void>;
}

/**
 * Create and connect an MCP client to a server
 */
export async function connectToServer(serverUrl: string): Promise<MCPClientConnection> {
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
            await client.close();
        }
    };
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
