import http from 'http';
import { DRAFT_PROTOCOL_VERSION } from '../../../src/types.js';
import { UNSUPPORTED_PROTOCOL_VERSION } from '../../../src/spec-types/draft.js';
import {
  isDraftModernProbe,
  LEGACY_PROTOCOL_VERSION,
  parseJsonRecord,
  readLimitedRequestBody
} from '../../../src/version-compat.js';

const port = Number.parseInt(process.env.PORT ?? '3010', 10);
const emitModernError = process.env.EMIT_MODERN_ERROR === 'true';

const server = http.createServer((request, response) => {
  void handleRequest(request, response);
});
server.requestTimeout = 5_000;
server.headersTimeout = 5_000;

async function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  let rawBody: string;
  try {
    rawBody = await readLimitedRequestBody(request);
  } catch (error) {
    response.writeHead(error instanceof RangeError ? 413 : 400).end();
    return;
  }

  const body = parseJsonRecord(rawBody);
  if (!body) {
    response.writeHead(400).end();
    return;
  }

  if (isDraftModernProbe(request, body)) {
    response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: body.id ?? null,
        error: emitModernError
          ? {
              code: UNSUPPORTED_PROTOCOL_VERSION,
              message: 'Unsupported protocol version',
              data: {
                supported: [LEGACY_PROTOCOL_VERSION],
                requested: DRAFT_PROTOCOL_VERSION
              }
            }
          : { code: -32600, message: 'Invalid Request' }
      })
    );
    return;
  }

  if (body.method === 'initialize') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: LEGACY_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'legacy-version-server', version: '1.0.0' }
        }
      })
    );
    return;
  }

  if (body.method === 'notifications/initialized') {
    response.writeHead(202).end();
    return;
  }

  if (body.method === 'tools/list') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: { tools: [] }
      })
    );
    return;
  }

  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }));
}

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to determine legacy server port');
  }
  console.log(
    `Legacy version server running on http://127.0.0.1:${address.port}/mcp`
  );
});
