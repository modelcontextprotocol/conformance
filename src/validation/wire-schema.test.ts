import { createServer, type Server } from 'http';
import { DRAFT_PROTOCOL_VERSION } from '../types';
import { sendStatelessRequest } from '../connection/stateless';
import {
  resetWireValidation,
  takeWireViolations,
  wireSchemaChecks,
  wireSchemaErrors
} from './wire-schema';

const META = {
  'io.modelcontextprotocol/protocolVersion': DRAFT_PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'c', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': { sampling: {} }
};

/** The exact hallucinated shape PR #376 fixed: an array instead of a
 * ClientCapabilities object in error.data.requiredCapabilities. */
const PR_376_INVALID_ERROR = {
  jsonrpc: '2.0',
  id: 1,
  error: {
    code: -32021,
    message: 'Server requires the sampling capability',
    data: { requiredCapabilities: ['sampling'] }
  }
};

function listen(
  handler: (body: string) => { status: number; body: unknown }
): Promise<{ url: string; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const { status, body } = handler(raw);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://localhost:${addr.port}/mcp`, server });
    });
  });
}

describe('wireSchemaErrors', () => {
  it('rejects the PR #376 hallucinated requiredCapabilities array under the draft schema', () => {
    const errors = wireSchemaErrors(
      DRAFT_PROTOCOL_VERSION,
      PR_376_INVALID_ERROR
    );
    expect(errors).toEqual([
      expect.stringContaining(
        'MissingRequiredClientCapabilityError/error/data/requiredCapabilities: must be object'
      )
    ]);
  });

  it('accepts the spec-valid ClientCapabilities object shape', () => {
    expect(
      wireSchemaErrors(DRAFT_PROTOCOL_VERSION, {
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32021,
          message: 'Server requires the sampling capability',
          data: { requiredCapabilities: { sampling: {} } }
        }
      })
    ).toEqual([]);
  });

  it('rejects messages that are not JSON-RPC at all', () => {
    expect(wireSchemaErrors('2025-06-18', { hello: 'world' })).toEqual([
      expect.stringContaining('JSONRPCMessage')
    ]);
  });

  it('validates typed requests by method const', () => {
    expect(
      wireSchemaErrors(DRAFT_PROTOCOL_VERSION, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { _meta: META }
      })
    ).toEqual([
      expect.stringContaining(
        "CallToolRequest/params: must have required property 'name'"
      )
    ]);
  });

  it('validates results against the typed result definition for the request method', () => {
    // Draft results must carry resultType / ttlMs / cacheScope.
    const errors = wireSchemaErrors(
      DRAFT_PROTOCOL_VERSION,
      { jsonrpc: '2.0', id: 3, result: { tools: [] } },
      'tools/list'
    );
    expect(errors.join('\n')).toContain('ListToolsResult');
    // The same result is valid at 2025-11-25, which has no such requirement.
    expect(
      wireSchemaErrors(
        '2025-11-25',
        { jsonrpc: '2.0', id: 3, result: { tools: [] } },
        'tools/list'
      )
    ).toEqual([]);
  });

  it('accepts a JSON-RPC batch under 2025-03-26 and reports per-element errors', () => {
    expect(
      wireSchemaErrors('2025-03-26', [
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' }
      ])
    ).toEqual([]);
    expect(
      wireSchemaErrors('2025-03-26', [
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { nope: true }
      ])
    ).toEqual([expect.stringContaining('[1] JSONRPCMessage')]);
  });
});

describe('wire-schema choke points and checks', () => {
  it('records a failing wire-schema-valid check when the implementation sends the PR #376 shape', async () => {
    const { url, server } = await listen(() => ({
      status: 400,
      body: PR_376_INVALID_ERROR
    }));
    try {
      resetWireValidation();
      await sendStatelessRequest(url, 'tools/list');
      const checks = wireSchemaChecks(DRAFT_PROTOCOL_VERSION);
      const wire = checks.find((c) => c.id === 'wire-schema-valid');
      expect(wire?.status).toBe('FAILURE');
      expect(wire?.errorMessage).toContain('requiredCapabilities');
      // The invalid message came from the (mock) implementation, not the
      // harness — no harness-error check.
      expect(
        checks.find((c) => c.id === 'wire-schema-harness-error')
      ).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('records a hard harness error when the harness itself sends an invalid message', async () => {
    const { url, server } = await listen(() => ({
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: 1,
        result: { resultType: 'complete', content: [] }
      }
    }));
    try {
      resetWireValidation();
      // tools/call without params.name violates CallToolRequest.
      await sendStatelessRequest(url, 'tools/call', { arguments: {} });
      const checks = wireSchemaChecks(DRAFT_PROTOCOL_VERSION);
      const harness = checks.find((c) => c.id === 'wire-schema-harness-error');
      expect(harness?.status).toBe('FAILURE');
      expect(harness?.errorMessage).toContain('HARNESS ERROR');
      expect(harness?.errorMessage).toContain("required property 'name'");
    } finally {
      server.close();
    }
  });

  it('skips both directions for a call that opts out via skipValidation', async () => {
    const { url, server } = await listen(() => ({
      status: 400,
      body: PR_376_INVALID_ERROR
    }));
    try {
      resetWireValidation();
      await sendStatelessRequest(
        url,
        'tools/call',
        { arguments: {} },
        { skipValidation: true }
      );
      const { violations, observed } = takeWireViolations();
      expect(observed).toBe(0);
      expect(violations).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('emits a passing wire-schema-valid check for clean traffic', async () => {
    const { url, server } = await listen(() => ({
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: 1,
        result: {
          resultType: 'complete',
          ttlMs: 0,
          cacheScope: 'private',
          tools: []
        }
      }
    }));
    try {
      resetWireValidation();
      await sendStatelessRequest(url, 'tools/list');
      const checks = wireSchemaChecks(DRAFT_PROTOCOL_VERSION);
      expect(checks).toHaveLength(1);
      expect(checks[0].id).toBe('wire-schema-valid');
      expect(checks[0].status).toBe('SUCCESS');
      expect(checks[0].details?.messagesValidated).toBe(2);
    } finally {
      server.close();
    }
  });

  it('emits no checks when no wire traffic was observed', () => {
    resetWireValidation();
    expect(wireSchemaChecks(DRAFT_PROTOCOL_VERSION)).toEqual([]);
  });
});
