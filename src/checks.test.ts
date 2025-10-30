import { createClientInitializationCheck } from './checks';

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
        expect(check.errorMessage).toContain('Client name missing');
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
        expect(check.errorMessage).toContain('Client version missing');
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
