import { createServer, type IncomingHttpHeaders } from 'http';

export type HeaderPresenceBehavior =
  | 'correct'
  | 'empty-is-absent'
  | 'absent-is-empty';

function decodeHeader(value: string): string | undefined {
  if (!value.startsWith('=?base64?') || !value.endsWith('?=')) return value;
  const encoded = value.slice('=?base64?'.length, -2);
  const decoded = Buffer.from(encoded, 'base64');
  return decoded.toString('base64') === encoded
    ? decoded.toString('utf8')
    : undefined;
}

/**
 * A narrow HTTP fixture, not a complete MCP server. The two broken modes
 * deliberately conflate missing and empty headers in opposite directions.
 */
export function createCustomHeaderPresenceServer(
  behavior: HeaderPresenceBehavior = 'correct',
  allParamsRequired = false
) {
  const properties = {
    required_region: { type: 'string', 'x-mcp-header': 'RequiredRegion' },
    region: { type: 'string', 'x-mcp-header': 'Region' }
  };
  const requests: Array<{ body: any; headers: IncomingHttpHeaders }> = [];
  const server = createServer(async (req, res) => {
    let body: any;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400).end();
      return;
    }
    requests.push({ body, headers: req.headers });

    const reply = (status: number, payload: object) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...payload }));
    };
    if (body.method === 'tools/list') {
      reply(200, {
        result: {
          resultType: 'complete',
          ttlMs: 0,
          cacheScope: 'private',
          tools: [
            {
              name: 'test_header_presence',
              inputSchema: {
                type: 'object',
                properties,
                required: allParamsRequired
                  ? ['required_region', 'region']
                  : ['required_region']
              }
            }
          ]
        }
      });
      return;
    }
    if (body.method !== 'tools/call') {
      reply(404, { error: { code: -32601, message: 'Method not found' } });
      return;
    }

    const args = body.params?.arguments ?? {};
    for (const [param, schema] of Object.entries(properties)) {
      const header = req.headers[
        `mcp-param-${schema['x-mcp-header'].toLowerCase()}`
      ] as string | undefined;
      const present =
        behavior === 'empty-is-absent' ? Boolean(header) : header !== undefined;
      const value = args[param];
      const mismatch =
        value === undefined || value === null
          ? present
          : (!present && behavior !== 'absent-is-empty') ||
            decodeHeader(header ?? '') !== value;
      if (mismatch) {
        reply(400, { error: { code: -32020, message: 'Header mismatch' } });
        return;
      }
    }
    reply(200, {
      result: {
        resultType: 'complete',
        content: [{ type: 'text', text: 'ok' }]
      }
    });
  });
  return { server, requests };
}
