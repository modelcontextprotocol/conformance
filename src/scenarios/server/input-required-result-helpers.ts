/**
 * Helpers for SEP-2322 conformance tests.
 *
 * Uses RawMcpSession from client-helper.ts for connection management and
 * raw JSON-RPC transport. This file adds InputRequiredResult-specific type
 * guards and mock response builders.
 */

import { RawMcpSession, JsonRpcResponse } from './client-helper';

export type { RawMcpSession, JsonRpcResponse };

// ─── InputRequiredResult Types ───────────────────────────────────────────────

export interface InputRequiredResultData {
  resultType?: 'input_required';
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
 * Check if a JSON-RPC result is an InputRequiredResult.
 */
export function isInputRequiredResult(
  result: Record<string, unknown> | undefined
): result is InputRequiredResultData {
  if (!result) return false;
  if (result.resultType === 'input_required') return true;
  // Also detect by presence of InputRequiredResult fields
  return 'inputRequests' in result || 'requestState' in result;
}

/**
 * Check if a JSON-RPC result is a complete result (not input_required).
 * complete is the default so if resultType is missing we assume it's complete.
 */
export function isCompleteResult(
  result: Record<string, unknown> | undefined
): boolean {
  if (!result) return false;
  if (result.resultType === 'complete') return true;
  if (!('resultType' in result)) return true;
  return !isInputRequiredResult(result);
}

/**
 * Extract inputRequests from an InputRequiredResult.
 */
export function getInputRequests(
  result: InputRequiredResultData
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

// ─── Spec References ─────────────────────────────────────────────────────────

/**
 * SEP reference for InputRequiredResult / MRTR tests.
 */
export const MRTR_SPEC_REFERENCES = [
  {
    id: 'SEP-2322',
    url: 'https://github.com/modelcontextprotocol/specification/pull/2322'
  }
];
