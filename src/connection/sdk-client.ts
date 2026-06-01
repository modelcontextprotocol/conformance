/**
 * Helper utilities for creating MCP clients to test servers
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  LoggingMessageNotificationSchema,
  ProgressNotificationSchema
} from '@modelcontextprotocol/sdk/types.js';
import { ConformanceCheck } from '../types';

export interface MCPClientConnection {
  client: Client;
  close: () => Promise<void>;
}

/**
 * Emit a single `<scenarioName>-setup` check as FAILURE for a scenario that
 * could not get far enough to evaluate its real checks (connect failure,
 * missing fixture, capability not advertised, etc.).
 *
 * See #248: previously each scenario hand-rolled a try/catch around connect
 * and pinned the setup error onto whichever check ID happened to be first.
 * That mislabels the failure — the error ends up under a check that has
 * nothing to do with the actual problem, and any *other* checks the scenario
 * would have emitted silently disappear. Routing setup failures through this
 * helper gives them a dedicated, semantically honest ID and a consistent
 * output shape across scenarios.
 *
 * The convention is that a scenario that cannot execute counts as a FAILURE;
 * the escape hatches are scenario filtering (`--suite`/`--scenario`) and the
 * expected-failures baseline, not in-scenario skipping or silent passes.
 *
 * @param scenarioName The scenario's `name`; the emitted check id is
 *   `<scenarioName>-setup`.
 * @param error The thrown setup error.
 * @param specReferences Optional spec references to attach to the check.
 * @returns A one-element array, so a scenario can `return reportSetupFailure(...)`.
 */
export function reportSetupFailure(
  scenarioName: string,
  error: unknown,
  specReferences?: ConformanceCheck['specReferences']
): ConformanceCheck[] {
  const message = error instanceof Error ? error.message : String(error);
  return [
    {
      id: `${scenarioName}-setup`,
      name: `${scenarioName} setup`,
      description: `Scenario "${scenarioName}" could not be set up (connect/fixture/capability)`,
      status: 'FAILURE',
      timestamp: new Date().toISOString(),
      errorMessage: `Setup failed: ${message}`,
      ...(specReferences ? { specReferences } : {})
    }
  ];
}

/**
 * Create and connect an MCP client to a server
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
