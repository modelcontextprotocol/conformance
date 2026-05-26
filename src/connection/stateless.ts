/**
 * Stateless connection: 2026-x lifecycle (SEP-2575).
 *
 * No handshake. Every request carries `_meta` with protocolVersion, clientInfo,
 * and clientCapabilities, plus the `MCP-Protocol-Version` header. Implemented
 * with raw fetch so the conformance suite can test draft spec versions before
 * the SDK supports them.
 */

import { DRAFT_PROTOCOL_VERSION } from '../types';
import type { JSONRPCNotification } from '../spec-types/draft';
import { JsonRpcError, type Connection, type RequestOptions } from './index';

const CLIENT_INFO = { name: 'conformance-test-client', version: '1.0.0' };
const CLIENT_CAPABILITIES = {
  sampling: {},
  elicitation: {},
  roots: { listChanged: true }
};

export async function connectStateless(serverUrl: string): Promise<Connection> {
  const notifications: JSONRPCNotification[] = [];
  let nextId = 1;

  async function request<R>(
    method: string,
    params: Record<string, unknown> = {},
    opts?: RequestOptions
  ): Promise<R> {
    const id = nextId++;
    const _meta = {
      'io.modelcontextprotocol/protocolVersion': DRAFT_PROTOCOL_VERSION,
      'io.modelcontextprotocol/clientInfo': CLIENT_INFO,
      'io.modelcontextprotocol/clientCapabilities': CLIENT_CAPABILITIES,
      ...(params._meta as Record<string, unknown> | undefined),
      ...opts?.meta
    };

    const response = await fetch(serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': DRAFT_PROTOCOL_VERSION
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params: { ...params, _meta }
      })
    });

    const contentType = response.headers.get('content-type') ?? '';
    const message = contentType.includes('text/event-stream')
      ? await readFinalSseMessage(response, id, notifications)
      : await response.json();

    if (message.error) {
      throw new JsonRpcError(
        message.error.code,
        message.error.message,
        message.error.data
      );
    }
    return message.result as R;
  }

  return {
    notifications,
    request,
    close: async () => {}
  };
}

/**
 * Consume an SSE response stream, pushing notifications into `sink` and
 * returning the final response message matching `id`. Server-to-client
 * requests on this stream are a spec violation under the stateless lifecycle
 * and are surfaced as a thrown error.
 */
async function readFinalSseMessage(
  response: Response,
  id: number,
  sink: JSONRPCNotification[]
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const event = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const data = event
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('');
      if (!data) continue;
      const msg = JSON.parse(data);
      if ('method' in msg && !('id' in msg)) {
        sink.push(msg);
      } else if ('method' in msg && 'id' in msg) {
        throw new JsonRpcError(
          -32600,
          `Server sent request '${msg.method}' on response stream; stateless lifecycle forbids this (use MRTR)`
        );
      } else if (msg.id === id) {
        reader.cancel().catch(() => {});
        return msg;
      }
    }
  }
  throw new Error('SSE stream ended without a response for id ' + id);
}
