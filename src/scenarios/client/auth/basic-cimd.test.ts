import { describe, it, expect } from 'vitest';
import { CIMD_CLIENT_METADATA_URL, isUrlClientId } from './basic-cimd';

describe('basic-cimd URL-based client ID', () => {
  it('accepts any https URL, not only the example metadata URL', () => {
    expect(isUrlClientId(CIMD_CLIENT_METADATA_URL)).toBe(true);
    // A real client publishes its own metadata document.
    expect(isUrlClientId('https://vscode.dev/oauth/client-metadata.json')).toBe(
      true
    );
  });

  it('still rejects a registered client id or a non-https URL', () => {
    expect(isUrlClientId(undefined)).toBe(false);
    expect(isUrlClientId('')).toBe(false);
    expect(isUrlClientId('dcr-issued-client-123')).toBe(false);
    expect(isUrlClientId('http://example.com/client-metadata.json')).toBe(
      false
    );
  });
});
