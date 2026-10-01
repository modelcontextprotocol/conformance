import type { IncomingMessage } from 'http';
import {
  HEADER_MISMATCH,
  MISSING_REQUIRED_CLIENT_CAPABILITY,
  UNSUPPORTED_PROTOCOL_VERSION
} from './spec-types/draft';
import { DRAFT_PROTOCOL_VERSION } from './types';
import { buildStandardHeaders, withRequestMeta } from './connection/stateless';

export const LEGACY_PROTOCOL_VERSION = '2025-11-25' as const;
export const MODERN_PROBE_ID = 'modern-probe' as const;
export const MAX_COMPAT_MESSAGE_BYTES = 1024 * 1024;

export const RECOGNIZED_MODERN_ERROR_CODES: ReadonlySet<number> = new Set([
  HEADER_MISMATCH,
  MISSING_REQUIRED_CLIENT_CAPABILITY,
  UNSUPPORTED_PROTOCOL_VERSION
]);

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseJsonRecord(text: string): JsonRecord | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function recognizedModernErrorCode(
  value: unknown,
  expectedId: string | number
): number | undefined {
  if (!isRecord(value) || value.jsonrpc !== '2.0' || value.id !== expectedId) {
    return undefined;
  }
  const error = value.error;
  if (!isRecord(error) || typeof error.code !== 'number') return undefined;
  return RECOGNIZED_MODERN_ERROR_CODES.has(error.code) ? error.code : undefined;
}

export function modernProbeRequestInit(
  id: string | number = MODERN_PROBE_ID
): RequestInit {
  const method = 'tools/list';
  return {
    method: 'POST',
    headers: buildStandardHeaders(method),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params: withRequestMeta()
    })
  };
}

export async function readLimitedRequestBody(
  request: IncomingMessage,
  maxBytes = MAX_COMPAT_MESSAGE_BYTES
): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new RangeError(`Request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readLimitedResponseText(
  response: Response,
  maxBytes = MAX_COMPAT_MESSAGE_BYTES
): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    await response.body?.cancel();
    throw new RangeError(`Response body exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new RangeError(`Response body exceeds ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export type HttpFallbackClassification =
  | { kind: 'legacy-fallback'; status: 400 }
  | { kind: 'modern'; status: 400; errorCode: number }
  | { kind: 'other'; status: number }
  | { kind: 'unavailable'; error: string };

export async function classifyHttpFallbackResponse(
  response: Response,
  expectedId: string | number
): Promise<HttpFallbackClassification> {
  if (response.status !== 400) {
    await response.body?.cancel();
    return { kind: 'other', status: response.status };
  }

  const text = await readLimitedResponseText(response);
  const body = parseJsonRecord(text);
  const contentType = response.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  const errorCode =
    contentType === 'application/json'
      ? recognizedModernErrorCode(body, expectedId)
      : undefined;
  return errorCode === undefined
    ? { kind: 'legacy-fallback', status: 400 }
    : { kind: 'modern', status: 400, errorCode };
}

export async function probeLegacyHttpFallback(
  serverUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<HttpFallbackClassification> {
  try {
    const response = await fetchImpl(
      serverUrl,
      modernProbeRequestInit(MODERN_PROBE_ID)
    );
    return await classifyHttpFallbackResponse(response, MODERN_PROBE_ID);
  } catch (error) {
    return {
      kind: 'unavailable',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function isDraftModernProbe(
  request: IncomingMessage,
  body: JsonRecord
): boolean {
  const params = isRecord(body.params) ? body.params : undefined;
  const meta = params && isRecord(params._meta) ? params._meta : undefined;
  return (
    request.method === 'POST' &&
    request.headers['mcp-protocol-version'] === DRAFT_PROTOCOL_VERSION &&
    request.headers['mcp-method'] === 'tools/list' &&
    body.method === 'tools/list' &&
    meta?.['io.modelcontextprotocol/protocolVersion'] === DRAFT_PROTOCOL_VERSION
  );
}
