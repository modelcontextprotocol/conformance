/**
 * Minimal loopback MCP server fixtures for `--production` mode integration
 * tests (stateful 2025-11-25 and stateless 2026-07-28).
 */
import http from 'http';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import type { AddressInfo } from 'net';
import { DRAFT_PROTOCOL_VERSION, LATEST_SPEC_VERSION } from '../../types';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..'
);

export interface TestServer {
  url: string;
  methodsCalled: string[];
  close: () => Promise<void>;
}

export interface StatefulServerConfig {
  capabilities: Record<string, unknown>;
  failResourcesList?: boolean;
}

export interface StatelessServerConfig {
  capabilities: Record<string, unknown>;
  includeCachingHints: boolean;
}

const DOMAIN_TOOLS = [
  {
    name: 'execute_sql',
    description: 'Execute a read-only SQL query',
    inputSchema: {
      type: 'object',
      properties: { sql: { type: 'string' } },
      required: ['sql']
    }
  },
  {
    name: 'list_tables',
    description: 'List database tables',
    inputSchema: { type: 'object', properties: {} }
  }
];

function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.split(':')[0];
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

function isAllowedOrigin(originHeader: string | undefined): boolean {
  if (!originHeader) return true;
  try {
    const { hostname } = new URL(originHeader);
    return (
      hostname === '127.0.0.1' ||
      hostname === 'localhost' ||
      hostname === '[::1]'
    );
  } catch {
    return false;
  }
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(payload));
}

function readJsonBody(
  req: http.IncomingMessage,
  onBody: (body: Record<string, unknown>) => void
): void {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    onBody(JSON.parse(raw) as Record<string, unknown>);
  });
}

async function listenLoopback(
  handler: http.RequestListener,
  methodsCalled: string[]
): Promise<TestServer> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve())
  );
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    methodsCalled,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

function dispatchStatefulMethod(
  res: http.ServerResponse,
  id: unknown,
  method: string,
  config: StatefulServerConfig
): void {
  if (method === 'ping') {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'tools/list') {
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      result: { tools: DOMAIN_TOOLS }
    });
    return;
  }
  if (
    method === 'resources/list' &&
    'resources' in config.capabilities &&
    !config.failResourcesList
  ) {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: { resources: [] } });
    return;
  }
  sendJson(res, 200, {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not supported: ${method}` }
  });
}

function handleStatefulRpc(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Record<string, unknown>,
  config: StatefulServerConfig,
  activeSessions: Set<string>,
  nextSessionId: () => string
): void {
  const id = body.id ?? null;
  const method = String(body.method ?? '');
  if (id === null || method.startsWith('notifications/')) {
    res.writeHead(202).end();
    return;
  }
  if (method === 'initialize') {
    const sessionId = nextSessionId();
    activeSessions.add(sessionId);
    const params = (body.params as Record<string, unknown>) ?? {};
    const requestedVersion =
      typeof params.protocolVersion === 'string'
        ? params.protocolVersion
        : LATEST_SPEC_VERSION;
    sendJson(
      res,
      200,
      {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: requestedVersion,
          capabilities: config.capabilities,
          serverInfo: { name: 'dbhub-like-prod-server', version: '1.0.0' }
        }
      },
      { 'mcp-session-id': sessionId }
    );
    return;
  }

  const sessionId = String(req.headers['mcp-session-id'] ?? '');
  if (!sessionId || !activeSessions.has(sessionId)) {
    sendJson(res, 404, {
      jsonrpc: '2.0',
      id,
      error: { code: -32001, message: 'Session not found' }
    });
    return;
  }
  dispatchStatefulMethod(res, id, method, config);
}

export async function startStatefulPartialServer(
  config: StatefulServerConfig
): Promise<TestServer> {
  const methodsCalled: string[] = [];
  const activeSessions = new Set<string>();
  let sessionCounter = 0;
  const nextSessionId = () => `prod-session-${++sessionCounter}`;

  return listenLoopback((req, res) => {
    if (
      !isLoopbackHost(req.headers.host) ||
      !isAllowedOrigin(req.headers.origin)
    ) {
      sendJson(res, 403, { error: 'Forbidden host or origin' });
      return;
    }
    if (req.method === 'DELETE') {
      const sid = String(req.headers['mcp-session-id'] ?? '');
      res.writeHead(sid && activeSessions.delete(sid) ? 200 : 404).end();
      return;
    }
    if (req.method === 'GET') {
      res.writeHead(405).end();
      return;
    }
    readJsonBody(req, (body) => {
      methodsCalled.push(String(body.method ?? ''));
      handleStatefulRpc(req, res, body, config, activeSessions, nextSessionId);
    });
  }, methodsCalled);
}

function handleStatelessRpc(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Record<string, unknown>,
  config: StatelessServerConfig
): void {
  const id = body.id ?? null;
  const method = String(body.method ?? '');
  const mcpMethod = req.headers['mcp-method'];
  if (typeof mcpMethod !== 'string' || mcpMethod.trim() !== method) {
    sendJson(res, 400, {
      jsonrpc: '2.0',
      id,
      error: { code: -32020, message: 'Mcp-Method header mismatch' }
    });
    return;
  }
  if (method === 'server/discover') {
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      result: {
        resultType: 'complete',
        supportedVersions: [DRAFT_PROTOCOL_VERSION],
        capabilities: config.capabilities,
        ttlMs: 30000,
        cacheScope: 'public',
        _meta: {
          'io.modelcontextprotocol/serverInfo': {
            name: 'stateless-tools-only',
            version: '1.0.0'
          }
        }
      }
    });
    return;
  }
  if (method === 'tools/list' && 'tools' in config.capabilities) {
    const result = config.includeCachingHints
      ? {
          resultType: 'complete',
          tools: DOMAIN_TOOLS,
          ttlMs: 30000,
          cacheScope: 'public'
        }
      : { resultType: 'complete', tools: DOMAIN_TOOLS };
    sendJson(res, 200, { jsonrpc: '2.0', id, result });
    return;
  }
  sendJson(res, 404, {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` }
  });
}

export async function startStatelessPartialServer(
  config: StatelessServerConfig
): Promise<TestServer> {
  const methodsCalled: string[] = [];
  return listenLoopback((req, res) => {
    if (
      !isLoopbackHost(req.headers.host) ||
      !isAllowedOrigin(req.headers.origin)
    ) {
      sendJson(res, 403, { error: 'Forbidden host or origin' });
      return;
    }
    readJsonBody(req, (body) => {
      methodsCalled.push(String(body.method ?? ''));
      handleStatelessRpc(req, res, body, config);
    });
  }, methodsCalled);
}

export function runCliSubprocess(
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'),
        path.join(REPO_ROOT, 'src/index.ts'),
        ...args
      ],
      { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({ exitCode: code ?? 1, stdout, stderr })
    );
  });
}
