/**
 * IncompleteResult helpers for SEP-2322 conformance tests.
 *
 * Uses RawMcpSession from client-helper.ts for connection management and
 * raw JSON-RPC transport. This file adds IncompleteResult-specific type
 * guards, mock response builders, and convenience wrappers.
 */

import {
  RawMcpSession,
  createRawSession,
  JsonRpcResponse
} from './client-helper';

export type { RawMcpSession, JsonRpcResponse };

// ─── IncompleteResult Types ──────────────────────────────────────────────────

export interface IncompleteResult {
  result_type?: 'incomplete';
  inputRequests?: Record<string, InputRequestObject>;
  requestState?: string;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface InputRequestObject {
  method: string;
  params?: Record<string, unknown>;
}

// ─── Type Guards ─────────────────────────────────────────────────────────────

/**
 * Check if a JSON-RPC result is an IncompleteResult.
 */
export function isIncompleteResult(
  result: Record<string, unknown> | undefined
): result is IncompleteResult {
  if (!result) return false;
  if (result.result_type === 'incomplete') return true;
  // Also detect by presence of IncompleteResult fields
  return 'inputRequests' in result || 'requestState' in result;
}

/**
 * Check if a JSON-RPC result is a complete result (not incomplete).
 */
export function isCompleteResult(
  result: Record<string, unknown> | undefined
): boolean {
  if (!result) return false;
  return !isIncompleteResult(result);
}

/**
 * Extract inputRequests from an IncompleteResult.
 */
export function getInputRequests(
  result: IncompleteResult
): Record<string, InputRequestObject> | undefined {
  return result.inputRequests;
}

// ─── Mock Response Builders ──────────────────────────────────────────────────

/**
 * Build a mock elicitation response (ElicitResult).
 */
export function mockElicitResponse(
  content: Record<string, unknown>
): Record<string, unknown> {
  return {
    action: 'accept',
    content
  };
}

/**
 * Build a mock sampling response (CreateMessageResult).
 */
export function mockSamplingResponse(text: string): Record<string, unknown> {
  return {
    role: 'assistant',
    content: {
      type: 'text',
      text
    },
    model: 'test-model',
    stopReason: 'endTurn'
  };
}

/**
 * Build a mock list roots response (ListRootsResult).
 */
export function mockListRootsResponse(): Record<string, unknown> {
  return {
    roots: [
      {
        uri: 'file:///test/root',
        name: 'Test Root'
      }
    ]
  };
}

// ─── Session Factory ─────────────────────────────────────────────────────────

/**
 * Create an initialized raw MCP session for IncompleteResult testing.
 * Delegates to createRawSession from client-helper.ts.
 */
export async function createIncompleteResultSession(
  serverUrl: string
): Promise<RawMcpSession> {
  return createRawSession(serverUrl);
}

// ─── Spec References ─────────────────────────────────────────────────────────

/**
 * SEP reference for IncompleteResult / MRTR tests.
 */
export const MRTR_SPEC_REFERENCES = [
  {
    id: 'SEP-2322',
    url: 'https://github.com/modelcontextprotocol/specification/pull/2322'
  }
];
