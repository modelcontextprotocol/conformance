/**
 * Vitest-wide guard for wire-schema violations (see `wire-schema.ts`).
 *
 * The scenario self-tests drive scenarios directly (bypassing the runners
 * that append the `wire-schema-valid` checks), and in a self-test both sides
 * of the wire are harness-authored. Any message that violates the spec JSON
 * schema during a test is therefore a harness bug — fail the test loudly so
 * hallucinated fixtures can't ship.
 *
 * Tests that intentionally exercise nonconformant traffic (negative fixtures,
 * the wire-schema tests themselves) drain the recorder with
 * `takeWireViolations()` before the test ends.
 */

import { afterEach, beforeEach } from 'vitest';
import { formatWireViolation, takeWireViolations } from './wire-schema';

beforeEach(() => {
  // Discard anything recorded between tests (e.g. by a mock server still
  // answering a straggling request from the previous test).
  takeWireViolations();
});

afterEach(() => {
  const { violations } = takeWireViolations();
  if (violations.length > 0) {
    throw new Error(
      'Wire messages violated the spec JSON schema during this test ' +
        '(intentional? drain with takeWireViolations()):\n  ' +
        violations.map(formatWireViolation).join('\n  ')
    );
  }
});
