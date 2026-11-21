/**
 * Scenario 1 for the Resource-AS side of Enterprise-Managed Authorization
 * (ISSUE-470): verify a Resource Authorization Server's server metadata
 * advertises ID-JAG support.
 *
 * A real Resource AS is not available as a test target, so the runner drives
 * the mock Resource AS (`../auth/helpers/mockResourceAuthorizationServer`),
 * retrieves its metadata over HTTP, and checks that it declares the ID-JAG
 * grant profile and the JWT-bearer grant type (EMA §6 Discovery /
 * draft-ietf-oauth-identity-assertion-authz-grant §7.2).
 */
import { request } from 'undici';
import type {
  ConformanceCheck,
  ScenarioForResourceAuthorizationServer,
  ScenarioSource
} from '../../../types';
import type { ResourceAuthorizationServerOptions } from '../../../schemas';
import {
  ID_JAG_GRANT_PROFILE,
  JWT_BEARER_GRANT_TYPE
} from '../auth/helpers/mockResourceAuthorizationServer';
import { SpecReferences as SPEC_REFERENCES } from '../auth/spec-references';

const EMA_SOURCE: ScenarioSource = {
  extensionId: 'io.modelcontextprotocol/enterprise-managed-authorization'
};

/**
 * Normalize a metadata claim that may be a single string or an array of
 * strings into a string list. Returns undefined when the claim is absent or
 * not a string / array-of-strings.
 */
function asStringList(claim: unknown): string[] | undefined {
  if (typeof claim === 'string') {
    return [claim];
  }
  if (Array.isArray(claim) && claim.every((v) => typeof v === 'string')) {
    return claim as string[];
  }
  return undefined;
}

/**
 * Run the four Resource-AS metadata checks against a parsed metadata document.
 * Exported so tests can exercise the logic without an HTTP round-trip.
 */
export function checkResourceServerMetadata(
  body: Record<string, unknown>
): ConformanceCheck[] {
  const checks: ConformanceCheck[] = [];
  const timestamp = () => new Date().toISOString();

  // 1. authorization_grant_profiles_supported is present (string or array).
  const grantProfilesClaim = body.authorization_grant_profiles_supported;
  const grantProfiles = asStringList(grantProfilesClaim);
  const grantProfilesPresent = grantProfiles !== undefined;
  checks.push({
    id: 'resource-as-metadata-grant-profiles-supported',
    name: 'ResourceAsMetadataGrantProfilesSupported',
    description:
      'Resource AS metadata includes "authorization_grant_profiles_supported" as a string or array of strings (EMA §6)',
    status: grantProfilesPresent ? 'SUCCESS' : 'FAILURE',
    timestamp: timestamp(),
    errorMessage: grantProfilesPresent
      ? undefined
      : `Missing or non-string "authorization_grant_profiles_supported": ${JSON.stringify(grantProfilesClaim)}`,
    specReferences: [
      SPEC_REFERENCES.EMA_DISCOVERY,
      SPEC_REFERENCES.ID_JAG_DISCOVERY
    ],
    details: { authorization_grant_profiles_supported: grantProfilesClaim }
  });

  // 2. authorization_grant_profiles_supported includes the ID-JAG profile.
  const idJagProfileIncluded =
    grantProfiles?.includes(ID_JAG_GRANT_PROFILE) ?? false;
  checks.push({
    id: 'resource-as-metadata-id-jag-grant-profile',
    name: 'ResourceAsMetadataIdJagGrantProfile',
    description: `Resource AS metadata "authorization_grant_profiles_supported" includes "${ID_JAG_GRANT_PROFILE}" (EMA §6)`,
    status: idJagProfileIncluded ? 'SUCCESS' : 'FAILURE',
    timestamp: timestamp(),
    errorMessage: idJagProfileIncluded
      ? undefined
      : `"authorization_grant_profiles_supported" does not include "${ID_JAG_GRANT_PROFILE}": ${JSON.stringify(grantProfilesClaim)}`,
    specReferences: [
      SPEC_REFERENCES.EMA_DISCOVERY,
      SPEC_REFERENCES.ID_JAG_DISCOVERY
    ],
    details: { authorization_grant_profiles_supported: grantProfilesClaim }
  });

  // 3. grant_types_supported is present and an array of strings.
  const grantTypesClaim = body.grant_types_supported;
  const grantTypesIsArray =
    Array.isArray(grantTypesClaim) &&
    grantTypesClaim.every((v) => typeof v === 'string');
  checks.push({
    id: 'resource-as-metadata-grant-types-supported',
    name: 'ResourceAsMetadataGrantTypesSupported',
    description:
      'Resource AS metadata includes "grant_types_supported" as an array of strings (RFC 8414 §2)',
    status: grantTypesIsArray ? 'SUCCESS' : 'FAILURE',
    timestamp: timestamp(),
    errorMessage: grantTypesIsArray
      ? undefined
      : `Missing or non-array "grant_types_supported": ${JSON.stringify(grantTypesClaim)}`,
    specReferences: [SPEC_REFERENCES.RFC_7523],
    details: { grant_types_supported: grantTypesClaim }
  });

  // 4. grant_types_supported includes the JWT-bearer grant type.
  const jwtBearerIncluded =
    grantTypesIsArray &&
    (grantTypesClaim as string[]).includes(JWT_BEARER_GRANT_TYPE);
  checks.push({
    id: 'resource-as-metadata-jwt-bearer-grant-type',
    name: 'ResourceAsMetadataJwtBearerGrantType',
    description: `Resource AS metadata "grant_types_supported" includes "${JWT_BEARER_GRANT_TYPE}" (RFC 7523)`,
    status: jwtBearerIncluded ? 'SUCCESS' : 'FAILURE',
    timestamp: timestamp(),
    errorMessage: jwtBearerIncluded
      ? undefined
      : `"grant_types_supported" does not include "${JWT_BEARER_GRANT_TYPE}": ${JSON.stringify(grantTypesClaim)}`,
    specReferences: [SPEC_REFERENCES.RFC_7523],
    details: { grant_types_supported: grantTypesClaim }
  });

  return checks;
}

async function fetchResourceServerMetadata(
  metadataUrl: string
): Promise<Record<string, unknown>> {
  const response = await request(metadataUrl, { method: 'GET' });
  return (await response.body.json()) as Record<string, unknown>;
}

/**
 * Scenario 1: verify the Resource AS server metadata.
 *
 * Discovers the target Resource AS from {@link
 * ResourceAuthorizationServerOptions.url} (well-known URI), retrieves its
 * metadata over HTTP, and validates the ID-JAG discovery fields.
 */
export class ResourceServerMetadataScenario implements ScenarioForResourceAuthorizationServer {
  name = 'ema/resource-authorization-server/metadata';
  readonly source = EMA_SOURCE;
  description =
    'EMA: the Resource AS server metadata advertises the id-jag grant profile (authorization_grant_profiles_supported) and the jwt-bearer grant type (grant_types_supported).';

  async run(
    options: ResourceAuthorizationServerOptions,
    _details: Record<string, unknown>
  ): Promise<ConformanceCheck[]> {
    const base = options.url.endsWith('/')
      ? options.url.slice(0, -1)
      : options.url;
    const metadataUrl = `${base}/.well-known/oauth-authorization-server`;
    const body = await fetchResourceServerMetadata(metadataUrl);
    return checkResourceServerMetadata(body);
  }
}
