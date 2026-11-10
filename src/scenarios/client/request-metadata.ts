import { withRequiredDraftResultFields } from '../../mock-server';
import http from 'http';
import {
  HandlerScenario,
  RequestListener,
  ConformanceCheck,
  CheckStatus,
  DRAFT_PROTOCOL_VERSION
} from '../../types';

/**
 * Severity ranking used to latch per-id check results: a single
 * non-conformant request is a violation even if later requests are
 * conformant, so a later better status must never overwrite a worse one.
 */
const STATUS_SEVERITY: Record<CheckStatus, number> = {
  FAILURE: 3,
  WARNING: 2,
  SUCCESS: 1,
  INFO: 1,
  SKIPPED: 0
};

/**
 * Every check ID this scenario can emit. Declared-but-unemitted checks are
 * backfilled as FAILURE by getChecks(), so the emitted ID set is the same for
 * every client. The positive-path test asserts this list is exact.
 */
export const DECLARED_CHECK_IDS = [
  'sep-2575-http-client-sends-version-header',
  'sep-2575-client-populates-meta',
  'sep-2575-client-sends-client-info',
  'sep-2575-http-version-header-matches-meta',
  'sep-2575-client-declares-roots-capability',
  'sep-2575-client-declares-sampling-capability',
  'sep-2575-client-declares-elicitation-capability',
  'sep-2575-client-retry-supported-version'
] as const;

/**
 * Recorded the moment the simulated version rejection is issued, and only
 * then — so its presence in the log is the record that the rejection
 * happened. Deriving that from the log rather than from an instance flag is
 * what lets a run split across processes (the hosted server seeds a cold
 * process with the persisted log) reject the client's first request once,
 * not once per process.
 */
const RETRY_CHECK_ID = 'sep-2575-client-retry-supported-version';

export class RequestMetadataScenario extends HandlerScenario {
  name = 'request-metadata';
  readonly source = { introducedIn: DRAFT_PROTOCOL_VERSION } as const;
  description =
    'Per-request _meta and MCP-Protocol-Version header obligations (SEP-2575)';

  private checks: ConformanceCheck[] = [];
  private requestsObserved = 0;

  handler(_getBaseUrl: () => string): RequestListener {
    this.checks = [];
    this.requestsObserved = 0;
    return (req, res) => this.handleRequest(req, res);
  }

  /** Whether this run has already issued its one simulated rejection. */
  private hasSimulatedRejection(): boolean {
    return this.checks.some((c) => c.id === RETRY_CHECK_ID);
  }

  getChecks(): ConformanceCheck[] {
    this.collapseDuplicateIds();
    // Declared but never emitted -> FAILURE. A check that is legitimately not
    // applicable must be emitted as SKIPPED explicitly to avoid this.
    for (const id of DECLARED_CHECK_IDS) {
      if (!this.checks.some((c) => c.id === id)) {
        this.checks.push({
          id,
          name: 'NotObserved',
          description: `Declared check ${id} was never emitted`,
          status: 'FAILURE',
          errorMessage:
            this.requestsObserved === 0
              ? 'Check was not observed: the client never sent a request to the scenario server (no handler registered for this scenario?)'
              : 'Check was not observed: no request exercised it',
          timestamp: new Date().toISOString(),
          specReferences: [
            {
              id: 'SEP-2575',
              url: 'https://modelcontextprotocol.io/specification/draft/basic/index#meta'
            }
          ],
          details: { observed: false, requestsObserved: this.requestsObserved }
        });
      }
    }
    return this.checks;
  }

  /**
   * A log merged from several processes (see src/hosted/session.ts) can carry
   * one id more than once, one per process that observed it. Collapse each
   * id the way addOrUpdateCheck() would have as the requests arrived: the
   * worst status wins. The retry check is the exception — it is rewritten by
   * every retry the client makes, so its latest observation supersedes.
   */
  private collapseDuplicateIds(): void {
    if (new Set(this.checks.map((c) => c.id)).size === this.checks.length)
      return;
    const byId = new Map<string, ConformanceCheck>();
    for (const check of this.checks) {
      const kept = byId.get(check.id);
      if (
        !kept ||
        check.id === RETRY_CHECK_ID ||
        STATUS_SEVERITY[check.status] >= STATUS_SEVERITY[kept.status]
      ) {
        byId.set(check.id, check);
      }
    }
    this.checks = Array.from(byId.values());
  }

  private addOrUpdateCheck(check: ConformanceCheck): void {
    const index = this.checks.findIndex((c) => c.id === check.id);
    if (index === -1) {
      this.checks.push(check);
      return;
    }
    // Keep the worst status observed for this id (FAILURE > WARNING > SUCCESS
    // > SKIPPED): an equal-or-worse result replaces the stored check (so its
    // details stay fresh), but a better result must not erase a violation
    // recorded from an earlier request.
    const existing = this.checks[index];
    if (STATUS_SEVERITY[check.status] >= STATUS_SEVERITY[existing.status]) {
      this.checks[index] = check;
    }
  }

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    // This scenario only evaluates the metadata attached to POST requests.
    // Clients may probe a Streamable HTTP endpoint with an empty-body GET
    // before sending MCP requests, so reject unsupported methods before
    // attempting to parse a JSON-RPC body.
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      res.end('Method Not Allowed');
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      let request;
      try {
        request = JSON.parse(body);
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32700,
              message: `Parse error: ${String(error)}`
            }
          })
        );
        return;
      }

      this.requestsObserved++;

      // Extract version and headers
      const meta = request.params?._meta;
      const metaVersion = meta?.['io.modelcontextprotocol/protocolVersion'];
      const headerVersion = req.headers['mcp-protocol-version'];

      // 1. "Every POST request to the MCP endpoint MUST include an
      //  MCP-Protocol-Version header." — unconditional, so this fires for
      // server/discover too.
      this.addOrUpdateCheck({
        id: 'sep-2575-http-client-sends-version-header',
        name: 'ClientSendsVersionHeader',
        description: 'Client sends MCP-Protocol-Version header on every POST',
        status: headerVersion !== undefined ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [
          {
            id: 'SEP-2575',
            url: 'https://modelcontextprotocol.io/specification/draft/basic/transports#protocol-version-header'
          }
        ],
        details: { method: request.method, headerVersion }
      });

      // 2. "Every client request MUST include the following
      //  io.modelcontextprotocol/* fields in _meta: protocolVersion,
      //  clientCapabilities." clientInfo is a SHOULD since spec PR #3002 and
      // is tracked by its own check below, so requirement levels never blend
      // in one check id.
      const hasClientInfo = meta?.['io.modelcontextprotocol/clientInfo'];
      const hasCapabilities =
        meta?.['io.modelcontextprotocol/clientCapabilities'];
      const metaIsValid = metaVersion && hasCapabilities;

      this.addOrUpdateCheck({
        id: 'sep-2575-client-populates-meta',
        name: 'ClientPopulatesMeta',
        description:
          'Client populates _meta on every request with the required fields (protocolVersion, clientCapabilities)',
        status: metaIsValid ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [
          {
            id: 'SEP-2575',
            url: 'https://modelcontextprotocol.io/specification/draft/basic/index#meta'
          }
        ],
        details: { method: request.method, meta }
      });

      // 2b. clientInfo SHOULD (spec PR #3002): absence is a WARNING, never a
      // FAILURE — a dedicated id so adoption is trackable on its own.
      this.addOrUpdateCheck({
        id: 'sep-2575-client-sends-client-info',
        name: 'ClientSendsClientInfo',
        description:
          "Client SHOULD include io.modelcontextprotocol/clientInfo in every request's _meta (spec PR #3002)",
        status: hasClientInfo ? 'SUCCESS' : 'WARNING',
        timestamp: new Date().toISOString(),
        specReferences: [
          {
            id: 'SEP-2575',
            url: 'https://modelcontextprotocol.io/specification/draft/basic/index#meta'
          }
        ],
        details: { method: request.method, meta }
      });

      // 3. "The header value MUST match the io.modelcontextprotocol/protocolVersion
      //  field carried in the request body's _meta." Only comparable when both
      // are present; absence is already covered by the two checks above, so
      // emit SKIPPED rather than falling through to the declared-check failure.
      const bothVersionsPresent =
        headerVersion !== undefined && metaVersion !== undefined;
      this.addOrUpdateCheck({
        id: 'sep-2575-http-version-header-matches-meta',
        name: 'ClientVersionHeaderMatchesMeta',
        description:
          'MCP-Protocol-Version header matches _meta.protocolVersion',
        status: !bothVersionsPresent
          ? 'SKIPPED'
          : headerVersion === metaVersion
            ? 'SUCCESS'
            : 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [
          {
            id: 'SEP-2575',
            url: 'https://modelcontextprotocol.io/specification/draft/basic/transports#protocol-version-header'
          }
        ],
        details: { headerVersion, metaVersion }
      });

      // 4. Optional client capabilities conditional verification
      const capabilities = meta?.['io.modelcontextprotocol/clientCapabilities'];
      const checkOptionalCapability = (
        capabilityName: string,
        checkId: string,
        checkName: string
      ) => {
        let status: 'SUCCESS' | 'FAILURE' | 'SKIPPED' = 'SKIPPED';
        if (capabilities && capabilityName in capabilities) {
          const val = capabilities[capabilityName];
          const isValidObject =
            typeof val === 'object' && val !== null && !Array.isArray(val);
          status = isValidObject ? 'SUCCESS' : 'FAILURE';
        }
        this.addOrUpdateCheck({
          id: checkId,
          name: checkName,
          description: `Client declares valid ${capabilityName} capability if present`,
          status,
          timestamp: new Date().toISOString(),
          specReferences: [
            {
              id: 'SEP-2575',
              url: 'https://modelcontextprotocol.io/specification/draft/basic/index#capabilities'
            }
          ],
          details: { capabilityValue: capabilities?.[capabilityName] }
        });
      };

      checkOptionalCapability(
        'roots',
        'sep-2575-client-declares-roots-capability',
        'ClientDeclaresRootsCapability'
      );
      checkOptionalCapability(
        'sampling',
        'sep-2575-client-declares-sampling-capability',
        'ClientDeclaresSamplingCapability'
      );
      checkOptionalCapability(
        'elicitation',
        'sep-2575-client-declares-elicitation-capability',
        'ClientDeclaresElicitationCapability'
      );

      // 5. Simulated Version Negotiation Retry Check — issued once per run;
      // the retry check recorded here is the record that it was (see
      // RETRY_CHECK_ID).
      if (!this.hasSimulatedRejection()) {
        this.addOrUpdateCheck({
          id: RETRY_CHECK_ID,
          name: 'ClientRetrySupportedVersion',
          description:
            'Client retries with a supported version when first choice is rejected',
          status: 'WARNING',
          timestamp: new Date().toISOString(),
          specReferences: [
            {
              id: 'SEP-2575',
              url: 'https://modelcontextprotocol.io/specification/draft/basic/transports#protocol-version-header'
            }
          ],
          details: { headerVersion }
        });

        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id ?? null,
            error: {
              // UnsupportedProtocolVersionError per the draft schema.
              code: -32022,
              message: 'Unsupported protocol version',
              data: {
                supported: [DRAFT_PROTOCOL_VERSION],
                requested: String(headerVersion ?? metaVersion ?? '')
              }
            }
          })
        );
        return;
      }

      const retryCheck = this.checks.find((c) => c.id === RETRY_CHECK_ID);
      if (retryCheck) {
        if (
          headerVersion === DRAFT_PROTOCOL_VERSION &&
          metaVersion === DRAFT_PROTOCOL_VERSION
        ) {
          retryCheck.status = 'SUCCESS';
        } else {
          retryCheck.status = 'WARNING';
        }
        // Re-stamped so that, in a log merged across processes, this
        // observation is the latest one for the id.
        retryCheck.timestamp = new Date().toISOString();
        retryCheck.details = {
          ...retryCheck.details,
          retryHeaderVersion: headerVersion,
          retryMetaVersion: metaVersion
        };
      }

      // server/discover is optional for clients (spec: "Clients MAY call it"),
      // so no check is emitted; we still respond so a client that does call it
      // proceeds normally and exercises the per-request _meta/header checks above.
      if (request.method === 'server/discover') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: withRequiredDraftResultFields(request.method, {
              supportedVersions: [DRAFT_PROTOCOL_VERSION],
              capabilities: {},
              serverInfo: { name: 'test', version: '1.0' }
            })
          })
        );
        return;
      }

      // Return generic response to unblock client
      let result: object = {};
      if (request.method === 'tools/list') {
        result = { tools: [] };
      } else if (request.method === 'tools/call') {
        result = { content: [] };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: withRequiredDraftResultFields(request.method, result)
        })
      );
    });
  }
}
