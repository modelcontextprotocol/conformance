#!/usr/bin/env node

/**
 * Auth-enabled fixture for the auth/protected-resource-metadata scenario.
 *
 * Requests without a bearer token get a 401 challenge; the Protected Resource
 * Metadata (RFC 9728) is served at the path-based well-known URL. PRM_BREAK
 * selects one deliberate defect so each check has a negative case:
 *   none                         compliant (default)
 *   no-prm                       no resource_metadata, no well-known document
 *   challenge-404                resource_metadata points at a 404; well-known works
 *   wrong-content-type           metadata served as text/html
 *   wrong-resource               resource names another server
 *   missing-resource             resource omitted
 *   missing-authorization-servers  authorization_servers omitted
 *   empty-authorization-servers  authorization_servers is []
 *   empty-scopes-supported       scopes_supported is []
 *   empty-bearer-methods-supported  bearer_methods_supported is [] (allowed by RFC 9728 §2)
 *   status-403                   403 instead of 401 for a missing token
 *   no-scope                     challenge omits scope
 *   well-known-only              no resource_metadata; well-known works
 *   root-well-known              metadata only at the root URL, resource = origin
 *   no-auth                      no authorization at all (2xx to every request)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';

const BREAK_MODES = [
  'none',
  'no-prm',
  'challenge-404',
  'wrong-content-type',
  'wrong-resource',
  'missing-resource',
  'missing-authorization-servers',
  'empty-authorization-servers',
  'empty-scopes-supported',
  'empty-bearer-methods-supported',
  'status-403',
  'no-scope',
  'well-known-only',
  'root-well-known',
  'no-auth'
];

const PORT = parseInt(process.env.PORT || '3013', 10);
const BREAK = process.env.PRM_BREAK || 'none';
if (!BREAK_MODES.includes(BREAK)) {
  console.error(
    `Unknown PRM_BREAK "${BREAK}". Allowed: ${BREAK_MODES.join(', ')}`
  );
  process.exit(1);
}
const ORIGIN = `http://localhost:${PORT}`;
const MCP_URL = `${ORIGIN}/mcp`;
const AUTHORIZATION_SERVER = 'https://auth.example.com';
const PATH_PRM = '/.well-known/oauth-protected-resource/mcp';
const ROOT_PRM = '/.well-known/oauth-protected-resource';

function prmDocument(atRoot: boolean): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    resource: atRoot ? ORIGIN : MCP_URL,
    authorization_servers: [AUTHORIZATION_SERVER],
    scopes_supported: ['mcp:read']
  };
  if (BREAK === 'wrong-resource') doc.resource = 'https://attacker.example/mcp';
  if (BREAK === 'missing-resource') delete doc.resource;
  if (BREAK === 'missing-authorization-servers')
    delete doc.authorization_servers;
  if (BREAK === 'empty-authorization-servers') doc.authorization_servers = [];
  if (BREAK === 'empty-scopes-supported') doc.scopes_supported = [];
  if (BREAK === 'empty-bearer-methods-supported')
    doc.bearer_methods_supported = [];
  return doc;
}

function challenge(): string {
  const params: string[] = [];
  if (BREAK === 'challenge-404') {
    params.push(`resource_metadata="${ORIGIN}/missing-prm"`);
  } else if (BREAK === 'root-well-known') {
    params.push(`resource_metadata="${ORIGIN}${ROOT_PRM}"`);
  } else if (BREAK !== 'no-prm' && BREAK !== 'well-known-only') {
    params.push(`resource_metadata="${ORIGIN}${PATH_PRM}"`);
  }
  if (BREAK !== 'no-scope') params.push('scope="mcp:read"');
  return `Bearer ${params.join(', ')}`;
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'auth-prm-server',
    version: '1.0.0'
  });
  server.registerTool(
    'echo',
    {
      description: 'Echo the input back',
      inputSchema: { message: z.string() }
    },
    async ({ message }) => ({
      content: [{ type: 'text', text: `Echo: ${message}` }]
    })
  );
  return server;
}

function sendPrm(res: Response, atRoot: boolean): void {
  const body = JSON.stringify(prmDocument(atRoot));
  if (BREAK === 'wrong-content-type') {
    res.status(200).type('text/html').send(body);
    return;
  }
  res.status(200).type('application/json').send(body);
}

const app = express();
app.use(express.json());

if (BREAK !== 'no-prm') {
  if (BREAK === 'root-well-known') {
    app.get(ROOT_PRM, (_req, res) => sendPrm(res, true));
  } else {
    app.get(PATH_PRM, (_req, res) => sendPrm(res, false));
  }
}

app.post('/mcp', async (req: Request, res: Response) => {
  const authorization = req.get('authorization') ?? '';
  if (BREAK !== 'no-auth' && !/^bearer\s+\S+/i.test(authorization)) {
    res
      .status(BREAK === 'status-403' ? 403 : 401)
      .set('WWW-Authenticate', challenge())
      .json({ error: 'unauthorized' });
    return;
  }
  try {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: `Internal error: ${error instanceof Error ? error.message : String(error)}`
        },
        id: null
      });
    }
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Auth PRM server running on ${MCP_URL} (PRM_BREAK=${BREAK})`);
});
