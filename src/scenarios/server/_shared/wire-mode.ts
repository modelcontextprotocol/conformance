/**
 * Wire-mode selection helpers shared by server-conformance harnesses.
 *
 * MCP defines two HTTP wire shapes that SDKs may implement:
 *
 *   - **legacy**: session-based — `initialize` handshake, `Mcp-Session-Id`
 *     on every follow-up, no per-request `_meta` envelope. Predates
 *     SEP-2575.
 *   - **stateless** (SEP-2575): no initialize, no session id, every
 *     request body carries `_meta.io.modelcontextprotocol/*` and the
 *     `MCP-Protocol-Version` header pins the negotiated version per
 *     request.
 *
 * SEP-2663 / SEP-2322 behavior is wire-independent in spec, so the
 * harnesses run every scenario against both wires by default. SDKs
 * that only implement one wire pin via `MCP_WIRE_MODES=legacy` or
 * `MCP_WIRE_MODES=stateless`.
 *
 * Hoisted out of the per-suite harnesses so tasks and mrtr share the
 * exact same parsing + default set; either suite advancing on one
 * dimension automatically picks the other up.
 */

export type WireMode = 'legacy' | 'stateless';

const VALID_MODES: ReadonlySet<WireMode> = new Set(['legacy', 'stateless']);

export const DEFAULT_WIRE_MODES: readonly WireMode[] = ['legacy', 'stateless'];

/**
 * Read `MCP_WIRE_MODES` from the environment. Comma-separated;
 * recognized values are `legacy` and `stateless`. Unknown tokens are
 * dropped; an empty / unset / fully-invalid value falls back to the
 * default (both wires).
 */
export function parseWireModes(): WireMode[] {
  const raw = process.env.MCP_WIRE_MODES;
  if (!raw) return [...DEFAULT_WIRE_MODES];
  const modes = raw
    .split(',')
    .map((s) => s.trim().toLowerCase() as WireMode)
    .filter((m) => VALID_MODES.has(m));
  return modes.length > 0 ? modes : [...DEFAULT_WIRE_MODES];
}
