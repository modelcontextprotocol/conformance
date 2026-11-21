/**
 * Shared helpers for the Resource-AS EMA scenarios (ISSUE-470). A scenario is
 * driven by a {@link ResourceAuthorizationServerOptions} settings object naming
 * a target Resource AS, plus a `details` bag through which the runner hands over
 * the live IdP Authorization Server(s) it hosts (the runner plays the Trusted —
 * and, for negative tests, an Untrusted — IdP AS). The IdP objects carry the
 * signing keys the scenario needs to mint ID-JAGs, which the settings (issuer
 * URLs only) cannot convey.
 */
import { request } from 'undici';
import { IdPAuthorizationServer } from '../auth/helpers/provideIdPAuthorizationServer';

/** `details` key under which the runner supplies the trusted IdP AS. */
export const TRUSTED_IDP_DETAIL = 'trustedIdp';
/** `details` key under which the runner supplies the untrusted IdP AS. */
export const UNTRUSTED_IDP_DETAIL = 'untrustedIdp';

/** Pull a runner-hosted IdP AS out of the scenario `details` bag, if present. */
export function getIdp(
  details: Record<string, unknown>,
  key: string
): IdPAuthorizationServer | undefined {
  const value = details[key];
  return value instanceof IdPAuthorizationServer ? value : undefined;
}

export interface ResourceAsEndpoints {
  /** Issuer identifier the ID-JAG `aud` must match (metadata `issuer`). */
  issuer: string;
  tokenEndpoint: string;
  introspectionEndpoint: string;
  metadata: Record<string, unknown>;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Fetch a Resource AS's server metadata from its issuer URL (well-known URI)
 * and resolve the token and introspection endpoints the ID-JAG flow needs.
 * Throws when the document is unreachable or omits a required endpoint.
 */
export async function discoverResourceAs(
  issuerUrl: string
): Promise<ResourceAsEndpoints> {
  const metadataUrl = `${trimTrailingSlash(issuerUrl)}/.well-known/oauth-authorization-server`;
  const response = await request(metadataUrl, { method: 'GET' });
  if (response.statusCode !== 200) {
    throw new Error(
      `Resource AS metadata endpoint ${metadataUrl} returned ${response.statusCode}`
    );
  }
  const metadata = (await response.body.json()) as Record<string, unknown>;
  const issuer =
    typeof metadata.issuer === 'string'
      ? metadata.issuer
      : trimTrailingSlash(issuerUrl);
  const tokenEndpoint = metadata.token_endpoint;
  const introspectionEndpoint = metadata.introspection_endpoint;
  if (typeof tokenEndpoint !== 'string') {
    throw new Error(
      `Resource AS metadata at ${metadataUrl} is missing "token_endpoint"`
    );
  }
  if (typeof introspectionEndpoint !== 'string') {
    throw new Error(
      `Resource AS metadata at ${metadataUrl} is missing "introspection_endpoint"`
    );
  }
  return { issuer, tokenEndpoint, introspectionEndpoint, metadata };
}
