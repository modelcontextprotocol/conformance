/**
 * tools/call input validation (SEP-1303; "Servers MUST validate all tool
 * inputs", server/tools#security-considerations).
 */

import type {
  ClientScenario,
  ConformanceCheck,
  SpecReference
} from '../../types';
import {
  JsonRpcError,
  type Connection,
  type RunContext
} from '../../connection';
import { untestableCheck } from '../untestable';

const TOOL = 'test_input_validation';

const SECURITY_REF: SpecReference = {
  id: 'MCP-Tools-Security',
  url: 'https://modelcontextprotocol.io/specification/2025-11-25/server/tools#security-considerations'
};
const ERROR_HANDLING_REF: SpecReference = {
  id: 'SEP-1303',
  url: 'https://modelcontextprotocol.io/specification/2025-11-25/server/tools#error-handling'
};

type Outcome =
  | { kind: 'executed'; result: unknown }
  | { kind: 'tool-error'; result: unknown }
  | { kind: 'protocol-error'; code: number; message: string }
  | { kind: 'transport-error'; message: string };

const INVALID_CASES: ReadonlyArray<{
  label: string;
  args: Record<string, unknown>;
}> = [
  { label: 'wrong type (string for integer)', args: { value: 'five' } },
  { label: 'missing required property', args: {} },
  { label: 'out of range (maximum 10)', args: { value: 11 } }
];

async function callTool(
  conn: Connection,
  args: Record<string, unknown>
): Promise<Outcome> {
  try {
    const result = await conn.request<Record<string, unknown>>('tools/call', {
      name: TOOL,
      arguments: args
    });
    return result?.isError === true
      ? { kind: 'tool-error', result }
      : { kind: 'executed', result };
  } catch (e) {
    if (e instanceof JsonRpcError) {
      return { kind: 'protocol-error', code: e.code, message: e.message };
    }
    return {
      kind: 'transport-error',
      message: e instanceof Error ? e.message : String(e)
    };
  }
}

function hasTextContent(result: unknown): boolean {
  const content = (result as { content?: unknown })?.content;
  return (
    Array.isArray(content) &&
    content.some(
      (c: any) => c?.type === 'text' && typeof c.text === 'string' && c.text
    )
  );
}

export class ToolsCallInputValidationScenario implements ClientScenario {
  name = 'tools-call-input-validation';
  readonly source = { introducedIn: '2025-11-25' } as const;
  description = `Test that a server validates tool arguments against the tool's inputSchema.

**Server Implementation Requirements:**

Implement tool \`${TOOL}\` with \`inputSchema\`:

\`\`\`json
{
  "type": "object",
  "properties": { "value": { "type": "integer", "minimum": 1, "maximum": 10 } },
  "required": ["value"]
}
\`\`\`

A valid call returns a text result. The harness then sends arguments that
violate the schema (wrong type, missing required property, out of range).
Servers MUST validate all tool inputs, so none of these may execute the tool.
Input validation errors are Tool Execution Errors: they are reported in the
tool result with \`isError: true\`, not as a JSON-RPC error.`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    let conn: Connection;
    try {
      conn = await ctx.connect();
    } catch (e) {
      const reason = `could not connect: ${e instanceof Error ? e.message : String(e)}`;
      return [
        untestableCheck(
          'tools-call-input-validation-valid',
          'ToolsCallInputValidationValid',
          'A call with schema-valid arguments returns a result',
          reason,
          [ERROR_HANDLING_REF]
        ),
        untestableCheck(
          'sep-1303-input-validation-rejected',
          'ToolsCallInputValidationRejected',
          'Schema-invalid arguments are not executed',
          reason,
          [SECURITY_REF]
        ),
        untestableCheck(
          'sep-1303-input-validation-tool-error',
          'ToolsCallInputValidationToolError',
          'Input validation errors are reported as tool execution errors',
          reason,
          [ERROR_HANDLING_REF],
          'WARNING'
        )
      ];
    }
    try {
      return await this.runChecks(conn);
    } finally {
      await conn.close().catch(() => {});
    }
  }

  private async runChecks(conn: Connection): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const ts = () => new Date().toISOString();

    // Control: a valid call must succeed, or the invalid probes prove nothing.
    const valid = await callTool(conn, { value: 5 });
    const validOk = valid.kind === 'executed' && hasTextContent(valid.result);
    if (!validOk) {
      const reason = `valid call to ${TOOL} with {"value": 5} did not return a text result (${valid.kind}${
        valid.kind === 'protocol-error'
          ? ` ${valid.code}: ${valid.message}`
          : ''
      }${valid.kind === 'transport-error' ? `: ${valid.message}` : ''})`;
      checks.push({
        id: 'tools-call-input-validation-valid',
        name: 'ToolsCallInputValidationValid',
        description: 'A call with schema-valid arguments returns a result',
        status: 'FAILURE',
        timestamp: ts(),
        errorMessage: reason,
        specReferences: [ERROR_HANDLING_REF],
        details: { outcome: valid }
      });
      checks.push(
        untestableCheck(
          'sep-1303-input-validation-rejected',
          'ToolsCallInputValidationRejected',
          'Schema-invalid arguments are not executed',
          reason,
          [SECURITY_REF]
        ),
        untestableCheck(
          'sep-1303-input-validation-tool-error',
          'ToolsCallInputValidationToolError',
          'Input validation errors are reported as tool execution errors',
          reason,
          [ERROR_HANDLING_REF],
          'WARNING'
        )
      );
      return checks;
    }
    checks.push({
      id: 'tools-call-input-validation-valid',
      name: 'ToolsCallInputValidationValid',
      description: 'A call with schema-valid arguments returns a result',
      status: 'SUCCESS',
      timestamp: ts(),
      specReferences: [ERROR_HANDLING_REF],
      details: { outcome: valid }
    });

    const cases: Array<{ label: string; args: unknown; outcome: Outcome }> = [];
    for (const c of INVALID_CASES) {
      cases.push({ ...c, outcome: await callTool(conn, c.args) });
    }

    // MUST: Validate all tool inputs. Any rejection (tool error or JSON-RPC
    // error) satisfies it; an ordinary result means the tool ran.
    const executed = cases.filter((c) => c.outcome.kind === 'executed');
    const transport = cases.filter((c) => c.outcome.kind === 'transport-error');
    const rejectedFail = executed.length > 0 || transport.length > 0;
    checks.push({
      id: 'sep-1303-input-validation-rejected',
      name: 'ToolsCallInputValidationRejected',
      description: 'Schema-invalid arguments are not executed',
      status: rejectedFail ? 'FAILURE' : 'SUCCESS',
      timestamp: ts(),
      errorMessage: rejectedFail
        ? [
            ...executed.map(
              (c) =>
                `${c.label}: tool executed and returned a result without isError`
            ),
            ...transport.map(
              (c) =>
                `${c.label}: no JSON-RPC response (${(c.outcome as { message: string }).message})`
            )
          ].join('; ')
        : undefined,
      specReferences: [SECURITY_REF],
      details: { cases }
    });

    // Error taxonomy: input validation errors are tool execution errors.
    const notToolError = cases.filter(
      (c) =>
        c.outcome.kind !== 'tool-error' ||
        !hasTextContent((c.outcome as { result: unknown }).result)
    );
    checks.push({
      id: 'sep-1303-input-validation-tool-error',
      name: 'ToolsCallInputValidationToolError',
      description:
        'Input validation errors are reported as tool execution errors',
      status: notToolError.length > 0 ? 'WARNING' : 'SUCCESS',
      timestamp: ts(),
      errorMessage:
        notToolError.length > 0
          ? notToolError
              .map((c) => {
                const o = c.outcome;
                if (o.kind === 'protocol-error')
                  return `${c.label}: JSON-RPC error ${o.code} instead of an isError result`;
                if (o.kind === 'tool-error')
                  return `${c.label}: isError result has no text content`;
                return `${c.label}: ${o.kind}`;
              })
              .join('; ')
          : undefined,
      specReferences: [ERROR_HANDLING_REF],
      details: { cases }
    });

    return checks;
  }
}
