/**
 * Unit tests for the shared stateless request helper (SEP-2575 + SEP-2243):
 * standard header defaults/overrides, `_meta` injection, and JSON parsing.
 */
import http from 'http';
import { describe, test, expect } from 'vitest';
import {
  buildStandardHeaders,
  withRequestMeta,
  sendStatelessRequest,
  CONFORMANCE_CLIENT_INFO,
  DEFAULT_CLIENT_CAPABILITIES
} from './stateless';
import { DRAFT_PROTOCOL_VERSION } from '../types';

describe('buildStandardHeaders', () => {
  test('sets the standard headers pinned to the draft protocol version', () => {
    const headers = buildStandardHeaders('tools/list');
    expect(headers['Mcp-Method']).toBe('tools/list');
    expect(headers['MCP-Protocol-Version']).toBe(DRAFT_PROTOCOL_VERSION);
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Accept).toContain('application/json');
    expect(headers.Accept).toContain('text/event-stream');
    expect(headers['Mcp-Name']).toBeUndefined();
  });

  test('sets Mcp-Name from params.name (tools/call) and params.uri (resources/read)', () => {
    expect(
      buildStandardHeaders('tools/call', { name: 'echo' })['Mcp-Name']
    ).toBe('echo');
    expect(
      buildStandardHeaders('resources/read', { uri: 'file:///a.txt' })[
        'Mcp-Name'
      ]
    ).toBe('file:///a.txt');
  });

  test('overrides replace defaults case-insensitively', () => {
    const headers = buildStandardHeaders('tools/list', undefined, {
      headers: { 'mcp-protocol-version': '2025-06-18' }
    });
    expect(headers['MCP-Protocol-Version']).toBeUndefined();
    expect(headers['mcp-protocol-version']).toBe('2025-06-18');
  });
});

describe('withRequestMeta', () => {
  test('injects the required _meta fields', () => {
    const params = withRequestMeta({ name: 'echo' });
    const meta = params._meta as Record<string, unknown>;
    expect(meta['io.modelcontextprotocol/protocolVersion']).toBe(
      DRAFT_PROTOCOL_VERSION
    );
    expect(meta['io.modelcontextprotocol/clientInfo']).toEqual(
      CONFORMANCE_CLIENT_INFO
    );
    expect(meta['io.modelcontextprotocol/clientCapabilities']).toEqual(
      DEFAULT_CLIENT_CAPABILITIES
    );
    expect(params.name).toBe('echo');
  });

  test('keys already present in params._meta win over the defaults', () => {
    const params = withRequestMeta({
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-06-18' }
    });
    const meta = params._meta as Record<string, unknown>;
    expect(meta['io.modelcontextprotocol/protocolVersion']).toBe('2025-06-18');
    expect(meta['io.modelcontextprotocol/clientInfo']).toEqual(
      CONFORMANCE_CLIENT_INFO
    );
  });
});

describe('sendStatelessRequest', () => {
  test('parses a plain JSON response', async () => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const request = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: { tools: [] }
          })
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const response = await sendStatelessRequest(
        `http://localhost:${port}/`,
        'tools/list'
      );
      expect(response.status).toBe(200);
      expect(response.body?.result).toEqual({ tools: [] });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
