/**
 * Helper utilities for creating MCP clients to test servers
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  LoggingMessageNotificationSchema,
  ProgressNotificationSchema,
  type JSONRPCMessage,
  type MessageExtraInfo
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { LATEST_SPEC_VERSION, type SpecVersion } from '../types';
import {
  validateWireMessage,
  type WireOrigin
} from '../validation/wire-schema';
import type { ConnectOptions } from './index';

const DEFAULT_CLIENT_INFO = {
  name: 'conformance-test-client',
  version: '1.0.0'
} as const;

const DEFAULT_CAPABILITIES = {
  sampling: {},
  elicitation: {}
} as const;

export interface MCPClientConnection {
  client: Client;
  close: () => Promise<void>;
}

/**
 * Hook an SDK transport so every raw wire message, in both directions, is
 * validated against the spec JSON schema for `specVersion` (see
 * `src/validation/wire-schema.ts`). Because this sits below the SDK's
 * `Client`, it sees the real bytes of everything the protocol layer does —
 * the `initialize` handshake, server→client requests (elicitation/sampling)
 * and the harness's responses to them, notifications on any stream — with no
 * reconstructed stand-ins and no way for a call path to bypass it.
 *
 * Outbound messages are harness-authored; inbound messages come from the
 * implementation under test. Request ids are tracked per direction so each
 * response is validated against the typed result definition of the request
 * it answers (e.g. an outbound response to `elicitation/create` against
 * `ElicitResult`).
 */
function instrumentTransport(
  transport: Transport,
  specVersion: SpecVersion
): void {
  // Request id → method, per direction. An entry is consumed by the response
  // travelling the opposite way, so the maps stay bounded.
  const harnessRequests = new Map<string | number, string>();
  const implementationRequests = new Map<string | number, string>();

  const validate = (message: unknown, origin: WireOrigin): void => {
    const ownRequests =
      origin === 'harness' ? harnessRequests : implementationRequests;
    const peerRequests =
      origin === 'harness' ? implementationRequests : harnessRequests;
    // `send` accepts arrays (2025-03-26 batches); validate each element with
    // its own classification, then the batch envelope itself.
    for (const m of Array.isArray(message) ? message : [message]) {
      const msg = (typeof m === 'object' && m !== null ? m : {}) as Record<
        string,
        unknown
      >;
      const id = msg.id as string | number | undefined;
      let context: string;
      let requestMethod: string | undefined;
      if (typeof msg.method === 'string') {
        if (id !== undefined) {
          ownRequests.set(id, msg.method);
          context = `stateful request '${msg.method}'`;
        } else {
          context = `stateful notification '${msg.method}'`;
        }
      } else {
        requestMethod = id !== undefined ? peerRequests.get(id) : undefined;
        if (id !== undefined) peerRequests.delete(id);
        context = `stateful response to '${requestMethod ?? `id ${String(id)}`}'`;
      }
      validateWireMessage(specVersion, m, { origin, context, requestMethod });
    }
    if (Array.isArray(message)) {
      validateWireMessage(specVersion, message, {
        origin,
        context: 'stateful batch'
      });
    }
  };

  const originalSend = transport.send.bind(transport);
  transport.send = (message, options) => {
    validate(message, 'harness');
    return originalSend(message, options);
  };

  // The SDK's protocol layer assigns `onmessage` during `client.connect()`;
  // intercept the assignment so the validator sees every inbound message
  // before the handler does.
  let inner:
    | ((message: JSONRPCMessage, extra?: MessageExtraInfo) => void)
    | undefined;
  const wrapped = (message: JSONRPCMessage, extra?: MessageExtraInfo): void => {
    validate(message, 'implementation');
    inner?.(message, extra);
  };
  Object.defineProperty(transport, 'onmessage', {
    configurable: true,
    enumerable: true,
    get: () => (inner === undefined ? undefined : wrapped),
    set: (handler: typeof inner) => {
      inner = handler;
    }
  });
}

/**
 * Create and connect an MCP client to a server. `opts.capabilities` and
 * `opts.clientInfo` override the harness defaults — scenarios that
 * negotiate extensions (tasks, EMA, ...) pass them through to drive a
 * conformant `initialize`. The transport is instrumented so every wire
 * message in both directions is validated against `specVersion`'s spec
 * JSON schema; scenarios that call this directly pass `ctx.specVersion`.
 */
export async function connectToServer(
  serverUrl: string,
  opts: ConnectOptions = {},
  specVersion: SpecVersion = LATEST_SPEC_VERSION
): Promise<MCPClientConnection> {
  const client = new Client(opts.clientInfo ?? DEFAULT_CLIENT_INFO, {
    capabilities: opts.capabilities ?? DEFAULT_CAPABILITIES
  });

  const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
  instrumentTransport(transport, specVersion);

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
