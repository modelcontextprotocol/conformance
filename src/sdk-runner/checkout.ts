import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

export interface SdkSpec {
  name: string;
  ref: string;
}

/**
 * A parsed `<name>[@<ref>]` argument. `ref` is left undefined when the user
 * omits `@<ref>` so the caller can fall back to a per-SDK default branch
 * (KNOWN_SDKS `defaultRef`) before settling on `main`.
 */
export interface ParsedSdkSpec {
  name: string;
  ref?: string;
}

const DEFAULT_ORG = 'modelcontextprotocol';

export function parseSdkSpec(spec: string): ParsedSdkSpec {
  const at = spec.lastIndexOf('@');
  if (at <= 0) {
    return { name: spec };
  }
  // A trailing `@` (empty ref) is treated as "no ref given" so the caller's
  // defaultRef/main fallback applies, rather than checking out the empty ref.
  const ref = spec.slice(at + 1);
  return ref ? { name: spec.slice(0, at), ref } : { name: spec.slice(0, at) };
}

function repoUrl(name: string): string {
  if (name.includes('/')) {
    return `https://github.com/${name}.git`;
  }
  return `https://github.com/${DEFAULT_ORG}/${name}.git`;
}

async function git(
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string }> {
  const cmd = 'git';
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `${cmd} ${args.join(' ')} exited with ${code}\n${stderr || stdout}`
          )
        );
      }
    });
  });
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Ensure an SDK is checked out at the requested ref under cacheDir.
 * Clones on first use; on subsequent calls fetches and resets to the ref.
 * Returns the absolute path to the checkout.
 */
export async function ensureCheckout(
  spec: SdkSpec,
  cacheDir: string
): Promise<string> {
  const safeName = spec.name.replace(/\//g, '__');
  // Key the checkout by ref as well, so different refs of the same repo (e.g.
  // the typescript-sdk `main` and typescript-sdk-v1 `v1.x` entries) get their
  // own directory instead of thrashing one checkout between refs/build systems.
  const safeRef = spec.ref.replace(/[^a-zA-Z0-9._-]/g, '_');
  const dir = path.resolve(cacheDir, safeName, safeRef);
  await fs.mkdir(path.dirname(dir), { recursive: true });

  if (await dirExists(path.join(dir, '.git'))) {
    console.error(`[sdk] Fetching ${spec.name} (cached at ${dir})`);
    await git(['fetch', '--tags', 'origin'], dir);
  } else {
    console.error(`[sdk] Cloning ${repoUrl(spec.name)} -> ${dir}`);
    await git(['clone', repoUrl(spec.name), dir], path.dirname(dir));
  }

  // Try the ref as a remote branch first, then fall back to a local-resolvable
  // ref (tag or SHA).
  const candidates = [`origin/${spec.ref}`, spec.ref];
  let resolved: string | undefined;
  for (const candidate of candidates) {
    try {
      await git(['rev-parse', '--verify', `${candidate}^{commit}`], dir);
      resolved = candidate;
      break;
    } catch {
      // rev-parse failure means this candidate doesn't exist; try the next form
    }
  }
  if (!resolved) {
    throw new Error(
      `Ref '${spec.ref}' not found in ${spec.name} (tried ${candidates.join(', ')})`
    );
  }

  console.error(`[sdk] Checking out ${spec.name}@${spec.ref} (${resolved})`);
  await git(['checkout', '--detach', resolved], dir);

  const { stdout } = await git(['rev-parse', '--short', 'HEAD'], dir);
  console.error(`[sdk] HEAD is ${stdout.trim()}`);

  return dir;
}
