/**
 * Stateless MCP test scenarios for MCP servers (SEP-2575)
 */

import {
  ClientScenario,
  ConformanceCheck,
  DRAFT_PROTOCOL_VERSION
} from '../../types';
import {
  buildStandardHeaders,
  readSseJsonRpcResponse,
  type RunContext
} from '../../connection';

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

1. **Per-Request _meta Validation (5 Checks)**
   - Rejects requests missing \`_meta\` or lacking structural required internal subfields (\`protocolVersion\`, \`clientInfo\`, \`clientCapabilities\`) with a JSON-RPC \`-32602 Invalid params\` error signature and an HTTP status code \`400 Bad Request\`.
2. **Discovery & Capabilities (3 Checks)**
   - Implements \`server/discover\` mapping exact mandatory protocol elements.
   - Dynamically checks prompt capability declaration constraints, validates that active RPC handlers match advertised discovery capacities.
3. **Version Negotiation & Headers (3 Checks)**
   - Mismatched or unknown protocol versions must return an \`UnsupportedProtocolVersionError\` (HTTP status code \`400 Bad Request\`) carrying precise version tracking arrays.
   - Absent or altered protocol version header metadata must trigger a \`-32001 Header Mismatch\` error with an HTTP 400 boundary state.
4. **Client Capability Constraints (2 Checks)**
   - Accessing platform capabilities without explicit declaration drops requests with a \`-32003 MissingRequiredClientCapabilityError\` containing needed capabilities, returning an HTTP status code \`400 Bad Request\`.
5. **Methods & Routing Mechanics (5 Checks)**
   - Removed legacy endpoints (\`initialize\`, \`ping\`, \`logging/setLevel\`, etc.) or generic unknown methods must cleanly yield an HTTP status code \`404 Not Found\` alongside a JSON-RPC \`-32601 Method not found\` payload. All error returns must preserve original request ID mappings.
   - Validates response streams contain only \`IncompleteResult\` chunks and never independent top-level JSON-RPC requests, while enforcing that no log messages are emitted when \`_meta.../logLevel\` is omitted.
6. **Subscription Streams & Filtering (3 Checks)**
   - Mandates that \`notifications/subscriptions/acknowledged\` is the first message on a \`subscriptions/listen\` stream, and that subsequent notifications carry a matching \`_meta.../subscriptionId\`.
   - Verifies strict containment where servers do not dispatch notification types that fall outside the client's explicit requested subscription filter list.
7. **Dynamic List Mutations (2 Checks)**
   - Evaluates that list-changed capable servers notify active listen streams with \`promptsListChanged: true\` or \`toolsListChanged: true\` upon live configuration or capability modifications.  `;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    const { serverUrl, specVersion } = ctx;
    const checks: ConformanceCheck[] = [];
    const timestamp = new Date().toISOString();

    // Executes a validation rule and pushes the structural result metadata.
    async function runCheck(
      id: string,
      name: string,
      description: string,
      fn: () =>
        | Promise<{
            error?: string;
            warning?: boolean;
            skipped?: boolean;
            details?: any;
          } | void>
        | ({
            error?: string;
            warning?: boolean;
            skipped?: boolean;
            details?: any;
          } | void),
      fallbackDetails = {}
    ) {
      try {
        const result = await fn();
        const errorMessage = result?.error;
        // SHOULD-level requirements report WARNING rather than FAILURE
        // (severity follows the spec keyword).
        const status = errorMessage
          ? result?.warning
            ? 'WARNING'
            : 'FAILURE'
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
      // The cross-cutting SEP-2243 headers (Mcp-Method, Mcp-Name, Accept,
      // MCP-Protocol-Version) are not what this scenario exercises, so they
      // are always sent conformantly; overrides only alter the dimension a
      // test case is about (issue #312).
      const headers = buildStandardHeaders(method, params, {
        headers: headersOverrides,
        specVersion
      });

      const body = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        ...(params !== undefined ? { params } : {})
      });

      const res = await fetch(serverUrl, { method: 'POST', headers, body });
      let data: any = null;
      // Servers may answer single requests over text/event-stream; pick the
      // JSON-RPC message matching this request id instead of failing to parse
      // the stream as JSON.
      const contentType =
        typeof res.headers?.get === 'function'
          ? (res.headers.get('content-type') ?? '')
          : '';
      if (contentType.includes('text/event-stream')) {
        const { body: matched } = await readSseJsonRpcResponse(res, id);
        data = matched ?? null;
      } else {
        try {
          data = await res.json();
        } catch {
          // Response might not be JSON
        }
      }
      return { res, data };
    };

    // Helper to read multi-frame streaming endpoints (like subscriptions/listen).
    // `onFirstFrame` runs once after the first frame arrives (i.e. after the
    // server has acknowledged the subscription) so callers can trigger
    // side effects on a separate connection while this stream is still open.
    const listenToStream = async (
      method: string,
      params?: any,
      maxFrames = 3,
      timeoutMs = 1000,
      onFirstFrame?: () => Promise<void>
    ): Promise<any[]> => {
      const headers = buildStandardHeaders(method, params, { specVersion });

      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method,
        ...(params !== undefined ? { params } : {})
      });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      try {
        const res = await fetch(serverUrl, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal
        });

        if (!res.body) {
          clearTimeout(timeoutId);
          return [];
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const frames: any[] = [];
        let buffer = '';
        let firstFrameCallbackFired = false;
        const maybeFireFirstFrameCallback = async () => {
          if (firstFrameCallbackFired || frames.length === 0 || !onFirstFrame)
            return;
          firstFrameCallbackFired = true;
          try {
            await onFirstFrame();
          } catch {
            // The trigger failed; the caller inspects its own captured result.
          }
        };

        try {
          while (frames.length < maxFrames) {
            let value: Uint8Array | undefined;
            let done = false;
            try {
              ({ value, done } = await reader.read());
            } catch {
              // The stream was aborted (timeout) or dropped. A compliant
              // server holds a subscriptions/listen stream open indefinitely,
              // so hitting the timeout is the normal way these reads end —
              // return whatever frames arrived before it fired.
              break;
            }

            if (value) {
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split(/\r?\n/);
              buffer = lines.pop() || '';

              for (const line of lines) {
                const cleanLine = line.trim();
                if (!cleanLine) continue;

                const jsonText = cleanLine.startsWith('data:')
                  ? cleanLine.replace(/^data:\s*/, '')
                  : cleanLine;
                try {
                  frames.push(JSON.parse(jsonText));
                } catch {
                  // Keep segment buffering
                }
              }
              await maybeFireFirstFrameCallback();
            }

            if (done) {
              const finalLine = buffer.trim();
              if (finalLine) {
                const jsonText = finalLine.startsWith('data:')
                  ? finalLine.replace(/^data:\s*/, '')
                  : finalLine;
                try {
                  frames.push(JSON.parse(jsonText));
                } catch {
                  // Trailing formatting mismatch
                }
              }
              break;
            }
          }
        } finally {
          reader.releaseLock();
        }

        clearTimeout(timeoutId);
        return frames;
      } catch {
        clearTimeout(timeoutId);
        return [];
      }
    };

    const validMeta = {
      'io.modelcontextprotocol/protocolVersion': specVersion,
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
      const metaProbe = await sendRpc(
        'server/discover',
        testCase.params,
        undefined,
        testCase.rpcId
      ).catch(() => null);
      const metaRes: any = metaProbe?.res ?? null;
      const metaData: any = metaProbe?.data ?? null;
      if (metaData) checkErrorId(metaData, testCase.rpcId);

      await runCheck(
        `sep-2575-request-meta-invalid-${testCase.slug}`,
        'RequestMetaInvalid',
        testCase.description,
        () => {
          if (!metaProbe)
            return { error: '_meta validation probe failed completely' };
          if (metaData?.error?.code !== -32602) {
            return {
              error: `Expected error code -32602, got ${metaData?.error?.code}`,
              details: { fieldIssue: testCase.slug, response: metaData }
            };
          }
          return { details: { fieldIssue: testCase.slug, response: metaData } };
        },
        { fieldIssue: testCase.slug }
      );

      // Companion HTTP-status check: a request missing a required _meta field
      // is malformed and, on HTTP, the rejection MUST use 400 Bad Request.
      await runCheck(
        'sep-2575-http-server-meta-invalid-400',
        'HttpServerMetaInvalid400',
        'Rejections of requests missing required _meta fields use HTTP 400 Bad Request.',
        () => {
          if (!metaRes)
            return { error: '_meta validation probe failed completely' };
          if (metaRes.status !== 400) {
            return {
              error: `Expected HTTP 400 Bad Request, got status code ${metaRes.status}`,
              details: { fieldIssue: testCase.slug, response: metaData }
            };
          }
          return { details: { fieldIssue: testCase.slug, response: metaData } };
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
    const requestedUnsupportedVersion = 'v999.0.0';
    const unsupportedMeta = {
      ...validMeta,
      'io.modelcontextprotocol/protocolVersion': requestedUnsupportedVersion
    };
    const response301 = await sendRpc(
      'server/discover',
      { _meta: unsupportedMeta },
      { 'MCP-Protocol-Version': requestedUnsupportedVersion },
      301
    ).catch(() => null);
    const res301: any = response301?.res ?? null;
    const data301: any = response301?.data ?? null;
    if (data301) checkErrorId(data301, 301);

    await runCheck(
      'sep-2575-server-unsupported-version-error',
      'ServerUnsupportedVersionError',
      'If the server does not implement the requested version (whether the version is unknown to the server, or is a known version the server has chosen not to support), it MUST respond with an UnsupportedProtocolVersionError listing the versions it does support; the error data carries the supported versions and echoes the requested version.',
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

        // UnsupportedProtocolVersionError data carries both required members:
        // `supported` (asserted above) and `requested`, which echoes the
        // version the request asked for.
        const requestedEcho = data301?.error?.data?.requested;
        if (requestedEcho !== requestedUnsupportedVersion) {
          return {
            error: `error.data.requested must echo the requested version '${requestedUnsupportedVersion}', got ${JSON.stringify(requestedEcho)}`,
            details: { response: data301 }
          };
        }
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
      { 'MCP-Protocol-Version': specVersion },
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
    // 5. Methods & Routing Mechanics (5 Checks)
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

    await runCheck(
      'sep-2575-http-server-no-independent-requests-on-stream',
      'HttpServerNoIndependentRequestsOnStream',
      'Request stream contains only IncompleteResult, never independent JSON-RPC requests',
      async () => {
        const frames = await listenToStream(
          'tools/call',
          {
            name: 'test_streaming_elicitation',
            arguments: {},
            _meta: validMeta
          },
          3,
          600
        );

        if (frames.length === 0) {
          return {
            error:
              'Failed to receive progressive stream chunk execution frames from tools/call handler endpoint'
          };
        }

        // If the call was rejected outright (e.g. the diagnostic tool does
        // not exist), nothing was streamed and the requirement was not
        // exercised - report SKIPPED rather than a vacuous SUCCESS.
        if (frames.every((f) => f?.error !== undefined)) {
          return {
            skipped: true,
            details: {
              note: 'Server does not expose diagnostic tool test_streaming_elicitation; the response stream could not be exercised.',
              response: frames[0]
            }
          };
        }

        const hasIndependentRequest = frames.some(
          (f) => f.method && !f.method.startsWith('notifications/')
        );
        if (hasIndependentRequest) {
          return {
            error:
              'Server emitted an independent standard request layout inside a response progress execution block stream context',
            details: { frames }
          };
        }
        return { details: { inspectedFramesCount: frames.length } };
      }
    );

    await runCheck(
      'sep-2575-server-no-log-without-loglevel',
      'ServerNoLogWithoutLogLevel',
      "No notifications/message for requests that didn't set _meta.../logLevel",
      async () => {
        const frames = await listenToStream(
          'tools/call',
          { name: 'test_logging_tool', arguments: {}, _meta: validMeta },
          3,
          500
        );

        if (frames.length === 0) {
          return {
            error:
              'Logging target endpoint context dropped or failed to yield frame structures'
          };
        }

        // If the call was rejected outright (e.g. the diagnostic tool does
        // not exist), the server never had anything to log and the
        // requirement was not exercised - report SKIPPED rather than a
        // vacuous SUCCESS.
        if (frames.every((f) => f?.error !== undefined)) {
          return {
            skipped: true,
            details: {
              note: 'Server does not expose diagnostic tool test_logging_tool; the no-log-without-logLevel requirement could not be exercised.',
              response: frames[0]
            }
          };
        }

        const logFrame = frames.find(
          (f) => f.method === 'notifications/message'
        );
        if (logFrame) {
          return {
            error:
              'Server dispatched a notifications/message payload chunk even though the client request did not authorize a log level context descriptor',
            details: { logFrame }
          };
        }
        return { details: { framesFound: frames.length } };
      }
    );

    // ==========================================
    // 6. Subscription Streams & Filtering (3 Checks)
    // ==========================================
    const subscriptionParams = {
      _meta: validMeta,
      notifications: { toolsListChanged: true }
    };

    // Open a tools-filtered stream and (best-effort) trigger a tool-list
    // change once it is acknowledged, so the stream carries at least one
    // post-acknowledgment notification for the subscription-id check.
    let streamFrames: any[] = [];
    try {
      streamFrames = await listenToStream(
        'subscriptions/listen',
        subscriptionParams,
        2,
        800,
        async () => {
          await sendRpc('tools/call', {
            name: 'test_trigger_tool_change',
            arguments: {},
            _meta: validMeta
          });
        }
      );
    } catch {
      // Stream pipeline tracking failed
    }

    await runCheck(
      'sep-2575-server-sends-subscription-ack',
      'ServerSendsSubscriptionAck',
      'notifications/subscriptions/acknowledged is the first message on a subscriptions/listen stream',
      () => {
        if (streamFrames[0]?.error?.code === -32601) {
          return {
            skipped: true,
            details: {
              note: 'Server does not support subscriptions/listen (Method not found)'
            }
          };
        }
        if (streamFrames.length === 0) {
          return {
            error:
              'Failed to open or receive frames from the subscriptions/listen stream endpoint'
          };
        }
        const firstFrame = streamFrames[0];
        if (firstFrame?.method !== 'notifications/subscriptions/acknowledged') {
          return {
            error: `Expected first frame method to be 'notifications/subscriptions/acknowledged', got '${firstFrame?.method}'`,
            details: { firstFrame }
          };
        }
        return { details: { firstFrame } };
      }
    );

    await runCheck(
      'sep-2575-server-tags-subscription-id',
      'ServerTagsSubscriptionId',
      'Listen-stream notifications carry _meta.../subscriptionId',
      () => {
        if (streamFrames[0]?.error?.code === -32601) {
          return {
            skipped: true,
            details: {
              note: 'Server does not support subscriptions/listen (Method not found)'
            }
          };
        }
        if (streamFrames.length === 0) {
          return {
            error:
              'Failed to open stream line or tracking frames are missing completely'
          };
        }

        // Every notification delivered on the stream (the acknowledgment and
        // anything after it) must carry the subscription id in params._meta.
        const notificationFrames = streamFrames.filter(
          (f) =>
            typeof f?.method === 'string' &&
            f.method.startsWith('notifications/')
        );
        if (notificationFrames.length === 0) {
          return {
            error:
              'subscriptions/listen stream carried no notification frames to inspect',
            details: { streamFrames }
          };
        }

        const untaggedFrames = notificationFrames.filter(
          (f) => !f?.params?._meta?.['io.modelcontextprotocol/subscriptionId']
        );
        if (untaggedFrames.length > 0) {
          return {
            error: `${untaggedFrames.length} of ${notificationFrames.length} listen-stream notification(s) are missing io.modelcontextprotocol/subscriptionId in params._meta`,
            details: { untaggedFrames }
          };
        }

        const subId =
          notificationFrames[0]?.params?._meta?.[
            'io.modelcontextprotocol/subscriptionId'
          ];
        return {
          details: {
            subscriptionId: subId,
            inspectedNotificationCount: notificationFrames.length
          }
        };
      }
    );

    await runCheck(
      'sep-2575-server-honors-notification-filter',
      'ServerHonorsNotificationFilter',
      "Server doesn't send notification types the client didn't request",
      async () => {
        const narrowParams = {
          _meta: validMeta,
          notifications: { promptsListChanged: true }
        };

        // Open a stream filtered to prompts only, then mutate the *tool* list
        // on a separate connection once the subscription is acknowledged. A
        // compliant server must not deliver the resulting tools notification
        // to this stream.
        const narrowFrames = await listenToStream(
          'subscriptions/listen',
          narrowParams,
          3,
          1500,
          async () => {
            await sendRpc('tools/call', {
              name: 'test_trigger_tool_change',
              arguments: {},
              _meta: validMeta
            });
          }
        );

        if (narrowFrames[0]?.error?.code === -32601) {
          return {
            skipped: true,
            details: {
              note: 'Server does not support subscriptions/listen (Method not found)'
            }
          };
        }
        if (narrowFrames.length === 0) {
          return {
            error:
              'Strict subscription filtering line failed to return communication frames'
          };
        }

        const leakedToolFrame = narrowFrames.find(
          (f) => f?.method === 'notifications/tools/list_changed'
        );

        if (leakedToolFrame) {
          return {
            error:
              'Server leaked a tools/list-changed notification over a stream explicitly filtered to prompts only',
            details: { leakedToolFrame }
          };
        }
        return { details: { narrowFramesCount: narrowFrames.length } };
      }
    );

    // ==========================================
    // 7. Dynamic List Mutations (2 Checks)
    // ==========================================
    await runCheck(
      'sep-2575-server-sends-prompts-list-changed-on-subscription',
      'ServerSendsPromptsListChangedOnSubscription',
      'List-changed-capable servers notify listen streams with promptsListChanged: true (SHOULD)',
      async () => {
        // Automatically pass/skip if the server didn't declare this capability during discovery
        if (!discoverCapabilities?.prompts?.listChanged) {
          return {
            skipped: true,
            details: {
              note: 'Server did not declare prompts.listChanged capability in server/discover'
            }
          };
        }

        const promptsParams = {
          _meta: validMeta,
          notifications: { promptsListChanged: true }
        };

        // Open the subscription first; mutate the prompt list on a separate
        // connection once it is acknowledged. A compliant server only
        // notifies streams that are open at the time of the change.
        let trigger: any = null;
        const frames = await listenToStream(
          'subscriptions/listen',
          promptsParams,
          2,
          1500,
          async () => {
            trigger = await sendRpc('tools/call', {
              name: 'test_trigger_prompt_change',
              arguments: {},
              _meta: validMeta
            });
          }
        );
        if (trigger?.data?.error?.code === -32601) {
          return {
            skipped: true,
            details: {
              note: 'Server does not expose diagnostic hook test_trigger_prompt_change to mutate lists'
            }
          };
        }

        if (frames.length === 0) {
          return {
            warning: true,
            error:
              'Failed to open or receive frames from the subscriptions/listen stream endpoint'
          };
        }

        const changeFrame = frames.find(
          (f) => f.method === 'notifications/prompts/list_changed'
        );
        if (!changeFrame) {
          return {
            warning: true,
            error:
              'Mutated the prompt list but no notifications/prompts/list_changed arrived on the open subscription stream. This is a SHOULD requirement.'
          };
        }
        return { details: { changeFrame } };
      }
    );

    await runCheck(
      'sep-2575-server-sends-tools-list-changed-on-subscription',
      'ServerSendsToolsListChangedOnSubscription',
      'List-changed-capable servers notify listen streams with toolsListChanged: true (SHOULD)',
      async () => {
        // Automatically pass/skip if the server didn't declare this capability during discovery
        if (!discoverCapabilities?.tools?.listChanged) {
          return {
            skipped: true,
            details: {
              note: 'Server did not declare tools.listChanged capability in server/discover'
            }
          };
        }

        const toolsParams = {
          _meta: validMeta,
          notifications: { toolsListChanged: true }
        };

        // Open the subscription first; mutate the tool list on a separate
        // connection once it is acknowledged. A compliant server only
        // notifies streams that are open at the time of the change.
        let trigger: any = null;
        const frames = await listenToStream(
          'subscriptions/listen',
          toolsParams,
          2,
          1500,
          async () => {
            trigger = await sendRpc('tools/call', {
              name: 'test_trigger_tool_change',
              arguments: {},
              _meta: validMeta
            });
          }
        );
        if (trigger?.data?.error?.code === -32601) {
          return {
            skipped: true,
            details: {
              note: 'Server does not expose diagnostic hook test_trigger_tool_change to mutate lists'
            }
          };
        }

        if (frames.length === 0) {
          return {
            warning: true,
            error:
              'Failed to open or receive frames from the subscriptions/listen stream endpoint'
          };
        }

        const changeFrame = frames.find(
          (f) => f.method === 'notifications/tools/list_changed'
        );
        if (!changeFrame) {
          return {
            warning: true,
            error:
              'Mutated the tool list but no notifications/tools/list_changed arrived on the open subscription stream. This is a SHOULD requirement.'
          };
        }
        return { details: { changeFrame } };
      }
    );

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
