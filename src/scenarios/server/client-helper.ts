/**
 * Helper utilities for creating MCP clients to test servers.
 *
 * Provides two connection modes:
 *  1. SDK-based (connectToServer) — uses the MCP TypeScript SDK for standard
 *     protocol operations.
 *  2. Raw JSON-RPC (RawMcpSession) — uses undici HTTP for draft/experimental
 *     features that the SDK does not yet support.
 *
 * Both modes share the same SDK-based initialize handshake and session ID.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  LoggingMessageNotificationSchema,
  ProgressNotificationSchema
} from '@modelcontextprotocol/sdk/types.js';
import { request } from 'undici';

// ─── JSON-RPC Types ──────────────────────────────────────────────────────────

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

// ─── SDK-based Connection ────────────────────────────────────────────────────

export interface MCPClientConnection {
  client: Client;
  transport: StreamableHTTPClientTransport;
  close: () => Promise<void>;
}

/**
 * Create and connect an MCP client to a server using the SDK.
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
    transport,
    close: async () => {
      await client.close();
    }
  };
}

// ─── Raw JSON-RPC Session ────────────────────────────────────────────────────

/**
 * A raw MCP session for testing draft/experimental protocol features that the
 * SDK does not yet support. Uses the SDK for the standard initialize handshake,
 * then sends raw JSON-RPC over HTTP via undici for subsequent requests.
 *
 * Usage:
 *   const session = await createRawSession(serverUrl);
 *   const response = await session.send('tools/call', { name: 'my-tool', arguments: {} });
 */
export class RawMcpSession {
  private nextId = 1;
  private serverUrl: string;
  private connection: MCPClientConnection | null = null;

  constructor(serverUrl: string) {
    this.serverUrl = serverUrl;
  }

  /**
   * Initialize the MCP session using the SDK's connectToServer(),
   * then extract the session ID for subsequent raw requests.
   */
  async initialize(): Promise<void> {
    this.connection = await connectToServer(this.serverUrl);
  }

  /**
   * Send a JSON-RPC request via raw HTTP.
   * Automatically manages session ID and auto-incrementing JSON-RPC IDs.
   * Handles both JSON and SSE response formats.
   */
  async send(
    method: string,
    params?: Record<string, unknown>
  ): Promise<JsonRpcResponse> {
    const id = this.nextId++;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    };

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params
    });

    const response = await request(this.serverUrl, {
      method: 'POST',
      headers,
      body
    });

    const contentType = response.headers['content-type'] ?? '';

    // Handle SSE responses — parse the last JSON-RPC message from the stream
    // Not doing proper handling of SSE here since none of the MRTR features under test currently require it.
    // This can be expanded if necessary for new features. 
    if (contentType.includes('text/event-stream')) {
      const text = await response.body.text();
      return parseSseResponse(text);
    }

    // Handle direct JSON responses
    return (await response.body.json()) as JsonRpcResponse;
  }

  /**
   * Close the underlying SDK connection.
   */
  async close(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
      this.connection = null;
    }
  }
}

/**
 * Create an initialized raw MCP session ready for testing.
 */
export async function createRawSession(
  serverUrl: string
): Promise<RawMcpSession> {
  const session = new RawMcpSession(serverUrl);
  await session.initialize();
  return session;
}

/**
 * Parse the last JSON-RPC message from an SSE response body.
 */
export function parseSseResponse(sseText: string): JsonRpcResponse {
  const lines = sseText.split('\n');
  let lastData: string | null = null;

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      lastData = line.slice(6);
    }
  }

  if (!lastData) {
    throw new Error('No data found in SSE stream');
  }

  return JSON.parse(lastData) as JsonRpcResponse;
}

// ─── Notification Collector ──────────────────────────────────────────────────
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
