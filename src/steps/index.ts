/**
 * Client steering steps ("generic steering").
 *
 * Most client scenarios only need plumbing from the client under test:
 * connect, list tools, call a tool, hang around, disconnect. Instead of every
 * SDK's everything-client carrying a per-scenario dispatch table for that
 * choreography, a scenario can declare it as data. The runner ships the
 * steps to the client in MCP_CONFORMANCE_CONTEXT (`context.steps`); a client
 * with no bespoke handler for the scenario name runs a small interpreter over
 * them. Checks stay in the scenario — only the *instructions* become data.
 *
 * The op set is deliberately closed. Anything that needs judgement on the
 * client side (credential modes, MRTR) keeps a named handler.
 *
 * Standing defaults an interpreter should apply without being told:
 *   - `initialize` is implicit (connect before the first step);
 *   - if the server sends elicitation/create, accept with schema defaults
 *     (empty content + `elicitation.applyDefaults` capability);
 *   - disconnect after the last step unless a `disconnect` step says when.
 */

import { z } from 'zod';

/**
 * `{ "$from": "tools/list", "path": "tools[name=echo].inputSchema" }` — a
 * value captured from the most recent result of a previous op. The only
 * dataflow form; two scenarios need it ("call B with the schema you got for
 * A"), nothing needs more.
 */
export const FromRefSchema = z.object({
  $from: z.enum(['tools/list', 'tools/call']),
  path: z.string()
});
export type FromRef = z.infer<typeof FromRefSchema>;

export const StepSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('tools/list') }),
  z.object({
    op: z.literal('tools/call'),
    name: z.string(),
    /** Argument values may be literals or `$from` captures. */
    arguments: z.record(z.string(), z.unknown()).optional()
  }),
  z.object({ op: z.literal('wait'), ms: z.number().int().nonnegative() }),
  z.object({ op: z.literal('disconnect') })
]);
export type Step = z.infer<typeof StepSchema>;

export const StepsSchema = z.array(StepSchema);

/** Results an interpreter has captured so far, keyed by op. */
export type Captures = Partial<Record<FromRef['$from'], unknown>>;

export function isFromRef(v: unknown): v is FromRef {
  return (
    typeof v === 'object' &&
    v !== null &&
    '$from' in v &&
    FromRefSchema.safeParse(v).success
  );
}

/**
 * Resolve a `$from` path against a captured result. Path grammar:
 * dot-separated segments, each either a key (`inputSchema`), an index
 * (`tools[0]`) or a filter on an array of objects (`tools[name=echo]`,
 * first match). Returns undefined when anything along the way is missing —
 * the interpreter should pass that through and let the scenario judge.
 */
export function resolveFrom(captures: Captures, ref: FromRef): unknown {
  let cur: unknown = captures[ref.$from];
  for (const seg of ref.path.split('.').filter(Boolean)) {
    const m = seg.match(/^([^[\]]*)(?:\[(?:(\d+)|([^=\]]+)=([^\]]*))\])?$/);
    if (!m) return undefined;
    const [, key, index, fkey, fval] = m;
    if (key) cur = (cur as Record<string, unknown> | undefined)?.[key];
    if (index !== undefined) cur = (cur as unknown[] | undefined)?.[+index];
    else if (fkey !== undefined) {
      cur = Array.isArray(cur)
        ? cur.find(
            (x) =>
              typeof x === 'object' &&
              x !== null &&
              String((x as Record<string, unknown>)[fkey]) === fval
          )
        : undefined;
    }
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** Resolve every `$from` capture in a tools/call arguments object (shallow). */
export function resolveArguments(
  captures: Captures,
  args: Record<string, unknown> | undefined
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    out[k] = isFromRef(v) ? resolveFrom(captures, v) : v;
  }
  return out;
}
