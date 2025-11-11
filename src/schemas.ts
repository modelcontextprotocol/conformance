import { z } from 'zod';
import { getScenario, getClientScenario } from './scenarios';

// Client command options schema
export const ClientOptionsSchema = z.object({
  command: z.string().min(1, 'Command cannot be empty'),
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
    ),
  verbose: z.boolean().optional()
});

export type ClientOptions = z.infer<typeof ClientOptionsSchema>;

// Server command options schema
export const ServerOptionsSchema = z.object({
  url: z.string().url('Invalid server URL'),
  scenario: z
    .union([
      z.string(),
      z.array(z.string())
    ])
    .optional()
    .transform((val) => {
      // Normalize to array for easier handling
      if (!val) return undefined;
      return Array.isArray(val) ? val : [val];
    })
    .refine(
      (scenarios) => {
        if (!scenarios) return true; // No scenario means run all
        return scenarios.every(s => getClientScenario(s) !== undefined);
      },
      (scenarios) => {
        if (!scenarios) return { message: '' };
        const invalid = scenarios.find(s => getClientScenario(s) === undefined);
        return { message: `Unknown scenario '${invalid}'` };
      }
    )
});

export type ServerOptions = z.infer<typeof ServerOptionsSchema>;
