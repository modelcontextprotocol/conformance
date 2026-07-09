import { createServer, type Server } from 'http';
import { DRAFT_PROTOCOL_VERSION } from '../types';
import { sendStatelessRequest } from '../connection/stateless';
import {
  resetWireValidation,
  specDispatchMaps,
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

  it('skips only the request direction for a call that opts out via skipValidation', async () => {
    const { url, server } = await listen(() => ({
      status: 400,
      body: PR_376_INVALID_ERROR
    }));
    try {
      resetWireValidation();
      // The deliberately-malformed request is not validated, but the
      // implementation's response still is — and here it is invalid.
      await sendStatelessRequest(
        url,
        'tools/call',
        { arguments: {} },
        { skipValidation: true }
      );
      const { violations, observed } = takeWireViolations();
      expect(observed).toBe(1);
      expect(violations).toHaveLength(1);
      expect(violations[0].origin).toBe('implementation');
      expect(violations[0].errors.join('\n')).toContain('requiredCapabilities');
    } finally {
      server.close();
    }
  });

  it('tolerates a JSON-RPC 2.0 `id: null` error response only on skip-validated requests', async () => {
    // JSON-RPC 2.0 requires id: null on error responses to requests that
    // could not be processed; the MCP schema's RequestId forbids null.
    const { url, server } = await listen(() => ({
      status: 400,
      body: {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' }
      }
    }));
    try {
      resetWireValidation();
      await sendStatelessRequest(
        url,
        'tools/call',
        { arguments: {} },
        { skipValidation: true }
      );
      const skipped = takeWireViolations();
      expect(skipped.observed).toBe(1);
      expect(skipped.violations).toEqual([]);

      // The carve-out is narrow: the same response on a normal (validated)
      // call is still a violation.
      await sendStatelessRequest(url, 'tools/list');
      const normal = takeWireViolations();
      expect(
        normal.violations.filter((v) => v.origin === 'implementation')
      ).toHaveLength(1);
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

describe('specDispatchMaps', () => {
  // Pin the dispatch maps extracted from each vendored schema: if a schema sync
  // restructures the `method`/`error.code` consts the extraction walks, validation
  // silently degrades to envelope-only. These pins make that loud instead.

  const METHOD_DEFS_2025_03_26: Record<string, string> = {
    'tools/call': 'CallToolRequest',
    'notifications/cancelled': 'CancelledNotification',
    'completion/complete': 'CompleteRequest',
    'sampling/createMessage': 'CreateMessageRequest',
    'prompts/get': 'GetPromptRequest',
    initialize: 'InitializeRequest',
    'notifications/initialized': 'InitializedNotification',
    'prompts/list': 'ListPromptsRequest',
    'resources/templates/list': 'ListResourceTemplatesRequest',
    'resources/list': 'ListResourcesRequest',
    'roots/list': 'ListRootsRequest',
    'tools/list': 'ListToolsRequest',
    'notifications/message': 'LoggingMessageNotification',
    ping: 'PingRequest',
    'notifications/progress': 'ProgressNotification',
    'notifications/prompts/list_changed': 'PromptListChangedNotification',
    'resources/read': 'ReadResourceRequest',
    'notifications/resources/list_changed': 'ResourceListChangedNotification',
    'notifications/resources/updated': 'ResourceUpdatedNotification',
    'notifications/roots/list_changed': 'RootsListChangedNotification',
    'logging/setLevel': 'SetLevelRequest',
    'resources/subscribe': 'SubscribeRequest',
    'notifications/tools/list_changed': 'ToolListChangedNotification',
    'resources/unsubscribe': 'UnsubscribeRequest'
  };

  // 2025-06-18 adds elicitation on top of 2025-03-26.
  const METHOD_DEFS_2025_06_18: Record<string, string> = {
    ...METHOD_DEFS_2025_03_26,
    'elicitation/create': 'ElicitRequest'
  };

  // 2025-11-25 adds tasks (SEP-1686) and the elicitation-complete
  // notification on top of 2025-06-18.
  const METHOD_DEFS_2025_11_25: Record<string, string> = {
    ...METHOD_DEFS_2025_06_18,
    'tasks/cancel': 'CancelTaskRequest',
    'notifications/elicitation/complete': 'ElicitationCompleteNotification',
    'tasks/result': 'GetTaskPayloadRequest',
    'tasks/get': 'GetTaskRequest',
    'tasks/list': 'ListTasksRequest',
    'notifications/tasks/status': 'TaskStatusNotification'
  };

  // The draft (SEP-2575) drops the initialize/session lifecycle, ping,
  // logging/setLevel, roots-changed, tasks, and resource subscriptions, and
  // adds server/discover plus subscriptions/listen.
  const METHOD_DEFS_DRAFT: Record<string, string> = (() => {
    const defs: Record<string, string> = {
      ...METHOD_DEFS_2025_11_25,
      'server/discover': 'DiscoverRequest',
      'subscriptions/listen': 'SubscriptionsListenRequest',
      'notifications/subscriptions/acknowledged':
        'SubscriptionsAcknowledgedNotification'
    };
    for (const removed of [
      'initialize',
      'notifications/initialized',
      'ping',
      'logging/setLevel',
      'notifications/roots/list_changed',
      'resources/subscribe',
      'resources/unsubscribe',
      'tasks/cancel',
      'notifications/elicitation/complete',
      'tasks/result',
      'tasks/get',
      'tasks/list',
      'notifications/tasks/status'
    ]) {
      delete defs[removed];
    }
    return defs;
  })();

  it.each([
    ['2025-03-26', METHOD_DEFS_2025_03_26, {}],
    ['2025-06-18', METHOD_DEFS_2025_06_18, {}],
    [
      '2025-11-25',
      METHOD_DEFS_2025_11_25,
      { '-32042': 'URLElicitationRequiredError' }
    ],
    [
      DRAFT_PROTOCOL_VERSION,
      METHOD_DEFS_DRAFT,
      {
        '-32020': 'HeaderMismatchError',
        '-32021': 'MissingRequiredClientCapabilityError',
        '-32022': 'UnsupportedProtocolVersionError'
      }
    ]
  ] as const)(
    'extracts the expected methodDefs and errorDefs for %s',
    (version, expectedMethods, expectedErrors) => {
      const { methodDefs, errorDefs, resultDefs } = specDispatchMaps(
        version as never
      );
      expect(Object.fromEntries(methodDefs)).toEqual(expectedMethods);
      expect(
        Object.fromEntries(
          [...errorDefs].map(([code, def]) => [String(code), def])
        )
      ).toEqual(expectedErrors);
      // Every XxxRequest with a schema-defined XxxResult must be paired.
      expect(resultDefs.get('tools/call')).toBe('CallToolResult');
      expect(resultDefs.get('tools/list')).toBe('ListToolsResult');
    }
  );

  it('pairs elicitation/create with ElicitResult from 2025-06-18 on (the #376 class)', () => {
    expect(
      specDispatchMaps('2025-03-26').resultDefs.get('elicitation/create')
    ).toBeUndefined();
    expect(
      specDispatchMaps('2025-06-18').resultDefs.get('elicitation/create')
    ).toBe('ElicitResult');
    expect(
      specDispatchMaps('2025-11-25').resultDefs.get('elicitation/create')
    ).toBe('ElicitResult');
    expect(
      specDispatchMaps(DRAFT_PROTOCOL_VERSION).resultDefs.get(
        'elicitation/create'
      )
    ).toBe('ElicitResult');
    expect(
      specDispatchMaps(DRAFT_PROTOCOL_VERSION).resultDefs.get('server/discover')
    ).toBe('DiscoverResult');
  });
});
