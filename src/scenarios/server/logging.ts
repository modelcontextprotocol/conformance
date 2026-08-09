/**
 * Logging conformance scenarios for MCP servers (2025-06-18 / 2025-11-25).
 *
 * Extends the basic logging-set-level check with:
 * 1. Capability advertisement verification
 * 2. Invalid level rejection (-32602)
 * 3. Threshold filtering behavior
 */

import {
  ClientScenario,
  ConformanceCheck,
  DRAFT_PROTOCOL_VERSION
} from '../../types';
import { JsonRpcError, type RunContext } from '../../connection';
import {
  connectToServer,
  NotificationCollector
} from '../../connection/sdk-client';

const LOG_LEVELS = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency'
] as const;

function levelIndex(level: string): number {
  return LOG_LEVELS.indexOf(level as (typeof LOG_LEVELS)[number]);
}

const SPEC_REFS = [
  {
    id: 'MCP-Logging',
    url: 'https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/logging'
  }
];

export class LoggingCapabilityScenario implements ClientScenario {
  name = 'logging-capability-advertisement';
  readonly source = {
    introducedIn: '2025-06-18',
    removedIn: DRAFT_PROTOCOL_VERSION
  } as const;
  description = `Test that a server advertising the logging capability accepts logging/setLevel.

**Server Implementation Requirements:**

**Capability**: Advertise \`logging: {}\` in the server's capabilities during initialize.

**Endpoint**: \`logging/setLevel\`

**Specification Requirements (1 Check)**:

1. **Capability Advertisement**
   - A server that emits \`notifications/message\` MUST advertise \`logging\` in its capabilities.
   - Verify the server's initialize response includes \`capabilities.logging\`.`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    try {
      const conn = await ctx.connect();
      const discovered = await conn.discover();
      const caps = (discovered as any).capabilities ?? {};

      if (caps.logging !== undefined) {
        checks.push({
          id: 'logging-capability-advertised',
          name: 'LoggingCapabilityAdvertised',
          description:
            'Server advertises logging capability in initialize response',
          status: 'SUCCESS',
          timestamp: new Date().toISOString(),
          specReferences: SPEC_REFS,
          details: { logging: caps.logging }
        });
      } else {
        checks.push({
          id: 'logging-capability-advertised',
          name: 'LoggingCapabilityAdvertised',
          description:
            'Server advertises logging capability in initialize response',
          status: 'WARNING',
          timestamp: new Date().toISOString(),
          errorMessage:
            'Server did not advertise capabilities.logging. ' +
            'A server that supports logging/setLevel MUST include logging in its capabilities.',
          specReferences: SPEC_REFS,
          details: { capabilities: caps }
        });
      }

      await conn.close();
    } catch (error) {
      checks.push({
        id: 'logging-capability-advertised',
        name: 'LoggingCapabilityAdvertised',
        description:
          'Server advertises logging capability in initialize response',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: SPEC_REFS
      });
    }

    return checks;
  }
}

export class LoggingInvalidLevelScenario implements ClientScenario {
  name = 'logging-invalid-level';
  readonly source = {
    introducedIn: '2025-06-18',
    removedIn: DRAFT_PROTOCOL_VERSION
  } as const;
  description = `Test that logging/setLevel rejects invalid severity levels.

**Server Implementation Requirements:**

**Endpoint**: \`logging/setLevel\`

**Specification Requirements (1 Check)**:

1. **Invalid Level Rejection**
   - When a client sends \`logging/setLevel\` with a level value that is not one of the
     eight recognized severity levels, the server SHOULD respond with a JSON-RPC error
     code \`-32602\` (Invalid Params).
   - Valid levels: debug, info, notice, warning, error, critical, alert, emergency`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];

    let conn;
    try {
      conn = await ctx.connect();
    } catch (error) {
      checks.push({
        id: 'logging-invalid-level-rejection',
        name: 'LoggingInvalidLevelRejection',
        description:
          'Server rejects unrecognized logging level with -32602',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: SPEC_REFS
      });
      return checks;
    }

    let caughtError: unknown;
    let result: unknown;
    try {
      result = await conn.request('logging/setLevel', {
        level: 'banana'
      });
    } catch (error) {
      caughtError = error;
    }

    const rpcError =
      caughtError instanceof JsonRpcError ? caughtError : undefined;
    const errorCode = rpcError?.code;

    if (rpcError && errorCode === -32602) {
      checks.push({
        id: 'logging-invalid-level-rejection',
        name: 'LoggingInvalidLevelRejection',
        description:
          'Server rejects unrecognized logging level with -32602',
        status: 'SUCCESS',
        timestamp: new Date().toISOString(),
        specReferences: SPEC_REFS,
        details: {
          invalidLevel: 'banana',
          errorCode: rpcError.code,
          errorMessage: rpcError.message
        }
      });
    } else if (rpcError) {
      checks.push({
        id: 'logging-invalid-level-rejection',
        name: 'LoggingInvalidLevelRejection',
        description:
          'Server rejects unrecognized logging level with -32602',
        status: 'WARNING',
        timestamp: new Date().toISOString(),
        errorMessage:
          `Server returned error code ${errorCode} instead of -32602 for invalid level "banana". ` +
          'The spec says servers SHOULD respond with -32602 (Invalid Params).',
        specReferences: SPEC_REFS,
        details: {
          invalidLevel: 'banana',
          errorCode,
          errorMessage: rpcError.message
        }
      });
    } else if (result !== undefined) {
      checks.push({
        id: 'logging-invalid-level-rejection',
        name: 'LoggingInvalidLevelRejection',
        description:
          'Server rejects unrecognized logging level with -32602',
        status: 'WARNING',
        timestamp: new Date().toISOString(),
        errorMessage:
          'Server accepted unrecognized level "banana" without error. ' +
          'The spec says servers SHOULD respond with -32602 (Invalid Params) for invalid levels.',
        specReferences: SPEC_REFS,
        details: {
          invalidLevel: 'banana',
          result
        }
      });
    } else {
      checks.push({
        id: 'logging-invalid-level-rejection',
        name: 'LoggingInvalidLevelRejection',
        description:
          'Server rejects unrecognized logging level with -32602',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Unexpected error: ${caughtError instanceof Error ? caughtError.message : String(caughtError)}`,
        specReferences: SPEC_REFS
      });
    }

    await conn.close();
    return checks;
  }
}

export class LoggingThresholdFilteringScenario implements ClientScenario {
  name = 'logging-threshold-filtering';
  readonly source = {
    introducedIn: '2025-06-18',
    removedIn: DRAFT_PROTOCOL_VERSION
  } as const;
  description = `Test that log notifications respect the configured severity threshold.

**Server Implementation Requirements:**

**Endpoints**: \`logging/setLevel\`, \`tools/call\`

**Tool**: Implement \`test_tool_with_logging\` (no arguments) that emits log notifications
at multiple severity levels (at minimum: debug and error) via \`notifications/message\`
during execution.

**Specification Requirements (2 Checks)**:

1. **Threshold Suppresses Lower Levels**
   - After setting level to "error", the server MUST NOT emit notifications/message
     at levels below "error" (debug, info, notice, warning).

2. **Threshold Allows Higher Levels**
   - After setting level to "debug", the server SHOULD emit notifications/message
     at all levels (debug through emergency).

**Log Levels** (ascending severity):
debug < info < notice < warning < error < critical < alert < emergency`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const { serverUrl } = ctx;
    const checks: ConformanceCheck[] = [];

    try {
      const connection = await connectToServer(serverUrl, {}, ctx.specVersion);
      const notifications = new NotificationCollector(connection.client);

      // Set level to "error" — should suppress debug/info/notice/warning
      await connection.client.setLoggingLevel('error');

      await connection.client.callTool({
        name: 'test_tool_with_logging',
        arguments: {}
      });

      await new Promise((resolve) => setTimeout(resolve, 200));

      const errorLevelNotifications = notifications.getLoggingNotifications();
      const errorThresholdIdx = levelIndex('error');
      const belowThreshold = errorLevelNotifications.filter((n: any) => {
        const msgLevel = n.params?.level;
        const idx = levelIndex(msgLevel);
        return idx >= 0 && idx < errorThresholdIdx;
      });

      if (errorLevelNotifications.length === 0) {
        checks.push({
          id: 'logging-threshold-suppresses-lower',
          name: 'LoggingThresholdSuppressesLower',
          description:
            'Server does not emit log notifications below the configured level',
          status: 'SKIPPED',
          timestamp: new Date().toISOString(),
          errorMessage:
            'No log notifications received at any level after setting threshold to "error". ' +
            'Cannot verify filtering without log output from test_tool_with_logging.',
          specReferences: SPEC_REFS
        });
      } else if (belowThreshold.length > 0) {
        checks.push({
          id: 'logging-threshold-suppresses-lower',
          name: 'LoggingThresholdSuppressesLower',
          description:
            'Server does not emit log notifications below the configured level',
          status: 'FAILURE',
          timestamp: new Date().toISOString(),
          errorMessage:
            `Received ${belowThreshold.length} notification(s) below "error" threshold: ` +
            belowThreshold.map((n: any) => n.params?.level).join(', '),
          specReferences: SPEC_REFS,
          details: {
            configuredLevel: 'error',
            belowThreshold: belowThreshold.map((n: any) => n.params?.level),
            allReceived: errorLevelNotifications.map(
              (n: any) => n.params?.level
            )
          }
        });
      } else {
        checks.push({
          id: 'logging-threshold-suppresses-lower',
          name: 'LoggingThresholdSuppressesLower',
          description:
            'Server does not emit log notifications below the configured level',
          status: 'SUCCESS',
          timestamp: new Date().toISOString(),
          specReferences: SPEC_REFS,
          details: {
            configuredLevel: 'error',
            receivedLevels: errorLevelNotifications.map(
              (n: any) => n.params?.level
            )
          }
        });
      }

      await connection.close();
    } catch (error) {
      checks.push({
        id: 'logging-threshold-suppresses-lower',
        name: 'LoggingThresholdSuppressesLower',
        description:
          'Server does not emit log notifications below the configured level',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: SPEC_REFS
      });
    }

    // Check 2: Set level to "debug" — should emit all levels
    try {
      const connection = await connectToServer(serverUrl, {}, ctx.specVersion);
      const notifications = new NotificationCollector(connection.client);

      await connection.client.setLoggingLevel('debug');

      await connection.client.callTool({
        name: 'test_tool_with_logging',
        arguments: {}
      });

      await new Promise((resolve) => setTimeout(resolve, 200));

      const debugLevelNotifications = notifications.getLoggingNotifications();

      if (debugLevelNotifications.length === 0) {
        checks.push({
          id: 'logging-threshold-allows-all',
          name: 'LoggingThresholdAllowsAll',
          description:
            'Server emits log notifications at all levels when threshold is "debug"',
          status: 'WARNING',
          timestamp: new Date().toISOString(),
          errorMessage:
            'No log notifications received with threshold at "debug". ' +
            'Server MAY choose not to emit, but this prevents verification of threshold behavior.',
          specReferences: SPEC_REFS
        });
      } else {
        checks.push({
          id: 'logging-threshold-allows-all',
          name: 'LoggingThresholdAllowsAll',
          description:
            'Server emits log notifications at all levels when threshold is "debug"',
          status: 'SUCCESS',
          timestamp: new Date().toISOString(),
          specReferences: SPEC_REFS,
          details: {
            configuredLevel: 'debug',
            notificationCount: debugLevelNotifications.length,
            receivedLevels: debugLevelNotifications.map(
              (n: any) => n.params?.level
            )
          }
        });
      }

      await connection.close();
    } catch (error) {
      checks.push({
        id: 'logging-threshold-allows-all',
        name: 'LoggingThresholdAllowsAll',
        description:
          'Server emits log notifications at all levels when threshold is "debug"',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: SPEC_REFS
      });
    }

    return checks;
  }
}
