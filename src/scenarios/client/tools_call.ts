import type { ScenarioContext, MockServer } from '../../mock-server';
import type { Scenario, ConformanceCheck, ScenarioUrls } from '../../types';
import type { CallToolRequest } from '../../spec-types/2025-06-18';

const SPEC_REF = {
  id: 'MCP-Tools',
  url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/tools#calling-tools'
};

export class ToolsCallScenario implements Scenario {
  name = 'tools_call';
  readonly source = { introducedIn: '2025-06-18' } as const;
  description = 'Tests calling tools with various parameter types';
  private srv: MockServer | null = null;

  async start(ctx: ScenarioContext): Promise<ScenarioUrls> {
    this.srv = await ctx.createServer({
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
    return { serverUrl: this.srv.url };
  }

  async stop() {
    await this.srv?.close();
    this.srv = null;
  }

  getChecks(): ConformanceCheck[] {
    // Built fresh on every call so getChecks() is idempotent — the runner may
    // call it more than once and we must not accumulate duplicates.
    const call = this.srv?.recorded.find((r) => r.method === 'tools/call');
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
