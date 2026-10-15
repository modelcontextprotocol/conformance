/**
 * SEP-1036 URL mode elicitation, client side (2026-07-28).
 *
 * Positive: the everything-client passes every check.
 * Negative: inline clients that each break one requirement produce a FAILURE
 * for that check, and a client without URL mode is skipped, not failed.
 */
import { describe, test, expect } from 'vitest';
import {
  runClientAgainstScenario,
  InlineClientRunner
} from './auth/test_helpers/testClient';
import { getHandler } from '../../../examples/clients/typescript/everything-client';
import { ElicitationClientUrlModeScenario } from './elicitation-url-mode';
import { testScenarioContext } from '../../mock-server/testing';
import type { ConformanceCheck } from '../../types';

const SCENARIO = 'elicitation-sep1036-client-url-mode';
const SPEC_VERSION = '2026-07-28';

interface ClientOptions {
  /** The `elicitation` capability to declare. */
  elicitation?: unknown;
  /** Tools to call, in order. Defaults to every listed tool. */
  tools?: string[];
  /** Replaces the contract's answer. Return undefined to leave a request unanswered. */
  answer?: (
    params: Record<string, unknown>
  ) => Record<string, unknown> | undefined;
  /** Fetch every URL-mode URL as soon as the request arrives. */
  prefetch?: boolean;
  /** Resend the first retry's inputResponses on every later retry. */
  replayFirstAnswers?: boolean;
  /** Echo the first requestState on every later retry. */
  echoFirstState?: boolean;
  /** Abort any request that takes longer than this. */
  timeoutMs?: number;
}

/** The answers the scenario contract asks for. */
function contractAnswer(
  params: Record<string, unknown>
): Record<string, unknown> {
  if (params.mode === 'url') {
    return String(params.message).startsWith('DECLINE:')
      ? { action: 'decline' }
      : { action: 'accept' };
  }
  return { action: 'accept', content: { confirmed: true } };
}

/**
 * A minimal 2026-07-28 client that follows the scenario contract unless an
 * option breaks it.
 */
function urlModeClient(options: ClientOptions = {}) {
  return async (serverUrl: string): Promise<void> => {
    let nextId = 1;
    const send = async (
      method: string,
      params: Record<string, unknown>
    ): Promise<any> => {
      const id = nextId++;
      try {
        const response = await fetch(serverUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': SPEC_VERSION
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method,
            params: {
              ...params,
              _meta: {
                'io.modelcontextprotocol/protocolVersion': SPEC_VERSION,
                'io.modelcontextprotocol/clientInfo': {
                  name: 'url-mode-test-client',
                  version: '1.0.0'
                },
                'io.modelcontextprotocol/clientCapabilities': {
                  elicitation: options.elicitation ?? { form: {}, url: {} }
                }
              }
            }
          }),
          signal: options.timeoutMs
            ? AbortSignal.timeout(options.timeoutMs)
            : undefined
        });
        const text = await response.text();
        if (!response.headers.get('content-type')?.includes('event-stream')) {
          return JSON.parse(text);
        }
        return text
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => JSON.parse(line.slice('data:'.length)))
          .find((message) => message.id === id);
      } catch {
        // Timed out: give up on this call, as a client with a short timeout would.
        return undefined;
      }
    };

    const list = await send('tools/list', {});
    const tools: string[] =
      options.tools ??
      (list?.result?.tools ?? []).map((tool: { name: string }) => tool.name);

    for (const name of tools) {
      let params: Record<string, unknown> = { name, arguments: {} };
      let firstAnswers: Record<string, unknown> | undefined;
      let firstState: string | undefined;
      for (let attempt = 1; attempt <= 10; attempt++) {
        const result = (await send('tools/call', params))?.result;
        if (result?.resultType !== 'input_required') break;

        const inputResponses: Record<string, unknown> = {};
        for (const [key, request] of Object.entries(
          result.inputRequests as Record<
            string,
            { params: Record<string, unknown> }
          >
        )) {
          if (options.prefetch && request.params.mode === 'url') {
            await fetch(request.params.url as string);
          }
          const answer = (options.answer ?? contractAnswer)(request.params);
          if (answer !== undefined) inputResponses[key] = answer;
        }
        firstAnswers ??= inputResponses;
        firstState ??= result.requestState;

        params = {
          name,
          arguments: {},
          inputResponses: options.replayFirstAnswers
            ? firstAnswers
            : inputResponses,
          requestState: options.echoFirstState
            ? firstState
            : result.requestState
        };
      }
    }
  };
}

/** Run a client against a fresh scenario instance and return every check. */
async function runAgainstScenario(
  client: (serverUrl: string) => Promise<void>
): Promise<ConformanceCheck[]> {
  const scenario = new ElicitationClientUrlModeScenario();
  const { serverUrl } = await scenario.start(testScenarioContext(SPEC_VERSION));
  try {
    await client(serverUrl);
    return scenario.getChecks();
  } finally {
    await scenario.stop();
  }
}

function checkNamed(
  checks: ConformanceCheck[],
  name: string
): ConformanceCheck {
  const check = checks.find((c) => c.name === name);
  if (!check) throw new Error(`Check ${name} not emitted`);
  return check;
}

/** A FAILURE that reports a violation, not a missing prerequisite. */
function expectViolation(check: ConformanceCheck): void {
  expect(check.status, check.errorMessage).toBe('FAILURE');
  expect(check.details?.untestable).toBeUndefined();
}

describe('elicitation-sep1036-client-url-mode (SEP-1036)', () => {
  test('everything-client passes every check', async () => {
    const clientFn = getHandler(SCENARIO);
    if (!clientFn) {
      throw new Error(`No handler registered for scenario: ${SCENARIO}`);
    }
    await runClientAgainstScenario(new InlineClientRunner(clientFn), SCENARIO, {
      specVersion: SPEC_VERSION
    });
  }, 30000);

  test('a client that fetches a declined URL fails no-url-prefetch', async () => {
    const checks = await runAgainstScenario(
      urlModeClient({ tools: ['test_url_elicitation_decline'], prefetch: true })
    );
    expectViolation(checkNamed(checks, 'ClientNoUrlPrefetch'));
  });

  test('a client that remembers consent fails constructs-inputs on the third round', async () => {
    const checks = await runAgainstScenario(
      urlModeClient({
        tools: ['test_url_elicitation_rounds'],
        answer: (params) =>
          params.mode === 'url' ? { action: 'accept' } : contractAnswer(params)
      })
    );
    const check = checkNamed(checks, 'ClientConstructsInputsUrlRounds');
    expectViolation(check);
    expect(check.errorMessage).toContain('Round 3');
    expect(checkNamed(checks, 'ClientRequestStateEchoedUrlRounds').status).toBe(
      'SUCCESS'
    );
  });

  test('a client that resends its first answers fails constructs-inputs', async () => {
    const checks = await runAgainstScenario(
      urlModeClient({
        tools: ['test_url_elicitation_rounds'],
        replayFirstAnswers: true
      })
    );
    const check = checkNamed(checks, 'ClientConstructsInputsUrlRounds');
    expectViolation(check);
    expect(check.errorMessage).toContain("did not answer 'connect_service_b'");
  });

  test('a client that echoes a stale requestState fails request-state-echoed', async () => {
    const checks = await runAgainstScenario(
      urlModeClient({
        tools: ['test_url_elicitation_rounds'],
        echoFirstState: true
      })
    );
    const check = checkNamed(checks, 'ClientRequestStateEchoedUrlRounds');
    expectViolation(check);
    expect(check.errorMessage).toContain('requestState from round 1');
    expect(checkNamed(checks, 'ClientConstructsInputsUrlRounds').status).toBe(
      'SUCCESS'
    );
  });

  test('a client that answers only the URL request fails constructs-inputs-mixed', async () => {
    const checks = await runAgainstScenario(
      urlModeClient({
        tools: ['test_url_elicitation_mixed'],
        answer: (params) =>
          params.mode === 'form' ? undefined : contractAnswer(params)
      })
    );
    expectViolation(checkNamed(checks, 'ClientConstructsInputsMixedModes'));
  });

  test('a client that treats a request without mode as URL mode fails missing-mode-is-form', async () => {
    const checks = await runAgainstScenario(
      urlModeClient({
        tools: ['test_elicitation_no_mode'],
        // Picks URL mode because the request carries a url field.
        answer: (params) =>
          params.mode === undefined && params.url !== undefined
            ? { action: 'accept' }
            : contractAnswer(params)
      })
    );
    expectViolation(checkNamed(checks, 'ClientMissingModeIsForm'));
  });

  test('a client that times out held retries fails both held-retry gates', async () => {
    const checks = await runAgainstScenario(
      urlModeClient({
        tools: [
          'test_url_elicitation_held_json',
          'test_url_elicitation_held_sse'
        ],
        timeoutMs: 1000
      })
    );
    expectViolation(checkNamed(checks, 'ClientHeldJsonRetryComplete'));
    expectViolation(checkNamed(checks, 'ClientHeldSseRetryComplete'));
  });

  test('a client declaring elicitation with neither mode fails supports-declared-mode', async () => {
    const checks = await runAgainstScenario(
      urlModeClient({ elicitation: { bogus: {} }, tools: [] })
    );
    expectViolation(checkNamed(checks, 'ClientDeclaresElicitationMode'));
  });

  test('a form-only client is skipped for URL mode, not failed', async () => {
    const checks = await runAgainstScenario(urlModeClient({ elicitation: {} }));
    for (const name of [
      'ClientConstructsInputsUrlRounds',
      'ClientRequestStateEchoedUrlRounds',
      'ClientConstructsInputsMixedModes',
      'ClientNoUrlPrefetch',
      'ClientHeldJsonRetryComplete',
      'ClientHeldSseRetryComplete'
    ]) {
      expect(checkNamed(checks, name).status, name).toBe('SKIPPED');
    }
    expect(checkNamed(checks, 'ClientDeclaresElicitationMode').status).toBe(
      'SUCCESS'
    );
    expect(checkNamed(checks, 'ClientMissingModeIsForm').status).toBe(
      'SUCCESS'
    );
  });

  test('a client that never calls the tools fails as untestable', async () => {
    const checks = await runAgainstScenario(urlModeClient({ tools: [] }));
    for (const name of [
      'ClientConstructsInputsUrlRounds',
      'ClientRequestStateEchoedUrlRounds',
      'ClientConstructsInputsMixedModes',
      'ClientMissingModeIsForm',
      'ClientNoUrlPrefetch',
      'ClientHeldJsonRetryComplete',
      'ClientHeldSseRetryComplete'
    ]) {
      const check = checkNamed(checks, name);
      expect(check.status, name).toBe('FAILURE');
      expect(check.details?.untestable, name).toBe(true);
    }
  });
});
