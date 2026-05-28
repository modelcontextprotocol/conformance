/**
 * Unit tests for readJsonRpcResponse — the SSE / JSON content-type
 * dispatcher used by every raw-session request. The SSE branch
 * delegates to `eventsource-parser`; these tests pin the contract
 * across the cases that matter for Streamable HTTP responses:
 *
 *   - application/json — single-frame body, id-match required
 *   - text/event-stream — multi-event scan, id-match required,
 *     reassembly of multi-line `data:` continuations, CRLF tolerance,
 *     comment / retry / id field handling, and error-frame return.
 */

import { describe, it, expect } from 'vitest';

import { readJsonRpcResponse } from './raw-session';

function sseResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/event-stream' }
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('readJsonRpcResponse', () => {
  describe('application/json branch', () => {
    it('returns the body when id matches', async () => {
      const body = { jsonrpc: '2.0', id: 42, result: { ok: true } };
      const out = await readJsonRpcResponse(jsonResponse(body), 42);
      expect(out).toEqual(body);
    });

    it('throws on id mismatch', async () => {
      const body = { jsonrpc: '2.0', id: 99, result: { ok: true } };
      await expect(readJsonRpcResponse(jsonResponse(body), 42)).rejects.toThrow(
        /JSON-RPC id mismatch.*expected 42.*got 99/
      );
    });

    it('preserves error frames', async () => {
      const body = {
        jsonrpc: '2.0',
        id: 7,
        error: { code: -32601, message: 'Method not found' }
      };
      const out = await readJsonRpcResponse(jsonResponse(body), 7);
      expect(out.error?.code).toBe(-32601);
    });
  });

  describe('text/event-stream branch', () => {
    it('extracts the single JSON-RPC frame from a one-event stream', async () => {
      const frame = { jsonrpc: '2.0', id: 1, result: { ok: true } };
      const body = `data: ${JSON.stringify(frame)}\n\n`;
      const out = await readJsonRpcResponse(sseResponse(body), 1);
      expect(out).toEqual(frame);
    });

    it('picks the matching id when earlier events carry other ids', async () => {
      // Streamable HTTP allows in-flight notifications (`notifications/*`,
      // which have no id) followed by the response frame. Make sure we
      // skip the noise and return the response.
      const notif = {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progress: 50 }
      };
      const frame = { jsonrpc: '2.0', id: 5, result: { done: true } };
      const body =
        `data: ${JSON.stringify(notif)}\n\n` +
        `data: ${JSON.stringify(frame)}\n\n`;
      const out = await readJsonRpcResponse(sseResponse(body), 5);
      expect(out).toEqual(frame);
    });

    it('reassembles multi-line data: continuations', async () => {
      // WHATWG SSE concatenates consecutive `data:` lines with `\n`.
      // The hand-rolled parser this commit replaces also did this, but
      // only because the frames we send happen to fit on one line; pin
      // the multi-line case so a future fixture that emits pretty-
      // printed JSON keeps working.
      const body =
        'data: {"jsonrpc":"2.0",\ndata: "id":9,\ndata: "result":{}}\n\n';
      const out = await readJsonRpcResponse(sseResponse(body), 9);
      expect(out).toEqual({ jsonrpc: '2.0', id: 9, result: {} });
    });

    it('tolerates CRLF line endings', async () => {
      const frame = { jsonrpc: '2.0', id: 3, result: { ok: true } };
      const body = `data: ${JSON.stringify(frame)}\r\n\r\n`;
      const out = await readJsonRpcResponse(sseResponse(body), 3);
      expect(out).toEqual(frame);
    });

    it('skips comment + id + retry fields without misreading them as frames', async () => {
      const frame = { jsonrpc: '2.0', id: 11, result: { ok: true } };
      const body =
        ': heartbeat\n' +
        'retry: 5000\n' +
        'id: event-7\n' +
        '\n' +
        `event: message\ndata: ${JSON.stringify(frame)}\n\n`;
      const out = await readJsonRpcResponse(sseResponse(body), 11);
      expect(out).toEqual(frame);
    });

    it('returns error frames from the SSE stream', async () => {
      const frame = {
        jsonrpc: '2.0',
        id: 4,
        error: { code: -32001, message: 'HeaderMismatch' }
      };
      const body = `data: ${JSON.stringify(frame)}\n\n`;
      const out = await readJsonRpcResponse(sseResponse(body), 4);
      expect(out.error?.code).toBe(-32001);
    });

    it('throws when no event matches the expected id', async () => {
      // Only non-response events on the stream.
      const notif = {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progress: 100 }
      };
      const body = `data: ${JSON.stringify(notif)}\n\n`;
      await expect(readJsonRpcResponse(sseResponse(body), 7)).rejects.toThrow(
        /No JSON-RPC frame with id=7/
      );
    });

    it('throws on empty stream body', async () => {
      await expect(readJsonRpcResponse(sseResponse(''), 1)).rejects.toThrow(
        /No JSON-RPC frame with id=1/
      );
    });

    it('skips events with non-JSON data without throwing', async () => {
      // Plain text events shouldn't blow up the parser; we just skip
      // them and keep scanning for the JSON-RPC frame.
      const frame = { jsonrpc: '2.0', id: 8, result: { ok: true } };
      const body = 'data: keepalive\n\n' + `data: ${JSON.stringify(frame)}\n\n`;
      const out = await readJsonRpcResponse(sseResponse(body), 8);
      expect(out).toEqual(frame);
    });
  });
});
