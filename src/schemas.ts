import { z } from 'zod';
import { getScenario, getClientScenario } from './scenarios';

// Client command options schema
export const ClientOptionsSchema = z.object({
  command: z.string().min(1, 'Command cannot be empty').optional(),
  scenario: z
    .string()
    .min(1, 'Scenario cannot be empty')
    .refine(
      (scenario) => getScenario(scenario) !== undefined,
      (scenario) => ({
        message: `Unknown scenario '${scenario}'`
      })
    ),
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
    .refine(
      (scenario) => getClientScenario(scenario) !== undefined,
      (scenario) => ({
        message: `Unknown scenario '${scenario}'`
      })
    )
    .optional()
});

export type ServerOptions = z.infer<typeof ServerOptionsSchema>;

// Interactive command options schema
export const InteractiveOptionsSchema = z.object({
  scenario: z
    .string()
    .min(1, 'Scenario cannot be empty')
    .refine(
      (scenario) => getScenario(scenario) !== undefined,
      (scenario) => ({
        message: `Unknown scenario '${scenario}'`
      })
    )
});

export type InteractiveOptions = z.infer<typeof InteractiveOptionsSchema>;
