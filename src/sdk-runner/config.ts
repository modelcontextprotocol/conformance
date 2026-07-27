import { z } from 'zod';
import { DATED_SPEC_VERSIONS, DRAFT_PROTOCOL_VERSION } from '../types';

// Fields an entry may vary per targeted spec version. Identity fields
// (repo / defaultRef / specVersion) can't vary — they pick what to clone,
// not how to drive it. `server` is partial here so an override can change
// just the command (go-sdk) or just the url (csharp-sdk).
const SpecOverrideSchema = z.object({
  build: z.string().optional(),
  client: z
    .object({
      command: z.string()
    })
    .optional(),
  server: z
    .object({
      command: z.string().optional(),
      url: z.string().url().optional(),
      readyTimeoutMs: z.number().int().positive().optional()
    })
    .optional(),
  expectedFailures: z.string().optional()
});

export type SpecOverride = z.infer<typeof SpecOverrideSchema>;

const VALID_OVERRIDE_KEYS: readonly string[] = [
  ...DATED_SPEC_VERSIONS,
  DRAFT_PROTOCOL_VERSION
];

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
  expectedFailures: z.string().optional(),
  // Spec version this SDK targets, used as the default --spec-version when
  // the flag isn't given (e.g. a v1 SDK pinned to the latest dated spec).
  // An explicit --spec-version on the sdk command always wins.
  specVersion: z.string().optional(),
  // Per-spec-version defaults, keyed by the canonical spec version a run
  // targets (--spec-version after alias resolution — so keys are the dated
  // strings, never 'draft' — or the entry's own specVersion). Matched entries
  // are merged over the base config field-by-field before CLI flags apply, so
  // `sdk go-sdk --mode server --spec-version 2026-07-28` picks up the right
  // server invocation with no manual overrides.
  // Precedence: CLI flag > specOverrides > base entry.
  specOverrides: z
    .record(z.string(), SpecOverrideSchema)
    .superRefine((overrides, ctx) => {
      // Keys must be canonical spec versions: a 'draft' key (or a typo'd
      // date) would silently never match, because the requested version is
      // resolved to its dated form before the lookup.
      for (const key of Object.keys(overrides)) {
        if (!VALID_OVERRIDE_KEYS.includes(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `specOverrides key '${key}' is not a spec version. ` +
              `Use one of: ${VALID_OVERRIDE_KEYS.join(', ')} ` +
              `('draft' resolves to ${DRAFT_PROTOCOL_VERSION} before lookup, so key the dated form).`
          });
        }
      }
    })
    .optional()
});

export type SdkConfig = z.infer<typeof SdkConfigSchema>;

/**
 * Resolve the config to use for a run targeting `specVersion`: the base
 * entry with the matching specOverrides entry (if any) merged on top.
 * Returns the input unchanged when nothing matches; never mutates it.
 */
export function resolveConfigForSpec(
  config: SdkConfig,
  specVersion: string | undefined
): SdkConfig {
  const override = specVersion
    ? config.specOverrides?.[specVersion]
    : undefined;
  if (!override) return config;
  const server =
    config.server || override.server
      ? { ...config.server, ...override.server }
      : undefined;
  return {
    ...config,
    build: override.build ?? config.build,
    client: override.client ?? config.client,
    // The base schema guarantees command+url when a base server exists; an
    // override without a base server must itself be complete to be usable.
    server: server as SdkConfig['server'],
    expectedFailures: override.expectedFailures ?? config.expectedFailures
  };
}
