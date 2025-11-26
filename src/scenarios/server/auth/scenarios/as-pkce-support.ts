/**
 * PKCE Support Validation Scenario
 *
 * Tests that the Authorization Server supports PKCE (Proof Key for Code Exchange)
 * with the S256 code challenge method.
 *
 * @see RFC 7636 - Proof Key for Code Exchange
 * @see OAuth 2.1 Draft Section 7.5.2
 */

import { ClientScenario, ConformanceCheck } from '../../../../types';
import { fetchAsMetadata } from '../helpers/as-metadata';
import { ServerAuthSpecReferences } from '../spec-references';

/**
 * Validates PKCE support in AS metadata.
 *
 * Per RFC 7636 and OAuth 2.1:
 * - AS SHOULD advertise code_challenge_methods_supported
 * - SHOULD include "S256" (SHA-256 based)
 * - MAY include "plain" (not recommended for security)
 */
export class AuthAsPkceSupportScenario implements ClientScenario {
  name = 'server/auth-as-pkce-support';
  description = `Test PKCE (Proof Key for Code Exchange) support.

**Prerequisites**: Server must have valid AS metadata endpoint.

**Check**: AS metadata contains \`code_challenge_methods_supported\` with "S256".

PKCE is a security extension for OAuth that prevents authorization code interception attacks.
S256 is the recommended method (SHA-256 hash of code verifier).

**Spec References**:
- RFC 7636 Section 4.2 (Code Challenge Methods)
- OAuth 2.1 Section 7.5.2`;

  async run(serverUrl: string): Promise<ConformanceCheck[]> {
    const checks: ConformanceCheck[] = [];
    const timestamp = () => new Date().toISOString();

    // Fetch AS metadata
    const asResult = await fetchAsMetadata(serverUrl);

    if (!asResult.success || !asResult.metadata) {
      checks.push({
        id: 'auth-pkce-as-prerequisite',
        name: 'AS Metadata Prerequisite',
        description: 'Valid AS metadata required to check PKCE support',
        status: 'SKIPPED',
        timestamp: timestamp(),
        errorMessage:
          asResult.error ||
          'Cannot fetch AS metadata - run auth-as-metadata-discovery first',
        specReferences: [ServerAuthSpecReferences.RFC_8414_AS_DISCOVERY]
      });
      return checks;
    }

    checks.push({
      id: 'auth-pkce-as-prerequisite',
      name: 'AS Metadata Prerequisite',
      description: 'Valid AS metadata found',
      status: 'SUCCESS',
      timestamp: timestamp(),
      specReferences: [ServerAuthSpecReferences.RFC_8414_AS_DISCOVERY],
      details: { asUrl: asResult.asUrl, metadataUrl: asResult.url }
    });

    const metadata = asResult.metadata;
    const challengeMethods = metadata.code_challenge_methods_supported;

    // Check: code_challenge_methods_supported field present
    if (challengeMethods === undefined) {
      checks.push({
        id: 'auth-pkce-field-present',
        name: 'PKCE Methods Field Present',
        description:
          'AS metadata contains code_challenge_methods_supported field',
        status: 'WARNING',
        timestamp: timestamp(),
        errorMessage:
          'Field not present - PKCE support unknown (may still be supported)',
        specReferences: [
          ServerAuthSpecReferences.RFC_7636_CODE_CHALLENGE_METHODS,
          ServerAuthSpecReferences.RFC_8414_AS_FIELDS
        ],
        details: { code_challenge_methods_supported: undefined }
      });

      // Can't determine S256 support
      checks.push({
        id: 'auth-pkce-s256-supported',
        name: 'PKCE S256 Supported',
        description: 'Authorization Server supports S256 code challenge method',
        status: 'SKIPPED',
        timestamp: timestamp(),
        errorMessage:
          'Cannot determine - code_challenge_methods_supported not advertised',
        specReferences: [ServerAuthSpecReferences.RFC_7636_CODE_CHALLENGE]
      });

      return checks;
    }

    // Check: field is an array
    if (!Array.isArray(challengeMethods)) {
      checks.push({
        id: 'auth-pkce-field-present',
        name: 'PKCE Methods Field Present',
        description:
          'AS metadata contains code_challenge_methods_supported field',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage: `Invalid type: expected array, got ${typeof challengeMethods}`,
        specReferences: [ServerAuthSpecReferences.RFC_8414_AS_FIELDS],
        details: { code_challenge_methods_supported: challengeMethods }
      });
      return checks;
    }

    checks.push({
      id: 'auth-pkce-field-present',
      name: 'PKCE Methods Field Present',
      description:
        'AS metadata contains code_challenge_methods_supported field',
      status: 'SUCCESS',
      timestamp: timestamp(),
      specReferences: [
        ServerAuthSpecReferences.RFC_7636_CODE_CHALLENGE_METHODS,
        ServerAuthSpecReferences.RFC_8414_AS_FIELDS
      ],
      details: { code_challenge_methods_supported: challengeMethods }
    });

    // Check: S256 supported
    const hasS256 = challengeMethods.includes('S256');
    const hasPlain = challengeMethods.includes('plain');

    if (hasS256) {
      checks.push({
        id: 'auth-pkce-s256-supported',
        name: 'PKCE S256 Supported',
        description: 'Authorization Server supports S256 code challenge method',
        status: 'SUCCESS',
        timestamp: timestamp(),
        specReferences: [
          ServerAuthSpecReferences.RFC_7636_CODE_CHALLENGE,
          ServerAuthSpecReferences.OAUTH_2_1_PKCE
        ],
        details: {
          code_challenge_methods_supported: challengeMethods,
          s256_supported: true
        }
      });
    } else {
      checks.push({
        id: 'auth-pkce-s256-supported',
        name: 'PKCE S256 Supported',
        description: 'Authorization Server supports S256 code challenge method',
        status: 'FAILURE',
        timestamp: timestamp(),
        errorMessage:
          'S256 not in code_challenge_methods_supported - required for secure PKCE',
        specReferences: [
          ServerAuthSpecReferences.RFC_7636_CODE_CHALLENGE,
          ServerAuthSpecReferences.OAUTH_2_1_PKCE
        ],
        details: {
          code_challenge_methods_supported: challengeMethods,
          s256_supported: false
        }
      });
    }

    // Check: plain method (warning if present alone, or only method)
    if (hasPlain && !hasS256) {
      checks.push({
        id: 'auth-pkce-plain-only',
        name: 'PKCE Plain Method Only',
        description:
          'Check if only "plain" method is supported (security risk)',
        status: 'WARNING',
        timestamp: timestamp(),
        errorMessage:
          'Only "plain" PKCE method supported - S256 is recommended for security',
        specReferences: [ServerAuthSpecReferences.RFC_7636_CODE_CHALLENGE],
        details: {
          code_challenge_methods_supported: challengeMethods,
          plain_only: true
        }
      });
    } else if (hasPlain && hasS256) {
      checks.push({
        id: 'auth-pkce-plain-only',
        name: 'PKCE Plain Method Only',
        description:
          'Check if only "plain" method is supported (security risk)',
        status: 'INFO',
        timestamp: timestamp(),
        specReferences: [ServerAuthSpecReferences.RFC_7636_CODE_CHALLENGE],
        details: {
          code_challenge_methods_supported: challengeMethods,
          plain_available: true,
          s256_available: true,
          note: 'Both plain and S256 available - clients should use S256'
        }
      });
    }

    // Summary check
    if (hasS256) {
      checks.push({
        id: 'auth-pkce-ready',
        name: 'PKCE Ready',
        description: 'Authorization Server is ready for PKCE-protected flows',
        status: 'SUCCESS',
        timestamp: timestamp(),
        specReferences: [
          ServerAuthSpecReferences.RFC_7636_CODE_CHALLENGE,
          ServerAuthSpecReferences.OAUTH_2_1_PKCE
        ],
        details: {
          recommended_method: 'S256',
          available_methods: challengeMethods
        }
      });
    }

    return checks;
  }
}
