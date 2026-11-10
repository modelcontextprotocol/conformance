import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { testContext } from '../../connection/testing';
import { DRAFT_PROTOCOL_VERSION } from '../../types';
import {
  InputRequiredResultBasicElicitationScenario,
  InputRequiredResultBasicSamplingScenario,
  InputRequiredResultBasicListRootsScenario,
  InputRequiredResultRequestStateScenario,
  InputRequiredResultMultipleInputRequestsScenario,
  InputRequiredResultMultiRoundScenario,
  InputRequiredResultNonToolRequestScenario,
  InputRequiredResultTamperedStateScenario
} from './input-required-result';
import type { InputRequestObject } from './input-required-result-helpers';

const elicitation: InputRequestObject = {
  method: 'elicitation/create',
  params: {
    message: 'Confirm?',
    requestedSchema: { type: 'object', properties: {} }
  }
};
const sampling: InputRequestObject = {
  method: 'sampling/createMessage',
  params: {
    messages: [{ role: 'user', content: { type: 'text', text: 'Hello' } }],
    maxTokens: 10
  }
};
const roots: InputRequestObject = { method: 'roots/list', params: {} };

const retryCases = [
  {
    Scenario: InputRequiredResultRequestStateScenario,
    check: 'sep-2322-request-state-complete',
    input: elicitation
  },
  {
    Scenario: InputRequiredResultMultiRoundScenario,
    check: 'sep-2322-multi-round-r2',
    input: elicitation
  },
  {
    Scenario: InputRequiredResultNonToolRequestScenario,
    check: 'sep-2322-non-tool-complete',
    input: elicitation
  },
  {
    Scenario: InputRequiredResultTamperedStateScenario,
    check: 'sep-2322-reject-tampered-state',
    input: elicitation
  }
];
const fixtureCases = [
  {
    Scenario: InputRequiredResultBasicElicitationScenario,
    check: 'sep-2322-elicitation-incomplete',
    input: elicitation
  },
  {
    Scenario: InputRequiredResultBasicSamplingScenario,
    check: 'sep-2322-sampling-incomplete',
    input: sampling
  },
  {
    Scenario: InputRequiredResultBasicListRootsScenario,
    check: 'sep-2322-list-roots-incomplete',
    input: roots
  },
  {
    Scenario: InputRequiredResultMultipleInputRequestsScenario,
    check: 'sep-2322-multiple-inputs-incomplete',
    input: elicitation
  }
];

describe('InputRequiredResult input request prerequisites', () => {
  let server: Server;
  let serverUrl: string;
  let replies: Array<Record<string, unknown>>;
  let requests: Array<{
    method: string;
    params: { inputResponses?: Record<string, unknown>; requestState?: string };
  }>;

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      requests.push(request);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          ...(replies.shift() ?? {
            error: { code: -32603, message: 'Unexpected retry' }
          })
        })
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  });

  beforeEach(() => {
    replies = [];
    requests = [];
  });

  describe.each([
    { label: 'empty', fields: { inputRequests: {} } },
    { label: 'omitted', fields: {} }
  ])('$label inputRequests', ({ fields }) => {
    it.each([...retryCases, ...fixtureCases])(
      'reports $check as untestable without sending a retry',
      async ({ Scenario, check }) => {
        replies.push({
          result: {
            resultType: 'input_required',
            requestState: 'state-1',
            ...fields
          }
        });

        const checks = await new Scenario().run(
          testContext(serverUrl, DRAFT_PROTOCOL_VERSION)
        );

        expect(checks.filter((c) => c.id === check)).toEqual([
          expect.objectContaining({
            status: 'FAILURE',
            errorMessage: expect.stringMatching(
              /^Not testable:.*inputRequests/
            ),
            details: expect.objectContaining({ untestable: true })
          })
        ]);
        expect(
          checks
            .filter((c) => c.id !== check)
            .every((c) => c.status === 'SUCCESS')
        ).toBe(true);
        expect(requests).toHaveLength(1);
        expect(requests[0].params.inputResponses).toBeUndefined();
      }
    );

    it('stops before round 3 when round 2 names no input requests', async () => {
      replies.push(
        {
          result: {
            resultType: 'input_required',
            requestState: 'state-1',
            inputRequests: { step1: elicitation }
          }
        },
        {
          result: {
            resultType: 'input_required',
            requestState: 'state-2',
            ...fields
          }
        }
      );

      const checks = await new InputRequiredResultMultiRoundScenario().run(
        testContext(serverUrl, DRAFT_PROTOCOL_VERSION)
      );

      expect(checks.map((c) => [c.id, c.status])).toEqual([
        ['sep-2322-multi-round-r1', 'SUCCESS'],
        ['sep-2322-multi-round-r2', 'SUCCESS'],
        ['sep-2322-multi-round-r3', 'FAILURE']
      ]);
      expect(checks[2].details?.untestable).toBe(true);
      expect(checks[2].errorMessage).toMatch(/^Not testable:.*round 2/);
      expect(requests).toHaveLength(2);
      expect(Object.keys(requests[1].params.inputResponses ?? {})).toEqual([
        'step1'
      ]);
      expect(requests[1].params.requestState).toBe('state-1');
    });
  });

  describe.each(['', 'undefined'])('server-assigned key %j', (key) => {
    it.each([...retryCases, ...fixtureCases.slice(1, 3)])(
      'echoes the key when exercising $check',
      async ({ Scenario, input }) => {
        replies.push({
          result: {
            resultType: 'input_required',
            requestState: 'state-1',
            inputRequests: { [key]: input }
          }
        });
        if (Scenario === InputRequiredResultMultiRoundScenario) {
          replies.push({
            result: {
              resultType: 'input_required',
              requestState: 'state-2',
              inputRequests: { [key]: elicitation }
            }
          });
        }
        replies.push(
          Scenario === InputRequiredResultTamperedStateScenario
            ? { error: { code: -32602, message: 'Invalid requestState' } }
            : {
                result: {
                  resultType: 'complete',
                  ...(Scenario === InputRequiredResultNonToolRequestScenario
                    ? {
                        messages: [
                          {
                            role: 'user',
                            content: { type: 'text', text: 'Done' }
                          }
                        ]
                      }
                    : { content: [{ type: 'text', text: 'state-ok' }] })
                }
              }
        );

        const checks = await new Scenario().run(
          testContext(serverUrl, DRAFT_PROTOCOL_VERSION)
        );

        expect(checks.every((c) => c.status === 'SUCCESS')).toBe(true);
        expect(requests).toHaveLength(
          Scenario === InputRequiredResultMultiRoundScenario ? 3 : 2
        );
        for (const request of requests.slice(1)) {
          expect(Object.keys(request.params.inputResponses ?? {})).toEqual([
            key
          ]);
        }
        expect(requests[1].params.requestState).toBe(
          Scenario === InputRequiredResultTamperedStateScenario
            ? 'state-1-TAMPERED'
            : 'state-1'
        );
        if (requests.length === 3)
          expect(requests[2].params.requestState).toBe('state-2');
      }
    );
  });

  it.each(fixtureCases.slice(1, 3))(
    'keeps a wrong request method as an ordinary failure for $check',
    async ({ Scenario, check }) => {
      replies.push({
        result: {
          resultType: 'input_required',
          requestState: 'state-1',
          inputRequests: { confirm: elicitation }
        }
      });

      const checks = await new Scenario().run(
        testContext(serverUrl, DRAFT_PROTOCOL_VERSION)
      );

      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ id: check, status: 'FAILURE' });
      expect(checks[0].errorMessage).toContain('Expected method');
      expect(checks[0].details?.untestable).toBeUndefined();
      expect(requests).toHaveLength(1);
    }
  );
});
