import { promises as fs } from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const SdkConfigSchema = z.object({
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

const CONFIG_FILENAMES = [
  'conformance.config.yaml',
  'conformance.config.yml',
  'conformance.config.json'
];

export async function loadSdkConfig(dir: string): Promise<SdkConfig | null> {
  for (const name of CONFIG_FILENAMES) {
    const filePath = path.join(dir, name);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch {
      continue;
    }
    const parsed = name.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw);
    return SdkConfigSchema.parse(parsed);
  }
  return null;
}
