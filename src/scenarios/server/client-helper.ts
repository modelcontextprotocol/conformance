/**
 * Helper utilities for creating MCP clients to test servers.
 *
 * Provides two connection modes:
 *  1. SDK-based (connectToServer) — uses the MCP TypeScript SDK for standard
 *     protocol operations.
 *  2. Raw JSON-RPC (RawMcpSession) — uses stateless fetch for draft/experimental
 *     features (SEP-2575 pattern: no initialize, no session ID, _meta per request).
 *
 * Both modes share a common client identity.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  LoggingMessageNotificationSchema,
  ProgressNotificationSchema
} from '@modelcontextprotocol/sdk/types.js';
import { DRAFT_PROTOCOL_VERSION } from '../../types';

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

// ─── Raw JSON-RPC Session (Stateless, SEP-2575 pattern) ──────────────────────

/**
 * A raw MCP session for testing draft/experimental protocol features.
 * Uses stateless HTTP requests with _meta on every request (SEP-2575 pattern).
 * No initialize handshake, no session ID.
 *
 * Usage:
 *   const session = await createRawSession(serverUrl);
 *   const response = await session.send('tools/call', { name: 'my-tool', arguments: {} });
 */
export class RawMcpSession {
  private nextId = 1;
  private serverUrl: string;

  constructor(serverUrl: string) {
    this.serverUrl = serverUrl;
  }

  /**
   * Initialize the session. For stateless servers this is a no-op,
   * but kept for API compatibility.
   */
  async initialize(): Promise<void> {
    // Stateless: no handshake needed
  }

  /**
   * Send a JSON-RPC request via raw HTTP (stateless, SEP-2575 pattern).
   * Automatically injects _meta with protocolVersion, clientInfo, clientCapabilities.
   */
  async send(
    method: string,
    params?: Record<string, unknown>
  ): Promise<JsonRpcResponse> {
    const id = this.nextId++;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'MCP-Protocol-Version': DRAFT_PROTOCOL_VERSION
    };

    // Inject _meta into params per SEP-2575
    const enrichedParams = {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': DRAFT_PROTOCOL_VERSION,
        'io.modelcontextprotocol/clientInfo': {
          name: 'conformance-test-client',
          version: '1.0.0'
        },
        'io.modelcontextprotocol/clientCapabilities': {
          sampling: {},
          elicitation: {}
        },
        ...(params?._meta as Record<string, unknown> | undefined)
      }
    };

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params: enrichedParams
    });

    const response = await fetch(this.serverUrl, {
      method: 'POST',
      headers,
      body
    });

    return (await response.json()) as JsonRpcResponse;
  }

  /**
   * Close the session. No-op for stateless sessions.
   */
  async close(): Promise<void> {
    // Stateless: nothing to close
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
