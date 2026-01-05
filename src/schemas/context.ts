import { z } from 'zod';

/**
 * Schema for client conformance test context passed via MCP_CONFORMANCE_CONTEXT.
 *
 * Each variant includes a `name` field matching the scenario name to enable
 * discriminated union parsing and type-safe access to scenario-specific fields.
 */
export const ClientConformanceContextSchema = z.discriminatedUnion('name', [
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

export type ClientConformanceContext = z.infer<
  typeof ClientConformanceContextSchema
>;
