import { createServer, Server } from 'http';
import { testContext } from '../../connection/testing';
import {
  InputRequiredResultUnsupportedMethodsScenario,
  InputRequiredResultValidateInputScenario
} from './input-required-result';

// #451: a server that rejects every request with the same unrelated error
// used to score two scored 2026-07-28 scenarios fully green:
// input-required-result-validate-input, whose checks accept any JSON-RPC
// error as proof of input validation, and
// input-required-result-unsupported-methods, whose MUST NOT is never
// exercised when every probe is rejected.
describe('SEP-2322 scenarios against a server that rejects everything', () => {
  let server: Server;
  let SERVER_URL: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        let id: unknown = null;
        try {
          id = JSON.parse(body).id ?? null;
        } catch {
          // keep id null
        }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32000,
              message: 'Bad Request: Server not initialized'
            }
          })
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    SERVER_URL = `http://localhost:${port}/mcp`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('validate-input reports both checks as not testable instead of SUCCESS', async () => {
    const scenario = new InputRequiredResultValidateInputScenario();
    const checks = await scenario.run(testContext(SERVER_URL));

    expect(checks.map((c) => c.id).sort()).toEqual([
      'sep-2322-error-on-protocol-error',
      'sep-2322-validate-input-responses'
    ]);
    for (const check of checks) {
      expect(check.status).toBe('WARNING');
      expect(check.errorMessage).toContain('Not testable:');
      expect(check.errorMessage).toContain('-32000');
      expect(check.details?.untestable).toBe(true);
    }
  }, 10000);

  it('unsupported-methods reports its check as not testable instead of SUCCESS', async () => {
    const scenario = new InputRequiredResultUnsupportedMethodsScenario();
    const checks = await scenario.run(testContext(SERVER_URL));

    expect(checks).toHaveLength(1);
    expect(checks[0].id).toBe('sep-2322-not-on-unsupported-requests');
    expect(checks[0].status).toBe('FAILURE');
    expect(checks[0].errorMessage).toContain('Not testable:');
    expect(checks[0].errorMessage).toContain('tools/list');
    expect(checks[0].errorMessage).toContain('prompts/list');
    expect(checks[0].details?.untestable).toBe(true);
  }, 10000);
});
