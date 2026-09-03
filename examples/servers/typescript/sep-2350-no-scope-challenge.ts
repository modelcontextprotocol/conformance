/**
 * Deliberately broken SEP-2350 fixture.
 *
 * It implements every primitive required by the scope-challenge scenario, but
 * ignores the low-scope token and returns the normal result instead of HTTP 403.
 */
import { createServer } from 'node:http';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

function resultFor(request: JsonRpcRequest): Record<string, unknown> {
  if (
    request.method === 'tools/call' &&
    request.params?.name === 'test_simple_text'
  ) {
    return {
      resultType: 'complete',
      content: [
        {
          type: 'text',
          text: 'This is a simple text response for testing.'
        }
      ]
    };
  }

  if (request.method === 'resources/read') {
    const uri = request.params?.uri;
    if (uri === 'test://static-text') {
      return {
        resultType: 'complete',
        ttlMs: 0,
        cacheScope: 'private',
        contents: [
          {
            uri,
            mimeType: 'text/plain',
            text: 'This is the content of the static text resource.'
          }
        ]
      };
    }
    if (uri === 'test://template/123/data') {
      return {
        resultType: 'complete',
        ttlMs: 0,
        cacheScope: 'private',
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({
              id: '123',
              templateTest: true,
              data: 'Data for ID: 123'
            })
          }
        ]
      };
    }
  }

  if (
    request.method === 'prompts/get' &&
    request.params?.name === 'test_simple_prompt'
  ) {
    return {
      resultType: 'complete',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: 'This is a simple prompt for testing.'
          }
        }
      ]
    };
  }

  throw new Error(`Unsupported fixture request: ${request.method}`);
}

const server = createServer((req, res) => {
  let rawBody = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    rawBody += chunk;
  });
  req.on('end', () => {
    let response: Record<string, unknown>;
    try {
      const request = JSON.parse(rawBody) as JsonRpcRequest;
      response = {
        jsonrpc: '2.0',
        id: request.id,
        result: resultFor(request)
      };
    } catch (error) {
      response = {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message: error instanceof Error ? error.message : String(error)
        }
      };
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(response));
  });
});

const port = Number.parseInt(process.env.PORT ?? '3012', 10);
server.listen(port, '127.0.0.1', () => {
  console.log(
    `Broken SEP-2350 fixture running on http://127.0.0.1:${port}/mcp`
  );
});

process.on('SIGTERM', () => server.close());
