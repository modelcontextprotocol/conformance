/**
 * Stateful connection: 2025-x lifecycle (initialize handshake, session id).
 *
 * Backed by the SDK's `Client` so we don't reimplement the handshake, session
 * header, or SSE response parsing. The SDK is the driver here, not the
 * system-under-test; its own correctness is covered by the client-conformance
 * scenarios.
 */

import {
  ResultSchema,
  McpError,
  ProgressNotificationSchema,
  LoggingMessageNotificationSchema
} from '@modelcontextprotocol/sdk/types.js';
import { connectToServer } from './sdk-client';
import type { JSONRPCNotification } from '../spec-types/2025-11-25';
import { JsonRpcError, type Connection, type ConnectOptions } from './index';

export async function connectStateful(
  serverUrl: string,
  opts: ConnectOptions = {}
): Promise<Connection> {
  const { client, close } = await connectToServer(serverUrl, opts);

  const notifications: JSONRPCNotification[] = [];
  const collect = (n: unknown) => {
    // The SDK's Zod parsing strips the jsonrpc field; restore it so collected
    // notifications match the JSONRPCNotification wire shape, as
    // connectStateless provides.
    notifications.push({
      jsonrpc: '2.0',
      ...(n as object)
    } as JSONRPCNotification);
  };
  // The SDK pre-registers a handler for notifications/progress (to drive the
  // onprogress callback feature), so it never reaches the fallback. Register
  // explicit collectors for the schemas the SDK claims, then a fallback for
  // everything else.
  client.setNotificationHandler(ProgressNotificationSchema, async (n) =>
    collect(n)
  );
  client.setNotificationHandler(LoggingMessageNotificationSchema, async (n) =>
    collect(n)
  );
  client.fallbackNotificationHandler = async (n) => collect(n);

  return {
    notifications,

    // Synthesize the discover-shape from the SDK Client's post-`initialize`
    // accessors so the stateful Connection exposes the same surface the
    // stateless wire's `server/discover` produces.
    async discover(): Promise<Record<string, unknown>> {
      return {
        capabilities: client.getServerCapabilities() ?? {},
        serverInfo: client.getServerVersion() ?? {},
        instructions: client.getInstructions()
      };
    },

    async request<R>(
      method: string,
      params: Record<string, unknown> = {},
      extraHeaders?: Record<string, string>
    ): Promise<R> {
      if (extraHeaders && Object.keys(extraHeaders).length > 0) {
        // The SDK Client transport manages headers internally; per-call
        // override would require dropping to raw fetch. No 2025-x
        // scenario needs this today; flag loudly if one shows up.
        throw new Error(
          'connectStateful.request: extraHeaders is unsupported on the stateful wire (per-call header overrides require raw fetch on the stateless wire only)'
        );
      }
      try {
        return (await client.request({ method, params }, ResultSchema)) as R;
      } catch (e) {
        // Normalize so scenarios always see JsonRpcError regardless of impl.
        // The SDK prefixes messages with "MCP error <code>: "; strip it so
        // the message matches what connectStateless surfaces.
        if (e instanceof McpError) {
          throw new JsonRpcError(
            e.code,
            e.message.replace(/^MCP error -?\d+: /, ''),
            e.data
          );
        }
        throw e;
      }
    },

    close
  };
}
