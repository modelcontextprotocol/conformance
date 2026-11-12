import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { MockServer, ScenarioContext } from '../../mock-server';
import type { ConformanceCheck, Scenario, ScenarioUrls } from '../../types';
import { untestableCheck } from '../untestable';

const SPEC_REFERENCES = [
  {
    id: 'MCP-Pagination',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/pagination#implementation-guidelines'
  },
  {
    id: 'MCP-Pagination-Empty-Cursor',
    url: 'https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/pagination#implementation-guidelines'
  }
];

// No cursor format is defined by the protocol. In particular, clients must not
// trim whitespace, decode punctuation, or stop on the empty-string cursor.
const OPAQUE_CURSOR = ' 0+/%雪?= ';
const ADD_NUMBERS = {
  name: 'add_numbers',
  description: 'Add two numbers',
  inputSchema: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b']
  }
};

export class PaginationScenario implements Scenario {
  name = 'client-pagination';
  // Opaque string cursors and variable page sizes are already specified here;
  // the 2026 revision additionally spells out that an empty string is valid.
  readonly source = { introducedIn: '2025-06-18' } as const;
  description =
    'Enumerate tools across three pages, preserving empty and opaque cursors, ' +
    'then call the discovered add_numbers tool. Complete this one traversal ' +
    'when nextCursor is absent; page sizes are 1, 0, and 2.';
  private srv: MockServer | null = null;

  async start(ctx: ScenarioContext): Promise<ScenarioUrls> {
    this.srv = await ctx.createServer({
      'tools/list': (params) => {
        if (params.cursor === undefined) {
          return {
            tools: [
              { name: 'pagination_decoy', inputSchema: { type: 'object' } }
            ],
            nextCursor: ''
          };
        }
        if (params.cursor === '') {
          return { tools: [], nextCursor: OPAQUE_CURSOR };
        }
        if (params.cursor === OPAQUE_CURSOR) {
          return {
            tools: [
              ADD_NUMBERS,
              { name: 'pagination_tail', inputSchema: { type: 'object' } }
            ]
          };
        }
        throw new McpError(
          ErrorCode.InvalidParams,
          'Unknown pagination cursor'
        );
      },
      'tools/call': (params) => {
        const args = params.arguments as
          | { a?: unknown; b?: unknown }
          | undefined;
        if (
          params.name !== ADD_NUMBERS.name ||
          typeof args?.a !== 'number' ||
          typeof args.b !== 'number'
        ) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'Expected add_numbers(a, b)'
          );
        }
        return { content: [{ type: 'text', text: String(args.a + args.b) }] };
      }
    });
    return { serverUrl: this.srv.url };
  }

  async stop(): Promise<void> {
    await this.srv?.close();
    this.srv = null;
  }

  getChecks(): ConformanceCheck[] {
    const requests = this.srv?.recorded ?? [];
    const first = requests.findIndex(
      (r) => r.method === 'tools/list' && r.params?.cursor === undefined
    );
    const empty = requests.findIndex(
      (r, i) =>
        i > first && r.method === 'tools/list' && r.params?.cursor === ''
    );
    const terminal = requests.findIndex(
      (r, i) =>
        i > empty &&
        r.method === 'tools/list' &&
        r.params?.cursor === OPAQUE_CURSOR
    );
    const called = requests.findIndex((r, i) => {
      const args = r.params?.arguments as
        | { a?: unknown; b?: unknown }
        | undefined;
      return (
        i > terminal &&
        r.method === 'tools/call' &&
        r.params?.name === ADD_NUMBERS.name &&
        typeof args?.a === 'number' &&
        typeof args.b === 'number'
      );
    });
    const timestamp = new Date().toISOString();
    const emptyContinued = first >= 0 && empty > first;
    const terminalReached = emptyContinued && terminal > empty;
    // Eventual success must not hide a modified cursor followed by a retry.
    const unknownCursors = requests
      .filter(
        (r, i) =>
          i > empty &&
          (called < 0 || i < called) &&
          r.method === 'tools/list' &&
          r.params?.cursor !== undefined &&
          r.params.cursor !== '' &&
          r.params.cursor !== OPAQUE_CURSOR
      )
      .map((r) => r.params?.cursor);
    const opaquePreserved = terminalReached && unknownCursors.length === 0;
    const taskCompleted = terminalReached && called > terminal;
    // A new discovery AFTER the requested tool call is legitimate. Only grade
    // requests within this single enumeration, not all future tools/list calls.
    const ranPastEnd = requests
      .slice(terminal + 1, called >= 0 ? called : undefined)
      .some((r) => r.method === 'tools/list');
    return [
      first >= 0
        ? {
            id: 'pagination-empty-cursor',
            name: 'PaginationEmptyCursor',
            description: 'Client continues with the empty-string nextCursor',
            status: emptyContinued ? 'SUCCESS' : 'FAILURE',
            timestamp,
            specReferences: SPEC_REFERENCES,
            errorMessage: emptyContinued
              ? undefined
              : 'Client did not continue the listing with cursor: ""',
            details: { firstRequest: first, emptyCursorRequest: empty }
          }
        : untestableCheck(
            'pagination-empty-cursor',
            'PaginationEmptyCursor',
            'Client continues with the empty-string nextCursor',
            'Client never requested the initial tools/list page',
            SPEC_REFERENCES
          ),
      emptyContinued
        ? {
            id: 'pagination-opaque-cursor',
            name: 'PaginationOpaqueCursor',
            description:
              'Client preserves the opaque cursor and continues past an empty page',
            status: opaquePreserved ? 'SUCCESS' : 'FAILURE',
            timestamp,
            specReferences: SPEC_REFERENCES,
            errorMessage: opaquePreserved
              ? undefined
              : 'Client did not preserve the opaque cursor from the empty second page',
            details: {
              emptyCursorRequest: empty,
              terminalPageRequest: terminal,
              unknownCursors
            }
          }
        : untestableCheck(
            'pagination-opaque-cursor',
            'PaginationOpaqueCursor',
            'Client preserves the opaque cursor from the second page',
            'Client never requested the page that advertises the opaque cursor',
            SPEC_REFERENCES
          ),
      taskCompleted
        ? {
            id: 'pagination-tool-discovered',
            name: 'PaginationToolDiscovered',
            description:
              'Client calls add_numbers after discovering the last page',
            status: 'SUCCESS',
            timestamp,
            specReferences: SPEC_REFERENCES
          }
        : untestableCheck(
            'pagination-tool-discovered',
            'PaginationToolDiscovered',
            'Client completes the scenario by calling the last-page tool',
            'No valid add_numbers call followed the complete pagination traversal',
            SPEC_REFERENCES
          ),
      taskCompleted
        ? {
            id: 'pagination-stops-at-end',
            name: 'PaginationStopsAtEnd',
            description:
              'Client treats an absent nextCursor as the end of this traversal (SHOULD)',
            status: ranPastEnd ? 'WARNING' : 'SUCCESS',
            timestamp,
            specReferences: SPEC_REFERENCES,
            errorMessage: ranPastEnd
              ? 'Client requested another page after nextCursor was absent, before completing the traversal task'
              : undefined
          }
        : untestableCheck(
            'pagination-stops-at-end',
            'PaginationStopsAtEnd',
            'Client treats an absent nextCursor as the end of this traversal (SHOULD)',
            'Client did not complete the requested traversal and tool call',
            SPEC_REFERENCES,
            'WARNING'
          )
    ];
  }
}
