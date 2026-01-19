import path from 'path';
import { ConformanceCheck } from '../types';

// ANSI color codes
export const COLORS = {
  RESET: '\x1b[0m',
  GRAY: '\x1b[90m',
  GREEN: '\x1b[32m',
  YELLOW: '\x1b[33m',
  RED: '\x1b[31m',
  BLUE: '\x1b[36m'
};

export function getStatusColor(status: string): string {
  switch (status) {
    case 'SUCCESS':
      return COLORS.GREEN;
    case 'FAILURE':
      return COLORS.RED;
    case 'WARNING':
      return COLORS.YELLOW;
    case 'INFO':
      return COLORS.BLUE;
    default:
      return COLORS.RESET;
  }
}

export function formatPrettyChecks(checks: ConformanceCheck[]): string {
  // Find the longest id and status for column alignment
  const maxIdLength = Math.max(...checks.map((c) => c.id.length));
  const maxStatusLength = Math.max(...checks.map((c) => c.status.length));

  return checks
    .map((check) => {
      const timestamp = `${COLORS.GRAY}${check.timestamp}${COLORS.RESET}`;
      const id = check.id.padEnd(maxIdLength);
      const statusColor = getStatusColor(check.status);
      const status = `${statusColor}${check.status.padEnd(maxStatusLength)}${COLORS.RESET}`;
      const description = check.description;
      const line = `${timestamp} [${id}] ${status} ${description}`;
      // Add newline after outgoing responses for better visual separation
      return (
        line +
        (check.id.includes('outgoing') && check.id.includes('response')
          ? '\n'
          : '')
      );
    })
    .join('\n');
}

export function createResultDir(
  baseDir: string,
  scenario: string,
  prefix = ''
): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dirName = prefix ? `${prefix}-${scenario}` : scenario;
  return path.join(baseDir, `${dirName}-${timestamp}`);
}
