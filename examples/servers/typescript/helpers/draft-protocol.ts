/**
 * Pre-transport support for the draft stateless wire protocol in example servers.
 *
 * The published v1 SDK is intentionally unaware of 2026-07-28. Detect those
 * requests before handing anything to its session-based HTTP transport.
 * Keep this aligned with the draft version in src/types.ts.
 */
import type { Request, Response } from 'express';

const DRAFT_VERSION = '2026-07-28';
const LEGACY_VERSIONS = new Set([
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25'
]);

type DraftRequest = { kind: 'draft'; method: string; id: unknown };
type RequestClassification =
  | DraftRequest
  | { kind: 'legacy' }
  | { kind: 'rejected' };

function reject(
  res: Response,
  id: unknown,
  code: number,
  message: string,
  data?: Record<string, unknown>
): { kind: 'rejected' } {
  res.status(400).json({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data ? { data } : {}) }
  });
  return { kind: 'rejected' };
}

/**
 * Classify and validate a POST /mcp request before the SDK transport sees it.
 * A legacy request must continue through the normal SDK session path.
 * Invalid draft requests are answered here and must not reach the transport.
 */
export function inspectDraftRequest(
  req: Request,
  res: Response
): RequestClassification {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const id = body.id ?? null;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = (body.params ?? {}) as Record<string, unknown>;
  const meta = params._meta as Record<string, unknown> | undefined;
  const rawVersion = req.headers['mcp-protocol-version'];
  const reqVersion = typeof rawVersion === 'string' ? rawVersion : undefined;

  // An initialized session or a known pre-2026 request uses the SDK's own path.
  if (req.headers['mcp-session-id']) return { kind: 'legacy' };
  if (meta === undefined && (!reqVersion || LEGACY_VERSIONS.has(reqVersion))) {
    return { kind: 'legacy' };
  }

  if (!reqVersion) {
    return reject(res, id, -32020, 'Missing MCP-Protocol-Version header');
  }
  const metaVersion = meta?.['io.modelcontextprotocol/protocolVersion'];
  if (!metaVersion || !meta?.['io.modelcontextprotocol/clientCapabilities']) {
    return reject(
      res,
      id,
      -32602,
      'Invalid params: missing _meta or required fields'
    );
  }
  if (reqVersion !== metaVersion) {
    return reject(res, id, -32020, 'Mismatched MCP-Protocol-Version header');
  }
  if (metaVersion !== DRAFT_VERSION) {
    return reject(res, id, -32022, 'UnsupportedProtocolVersionError', {
      supported: [DRAFT_VERSION],
      requested: String(metaVersion)
    });
  }
  return { kind: 'draft', id, method };
}

/** Send a draft result with its result envelope and private, zero-TTL hints. */
export function sendDraftResult(
  res: Response,
  id: unknown,
  result: Record<string, unknown>
): Response {
  return res.json({
    jsonrpc: '2.0',
    id,
    result: {
      ...result,
      resultType: 'complete',
      ttlMs: 0,
      cacheScope: 'private'
    }
  });
}

export function sendDraftDiscovery(
  res: Response,
  id: unknown,
  serverInfo: { name: string; version: string },
  capabilities: Record<string, unknown>
): Response {
  return sendDraftResult(res, id, {
    supportedVersions: [DRAFT_VERSION],
    capabilities,
    _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo }
  });
}

/**
 * Minimal negative fixtures do not implement other draft methods.
 */
export function sendDraftMethodNotFound(res: Response, id: unknown): Response {
  return res.status(404).json({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: 'Method not found' }
  });
}
