/**
 * Per-spec-version JSON-schema validation of wire messages.
 *
 * JSON-RPC messages the harness sends or receives are validated against the
 * vendored spec `schema.json` for the run's spec version (see
 * `src/spec-types/{version}.schema.json`, synced by `scripts/sync-schema.ts`).
 *
 * Coverage: the stateless wire (`sendStatelessRequest` — outbound requests,
 * JSON response bodies, SSE events), the stateful wire (the SDK transport
 * hook in `src/connection/sdk-client.ts` — both directions, including the
 * initialize handshake and server→client elicitation/sampling traffic), and
 * the mock servers driving client conformance (`src/mock-server/*`). Known
 * gap: the client-auth scenarios' bespoke express mock
 * (`src/scenarios/client/auth/helpers/createServer.ts`) is not instrumented.
 *
 * This catches two failure classes:
 *
 * - `implementation` origin: the system-under-test emitted a message the spec
 *   schema forbids → surfaced as a failing `wire-schema-valid` check.
 * - `harness` origin: the harness itself (hand-built requests, mock-server
 *   responses, fixture results) emitted an invalid message → surfaced as a
 *   `wire-schema-harness-error` check and failed loudly in the vitest suite
 *   (see `vitest-hooks.ts`), so scenario checks can never expect a message
 *   shape the schema forbids (the "schema hallucination" bug class, #376).
 *
 * Validation depth, per message:
 * 1. The `JSONRPCMessage` envelope definition.
 * 2. Requests/notifications with a `method` the schema types via a `const`
 *    (e.g. `tools/call` → `CallToolRequest`) against that definition.
 * 3. Error responses whose `error.code` the schema types via a `const`
 *    (e.g. -32021 → `MissingRequiredClientCapabilityError`).
 * 4. Results, when the caller knows the request method, against the
 *    `XxxRequest` → `XxxResult` definition pair (skipped when the schema has
 *    no result type for the method, e.g. `ping`).
 *
 * Call sites that intentionally send malformed traffic opt out per call
 * (`skipValidation`); tests that intentionally elicit invalid messages drain
 * the recorder via `takeWireViolations()`. Both are explicit and greppable.
 */

import { Ajv, type ValidateFunction, type ErrorObject } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { default as addFormats } from 'ajv-formats';
import {
  DRAFT_PROTOCOL_VERSION,
  type ConformanceCheck,
  type SpecVersion
} from '../types';
import schema2025_03_26 from '../spec-types/2025-03-26.schema.json';
import schema2025_06_18 from '../spec-types/2025-06-18.schema.json';
import schema2025_11_25 from '../spec-types/2025-11-25.schema.json';
import schemaDraft from '../spec-types/draft.schema.json';

export type WireOrigin = 'harness' | 'implementation';

export interface WireMessageInfo {
  /** Who authored the message: the harness or the implementation-under-test. */
  origin: WireOrigin;
  /** Human-readable location, e.g. `stateless request 'tools/call'`. */
  context: string;
  /**
   * For responses: the method of the request being answered, so the result
   * can be validated against its typed result definition.
   */
  requestMethod?: string;
}

export interface WireSchemaViolation {
  origin: WireOrigin;
  specVersion: SpecVersion;
  context: string;
  errors: string[];
  message: unknown;
}

const SCHEMAS: Record<SpecVersion, Record<string, unknown>> = {
  '2025-03-26': schema2025_03_26,
  '2025-06-18': schema2025_06_18,
  '2025-11-25': schema2025_11_25,
  [DRAFT_PROTOCOL_VERSION]: schemaDraft
};

/** Spec-repo directory name for a version (the draft is pinned unversioned). */
export function schemaDirFor(specVersion: SpecVersion): string {
  return specVersion === DRAFT_PROTOCOL_VERSION ? 'draft' : specVersion;
}

/**
 * Union definitions that alias a single concrete type (and so carry a
 * `method` const) but are not the canonical definition for that method.
 */
const NON_CANONICAL_DEFS = new Set([
  'ClientRequest',
  'ClientNotification',
  'ClientResult',
  'ClientMessage',
  'ServerRequest',
  'ServerNotification',
  'ServerResult',
  'ServerMessage'
]);

interface CompiledSpec {
  defsKey: '$defs' | 'definitions';
  defs: Record<string, Record<string, unknown>>;
  /** JSON-RPC method → canonical request/notification definition name. */
  methodDefs: Map<string, string>;
  /** `error.code` const → typed error-response definition name. */
  errorDefs: Map<number, string>;
  /** JSON-RPC method → typed result definition name. */
  resultDefs: Map<string, string>;
  validatorFor(defName: string): ValidateFunction;
}

const compiledSpecs = new Map<SpecVersion, CompiledSpec>();

function compileSpec(specVersion: SpecVersion): CompiledSpec {
  let compiled = compiledSpecs.get(specVersion);
  if (compiled) return compiled;

  const schema = SCHEMAS[specVersion];
  const is2020 =
    typeof schema.$schema === 'string' && schema.$schema.includes('2020-12');
  // The spec schemas are not authored for ajv strict mode; validate them
  // as-is rather than editing vendored files.
  const options = { strict: false, allErrors: true } as const;
  const ajv = is2020 ? new Ajv2020(options) : new Ajv(options);
  addFormats(ajv);
  // "byte" (base64) is an OpenAPI format ajv-formats doesn't ship; the spec
  // uses it on blob contents. Accept any string rather than reimplementing it.
  ajv.addFormat('byte', true);

  const schemaId = `mcp://${schemaDirFor(specVersion)}/schema.json`;
  ajv.addSchema({ ...schema, $id: schemaId });

  const defsKey: '$defs' | 'definitions' =
    '$defs' in schema ? '$defs' : 'definitions';
  const defs = schema[defsKey] as Record<string, Record<string, unknown>>;

  const methodDefs = new Map<string, string>();
  const errorDefs = new Map<number, string>();
  const resultDefs = new Map<string, string>();
  for (const [name, def] of Object.entries(defs)) {
    if (NON_CANONICAL_DEFS.has(name)) continue;
    const props = (def.properties ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    const method = props.method?.const;
    if (typeof method === 'string') {
      methodDefs.set(method, name);
      if (name.endsWith('Request')) {
        const resultName = `${name.slice(0, -'Request'.length)}Result`;
        if (resultName in defs) resultDefs.set(method, resultName);
      }
    }
    const errorProp = props.error as
      | { allOf?: { properties?: { code?: { const?: unknown } } }[] }
      | undefined;
    for (const part of errorProp?.allOf ?? []) {
      const code = part.properties?.code?.const;
      if (typeof code === 'number') errorDefs.set(code, name);
    }
  }

  const validators = new Map<string, ValidateFunction>();
  compiled = {
    defsKey,
    defs,
    methodDefs,
    errorDefs,
    resultDefs,
    validatorFor(defName: string): ValidateFunction {
      let v = validators.get(defName);
      if (!v) {
        v = ajv.compile({ $ref: `${schemaId}#/${defsKey}/${defName}` });
        validators.set(defName, v);
      }
      return v;
    }
  };
  compiledSpecs.set(specVersion, compiled);
  return compiled;
}

/**
 * The dispatch maps extracted from a version's schema: JSON-RPC method →
 * typed request/notification definition, and `error.code` const → typed
 * error-response definition. Exposed so a unit test can pin the expected
 * contents per version — if a schema sync changes the structure the
 * extraction walks (`properties.method.const`,
 * `properties.error.allOf[].properties.code.const`), validation would
 * silently degrade to envelope-only; the pinning test makes that loud.
 */
export function specDispatchMaps(specVersion: SpecVersion): {
  methodDefs: ReadonlyMap<string, string>;
  errorDefs: ReadonlyMap<number, string>;
  resultDefs: ReadonlyMap<string, string>;
} {
  const spec = compileSpec(specVersion);
  return {
    methodDefs: spec.methodDefs,
    errorDefs: spec.errorDefs,
    resultDefs: spec.resultDefs
  };
}

function formatErrors(
  defName: string,
  errors: ErrorObject[] | null | undefined
): string[] {
  const MAX = 6;
  const formatted = (errors ?? []).map(
    (e) =>
      `${defName}${e.instancePath || ''}: ${e.message ?? 'invalid'}` +
      (e.keyword === 'const' || e.keyword === 'enum'
        ? ` (${JSON.stringify(e.params)})`
        : '')
  );
  if (formatted.length > MAX) {
    return [
      ...formatted.slice(0, MAX),
      `... ${formatted.length - MAX} more error(s)`
    ];
  }
  return formatted.length > 0 ? formatted : [`${defName}: invalid`];
}

/**
 * Validate a single JSON-RPC message against the given spec version's schema.
 * Returns `[]` when the message is valid. Pure — does not touch the recorder.
 */
export function wireSchemaErrors(
  specVersion: SpecVersion,
  message: unknown,
  requestMethod?: string
): string[] {
  const spec = compileSpec(specVersion);
  const validateAgainst = (defName: string, value: unknown): string[] => {
    const validate = spec.validatorFor(defName);
    return validate(value) ? [] : formatErrors(defName, validate.errors);
  };
  const firstDef = (...names: string[]): string =>
    names.find((n) => n in spec.defs) ?? names[names.length - 1];

  if (Array.isArray(message)) {
    // A batch: only legal where the envelope union admits arrays (2025-03-26).
    // Limitation: `requestMethod` is forwarded to every element, so a batch
    // mixing responses to different requests would validate all of them
    // against one result type — no caller sends batched requests today.
    const elementErrors = message.flatMap((m, i) =>
      wireSchemaErrors(specVersion, m, requestMethod).map((e) => `[${i}] ${e}`)
    );
    if (elementErrors.length > 0) return elementErrors;
    if (validateAgainst('JSONRPCMessage', message).length > 0) {
      return [
        'JSONRPCMessage: batch arrays are not valid in this spec version'
      ];
    }
    return [];
  }

  const msg = (
    typeof message === 'object' && message !== null ? message : {}
  ) as Record<string, unknown>;

  // Classify the message and validate against the most specific definition
  // the schema has for it. The typed definitions include the envelope
  // requirements (jsonrpc, id, method, ...), so they subsume the union check.
  if (typeof msg.method === 'string') {
    const defName =
      spec.methodDefs.get(msg.method) ??
      ('id' in msg ? 'JSONRPCRequest' : 'JSONRPCNotification');
    return validateAgainst(defName, message);
  }

  if (msg.error !== undefined && msg.error !== null) {
    const code = (msg.error as Record<string, unknown>).code;
    const defName =
      (typeof code === 'number' ? spec.errorDefs.get(code) : undefined) ??
      firstDef('JSONRPCErrorResponse', 'JSONRPCError');
    return validateAgainst(defName, message);
  }

  if (msg.result !== undefined) {
    // SEP-2322 (MRTR): any request may be answered with an InputRequiredResult
    // instead of its method's result type; discriminate on resultType.
    const inputRequired =
      (msg.result as Record<string, unknown> | null)?.resultType ===
        'input_required' && 'InputRequiredResult' in spec.defs;
    const resultDefName = inputRequired
      ? 'InputRequiredResult'
      : requestMethod !== undefined
        ? spec.resultDefs.get(requestMethod)
        : undefined;
    if (resultDefName) {
      const typed = validateAgainst(resultDefName, msg.result).map(
        (e) => `${e} (result of '${requestMethod}')`
      );
      if (typed.length > 0) return typed;
    }
    return validateAgainst(
      firstDef('JSONRPCResultResponse', 'JSONRPCResponse'),
      message
    );
  }

  return [
    'JSONRPCMessage: not a valid JSON-RPC request, notification, or response'
  ];
}

// ---------------------------------------------------------------------------
// Recorder: choke points record every message; runners (and the vitest hook)
// drain the accumulated violations per scenario / test.
// ---------------------------------------------------------------------------

let violations: WireSchemaViolation[] = [];
let observed = 0;

/** Validate a wire message and record any violation. Called by choke points. */
export function validateWireMessage(
  specVersion: SpecVersion,
  message: unknown,
  info: WireMessageInfo
): void {
  observed++;
  const errors = wireSchemaErrors(specVersion, message, info.requestMethod);
  if (errors.length > 0) {
    violations.push({
      origin: info.origin,
      specVersion,
      context: info.context,
      errors,
      message
    });
  }
}

export function resetWireValidation(): void {
  violations = [];
  observed = 0;
}

/** Return everything recorded since the last reset, and reset. */
export function takeWireViolations(): {
  violations: WireSchemaViolation[];
  observed: number;
} {
  const result = { violations, observed };
  resetWireValidation();
  return result;
}

function violationDetails(v: WireSchemaViolation): Record<string, unknown> {
  return {
    origin: v.origin,
    specVersion: v.specVersion,
    context: v.context,
    errors: v.errors,
    message: v.message
  };
}

export function formatWireViolation(v: WireSchemaViolation): string {
  return (
    `[${v.origin}] ${v.context} (spec ${v.specVersion}): ` +
    `${v.errors.join('; ')} — message: ${JSON.stringify(v.message)}`
  );
}

/**
 * Drain the recorder and synthesize the per-scenario conformance checks.
 * Returns `[]` when no wire traffic was observed (e.g. a scenario that only
 * asserts on HTTP mechanics via raw fetch).
 */
export function wireSchemaChecks(specVersion: SpecVersion): ConformanceCheck[] {
  const { violations: all, observed: count } = takeWireViolations();
  if (count === 0 && all.length === 0) return [];

  const timestamp = new Date().toISOString();
  const specReferences = [
    {
      id: 'MCP-Schema',
      url: `https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/${schemaDirFor(specVersion)}/schema.json`
    }
  ];
  const checks: ConformanceCheck[] = [];

  const implViolations = all.filter((v) => v.origin === 'implementation');
  checks.push({
    id: 'wire-schema-valid',
    name: 'WireSchemaValid',
    description:
      'Every JSON-RPC message the implementation sent is valid per the spec JSON schema for the negotiated spec version',
    status: implViolations.length === 0 ? 'SUCCESS' : 'FAILURE',
    timestamp,
    specReferences,
    details: {
      messagesValidated: count,
      violations: implViolations.map(violationDetails)
    },
    errorMessage:
      implViolations.length > 0
        ? implViolations.map(formatWireViolation).join('\n')
        : undefined
  });

  const harnessViolations = all.filter((v) => v.origin === 'harness');
  if (harnessViolations.length > 0) {
    checks.push({
      id: 'wire-schema-harness-error',
      name: 'WireSchemaHarnessError',
      description:
        'HARNESS ERROR: the conformance harness itself sent a JSON-RPC message the spec JSON schema forbids. This is a bug in the harness or a scenario fixture, not in the implementation under test.',
      status: 'FAILURE',
      timestamp,
      specReferences,
      details: { violations: harnessViolations.map(violationDetails) },
      errorMessage:
        'HARNESS ERROR: ' +
        harnessViolations.map(formatWireViolation).join('\n')
    });
  }

  return checks;
}
