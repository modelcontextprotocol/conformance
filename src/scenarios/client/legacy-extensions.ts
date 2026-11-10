import { createServer, type Server } from 'node:http';
import type { Scenario, ScenarioUrls } from '../../types';
import {
  CLIENT_EXTENSIONS,
  SERVER_EXTENSIONS,
  EXTENSIONS_ECHO_TOOL,
  LEGACY_EXTENSION_VERSION,
  EXTENSION_REFERENCES,
  extensionChecks
} from '../legacy-extensions';
import { untestableCheck } from '../untestable';
import { validateWireMessage } from '../../validation/wire-schema';

export class LegacyExtensionsScenario implements Scenario {
  name = 'legacy-extensions';
  readonly source = { extensionId: 'io.modelcontextprotocol/ui' } as const;
  description = `Optional legacy capability round-trip (fixed protocol 2025-11-25).
Configure the client with CLIENT_EXTENSIONS documented in SDK_INTEGRATION.md.
After initialize, call ${EXTENSIONS_ECHO_TOOL} with { extensions: <server
extensions from the SDK capability accessor> }. Do not echo a hardcoded fixture
or parse the raw initialize response outside the SDK. This tests capability
preservation, not full Apps support, and is not required for core conformance.`;
  private server?: Server;
  private advertised: unknown;
  private observed: unknown;
  private initialized = false;
  private reported = false;
  private version: unknown;

  async start(): Promise<ScenarioUrls> {
    this.advertised = this.observed = this.version = undefined;
    this.initialized = this.reported = false;
    this.server = createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      try {
        let text = '';
        for await (const chunk of req) text += chunk;
        const message = JSON.parse(text);
        validateWireMessage(LEGACY_EXTENSION_VERSION, message, {
          origin: 'implementation',
          context: 'legacy extension client request'
        });
        const send = (result: object) => {
          const response = { jsonrpc: '2.0', id: message.id, result };
          validateWireMessage(LEGACY_EXTENSION_VERSION, response, {
            origin: 'harness',
            context: 'legacy extension response',
            requestMethod: message.method
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
        };
        if (message.method === 'initialize') {
          this.advertised = message.params?.capabilities?.extensions;
          this.version = message.params?.protocolVersion;
          send({
            protocolVersion: LEGACY_EXTENSION_VERSION,
            capabilities: { tools: {}, extensions: SERVER_EXTENSIONS },
            serverInfo: { name: 'legacy-extension-fixture', version: '1.0.0' }
          });
        } else if (message.method === 'notifications/initialized') {
          this.initialized = true;
          res.writeHead(202).end();
        } else if (message.method === 'tools/list') {
          send({
            tools: [
              {
                name: EXTENSIONS_ECHO_TOOL,
                inputSchema: {
                  type: 'object',
                  properties: { extensions: { type: 'object' } },
                  required: ['extensions']
                }
              }
            ]
          });
        } else if (
          message.method === 'tools/call' &&
          message.params?.name === EXTENSIONS_ECHO_TOOL
        ) {
          this.reported = true;
          this.observed = message.params.arguments?.extensions;
          send({ content: [{ type: 'text', text: 'recorded' }] });
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32601, message: 'Method not found' }
            })
          );
        }
      } catch {
        res.writeHead(400).end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === 'string')
      throw new Error('No listening port');
    return { serverUrl: `http://127.0.0.1:${address.port}/mcp` };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server!.close((e) => (e ? reject(e) : resolve()))
    );
    this.server = undefined;
  }

  getChecks() {
    return [
      {
        id: 'legacy-extensions-client-handshake',
        name: 'LegacyExtensionHandshake',
        description: 'Client completes a 2025-11-25 initialize handshake',
        status:
          this.initialized && this.version === LEGACY_EXTENSION_VERSION
            ? ('SUCCESS' as const)
            : ('FAILURE' as const),
        timestamp: new Date().toISOString(),
        specReferences: EXTENSION_REFERENCES,
        errorMessage:
          this.initialized && this.version === LEGACY_EXTENSION_VERSION
            ? undefined
            : 'Expected 2025-11-25 initialization and notifications/initialized'
      },
      ...extensionChecks(
        'client-advertisement',
        this.advertised,
        CLIENT_EXTENSIONS
      ),
      ...(this.reported
        ? extensionChecks('client-reception', this.observed, SERVER_EXTENSIONS)
        : [
            untestableCheck(
              'legacy-extensions-client-report',
              'LegacyExtensionReport',
              'Client reports SDK-visible server extensions',
              `Client did not call ${EXTENSIONS_ECHO_TOOL}`,
              EXTENSION_REFERENCES
            )
          ])
    ];
  }
}
