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
  connectStateless,
  CONFORMANCE_CLIENT_INFO,
  DEFAULT_CLIENT_CAPABILITIES
} from './stateless';
import { DRAFT_PROTOCOL_VERSION } from '../types';
import { takeWireViolations } from '../validation/wire-schema';

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
            result: {
              tools: [],
              resultType: 'complete',
              ttlMs: 0,
              cacheScope: 'private'
            }
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
      expect(response.body?.result).toEqual({
        tools: [],
        resultType: 'complete',
        ttlMs: 0,
        cacheScope: 'private'
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('spec version plumbing', () => {
  test('buildStandardHeaders sends the requested spec version', () => {
    const headers = buildStandardHeaders('tools/list', undefined, {
      specVersion: '2025-11-25'
    });
    expect(headers['MCP-Protocol-Version']).toBe('2025-11-25');
  });

  test('buildStandardHeaders defaults to the draft version', () => {
    const headers = buildStandardHeaders('tools/list');
    expect(headers['MCP-Protocol-Version']).toBe(DRAFT_PROTOCOL_VERSION);
  });

  test('withRequestMeta declares the requested spec version in _meta', () => {
    const params = withRequestMeta({}, '2025-11-25');
    const meta = params._meta as Record<string, unknown>;
    expect(meta['io.modelcontextprotocol/protocolVersion']).toBe('2025-11-25');
  });

  test('withRequestMeta defaults to the draft version', () => {
    const params = withRequestMeta({});
    const meta = params._meta as Record<string, unknown>;
    expect(meta['io.modelcontextprotocol/protocolVersion']).toBe(
      DRAFT_PROTOCOL_VERSION
    );
  });
});

describe('connectStateless', () => {
  test('surfaces HTTP status and body when the error field is not JSON-RPC shaped', async () => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream timeout' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const conn = await connectStateless(`http://localhost:${port}/`);
      await expect(conn.request('tools/list')).rejects.toThrow(
        /HTTP 502.*upstream timeout/
      );
      // The proxy body is deliberately not a JSON-RPC message.
      expect(takeWireViolations().violations).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
