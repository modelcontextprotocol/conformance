/**
 * SEP-1036: URL mode elicitation, server side.
 *
 * Targets the 2026-07-28 revision only. There, URL-mode requests travel inside
 * an InputRequiredResult (MRTR, SEP-2322), and the 2025-11-25 elicitationId,
 * notifications/elicitation/complete, and -32042 error no longer exist.
 *
 * The harness is the client. It calls the server's `test_url_elicitation`
 * tool while declaring different elicitation modes, and checks that:
 * - the URL-mode request carries mode, message, and a valid absolute url
 * - declining or cancelling the request still gets a well-formed answer
 * - a client without URL mode gets -32021 (HTTP 400) instead of a URL-mode
 *   request, and a URL-only client never gets a form-mode request
 * - the server never answers with the removed -32042 error
 */

import { fullFormats } from 'ajv-formats/dist/formats.js';
import type {
  ClientScenario,
  ConformanceCheck,
  SpecReference
} from '../../types';
import {
  sendStatelessRequest,
  type RunContext,
  type StatelessResponse
} from '../../connection';
import { STATELESS_SPEC_VERSIONS } from '../../connection/select';
import { isInputRequiredResult } from './input-required-result-helpers';
import { untestableCheck } from '../untestable';

const SPEC_VERSION = '2026-07-28';
const SPEC_BASE = `https://modelcontextprotocol.io/specification/${SPEC_VERSION}`;

const URL_MODE_REFERENCES: SpecReference[] = [
  {
    id: 'SEP-1036-URL-Mode-Requests',
    url: `${SPEC_BASE}/client/elicitation#url-mode-elicitation-requests`
  }
];
const CAPABILITIES_REFERENCES: SpecReference[] = [
  {
    id: 'SEP-1036-Capabilities',
    url: `${SPEC_BASE}/client/elicitation#capabilities`
  }
];
const ERROR_HANDLING_REFERENCES: SpecReference[] = [
  {
    id: 'SEP-1036-Error-Handling',
    url: `${SPEC_BASE}/client/elicitation#error-handling`
  }
];
const MISSING_CAPABILITY_REFERENCES: SpecReference[] = [
  { id: 'SEP-2575-Meta', url: `${SPEC_BASE}/basic/index#meta` }
];
const ERROR_CODES_REFERENCES: SpecReference[] = [
  { id: 'MCP-Error-Codes', url: `${SPEC_BASE}/basic/index#error-codes` }
];

/** The tool under test. It can only work through URL mode. */
const URL_TOOL = 'test_url_elicitation';

/** The SEP-2322 scenarios' form-mode tool, reused to probe a URL-only client. */
const FORM_TOOL = 'test_input_required_result_elicitation';

const MISSING_REQUIRED_CLIENT_CAPABILITY = -32021;
const INTERNAL_ERROR = -32603;
/** URLElicitationRequiredError, which exists in 2025-11-25 only. */
const URL_ELICITATION_REQUIRED = -32042;

/**
 * The schema's `format: uri` check (an absolute RFC 3986 URI), the same one
 * the wire validator applies.
 */
const isUri = fullFormats.uri as (value: string) => boolean;

/** One request the scenario sent, and what came back. */
interface Exchange {
  label: string;
  response?: StatelessResponse;
  /** Set when no HTTP response arrived (a timeout or a dropped connection). */
  transportError?: string;
}

type ElicitationParams = Record<string, unknown>;

function elicitationRequests(
  response: StatelessResponse | undefined
): Array<[string, ElicitationParams]> {
  const result = response?.body?.result;
  if (!isInputRequiredResult(result)) return [];
  return Object.entries(result.inputRequests ?? {})
    .filter(([, request]) => request.method === 'elicitation/create')
    .map(([key, request]) => [key, request.params ?? {}]);
}

/**
 * URL-mode requests, including one that carries a `url` but forgot
 * `mode: "url"` (which a client would read as form mode).
 */
function urlModeRequests(
  response: StatelessResponse | undefined
): Array<[string, ElicitationParams]> {
  return elicitationRequests(response).filter(
    ([, params]) =>
      params.mode === 'url' || (params.mode === undefined && 'url' in params)
  );
}

/** Form-mode requests: `mode: "form"`, or no mode and no url. */
function formModeRequests(
  response: StatelessResponse | undefined
): Array<[string, ElicitationParams]> {
  return elicitationRequests(response).filter(
    ([, params]) =>
      params.mode === 'form' ||
      (params.mode === undefined && !('url' in params))
  );
}

function summarize(exchange: Exchange): string {
  if (exchange.transportError) {
    return `no response (${exchange.transportError})`;
  }
  const { status, body } = exchange.response!;
  if (body?.error) {
    return `HTTP ${status} with error ${body.error.code} (${body.error.message})`;
  }
  if (body?.result) {
    return isInputRequiredResult(body.result)
      ? `HTTP ${status} with an InputRequiredResult`
      : `HTTP ${status} with a complete result`;
  }
  return `HTTP ${status} with no JSON-RPC response`;
}

export class ElicitationUrlModeScenario implements ClientScenario {
  name = 'elicitation-sep1036-url-mode';
  readonly source = { introducedIn: SPEC_VERSION } as const;
  description = `Tests server URL mode elicitation (SEP-1036) on the ${SPEC_VERSION} revision, where elicitation requests travel inside an InputRequiredResult (SEP-2322).

**Server Implementation Requirements:**

Implement a tool named \`${URL_TOOL}\` (no arguments) that can only work through URL mode:

1. If \`_meta["io.modelcontextprotocol/clientCapabilities"]\` does not declare \`elicitation.url\`, return a \`MissingRequiredClientCapabilityError\`: JSON-RPC error \`-32021\` with HTTP status 400 and \`data.requiredCapabilities\` set to \`{ "elicitation": { "url": {} } }\`.
2. Otherwise, when called without \`inputResponses\`, return an \`InputRequiredResult\` holding one URL-mode \`elicitation/create\` request:

\`\`\`json
{
  "resultType": "input_required",
  "inputRequests": {
    "connect_account": {
      "method": "elicitation/create",
      "params": {
        "mode": "url",
        "message": "Connect your account to continue.",
        "url": "https://example.com/connect"
      }
    }
  }
}
\`\`\`

3. When retried with an answer to that request, return a result. A \`decline\` or \`cancel\` must still get a well-formed answer, for example a tool result with \`isError: true\`.

The scenario also calls the SEP-2322 tool \`${FORM_TOOL}\` while declaring URL mode only, and expects no form-mode request back.`;

  async run(ctx: RunContext): Promise<ConformanceCheck[]> {
    // Speak the 2026-07-28 wire, or a later stateless revision if the runner
    // resolved one.
    const specVersion = STATELESS_SPEC_VERSIONS.includes(ctx.specVersion)
      ? ctx.specVersion
      : SPEC_VERSION;
    const call = async (
      label: string,
      tool: string,
      elicitation: Record<string, unknown>,
      extra: Record<string, unknown> = {}
    ): Promise<Exchange> => {
      try {
        const response = await sendStatelessRequest(
          ctx.serverUrl,
          'tools/call',
          {
            name: tool,
            arguments: {},
            ...extra,
            _meta: {
              'io.modelcontextprotocol/clientCapabilities': { elicitation }
            }
          },
          { specVersion }
        );
        return { label, response };
      } catch (error) {
        return {
          label,
          transportError: error instanceof Error ? error.message : String(error)
        };
      }
    };

    // Retry with an answer to the URL-mode request the first call returned.
    const answer = async (
      first: Exchange,
      action: 'decline' | 'cancel'
    ): Promise<Exchange | undefined> => {
      const [request] = urlModeRequests(first.response);
      if (!request) return undefined;
      const requestState = first.response?.body?.result?.requestState;
      return call(
        `${action} retry`,
        URL_TOOL,
        { form: {}, url: {} },
        {
          inputResponses: { [request[0]]: { action } },
          ...(requestState !== undefined && { requestState })
        }
      );
    };

    // The full declaration goes first: a server that remembers capabilities
    // from an earlier request would then send URL mode to the form-only
    // probes below.
    const declined = await call('form and URL mode declared', URL_TOOL, {
      form: {},
      url: {}
    });
    const declineRetry = await answer(declined, 'decline');
    const cancelled = await call(
      'form and URL mode declared (second call)',
      URL_TOOL,
      { form: {}, url: {} }
    );
    const cancelRetry = await answer(cancelled, 'cancel');

    // `elicitation: {}` means form mode only, the same as `{ form: {} }`.
    const formOnly = [
      await call('elicitation: {}', URL_TOOL, {}),
      await call('elicitation: { form: {} }', URL_TOOL, { form: {} })
    ];
    const urlOnly = await call('elicitation: { url: {} }', FORM_TOOL, {
      url: {}
    });

    // Without a working URL tool, an error to a form-only client can't be
    // told apart from a missing tool, so the capability checks would prove
    // nothing; they report the missing prerequisite instead.
    const toolMissing =
      urlModeRequests(declined.response).length === 0
        ? `${URL_TOOL} never sent a URL-mode request, even to a client that declared URL mode (it answered with ${summarize(declined)})`
        : undefined;

    return [
      this.urlRequestParamsCheck(declined),
      this.urlValidCheck(declined),
      this.declineCancelCheck([
        { first: declined, retry: declineRetry, action: 'decline' },
        { first: cancelled, retry: cancelRetry, action: 'cancel' }
      ]),
      this.noUnsupportedModeCheck(formOnly, urlOnly, toolMissing),
      ...this.missingCapabilityChecks(formOnly, toolMissing),
      this.noUrlElicitationRequiredCheck(
        [declined, declineRetry, cancelled, cancelRetry, ...formOnly, urlOnly],
        toolMissing
      )
    ];
  }

  private urlRequestParamsCheck(exchange: Exchange): ConformanceCheck {
    const requests = urlModeRequests(exchange.response);
    if (requests.length === 0) {
      return untestableCheck(
        'sep-1036-url-request-params',
        'UrlModeRequestParams',
        'URL mode elicitation requests MUST specify mode "url", a message, and a url',
        `${URL_TOOL} answered a client that declared URL mode with ${summarize(exchange)}, not a URL-mode request`,
        URL_MODE_REFERENCES
      );
    }

    const errors: string[] = [];
    for (const [key, params] of requests) {
      if (params.mode !== 'url') {
        errors.push(
          `'${key}' has a url but no mode "url"; a client treats a request without mode as form mode`
        );
      }
      if (typeof params.message !== 'string') {
        errors.push(`'${key}' has no string message`);
      }
      if (typeof params.url !== 'string') {
        errors.push(`'${key}' has no string url`);
      }
    }

    return {
      id: 'sep-1036-url-request-params',
      name: 'UrlModeRequestParams',
      description:
        'URL mode elicitation requests MUST specify mode "url", a message, and a url',
      status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
      timestamp: new Date().toISOString(),
      errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
      specReferences: URL_MODE_REFERENCES,
      details: { inputRequests: Object.fromEntries(requests) }
    };
  }

  private urlValidCheck(exchange: Exchange): ConformanceCheck {
    const requests = urlModeRequests(exchange.response).filter(
      ([, params]) => typeof params.url === 'string'
    );
    if (requests.length === 0) {
      return untestableCheck(
        'sep-1036-url-valid',
        'UrlModeRequestValidUrl',
        'The url parameter of a URL mode elicitation request MUST contain a valid URL',
        `${URL_TOOL} answered a client that declared URL mode with ${summarize(exchange)}, not a URL-mode request with a url`,
        URL_MODE_REFERENCES
      );
    }

    const errors = requests
      .filter(([, params]) => !isUri(params.url as string))
      .map(
        ([key, params]) =>
          `'${key}' has url ${JSON.stringify(params.url)}, which is not a valid absolute URI`
      );

    return {
      id: 'sep-1036-url-valid',
      name: 'UrlModeRequestValidUrl',
      description:
        'The url parameter of a URL mode elicitation request MUST contain a valid URL',
      status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
      timestamp: new Date().toISOString(),
      errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
      specReferences: URL_MODE_REFERENCES,
      details: {
        urls: Object.fromEntries(
          requests.map(([key, params]) => [key, params.url])
        )
      }
    };
  }

  private declineCancelCheck(
    flows: Array<{
      first: Exchange;
      retry: Exchange | undefined;
      action: 'decline' | 'cancel';
    }>
  ): ConformanceCheck {
    // Any well-formed answer is handling: a tool result (isError included),
    // another InputRequiredResult, or a deliberate JSON-RPC error. Only an
    // internal error, a timeout, or a dropped connection is not.
    const errors: string[] = [];
    const notExercised: string[] = [];
    for (const { first, retry, action } of flows) {
      if (!retry) {
        notExercised.push(
          `the ${action} flow: ${URL_TOOL} answered with ${summarize(first)}, not a URL-mode request`
        );
        continue;
      }
      const body = retry.response?.body;
      if (retry.transportError) {
        errors.push(
          `The ${action} retry got no response: ${retry.transportError}`
        );
      } else if (body?.error?.code === INTERNAL_ERROR) {
        errors.push(
          `The ${action} retry failed with an internal error (-32603): ${body.error.message}`
        );
      } else if (!body?.result && !body?.error) {
        errors.push(
          `The ${action} retry got HTTP ${retry.response!.status} with no JSON-RPC response`
        );
      }
    }

    if (errors.length === 0 && notExercised.length > 0) {
      return untestableCheck(
        'sep-2322-server-handles-decline-cancel',
        'ServerHandlesDeclineCancel',
        'Servers MUST handle cases where the user declines or cancels the elicitation',
        `Could not exercise ${notExercised.join('; ')}`,
        ERROR_HANDLING_REFERENCES
      );
    }

    return {
      id: 'sep-2322-server-handles-decline-cancel',
      name: 'ServerHandlesDeclineCancel',
      description:
        'Servers MUST handle cases where the user declines or cancels the elicitation',
      status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
      timestamp: new Date().toISOString(),
      errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
      specReferences: ERROR_HANDLING_REFERENCES,
      details: Object.fromEntries(
        flows.map(({ retry, action }) => [
          action,
          retry ? summarize(retry) : 'not exercised'
        ])
      )
    };
  }

  private noUnsupportedModeCheck(
    formOnly: Exchange[],
    urlOnly: Exchange,
    toolMissing: string | undefined
  ): ConformanceCheck {
    const errors: string[] = [];
    for (const exchange of formOnly) {
      const sent = urlModeRequests(exchange.response).map(([key]) => key);
      if (sent.length > 0) {
        errors.push(
          `With ${exchange.label} (form mode only), ${URL_TOOL} sent URL-mode request(s): ${sent.join(', ')}`
        );
      }
    }

    // The URL-only probe needs the SEP-2322 form tool. A server without it
    // answers with an error other than -32021, which exercises nothing.
    const urlOnlyError = urlOnly.response?.body?.error;
    const urlOnlyExercised =
      !urlOnly.transportError &&
      (urlOnlyError === undefined ||
        urlOnlyError.code === MISSING_REQUIRED_CLIENT_CAPABILITY);
    if (urlOnlyExercised) {
      const sent = formModeRequests(urlOnly.response).map(([key]) => key);
      if (sent.length > 0) {
        errors.push(
          `With ${urlOnly.label} (URL mode only), ${FORM_TOOL} sent form-mode request(s): ${sent.join(', ')}`
        );
      }
    }

    const formOnlyAnswered = formOnly.filter((e) => !e.transportError);
    if (errors.length === 0 && (toolMissing || formOnlyAnswered.length === 0)) {
      return untestableCheck(
        'sep-1036-server-no-unsupported-mode',
        'ServerNoUnsupportedElicitationMode',
        'Servers MUST NOT send elicitation requests with modes that are not supported by the client',
        toolMissing ??
          `${URL_TOOL} gave no response to any form-only probe: ${formOnly.map(summarize).join('; ')}`,
        CAPABILITIES_REFERENCES
      );
    }

    return {
      id: 'sep-1036-server-no-unsupported-mode',
      name: 'ServerNoUnsupportedElicitationMode',
      description:
        'Servers MUST NOT send elicitation requests with modes that are not supported by the client',
      status: errors.length === 0 ? 'SUCCESS' : 'FAILURE',
      timestamp: new Date().toISOString(),
      errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
      specReferences: CAPABILITIES_REFERENCES,
      details: {
        probes: Object.fromEntries(
          [...formOnly, urlOnly].map((e) => [e.label, summarize(e)])
        ),
        urlOnlyProbeExercised: urlOnlyExercised
      }
    };
  }

  private missingCapabilityChecks(
    formOnly: Exchange[],
    toolMissing: string | undefined
  ): ConformanceCheck[] {
    if (toolMissing) {
      return [
        untestableCheck(
          'sep-2575-server-rejects-undeclared-capability',
          'ServerRejectsUndeclaredUrlMode',
          'A tool that needs URL mode MUST return MissingRequiredClientCapabilityError (-32021) naming elicitation.url to a client without it',
          toolMissing,
          MISSING_CAPABILITY_REFERENCES
        ),
        untestableCheck(
          'sep-2575-missing-capability-http-400',
          'MissingUrlModeCapabilityHttp400',
          'MissingRequiredClientCapabilityError (-32021) MUST come with HTTP 400 Bad Request',
          toolMissing,
          MISSING_CAPABILITY_REFERENCES
        )
      ];
    }

    const codeErrors: string[] = [];
    const statusErrors: string[] = [];
    const rejected: Exchange[] = [];
    for (const exchange of formOnly) {
      if (exchange.transportError) continue;
      const error = exchange.response!.body?.error;
      if (error?.code !== MISSING_REQUIRED_CLIENT_CAPABILITY) {
        codeErrors.push(
          `With ${exchange.label}, ${URL_TOOL} answered ${summarize(exchange)} instead of -32021`
        );
        continue;
      }
      rejected.push(exchange);
      const requiredCapabilities = (
        error.data as Record<string, unknown> | undefined
      )?.requiredCapabilities as Record<string, unknown> | undefined;
      const elicitation = requiredCapabilities?.elicitation as
        | Record<string, unknown>
        | undefined;
      if (typeof elicitation?.url !== 'object' || elicitation.url === null) {
        codeErrors.push(
          `With ${exchange.label}, the -32021 error's data.requiredCapabilities does not name elicitation.url: ${JSON.stringify(error.data)}`
        );
      }
      if (exchange.response!.status !== 400) {
        statusErrors.push(
          `With ${exchange.label}, -32021 came with HTTP ${exchange.response!.status}`
        );
      }
    }

    const checks: ConformanceCheck[] = [];
    if (
      codeErrors.length === 0 &&
      formOnly.every((exchange) => exchange.transportError)
    ) {
      checks.push(
        untestableCheck(
          'sep-2575-server-rejects-undeclared-capability',
          'ServerRejectsUndeclaredUrlMode',
          'A tool that needs URL mode MUST return MissingRequiredClientCapabilityError (-32021) naming elicitation.url to a client without it',
          `${URL_TOOL} gave no response to any form-only probe`,
          MISSING_CAPABILITY_REFERENCES
        )
      );
    } else {
      checks.push({
        id: 'sep-2575-server-rejects-undeclared-capability',
        name: 'ServerRejectsUndeclaredUrlMode',
        description:
          'A tool that needs URL mode MUST return MissingRequiredClientCapabilityError (-32021) naming elicitation.url to a client without it',
        status: codeErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage: codeErrors.length > 0 ? codeErrors.join('; ') : undefined,
        specReferences: MISSING_CAPABILITY_REFERENCES,
        details: {
          probes: Object.fromEntries(
            formOnly.map((e) => [e.label, e.response?.body ?? summarize(e)])
          )
        }
      });
    }

    if (rejected.length === 0) {
      checks.push(
        untestableCheck(
          'sep-2575-missing-capability-http-400',
          'MissingUrlModeCapabilityHttp400',
          'MissingRequiredClientCapabilityError (-32021) MUST come with HTTP 400 Bad Request',
          `${URL_TOOL} never returned -32021, so its HTTP status could not be checked`,
          MISSING_CAPABILITY_REFERENCES
        )
      );
    } else {
      checks.push({
        id: 'sep-2575-missing-capability-http-400',
        name: 'MissingUrlModeCapabilityHttp400',
        description:
          'MissingRequiredClientCapabilityError (-32021) MUST come with HTTP 400 Bad Request',
        status: statusErrors.length === 0 ? 'SUCCESS' : 'FAILURE',
        timestamp: new Date().toISOString(),
        errorMessage:
          statusErrors.length > 0 ? statusErrors.join('; ') : undefined,
        specReferences: MISSING_CAPABILITY_REFERENCES,
        details: {
          statuses: Object.fromEntries(
            rejected.map((e) => [e.label, e.response!.status])
          )
        }
      });
    }
    return checks;
  }

  private noUrlElicitationRequiredCheck(
    exchanges: Array<Exchange | undefined>,
    toolMissing: string | undefined
  ): ConformanceCheck {
    const answered = exchanges.filter(
      (exchange): exchange is Exchange => exchange?.response !== undefined
    );
    const offenders = answered
      .filter(
        (exchange) =>
          exchange.response!.body?.error?.code === URL_ELICITATION_REQUIRED
      )
      .map((exchange) => exchange.label);

    // A server that never got as far as a URL-mode request hasn't been
    // exercised on the path where -32042 used to appear.
    if (offenders.length === 0 && (toolMissing || answered.length === 0)) {
      return untestableCheck(
        'sep-1036-server-no-url-elicitation-required-error',
        'ServerNoUrlElicitationRequiredError',
        'Implementations of 2026-07-28 MUST NOT emit -32042 (URL elicitation required, 2025-11-25 only)',
        toolMissing ?? 'No request in this scenario got a response',
        ERROR_CODES_REFERENCES
      );
    }

    return {
      id: 'sep-1036-server-no-url-elicitation-required-error',
      name: 'ServerNoUrlElicitationRequiredError',
      description:
        'Implementations of 2026-07-28 MUST NOT emit -32042 (URL elicitation required, 2025-11-25 only)',
      status: offenders.length === 0 ? 'SUCCESS' : 'FAILURE',
      timestamp: new Date().toISOString(),
      errorMessage:
        offenders.length > 0
          ? `The server answered with -32042 (URLElicitationRequiredError) for: ${offenders.join(', ')}. On 2026-07-28 a URL-mode request goes in an InputRequiredResult instead.`
          : undefined,
      specReferences: ERROR_CODES_REFERENCES,
      details: { requestsChecked: answered.map((exchange) => exchange.label) }
    };
  }
}
