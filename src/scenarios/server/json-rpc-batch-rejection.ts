/**
 * JSON-RPC batch rejection test scenario for MCP servers.
 *
 * Batch arrays violate the Streamable HTTP transport MUST: "The body of the POST
 * request MUST be a single JSON-RPC request, notification, or response."
 *
 * Probe design (AGENTS.md: distinguish rejection from unrelated errors):
 * - Stateful (2025-06-18 / 2025-11-25): initialize first, then POST a two-request
 *   ping batch with Mcp-Session-Id so the check exercises batch handling on an
 *   established session rather than "missing session ID" routing.
 * - Draft (stateless): POST a two-method batch with per-request _meta.
 *
 * Success criteria: any HTTP 4xx with a single JSON-RPC error object. We do
 * not require a specific error code (-32600 vs implementation-defined -320xx)
 * because SDKs and wrappers disagree today; acceptance is 2xx with batch or
 * single-request results. Negative proof: accepts-json-rpc-batch.ts.
 */

import {
  ClientScenario,
  ConformanceCheck,
  DRAFT_PROTOCOL_VERSION,
  type SpecVersion
} from '../../types';
import { buildStandardHeaders, type RunContext } from '../../connection';
import { request } from 'undici';

const SPEC_REFERENCES = [
  {
    id: 'MCP-Transports-POST-Body',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#sending-messages-to-the-server'
  },
  {
    id: 'MCP-Transports-POST-Body-2025-11-25',
    url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#sending-messages-to-the-server'
  },
  {
    id: 'MCP-2025-06-18-Changelog',
    url: 'https://modelcontextprotocol.io/specification/2025-06-18/changelog#major-changes'
  }
];

const CLIENT_INFO = {
  name: 'conformance-json-rpc-batch-test',
  version: '1.0.0'
};

function buildStatelessBatch(specVersion: string): unknown[] {
  return [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': specVersion,
          'io.modelcontextprotocol/clientInfo': CLIENT_INFO,
          'io.modelcontextprotocol/clientCapabilities': {}
        }
      }
    },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': specVersion,
          'io.modelcontextprotocol/clientInfo': CLIENT_INFO,
          'io.modelcontextprotocol/clientCapabilities': {}
        }
      }
    }
  ];
}

function buildStatefulBatch(): unknown[] {
  return [
    { jsonrpc: '2.0', id: 901, method: 'ping', params: {} },
    { jsonrpc: '2.0', id: 902, method: 'ping', params: {} }
  ];
}

export function jsonRpcErrorCode(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return undefined;
  }
  const error = (body as { error?: { code?: unknown } }).error;
  if (typeof error !== 'object' || error === null) return undefined;
  return typeof error.code === 'number' ? error.code : undefined;
}

/** True when the server appears to have processed the batch successfully. */
export function isBatchAccepted(statusCode: number, body: unknown): boolean {
  if (statusCode >= 200 && statusCode < 300 && Array.isArray(body)) {
    return true;
  }
  if (statusCode >= 200 && statusCode < 300 && !Array.isArray(body)) {
    const result = (body as { result?: unknown })?.result;
    if (result !== undefined) {
      return true;
    }
  }
  return false;
}

/** True when the server rejected the batch with an HTTP 4xx JSON-RPC error. */
export function isBatchRejected(statusCode: number, body: unknown): boolean {
  // Intentionally any 4xx + JSON-RPC error, not only -32600: reference servers
  // and SDK wrappers may surface batch rejection through different codes.
  if (isBatchAccepted(statusCode, body)) {
    return false;
  }
  return (
    statusCode >= 400 &&
    statusCode < 500 &&
    jsonRpcErrorCode(body) !== undefined
  );
}

async function establishStatefulSession(
  serverUrl: string,
  specVersion: SpecVersion
): Promise<string> {
  // Raw initialize (not ctx.connect()) so the subsequent batch POST is the
  // only array on the wire under test; session id comes from response headers.
  const params = {
    protocolVersion: specVersion,
    capabilities: {},
    clientInfo: CLIENT_INFO
  };
  const response = await request(serverUrl, {
    method: 'POST',
    headers: buildStandardHeaders('initialize', params, { specVersion }),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params
    })
  });

  const sessionId = response.headers['mcp-session-id'] as string | undefined;
  await response.body.text();

  if (!sessionId) {
    throw new Error('initialize did not return Mcp-Session-Id header');
  }

  return sessionId;
}

async function sendJsonRpcBatch(
  serverUrl: string,
  specVersion: SpecVersion,
  batch: unknown[],
  extraHeaders: Record<string, string> = {}
): Promise<{ statusCode: number; body: unknown }> {
  const first = batch[0] as {
    method: string;
    params?: Record<string, unknown>;
  };
  const response = await request(serverUrl, {
    method: 'POST',
    headers: buildStandardHeaders(first.method, first.params, {
      specVersion,
      headers: extraHeaders
    }),
    body: JSON.stringify(batch)
  });

  let body: unknown;
  try {
    body = await response.body.json();
  } catch {
    body = null;
  }

  return {
    statusCode: response.statusCode,
    body
  };
}

export class JsonRpcBatchRejectionScenario implements ClientScenario {
  name = 'json-rpc-batch-rejection';
  readonly source = { introducedIn: '2025-06-18' } as const;
  description = `Test that the server rejects JSON-RPC batch requests.

**Scope:** From 2025-06-18 onward, Streamable HTTP POST bodies **MUST** be a single JSON-RPC message (not a JSON array).

**Requirements:**
- Per [transports#sending-messages-to-the-server](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#sending-messages-to-the-server): the POST body **MUST** be a single JSON-RPC _request_, _notification_, or _response_; a JSON array **MUST** be rejected (HTTP \`4xx\`, commonly \`400\` with a JSON-RPC error)`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const { serverUrl, specVersion } = ctx;
    const timestamp = new Date().toISOString();
    const checkBase = {
      id: 'json-rpc-batch-rejected',
      name: 'JsonRpcBatchRejected',
      description:
        'POST body MUST be a single JSON-RPC message; batch arrays MUST be rejected',
      timestamp,
      specReferences: SPEC_REFERENCES
    };

    try {
      const batch =
        specVersion === DRAFT_PROTOCOL_VERSION
          ? buildStatelessBatch(specVersion)
          : buildStatefulBatch();

      const extraHeaders: Record<string, string> = {};
      if (specVersion !== DRAFT_PROTOCOL_VERSION) {
        extraHeaders['Mcp-Session-Id'] = await establishStatefulSession(
          serverUrl,
          specVersion
        );
      }

      const response = await sendJsonRpcBatch(
        serverUrl,
        specVersion,
        batch,
        extraHeaders
      );
      const errorCode = jsonRpcErrorCode(response.body);
      const accepted = isBatchAccepted(response.statusCode, response.body);
      const rejected = isBatchRejected(response.statusCode, response.body);
      const details = {
        statusCode: response.statusCode,
        errorCode,
        body: response.body,
        batchSize: batch.length,
        lifecycle:
          specVersion === DRAFT_PROTOCOL_VERSION ? 'stateless' : 'stateful'
      };

      if (accepted) {
        return [
          {
            ...checkBase,
            status: 'FAILURE',
            errorMessage:
              'Server accepted a JSON-RPC batch array; batch requests are not supported from 2025-06-18 onward',
            details
          }
        ];
      }

      if (rejected) {
        return [
          {
            ...checkBase,
            status: 'SUCCESS',
            details
          }
        ];
      }

      return [
        {
          ...checkBase,
          status: 'FAILURE',
          errorMessage:
            'Server did not reject the batch with an HTTP 4xx JSON-RPC error response',
          details
        }
      ];
    } catch (error) {
      return [
        {
          ...checkBase,
          status: 'FAILURE',
          errorMessage: `Request failed: ${error instanceof Error ? error.message : String(error)}`
        }
      ];
    }
  }
}
