/**
 * Helpers for SEP-2322 conformance tests.
 *
 * Provides InputRequiredResult-specific type guards, mock response builders,
 * and a stateless JSON-RPC transport helper.
 */

// ─── JSON-RPC Types ──────────────────────────────────────────────────────────

export type { JsonRpcResponse } from './stateless-client';

// ─── Stateless RPC Helper ────────────────────────────────────────────────────

import { sendStatelessRequest, JsonRpcResponse } from './stateless-client';

/**
 * Send a stateless JSON-RPC request (SEP-2575 pattern).
 * The shared stateless helper injects the cross-cutting requirements: _meta
 * (protocolVersion, clientInfo, clientCapabilities) and the standard
 * MCP-Protocol-Version / Mcp-Method / Mcp-Name headers (SEP-2243).
 */
export async function sendRpc(
  serverUrl: string,
  method: string,
  params?: Record<string, unknown>
): Promise<JsonRpcResponse> {
  const response = await sendStatelessRequest(serverUrl, method, params);
  if (!response.body) {
    throw new Error(
      `Expected a JSON-RPC response for ${method}, got HTTP ${response.status} (${response.contentType ?? 'no content-type'})`
    );
  }
  return response.body as JsonRpcResponse;
}

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
  return false;
}

/**
 * Check if a JSON-RPC result is a complete result (not input_required).
 * complete is the default so if resultType is missing we assume it's complete.
 */
export function isCompleteResult(
  result: Record<string, unknown> | undefined
): boolean {
  if (!result) return false;
  if (result.resultType === 'input_required') return false;
  return true;
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
    url: 'https://modelcontextprotocol.io/specification/draft/basic/utilities/mrtr'
  }
];
