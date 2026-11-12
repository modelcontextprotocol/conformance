/**
 * Deliberately broken pagination strategies for the client-pagination scenario.
 * MCP_PAGINATION_DEFECT selects a control; the default reproduces the truthiness
 * condition reported in conformance#577. No language-model service is used.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sendStatelessRequest } from '../../../src/connection/stateless.js';
import { STATELESS_SPEC_VERSIONS } from '../../../src/connection/select.js';
import { LATEST_SPEC_VERSION, type SpecVersion } from '../../../src/types.js';
import { runAsCli } from './helpers/cliRunner.js';

export type PaginationDefect =
  | 'truthy-cursor'
  | 'trim-cursor'
  | 'recover-trim'
  | 'empty-page'
  | 'past-end'
  | 'inert'
  | 'rediscover';

export async function runClient(
  serverUrl: string,
  defect: PaginationDefect = (process.env.MCP_PAGINATION_DEFECT ??
    'truthy-cursor') as PaginationDefect
): Promise<void> {
  if (defect === 'inert') return;
  const specVersion = (process.env.MCP_CONFORMANCE_PROTOCOL_VERSION ??
    LATEST_SPEC_VERSION) as SpecVersion;
  const stateless = (STATELESS_SPEC_VERSIONS as readonly string[]).includes(
    specVersion
  );
  const client = new Client(
    { name: 'pagination-control-client', version: '1.0.0' },
    { capabilities: {} }
  );
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
  type ToolPage = { tools: { name: string }[]; nextCursor?: string };
  async function request(method: string, params: Record<string, unknown>) {
    const response = await sendStatelessRequest(serverUrl, method, params, {
      specVersion
    });
    if (response.body?.error || !response.body?.result) {
      throw new Error(`${method}: ${JSON.stringify(response.body)}`);
    }
    return response.body.result;
  }
  async function list(cursor?: string): Promise<ToolPage> {
    const params = cursor === undefined ? {} : { cursor };
    return stateless
      ? ((await request('tools/list', params)) as ToolPage)
      : client.listTools(params);
  }
  try {
    if (!stateless) await client.connect(transport);
    const tools: { name: string }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 8; page++) {
      const result = await list(cursor);
      tools.push(...result.tools);
      // One wrong condition is enough to stop on a valid empty-string cursor.
      if (defect === 'truthy-cursor' && !result.nextCursor) break;
      if (defect === 'empty-page' && result.tools.length === 0) break;
      if (result.nextCursor === undefined) {
        // Continue the SAME traversal once after the server declared its end.
        if (defect === 'past-end') await list(cursor);
        break;
      }
      if (defect === 'recover-trim' && result.nextCursor !== '') {
        try {
          await list(result.nextCursor.trim());
        } catch {
          // Recover with the advertised cursor; the earlier violation remains.
        }
      }
      cursor =
        defect === 'trim-cursor' ? result.nextCursor.trim() : result.nextCursor;
    }
    if (tools.some((tool) => tool.name === 'add_numbers')) {
      const params = { name: 'add_numbers', arguments: { a: 2, b: 3 } };
      if (stateless) await request('tools/call', params);
      else await client.callTool(params);
    }
    // A NEW discovery after the requested traversal and tool call is allowed.
    if (defect === 'rediscover') await list();
  } finally {
    await client.close();
  }
}

runAsCli(runClient, import.meta.url);
