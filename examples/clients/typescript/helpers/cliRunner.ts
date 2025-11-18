import { fileURLToPath } from 'url';

/**
 * Helper to run a client function as a CLI command.
 * Only runs if the file is executed directly (not imported).
 * Handles argv parsing and exit codes.
 */
export function runAsCli(
  clientFn: (serverUrl: string) => Promise<void>,
  importMetaUrl: string,
  usage: string = 'client <server-url>'
): void {
  // Check if this file is being run directly
  const isMain = process.argv[1] === fileURLToPath(importMetaUrl);
  if (!isMain) return;

  const serverUrl = process.argv[2];
  if (!serverUrl) {
    console.error(`Usage: ${usage}`);
    process.exit(1);
  }
  clientFn(serverUrl)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
