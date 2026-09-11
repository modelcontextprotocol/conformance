import { z } from 'zod';
import {
  getScenario,
  getClientScenario,
  getClientScenarioForAuthorizationServer,
  getScenarioForResourceAuthorizationServer
} from './scenarios';

// Client command options schema
export const ClientOptionsSchema = z.object({
  command: z.string().min(1, 'Command cannot be empty').optional(),
  scenario: z
    .string()
    .min(1, 'Scenario cannot be empty')
    .refine((scenario) => getScenario(scenario) !== undefined, {
      error: (iss) => `Unknown scenario '${iss.input}'`
    }),
  timeout: z
    .string()
    .transform((val) => parseInt(val, 10))
    .pipe(
      z
        .number()
        .positive('Timeout must be a positive number')
        .int('Timeout must be an integer')
    )
    .optional(),
  verbose: z.boolean().optional()
});

export type ClientOptions = z.infer<typeof ClientOptionsSchema>;

// Server command options schema
export const ServerOptionsSchema = z.object({
  url: z.string().url('Invalid server URL'),
  scenario: z
    .string()
    .refine((scenario) => getClientScenario(scenario) !== undefined, {
      error: (iss) => `Unknown scenario '${iss.input}'`
    })
    .optional()
});

export type ServerOptions = z.infer<typeof ServerOptionsSchema>;

// Authorization server command options schema
export const AuthorizationServerOptionsSchema = z.object({
  url: z.string().url('Invalid authorization server URL'),
  scenario: z
    .string()
    .refine(
      (scenario) =>
        getClientScenarioForAuthorizationServer(scenario) !== undefined,
      {
        error: (iss) => `Unknown scenario '${iss.input}'`
      }
    )
    .optional(),
  clientId: z.string().min(1, 'Client id cannot be empty').optional(),
  clientSecret: z.string().min(1, 'Client secret cannot be empty').optional(),
  // RFC 8707 §2: the resource value is an absolute URI with no fragment.
  resource: z
    .string()
    .refine((value) => URL.canParse(value), 'Resource must be an absolute URI')
    .refine(
      (value) => !URL.canParse(value) || !new URL(value).hash,
      'Resource must not include a fragment'
    )
    .optional(),
  port: z
    .number()
    .int('Port must be an integer')
    .min(1, 'Port must be >= 1')
    .max(65535, 'Port must be <= 65535')
    .default(3000)
});

export type AuthorizationServerOptions = z.infer<
  typeof AuthorizationServerOptionsSchema
>;

// Resource authorization server (EMA / ID-JAG) command options schema.
//
// Settings a human tester provides to point a scenario at a *real* target
// Resource AS they have pre-provisioned. `url` is the only field every scenario
// needs (it discovers the token/introspection endpoints from the issuer's
// server metadata); each scenario validates the additional fields it requires
// and skips when they are absent, so the remaining fields are schema-optional.
export const ResourceAuthorizationServerOptionsSchema = z.object({
  // [1] Issuer URL of the target Resource AS. The runner GETs its server
  // metadata (well-known URL derived from the issuer) to learn the token and
  // introspection endpoints. Required by every scenario.
  url: z.string().url('Invalid resource authorization server URL'),
  scenario: z
    .string()
    .min(1, 'Scenario cannot be empty')
    .refine(
      (scenario) =>
        getScenarioForResourceAuthorizationServer(scenario) !== undefined,
      {
        error: (iss) => `Unknown scenario '${iss.input}'`
      }
    )
    .optional(),
  // [2] client_id of the MCP Client the tester registered with the Resource AS.
  clientId: z.string().min(1, 'Client id cannot be empty').optional(),
  // [3] Client secret for that MCP Client (client_secret_post authentication).
  clientSecret: z.string().min(1, 'Client secret cannot be empty').optional(),
  // [4] Issuer URL of an IdP AS the target Resource AS trusts (accepts ID-JAGs
  // whose `iss` matches).
  trustedIdpIssuer: z.string().url('Invalid trusted IdP issuer URL').optional(),
  // [5] Issuer URL of an IdP AS the target Resource AS does not trust (rejects
  // ID-JAGs whose `iss` matches).
  untrustedIdpIssuer: z
    .string()
    .url('Invalid untrusted IdP issuer URL')
    .optional(),
  // [6] URL of an MCP Server the Resource AS trusts; used as the ID-JAG
  // `resource`. Optional — only needed for scenarios exercising `resource`.
  trustedMcpServer: z.string().url('Invalid trusted MCP server URL').optional(),
  // [7] URL of an MCP Server the Resource AS does not trust; used as the ID-JAG
  // `resource`. Optional — only needed for scenarios exercising `resource`.
  untrustedMcpServer: z
    .string()
    .url('Invalid untrusted MCP server URL')
    .optional(),
  // [8] OAuth 2.0 scope the Resource AS recognises; used as the ID-JAG `scope`.
  // Optional — only needed for scenarios exercising `scope`.
  scope: z.string().min(1, 'Scope cannot be empty').optional(),
  // [9] User id registered with the target Resource AS; the Resource AS is
  // expected to place this value in the `sub` claim of the access token it
  // issues for the linked IdP-registered user (see `idpSub`). Optional —
  // only needed for scenarios exercising `sub`.
  sub: z.string().min(1, 'Subject cannot be empty').optional(),
  // [10] User id registered with the trusted IdP AS for that same person;
  // used as the ID-JAG `sub` claim. The IdP and the Resource AS may assign the
  // same human different ids, so this is intentionally distinct from `sub`
  // above. Optional — only needed for scenarios exercising `sub`.
  idpSub: z.string().min(1, 'Subject cannot be empty').optional()
});

export type ResourceAuthorizationServerOptions = z.infer<
  typeof ResourceAuthorizationServerOptionsSchema
>;

// Interactive command options schema
export const InteractiveOptionsSchema = z.object({
  scenario: z
    .string()
    .min(1, 'Scenario cannot be empty')
    .refine((scenario) => getScenario(scenario) !== undefined, {
      error: (iss) => `Unknown scenario '${iss.input}'`
    })
});

export type InteractiveOptions = z.infer<typeof InteractiveOptionsSchema>;
