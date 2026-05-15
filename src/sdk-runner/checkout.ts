import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

export interface SdkSpec {
  name: string;
  ref: string;
}

const DEFAULT_ORG = 'modelcontextprotocol';

export function parseSdkSpec(spec: string): SdkSpec {
  const at = spec.lastIndexOf('@');
  if (at <= 0) {
    return { name: spec, ref: 'main' };
  }
  return { name: spec.slice(0, at), ref: spec.slice(at + 1) };
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
  await fs.mkdir(cacheDir, { recursive: true });
  const safeName = spec.name.replace('/', '__');
  const dir = path.resolve(cacheDir, safeName);

  if (await dirExists(path.join(dir, '.git'))) {
    console.error(`[sdk] Fetching ${spec.name} (cached at ${dir})`);
    await git(['fetch', '--tags', 'origin'], dir);
  } else {
    console.error(`[sdk] Cloning ${repoUrl(spec.name)} -> ${dir}`);
    await git(['clone', repoUrl(spec.name), dir], cacheDir);
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
