/**
 * Stateless MCP test scenarios for MCP servers (SEP-2575)
 */

import {
  ClientScenario,
  ConformanceCheck,
  SpecVersion,
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
  specVersions: SpecVersion[] = [DRAFT_PROTOCOL_VERSION];
  description = `Test stateless MCP server architecture (SEP-2575).

**Server Implementation Requirements:**

**Endpoints**:
- \`server/discover\`: Returns supportedVersions, capabilities, and serverInfo.
- \`tools/call\`: Implement tool \`test_missing_capability\` requiring \`sampling\` capability in \`_meta\`.

**Requirements**:
1. **Per-request _meta**: Rejects requests missing \`_meta\` or its required subfields (\`io.modelcontextprotocol/protocolVersion\`, \`io.modelcontextprotocol/clientInfo\`, \`io.modelcontextprotocol/clientCapabilities\`) with -32602 Invalid params.
2. **server/discover**: Returns valid discovery metadata matching real RPC capabilities.
3. **Version negotiation**: For unsupported versions, returns UnsupportedProtocolVersionError (HTTP 400, non-empty supportedVersions matching discover). Validates \`MCP-Protocol-Version\` header.
4. **Errors**: MissingRequiredClientCapabilityError (-32003, HTTP 400) lists missing capabilities. All error responses carry matching JSON-RPC id.
5. **Removed RPCs**: Rejects \`initialize\`, \`ping\`, \`logging/setLevel\`, \`resources/subscribe\`, \`resources/unsubscribe\` with -32601.
6. **HTTP transport**: Unknown methods return HTTP 404 + JSON-RPC -32601.`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const timestamp = new Date().toISOString();

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
            id: 'stateless-error-jsonrpc-id',
            name: 'StatelessErrorJsonrpcId',
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
    // 1. Per-request _meta
    // ==========================================

    // Missing _meta -> -32602
    try {
      const { data } = await sendRpc('server/discover', {}, undefined, 101);
      checkErrorId(data, 101);
      const passed = data?.error?.code === -32602;
      checks.push({
        id: 'stateless-meta-missing',
        name: 'StatelessMetaMissing',
        description:
          'Rejects request with missing _meta with -32602 Invalid params',
        status: passed ? 'SUCCESS' : 'FAILURE',
        timestamp,
        errorMessage: passed
          ? undefined
          : `Expected error code -32602, got ${data?.error?.code}`,
        specReferences: SPEC_REF,
        details: { response: data }
      });
    } catch (e) {
      checks.push({
        id: 'stateless-meta-missing',
        name: 'StatelessMetaMissing',
        description:
          'Rejects request with missing _meta with -32602 Invalid params',
        status: 'FAILURE',
        timestamp,
        errorMessage: String(e),
        specReferences: SPEC_REF
      });
    }

    // Missing protocolVersion -> -32602
    try {
      const { data } = await sendRpc(
        'server/discover',
        {
          _meta: {
            'io.modelcontextprotocol/clientInfo':
              validMeta['io.modelcontextprotocol/clientInfo'],
            'io.modelcontextprotocol/clientCapabilities':
              validMeta['io.modelcontextprotocol/clientCapabilities']
          }
        },
        undefined,
        102
      );
      checkErrorId(data, 102);
      const passed = data?.error?.code === -32602;
      checks.push({
        id: 'stateless-meta-missing-protocol-version',
        name: 'StatelessMetaMissingProtocolVersion',
        description:
          'Rejects request with _meta missing io.modelcontextprotocol/protocolVersion',
        status: passed ? 'SUCCESS' : 'FAILURE',
        timestamp,
        errorMessage: passed
          ? undefined
          : `Expected error code -32602, got ${data?.error?.code}`,
        specReferences: SPEC_REF,
        details: { response: data }
      });
    } catch (e) {
      checks.push({
        id: 'stateless-meta-missing-protocol-version',
        name: 'StatelessMetaMissingProtocolVersion',
        description:
          'Rejects request with _meta missing io.modelcontextprotocol/protocolVersion',
        status: 'FAILURE',
        timestamp,
        errorMessage: String(e),
        specReferences: SPEC_REF
      });
    }

    // Missing clientInfo -> -32602
    try {
      const { data } = await sendRpc(
        'server/discover',
        {
          _meta: {
            'io.modelcontextprotocol/protocolVersion':
              validMeta['io.modelcontextprotocol/protocolVersion'],
            'io.modelcontextprotocol/clientCapabilities':
              validMeta['io.modelcontextprotocol/clientCapabilities']
          }
        },
        undefined,
        103
      );
      checkErrorId(data, 103);
      const passed = data?.error?.code === -32602;
      checks.push({
        id: 'stateless-meta-missing-client-info',
        name: 'StatelessMetaMissingClientInfo',
        description:
          'Rejects request with _meta missing io.modelcontextprotocol/clientInfo',
        status: passed ? 'SUCCESS' : 'FAILURE',
        timestamp,
        errorMessage: passed
          ? undefined
          : `Expected error code -32602, got ${data?.error?.code}`,
        specReferences: SPEC_REF,
        details: { response: data }
      });
    } catch (e) {
      checks.push({
        id: 'stateless-meta-missing-client-info',
        name: 'StatelessMetaMissingClientInfo',
        description:
          'Rejects request with _meta missing io.modelcontextprotocol/clientInfo',
        status: 'FAILURE',
        timestamp,
        errorMessage: String(e),
        specReferences: SPEC_REF
      });
    }

    // Missing clientCapabilities -> -32602
    try {
      const { data } = await sendRpc(
        'server/discover',
        {
          _meta: {
            'io.modelcontextprotocol/protocolVersion':
              validMeta['io.modelcontextprotocol/protocolVersion'],
            'io.modelcontextprotocol/clientInfo':
              validMeta['io.modelcontextprotocol/clientInfo']
          }
        },
        undefined,
        104
      );
      checkErrorId(data, 104);
      const passed = data?.error?.code === -32602;
      checks.push({
        id: 'stateless-meta-missing-client-capabilities',
        name: 'StatelessMetaMissingClientCapabilities',
        description:
          'Rejects request with _meta missing io.modelcontextprotocol/clientCapabilities',
        status: passed ? 'SUCCESS' : 'FAILURE',
        timestamp,
        errorMessage: passed
          ? undefined
          : `Expected error code -32602, got ${data?.error?.code}`,
        specReferences: SPEC_REF,
        details: { response: data }
      });
    } catch (e) {
      checks.push({
        id: 'stateless-meta-missing-client-capabilities',
        name: 'StatelessMetaMissingClientCapabilities',
        description:
          'Rejects request with _meta missing io.modelcontextprotocol/clientCapabilities',
        status: 'FAILURE',
        timestamp,
        errorMessage: String(e),
        specReferences: SPEC_REF
      });
    }

    // ==========================================
    // 2. server/discover
    // ==========================================

    let discoverSupportedVersions: string[] = [];
    let discoverCapabilities: any = {};

    try {
      const { data } = await sendRpc(
        'server/discover',
        { _meta: validMeta },
        undefined,
        201
      );

      const resResult = data?.result;
      const hasSupportedVersions =
        Array.isArray(resResult?.supportedVersions) &&
        resResult.supportedVersions.length > 0;
      const hasCapabilities =
        resResult?.capabilities && typeof resResult.capabilities === 'object';
      const hasServerInfo =
        resResult?.serverInfo && typeof resResult.serverInfo === 'object';

      const passed = hasSupportedVersions && hasCapabilities && hasServerInfo;

      if (hasSupportedVersions)
        discoverSupportedVersions = resResult.supportedVersions;
      if (hasCapabilities) discoverCapabilities = resResult.capabilities;

      checks.push({
        id: 'stateless-discover-response',
        name: 'StatelessDiscoverResponse',
        description:
          'Responds to server/discover with supportedVersions, capabilities, serverInfo',
        status: passed ? 'SUCCESS' : 'FAILURE',
        timestamp,
        errorMessage: passed ? undefined : 'Missing required discovery fields',
        specReferences: SPEC_REF,
        details: { result: resResult }
      });

      // Check capabilities matching real RPC calls
      if (discoverCapabilities.tools) {
        const { data: toolsData } = await sendRpc(
          'tools/list',
          { _meta: validMeta },
          undefined,
          202
        );
        const toolsPassed =
          toolsData?.result?.tools && Array.isArray(toolsData.result.tools);
        checks.push({
          id: 'stateless-discover-capabilities-match',
          name: 'StatelessDiscoverCapabilitiesMatch',
          description:
            'capabilities matches what the server honors on real RPC calls',
          status: toolsPassed ? 'SUCCESS' : 'FAILURE',
          timestamp,
          errorMessage: toolsPassed
            ? undefined
            : 'Advertised tools capability but tools/list failed',
          specReferences: SPEC_REF
        });
      } else {
        const { data: toolsData } = await sendRpc(
          'tools/list',
          { _meta: validMeta },
          undefined,
          202
        );
        const toolsPassed = toolsData?.error?.code === -32601;
        checks.push({
          id: 'stateless-discover-capabilities-match',
          name: 'StatelessDiscoverCapabilitiesMatch',
          description:
            'capabilities matches what the server honors on real RPC calls',
          status: toolsPassed ? 'SUCCESS' : 'FAILURE',
          timestamp,
          errorMessage: toolsPassed
            ? undefined
            : 'Did not advertise tools capability but tools/list did not return -32601',
          specReferences: SPEC_REF
        });
      }
    } catch (e) {
      checks.push({
        id: 'stateless-discover-response',
        name: 'StatelessDiscoverResponse',
        description:
          'Responds to server/discover with supportedVersions, capabilities, serverInfo',
        status: 'FAILURE',
        timestamp,
        errorMessage: String(e),
        specReferences: SPEC_REF
      });
      checks.push({
        id: 'stateless-version-response-header',
        name: 'StatelessVersionResponseHeader',
        description:
          'Returns MCP-Protocol-Version header on responses matching request protocolVersion',
        status: 'FAILURE',
        timestamp,
        errorMessage: String(e),
        specReferences: SPEC_REF
      });
      checks.push({
        id: 'stateless-discover-capabilities-match',
        name: 'StatelessDiscoverCapabilitiesMatch',
        description:
          'capabilities matches what the server honors on real RPC calls',
        status: 'FAILURE',
        timestamp,
        errorMessage: String(e),
        specReferences: SPEC_REF
      });
    }

    // ==========================================
    // 3. Version negotiation
    // ==========================================

    const unsupportedMeta = {
      ...validMeta,
      'io.modelcontextprotocol/protocolVersion': 'v999.0.0'
    };

    // Send unsupported version on server/discover
    try {
      const { res, data } = await sendRpc(
        'server/discover',
        { _meta: unsupportedMeta },
        { 'MCP-Protocol-Version': 'v999.0.0' },
        301
      );
      checkErrorId(data, 301);

      const isHttp400 = res.status === 400;
      const isInvalidParams = data?.error && data.error.code == -32602;

      const errSupportedVersions = data?.error?.data?.supported;
      const hasErrVersions =
        Array.isArray(errSupportedVersions) && errSupportedVersions.length > 0;

      // No drift check
      const noDrift =
        hasErrVersions &&
        discoverSupportedVersions.length > 0 &&
        errSupportedVersions.length === discoverSupportedVersions.length &&
        errSupportedVersions.every(
          (v, i) => v === discoverSupportedVersions[i]
        );

      checks.push({
        id: 'stateless-version-http-400',
        name: 'StatelessVersionHttp400',
        description:
          'UnsupportedProtocolVersionError returns HTTP 400 Bad Request',
        status: isHttp400 ? 'SUCCESS' : 'FAILURE',
        timestamp,
        errorMessage: isHttp400
          ? undefined
          : `Expected HTTP 400, got ${res.status}`,
        specReferences: SPEC_REF
      });

      checks.push({
        id: 'stateless-version-unsupported',
        name: 'StatelessVersionUnsupported',
        description:
          'Returns UnsupportedProtocolVersionError (with Invalid params)',
        status: isInvalidParams ? 'SUCCESS' : 'FAILURE',
        timestamp,
        errorMessage: isInvalidParams
          ? undefined
          : `Expected custom error code, got ${data?.error?.code}`,
        specReferences: SPEC_REF
      });

      checks.push({
        id: 'stateless-version-supported-versions-match',
        name: 'StatelessVersionSupportedVersionsMatch',
        description:
          'UnsupportedProtocolVersionError carries data.supported matching server/discover',
        status: noDrift ? 'SUCCESS' : 'FAILURE',
        timestamp,
        errorMessage: noDrift
          ? undefined
          : `Version drift detected or missing versions: ${JSON.stringify(errSupportedVersions)} vs ${JSON.stringify(discoverSupportedVersions)}`,
        specReferences: SPEC_REF
      });

      checks.push({
        id: 'stateless-version-discover-unsupported',
        name: 'StatelessVersionDiscoverUnsupported',
        description:
          'Returns UnsupportedProtocolVersionError even on server/discover request',
        status:
          isHttp400 && isInvalidParams && hasErrVersions
            ? 'SUCCESS'
            : 'FAILURE',
        timestamp,
        errorMessage:
          isHttp400 && isInvalidParams && hasErrVersions
            ? undefined
            : 'Failed to return full error on discover endpoint',
        specReferences: SPEC_REF
      });
    } catch (e) {
      checks.push({
        id: 'stateless-version-http-400',
        name: 'StatelessVersionHttp400',
        description:
          'UnsupportedProtocolVersionError returns HTTP 400 Bad Request',
        status: 'FAILURE',
        timestamp,
        errorMessage: String(e),
        specReferences: SPEC_REF
      });
      checks.push({
        id: 'stateless-version-unsupported',
        name: 'StatelessVersionUnsupported',
        description:
          'Returns UnsupportedProtocolVersionError (not Invalid params)',
        status: 'FAILURE',
        timestamp,
        errorMessage: String(e),
        specReferences: SPEC_REF
      });
      checks.push({
        id: 'stateless-version-supported-versions-match',
        name: 'StatelessVersionSupportedVersionsMatch',
        description:
          'UnsupportedProtocolVersionError carries data.supported matching server/discover',
        status: 'FAILURE',
        timestamp,
        errorMessage: String(e),
        specReferences: SPEC_REF
      });
      checks.push({
        id: 'stateless-version-discover-unsupported',
        name: 'StatelessVersionDiscoverUnsupported',
        description:
          'Returns UnsupportedProtocolVersionError even on server/discover request',
        status: 'FAILURE',
        timestamp,
        errorMessage: String(e),
        specReferences: SPEC_REF
      });
    }

    // Header mismatch / absent header
    try {
      // Omit MCP-Protocol-Version header
      const { res } = await sendRpc(
        'server/discover',
        { _meta: validMeta },
        { 'MCP-Protocol-Version': '' },
        302
      );
      const passedAbsent = res.status === 400;

      // Mismatch header
      const { res: resMismatch } = await sendRpc(
        'server/discover',
        { _meta: validMeta },
        { 'MCP-Protocol-Version': 'v999.0' },
        303
      );
      const passedMismatch = resMismatch.status === 400;

      const overallPassed = passedAbsent && passedMismatch;
      checks.push({
        id: 'stateless-version-header-mismatch',
        name: 'StatelessVersionHeaderMismatch',
        description:
          'Rejects request when MCP-Protocol-Version header is absent or does not match _meta.protocolVersion',
        status: overallPassed ? 'SUCCESS' : 'FAILURE',
        timestamp,
        errorMessage: overallPassed
          ? undefined
          : `Failed header check: absent=HTTP ${res.status}, mismatch=HTTP ${resMismatch.status}`,
        specReferences: SPEC_REF
      });
    } catch (e) {
      checks.push({
        id: 'stateless-version-header-mismatch',
        name: 'StatelessVersionHeaderMismatch',
        description:
          'Rejects request when MCP-Protocol-Version header is absent or does not match _meta.protocolVersion',
        status: 'FAILURE',
        timestamp,
        errorMessage: String(e),
        specReferences: SPEC_REF
      });
    }

    // ==========================================
    // 4. Errors & HTTP 400 for capability
    // ==========================================

    try {
      const { res, data } = await sendRpc(
        'tools/call',
        {
          name: 'test_missing_capability',
          arguments: {},
          _meta: validMeta
        },
        undefined,
        401
      );
      checkErrorId(data, 401);

      const isHttp400 = res.status === 400;
      const isCode32003 = data?.error?.code === -32003;
      const reqCaps = data?.error?.data?.requiredCapabilities;
      const carriesCaps =
        Array.isArray(reqCaps) && reqCaps.includes('sampling');

      checks.push({
        id: 'stateless-error-missing-capability',
        name: 'StatelessErrorMissingCapability',
        description:
          'MissingRequiredClientCapabilityError (-32003) carries data.requiredCapabilities for servers that wants a required client capability',
        status: isCode32003 && carriesCaps ? 'SUCCESS' : 'WARNING',
        timestamp,
        errorMessage:
          isCode32003 && carriesCaps
            ? undefined
            : `Expected code -32003 with sampling requiredCapabilities, got code ${data?.error?.code}, data: ${JSON.stringify(data?.error?.data)}`,
        specReferences: SPEC_REF
      });

      checks.push({
        id: 'stateless-http-missing-capability',
        name: 'StatelessHttpMissingCapability',
        description:
          'MissingRequiredClientCapabilityError returns HTTP 400 Bad Request for servers that wants a required client capability',
        status: isHttp400 ? 'SUCCESS' : 'WARNING',
        timestamp,
        errorMessage: isHttp400
          ? undefined
          : `Expected HTTP 400, got ${res.status}`,
        specReferences: SPEC_REF
      });
    } catch (e) {
      checks.push({
        id: 'stateless-error-missing-capability',
        name: 'StatelessErrorMissingCapability',
        description:
          'MissingRequiredClientCapabilityError (-32003) carries data.requiredCapabilities for servers that wants a required client capability',
        status: 'WARNING',
        timestamp,
        errorMessage: String(e),
        specReferences: SPEC_REF
      });
      checks.push({
        id: 'stateless-http-missing-capability',
        name: 'StatelessHttpMissingCapability',
        description:
          'MissingRequiredClientCapabilityError returns HTTP 400 Bad Request for servers that wants a required client capability',
        status: 'WARNING',
        timestamp,
        errorMessage: String(e),
        specReferences: SPEC_REF
      });
    }

    // Push the check for JSON-RPC ID matching across all error responses
    // If no failure was recorded by checkErrorId, record success
    if (!checks.some((c) => c.id === 'stateless-error-jsonrpc-id')) {
      checks.push({
        id: 'stateless-error-jsonrpc-id',
        name: 'StatelessErrorJsonrpcId',
        description: 'All error responses carry the request JSON-RPC id',
        status: 'SUCCESS',
        timestamp,
        specReferences: SPEC_REF
      });
    }

    // ==========================================
    // 5. Removed RPCs
    // ==========================================

    const removedRpcs = [
      {
        method: 'initialize',
        id: 'stateless-removed-initialize',
        name: 'StatelessRemovedInitialize'
      },
      {
        method: 'ping',
        id: 'stateless-removed-ping',
        name: 'StatelessRemovedPing'
      },
      {
        method: 'logging/setLevel',
        id: 'stateless-removed-logging-set-level',
        name: 'StatelessRemovedLoggingSetLevel'
      },
      {
        method: 'resources/subscribe',
        id: 'stateless-removed-resources-subscribe',
        name: 'StatelessRemovedResourcesSubscribe'
      },
      {
        method: 'resources/unsubscribe',
        id: 'stateless-removed-resources-unsubscribe',
        name: 'StatelessRemovedResourcesUnsubscribe'
      }
    ];

    for (const rpc of removedRpcs) {
      try {
        const { data } = await sendRpc(
          rpc.method,
          { _meta: validMeta },
          undefined,
          500
        );
        const passed = data?.error?.code === -32601;
        checks.push({
          id: rpc.id,
          name: rpc.name,
          description: `Removed RPC ${rpc.method} returns -32601 Method not found`,
          status: passed ? 'SUCCESS' : 'FAILURE',
          timestamp,
          errorMessage: passed
            ? undefined
            : `Expected code -32601, got ${data?.error?.code}`,
          specReferences: SPEC_REF
        });
      } catch (e) {
        checks.push({
          id: rpc.id,
          name: rpc.name,
          description: `Removed RPC ${rpc.method} returns -32601 Method not found`,
          status: 'FAILURE',
          timestamp,
          errorMessage: String(e),
          specReferences: SPEC_REF
        });
      }
    }

    // ==========================================
    // 6. HTTP transport - unknown method
    // ==========================================

    try {
      const { res, data } = await sendRpc(
        'unknown/method',
        { _meta: validMeta },
        undefined,
        601
      );
      const passed = res.status === 404 && data?.error?.code === -32601;
      checks.push({
        id: 'stateless-http-unknown-method',
        name: 'StatelessHttpUnknownMethod',
        description:
          'Unknown method returns HTTP 404 Not Found and JSON-RPC -32601',
        status: passed ? 'SUCCESS' : 'FAILURE',
        timestamp,
        errorMessage: passed
          ? undefined
          : `Expected HTTP 404 and code -32601, got HTTP ${res.status} and code ${data?.error?.code}`,
        specReferences: SPEC_REF
      });
    } catch (e) {
      checks.push({
        id: 'stateless-http-unknown-method',
        name: 'StatelessHttpUnknownMethod',
        description:
          'Unknown method returns HTTP 404 Not Found and JSON-RPC -32601',
        status: 'FAILURE',
        timestamp,
        errorMessage: String(e),
        specReferences: SPEC_REF
      });
    }

    return checks;
  }
}
