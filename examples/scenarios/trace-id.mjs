/**
 * Example of a scenario kept outside the suite: a check that belongs to one
 * product, not to the spec. Here a team requires its client to tag every
 * tool call with a trace id in `_meta`. The README, "Writing Your Own
 * Scenarios", says how to run it.
 *
 * A scenario plays the server. `start()` serves the handlers below and
 * returns the URL the client under test is given; `getChecks()` judges what
 * the client sent. Nothing is imported from the suite.
 */

const TRACE_ID = 'com.example/traceId';

const SPEC_REFERENCES = [
  {
    id: 'MCP-Tools',
    url: 'https://modelcontextprotocol.io/specification/2025-11-25/server/tools#calling-tools'
  },
  {
    id: 'MCP-Meta',
    url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/index#_meta'
  }
];

class TraceIdScenario {
  // Prefix your names so they can never clash with a built-in scenario.
  name = 'example/trace-id';
  description = 'Example: the client tags every tool call with a trace id';
  // The first spec version the scenario applies to.
  source = { introducedIn: '2025-06-18' };
  server = null;

  async start(ctx) {
    // One handler per method. It receives the request's `params` and returns
    // the result. The suite supplies the lifecycle for `ctx.specVersion`.
    this.server = await ctx.createServer({
      'tools/list': () => ({
        tools: [
          {
            name: 'echo',
            description: 'Return the text it is given',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text']
            }
          }
        ]
      }),
      'tools/call': (params) => ({
        content: [{ type: 'text', text: String(params.arguments?.text) }]
      })
    });
    // `context`, if you return one, reaches the client as MCP_CONFORMANCE_CONTEXT.
    return { serverUrl: this.server.url };
  }

  async stop() {
    await this.server?.close();
  }

  // Called after the client has finished and before stop().
  getChecks() {
    // Every request and notification the client sent, in order, without the
    // lifecycle ones (initialize, notifications/initialized, server/discover).
    const calls = (this.server?.recorded ?? []).filter(
      (request) => request.method === 'tools/call'
    );
    const untagged = calls.filter(
      (call) => typeof call.params?._meta?.[TRACE_ID] !== 'string'
    );
    const called = calls.length > 0;
    const tagged = called && untagged.length === 0;

    // One id per check, whether it passes or fails.
    return [
      {
        id: 'example-tool-called',
        name: 'ToolCalled',
        description: 'The client called a tool',
        status: called ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: SPEC_REFERENCES,
        ...(!called && { errorMessage: 'The client never sent tools/call' })
      },
      {
        id: 'example-trace-id-sent',
        name: 'TraceIdSent',
        description: `Every tool call carries _meta["${TRACE_ID}"]`,
        status: tagged ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: SPEC_REFERENCES,
        ...(!tagged && {
          errorMessage: called
            ? `${untagged.length} of ${calls.length} tool calls had no trace id`
            : 'The client never sent tools/call'
        })
      }
    ];
  }
}

// Export one scenario, or an array of them.
export default new TraceIdScenario();
