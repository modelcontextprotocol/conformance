import type { ScenarioContext, MockHandler } from '../../mock-server';
import type { ConformanceCheck, RequestListener } from '../../types';
import { HandlerScenario } from '../../types';
import type { CallToolRequest } from '../../spec-types/2025-06-18';

const SPEC_REF = {
  id: 'MCP-Tools',
  url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/tools#calling-tools'
};
const SPEC_REF_2026_07_28 = {
  id: 'MCP-2026-07-28-Tools',
  url: 'https://modelcontextprotocol.io/specification/2026-07-28/server/tools#calling-tools'
};

/** Raw events, one per request the mock routed to the scenario. */
const TOOLS_LIST_EVENT_ID = 'tools-list-requested';
const TOOLS_CALL_EVENT_ID = 'tools-call-requested';

export class ToolsCallScenario extends HandlerScenario {
  name = 'tools_call';
  readonly source = { introducedIn: '2025-06-18' } as const;
  description = 'Tests calling tools with various parameter types';
  mcpPath = '/mcp';
  private mock: MockHandler | null = null;
  /**
   * The raw log: an INFO event per tools/list and tools/call the client
   * made. getChecks() judges from this, so the hosted server can persist it
   * per process and judge the merged log once when a client's requests are
   * spread across processes (see src/hosted/session.ts).
   */
  private checks: ConformanceCheck[] = [];

  handler(_getBaseUrl: () => string, ctx: ScenarioContext): RequestListener {
    this.checks = [];
    // The version-aware mock supplies the lifecycle scaffold; unbound so the
    // same body serves the CLI runner (via HandlerScenario.start) and the
    // hosted runner's path-prefix mount.
    this.mock = ctx.createHandler({
      'tools/list': () => {
        this.checks.push({
          id: TOOLS_LIST_EVENT_ID,
          name: 'ToolsListRequested',
          description: 'Client requested tools/list',
          status: 'INFO',
          timestamp: new Date().toISOString(),
          specReferences: [SPEC_REF, SPEC_REF_2026_07_28]
        });
        return {
          tools: [
            {
              name: 'add_numbers',
              description: 'Add two numbers together',
              inputSchema: {
                type: 'object',
                properties: {
                  a: { type: 'number', description: 'First number' },
                  b: { type: 'number', description: 'Second number' }
                },
                required: ['a', 'b']
              }
            }
          ]
        };
      },
      'tools/call': (params) => {
        const p = params as CallToolRequest['params'];
        this.checks.push({
          id: TOOLS_CALL_EVENT_ID,
          name: 'ToolsCallRequested',
          description: `Client called tool '${p.name}'`,
          status: 'INFO',
          timestamp: new Date().toISOString(),
          specReferences: [SPEC_REF, SPEC_REF_2026_07_28],
          details: { name: p.name, arguments: p.arguments }
        });
        if (p.name !== 'add_numbers') {
          throw new Error(`Unknown tool: ${p.name}`);
        }
        const { a, b } = p.arguments as { a: number; b: number };
        return {
          content: [
            { type: 'text', text: `The sum of ${a} and ${b} is ${a + b}` }
          ]
        };
      }
    });
    return this.mock.listener;
  }

  readonly steps = [
    { op: 'tools/list' },
    { op: 'tools/call', name: 'add_numbers', arguments: { a: 5, b: 3 } }
  ] as const;

  getChecks(): ConformanceCheck[] {
    // Built fresh on every call so getChecks() is idempotent — the runner may
    // call it more than once and we must not accumulate duplicates. Judged
    // from the raw log, not the mock's `recorded`, which only this process's
    // mock instance holds. Every call is judged, from every connection and
    // process: one that sends bad arguments fails the check whenever it
    // came, and is the one shown.
    const argsOf = (c: ConformanceCheck) =>
      c.details?.arguments as { a?: unknown; b?: unknown } | undefined;
    const numeric = (c: ConformanceCheck) =>
      typeof argsOf(c)?.a === 'number' && typeof argsOf(c)?.b === 'number';
    const calls = this.checks.filter((c) => c.id === TOOLS_CALL_EVENT_ID);
    const call = calls.find((c) => !numeric(c)) ?? calls[0];
    const args = call && argsOf(call);
    const ok = call !== undefined && numeric(call);
    return [
      {
        id: 'tool-add-numbers',
        name: 'ToolAddNumbers',
        description: 'Validates that the add_numbers tool works correctly',
        status: ok ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [SPEC_REF, SPEC_REF_2026_07_28],
        ...(call &&
          !ok && {
            errorMessage: `Client called '${String(call.details?.name)}' without numbers for a and b`
          }),
        details: ok
          ? {
              a: args!.a,
              b: args!.b,
              result: (args!.a as number) + (args!.b as number)
            }
          : call
            ? { name: call.details?.name, arguments: args }
            : { message: 'Tool was not called by client' }
      }
    ];
  }
}
