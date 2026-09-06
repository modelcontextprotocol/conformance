import { z } from 'zod';
import {
  getScenario,
  getClientScenario,
  getClientScenarioForAuthorizationServer
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
