import type { ScenarioContext, MockHandler } from '../../mock-server';
import type { ConformanceCheck, RequestListener } from '../../types';
import { HandlerScenario } from '../../types';
import type { CallToolRequest } from '../../spec-types/2025-06-18';

const SPEC_REF = {
  id: 'MCP-Tools',
  url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/tools#calling-tools'
};

export class ToolsCallScenario extends HandlerScenario {
  name = 'tools_call';
  readonly source = { introducedIn: '2025-06-18' } as const;
  description = 'Tests calling tools with various parameter types';
  mcpPath = '/mcp';
  private mock: MockHandler | null = null;

  handler(_getBaseUrl: () => string, ctx: ScenarioContext): RequestListener {
    // The version-aware mock supplies the lifecycle scaffold; unbound so the
    // same body serves the CLI runner (via HandlerScenario.start) and the
    // hosted runner's path-prefix mount.
    this.mock = ctx.createHandler({
      'tools/list': () => ({
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
      }),
      'tools/call': (params) => {
        const p = params as CallToolRequest['params'];
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
    // call it more than once and we must not accumulate duplicates.
    const call = this.mock?.recorded.find((r) => r.method === 'tools/call');
    const args = (call?.params as CallToolRequest['params'] | undefined)
      ?.arguments as { a?: unknown; b?: unknown } | undefined;
    const ok =
      call !== undefined &&
      typeof args?.a === 'number' &&
      typeof args?.b === 'number';
    return [
      {
        id: 'tool-add-numbers',
        name: 'ToolAddNumbers',
        description: 'Validates that the add_numbers tool works correctly',
        status: ok ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [SPEC_REF],
        details: ok
          ? {
              a: args!.a,
              b: args!.b,
              result: (args!.a as number) + (args!.b as number)
            }
          : { message: 'Tool was not called by client' }
      }
    ];
  }
}
