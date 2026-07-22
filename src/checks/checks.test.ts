import { createClientInitializationCheck } from './client';
import { DRAFT_PROTOCOL_VERSION } from '../types';

describe('createClientInitializationCheck', () => {
  it('should return SUCCESS for a valid initialize request', () => {
    const validRequest = {
      protocolVersion: '2025-06-18',
      clientInfo: {
        name: 'TestClient',
        version: '1.0.0'
      }
    };

    const check = createClientInitializationCheck(validRequest);
    expect(check.status).toBe('SUCCESS');
    expect(check.errorMessage).toBeUndefined();
  });

  it('should return FAILURE when protocol version is missing', () => {
    const invalidRequest = {
      clientInfo: {
        name: 'TestClient',
        version: '1.0.0'
      }
    };

    const check = createClientInitializationCheck(invalidRequest);
    expect(check.status).toBe('FAILURE');
    expect(check.errorMessage).toContain('Protocol version not provided');
  });

  it('should return FAILURE when protocol version does not match', () => {
    const invalidRequest = {
      protocolVersion: '2024-11-05',
      clientInfo: {
        name: 'TestClient',
        version: '1.0.0'
      }
    };

    const check = createClientInitializationCheck(invalidRequest);
    expect(check.status).toBe('FAILURE');
    expect(check.errorMessage).toContain('Version mismatch');
  });

  it('should return FAILURE when client name is missing', () => {
    const invalidRequest = {
      protocolVersion: '2025-06-18',
      clientInfo: {
        version: '1.0.0'
      }
    };

    const check = createClientInitializationCheck(invalidRequest);
    expect(check.status).toBe('FAILURE');
    expect(check.errorMessage).toContain("clientInfo needs a string 'name'");
  });

  it('should return FAILURE when client version is missing', () => {
    const invalidRequest = {
      protocolVersion: '2025-06-18',
      clientInfo: {
        name: 'TestClient'
      }
    };

    const check = createClientInitializationCheck(invalidRequest);
    expect(check.status).toBe('FAILURE');
    expect(check.errorMessage).toContain("clientInfo needs a string 'version'");
  });

  it('should accept the current draft protocol version', () => {
    const request = {
      protocolVersion: DRAFT_PROTOCOL_VERSION,
      clientInfo: { name: 'TestClient', version: '1.0.0' }
    };

    const check = createClientInitializationCheck(request);
    expect(check.status).toBe('SUCCESS');
    expect(check.errorMessage).toBeUndefined();
  });

  it.each(['DRAFT-2025-v1', 'draft'])(
    'should reject stale or non-canonical draft version %s',
    (protocolVersion) => {
      const request = {
        protocolVersion,
        clientInfo: { name: 'TestClient', version: '1.0.0' }
      };

      const check = createClientInitializationCheck(request);
      expect(check.status).toBe('FAILURE');
      expect(check.errorMessage).toContain('Version mismatch');
    }
  );

  // `Implementation` constrains `name` and `version` to be present strings and
  // says nothing about their content, so '' is a supplied field. Failing here
  // rejected a client the spec allows — and at FAILURE severity.
  it.each([
    ['version', { name: 'TestClient', version: '' }],
    ['name', { name: '', version: '1.0.0' }]
  ])('should accept an empty %s', (_field, clientInfo) => {
    const check = createClientInitializationCheck({
      protocolVersion: '2025-06-18',
      clientInfo
    });
    expect(check.status).toBe('SUCCESS');
    expect(check.errorMessage).toBeUndefined();
  });

  it('should return FAILURE when a clientInfo field is not a string', () => {
    const check = createClientInitializationCheck({
      protocolVersion: '2025-06-18',
      clientInfo: { name: 'TestClient', version: 1 }
    });
    expect(check.status).toBe('FAILURE');
    expect(check.errorMessage).toContain("clientInfo needs a string 'version'");
  });

  it('should report both fields when clientInfo is absent', () => {
    const check = createClientInitializationCheck({
      protocolVersion: '2025-06-18'
    });
    expect(check.status).toBe('FAILURE');
    expect(check.errorMessage).toContain("clientInfo needs a string 'name'");
    expect(check.errorMessage).toContain("clientInfo needs a string 'version'");
  });

  it('should support custom expected spec version', () => {
    const request = {
      protocolVersion: '2024-11-05',
      clientInfo: {
        name: 'TestClient',
        version: '1.0.0'
      }
    };

    const check = createClientInitializationCheck(request, '2024-11-05');
    expect(check.status).toBe('SUCCESS');
    expect(check.errorMessage).toBeUndefined();
  });
});
