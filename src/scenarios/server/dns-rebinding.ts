/**
 * DNS Rebinding Protection test scenarios for MCP servers
 *
 * Tests that localhost MCP servers properly validate Host headers to prevent
 * DNS rebinding attacks. See GHSA-w48q-cv73-mx4w for details on the attack.
 */

import { ClientScenario, ConformanceCheck } from '../../types';
import { request } from 'undici';

const SPEC_REFERENCE = {
  id: 'MCP-DNS-Rebinding-Protection',
  url: 'https://modelcontextprotocol.io/specification/draft/basic/transports#security'
};

/**
 * Check if URL is a localhost URL
 */
function isLocalhostUrl(serverUrl: string): boolean {
  const url = new URL(serverUrl);
  const hostname = url.hostname.toLowerCase();
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

/**
 * Get the host header value from a URL (hostname:port)
 */
function getHostFromUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  return url.host; // includes port if present
}

/**
 * Send an MCP initialize request with a custom Host header
 */
async function sendRequestWithHost(
  serverUrl: string,
  hostHeader: string
): Promise<{ statusCode: number; body: unknown }> {
  const response = await request(serverUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Host: hostHeader,
      Accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'conformance-dns-rebinding-test', version: '1.0.0' }
      }
    })
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

export class DNSRebindingProtectionScenario implements ClientScenario {
  name = 'dns-rebinding-protection';
  description = `Test DNS rebinding protection for localhost servers.

**Server Implementation Requirements:**

DNS rebinding attacks occur when an attacker's domain resolves to a localhost IP,
allowing malicious websites to interact with local MCP servers. To prevent this:

**Requirements**:
- Server **MUST** validate the Host header on incoming requests
- Server **MUST** reject requests with non-localhost Host headers with HTTP 403
- Server **MUST** accept requests with valid localhost Host headers

**Valid localhost hosts:**
- \`localhost\` / \`localhost:PORT\`
- \`127.0.0.1\` / \`127.0.0.1:PORT\`
- \`[::1]\` / \`[::1]:PORT\` (IPv6)

**Note:** This test only runs against localhost servers. Non-localhost server URLs will fail.

See: https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-w48q-cv73-mx4w`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const timestamp = new Date().toISOString();

    // First check: Is this a localhost URL?
    if (!isLocalhostUrl(serverUrl)) {
      // Return failure for both checks when server is not localhost
      checks.push({
        id: 'localhost-host-rebinding-rejected',
        name: 'DNSRebindingRejected',
        description:
          'Server rejects requests with non-localhost Host headers (HTTP 403)',
        status: 'FAILURE',
        timestamp,
        errorMessage:
          'DNS rebinding tests require a localhost server URL (localhost, 127.0.0.1, or [::1])',
        specReferences: [SPEC_REFERENCE],
        details: { serverUrl, reason: 'non-localhost-url' }
      });

      checks.push({
        id: 'localhost-host-valid-accepted',
        name: 'LocalhostHostAccepted',
        description:
          'Server accepts requests with valid localhost Host headers',
        status: 'FAILURE',
        timestamp,
        errorMessage:
          'DNS rebinding tests require a localhost server URL (localhost, 127.0.0.1, or [::1])',
        specReferences: [SPEC_REFERENCE],
        details: { serverUrl, reason: 'non-localhost-url' }
      });

      return checks;
    }

    const validHost = getHostFromUrl(serverUrl);
    const attackerHost = 'evil.example.com';

    // Check 1: Invalid Host header should be rejected with 403
    try {
      const response = await sendRequestWithHost(serverUrl, attackerHost);

      if (response.statusCode === 403) {
        checks.push({
          id: 'localhost-host-rebinding-rejected',
          name: 'DNSRebindingRejected',
          description:
            'Server rejects requests with non-localhost Host headers (HTTP 403)',
          status: 'SUCCESS',
          timestamp,
          specReferences: [SPEC_REFERENCE],
          details: {
            hostHeader: attackerHost,
            statusCode: response.statusCode,
            body: response.body
          }
        });
      } else {
        checks.push({
          id: 'localhost-host-rebinding-rejected',
          name: 'DNSRebindingRejected',
          description:
            'Server rejects requests with non-localhost Host headers (HTTP 403)',
          status: 'FAILURE',
          timestamp,
          errorMessage: `Expected HTTP 403 for invalid Host header, got ${response.statusCode}`,
          specReferences: [SPEC_REFERENCE],
          details: {
            hostHeader: attackerHost,
            statusCode: response.statusCode,
            body: response.body
          }
        });
      }
    } catch (error) {
      checks.push({
        id: 'localhost-host-rebinding-rejected',
        name: 'DNSRebindingRejected',
        description:
          'Server rejects requests with non-localhost Host headers (HTTP 403)',
        status: 'FAILURE',
        timestamp,
        errorMessage: `Request failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [SPEC_REFERENCE],
        details: { hostHeader: attackerHost }
      });
    }

    // Check 2: Valid localhost Host header should be accepted
    try {
      const response = await sendRequestWithHost(serverUrl, validHost);

      // Accept any 2xx response (200, 201, etc.) as success
      if (response.statusCode >= 200 && response.statusCode < 300) {
        checks.push({
          id: 'localhost-host-valid-accepted',
          name: 'LocalhostHostAccepted',
          description:
            'Server accepts requests with valid localhost Host headers',
          status: 'SUCCESS',
          timestamp,
          specReferences: [SPEC_REFERENCE],
          details: {
            hostHeader: validHost,
            statusCode: response.statusCode
          }
        });
      } else if (response.statusCode === 403) {
        checks.push({
          id: 'localhost-host-valid-accepted',
          name: 'LocalhostHostAccepted',
          description:
            'Server accepts requests with valid localhost Host headers',
          status: 'FAILURE',
          timestamp,
          errorMessage: `Server rejected valid localhost Host header with HTTP 403`,
          specReferences: [SPEC_REFERENCE],
          details: {
            hostHeader: validHost,
            statusCode: response.statusCode,
            body: response.body
          }
        });
      } else {
        // Other status codes might still be acceptable (e.g., 401 for auth)
        // but 403 specifically indicates Host rejection
        checks.push({
          id: 'localhost-host-valid-accepted',
          name: 'LocalhostHostAccepted',
          description:
            'Server accepts requests with valid localhost Host headers',
          status: 'SUCCESS',
          timestamp,
          specReferences: [SPEC_REFERENCE],
          details: {
            hostHeader: validHost,
            statusCode: response.statusCode,
            note: 'Non-403 response indicates Host header was accepted'
          }
        });
      }
    } catch (error) {
      checks.push({
        id: 'localhost-host-valid-accepted',
        name: 'LocalhostHostAccepted',
        description:
          'Server accepts requests with valid localhost Host headers',
        status: 'FAILURE',
        timestamp,
        errorMessage: `Request failed: ${error instanceof Error ? error.message : String(error)}`,
        specReferences: [SPEC_REFERENCE],
        details: { hostHeader: validHost }
      });
    }

    return checks;
  }
}
