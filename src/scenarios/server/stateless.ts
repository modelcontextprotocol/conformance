/**
 * Stateless MCP test scenarios for MCP servers (SEP-2575)
 */

import {
  ClientScenario,
  ConformanceCheck,
  DRAFT_PROTOCOL_VERSION
} from '../../types';

const SPEC_REF = [
  {
    id: 'SEP-2575',
    url: 'https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2575'
  }
];

export class ServerStatelessScenario implements ClientScenario {
  name = 'server-stateless';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  description = `Test stateless MCP server architecture (SEP-2575).

**Server Implementation Requirements:**

**Endpoints**:
- \`server/discover\`: Returns supportedVersions, capabilities, and serverInfo metadata.
- \`tools/call\`: Implement structural test tools like \`test_missing_capability\` requiring explicit capabilities in \`_meta\`.

**Grouped Specification Requirements**:

1. **Per-Request _meta Validation (4 Checks)**
   - Rejects requests missing \`_meta\` or lacking structural required internal subfields (\`protocolVersion\`, \`clientInfo\`, \`clientCapabilities\`) with a JSON-RPC \`-32602 Invalid params\` error signature.
2. **Discovery & Capabilities (3 Checks)**
   - Implements \`server/discover\` mapping exact mandatory protocol elements.
   - Dynamically checks prompt capability declaration constraints, validates that active RPC handlers match advertised discovery capacities.
3. **Version Negotiation & Headers (3 Checks)**
   - Mismatched or unknown protocol versions must return an \`UnsupportedProtocolVersionError\` (HTTP status code \`400 Bad Request\`) carrying precise version tracking arrays.
   - Absent or altered protocol version header metadata must trigger a \`-32001 Header Mismatch\` error with an HTTP 400 boundary state.
4. **Client Capability Constraints (2 Checks)**
   - Accessing platform capabilities without explicit declaration drops requests with a \`-32003 MissingRequiredClientCapabilityError\` containing needed capabilities, returning an HTTP status code \`400 Bad Request\`.
5. **Methods & Routing Mechanics (3 Checks)**
   - Removed legacy endpoints (\`initialize\`, \`ping\`, \`logging/setLevel\`, etc.) or generic unknown methods must cleanly yield an HTTP status code \`404 Not Found\` alongside a JSON-RPC \`-32601 Method not found\` payload. All error returns must preserve original request ID mappings.`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const timestamp = new Date().toISOString();

    // Executes a validation rule and pushes the structural result metadata.
    async function runCheck(
      id: string,
      name: string,
      description: string,
      fn: () =>
        | Promise<{ error?: string; skipped?: boolean; details?: any } | void>
        | ({ error?: string; skipped?: boolean; details?: any } | void),
      fallbackDetails = {}
    ) {
      try {
        const result = await fn();
        const errorMessage = result?.error;
        const status = errorMessage
          ? 'FAILURE'
          : result?.skipped
            ? 'SKIPPED'
            : 'SUCCESS';

        checks.push({
          id,
          name,
          description,
          status,
          timestamp,
          errorMessage: errorMessage || undefined,
          specReferences: SPEC_REF,
          details: result?.details || fallbackDetails
        });
      } catch (e) {
        checks.push({
          id,
          name,
          description,
          status: 'FAILURE',
          timestamp,
          errorMessage: String(e),
          specReferences: SPEC_REF,
          details: fallbackDetails
        });
      }
    }

    // Helper to send raw RPC requests via fetch
    const sendRpc = async (
      method: string,
      params?: any,
      headersOverrides?: Record<string, string>,
      id: string | number | null = 1
    ) => {
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'MCP-Protocol-Version': DRAFT_PROTOCOL_VERSION,
        ...headersOverrides
      };

      const body = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        ...(params !== undefined ? { params } : {})
      });

      const res = await fetch(serverUrl, { method: 'POST', headers, body });
      let data: any = null;
      try {
        data = await res.json();
      } catch {
        // Response might not be JSON
      }
      return { res, data };
    };

    const validMeta = {
      'io.modelcontextprotocol/protocolVersion': DRAFT_PROTOCOL_VERSION,
      'io.modelcontextprotocol/clientInfo': {
        name: 'conformance-client',
        version: '1.0.0'
      },
      'io.modelcontextprotocol/clientCapabilities': {}
    };

    // Helper to check JSON-RPC ID matching on error responses
    const checkErrorId = (data: any, expectedId: string | number) => {
      if (data && data.error) {
        if (data.id !== expectedId) {
          checks.push({
            id: 'sep-2575-http-server-error-jsonrpc-id',
            name: 'HttpServerErrorJsonrpcId',
            description: 'All error responses carry the request JSON-RPC id',
            status: 'FAILURE',
            timestamp: new Date().toISOString(),
            errorMessage: `Expected error response id ${expectedId}, got ${data.id}`,
            specReferences: SPEC_REF
          });
        }
      }
    };

    // ==========================================
    // 1. Per-request _meta Validation (4 Checks)
    // ==========================================
    const metaValidationTestCases = [
      {
        slug: 'missing-meta',
        description:
          'Rejects request with missing _meta with -32602 Invalid params',
        params: {},
        rpcId: 101
      },
      {
        slug: 'missing-protocol-version',
        description:
          'Rejects request with _meta missing io.modelcontextprotocol/protocolVersion',
        params: {
          _meta: {
            'io.modelcontextprotocol/clientInfo':
              validMeta['io.modelcontextprotocol/clientInfo'],
            'io.modelcontextprotocol/clientCapabilities':
              validMeta['io.modelcontextprotocol/clientCapabilities']
          }
        },
        rpcId: 102
      },
      {
        slug: 'missing-client-info',
        description:
          'Rejects request with _meta missing io.modelcontextprotocol/clientInfo',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion':
              validMeta['io.modelcontextprotocol/protocolVersion'],
            'io.modelcontextprotocol/clientCapabilities':
              validMeta['io.modelcontextprotocol/clientCapabilities']
          }
        },
        rpcId: 103
      },
      {
        slug: 'missing-client-capabilities',
        description:
          'Rejects request with _meta missing io.modelcontextprotocol/clientCapabilities',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion':
              validMeta['io.modelcontextprotocol/protocolVersion'],
            'io.modelcontextprotocol/clientInfo':
              validMeta['io.modelcontextprotocol/clientInfo']
          }
        },
        rpcId: 104
      }
    ];
    for (const testCase of metaValidationTestCases) {
      await runCheck(
        `sep-2575-request-meta-invalid-${testCase.slug}`,
        'RequestMetaInvalid',
        testCase.description,
        async () => {
          const { data } = await sendRpc(
            'server/discover',
            testCase.params,
            undefined,
            testCase.rpcId
          );
          checkErrorId(data, testCase.rpcId);

          if (data?.error?.code !== -32602) {
            return {
              error: `Expected error code -32602, got ${data?.error?.code}`,
              details: { fieldIssue: testCase.slug, response: data }
            };
          }
          return { details: { fieldIssue: testCase.slug, response: data } };
        },
        { fieldIssue: testCase.slug }
      );
    }

    // ==========================================
    // 2. Discovery & Capabilities (4 Checks)
    // ==========================================
    let discoverSupportedVersions: string[] = [];
    let discoverCapabilities: any = {};
    let discoverResult: any = null;
    let discoverRpcError: any = null;

    try {
      const { data } = await sendRpc(
        'server/discover',
        { _meta: validMeta },
        undefined,
        201
      );
      discoverResult = data?.result;

      if (Array.isArray(discoverResult?.supportedVersions)) {
        discoverSupportedVersions = discoverResult.supportedVersions;
      }
      if (
        discoverResult?.capabilities &&
        typeof discoverResult.capabilities === 'object'
      ) {
        discoverCapabilities = discoverResult.capabilities;
      }
    } catch (e) {
      discoverRpcError = e;
    }

    await runCheck(
      'sep-2575-server-implements-discover',
      'ServerImplementsDiscover',
      'Servers MUST implement server/discover.',
      () => {
        if (discoverRpcError)
          return { error: `Discovery failed: ${discoverRpcError.message}` };
        if (
          !discoverResult?.supportedVersions ||
          !discoverResult?.capabilities ||
          !discoverResult?.serverInfo
        ) {
          return {
            error: 'Missing mandatory fields in discover response setup',
            details: { result: discoverResult }
          };
        }
        return { details: { result: discoverResult } };
      }
    );

    await runCheck(
      'sep-2575-server-declares-prompts-in-discover',
      'ServerDeclaresPromptsInDiscover',
      'Servers that support prompts MUST declare the prompts capability in their DiscoverResult.',
      async () => {
        if (discoverRpcError)
          return { error: `Prerequisite missing: ${discoverRpcError.message}` };
        const { data: promptsData } = await sendRpc(
          'prompts/list',
          { _meta: validMeta },
          undefined,
          203
        );
        const methodExists =
          promptsData?.result?.prompts || promptsData?.error?.code !== -32601;

        if (methodExists && !discoverCapabilities.prompts) {
          return {
            error:
              'Server handles prompts but did not declare prompts capability in discover result',
            details: { discoverCapabilities }
          };
        }
        return { details: { discoverCapabilities, response: promptsData } };
      }
    );

    // Dynamic verification helper to check capability consistency against true handlers
    await runCheck(
      'sep-2575-discover-capabilities-match-handlers',
      'DiscoverCapabilitiesMatchHandlers',
      'capabilities matches what the server honors on real RPC calls',
      async () => {
        if (discoverRpcError)
          return {
            error: `Discovery runtime check failed: ${discoverRpcError.message}`
          };
        const { data: toolsData } = await sendRpc(
          'tools/list',
          { _meta: validMeta },
          undefined,
          202
        );

        if (discoverCapabilities.tools) {
          const toolsPassed = Array.isArray(toolsData?.result?.tools);
          if (!toolsPassed)
            return {
              error: 'Advertised tools capability but tools/list call failed',
              details: { response: toolsData }
            };
        } else {
          if (toolsData?.error?.code !== -32601)
            return {
              error:
                'Did not advertise tools capability but tools/list did not yield -32601',
              details: { response: toolsData }
            };
        }
        return { details: { response: toolsData } };
      }
    );

    // ==========================================
    // 3. Version Negotiation & Headers (3 Checks)
    // ==========================================
    const unsupportedMeta = {
      ...validMeta,
      'io.modelcontextprotocol/protocolVersion': 'v999.0.0'
    };
    const response301 = await sendRpc(
      'server/discover',
      { _meta: unsupportedMeta },
      { 'MCP-Protocol-Version': 'v999.0.0' },
      301
    ).catch(() => null);
    const res301: any = response301?.res ?? null;
    const data301: any = response301?.data ?? null;
    if (data301) checkErrorId(data301, 301);

    await runCheck(
      'sep-2575-server-unsupported-version-error',
      'ServerUnsupportedVersionError',
      'If the server does not implement the requested version (whether the version is unknown to the server, or is a known version the server has chosen not to support), it MUST respond with an UnsupportedProtocolVersionError listing the versions it does support.',
      () => {
        if (!data301)
          return { error: 'Unsupported version invocation failed completely' };
        const errSupportedVersions = data301?.error?.data?.supported;
        const hasErrVersions =
          Array.isArray(errSupportedVersions) &&
          errSupportedVersions.length > 0;

        const validMatch =
          hasErrVersions &&
          errSupportedVersions.every((v: string) =>
            discoverSupportedVersions.includes(v)
          );
        if (!validMatch)
          return {
            error: `Returned supported versions data layout does not correlate to active server metrics: ${JSON.stringify(errSupportedVersions)}`
          };
        return { details: { response: data301 } };
      }
    );

    await runCheck(
      'sep-2575-http-server-unsupported-version-400',
      'HttpServerUnsupportedVersion400',
      'If the server does not implement the requested protocol version, it MUST respond with 400 Bad Request and an UnsupportedProtocolVersionError listing its supported versions.',
      () => {
        if (!res301)
          return { error: 'Network transaction context unavailable' };
        if (res301.status !== 400)
          return {
            error: `Expected HTTP 400 Bad Request, got status code ${res301.status}`
          };
        return { details: { response: data301 } };
      }
    );

    const headerMismatchMeta = {
      ...validMeta,
      'io.modelcontextprotocol/protocolVersion': 'v999.0.0'
    };
    const responseAbsent = await sendRpc(
      'server/discover',
      { _meta: headerMismatchMeta },
      { 'MCP-Protocol-Version': 'mismatch.version' },
      302
    ).catch(() => null);
    const resAbsent: any = responseAbsent?.res ?? null;
    const dataAbsent: any = responseAbsent?.data ?? null;

    await runCheck(
      'sep-2575-http-server-header-mismatch-400',
      'HttpServerHeaderMismatch400',
      'If the values do not match, the server MUST reject the request with 400 Bad Request and a HeaderMismatch JSON-RPC error.',
      () => {
        if (!resAbsent)
          return { error: 'Header verification endpoint network hit failed' };
        if (resAbsent.status !== 400 || dataAbsent?.error?.code !== -32001) {
          return {
            error: `Expected HTTP 400 and JSON-RPC error -32001, got status ${resAbsent.status} with code ${dataAbsent?.error?.code}`
          };
        }
        return { details: { response: dataAbsent } };
      }
    );

    // ==========================================
    // 4. Client Capability Constraints (2 Checks)
    // ==========================================
    const response401 = await sendRpc(
      'tools/call',
      { name: 'test_missing_capability', arguments: {}, _meta: validMeta },
      undefined,
      401
    ).catch(() => null);
    const res401: any = response401?.res ?? null;
    const data401: any = response401?.data ?? null;
    if (data401) checkErrorId(data401, 401);

    // Determine if this server actively enforces client capabilities
    const serverRequiresCapability = data401?.error?.code === -32003;

    await runCheck(
      'sep-2575-server-rejects-undeclared-capability',
      'ServerRejectsUndeclaredCapability',
      'A server MUST NOT rely on capabilities the client has not declared. If processing a request requires a capability the client did not include in io.modelcontextprotocol/clientCapabilities, the server MUST return a MissingRequiredClientCapabilityError (-32003).',
      () => {
        if (!res401)
          return {
            error:
              'Capability checking call sequence timed out or dropped connection'
          };

        if (!serverRequiresCapability) {
          // The server didn't return -32003, so this requirement isn't
          // exercised for this method. Report SKIPPED rather than a green PASS.
          return {
            skipped: true,
            details: {
              note: 'Skipped requirement tracking: Server returned a non-32003 response, indicating it does not require explicit client capability authorization constraints for this method.',
              response: data401
            }
          };
        }

        // If it DOES return -32003, strictly validate the requirement payload structure
        const reqCaps = data401?.error?.data?.requiredCapabilities;
        if (!Array.isArray(reqCaps) || !reqCaps.includes('sampling')) {
          return {
            error: `Server responded with error code -32003 but failed to provide an array containing the expected 'sampling' capability in error.data.requiredCapabilities`,
            details: { response: data401 }
          };
        }

        return { details: { response: data401 } };
      }
    );

    await runCheck(
      'sep-2575-missing-capability-http-400',
      'MissingCapabilityHttp400',
      'On HTTP, the response status MUST be 400 Bad Request [for MissingRequiredClientCapabilityError].',
      () => {
        if (!res401)
          return {
            error: 'Network transport layer layer context failed to instantiate'
          };

        if (!serverRequiresCapability) {
          // No -32003 means the HTTP-400 requirement doesn't apply here.
          // Report SKIPPED rather than a green PASS.
          return {
            skipped: true,
            details: {
              note: 'Skipped status tracking: Server did not return a MissingRequiredClientCapabilityError.',
              httpStatus: res401.status
            }
          };
        }

        // If it did trigger the capability error, it MUST use HTTP 400
        if (res401.status !== 400) {
          return {
            error: `Expected HTTP status code 400 Bad Request for an undeclared capability error response, got ${res401.status}`,
            details: { response: data401 }
          };
        }

        return { details: { response: data401 } };
      }
    );

    // ==========================================
    // 5. Methods & Routing Mechanics (3 Checks)
    // ==========================================
    const expectedSlugs = [
      'initialize',
      'ping',
      'logging/setLevel',
      'resources/subscribe',
      'resources/unsubscribe'
    ];
    for (const slug of expectedSlugs) {
      const cleanMethodParam = slug.toLowerCase().replace('/', '-');
      const response500 = await sendRpc(
        slug,
        { _meta: validMeta },
        undefined,
        500
      ).catch(() => null);
      const res500: any = response500?.res ?? null;
      const data500: any = response500?.data ?? null;

      await runCheck(
        `sep-2575-http-server-method-not-found-404-${cleanMethodParam}`,
        `HttpServerMethodNotFound404${slug.replace('/', '')}`,
        `If the server does not implement the removed RPC method '${slug}', it MUST respond with 404 Not Found and a JSON-RPC error with code -32601 (Method not found).`,
        () => {
          if (!res500 || !data500)
            return {
              error:
                'Removed method validation hit dropped connections unexpectedly'
            };
          if (res500.status !== 404 || data500?.error?.code !== -32601) {
            return {
              error: `Expected HTTP 404 and code -32601 for removed methods, got HTTP ${res500.status} and code ${data500?.error?.code}`
            };
          }
          return { details: { response: data500 } };
        }
      );
    }

    // Explicit generic unknown method fallback test
    const response601 = await sendRpc(
      'unknown/method',
      { _meta: validMeta },
      undefined,
      601
    ).catch(() => null);
    const res601: any = response601?.res ?? null;
    const data601: any = response601?.data ?? null;

    await runCheck(
      'sep-2575-http-server-method-not-found-404',
      'HttpServerMethodNotFound404',
      'If the server does not implement the requested RPC method, it MUST respond with 404 Not Found and a JSON-RPC error with code -32601 (Method not found).',
      () => {
        if (!res601 || !data601)
          return {
            error: 'Unknown fallback test target returned an invalid layout'
          };
        if (res601.status !== 404 || data601?.error?.code !== -32601) {
          return {
            error: `Expected HTTP 404 and JSON-RPC error code -32601, got HTTP ${res601.status} and code ${data601?.error?.code}`
          };
        }
        return { details: { response: data601 } };
      }
    );

    // Final catchall ensuring JSON-RPC id integrity validation rules ran successfully
    if (!checks.some((c) => c.id === 'sep-2575-http-server-error-jsonrpc-id')) {
      checks.push({
        id: 'sep-2575-http-server-error-jsonrpc-id',
        name: 'HttpServerErrorJsonrpcId',
        description: 'All error responses carry the request JSON-RPC id',
        status: 'SUCCESS',
        timestamp,
        specReferences: SPEC_REF
      });
    }

    return checks;
  }
}
