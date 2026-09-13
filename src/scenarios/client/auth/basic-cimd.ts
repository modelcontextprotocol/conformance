import {
  AuthHandlerScenario,
  AuthHandlerContext,
  AuthHandlers,
  ConformanceCheck
} from '../../../types';
import { createAuthServer } from './helpers/createAuthServer';
import { createServer } from './helpers/createServer';
import { SpecReferences } from './spec-references';

/**
 * Fixed client metadata URL that clients should use for CIMD tests.
 * This URL doesn't need to resolve - the server will accept it as-is
 * and use hardcoded metadata.
 */
export const CIMD_CLIENT_METADATA_URL =
  'https://conformance-test.local/client-metadata.json';

/**
 * Whether `clientId` is a URL-based client ID: an https URL. A real client
 * publishes its own metadata document (e.g. at its product's domain), so any
 * https URL counts, not only CIMD_CLIENT_METADATA_URL.
 */
export function isUrlClientId(clientId: string | undefined): boolean {
  if (!clientId) return false;
  try {
    return new URL(clientId).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Scenario: Client ID Metadata Documents (SEP-991/URL-based client IDs)
 *
 * Tests that when a server advertises client_id_metadata_document_supported=true,
 * clients SHOULD use a URL as their client_id instead of using dynamic client
 * registration.
 */
export class AuthBasicCIMDScenario extends AuthHandlerScenario {
  name = 'auth/basic-cimd';
  readonly source = { introducedIn: '2025-11-25' } as const;
  description =
    'Tests OAuth flow with Client ID Metadata Documents (SEP-991/URL-based client IDs). Server advertises client_id_metadata_document_supported=true and client should use URL as client_id instead of DCR.';
  private checks: ConformanceCheck[] = [];

  authHandlers(ctx: AuthHandlerContext): AuthHandlers {
    this.checks = [];
    const getAsUrl = () => ctx.getAuxBaseUrl('as');

    const authApp = createAuthServer(ctx, this.checks, getAsUrl, {
      clientIdMetadataDocumentSupported: true,
      onAuthorizationRequest: (data) => {
        // Check if client used URL-based client ID
        const usedUrlClientId = isUrlClientId(data.clientId);
        this.checks.push({
          id: 'cimd-client-id-used',
          name: 'Client ID Metadata Document Usage',
          description: usedUrlClientId
            ? 'Client correctly used URL-based client ID when server supports client_id_metadata_document_supported'
            : 'Client SHOULD use URL-based client ID when server advertises client_id_metadata_document_supported=true',
          status: usedUrlClientId ? 'SUCCESS' : 'WARNING',
          timestamp: data.timestamp,
          specReferences: [
            SpecReferences.MCP_CLIENT_ID_METADATA_DOCUMENTS,
            SpecReferences.MCP_CLIENT_ID_METADATA_DOCUMENTS_2026_07_28,
            SpecReferences.IETF_CIMD
          ],
          details: {
            expectedClientId: `an https URL, such as ${CIMD_CLIENT_METADATA_URL}`,
            actualClientId: data.clientId || 'none'
          }
        });
      }
    });

    const rsApp = createServer(ctx, this.checks, ctx.getRsBaseUrl, getAsUrl);

    return { rs: rsApp, aux: { as: authApp } };
  }

  getChecks(): ConformanceCheck[] {
    // Ensure we have the CIMD check - if not, the client didn't make an auth request
    const hasCimdCheck = this.checks.some(
      (c) => c.id === 'cimd-client-id-used'
    );
    if (!hasCimdCheck) {
      this.checks.push({
        id: 'cimd-client-id-used',
        name: 'Client ID Metadata Document Usage',
        description:
          'Client did not make an authorization request to test CIMD support',
        status: 'FAILURE',
        timestamp: new Date().toISOString(),
        specReferences: [
          SpecReferences.MCP_CLIENT_ID_METADATA_DOCUMENTS,
          SpecReferences.MCP_CLIENT_ID_METADATA_DOCUMENTS_2026_07_28,
          SpecReferences.IETF_CIMD
        ]
      });
    }

    return this.checks;
  }
}
