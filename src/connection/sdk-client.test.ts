import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server as HttpServer } from 'http';
import { connectToServer, reportSetupFailure } from './sdk-client';

// Regression guard for the session-termination behavior of close(): a bad
// merge of connectToServer must not silently drop the DELETE (issue #79).
describe('connectToServer close()', () => {
  let httpServer: HttpServer | undefined;

  afterEach(
    () =>
      new Promise<void>((resolve) => {
        if (!httpServer) return resolve();
        httpServer.closeAllConnections?.();
        httpServer.close(() => resolve());
        httpServer = undefined;
      })
  );

  function startServer(sessionId?: string): Promise<{
    url: string;
    deletes: Array<string | undefined>;
  }> {
    const deletes: Array<string | undefined> = [];
    const app = express();
    app.use(express.json());
    app.post('/mcp', (req, res) => {
      if (req.body?.method === 'initialize') {
        if (sessionId) res.set('mcp-session-id', sessionId);
        res.json({
          jsonrpc: '2.0',
          id: req.body.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            serverInfo: { name: 'delete-probe', version: '1.0.0' }
          }
        });
      } else {
        res.status(202).end();
      }
    });
    app.delete('/mcp', (req, res) => {
      deletes.push(req.headers['mcp-session-id'] as string | undefined);
      res.status(200).end();
    });
    return new Promise((resolve, reject) => {
      const server = app.listen(0);
      httpServer = server;
      server.on('error', reject);
      server.on('listening', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve({ url: `http://localhost:${port}/mcp`, deletes });
      });
    });
  }

  it('sends an HTTP DELETE with the session ID to terminate the session', async () => {
    const { url, deletes } = await startServer('session-abc-123');

    const connection = await connectToServer(url, {}, '2025-11-25');
    await connection.close();

    expect(deletes).toEqual(['session-abc-123']);
  });

  it('does not send DELETE when the server assigned no session ID', async () => {
    const { url, deletes } = await startServer();

    const connection = await connectToServer(url, {}, '2025-11-25');
    await connection.close();

    expect(deletes).toEqual([]);
  });
});

describe('reportSetupFailure', () => {
  it('emits a single FAILURE check id-d "<scenario>-setup"', () => {
    const checks = reportSetupFailure(
      'tools-list',
      new Error('connect ECONNREFUSED')
    );

    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      id: 'tools-list-setup',
      status: 'FAILURE',
      errorMessage: 'Setup failed: connect ECONNREFUSED'
    });
  });

  it('stringifies a non-Error thrown value', () => {
    const checks = reportSetupFailure('prompts-list', 'boom');

    expect(checks[0]?.errorMessage).toBe('Setup failed: boom');
  });

  it('attaches spec references when provided and omits the field otherwise', () => {
    const withRefs = reportSetupFailure('resources-list', new Error('nope'), [
      { id: 'MCP-Resources-List' }
    ]);
    expect(withRefs[0]?.specReferences).toEqual([{ id: 'MCP-Resources-List' }]);

    const withoutRefs = reportSetupFailure('resources-list', new Error('nope'));
    expect(withoutRefs[0]).not.toHaveProperty('specReferences');
  });

  it('sets a timestamp', () => {
    const checks = reportSetupFailure('server-initialize', new Error('x'));
    expect(typeof checks[0]?.timestamp).toBe('string');
    expect(checks[0]?.timestamp.length).toBeGreaterThan(0);
  });
});
