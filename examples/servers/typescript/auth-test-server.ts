#!/usr/bin/env node

/**
 * MCP Auth Test Server - Conformance Test Server with Authentication
 *
 * A minimal MCP server that requires Bearer token authentication.
 * This server is used for testing OAuth authentication flows in conformance tests.
 *
 * Required environment variables:
 * - MCP_CONFORMANCE_AUTH_SERVER_URL: URL of the authorization server
 *
 * Optional environment variables:
 * - PORT: Server port (default: 3001)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';

// Check for required environment variable
const AUTH_SERVER_URL = process.env.MCP_CONFORMANCE_AUTH_SERVER_URL;
if (!AUTH_SERVER_URL) {
  console.error(
    'Error: MCP_CONFORMANCE_AUTH_SERVER_URL environment variable is required'
  );
  console.error(
    'Usage: MCP_CONFORMANCE_AUTH_SERVER_URL=http://localhost:3000 npx tsx auth-test-server.ts'
  );
  process.exit(1);
}

// Server configuration
const PORT = process.env.PORT || 3001;
const getBaseUrl = () => `http://localhost:${PORT}`;

// Session management
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};
const servers: { [sessionId: string]: McpServer } = {};

// Function to create a new MCP server instance (one per session)
function createMcpServer(): McpServer {
  const mcpServer = new McpServer(
    {
      name: 'mcp-auth-test-server',
      version: '1.0.0'
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  // Simple echo tool for testing authenticated calls
  mcpServer.tool(
    'echo',
    'Echoes back the provided message - used for testing authenticated calls',
    {
      message: z.string().optional().describe('The message to echo back')
    },
    async (args: { message?: string }) => {
      const message = args.message || 'No message provided';
      return {
        content: [{ type: 'text', text: `Echo: ${message}` }]
      };
    }
  );

  // Simple test tool with no arguments
  mcpServer.tool(
    'test-tool',
    'A simple test tool that returns a success message',
    {},
    async () => {
      return {
        content: [{ type: 'text', text: 'test' }]
      };
    }
  );

  return mcpServer;
}

/**
 * Validates a Bearer token.
 * Accepts tokens that start with 'test-token' or 'cc-token' (as issued by the fake auth server).
 */
function isValidToken(token: string): boolean {
  return token.startsWith('test-token') || token.startsWith('cc-token');
}

/**
 * Bearer authentication middleware.
 * Returns 401 with WWW-Authenticate header if token is missing or invalid.
 */
function bearerAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;

  // Check for Authorization header
  if (!authHeader) {
    sendUnauthorized(res, 'Missing authorization header');
    return;
  }

  // Check for Bearer scheme
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    sendUnauthorized(res, 'Invalid authorization scheme');
    return;
  }

  const token = parts[1];

  // Validate the token
  if (!isValidToken(token)) {
    sendUnauthorized(res, 'Invalid token');
    return;
  }

  // Token is valid, proceed
  next();
}

/**
 * Sends a 401 Unauthorized response with proper WWW-Authenticate header.
 */
function sendUnauthorized(res: Response, error: string): void {
  const prmUrl = `${getBaseUrl()}/.well-known/oauth-protected-resource`;

  // Build WWW-Authenticate header with resource_metadata parameter
  const wwwAuthenticate = `Bearer realm="mcp", error="invalid_token", error_description="${error}", resource_metadata="${prmUrl}"`;

  res.setHeader('WWW-Authenticate', wwwAuthenticate);
  res.status(401).json({
    error: 'unauthorized',
    error_description: error
  });
}

// Helper to check if request is an initialize request
function isInitializeRequest(body: any): boolean {
  return body?.method === 'initialize';
}

// ===== EXPRESS APP =====

const app = express();
app.use(express.json());

// Configure CORS to expose Mcp-Session-Id header for browser-based clients
app.use(
  cors({
    origin: '*',
    exposedHeaders: ['Mcp-Session-Id'],
    allowedHeaders: [
      'Content-Type',
      'mcp-session-id',
      'last-event-id',
      'Authorization'
    ]
  })
);

// Protected Resource Metadata endpoint (RFC 9728)
app.get(
  '/.well-known/oauth-protected-resource',
  (_req: Request, res: Response) => {
    res.json({
      resource: getBaseUrl(),
      authorization_servers: [AUTH_SERVER_URL]
    });
  }
);

// Handle POST requests to /mcp with bearer auth
app.post('/mcp', bearerAuthMiddleware, async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  try {
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      // Reuse existing transport for established sessions
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // Create new transport for initialization requests
      const mcpServer = createMcpServer();

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          transports[newSessionId] = transport;
          servers[newSessionId] = mcpServer;
          console.log(`Session initialized with ID: ${newSessionId}`);
        }
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          delete transports[sid];
          if (servers[sid]) {
            servers[sid].close();
            delete servers[sid];
          }
          console.log(`Session ${sid} closed`);
        }
      };

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Invalid or missing session ID'
        },
        id: null
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error'
        },
        id: null
      });
    }
  }
});

// Handle GET requests - SSE streams for sessions (also requires auth)
app.get('/mcp', bearerAuthMiddleware, async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }

  console.log(`Establishing SSE stream for session ${sessionId}`);

  try {
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error('Error handling SSE stream:', error);
    if (!res.headersSent) {
      res.status(500).send('Error establishing SSE stream');
    }
  }
});

// Handle DELETE requests - session termination (also requires auth)
app.delete(
  '/mcp',
  bearerAuthMiddleware,
  async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    console.log(
      `Received session termination request for session ${sessionId}`
    );

    try {
      const transport = transports[sessionId];
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error('Error handling termination:', error);
      if (!res.headersSent) {
        res.status(500).send('Error processing session termination');
      }
    }
  }
);

// Start server
app.listen(PORT, () => {
  console.log(`MCP Auth Test Server running at http://localhost:${PORT}/mcp`);
  console.log(
    `  - PRM endpoint: http://localhost:${PORT}/.well-known/oauth-protected-resource`
  );
  console.log(`  - Auth server: ${AUTH_SERVER_URL}`);
});
