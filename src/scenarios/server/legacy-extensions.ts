import type { ClientScenario, ConformanceCheck } from '../../types';
import type { RunContext } from '../../connection';
import { readSseJsonRpcResponse } from '../../connection';
import { terminateSessionRaw } from '../../connection/sdk-client';
import { validateWireMessage } from '../../validation/wire-schema';
import {
  CLIENT_EXTENSIONS,
  SERVER_EXTENSIONS,
  EXTENSIONS_ECHO_TOOL,
  LEGACY_EXTENSION_VERSION,
  EXTENSION_REFERENCES,
  extensionChecks
} from '../legacy-extensions';
import { untestableCheck } from '../untestable';

export class ServerLegacyExtensionsScenario implements ClientScenario {
  name = 'server-legacy-extensions';
  readonly source = { extensionId: 'io.modelcontextprotocol/ui' } as const;
  description = `Optional legacy capability round-trip, pinned to 2025-11-25.
Configure SERVER_EXTENSIONS from SDK_INTEGRATION.md in the SDK server's
capabilities. Implement ${EXTENSIONS_ECHO_TOOL} to return a text JSON object
{ extensions: <client extensions from the SDK capability accessor> }.
Do not hardcode the reported capabilities or read them from raw HTTP input.
Selecting this scenario opts into the fixture contract; absent advertisements
or diagnostic tools fail. It does not test full Apps support or affect core
conformance. The per-request capability lifecycle is not exercised.`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    let sessionId: string | null = null;
    let id = 0;
    // Raw requests pin the actual handshake version and inspect serialization
    // before a harness SDK parser could discard unknown capability fields.
    const request = async (
      method: string,
      params?: Record<string, unknown>,
      notification = false
    ) => {
      const message = {
        jsonrpc: '2.0',
        ...(notification ? {} : { id: ++id }),
        method,
        ...(params ? { params } : {})
      };
      validateWireMessage(LEGACY_EXTENSION_VERSION, message, {
        origin: 'harness',
        context: 'legacy extension probe'
      });
      const response = await fetch(ctx.serverUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': LEGACY_EXTENSION_VERSION,
          ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {})
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(5000)
      });
      if (method === 'initialize')
        sessionId = response.headers.get('mcp-session-id');
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`${method}: HTTP ${response.status}`);
      }
      if (notification) {
        await response.body?.cancel();
        return {};
      }
      const body = response.headers
        .get('content-type')
        ?.includes('text/event-stream')
        ? (await readSseJsonRpcResponse(response, id)).body
        : await response.json();
      validateWireMessage(LEGACY_EXTENSION_VERSION, body, {
        origin: 'implementation',
        context: 'legacy extension response',
        requestMethod: method
      });
      if (!body || body.id !== id || body.error || !body.result)
        throw new Error(`${method}: missing or invalid result`);
      return body.result;
    };
    try {
      const result = await request('initialize', {
        protocolVersion: LEGACY_EXTENSION_VERSION,
        capabilities: { extensions: CLIENT_EXTENSIONS },
        clientInfo: { name: 'legacy-extension-conformance', version: '1.0.0' }
      });
      const correctVersion =
        result.protocolVersion === LEGACY_EXTENSION_VERSION;
      if (correctVersion)
        await request('notifications/initialized', undefined, true);
      checks.push({
        id: 'legacy-extensions-server-handshake',
        name: 'LegacyExtensionHandshake',
        description:
          'Server negotiates 2025-11-25 for the legacy extension fixture',
        status: correctVersion ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: EXTENSION_REFERENCES,
        errorMessage: correctVersion
          ? undefined
          : `Fixture requires 2025-11-25; received ${result.protocolVersion}`
      });
      if (!correctVersion) return checks;
      checks.push(
        ...extensionChecks(
          'server-advertisement',
          result.capabilities?.extensions,
          SERVER_EXTENSIONS
        )
      );
      try {
        const result = await request('tools/call', {
          name: EXTENSIONS_ECHO_TOOL,
          arguments: {}
        });
        const content = result.content as { type: string; text?: string }[];
        const text = content?.find((c) => c.type === 'text')?.text;
        if (result.isError || !text)
          throw new Error('Diagnostic tool returned an error or no text');
        checks.push(
          ...extensionChecks(
            'server-reception',
            JSON.parse(text).extensions,
            CLIENT_EXTENSIONS
          )
        );
      } catch (error) {
        checks.push(
          untestableCheck(
            'legacy-extensions-server-report',
            'LegacyExtensionReport',
            'Server reports SDK-visible client extensions',
            `${EXTENSIONS_ECHO_TOOL} must return JSON text: ${String(error)}`,
            EXTENSION_REFERENCES
          )
        );
      }
    } catch (error) {
      checks.push(
        untestableCheck(
          'legacy-extensions-server-handshake',
          'LegacyExtensionHandshake',
          'Server completes the legacy extension handshake',
          String(error),
          EXTENSION_REFERENCES
        )
      );
    } finally {
      if (sessionId)
        await terminateSessionRaw(
          ctx.serverUrl,
          sessionId,
          LEGACY_EXTENSION_VERSION
        );
    }
    return checks;
  }
}
