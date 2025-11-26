/**
 * CIMD Support Advertisement Scenario
 *
 * Tests that the Authorization Server properly advertises Client ID
 * Metadata Document support per the IETF CIMD draft.
 *
 * @see IETF Draft: draft-ietf-oauth-client-id-metadata-document-00
 */

import { ClientScenario, ConformanceCheck } from '../../../../types';
import { fetchAsMetadata } from '../helpers/as-metadata';
import { ServerAuthSpecReferences } from '../spec-references';

/**
 * Validates CIMD support advertisement in AS metadata.
 *
 * Per IETF CIMD draft Section 4, authorization servers that support
 * Client ID Metadata Documents MUST advertise this via:
 *   "client_id_metadata_document_supported": true
 */
export class AuthAsCimdSupportedScenario implements ClientScenario {
  name = 'server/auth-as-cimd-supported';
  description = `Test CIMD (Client ID Metadata Document) support advertisement.

**Prerequisites**: Server must have valid AS metadata endpoint.

**Check**: AS metadata contains \`client_id_metadata_document_supported\` field.

CIMD is an alternative to DCR that allows clients to use HTTPS URLs as client_id,
pointing to a metadata document hosted by the client.

**Spec References**:
- IETF CIMD Draft Section 4 (Authorization Server Metadata)`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const timestamp = () => new Date().toISOString();

    // Fetch AS metadata
    const asResult = await fetchAsMetadata(serverUrl);

    if (!asResult.success || !asResult.metadata) {
      checks.push({
        id: 'auth-cimd-as-prerequisite',
        name: 'AS Metadata Prerequisite',
        description: 'Valid AS metadata required to check CIMD support',
        status: 'SKIPPED',
        timestamp: timestamp(),
        errorMessage: asResult.error || 'Cannot fetch AS metadata - run auth-as-metadata-discovery first',
        specReferences: [ServerAuthSpecReferences.RFC_8414_AS_DISCOVERY]
      });
      return checks;
    }

    checks.push({
      id: 'auth-cimd-as-prerequisite',
      name: 'AS Metadata Prerequisite',
      description: 'Valid AS metadata found',
      status: 'SUCCESS',
      timestamp: timestamp(),
      specReferences: [ServerAuthSpecReferences.RFC_8414_AS_DISCOVERY],
      details: { asUrl: asResult.asUrl, metadataUrl: asResult.url }
    });

    const metadata = asResult.metadata;

    // Check: client_id_metadata_document_supported field
    const cimdSupported = metadata.client_id_metadata_document_supported;

    if (cimdSupported === undefined) {
      checks.push({
        id: 'auth-cimd-field-present',
        name: 'CIMD Support Field Present',
        description: 'AS metadata contains client_id_metadata_document_supported field',
        status: 'INFO',
        timestamp: timestamp(),
        errorMessage: 'Field not present - CIMD support unknown (DCR may be available)',
        specReferences: [ServerAuthSpecReferences.IETF_CIMD_AS_METADATA],
        details: { client_id_metadata_document_supported: undefined }
      });

      checks.push({
        id: 'auth-cimd-supported',
        name: 'CIMD Supported',
        description: 'Authorization Server supports Client ID Metadata Documents',
        status: 'SKIPPED',
        timestamp: timestamp(),
        errorMessage: 'Cannot determine - field not present in AS metadata',
        specReferences: [ServerAuthSpecReferences.IETF_CIMD_AS_METADATA]
      });
    } else if (cimdSupported === true) {
      checks.push({
        id: 'auth-cimd-field-present',
        name: 'CIMD Support Field Present',
        description: 'AS metadata contains client_id_metadata_document_supported field',
        status: 'SUCCESS',
        timestamp: timestamp(),
        specReferences: [ServerAuthSpecReferences.IETF_CIMD_AS_METADATA],
        details: { client_id_metadata_document_supported: true }
      });

      checks.push({
        id: 'auth-cimd-supported',
        name: 'CIMD Supported',
        description: 'Authorization Server supports Client ID Metadata Documents',
        status: 'SUCCESS',
        timestamp: timestamp(),
        specReferences: [
          ServerAuthSpecReferences.IETF_CIMD,
          ServerAuthSpecReferences.IETF_CIMD_AS_METADATA
        ],
        details: { client_id_metadata_document_supported: true }
      });
    } else if (cimdSupported === false) {
      checks.push({
        id: 'auth-cimd-field-present',
        name: 'CIMD Support Field Present',
        description: 'AS metadata contains client_id_metadata_document_supported field',
        status: 'SUCCESS',
        timestamp: timestamp(),
        specReferences: [ServerAuthSpecReferences.IETF_CIMD_AS_METADATA],
        details: { client_id_metadata_document_supported: false }
      });

      checks.push({
        id: 'auth-cimd-supported',
        name: 'CIMD Supported',
        description: 'Authorization Server supports Client ID Metadata Documents',
        status: 'INFO',
        timestamp: timestamp(),
        errorMessage: 'CIMD explicitly not supported - DCR or pre-registration required',
        specReferences: [ServerAuthSpecReferences.IETF_CIMD_AS_METADATA],
        details: { client_id_metadata_document_supported: false }
      });
    } else {
      // Invalid value type
      checks.push({
        id: 'auth-cimd-field-present',
        name: 'CIMD Support Field Present',
        description: 'AS metadata contains client_id_metadata_document_supported field',
        status: 'WARNING',
        timestamp: timestamp(),
        errorMessage: `Invalid value type: expected boolean, got ${typeof cimdSupported}`,
        specReferences: [ServerAuthSpecReferences.IETF_CIMD_AS_METADATA],
        details: { client_id_metadata_document_supported: cimdSupported }
      });

      checks.push({
        id: 'auth-cimd-supported',
        name: 'CIMD Supported',
        description: 'Authorization Server supports Client ID Metadata Documents',
        status: 'SKIPPED',
        timestamp: timestamp(),
        errorMessage: 'Invalid field value type',
        specReferences: [ServerAuthSpecReferences.IETF_CIMD_AS_METADATA]
      });
    }

    // Check registration options summary
    const hasRegistrationEndpoint = typeof metadata.registration_endpoint === 'string';
    const hasCimd = cimdSupported === true;

    if (!hasRegistrationEndpoint && !hasCimd) {
      checks.push({
        id: 'auth-cimd-registration-options',
        name: 'Registration Options Available',
        description: 'At least one client registration mechanism available',
        status: 'WARNING',
        timestamp: timestamp(),
        errorMessage: 'Neither DCR (registration_endpoint) nor CIMD available - pre-registration may be required',
        specReferences: [
          ServerAuthSpecReferences.MCP_AUTH_DCR,
          ServerAuthSpecReferences.IETF_CIMD
        ],
        details: {
          dcr_available: hasRegistrationEndpoint,
          cimd_available: hasCimd,
          registration_endpoint: metadata.registration_endpoint
        }
      });
    } else {
      checks.push({
        id: 'auth-cimd-registration-options',
        name: 'Registration Options Available',
        description: 'At least one client registration mechanism available',
        status: 'SUCCESS',
        timestamp: timestamp(),
        specReferences: [
          ServerAuthSpecReferences.MCP_AUTH_DCR,
          ServerAuthSpecReferences.IETF_CIMD
        ],
        details: {
          dcr_available: hasRegistrationEndpoint,
          cimd_available: hasCimd,
          registration_endpoint: metadata.registration_endpoint
        }
      });
    }

    return checks;
  }
}
