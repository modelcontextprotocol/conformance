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
import { connectToServer } from '../scenarios/server/client-helper';
import type { JSONRPCNotification } from '../spec-types/2025-11-25';
import { JsonRpcError, type Connection, type RequestOptions } from './index';

export async function connectStateful(serverUrl: string): Promise<Connection> {
  const { client, close } = await connectToServer(serverUrl);

  const notifications: JSONRPCNotification[] = [];
  const collect = (n: unknown) => {
    notifications.push(n as JSONRPCNotification);
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

    async request<R>(
      method: string,
      params: Record<string, unknown> = {},
      opts?: RequestOptions
    ): Promise<R> {
      if (opts?.handlers) {
        client.fallbackRequestHandler = async (req) => {
          const h = opts.handlers?.[req.method];
          if (!h) {
            throw new Error(
              `No handler registered for server request '${req.method}'`
            );
          }
          return (await h(req.params)) as Record<string, unknown>;
        };
      }
      const reqParams = opts?.meta
        ? { ...params, _meta: { ...(params._meta as object), ...opts.meta } }
        : params;
      try {
        return (await client.request(
          { method, params: reqParams },
          ResultSchema
        )) as R;
      } catch (e) {
        // Normalize so scenarios always see JsonRpcError regardless of impl.
        if (e instanceof McpError) {
          throw new JsonRpcError(e.code, e.message, e.data);
        }
        throw e;
      }
    },

    close
  };
}
