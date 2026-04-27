/**
 * Authorization server metadata endpoint test scenarios for MCP authorization servers
 */
import {
  ClientScenarioForAuthorizationServer,
  ConformanceCheck,
  SpecVersion
} from '../../types';
import { request } from 'undici';

type Status = 'SUCCESS' | 'FAILURE';

export class AuthorizationServerMetadataEndpointScenario implements ClientScenarioForAuthorizationServer {
  name = 'authorization-server-metadata-endpoint';
  specVersions: SpecVersion[] = ['2025-03-26', '2025-06-18', '2025-11-25'];
  description = `Test authorization server metadata endpoint.

**Authorization Server Implementation Requirements:**

**Endpoint**: \`authorization server metadata\`

**Requirements**:
- HTTP response status code MUST be 200 OK
- Content-Type header MUST be application/json
- Return a JSON response including issuer, authorization_endpoint, token_endpoint and response_types_supported
- The issuer value MUST match the URI obtained by removing the well-known URI string from the authorization server metadata URI.`;

  async run(
    serverUrl: string,
    specVersion?: SpecVersion
  ): Promise<ConformanceCheck[]> {
    let status: Status = 'SUCCESS';
    let errorMessage: string | undefined;
    let details: any;
    let response: any | null = null;
    let body: Record<string, any> | undefined;
    try {
      const wellKnownUrls = this.createWellKnownUrl(serverUrl);

      for (const url of wellKnownUrls) {
        try {
          const checkResponse = await request(url, { method: 'GET' });
          if (checkResponse.statusCode === 200) {
            response = checkResponse;
            break;
          }
        } catch {
          // Ignore the error and proceed to the next loop.
        }
      }

      if (!response) {
        throw new Error(
          'All authorization server metadata endpoints returned invalid status code.'
        );
      }

      this.validateContentType(response.headers['content-type']);

      body = await this.parseJson(response);
      const errors: string[] = [];
      this.validateMetadataBody(body, serverUrl, errors);

      if (errors.length > 0) {
        status = 'FAILURE';
        errorMessage = errors.join(', ');
      }

      details = {
        contentType: response.headers['content-type'],
        body
      };
    } catch (error) {
      status = 'FAILURE';
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    const checks: ConformanceCheck[] = [
      {
        id: 'authorization-server-metadata',
        name: 'AuthorizationServerMetadata',
        description: 'Valid authorization server metadata response',
        status,
        timestamp: new Date().toISOString(),
        errorMessage,
        specReferences: [
          {
            id: 'Authorization-Server-Metadata',
            url: 'https://datatracker.ietf.org/doc/html/rfc8414'
          }
        ],
        ...(details ? { details } : {})
      }
    ];

    if (specVersion === '2025-11-25' && body) {
      const cimdSupported = body.client_id_metadata_document_supported;
      const cimdStatus: Status = cimdSupported === true ? 'SUCCESS' : 'FAILURE';
      const cimdErrorMessage =
        cimdSupported === true
          ? undefined
          : cimdSupported === undefined
            ? 'Authorization server metadata does not include "client_id_metadata_document_supported"'
            : `Expected "client_id_metadata_document_supported" to be true, got ${JSON.stringify(cimdSupported)}`;

      checks.push({
        id: 'authorization-server-metadata-cimd',
        name: 'AuthorizationServerMetadataCIMD',
        description:
          'Authorization server metadata includes client_id_metadata_document_supported=true',
        status: cimdStatus,
        timestamp: new Date().toISOString(),
        errorMessage: cimdErrorMessage,
        specReferences: [
          {
            id: 'IETF-OAuth-Client-ID-Metadata-Document',
            url: 'https://www.ietf.org/archive/id/draft-ietf-oauth-client-id-metadata-document-01.html#name-authorization-server-metada'
          }
        ],
        details: {
          client_id_metadata_document_supported: cimdSupported
        }
      });
    }

    return checks;
  }

  private createWellKnownUrl(serverUrl: string): string[] {
    const base = new URL(serverUrl);
    const origin = base.origin;
    const path = base.pathname.replace(/\/$/, '');

    const urls = new Set<string>();
    urls.add(`${origin}/.well-known/oauth-authorization-server${path}`);
    urls.add(`${origin}/.well-known/openid-configuration${path}`);
    urls.add(`${origin}${path}/.well-known/openid-configuration`);

    return Array.from(urls);
  }

  private validateContentType(contentType?: string | string[]): void {
    const valid =
      typeof contentType === 'string' &&
      contentType.toLowerCase().includes('application/json');

    if (!valid) {
      throw new Error(`Invalid Content-Type: ${contentType ?? '(missing)'}`);
    }
  }

  private async parseJson(response: any): Promise<Record<string, any>> {
    const body = await response.body.json();
    if (typeof body !== 'object' || body === null) {
      throw new Error('Response body is not an object');
    }
    return body;
  }

  private validateMetadataBody(
    body: Record<string, any>,
    serverUrl: string,
    errors: string[]
  ): void {
    this.assertString(
      body.authorization_endpoint,
      'authorization_endpoint',
      errors
    );
    this.assertString(body.token_endpoint, 'token_endpoint', errors);

    if (
      !Array.isArray(body.response_types_supported) ||
      !body.response_types_supported.includes('code')
    ) {
      errors.push(
        'Response body does not include valid "response_types_supported" claim'
      );
    }

    if (
      !Array.isArray(body.code_challenge_methods_supported) ||
      !body.code_challenge_methods_supported.includes('S256')
    ) {
      errors.push(
        'Response body does not include valid "code_challenge_methods_supported" claim'
      );
    }

    if (body.issuer !== serverUrl) {
      errors.push(`Invalid issuer: ${body.issuer ?? '(missing)'}`);
    }
  }

  private assertString(value: unknown, name: string, errors: string[]): void {
    if (typeof value !== 'string' || value.length === 0) {
      errors.push(`Response body does not include valid "${name}" claim`);
    }
  }
}
