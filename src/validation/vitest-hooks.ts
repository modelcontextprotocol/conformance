// Vitest-wide guard: in self-tests both sides of the wire are harness-authored, so any
// wire-schema violation is a harness bug — fail the test loudly. Tests that intentionally
// send nonconformant traffic drain the recorder with `takeWireViolations()` before ending.

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
