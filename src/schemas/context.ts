import { z } from 'zod';

/**
 * Schema for conformance test context passed via MCP_CONFORMANCE_CONTEXT.
 *
 * Each variant includes a `name` field matching the scenario name to enable
 * discriminated union parsing and type-safe access to scenario-specific fields.
 */
export const ConformanceContextSchema = z.discriminatedUnion('name', [
  z.object({
    name: z.literal('auth/client-credentials-jwt'),
    client_id: z.string(),
    private_key_pem: z.string(),
    signing_algorithm: z.string().optional()
  }),
  z.object({
    name: z.literal('auth/client-credentials-basic'),
    client_id: z.string(),
    client_secret: z.string()
  })
]);

export type ConformanceContext = z.infer<typeof ConformanceContextSchema>;
