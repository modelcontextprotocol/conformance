import { describe, it, expect } from 'vitest';
import {
  COLORS,
  getStatusColor,
  formatPrettyChecks,
  createResultDir
} from './utils.js';
import { ConformanceCheck } from '../types.js';

describe('Runner Utils', () => {
  describe('getStatusColor', () => {
    it('returns GREEN for SUCCESS status', () => {
      expect(getStatusColor('SUCCESS')).toBe(COLORS.GREEN);
    });

    it('returns RED for FAILURE status', () => {
      expect(getStatusColor('FAILURE')).toBe(COLORS.RED);
    });

    it('returns YELLOW for WARNING status', () => {
      expect(getStatusColor('WARNING')).toBe(COLORS.YELLOW);
    });

    it('returns BLUE for INFO status', () => {
      expect(getStatusColor('INFO')).toBe(COLORS.BLUE);
    });

    it('returns RESET for unknown status', () => {
      expect(getStatusColor('UNKNOWN')).toBe(COLORS.RESET);
    });
  });

  describe('formatPrettyChecks', () => {
    it('formats a single check with colors', () => {
      const checks: ConformanceCheck[] = [
        {
          id: 'test-check',
          name: 'TestCheck',
          description: 'A test check',
          status: 'SUCCESS',
          timestamp: '2025-03-03T12:00:00.000Z'
        }
      ];

      const formatted = formatPrettyChecks(checks);

      expect(formatted).toContain('test-check');
      expect(formatted).toContain('SUCCESS');
      expect(formatted).toContain('A test check');
      expect(formatted).toContain(COLORS.GREEN);
    });

    it('formats multiple checks with consistent column alignment', () => {
      const checks: ConformanceCheck[] = [
        {
          id: 'short',
          name: 'Short',
          description: 'First',
          status: 'SUCCESS',
          timestamp: '2025-03-03T12:00:00.000Z'
        },
        {
          id: 'very-long-check-id',
          name: 'Long',
          description: 'Second',
          status: 'FAILURE',
          timestamp: '2025-03-03T12:00:01.000Z'
        }
      ];

      const formatted = formatPrettyChecks(checks);
      const lines = formatted.split('\n');

      expect(lines.length).toBe(2);
      expect(lines[0]).toContain('short');
      expect(lines[1]).toContain('very-long-check-id');
    });

    it('adds extra newline after outgoing-response checks', () => {
      const checks: ConformanceCheck[] = [
        {
          id: 'outgoing-response',
          name: 'Response',
          description: 'Outgoing response',
          status: 'INFO',
          timestamp: '2025-03-03T12:00:00.000Z'
        },
        {
          id: 'next-check',
          name: 'NextCheck',
          description: 'Next check',
          status: 'SUCCESS',
          timestamp: '2025-03-03T12:00:01.000Z'
        }
      ];

      const formatted = formatPrettyChecks(checks);

      // The outgoing-response check should have a newline after it
      expect(formatted).toMatch(/outgoing-response.*\n\n/);
    });

    it('handles checks with different status colors', () => {
      const checks: ConformanceCheck[] = [
        {
          id: 'check1',
          name: 'Check1',
          description: 'First',
          status: 'SUCCESS',
          timestamp: '2025-03-03T12:00:00.000Z'
        },
        {
          id: 'check2',
          name: 'Check2',
          description: 'Second',
          status: 'WARNING',
          timestamp: '2025-03-03T12:00:01.000Z'
        },
        {
          id: 'check3',
          name: 'Check3',
          description: 'Third',
          status: 'FAILURE',
          timestamp: '2025-03-03T12:00:02.000Z'
        }
      ];

      const formatted = formatPrettyChecks(checks);

      expect(formatted).toContain(COLORS.GREEN);
      expect(formatted).toContain(COLORS.YELLOW);
      expect(formatted).toContain(COLORS.RED);
      expect(formatted).toContain(COLORS.RESET);
    });

    it('properly aligns IDs and status columns', () => {
      const checks: ConformanceCheck[] = [
        {
          id: 'a',
          name: 'A',
          description: 'First',
          status: 'S',
          timestamp: '2025-03-03T12:00:00.000Z'
        },
        {
          id: 'long-id',
          name: 'Long',
          description: 'Second',
          status: 'LONGSTATUS',
          timestamp: '2025-03-03T12:00:01.000Z'
        }
      ];

      const formatted = formatPrettyChecks(checks);

      // Should contain padded columns
      expect(formatted).toContain('a');
      expect(formatted).toContain('long-id');
    });
  });

  describe('createResultDir', () => {
    it('creates directory name with scenario and timestamp', () => {
      const result = createResultDir('/tmp', 'test-scenario');

      expect(result).toMatch(/\/tmp\/test-scenario-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
    });

    it('includes prefix in directory name when provided', () => {
      const result = createResultDir('/tmp', 'test-scenario', 'prefix');

      expect(result).toMatch(/\/tmp\/prefix-test-scenario-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
    });

    it('omits prefix in directory name when not provided', () => {
      const result = createResultDir('/tmp', 'test-scenario');

      expect(result).not.toMatch(/undefined/);
      expect(result).toMatch(/\/tmp\/test-scenario-/);
    });

    it('uses ISO timestamp with colons and periods replaced', () => {
      const result = createResultDir('/tmp', 'scenario', 'pre');

      // Should not contain colons or periods from timestamp
      expect(result).not.toMatch(/:/);
      expect(result).not.toMatch(/\./);
    });

    it('correctly paths directory with base directory', () => {
      const result = createResultDir('/home/user', 'my-scenario');

      expect(result).toMatch(/^\/home\/user\/my-scenario-/);
    });

    it('handles complex scenario names', () => {
      const result = createResultDir('/tmp', 'my-test-scenario-123');

      expect(result).toMatch(/\/tmp\/my-test-scenario-123-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
    });
  });

  describe('COLORS constant', () => {
    it('exports all required color codes', () => {
      expect(COLORS.RESET).toBeDefined();
      expect(COLORS.GRAY).toBeDefined();
      expect(COLORS.GREEN).toBeDefined();
      expect(COLORS.YELLOW).toBeDefined();
      expect(COLORS.RED).toBeDefined();
      expect(COLORS.BLUE).toBeDefined();
    });

    it('contains valid ANSI escape codes', () => {
      expect(COLORS.GREEN).toContain('\x1b[');
      expect(COLORS.RED).toContain('\x1b[');
      expect(COLORS.YELLOW).toContain('\x1b[');
      expect(COLORS.BLUE).toContain('\x1b[');
      expect(COLORS.GRAY).toContain('\x1b[');
      expect(COLORS.RESET).toBe('\x1b[0m');
    });
  });
});
