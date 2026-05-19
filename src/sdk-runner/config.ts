import { z } from 'zod';

export const SdkConfigSchema = z.object({
  // Clone this repo instead of the KNOWN_SDKS key — lets an alias entry
  // (e.g. typescript-sdk-v1) point at the real repo (typescript-sdk).
  repo: z.string().optional(),
  // Ref to check out when the SDK is named with no @ref (the "default branch").
  defaultRef: z.string().optional(),
  build: z.string().optional(),
  client: z
    .object({
      command: z.string()
    })
    .optional(),
  server: z
    .object({
      command: z.string(),
      url: z.string().url(),
      readyTimeoutMs: z.number().int().positive().optional()
    })
    .optional(),
  expectedFailures: z.string().optional()
});

export type SdkConfig = z.infer<typeof SdkConfigSchema>;
