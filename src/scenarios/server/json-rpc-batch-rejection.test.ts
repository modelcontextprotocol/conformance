// Unit tests for batch acceptance/rejection helpers used by
// json-rpc-batch-rejection.ts (AGENTS.md: prove the check logic, not only E2E).
import { describe, it, expect } from 'vitest';
import {
  isBatchAccepted,
  isBatchRejected,
  jsonRpcErrorCode
} from './json-rpc-batch-rejection.js';

describe('json-rpc batch rejection helpers', () => {
  it('detects a successful batch array response as accepted', () => {
    expect(
      isBatchAccepted(200, [
        { jsonrpc: '2.0', id: 1, result: {} },
        { jsonrpc: '2.0', id: 2, result: {} }
      ])
    ).toBe(true);
  });

  it('detects a single-object success response as accepted', () => {
    expect(isBatchAccepted(200, { jsonrpc: '2.0', id: 1, result: {} })).toBe(
      true
    );
  });

  it('detects HTTP 4xx JSON-RPC errors as rejected', () => {
    expect(
      isBatchRejected(400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' }
      })
    ).toBe(true);
    expect(
      isBatchRejected(400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Invalid or missing session ID' }
      })
    ).toBe(true);
  });

  it('does not treat HTTP 5xx as batch rejection', () => {
    expect(
      isBatchRejected(500, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: 'Internal error' }
      })
    ).toBe(false);
  });

  it('extracts JSON-RPC error codes from single-object bodies', () => {
    expect(
      jsonRpcErrorCode({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' }
      })
    ).toBe(-32600);
    expect(jsonRpcErrorCode([{ error: { code: -32600 } }])).toBeUndefined();
  });
});
