import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import {
  inspectDraftRequest,
  sendDraftDiscovery,
  sendDraftResult
} from './draft-protocol.js';

type Sent = {
  status: number;
  payload?: {
    id?: unknown;
    result?: Record<string, unknown>;
    error?: { code: number };
  };
};

function mockRequest(
  version: string | undefined,
  meta: Record<string, unknown> | undefined,
  method = 'server/discover',
  sessionId?: string
): Request {
  return {
    headers: {
      ...(version ? { 'mcp-protocol-version': version } : {}),
      ...(sessionId ? { 'mcp-session-id': sessionId } : {})
    },
    body: {
      jsonrpc: '2.0',
      id: 7,
      method,
      params: { ...(meta && { _meta: meta }) }
    }
  } as unknown as Request;
}

function mockResponse(): { res: Response; sent: Sent } {
  const sent: Sent = { status: 200 };
  const res = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      sent.payload = payload as Sent['payload'];
      return this;
    }
  } as unknown as Response;
  return { res, sent };
}

const validMeta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {}
};

describe('example draft protocol preflight', () => {
  it('preserves session-era requests for the official SDK', () => {
    expect(
      inspectDraftRequest(mockRequest(undefined, undefined), mockResponse().res)
        .kind
    ).toBe('legacy');
    expect(
      inspectDraftRequest(
        mockRequest('2025-11-25', undefined),
        mockResponse().res
      ).kind
    ).toBe('legacy');
    expect(
      inspectDraftRequest(
        mockRequest('2026-07-28', validMeta, 'tools/list', 'session-123'),
        mockResponse().res
      ).kind
    ).toBe('legacy');
  });

  it('accepts a valid draft request without forwarding it to the v1 SDK', () => {
    const { res, sent } = mockResponse();
    expect(
      inspectDraftRequest(mockRequest('2026-07-28', validMeta), res)
    ).toEqual({
      kind: 'draft',
      method: 'server/discover',
      id: 7
    });
    expect(sent.payload).toBeUndefined();
  });

  it.each([
    [undefined, validMeta, -32020],
    ['2026-07-28', undefined, -32602],
    ['2025-11-25', validMeta, -32020],
    [
      '2027-01-01',
      { ...validMeta, 'io.modelcontextprotocol/protocolVersion': '2027-01-01' },
      -32022
    ]
  ])(
    'rejects invalid draft request with expected JSON-RPC code',
    (version, meta, code) => {
      const { res, sent } = mockResponse();
      expect(inspectDraftRequest(mockRequest(version, meta), res).kind).toBe(
        'rejected'
      );
      expect(sent.status).toBe(400);
      expect(sent.payload?.error?.code).toBe(code);
      expect(sent.payload?.id).toBe(7);
    }
  );

  it('advertises draft version and expected server identity in discover', () => {
    const { res, sent } = mockResponse();
    sendDraftDiscovery(
      res,
      42,
      { name: 'fixture', version: '1.0.0' },
      { tools: {} }
    );
    expect(sent.payload?.result).toMatchObject({
      resultType: 'complete',
      ttlMs: 0,
      cacheScope: 'private',
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      _meta: {
        'io.modelcontextprotocol/serverInfo': { name: 'fixture', version: '1.0.0' }
      }
    });
  });

  it('adds required result fields to tools/list responses', () => {
    const { res, sent } = mockResponse();
    sendDraftResult(res, 1, { tools: [{ name: 'broken-tool-name' }] });
    expect(sent.payload?.result).toMatchObject({
      resultType: 'complete',
      ttlMs: 0,
      cacheScope: 'private',
      tools: [{ name: 'broken-tool-name' }]
    });
  });
});
